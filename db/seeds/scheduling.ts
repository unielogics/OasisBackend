// Seed profile "parity-ops": the Operations design's day, as data. Always anchored on the design's frozen clock
// (Saturday 2026-06-13, 10:36 AM Eastern), whatever the injected clock says, so the parity database and the oracle tests
// see the same board.
//
//   - the 12 design appointments a1..a12 with statuses, bays, staff, add-ons, notes, ETAs and check-in times, the
//     checklist snapshot with the design's done marks (cleaning 50%, completed 100%), photo rows and a short activity
//     history per the design's lazily built log;
//   - the design's procedural calendar days (genDay) for 210 days either side, except today and tomorrow, so week and month
//     counts are real rows and reproduce the design's counts (those days carry appointments only: no add-ons, photos or
//     checklists). Tomorrow keeps only a12: the design's calendar counts 5 procedural jobs there that its board never
//     lists, a contradiction recorded in test/golden/ops/DEVIATIONS.md.
//
// Invoices, tips, deposits and memberships belong to the Payments and Memberships verticals: PARITY_OPS_MONEY and
// PARITY_OPS_MEMBERS describe what the design shows, for the tests and for those seeds to consume. Idempotent: a second
// run inserts nothing (appointments are keyed by customer, start and package).
import { sql } from 'kysely'
import { PARITY_NOW } from '../../src/platform/clock.js'
import { formatPhoneDisplay } from '../../src/platform/phone.js'
import { mulberry32 } from '../../src/platform/random.js'
import { addDays, parseT, wallToInstant } from '../../src/platform/time.js'
import { buildPhotoKey } from '../../src/integrations/storage/keys.js'
import { listCatalog, type CatalogService } from '../../src/modules/catalog/service.js'
import { addAddonChecklist, snapshotPackageChecklist } from '../../src/modules/scheduling/checklist.js'
import type { SchedulingCtx } from '../../src/modules/scheduling/context.js'
import { listLiveClosures } from '../../src/modules/settings/closures.js'
import { dayInfo } from '../../src/modules/settings/day-info.js'
import { getHours } from '../../src/modules/settings/hours.js'
import '../../src/modules/customers/schema.js'
import type { SeedContext, SeedProfile } from './index.js'

export const BASE_DATE = '2026-06-13'
const TZ = 'America/New_York'
export const PARITY_NOW_MS = new Date(PARITY_NOW).getTime()

type Staff = 'Marco R.' | 'Lena K.' | 'Sofia D.' | 'Unassigned'
type Status = 'booked' | 'confirmed' | 'arrived' | 'cleaning' | 'completed'

export interface DesignAppointment {
  id: string
  day: 0 | 1
  /** "8:30 AM". */
  time: string
  status: Status
  staff: Staff
  customer: string
  svc: string
  bay: 1 | 2 | null
  addons: string[]
  notes?: string
  special?: string
  eta?: number
  /** Geofence check-in clock, "10:27 AM". */
  geoIn?: string
  startedAgo?: number
  pickup?: 'collected' | 'pending'
}

export const DESIGN_APPOINTMENTS: readonly DesignAppointment[] = [
  { id: 'a1', day: 0, time: '8:30 AM', status: 'completed', staff: 'Lena K.', customer: 'Maria Delgado', svc: 'Express Hand Wash', bay: 2, addons: ['Wax'], pickup: 'collected' },
  { id: 'a2', day: 0, time: '9:15 AM', status: 'completed', staff: 'Marco R.', customer: 'David Okafor', svc: 'Full Detail', bay: 1, addons: ['Engine bay cleaning'], pickup: 'collected' },
  { id: 'a3', day: 0, time: '9:45 AM', status: 'completed', staff: 'Lena K.', customer: 'Priya Nair', svc: 'Premium Hand Wash + Interior', bay: 2, addons: ['Rain repellent'], pickup: 'pending', notes: 'Customer prefers no fragrance products. Parked in the south lot.' },
  { id: 'a4', day: 0, time: '10:00 AM', status: 'cleaning', staff: 'Marco R.', customer: 'Jonathan Franco', svc: 'Premium Hand Wash + Interior Refresh', bay: 1, addons: ['Leather conditioning'], startedAgo: 27, notes: 'Regular — every other Saturday. Likes a text when 10 min out.' },
  { id: 'a5', day: 0, time: '10:30 AM', status: 'arrived', staff: 'Sofia D.', customer: 'Sofia Marchetti', svc: 'Executive Detail', bay: 2, addons: [], geoIn: '10:27 AM', notes: 'New ceramic coating — pH-neutral products only.' },
  { id: 'a6', day: 0, time: '10:45 AM', status: 'confirmed', staff: 'Marco R.', customer: 'Liam Chen', svc: 'Ceramic Maintenance + Wax', bay: 1, addons: [], eta: 12 },
  { id: 'a7', day: 0, time: '10:15 AM', status: 'confirmed', staff: 'Unassigned', customer: 'Marcus Webb', svc: 'Family Wash + Pet Hair', bay: null, addons: ['Odor removal'] },
  { id: 'a8', day: 0, time: '11:00 AM', status: 'booked', staff: 'Sofia D.', customer: 'Grace Adeyemi', svc: 'Express Hand Wash', bay: 2, addons: [], eta: 22 },
  { id: 'a9', day: 0, time: '12:00 PM', status: 'confirmed', staff: 'Marco R.', customer: 'Aisha Rahman', svc: 'Executive Detail + Ceramic', bay: 1, addons: ['Ceramic maintenance'] },
  { id: 'a10', day: 0, time: '1:30 PM', status: 'confirmed', staff: 'Sofia D.', customer: 'Tom Bradley', svc: 'Express Hand Wash', bay: 2, addons: [] },
  { id: 'a11', day: 0, time: '3:00 PM', status: 'booked', staff: 'Marco R.', customer: 'Elena Volkov', svc: 'Exotic Detail Package', bay: 1, addons: [], special: 'Hand-dry only — no automated equipment near paint. Owner inspects before release.' },
  { id: 'a12', day: 1, time: '9:00 AM', status: 'confirmed', staff: 'Lena K.', customer: 'Nathan Brooks', svc: 'Family Wash + Pet Hair', bay: 2, addons: ['Pet hair removal'] },
]

/** What the design shows for each appointment's money (the Payments seed builds the invoices from this). */
export const PARITY_OPS_MONEY: Readonly<Record<string, { pay: 'paid' | 'unpaid' | 'deposit'; depositCents: number; tipCents: number }>> = {
  a1: { pay: 'paid', depositCents: 0, tipCents: 800 },
  a2: { pay: 'paid', depositCents: 0, tipCents: 2000 },
  a3: { pay: 'unpaid', depositCents: 0, tipCents: 0 },
  a4: { pay: 'paid', depositCents: 0, tipCents: 0 },
  a5: { pay: 'deposit', depositCents: 5000, tipCents: 0 },
  a6: { pay: 'paid', depositCents: 0, tipCents: 0 },
  a7: { pay: 'deposit', depositCents: 2000, tipCents: 0 },
  a8: { pay: 'unpaid', depositCents: 0, tipCents: 0 },
  a9: { pay: 'paid', depositCents: 0, tipCents: 0 },
  a10: { pay: 'unpaid', depositCents: 0, tipCents: 0 },
  a11: { pay: 'unpaid', depositCents: 0, tipCents: 0 },
  a12: { pay: 'paid', depositCents: 0, tipCents: 0 },
}

/** The membership plan label per design customer (the Memberships seed owns the rows). */
export const PARITY_OPS_MEMBERS: Readonly<Record<string, string>> = {
  'Maria Delgado': 'Essential',
  'Priya Nair': 'Premium',
  'Jonathan Franco': 'Premium Care',
  'Sofia Marchetti': 'Executive',
  'Aisha Rahman': 'Exotic',
  'Elena Volkov': 'Exotic',
  'Nathan Brooks': 'Essential',
}

// The design's procedural days ----------------------------------------------------------------------------------------

export const POOL_NAMES = [
  'Olivia Hart', 'Ethan Morales', 'Chloe Bennett', 'Mateo Silva', 'Hannah Kim', 'Isaac Patel', 'Zoe Laurent',
  'Andre Thompson', 'Camila Reyes', 'Noah Fischer', 'Leah Goldberg', 'Omar Haddad', 'Ruby Castillo',
  'Victor Nguyen', 'Ava Sinclair', 'Diego Ramos', 'Nina Petrova', 'Caleb Owens', 'Mia Torres', 'Julian Brooks',
] as const

export const POOL_VEHICLES: readonly [number, string, string, string][] = [
  [2022, 'BMW', 'X5', 'Carbon Black'],
  [2021, 'Toyota', '4Runner', 'Lunar Rock'],
  [2023, 'Audi', 'e-tron GT', 'Tactical Green'],
  [2020, 'Honda', 'Accord', 'Platinum White'],
  [2024, 'Rivian', 'R1S', 'Glacier White'],
  [2019, 'Mercedes-Benz', 'C300', 'Selenite Grey'],
  [2022, 'Ford', 'Bronco', 'Cactus Gray'],
  [2023, 'Porsche', '911 Carrera', 'GT Silver'],
  [2021, 'Kia', 'Telluride', 'Gravity Gray'],
  [2022, 'Tesla', 'Model 3', 'Deep Blue'],
  [2024, 'Lexus', 'GX 550', 'Wind Chill Pearl'],
  [2023, 'Genesis', 'GV80', 'Uyuni White'],
]

const PACKAGE_ORDER = [
  'Express Hand Wash',
  'Premium Hand Wash + Interior',
  'Premium Hand Wash + Interior Refresh',
  'Executive Detail',
  'Executive Detail + Ceramic',
  'Full Detail',
  'Ceramic Maintenance + Wax',
  'Exotic Detail Package',
  'Family Wash + Pet Hair',
] as const

const GEN_STAFF = ['Marco R.', 'Lena K.', 'Sofia D.'] as const

export interface GeneratedAppointment {
  offset: number
  index: number
  startMin: number
  status: 'completed' | 'confirmed' | 'booked'
  staff: (typeof GEN_STAFF)[number]
  customerIdx: number
  vehicle: (typeof POOL_VEHICLES)[number]
  plate: string
  svc: string
  bayNumber: 1 | 2
}

/** The design's dayCount: how many appointments a day has (before the closed and reduced-hours rules). */
export function designDayCount(offset: number, weekday: number, reduced: boolean): { n: number; rnd: () => number } {
  const rnd = mulberry32(offset * 7919 + 104729)
  let n = Math.max(2, [4, 6, 6, 7, 7, 9, 10][weekday]! + Math.floor(rnd() * 4) - 1)
  if (reduced) n = Math.ceil(n / 2)
  return { n, rnd }
}

/**
 * The design's genDay(o), consuming the PRNG in exactly its order so names, vehicles, statuses and times match.
 * `h0` and `h1` are the day's grid rows (floor of the open hour, ceil of the close hour).
 */
export function designGenDay(offset: number, weekday: number, h0: number, h1: number, reduced: boolean): GeneratedAppointment[] {
  const { n, rnd } = designDayCount(offset, weekday, reduced)
  const start = Math.max(h0 * 60, offset === 1 ? 11 * 60 : 0)
  const end = Math.max(start, h1 * 60 - 60)
  const slots: number[] = []
  for (let m = start; m <= end; m += 30) slots.push(m)
  const past = offset < 0
  const picks = Array.from({ length: n }, () => slots[Math.floor(rnd() * slots.length)]!).sort((x, y) => x - y)
  return picks.map((m, i) => {
    const customerIdx = Math.floor(rnd() * POOL_NAMES.length)
    const vehicle = POOL_VEHICLES[Math.floor(rnd() * POOL_VEHICLES.length)]!
    const status = past ? 'completed' : rnd() < 0.7 ? 'confirmed' : 'booked'
    rnd() // phone: area-code line
    rnd() // phone: number
    const plate = `${vehicle[1].slice(0, 3).toUpperCase()}-${1000 + Math.floor(rnd() * 8999)}`
    const svc = PACKAGE_ORDER[Math.floor(rnd() * PACKAGE_ORDER.length)]!
    if (rnd() < 0.35) rnd() // member
    if (!past && !(rnd() < 0.45)) rnd() // pay split
    if (rnd() < 0.4) rnd() // add-on pick
    if (past) rnd() // tip
    return { offset, index: i, startMin: m, status, staff: GEN_STAFF[i % 3]!, customerIdx, vehicle, plate, svc, bayNumber: ((i % 2) + 1) as 1 | 2 }
  })
}

const GEN_RANGE = 210

// Runner ---------------------------------------------------------------------------------------------------------------

const key = (customerId: string, startMs: number, serviceId: string): string => `${customerId}|${startMs}|${serviceId}`

export async function seedParityOps(ctx: SeedContext): Promise<void> {
  const { tx, location } = ctx
  const c: SchedulingCtx = {
    clock: ctx.clock,
    newId: ctx.newId,
    locationId: location.id,
    tz: location.timezone || TZ,
    ports: undefined as never,
  }
  const catalog = await listCatalog(tx, location.id)
  const byName = new Map<string, CatalogService>([...catalog.packages, ...catalog.addons].map((s) => [s.name, s]))
  const svc = (name: string): CatalogService => {
    const s = byName.get(name)
    if (!s) throw new Error(`parity-ops needs the catalog entry "${name}" (seed the domain profile first)`)
    return s
  }
  const customers = new Map((await tx.selectFrom('customers').select(['id', 'full_name']).execute()).map((r) => [r.full_name, r.id]))
  const bays = new Map((await tx.selectFrom('bays').select(['id', 'number']).where('location_id', '=', location.id).execute()).map((b) => [b.number, b.id]))
  const employees = new Map(
    (await tx.selectFrom('employees').select(['id', 'first']).execute()).map((e) => [e.first, e.id]),
  )
  const staffId = (s: Staff): string | null => (s === 'Unassigned' ? null : (employees.get(s.split(' ')[0]!) ?? null))

  const existing = new Set(
    (await tx.selectFrom('appointments').select(['customer_id', 'scheduled_start', 'service_id']).where('location_id', '=', location.id).execute()).map(
      (r) => key(r.customer_id, r.scheduled_start.getTime(), r.service_id),
    ),
  )

  // 1. the twelve design appointments
  let made = 0
  for (const [idx, a] of DESIGN_APPOINTMENTS.entries()) {
    const customerId = customers.get(a.customer)
    if (!customerId) throw new Error(`parity-ops needs the design customer ${a.customer} (seed domain-design first)`)
    const pkg = svc(a.svc)
    const date = addDays(BASE_DATE, a.day)
    const start = wallToInstant(date, parseT(a.time), TZ)
    if (existing.has(key(customerId, start.getTime(), pkg.id))) continue
    const vehicle = await tx
      .selectFrom('vehicles')
      .select('id')
      .where('customer_id', '=', customerId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    const id = ctx.newId()
    const done = a.status === 'completed'
    const started = a.startedAgo ? new Date(PARITY_NOW_MS - a.startedAgo * 60_000) : done ? start : null
    const finished = done ? new Date(Math.min(start.getTime() + pkg.durationMin * 60_000, PARITY_NOW_MS - 5 * 60_000)) : null
    const geo = a.geoIn ? wallToInstant(date, parseT(a.geoIn), TZ) : null
    const arrivedAt = a.status === 'booked' || a.status === 'confirmed' ? null : (geo ?? started ?? start)
    await tx
      .insertInto('appointments')
      .values({
        id,
        location_id: location.id,
        customer_id: customerId,
        vehicle_id: vehicle?.id ?? null,
        service_id: pkg.id,
        package_name: pkg.name,
        price_cents: pkg.priceCents,
        duration_min: pkg.durationMin,
        status: a.status,
        scheduled_start: start,
        scheduled_end: new Date(start.getTime() + pkg.durationMin * 60_000),
        assigned_employee_id: staffId(a.staff),
        planned_bay_id: a.bay ? bays.get(a.bay)! : null,
        bay_id: a.bay && (a.status === 'cleaning' || done) ? bays.get(a.bay)! : null,
        source: 'dashboard',
        eta_minutes: a.eta ?? null,
        eta_at: a.eta ? new Date(PARITY_NOW_MS + a.eta * 60_000) : null,
        geo_checked_in_at: geo,
        arrived_at: arrivedAt,
        cleaning_started_at: a.status === 'cleaning' || done ? started : null,
        completed_at: finished,
        pickup_state: done ? (a.pickup ?? 'pending') : null,
        picked_up_at: a.pickup === 'collected' ? finished : null,
        ready_notified_at: done ? finished : null,
        notes: a.notes ?? null,
        special_instructions: a.special ?? null,
        created_at: new Date(wallToInstant(addDays(BASE_DATE, -1), 16 * 60 + 2, TZ)),
      })
      .execute()
    for (const name of a.addons) {
      const addon = svc(name)
      await tx
        .insertInto('appointment_addons')
        .values({ id: ctx.newId(), appointment_id: id, service_id: addon.id, name: addon.name, price_cents: addon.priceCents })
        .execute()
    }
    await snapshotPackageChecklist(tx, c, id, pkg)
    const rows = await tx.selectFrom('appointment_addons').select(['id', 'service_id']).where('appointment_id', '=', id).execute()
    for (const name of a.addons) {
      const addon = svc(name)
      await addAddonChecklist(tx, c, id, rows.find((r) => r.service_id === addon.id)!.id, addon)
    }
    // the design marks the first round(total * fraction) tasks: cleaning 50%, completed 100%
    const items = await tx.selectFrom('job_checklist_items').select('id').where('appointment_id', '=', id).orderBy('position').orderBy('id').execute()
    const fraction = done ? 1 : a.status === 'cleaning' ? 0.5 : 0
    const marked = items.slice(0, Math.round(items.length * fraction)).map((i) => i.id)
    if (marked.length)
      await tx.updateTable('job_checklist_items').set({ done: true, done_at: started ?? start }).where('id', 'in', marked).execute()
    // photo rows (no objects behind them): arrival unless booked, before and after, an issue note for every 4th
    const photos: { category: 'arrival' | 'before' | 'after'; n: number }[] = [
      { category: 'arrival', n: a.status === 'booked' ? 0 : 2 },
      { category: 'before', n: a.status === 'cleaning' || done ? 3 : 0 },
      { category: 'after', n: done ? 2 : 0 },
    ]
    for (const p of photos)
      for (let k = 0; k < p.n; k++) {
        const photoId = ctx.newId()
        await tx
          .insertInto('appointment_photos')
          .values({
            id: photoId,
            appointment_id: id,
            category: p.category,
            s3_key: buildPhotoKey({ locationId: location.id, apptId: id, category: p.category, photoId, contentType: 'image/jpeg' }),
            content_type: 'image/jpeg',
            bytes: 120_000,
            status: 'ready',
            taken_at: started ?? start,
          })
          .execute()
      }
    if (idx % 4 === 0)
      await tx
        .insertInto('appointment_photos')
        .values({ id: ctx.newId(), appointment_id: id, category: 'issue', note: 'Light scratch on the rear bumper', status: 'ready', taken_at: started ?? start })
        .execute()
    // activity, as the design builds it lazily
    const log: { at: Date; text: string; channels: ('sms' | 'internal' | 'automation' | 'system')[] }[] = [
      { at: wallToInstant(addDays(BASE_DATE, -1), 16 * 60 + 2, TZ), text: 'Booking created', channels: ['system'] },
    ]
    const order: Status[] = ['booked', 'confirmed', 'arrived', 'cleaning', 'completed']
    const ci = order.indexOf(a.status)
    const t0 = parseT(a.time)
    let off = 0
    for (const [i, st] of order.entries()) {
      if (i === 0 || i > ci) continue
      if (st === 'confirmed') log.push({ at: wallToInstant(addDays(BASE_DATE, -1), 16 * 60 + 12, TZ), text: 'Confirmation + reminder sent', channels: ['sms'] })
      else {
        const at = wallToInstant(date, t0 + off, TZ)
        off += Math.max(2, Math.round(pkg.durationMin / 6))
        if (st === 'arrived') log.push({ at, text: 'Arrival logged', channels: ['internal'] })
        if (st === 'cleaning') log.push({ at, text: 'In-progress message sent', channels: ['sms'] })
        if (st === 'completed') log.push({ at, text: 'Ready-for-pickup sent', channels: ['sms'] })
      }
    }
    await tx
      .insertInto('activity_log')
      .values(log.map((l) => ({ appointment_id: id, at: l.at, text: l.text, channels: l.channels, actor_type: 'system' as const })))
      .execute()
    made++
  }

  // 2. the procedural calendar days
  const hours = await getHours(tx, location.id)
  const closures = await listLiveClosures(tx, location.id)
  const poolIds: string[] = []
  for (const [i, name] of POOL_NAMES.entries()) {
    const phone = `+1${i % 2 === 0 ? '305' : '786'}5550${String(114 + i)}`
    const found = await tx.selectFrom('customers').select('id').where('phone_e164', '=', phone).where('merged_into', 'is', null).where('deleted_at', 'is', null).executeTakeFirst()
    if (found) {
      poolIds.push(found.id)
      continue
    }
    const id = ctx.newId()
    await tx
      .insertInto('customers')
      .values({
        id,
        full_name: name,
        phone_e164: phone,
        phone_display: formatPhoneDisplay(phone),
        sms_opted_in: true,
        sms_opt_in_source: 'import',
        sms_opt_in_at: new Date(PARITY_NOW_MS),
        source: 'import',
        synthetic: true,
      })
      .execute()
    poolIds.push(id)
  }
  let generated = 0
  const batch: Record<string, unknown>[] = []
  const vehicleRows: Record<string, unknown>[] = []
  for (let o = -GEN_RANGE; o <= GEN_RANGE; o++) {
    // Today and tomorrow carry only the design's fixtures: the board's 24-hour window must show a1..a12 and nothing else.
    if (o === 0 || o === 1) continue
    const date = addDays(BASE_DATE, o)
    const info = dayInfo({ date, hours, closures })
    if (info.closed) continue
    for (const g of designGenDay(o, info.weekday, info.h0!, info.h1!, info.reduced)) {
      const pkg = svc(g.svc)
      const customerId = poolIds[g.customerIdx]!
      const start = wallToInstant(date, g.startMin, TZ)
      // keyed against rows that existed before this run only: the design may pick the same client, time and package twice
      if (existing.has(key(customerId, start.getTime(), pkg.id))) continue
      const vehicleId = ctx.newId()
      vehicleRows.push({ id: vehicleId, customer_id: customerId, year: g.vehicle[0], make: g.vehicle[1], model: g.vehicle[2], color: g.vehicle[3], plate: g.plate })
      const done = o < 0
      const end = new Date(start.getTime() + pkg.durationMin * 60_000)
      batch.push({
        id: ctx.newId(),
        location_id: location.id,
        customer_id: customerId,
        vehicle_id: vehicleId,
        service_id: pkg.id,
        package_name: pkg.name,
        price_cents: pkg.priceCents,
        duration_min: pkg.durationMin,
        status: g.status,
        scheduled_start: start,
        scheduled_end: end,
        assigned_employee_id: staffId(g.staff),
        planned_bay_id: bays.get(g.bayNumber)!,
        bay_id: done ? bays.get(g.bayNumber)! : null,
        source: 'dashboard',
        arrived_at: done ? start : null,
        cleaning_started_at: done ? start : null,
        completed_at: done ? end : null,
        pickup_state: done ? 'collected' : null,
        picked_up_at: done ? end : null,
        ready_notified_at: done ? end : null,
      })
      generated++
    }
  }
  for (let i = 0; i < vehicleRows.length; i += 200)
    await tx
      .insertInto('vehicles')
      .values(vehicleRows.slice(i, i + 200) as never)
      .onConflict((oc) => oc.expression(sql`customer_id, upper(plate)`).doNothing())
      .execute()
  // a plate that collided with an existing one keeps that vehicle: point the appointment at it
  const veh = new Map<string, string>()
  for (const r of await tx.selectFrom('vehicles').select(['id', 'customer_id', 'plate']).where('customer_id', 'in', poolIds).execute())
    veh.set(`${r.customer_id}|${(r.plate ?? '').toUpperCase()}`, r.id)
  const plateOf = new Map(vehicleRows.map((v) => [v.id as string, `${v.customer_id as string}|${(v.plate as string).toUpperCase()}`]))
  for (const b of batch) b.vehicle_id = veh.get(plateOf.get(b.vehicle_id as string)!) ?? b.vehicle_id
  for (let i = 0; i < batch.length; i += 200)
    await tx
      .insertInto('appointments')
      .values(batch.slice(i, i + 200) as never)
      .execute()
  ctx.log(`parity-ops: ${made} design appointments, ${generated} procedural calendar appointments`)
}

export const schedulingSeedProfiles: Record<string, SeedProfile> = {
  'parity-ops': {
    description:
      'The Operations design day (2026-06-13 10:36 AM): appointments a1-a12 with checklists, photos and activity, plus the design calendar days either side',
    dependsOn: ['design'],
    run: seedParityOps,
  },
}

