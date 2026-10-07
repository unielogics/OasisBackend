// Standing (recurring) appointments (ADR 0086): VIP clients repeat a slot on a cadence. A series is created and edited by staff;
// the materializer books the next four weeks of occurrences as ordinary appointments (source standing), and an hourly job
// confirms them 48 hours ahead without waiting for a reply when auto-confirm is on. Everything here needs the feature setting.
import { sql } from 'kysely'
import type { Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { isUuid } from '../../platform/ids.js'
import { addDays, toBizDate, wallToInstant } from '../../platform/time.js'
import { requireService } from '../catalog/service.js'
import { requireCustomer, isVipCustomer } from '../customers/service.js'
import { createAppointment } from '../scheduling/booking.js'
import type { Actor, SchedulingCtx } from '../scheduling/context.js'
import { loadSettingsBundle } from '../scheduling/context.js'
import { confirmAppointment } from '../scheduling/lifecycle.js'
import { occurrenceDates, weekdayOf } from './cadence.js'
import './problems.js'
import type { Cadence, SeriesStatus } from './schema.js'
import { attempt, featureEnabled, requireFeature, systemActor } from './support.js'

export const HORIZON_DAYS = 28
export const AUTOCONFIRM_AHEAD_MS = 48 * 3600_000

export interface SeriesRecord {
  id: string
  customerId: string
  vehicleId: string | null
  serviceId: string
  cadence: Cadence
  weekday: number
  timeMin: number
  startDate: string
  endDate: string | null
  status: SeriesStatus
  generatedThrough: string | null
  autoConfirm: boolean
  notes: string | null
  version: number
}

const COLUMNS = [
  'id',
  'customer_id',
  'vehicle_id',
  'service_id',
  'cadence',
  'weekday',
  'time_min',
  'start_date',
  'end_date',
  'status',
  'generated_through',
  'auto_confirm',
  'notes',
  'version',
] as const

type Row = {
  id: string
  customer_id: string
  vehicle_id: string | null
  service_id: string
  cadence: Cadence
  weekday: number
  time_min: number
  start_date: string
  end_date: string | null
  status: SeriesStatus
  generated_through: string | null
  auto_confirm: boolean
  notes: string | null
  version: number
}

const toSeries = (r: Row): SeriesRecord => ({
  id: r.id,
  customerId: r.customer_id,
  vehicleId: r.vehicle_id,
  serviceId: r.service_id,
  cadence: r.cadence,
  weekday: r.weekday,
  timeMin: r.time_min,
  startDate: r.start_date,
  endDate: r.end_date,
  status: r.status,
  generatedThrough: r.generated_through,
  autoConfirm: r.auto_confirm,
  notes: r.notes,
  version: r.version,
})

const bad = (path: string, message: string): AppError =>
  new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path, message }] })

export interface CreateSeriesInput {
  customerId: string
  vehicleId?: string | null
  serviceId: string
  cadence: Cadence
  /** First occurrence, a business date; its weekday is the series' weekday. */
  startDate: string
  endDate?: string | null
  /** Minutes from midnight in the business timezone. */
  timeMin: number
  autoConfirm?: boolean
  notes?: string | null
}

export interface MaterializeReport {
  booked: number
  skipped: number
  through: string | null
}

export async function createSeries(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  input: CreateSeriesInput,
): Promise<{ series: SeriesRecord; materialized: MaterializeReport }> {
  await requireFeature(tx, c.locationId)
  const { vip } = await loadSettingsBundle(tx, c.locationId)
  if (!vip.standing) throw new AppError('STANDING_OFF')
  if (!vip.cadences.includes(input.cadence)) throw new AppError('STANDING_CADENCE_NOT_OFFERED')
  const customer = await requireCustomer(tx, input.customerId)
  if (customer.deletedAt || customer.mergedInto)
    throw new AppError('NOT_FOUND', { detail: 'That customer does not exist' })
  if (!(await isVipCustomer(tx, c.locationId, customer.id))) throw new AppError('STANDING_VIP_ONLY')
  const svc = await requireService(tx, c.locationId, input.serviceId)
  if (svc.kind !== 'package' || !svc.active) throw bad('serviceId', 'Pick an available package.')
  if (input.vehicleId) {
    const v = await tx
      .selectFrom('vehicles')
      .select('id')
      .where('id', '=', input.vehicleId)
      .where('customer_id', '=', customer.id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    if (!v) throw bad('vehicleId', 'Pick one of the client’s vehicles.')
  }
  const today = toBizDate(c.clock.now(), c.tz)
  if (input.startDate < today) throw bad('startDate', 'The first visit cannot be in the past.')
  if (input.endDate && input.endDate < input.startDate)
    throw bad('endDate', 'The end date is before the first visit.')
  if (!Number.isInteger(input.timeMin) || input.timeMin < 0 || input.timeMin > 1439)
    throw bad('timeMin', 'Pick a time of day.')
  const id = c.newId()
  await tx
    .insertInto('standing_series')
    .values({
      id,
      location_id: c.locationId,
      customer_id: customer.id,
      vehicle_id: input.vehicleId ?? null,
      service_id: svc.id,
      cadence: input.cadence,
      weekday: weekdayOf(input.startDate),
      time_min: input.timeMin,
      start_date: input.startDate,
      end_date: input.endDate ?? null,
      auto_confirm: input.autoConfirm ?? true,
      notes: input.notes?.trim() || null,
      created_by: isUuid(actor.auth.userId) ? actor.auth.userId : null,
    })
    .execute()
  const series = await requireSeries(tx, c.locationId, id)
  const materialized = await materializeSeries(tx, c, series)
  return { series: await requireSeries(tx, c.locationId, id), materialized }
}

export async function requireSeries(
  tx: Tx,
  locationId: string,
  id: string,
  lock = false,
): Promise<SeriesRecord> {
  let q = tx
    .selectFrom('standing_series')
    .select([...COLUMNS])
    .where('id', '=', id)
    .where('location_id', '=', locationId)
  if (lock) q = q.forUpdate()
  const r = await q.executeTakeFirst()
  if (!r) throw new AppError('STANDING_NOT_FOUND')
  return toSeries(r as Row)
}

export async function listSeries(
  tx: Tx,
  locationId: string,
  o: { customerId?: string; includeEnded?: boolean } = {},
): Promise<SeriesRecord[]> {
  let q = tx
    .selectFrom('standing_series')
    .select([...COLUMNS])
    .where('location_id', '=', locationId)
  if (o.customerId) q = q.where('customer_id', '=', o.customerId)
  if (!o.includeEnded) q = q.where('status', '<>', 'ended')
  return (await q.orderBy('start_date').orderBy('id').execute()).map((r) => toSeries(r as Row))
}

/**
 * Books the series' occurrences from the day after it was last generated (or its start) through four weeks from today, as ordinary
 * appointments checked against hours, closures and capacity. A date that cannot be booked is recorded as skipped with the reason
 * and never retried; a date beyond the booking window is left for a later run. Idempotent per (series, date).
 */
export async function materializeSeries(
  tx: Tx,
  c: SchedulingCtx,
  s: SeriesRecord,
): Promise<MaterializeReport> {
  const report: MaterializeReport = { booked: 0, skipped: 0, through: s.generatedThrough }
  if (s.status !== 'active') return report
  const today = toBizDate(c.clock.now(), c.tz)
  const horizon = addDays(today, HORIZON_DAYS)
  const from = s.generatedThrough ? addDays(s.generatedThrough, 1) : s.startDate
  const dates = occurrenceDates(s, from > today ? from : today, horizon)
  const actor = systemActor(c.locationId)
  let through = s.generatedThrough
  for (const date of dates) {
    const exists = await tx
      .selectFrom('standing_occurrences')
      .select('id')
      .where('series_id', '=', s.id)
      .where('occurrence_date', '=', date)
      .executeTakeFirst()
    if (exists) {
      through = date
      continue
    }
    const start = wallToInstant(date, s.timeMin, c.tz)
    const r = await attempt(tx, async () => {
      const booked = await createAppointment(tx, c, actor, {
        customer: { id: s.customerId },
        serviceId: s.serviceId,
        start,
        source: 'standing',
        notes: s.notes,
      })
      await tx
        .updateTable('appointments')
        .set({ standing_series_id: s.id, ...(s.vehicleId ? { vehicle_id: s.vehicleId } : {}) })
        .where('id', '=', booked.appointment.id)
        .execute()
      return booked.appointment.id
    })
    if (!r.ok && r.error.code === 'SLOT_OUTSIDE_WINDOW') break // too far ahead for now: a later run books it
    await tx
      .insertInto('standing_occurrences')
      .values({
        id: c.newId(),
        series_id: s.id,
        occurrence_date: date,
        status: r.ok ? 'booked' : 'skipped',
        appointment_id: r.ok ? r.value : null,
        reason: r.ok ? null : r.error.code,
      })
      .execute()
    if (r.ok) report.booked++
    else report.skipped++
    through = date
  }
  through = through && through > horizon ? through : horizon
  if (through !== s.generatedThrough)
    await tx
      .updateTable('standing_series')
      .set((eb) => ({
        generated_through: through,
        updated_at: eb.fn('app_now', []),
        version: eb('version', '+', 1),
      }))
      .where('id', '=', s.id)
      .execute()
  report.through = through
  return report
}

/** The job: materialize every active series of the location. Returns the totals. */
export async function materializeAll(
  tx: Tx,
  c: SchedulingCtx,
): Promise<MaterializeReport & { series: number }> {
  const total = { booked: 0, skipped: 0, through: null as string | null, series: 0 }
  if (!(await featureEnabled(tx, c.locationId))) return total
  const { vip } = await loadSettingsBundle(tx, c.locationId)
  if (!vip.standing) return total
  const rows = await tx
    .selectFrom('standing_series')
    .select([...COLUMNS])
    .where('location_id', '=', c.locationId)
    .where('status', '=', 'active')
    .orderBy('id')
    .forUpdate()
    .execute()
  for (const row of rows) {
    const r = await materializeSeries(tx, c, toSeries(row as Row))
    total.booked += r.booked
    total.skipped += r.skipped
    total.series++
  }
  return total
}

export interface SeriesPatch {
  status?: 'active' | 'paused' | 'ended'
  endDate?: string | null
  autoConfirm?: boolean
  notes?: string | null
}

export async function updateSeries(
  tx: Tx,
  c: SchedulingCtx,
  id: string,
  patch: SeriesPatch,
  expectedVersion?: number,
): Promise<SeriesRecord> {
  await requireFeature(tx, c.locationId)
  const cur = await requireSeries(tx, c.locationId, id, true)
  if (expectedVersion !== undefined && expectedVersion !== cur.version)
    throw new AppError('VERSION_CONFLICT', { meta: { currentVersion: cur.version } })
  if (cur.status === 'ended') throw bad('status', 'An ended standing appointment cannot be changed.')
  if (patch.endDate && patch.endDate < cur.startDate)
    throw bad('endDate', 'The end date is before the first visit.')
  const set: Record<string, unknown> = {}
  if (patch.status !== undefined) set.status = patch.status
  if (patch.endDate !== undefined) set.end_date = patch.endDate
  if (patch.autoConfirm !== undefined) set.auto_confirm = patch.autoConfirm
  if (patch.notes !== undefined) set.notes = patch.notes?.trim() || null
  if (Object.keys(set).length > 0)
    await tx
      .updateTable('standing_series')
      .set((eb) => ({ ...set, updated_at: eb.fn('app_now', []), version: eb('version', '+', 1) }) as never)
      .where('id', '=', id)
      .execute()
  return requireSeries(tx, c.locationId, id)
}

/** Booked or confirmed visits of the series that start after now (an ended or paused series may take them off the books). */
export async function upcomingVisits(tx: Tx, c: SchedulingCtx, seriesId: string): Promise<string[]> {
  const rows = await tx
    .selectFrom('appointments')
    .select('id')
    .where('location_id', '=', c.locationId)
    .where('standing_series_id', '=', seriesId)
    .where('status', 'in', ['booked', 'confirmed'])
    .where('scheduled_start', '>', c.clock.now())
    .orderBy('scheduled_start')
    .execute()
  return rows.map((r) => r.id)
}

export interface AutoConfirmReport {
  confirmed: number
}

/**
 * Confirms standing visits that start within 48 hours and are still booked: no reply needed when both the series and the VIP
 * settings say auto-confirm. Queues the ordinary "confirmed" text through the confirm command.
 */
export async function autoConfirmDue(tx: Tx, c: SchedulingCtx): Promise<AutoConfirmReport> {
  const out: AutoConfirmReport = { confirmed: 0 }
  if (!(await featureEnabled(tx, c.locationId))) return out
  const { vip } = await loadSettingsBundle(tx, c.locationId)
  if (!vip.standing || !vip.autoConfirm) return out
  const now = c.clock.now()
  const rows = await sql<{ id: string }>`
    select a.id from appointments a join standing_series s on s.id = a.standing_series_id
    where a.location_id = ${c.locationId} and a.status = 'booked' and s.auto_confirm and s.status = 'active'
      and a.scheduled_start > ${now} and a.scheduled_start <= ${new Date(now.getTime() + AUTOCONFIRM_AHEAD_MS)}
    order by a.scheduled_start, a.id`.execute(tx)
  const actor = systemActor(c.locationId)
  for (const r of rows.rows) {
    const done = await attempt(tx, () => confirmAppointment(tx, c, actor, r.id))
    if (done.ok) out.confirmed++
  }
  return out
}
