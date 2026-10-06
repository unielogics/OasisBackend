// Shared factories for the domain-core tests (catalog, customers, settings, schema). Rows are written straight to the
// tables, bypassing booking rules, the way the seeds do.
import type { Executor } from '../../src/platform/db.js'
import { createIdGenerator, type NewId } from '../../src/platform/ids.js'
import { ensureLocation, type Location } from '../../src/platform/locations.js'
import { formatPhoneDisplay } from '../../src/platform/phone.js'
import { ensureDomainDefaults } from '../../src/modules/settings/defaults.js'
import type { AppointmentStatus } from '../../src/modules/customers/schema.js'
import type { TestDb } from '../helpers/db.js'

export interface Fixture {
  location: Location
  locationId: string
  newId: NewId
}

/** Location, default settings and the design's default hours/rules/VIP/arrival rows. */
export async function setupLocation(t: Pick<TestDb, 'db' | 'clock'>): Promise<Fixture> {
  const newId = createIdGenerator(t.clock)
  const location = await ensureLocation(t.db, newId)
  await ensureDomainDefaults(t.db as never, location.id)
  return { location, locationId: location.id, newId }
}

let seq = 0
const next = (): number => (seq += 1)

export async function makeBay(
  db: Executor,
  f: Fixture,
  number: number,
  status: 'active' | 'maintenance' | 'blocked' = 'active',
) {
  const id = f.newId()
  await db
    .insertInto('bays')
    .values({ id, location_id: f.locationId, number, name: `Bay ${number}`, status, sort: number })
    .execute()
  return id
}

export async function makeService(
  db: Executor,
  f: Fixture,
  o: Partial<{
    kind: 'package' | 'addon'
    name: string
    priceCents: number
    durationMin: number
    tasks: string[]
    active: boolean
    sort: number
  }> = {},
) {
  const id = f.newId()
  const kind = o.kind ?? 'package'
  await db
    .insertInto('services')
    .values({
      id,
      location_id: f.locationId,
      kind,
      name: o.name ?? `Service ${next()}`,
      short_name: null,
      price_cents: o.priceCents ?? 4500,
      duration_min: kind === 'addon' ? 0 : (o.durationMin ?? 60),
      active: o.active ?? true,
      sort: o.sort ?? 0,
      sqsp_sku: null,
    })
    .execute()
  const tasks = o.tasks ?? []
  if (tasks.length > 0)
    await db
      .insertInto('checklist_tasks')
      .values(
        tasks.map((label, position) => ({
          id: f.newId(),
          service_id: id,
          label,
          position,
          retired_at: null,
        })),
      )
      .execute()
  return id
}

export async function makeCustomer(
  db: Executor,
  f: Fixture,
  o: Partial<{
    name: string
    line: string
    optedOut: boolean
    email: string | null
    synthetic: boolean
    noPhone: boolean
  }> = {},
) {
  const id = f.newId()
  const n = next()
  const line = o.line ?? String(100 + (n % 100)).padStart(4, '0')
  const phone = o.noPhone ? null : `+1305555${line}`
  await db
    .insertInto('customers')
    .values({
      id,
      full_name: o.name ?? `Customer ${n}`,
      phone_e164: phone,
      phone_display: phone ? formatPhoneDisplay(phone) : null,
      email: o.email ?? null,
      notes: null,
      sms_opted_in: !o.optedOut,
      sms_opt_in_source: o.optedOut ? null : 'import',
      sms_opt_in_at: null,
      sms_opted_out_at: o.optedOut ? new Date('2026-06-01T12:00:00Z') : null,
      synthetic: o.synthetic ?? true,
    })
    .execute()
  return id
}

export async function makeVehicle(
  db: Executor,
  f: Fixture,
  customerId: string,
  o: Partial<{ year: number; make: string; model: string; color: string; plate: string | null }> = {},
) {
  const id = f.newId()
  await db
    .insertInto('vehicles')
    .values({
      id,
      customer_id: customerId,
      year: o.year ?? 2022,
      make: o.make ?? 'Honda',
      model: o.model ?? 'Civic',
      color: o.color ?? 'Blue',
      plate: o.plate === undefined ? `TST-${String(next()).padStart(4, '0')}` : o.plate,
      deleted_at: null,
    })
    .execute()
  return id
}

export async function makeAppointment(
  db: Executor,
  f: Fixture,
  o: {
    customerId: string
    serviceId: string
    start: Date | string
    vehicleId?: string | null
    status?: AppointmentStatus
    durationMin?: number
    bayId?: string | null
    pickupState?: 'pending' | 'collected' | null
  },
) {
  const id = f.newId()
  const start = new Date(o.start)
  const dur = o.durationMin ?? 60
  await db
    .insertInto('appointments')
    .values({
      id,
      location_id: f.locationId,
      customer_id: o.customerId,
      vehicle_id: o.vehicleId ?? null,
      service_id: o.serviceId,
      package_name: 'Express Hand Wash',
      price_cents: 4500,
      duration_min: dur,
      status: o.status ?? 'booked',
      scheduled_start: start,
      scheduled_end: new Date(start.getTime() + dur * 60_000),
      assigned_employee_id: null,
      planned_bay_id: null,
      bay_id: o.bayId ?? null,
      eta_minutes: null,
      eta_at: null,
      geo_checked_in_at: null,
      bay_prepped_at: null,
      arrived_at: null,
      cleaning_started_at: o.status === 'cleaning' ? start : null,
      completed_at: null,
      pickup_state: o.pickupState ?? null,
      picked_up_at: null,
      ready_notified_at: null,
      canceled_at: null,
      cancel_reason: null,
      no_show_at: null,
      notes: null,
      special_instructions: null,
      membership_id: null,
      emergency_closure_id: null,
      standing_series_id: null,
      arrival_token_hash: null,
      created_by: null,
    })
    .execute()
  return id
}

/** A UTC instant from an Eastern wall-clock date and "HH:MM" (June dates are EDT, -04:00). */
export const edt = (date: string, hhmm: string): Date => new Date(`${date}T${hhmm}:00-04:00`)
