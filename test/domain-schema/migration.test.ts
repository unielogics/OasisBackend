import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { transaction } from '../../src/platform/db.js'
import { loadMigrationFiles } from '../../src/platform/migrate.js'
import { useTestDb } from '../helpers/db.js'
import {
  edt,
  makeAppointment,
  makeBay,
  makeCustomer,
  makeService,
  makeVehicle,
  setupLocation,
} from './helpers.js'

const t = useTestDb({ poolMax: 6 })

const constraintOf = (e: unknown): string | undefined => (e as { constraint?: string }).constraint
const codeOf = (e: unknown): string | undefined => (e as { code?: string }).code
async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error('expected the statement to fail')
}

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
  'emergency_notifications',
  'reschedule_links',
  'vip_settings',
  'vip_holds',
  'vip_clients',
  'arrival_settings',
  'appointments',
  'appointment_addons',
  'appointment_overrides',
  'job_checklist_items',
  'appointment_photos',
  'activity_log',
]

describe('domain_core migration', () => {
  it('is applied after platform_core and creates every domain table', async () => {
    const applied = await sql<{ name: string }>`select name from schema_migrations order by name`.execute(
      t.db,
    )
    const names = applied.rows.map((r) => r.name)
    expect(names.indexOf('20261006150000_domain_core.sql')).toBeGreaterThan(
      names.indexOf('20261006130000_platform_core.sql'),
    )
    expect(loadMigrationFiles().map((m) => m.name)).toContain('20261006150000_domain_core.sql')
    const tables = await sql<{
      tablename: string
    }>`select tablename from pg_tables where schemaname = current_schema()`.execute(t.db)
    const have = new Set(tables.rows.map((r) => r.tablename))
    for (const name of DOMAIN_TABLES) expect(have.has(name), name).toBe(true)
  })

  it('creates no payments, ledger, membership or messaging tables (later migrations own them)', () => {
    const text = loadMigrationFiles().find((m) => m.name === '20261006150000_domain_core.sql')!.sql
    for (const banned of ['invoices', 'ledger_events', 'memberships', 'messages', 'message_threads'])
      expect(text, banned).not.toMatch(new RegExp(`create table ${banned}\\b`, 'i'))
  })

  it('links to the people and auth tables (domain_links) but not to membership, messaging or standing-series tables', async () => {
    // Only the foreign keys OF the domain tables: the verticals' own tables (membership_credit_events, messages, ...) reference
    // their parents freely. The appointment columns that point at those verticals get their keys in a later links migration.
    const fks = await sql<{ ref: string; src: string }>`
      select confrelid::regclass::text as ref, conrelid::regclass::text as src from pg_constraint
      where contype = 'f' and connamespace = current_schema()::regnamespace`.execute(t.db)
    const bare = (name: string): string => name.replace(/^"?[^".]+"?\./, '').replace(/"/g, '')
    const domain = fks.rows.filter((r) => DOMAIN_TABLES.includes(bare(r.src)))
    const targets = new Set(domain.map((r) => bare(r.ref)))
    for (const linked of ['employees', 'users']) expect(targets.has(linked)).toBe(true)
    for (const banned of ['memberships', 'messages', 'standing_series'])
      expect(targets.has(banned)).toBe(false)
  })
})

describe('bays and the bay-occupancy guard', () => {
  it('lets exactly one of several concurrent starts take a bay', async () => {
    const f = await setupLocation(t)
    const bay = await makeBay(t.db, f, 1)
    const service = await makeService(t.db, f)
    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      const c = await makeCustomer(t.db, f)
      ids.push(
        await makeAppointment(t.db, f, {
          customerId: c,
          serviceId: service,
          start: edt('2026-06-13', '10:00'),
          status: 'arrived',
        }),
      )
    }
    const results = await Promise.allSettled(
      ids.map((id) =>
        transaction(t.db, (tx) =>
          tx
            .updateTable('appointments')
            .set({ status: 'cleaning', bay_id: bay, cleaning_started_at: new Date('2026-06-13T14:00:00Z') })
            .where('id', '=', id)
            .execute(),
        ),
      ),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(rejected).toHaveLength(3)
    for (const r of rejected) {
      expect(codeOf(r.reason)).toBe('23505')
      expect(constraintOf(r.reason)).toBe('uq_bay_occupied')
    }
    const cleaning = await t.db
      .selectFrom('appointments')
      .select('id')
      .where('status', '=', 'cleaning')
      .execute()
    expect(cleaning).toHaveLength(1)
  })

  it('frees the bay once the job completes', async () => {
    const f = await setupLocation(t)
    const bay = await makeBay(t.db, f, 1)
    const service = await makeService(t.db, f)
    const a = await makeAppointment(t.db, f, {
      customerId: await makeCustomer(t.db, f),
      serviceId: service,
      start: edt('2026-06-13', '10:00'),
      status: 'cleaning',
      bayId: bay,
    })
    const b = await makeAppointment(t.db, f, {
      customerId: await makeCustomer(t.db, f),
      serviceId: service,
      start: edt('2026-06-13', '11:00'),
      status: 'arrived',
    })
    const blocked = await failure(
      t.db.updateTable('appointments').set({ status: 'cleaning', bay_id: bay }).where('id', '=', b).execute(),
    )
    expect(constraintOf(blocked)).toBe('uq_bay_occupied')
    await t.db.updateTable('appointments').set({ status: 'completed' }).where('id', '=', a).execute()
    await t.db
      .updateTable('appointments')
      .set({ status: 'cleaning', bay_id: bay })
      .where('id', '=', b)
      .execute()
    const row = await t.db
      .selectFrom('appointments')
      .select('status')
      .where('id', '=', b)
      .executeTakeFirstOrThrow()
    expect(row.status).toBe('cleaning')
  })

  it('refuses a cleaning job with no bay, and a second bay with the same number', async () => {
    const f = await setupLocation(t)
    await makeBay(t.db, f, 1)
    const service = await makeService(t.db, f)
    const c = await makeCustomer(t.db, f)
    const e = await failure(
      makeAppointment(t.db, f, {
        customerId: c,
        serviceId: service,
        start: edt('2026-06-13', '10:00'),
        status: 'cleaning',
        bayId: null,
      }),
    )
    expect(codeOf(e)).toBe('23514')
    expect(codeOf(await failure(makeBay(t.db, f, 1)))).toBe('23505')
  })

  it('rejects an appointment that ends before it starts and an unknown status', async () => {
    const f = await setupLocation(t)
    const service = await makeService(t.db, f)
    const c = await makeCustomer(t.db, f)
    expect(
      codeOf(
        await failure(
          makeAppointment(t.db, f, {
            customerId: c,
            serviceId: service,
            start: edt('2026-06-13', '10:00'),
            durationMin: 0,
          }),
        ),
      ),
    ).toBe('23514')
    expect(
      codeOf(
        await failure(
          makeAppointment(t.db, f, {
            customerId: c,
            serviceId: service,
            start: edt('2026-06-13', '10:00'),
            status: 'ready' as never,
          }),
        ),
      ),
    ).toBe('23514')
  })
})

describe('business hours and booking rules checks', () => {
  const hours = (o: { open: number; close: number; weekday?: number }) =>
    t.db
      .updateTable('business_hours')
      .set({ open_min: o.open, close_min: o.close })
      .where('weekday', '=', o.weekday ?? 1)

  it('enforces open < close, 300..1410 and the 30-minute grid', async () => {
    await setupLocation(t)
    for (const bad of [
      { open: 600, close: 600 },
      { open: 720, close: 600 },
      { open: 270, close: 600 },
      { open: 600, close: 1440 },
      { open: 615, close: 900 },
      { open: 600, close: 905 },
    ])
      expect(codeOf(await failure(hours(bad).execute())), JSON.stringify(bad)).toBe('23514')
    await hours({ open: 300, close: 1410 }).execute()
    const row = await t.db
      .selectFrom('business_hours')
      .select(['open_min', 'close_min'])
      .where('weekday', '=', 1)
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ open_min: 300, close_min: 1410 })
  })

  it('rejects a weekday outside 0..6 and keeps one row per weekday', async () => {
    const f = await setupLocation(t)
    const weekdays = await t.db
      .selectFrom('business_hours')
      .select('weekday')
      .where('location_id', '=', f.locationId)
      .orderBy('weekday')
      .execute()
    expect(weekdays.map((w) => w.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6])
    const e = await failure(
      t.db
        .insertInto('business_hours')
        .values({ location_id: f.locationId, weekday: 7, is_open: true, open_min: 480, close_min: 1080 })
        .execute(),
    )
    expect(codeOf(e)).toBe('23514')
  })

  it('limits slot, buffer and cutoff to the design values and defaults to 30/10/60', async () => {
    const f = await setupLocation(t)
    const r = await t.db
      .selectFrom('booking_rules')
      .selectAll()
      .where('location_id', '=', f.locationId)
      .executeTakeFirstOrThrow()
    expect([r.slot_minutes, r.buffer_minutes, r.cutoff_minutes, r.version]).toEqual([30, 10, 60, 1])
    for (const set of [{ slot_minutes: 20 }, { buffer_minutes: 5 }, { cutoff_minutes: 45 }])
      expect(
        codeOf(
          await failure(
            t.db.updateTable('booking_rules').set(set).where('location_id', '=', f.locationId).execute(),
          ),
        ),
      ).toBe('23514')
    await t.db
      .updateTable('booking_rules')
      .set({ slot_minutes: 15, buffer_minutes: 0, cutoff_minutes: 90 })
      .where('location_id', '=', f.locationId)
      .execute()
  })
})

describe('closures', () => {
  const insert = (f: { locationId: string; newId: () => string }, o: Record<string, unknown>) =>
    t.db
      .insertInto('closures')
      .values({
        id: f.newId(),
        location_id: f.locationId,
        date: '2026-07-04',
        name: 'Independence Day',
        type: 'closed',
        open_min: null,
        close_min: null,
        federal_key: null,
        federal_year: null,
        emergency_closure_id: null,
        created_by: null,
        deleted_at: null,
        ...o,
      } as never)
      .execute()

  it('allows one live closure per date but a new one after the first is soft-deleted', async () => {
    const f = await setupLocation(t)
    await insert(f, {})
    expect(constraintOf(await failure(insert(f, { name: 'Other' })))).toBe('uq_closures_date_live')
    await t.db
      .updateTable('closures')
      .set({ deleted_at: new Date('2026-06-01T00:00:00Z') })
      .where('date', '=', '2026-07-04')
      .execute()
    await insert(f, { name: 'Other' })
  })

  it('keeps a federal key unique even when its closure was soft-deleted', async () => {
    const f = await setupLocation(t)
    const federal = { source: 'federal', federal_key: 'independence_day', federal_year: 2026 }
    await insert(f, federal)
    await t.db
      .updateTable('closures')
      .set({ deleted_at: new Date('2026-06-01T00:00:00Z') })
      .where('federal_key', '=', 'independence_day')
      .execute()
    expect(constraintOf(await failure(insert(f, { ...federal, date: '2026-07-03' })))).toBe(
      'uq_closures_federal',
    )
    await insert(f, { ...federal, federal_year: 2027, date: '2027-07-04' })
  })

  it('requires times for reduced days only, and a federal key to carry a year', async () => {
    const f = await setupLocation(t)
    expect(codeOf(await failure(insert(f, { type: 'reduced' })))).toBe('23514')
    expect(codeOf(await failure(insert(f, { type: 'reduced', open_min: 840, close_min: 600 })))).toBe('23514')
    expect(codeOf(await failure(insert(f, { type: 'closed', open_min: 600, close_min: 840 })))).toBe('23514')
    expect(codeOf(await failure(insert(f, { source: 'federal', federal_key: 'labor_day' })))).toBe('23514')
    expect(
      codeOf(await failure(insert(f, { source: 'manual', federal_key: 'labor_day', federal_year: 2026 }))),
    ).toBe('23514')
    await insert(f, { type: 'reduced', open_min: 600, close_min: 840 })
  })

  it('ties source emergency to an emergency closure row', async () => {
    const f = await setupLocation(t)
    expect(codeOf(await failure(insert(f, { source: 'emergency' })))).toBe('23514')
  })
})

describe('emergency closures', () => {
  const insert = (f: { locationId: string; newId: () => string }, o: Record<string, unknown> = {}) =>
    t.db
      .insertInto('emergency_closures')
      .values({
        id: f.newId(),
        location_id: f.locationId,
        reason: 'severe_weather',
        duration_kind: 'today',
        until_min: null,
        through_date: null,
        ends_at: null,
        started_by: null,
        started_by_name: null,
        reopened_at: null,
        reopened_by: null,
        reopened_by_name: null,
        detail: null,
        ...o,
      } as never)
      .execute()

  it('allows a single active emergency per location while history rows are unlimited', async () => {
    const f = await setupLocation(t)
    await insert(f)
    expect(constraintOf(await failure(insert(f)))).toBe('uq_emergency_one_active')
    await insert(f, { active: false, reopened_at: new Date('2026-06-03T22:00:00Z') })
    await insert(f, { active: false, reopened_at: new Date('2026-02-18T20:00:00Z') })
  })

  it('needs a reopening time for until and a reopened_at for inactive rows', async () => {
    const f = await setupLocation(t)
    expect(codeOf(await failure(insert(f, { duration_kind: 'until' })))).toBe('23514')
    expect(codeOf(await failure(insert(f, { active: false })))).toBe('23514')
  })
})

describe('customers and vehicles', () => {
  it('keeps live phone numbers unique but lets merged or deleted rows free the number', async () => {
    const f = await setupLocation(t)
    const a = await makeCustomer(t.db, f, { line: '0150' })
    expect(constraintOf(await failure(makeCustomer(t.db, f, { line: '0150' })))).toBe('uq_customers_phone')
    await t.db
      .updateTable('customers')
      .set({ deleted_at: new Date('2026-06-01T00:00:00Z') })
      .where('id', '=', a)
      .execute()
    const b = await makeCustomer(t.db, f, { line: '0150' })
    await t.db.updateTable('customers').set({ merged_into: b }).where('id', '=', a).execute()
    await makeCustomer(t.db, f, { noPhone: true })
    await makeCustomer(t.db, f, { noPhone: true })
  })

  it('only accepts E.164 numbers, and synthetic people only in the 555-01xx range', async () => {
    const f = await setupLocation(t)
    const insert = (phone: string, synthetic: boolean) =>
      t.db
        .insertInto('customers')
        .values({
          id: f.newId(),
          full_name: 'Test',
          phone_e164: phone,
          phone_display: null,
          email: null,
          notes: null,
          synthetic,
        })
        .execute()
    expect(codeOf(await failure(insert('305-555-0142', false)))).toBe('23514')
    expect(codeOf(await failure(insert('+13055550142x', false)))).toBe('23514')
    expect(codeOf(await failure(insert('+13054125555', true)))).toBe('23514')
    await insert('+13054125555', false)
    await insert('+13055550142', true)
  })

  it('ties a customer to at most one vehicle per plate, case-insensitively', async () => {
    const f = await setupLocation(t)
    const c = await makeCustomer(t.db, f)
    await makeVehicle(t.db, f, c, { plate: 'KLP-8842' })
    expect(constraintOf(await failure(makeVehicle(t.db, f, c, { plate: 'klp-8842' })))).toBe(
      'uq_vehicles_customer_plate',
    )
    await makeVehicle(t.db, f, await makeCustomer(t.db, f), { plate: 'KLP-8842' })
    await makeVehicle(t.db, f, c, { plate: null })
    await makeVehicle(t.db, f, c, { plate: null })
  })

  it('stores citext emails case-insensitively and has trigram indexes for search', async () => {
    const f = await setupLocation(t)
    await makeCustomer(t.db, f, { email: 'Maria@Example.com' })
    const hit = await t.db
      .selectFrom('customers')
      .select('id')
      .where('email', '=', 'maria@example.com')
      .execute()
    expect(hit).toHaveLength(1)
    const idx = await sql<{
      indexname: string
    }>`select indexname from pg_indexes where schemaname = current_schema() and tablename = 'customers' and indexdef ilike '%gin_trgm_ops%'`.execute(
      t.db,
    )
    expect(idx.rows.map((r) => r.indexname).sort()).toEqual([
      'customers_email_trgm',
      'customers_full_name_trgm',
      'customers_phone_trgm',
    ])
  })
})

describe('catalog, VIP, add-on and photo constraints', () => {
  it('keeps service names unique per location and kind, ignoring case, and add-ons at zero minutes', async () => {
    const f = await setupLocation(t)
    await makeService(t.db, f, { name: 'Wax', kind: 'addon' })
    expect(constraintOf(await failure(makeService(t.db, f, { name: 'wax', kind: 'addon' })))).toBe(
      'uq_services_name',
    )
    await makeService(t.db, f, { name: 'Wax', kind: 'package' })
    const bad = await failure(
      t.db
        .insertInto('services')
        .values({
          id: f.newId(),
          location_id: f.locationId,
          kind: 'addon',
          name: 'Timed',
          short_name: null,
          price_cents: 100,
          duration_min: 10,
          sqsp_sku: null,
        })
        .execute(),
    )
    expect(codeOf(bad)).toBe('23514')
    const zeroPackage = await failure(
      t.db
        .insertInto('services')
        .values({
          id: f.newId(),
          location_id: f.locationId,
          kind: 'package',
          name: 'Zero',
          short_name: null,
          price_cents: 100,
          duration_min: 0,
          sqsp_sku: null,
        })
        .execute(),
    )
    expect(codeOf(zeroPackage)).toBe('23514')
  })

  it('holds one VIP slot per weekday and time, and validates VIP/arrival value sets', async () => {
    const f = await setupLocation(t)
    const hold = (weekday: number, time: number) =>
      t.db
        .insertInto('vip_holds')
        .values({ id: f.newId(), location_id: f.locationId, weekday, time_min: time })
        .execute()
    await hold(6, 480)
    expect(codeOf(await failure(hold(6, 480)))).toBe('23505')
    await hold(6, 510)
    expect(codeOf(await failure(hold(6, 485)))).toBe('23514')
    for (const set of [
      { release_hours: 36 },
      { window_vip_days: 91 },
      { window_std_days: 61 },
      { same_day_per_month: 9 },
      { offer_minutes: 20 },
      { cadences: ['daily'] },
    ])
      expect(
        codeOf(
          await failure(
            t.db.updateTable('vip_settings').set(set).where('location_id', '=', f.locationId).execute(),
          ),
        ),
      ).toBe('23514')
    for (const set of [{ radius_m: 200 }, { prep_at_min: 12 }])
      expect(
        codeOf(
          await failure(
            t.db.updateTable('arrival_settings').set(set).where('location_id', '=', f.locationId).execute(),
          ),
        ),
      ).toBe('23514')
  })

  it('allows one live add-on row per appointment and service, and a photo note without a file only for issues', async () => {
    const f = await setupLocation(t)
    const service = await makeService(t.db, f)
    const addon = await makeService(t.db, f, { kind: 'addon', name: 'Wax' })
    const appt = await makeAppointment(t.db, f, {
      customerId: await makeCustomer(t.db, f),
      serviceId: service,
      start: edt('2026-06-13', '10:00'),
    })
    const add = (removed: Date | null) =>
      t.db
        .insertInto('appointment_addons')
        .values({
          id: f.newId(),
          appointment_id: appt,
          service_id: addon,
          name: 'Wax',
          price_cents: 4000,
          added_by: null,
          removed_at: removed,
        })
        .execute()
    await add(null)
    expect(constraintOf(await failure(add(null)))).toBe('uq_appointment_addons_live')
    await add(new Date('2026-06-13T15:00:00Z'))
    const photo = (category: 'issue' | 'before', key: string | null, note: string | null) =>
      t.db
        .insertInto('appointment_photos')
        .values({
          id: f.newId(),
          appointment_id: appt,
          category,
          s3_key: key,
          thumb_key: null,
          content_type: null,
          bytes: null,
          note,
          status: 'ready',
          uploaded_by: null,
        })
        .execute()
    await photo('issue', null, 'Scratch on rear bumper')
    expect(codeOf(await failure(photo('before', null, 'no file')))).toBe('23514')
    expect(codeOf(await failure(photo('issue', null, null)))).toBe('23514')
  })

  it('reads every default through app_now (a frozen clock reaches the columns)', async () => {
    const f = await setupLocation(t)
    const c = await makeCustomer(t.db, f)
    const row = await t.db
      .selectFrom('customers')
      .select('created_at')
      .where('id', '=', c)
      .executeTakeFirstOrThrow()
    expect(row.created_at.toISOString()).toBe('2026-06-13T14:36:00.000Z')
  })
})
