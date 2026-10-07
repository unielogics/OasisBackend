import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { transaction } from '../../src/platform/db.js'
import { profiles, runSeed } from '../../db/seeds/index.js'
import {
  DESIGN_ADDONS,
  DESIGN_CLOSURES,
  DESIGN_CUSTOMERS,
  DESIGN_PACKAGES,
  DESIGN_VIP_NAMES,
  INSPECTION_TASK,
  seedTasks,
} from '../../db/seeds/domain.js'
import { generateFederalHolidays } from '../../src/modules/settings/federal-holidays.js'
import { getEmergencyState } from '../../src/modules/settings/emergency.js'
import { getBookingRules, getHours } from '../../src/modules/settings/hours.js'
import { listLiveClosures } from '../../src/modules/settings/closures.js'
import { listVipClients } from '../../src/modules/settings/vip.js'
import { dayInfo } from '../../src/modules/settings/day-info.js'
import { listCatalog } from '../../src/modules/catalog/service.js'
import { searchCustomers } from '../../src/modules/customers/service.js'
import { useTestDb } from '../helpers/db.js'

const t = useTestDb()

const DOMAIN_TABLES = [
  'services',
  'checklist_tasks',
  'customers',
  'vehicles',
  'bays',
  'business_hours',
  'booking_rules',
  'closures',
  'federal_holiday_runs',
  'emergency_closures',
  'vip_settings',
  'vip_holds',
  'vip_clients',
  'arrival_settings',
]

async function snapshot(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {}
  for (const table of DOMAIN_TABLES) {
    const r = await sql<
      Record<string, unknown>
    >`select * from ${sql.id(table)} order by to_jsonb(${sql.id(table)})::text`.execute(t.db)
    out[table] = r.rows
  }
  return out
}

const seed = (profile: string) => runSeed({ db: t.db, clock: t.clock, profile })
const LOC = async () =>
  await t.db.selectFrom('locations').select(['id', 'timezone']).executeTakeFirstOrThrow()

describe('profile registration', () => {
  it('registers domain, domain-design, base and design, with people and domain running first', async () => {
    expect(Object.keys(profiles)).toEqual(
      expect.arrayContaining(['domain', 'domain-design', 'base', 'design']),
    )
    expect(await seed('base')).toEqual(['people', 'domain', 'base'])
    expect(await seed('design')).toEqual(['people', 'domain', 'base', 'domain-design', 'design'])
  })
})

describe('seed data: reference profile', () => {
  it('creates the location, two bays, the design hours and 30/10/60 rules', async () => {
    await seed('domain')
    const loc = await LOC()
    expect(loc.timezone).toBe('America/New_York')
    const bays = await t.db
      .selectFrom('bays')
      .select(['number', 'name', 'status'])
      .orderBy('number')
      .execute()
    expect(bays).toEqual([
      { number: 1, name: 'Bay 1', status: 'active' },
      { number: 2, name: 'Bay 2', status: 'active' },
    ])
    const hours = await getHours(t.db, loc.id)
    expect(hours.map((h) => [h.weekday, h.isOpen, h.openMin, h.closeMin])).toEqual([
      [0, true, 540, 900],
      [1, true, 480, 1080],
      [2, true, 480, 1080],
      [3, true, 480, 1080],
      [4, true, 480, 1080],
      [5, true, 480, 1080],
      [6, true, 480, 1020],
    ])
    expect((await getBookingRules(t.db, loc.id)).rules).toMatchObject({
      slotMinutes: 30,
      bufferMinutes: 10,
      cutoffMinutes: 60,
    })
  })

  it('creates exactly the design’s seven closures, with Jun 3 flagged as an emergency and the 2026 federal run marked', async () => {
    await seed('domain')
    const loc = await LOC()
    const closures = await listLiveClosures(t.db, loc.id)
    expect(closures.map((c) => [c.date, c.name, c.type, c.openMin, c.closeMin, c.source, c.notify])).toEqual([
      ['2026-05-25', 'Memorial Day', 'closed', null, null, 'federal', true],
      ['2026-06-03', 'Weather closure', 'closed', null, null, 'emergency', true],
      ['2026-07-04', 'Independence Day', 'closed', null, null, 'federal', true],
      ['2026-09-07', 'Labor Day', 'reduced', 600, 840, 'federal', true],
      ['2026-11-26', 'Thanksgiving', 'closed', null, null, 'federal', true],
      ['2026-12-24', 'Christmas Eve', 'reduced', 480, 780, 'manual', true],
      ['2026-12-25', 'Christmas Day', 'closed', null, null, 'federal', true],
    ])
    expect(DESIGN_CLOSURES).toHaveLength(7)
    const jun3 = closures.find((c) => c.date === '2026-06-03')!
    expect(jun3.emergencyClosureId).not.toBeNull()
    const em = await t.db
      .selectFrom('emergency_closures')
      .select(['id', 'reason'])
      .where('id', '=', jun3.emergencyClosureId!)
      .executeTakeFirstOrThrow()
    expect(em.reason).toBe('severe_weather')
    const runs = await t.db.selectFrom('federal_holiday_runs').select('year').execute()
    expect(runs).toEqual([{ year: 2026 }])
  })

  it('leaves the 2026 federal generation with nothing to add, in both normal and catch-up mode', async () => {
    await seed('domain')
    const loc = await LOC()
    const gen = (catchUp: boolean) =>
      transaction(t.db, (tx) =>
        generateFederalHolidays(tx, {
          locationId: loc.id,
          years: [2026],
          today: '2026-01-02',
          tz: loc.timezone,
          newId: () => '00000000-0000-7000-8000-00000000f001',
          catchUp,
        }),
      )
    expect((await gen(false)).created).toEqual([])
    const catchUp = await gen(true)
    expect(catchUp.created).toEqual([])
    expect(catchUp.skippedYears).toEqual([2026])
    expect(await t.db.selectFrom('closures').select('id').execute()).toHaveLength(7)
  })

  it('answers dayInfo from the seeded closures: Labor Day reduced 10-2, Christmas Eve 8-1, Jul 4 closed', async () => {
    await seed('domain')
    const loc = await LOC()
    const hours = await getHours(t.db, loc.id)
    const closures = await listLiveClosures(t.db, loc.id)
    const info = (date: string) => dayInfo({ date, hours, closures })
    expect(info('2026-09-07')).toMatchObject({
      reduced: true,
      openMin: 600,
      closeMin: 840,
      note: 'Labor Day · reduced hours',
    })
    expect(info('2026-12-24')).toMatchObject({
      reduced: true,
      openMin: 480,
      closeMin: 780,
      note: 'Christmas Eve · reduced hours',
    })
    expect(info('2026-07-04')).toMatchObject({ closed: true, reason: 'Independence Day' })
    expect(info('2026-06-03')).toMatchObject({ closed: true, reason: 'Weather closure', emergency: true })
    expect(info('2026-06-13')).toMatchObject({ closed: false, openMin: 480, closeMin: 1020 })
  })

  it('seeds the 9 packages and 10 add-ons with prices, durations and task lists, after the inspection filter', async () => {
    await seed('domain')
    const loc = await LOC()
    const cat = await listCatalog(t.db, loc.id)
    expect(cat.packages.map((p) => [p.name, p.priceCents / 100, p.durationMin, p.tasks.length])).toEqual([
      ['Express Hand Wash', 45, 35, 5],
      ['Premium Hand Wash + Interior', 129, 75, 7],
      ['Premium Hand Wash + Interior Refresh', 139, 75, 8],
      ['Executive Detail', 260, 90, 10],
      ['Executive Detail + Ceramic', 420, 120, 9],
      ['Full Detail', 320, 120, 10],
      ['Ceramic Maintenance + Wax', 180, 60, 7],
      ['Exotic Detail Package', 650, 150, 9],
      ['Family Wash + Pet Hair', 95, 50, 7],
    ])
    expect(cat.addons.map((a) => [a.name, a.priceCents / 100, a.durationMin, a.tasks.length])).toEqual([
      ['Interior deep clean', 60, 0, 3],
      ['Pet hair removal', 35, 0, 3],
      ['Leather conditioning', 45, 0, 3],
      ['Wax', 40, 0, 2],
      ['Clay bar', 50, 0, 3],
      ['Odor removal', 30, 0, 2],
      ['Engine bay cleaning', 55, 0, 3],
      ['Ceramic maintenance', 120, 0, 2],
      ['Rain repellent', 25, 0, 2],
      ['Wheel deep clean', 40, 0, 3],
    ])
    for (const s of [...cat.packages, ...cat.addons]) {
      expect(s.tasks.map((x) => x.position)).toEqual(s.tasks.map((_, i) => i))
      expect(
        s.tasks.some((x) => INSPECTION_TASK.test(x.label)),
        s.name,
      ).toBe(false)
    }
    const exotic = cat.packages.find((p) => p.name === 'Exotic Detail Package')!
    expect(exotic.tasks.map((x) => x.label)).toEqual([
      'Waterless decon',
      'Two-bucket hand wash',
      'Paint correction pass',
      'Ceramic seal',
      'Wheel & caliper detail',
      'Full interior detail',
      'Leather conditioning',
      'Glass & trim restore',
      'Photographic handover',
    ])
    expect(cat.packages[1]!.tasks.map((x) => x.label)).toEqual([
      'Exterior pre-rinse',
      'Two-bucket hand wash',
      'Wheel & tire cleaning',
      'Tire shine',
      'Interior vacuum',
      'Dashboard & console wipe',
      'Streak-free windows',
    ])
    expect(cat.packages.map((p) => p.bookableDesk)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ])
    expect(cat.packages[4]!.shortName).toBe('Executive Detail')
    expect(cat.packages[1]!.shortName).toBe('Premium Hand Wash')
  })

  it('applies the inspection filter to the source lists (the raw data does contain inspection tasks)', () => {
    const raw = DESIGN_PACKAGES.flatMap((p) => p.rawTasks).filter((x) => INSPECTION_TASK.test(x))
    expect(raw).toHaveLength(9)
    expect(raw).toContain('Hand-dry pre-inspection')
    expect(DESIGN_PACKAGES.map((p) => seedTasks(p).length)).toEqual([5, 7, 8, 10, 9, 10, 7, 9, 7])
    expect(DESIGN_ADDONS.map((a) => a.tasks.length)).toEqual([3, 3, 3, 2, 3, 2, 3, 2, 2, 3])
  })

  it('seeds the VIP settings, holds and arrival settings from the Settings design', async () => {
    await seed('domain')
    const loc = await LOC()
    const vip = await t.db
      .selectFrom('vip_settings')
      .selectAll()
      .where('location_id', '=', loc.id)
      .executeTakeFirstOrThrow()
    expect(vip).toMatchObject({
      release_hours: 48,
      window_vip_days: 30,
      window_std_days: 14,
      same_day_per_month: 2,
      waitlist: true,
      offer_minutes: 15,
      standing: true,
      auto_confirm: true,
      cadences: ['weekly', 'biweekly', 'monthly'],
    })
    const holds = await t.db.selectFrom('vip_holds').select(['weekday', 'time_min']).execute()
    expect(holds.map((h) => `${h.weekday}@${h.time_min}`).sort()).toEqual([
      '0@540',
      '5@960',
      '6@480',
      '6@540',
      '6@600',
    ])
    const arrival = await t.db
      .selectFrom('arrival_settings')
      .selectAll()
      .where('location_id', '=', loc.id)
      .executeTakeFirstOrThrow()
    expect(arrival).toMatchObject({
      enabled: true,
      radius_m: 300,
      prep_at_min: 15,
      auto_arrive: true,
      welcome: true,
      alert_crew: true,
      vip_first: true,
    })
  })

  it('seeds the two emergency history rows, newest first', async () => {
    await seed('domain')
    const loc = await LOC()
    const state = await getEmergencyState(t.db, { locationId: loc.id, now: t.clock.now(), tz: loc.timezone })
    expect(state.active).toBe(false)
    expect(state.history.map((h) => [h.date, h.reason, h.detail])).toEqual([
      ['Jun 3, 2026', 'Severe weather', 'Full day · 7 customers notified · 6 rebooked'],
      ['Feb 18, 2026', 'Power outage', '11:20 AM – 3:00 PM · 4 notified'],
    ])
    expect(state.history.map((h) => [h.affectedCount, h.notifiedCount, h.rebookedCount])).toEqual([
      [7, 7, 6],
      [4, 4, 0],
    ])
    const rows = await t.db
      .selectFrom('emergency_closures')
      .select(['started_at', 'ends_at', 'reopened_at', 'duration_kind', 'until_min'])
      .orderBy('started_at')
      .execute()
    expect(rows[0]!.started_at.toISOString()).toBe('2026-02-18T16:20:00.000Z') // 11:20 AM EST
    expect(rows[0]).toMatchObject({ duration_kind: 'until', until_min: 900 })
    expect(rows[0]!.ends_at!.toISOString()).toBe('2026-02-18T20:00:00.000Z') // 3:00 PM EST
    expect(rows[1]!.started_at.toISOString()).toBe('2026-06-03T11:30:00.000Z') // 7:30 AM EDT
  })

  it('seeds no appointments, invoices or people tables', async () => {
    await seed('design')
    expect(await t.db.selectFrom('appointments').select('id').execute()).toHaveLength(0)
    expect(await t.db.selectFrom('appointment_addons').select('id').execute()).toHaveLength(0)
    expect(await t.db.selectFrom('activity_log').select('id').execute()).toHaveLength(0)
  })
})

describe('seed data: design fixtures', () => {
  it('seeds the twelve design customers with synthetic 555-01xx numbers and their vehicles', async () => {
    await seed('domain-design')
    const rows = await t.db.selectFrom('customers').selectAll().orderBy('full_name').execute()
    expect(rows).toHaveLength(12)
    expect(rows.every((r) => r.synthetic && /^\+1[0-9]{3}55501[0-9]{2}$/.test(r.phone_e164!))).toBe(true)
    expect(
      rows.every(
        (r) => r.sms_opted_in && r.sms_opt_in_source === 'import' && r.email === null && !r.needs_details,
      ),
    ).toBe(true)
    expect(new Set(rows.map((r) => r.phone_e164)).size).toBe(12)
    expect(rows.find((r) => r.full_name === 'Liam Chen')).toMatchObject({
      phone_e164: '+13055550107',
      phone_display: '(305) 555-0107',
    })
    const vehicles = await t.db
      .selectFrom('vehicles as v')
      .innerJoin('customers as c', 'c.id', 'v.customer_id')
      .select(['c.full_name', 'v.year', 'v.make', 'v.model', 'v.color', 'v.plate'])
      .orderBy('c.full_name')
      .execute()
    expect(vehicles).toHaveLength(12)
    expect(vehicles.find((v) => v.full_name === 'Marcus Webb')).toEqual({
      full_name: 'Marcus Webb',
      year: 2017,
      make: 'Jeep',
      model: 'Wrangler',
      color: 'Sarge Green',
      plate: 'JEP-7720',
    })
    expect(vehicles.find((v) => v.full_name === 'Aisha Rahman')).toMatchObject({
      make: 'Range Rover',
      model: 'Sport',
      plate: 'RR-5567',
    })
    expect(DESIGN_CUSTOMERS.map((c) => c.ref)).toEqual(Array.from({ length: 12 }, (_, i) => `a${i + 1}`))
  })

  it('does not reuse the real-looking numbers of the design', async () => {
    await seed('domain-design')
    const phones = (await t.db.selectFrom('customers').select('phone_e164').execute()).map(
      (r) => r.phone_e164,
    )
    for (const real of ['+13054128890', '+17862201144', '+13052337765', '+13059047781'])
      expect(phones).not.toContain(real)
  })

  it('makes the four VIP names VIP clients, resolved to customers', async () => {
    await seed('domain-design')
    const loc = await LOC()
    const vips = await t.db
      .selectFrom('vip_clients as v')
      .innerJoin('customers as c', 'c.id', 'v.customer_id')
      .select('c.full_name')
      .where('v.location_id', '=', loc.id)
      .execute()
    expect(vips.map((v) => v.full_name).sort()).toEqual([...DESIGN_VIP_NAMES].sort())
    const hits = await searchCustomers(t.db, { locationId: loc.id, q: 'aisha', canContact: false })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ vip: true, phoneDisplay: null })
  })

  it("lists the VIP clients in the design's order (the list is ordered by when each was added)", async () => {
    await seed('domain-design')
    const loc = await LOC()
    const listed = await listVipClients(t.db, loc.id)
    expect(listed.map((v) => v.fullName)).toEqual([...DESIGN_VIP_NAMES])
  })
})

describe('seed idempotency', () => {
  it('running the design profile twice (and a third time) changes nothing', async () => {
    await seed('design')
    const first = await snapshot()
    await seed('design')
    expect(await snapshot()).toEqual(first)
    await seed('design')
    expect(await snapshot()).toEqual(first)
    const counts = Object.fromEntries(Object.entries(first).map(([k, v]) => [k, v.length]))
    expect(counts).toMatchObject({
      services: 19,
      checklist_tasks: 72 + 26,
      customers: 12,
      vehicles: 12,
      bays: 2,
      business_hours: 7,
      booking_rules: 1,
      closures: 7,
      federal_holiday_runs: 1,
      emergency_closures: 2,
      vip_settings: 1,
      vip_holds: 5,
      vip_clients: 4,
      arrival_settings: 1,
    })
  })

  it('does not undo edits made after seeding (price, renamed and retired tasks, removed closure)', async () => {
    await seed('design')
    const loc = await LOC()
    const wash = await t.db
      .selectFrom('services')
      .select('id')
      .where('name', '=', 'Express Hand Wash')
      .executeTakeFirstOrThrow()
    await t.db.updateTable('services').set({ price_cents: 4900 }).where('id', '=', wash.id).execute()
    await t.db
      .updateTable('checklist_tasks')
      .set({ label: 'Pre-rinse' })
      .where('service_id', '=', wash.id)
      .where('label', '=', 'Exterior rinse')
      .execute()
    await t.db
      .updateTable('checklist_tasks')
      .set({ retired_at: new Date('2026-06-01T00:00:00Z') })
      .where('service_id', '=', wash.id)
      .where('label', '=', 'Hand wash')
      .execute()
    await t.db
      .updateTable('closures')
      .set({ deleted_at: new Date('2026-06-01T00:00:00Z') })
      .where('name', '=', 'Christmas Eve')
      .execute()
    const before = await snapshot()
    await seed('design')
    expect(await snapshot()).toEqual(before)
    expect(await listLiveClosures(t.db, loc.id)).toHaveLength(6)
  })

  it('adopts a customer that already owns a seed phone number instead of duplicating or renaming it', async () => {
    await seed('domain')
    const loc = await LOC()
    await t.db
      .insertInto('customers')
      .values({
        id: '00000000-0000-7000-8000-0000000000c1',
        full_name: 'Existing Liam',
        phone_e164: '+13055550107',
        phone_display: '(305) 555-0107',
        email: null,
        notes: null,
        synthetic: true,
      })
      .execute()
    await seed('domain-design')
    expect(await t.db.selectFrom('customers').select('id').execute()).toHaveLength(12)
    expect(
      await t.db
        .selectFrom('customers')
        .select('full_name')
        .where('phone_e164', '=', '+13055550107')
        .executeTakeFirstOrThrow(),
    ).toEqual({ full_name: 'Existing Liam' })
    const vehicle = await t.db
      .selectFrom('vehicles')
      .select('plate')
      .where('customer_id', '=', '00000000-0000-7000-8000-0000000000c1')
      .execute()
    expect(vehicle).toEqual([{ plate: 'BMW-3401' }])
    const vip = await t.db
      .selectFrom('vip_clients')
      .select('customer_id')
      .where('location_id', '=', loc.id)
      .execute()
    expect(vip.map((v) => v.customer_id)).toContain('00000000-0000-7000-8000-0000000000c1')
  })
})
