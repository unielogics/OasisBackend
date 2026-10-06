// Appointment records and the small queries every command shares: row lock, customer and bay lookups, activity log,
// realtime events and the labels the design uses for statuses and times.
import { sql } from 'kysely'
import type { Executor, Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { isUuid } from '../../platform/ids.js'
import * as realtime from '../../platform/realtime.js'
import { addDays, dateLabel, fmtT, minutesOfDay, toBizDate } from '../../platform/time.js'
import { DateTime } from 'luxon'
import '../customers/schema.js'
import type {
  ActivityChannel,
  AppointmentSource,
  AppointmentStatus,
} from '../customers/schema.js'
import { actorName, firstName, type Actor, type SchedulingCtx } from './context.js'
import './problems.js'

export interface AppointmentRecord {
  id: string
  locationId: string
  seq: number
  customerId: string
  vehicleId: string | null
  serviceId: string
  packageName: string
  priceCents: number
  durationMin: number
  status: AppointmentStatus
  scheduledStart: Date
  scheduledEnd: Date
  assignedEmployeeId: string | null
  plannedBayId: string | null
  bayId: string | null
  source: AppointmentSource
  etaMinutes: number | null
  etaAt: Date | null
  geoCheckedInAt: Date | null
  bayPreppedAt: Date | null
  arrivedAt: Date | null
  cleaningStartedAt: Date | null
  completedAt: Date | null
  pickupState: 'pending' | 'collected' | null
  pickedUpAt: Date | null
  readyNotifiedAt: Date | null
  canceledAt: Date | null
  cancelReason: string | null
  noShowAt: Date | null
  notes: string | null
  specialInstructions: string | null
  membershipId: string | null
  emergencyClosureId: string | null
  version: number
  createdBy: string | null
  createdAt: Date
}

export const APPOINTMENT_COLUMNS = [
  'id',
  'location_id',
  'seq',
  'customer_id',
  'vehicle_id',
  'service_id',
  'package_name',
  'price_cents',
  'duration_min',
  'status',
  'scheduled_start',
  'scheduled_end',
  'assigned_employee_id',
  'planned_bay_id',
  'bay_id',
  'source',
  'eta_minutes',
  'eta_at',
  'geo_checked_in_at',
  'bay_prepped_at',
  'arrived_at',
  'cleaning_started_at',
  'completed_at',
  'pickup_state',
  'picked_up_at',
  'ready_notified_at',
  'canceled_at',
  'cancel_reason',
  'no_show_at',
  'notes',
  'special_instructions',
  'membership_id',
  'emergency_closure_id',
  'version',
  'created_by',
  'created_at',
] as const

type Row = {
  id: string
  location_id: string
  seq: number
  customer_id: string
  vehicle_id: string | null
  service_id: string
  package_name: string
  price_cents: number
  duration_min: number
  status: AppointmentStatus
  scheduled_start: Date
  scheduled_end: Date
  assigned_employee_id: string | null
  planned_bay_id: string | null
  bay_id: string | null
  source: AppointmentSource
  eta_minutes: number | null
  eta_at: Date | null
  geo_checked_in_at: Date | null
  bay_prepped_at: Date | null
  arrived_at: Date | null
  cleaning_started_at: Date | null
  completed_at: Date | null
  pickup_state: 'pending' | 'collected' | null
  picked_up_at: Date | null
  ready_notified_at: Date | null
  canceled_at: Date | null
  cancel_reason: string | null
  no_show_at: Date | null
  notes: string | null
  special_instructions: string | null
  membership_id: string | null
  emergency_closure_id: string | null
  version: number
  created_by: string | null
  created_at: Date
}

export const toAppointment = (r: Row): AppointmentRecord => ({
  id: r.id,
  locationId: r.location_id,
  seq: r.seq,
  customerId: r.customer_id,
  vehicleId: r.vehicle_id,
  serviceId: r.service_id,
  packageName: r.package_name,
  priceCents: r.price_cents,
  durationMin: r.duration_min,
  status: r.status,
  scheduledStart: r.scheduled_start,
  scheduledEnd: r.scheduled_end,
  assignedEmployeeId: r.assigned_employee_id,
  plannedBayId: r.planned_bay_id,
  bayId: r.bay_id,
  source: r.source,
  etaMinutes: r.eta_minutes,
  etaAt: r.eta_at,
  geoCheckedInAt: r.geo_checked_in_at,
  bayPreppedAt: r.bay_prepped_at,
  arrivedAt: r.arrived_at,
  cleaningStartedAt: r.cleaning_started_at,
  completedAt: r.completed_at,
  pickupState: r.pickup_state,
  pickedUpAt: r.picked_up_at,
  readyNotifiedAt: r.ready_notified_at,
  canceledAt: r.canceled_at,
  cancelReason: r.cancel_reason,
  noShowAt: r.no_show_at,
  notes: r.notes,
  specialInstructions: r.special_instructions,
  membershipId: r.membership_id,
  emergencyClosureId: r.emergency_closure_id,
  version: r.version,
  createdBy: r.created_by,
  createdAt: r.created_at,
})

const notFound = (): AppError => new AppError('NOT_FOUND', { detail: 'That appointment does not exist' })

export async function getAppointment(
  db: Executor,
  locationId: string,
  id: string,
): Promise<AppointmentRecord | undefined> {
  if (!isUuid(id)) return undefined
  const r = await db
    .selectFrom('appointments')
    .select([...APPOINTMENT_COLUMNS])
    .where('location_id', '=', locationId)
    .where('id', '=', id)
    .executeTakeFirst()
  return r ? toAppointment(r) : undefined
}

export async function requireAppointment(
  db: Executor,
  locationId: string,
  id: string,
): Promise<AppointmentRecord> {
  const a = await getAppointment(db, locationId, id)
  if (!a) throw notFound()
  return a
}

/** SELECT ... FOR UPDATE: the command's first step, so two commands on one appointment serialize. */
export async function lockAppointment(tx: Tx, locationId: string, id: string): Promise<AppointmentRecord> {
  if (!isUuid(id)) throw notFound()
  const r = await tx
    .selectFrom('appointments')
    .select([...APPOINTMENT_COLUMNS])
    .where('location_id', '=', locationId)
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst()
  if (!r) throw notFound()
  return toAppointment(r)
}

export interface BayRecord {
  id: string
  number: number
  name: string
  status: 'active' | 'maintenance' | 'blocked'
  sort: number
}

export async function listBays(db: Executor, locationId: string): Promise<BayRecord[]> {
  const rows = await db
    .selectFrom('bays')
    .select(['id', 'number', 'name', 'status', 'sort'])
    .where('location_id', '=', locationId)
    .orderBy('sort')
    .orderBy('number')
    .execute()
  return rows
}

export async function getBay(db: Executor, locationId: string, id: string): Promise<BayRecord | undefined> {
  if (!isUuid(id)) return undefined
  return db
    .selectFrom('bays')
    .select(['id', 'number', 'name', 'status', 'sort'])
    .where('location_id', '=', locationId)
    .where('id', '=', id)
    .executeTakeFirst()
}

export interface CustomerBrief {
  id: string
  fullName: string
  firstName: string
  phoneE164: string | null
  phoneDisplay: string | null
  email: string | null
  smsOptedIn: boolean
  smsOptedOutAt: Date | null
}

export interface VehicleBrief {
  id: string
  year: number | null
  make: string | null
  model: string | null
  color: string | null
  plate: string | null
}

export async function customerBrief(db: Executor, id: string): Promise<CustomerBrief> {
  const r = await db
    .selectFrom('customers')
    .select(['id', 'full_name', 'phone_e164', 'phone_display', 'email', 'sms_opted_in', 'sms_opted_out_at'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
  return {
    id: r.id,
    fullName: r.full_name,
    firstName: firstName(r.full_name),
    phoneE164: r.phone_e164,
    phoneDisplay: r.phone_display,
    email: r.email,
    smsOptedIn: r.sms_opted_in,
    smsOptedOutAt: r.sms_opted_out_at,
  }
}

export async function vehicleBrief(db: Executor, id: string | null): Promise<VehicleBrief | null> {
  if (!id) return null
  const r = await db
    .selectFrom('vehicles')
    .select(['id', 'year', 'make', 'model', 'color', 'plate'])
    .where('id', '=', id)
    .executeTakeFirst()
  return r ?? null
}

export const vehicleLabel = (v: Pick<VehicleBrief, 'year' | 'make' | 'model'> | null): string =>
  v ? [v.year, v.make, v.model].filter(Boolean).join(' ') : 'Vehicle on file'

// Activity log -------------------------------------------------------------------------------------------------------

export interface ActivityInput {
  appointmentId: string
  text: string
  channels: ActivityChannel[]
  actorType?: 'staff' | 'system' | 'automation' | 'customer'
  actor?: Actor | null
  meta?: Record<string, string | number | boolean | null>
}

export async function logActivity(tx: Tx, c: SchedulingCtx, e: ActivityInput): Promise<void> {
  const type = e.actorType ?? (e.actor ? 'staff' : 'system')
  await tx
    .insertInto('activity_log')
    .values({
      appointment_id: e.appointmentId,
      at: c.clock.now(),
      text: e.text,
      channels: e.channels,
      actor_type: type,
      actor_name: type === 'staff' ? actorName(e.actor) : null,
      // the shared table type models jsonb as a ColumnType value; the driver wants the JSON text
      meta: JSON.stringify(e.meta ?? {}) as never,
    })
    .execute()
}

// Realtime ------------------------------------------------------------------------------------------------------------

export interface OpsEvents {
  appointment?: { id: string; version: number; status: AppointmentStatus; change: string }
  bayIds?: string[]
  /** Business dates whose slot availability may have changed. */
  availability?: string[]
  kpi?: boolean
}

/** appointment.updated, bay.changed, availability.changed and kpi.dirty on the ops channel, in the mutation's tx. */
export async function publishOps(tx: Tx, locationId: string, e: OpsEvents): Promise<void> {
  if (e.appointment)
    await realtime.publish(tx, {
      locationId,
      channel: 'ops',
      type: 'appointment.updated',
      payload: { ...e.appointment },
    })
  for (const bayId of new Set(e.bayIds ?? []))
    await realtime.publish(tx, { locationId, channel: 'ops', type: 'bay.changed', payload: { bayId } })
  for (const date of new Set(e.availability ?? []))
    await realtime.publish(tx, { locationId, channel: 'ops', type: 'availability.changed', payload: { date } })
  if (e.kpi !== false)
    await realtime.publish(tx, { locationId, channel: 'ops', type: 'kpi.dirty', payload: {} })
}

// Labels --------------------------------------------------------------------------------------------------------------

/** The status as a short phrase for "This job is {phrase}". */
export const STATUS_PHRASE: Record<AppointmentStatus, string> = {
  booked: 'booked',
  confirmed: 'confirmed',
  arrived: 'arrived',
  cleaning: 'in a bay',
  completed: 'completed',
  canceled: 'canceled',
  no_show: 'a no-show',
}

export interface StatusMeta {
  label: string
  color: string
}

/** The design's stMeta (labels and colours); "Late" is derived, see isLate. */
export const STATUS_META: Record<AppointmentStatus, StatusMeta> = {
  booked: { label: 'Booked', color: '#6B7280' },
  confirmed: { label: 'Confirmed', color: '#2563EB' },
  arrived: { label: 'Arrived', color: '#7C3AED' },
  cleaning: { label: 'In Wash', color: '#C2740B' },
  completed: { label: 'Completed', color: '#0E9E6E' },
  canceled: { label: 'Canceled', color: '#9F1239' },
  no_show: { label: 'No-Show', color: '#B91C1C' },
}
export const LATE_META: StatusMeta = { label: 'Late', color: '#C2410C' }

/** The late rule: computed, never stored. */
export function isLate(
  a: Pick<AppointmentRecord, 'status' | 'scheduledStart'>,
  now: Date,
  graceMin: number,
): boolean {
  return (
    (a.status === 'booked' || a.status === 'confirmed') &&
    now.getTime() > a.scheduledStart.getTime() + graceMin * 60_000
  )
}

/** A job can move (drag to a bay, reschedule) unless it is in a bay or finished. */
export const canDrag = (status: AppointmentStatus): boolean =>
  status === 'booked' || status === 'confirmed' || status === 'arrived'

/**
 * How a start reads in a customer message or the log: "10:00 AM" today, "tomorrow at 9:00 AM", otherwise
 * "Mon, Jun 15 at 9:00 AM".
 */
export function whenLabel(start: Date, now: Date, tz: string): string {
  const time = fmtT(minutesOfDay(start, tz))
  const day = toBizDate(start, tz)
  const today = toBizDate(now, tz)
  if (day === today) return time
  if (day === addDays(today, 1)) return `tomorrow at ${time}`
  const d = DateTime.fromISO(day, { zone: 'utc' }).setLocale('en-US').toFormat('ccc, LLL d')
  return `${d} at ${time}`
}

export function invalidTransition(a: Pick<AppointmentRecord, 'status'>): AppError {
  return new AppError('INVALID_TRANSITION', {
    params: { status: STATUS_PHRASE[a.status] },
    meta: { currentStatus: a.status },
  })
}

export const dayHeading = (start: Date, tz: string): string => dateLabel(start, tz)

/** Appointments an `sql` template references as a.* in raw queries. */
export const aliasCols = (alias: string): ReturnType<typeof sql.raw> =>
  sql.raw(APPOINTMENT_COLUMNS.map((c) => `${alias}.${c}`).join(', '))
