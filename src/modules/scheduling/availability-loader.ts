// Loads what the pure slot engine needs for one business date and exposes the high-level availability query.
import { sql } from 'kysely'
import type { Executor } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { bizDayBounds, toBizDate, addDays } from '../../platform/time.js'
import '../customers/schema.js'
import '../settings/schema.js'
import { requireService } from '../catalog/service.js'
import { vipCustomerIds } from '../customers/service.js'
import { getActiveEmergency, emergencySnapshot } from '../settings/emergency.js'
import { listLiveClosures } from '../settings/closures.js'
import { dayInfo, type DayInfo } from '../settings/day-info.js'
import {
  computeSlots,
  evaluateStart,
  MS_PER_MIN,
  type AvailabilityInput,
  type AvailabilityResult,
  type BusyInterval,
  type Channel,
  type Evaluation,
  type VipHold,
} from './availability.js'
import { loadSettingsBundle, type SettingsBundle } from './context.js'

export interface BusyRow {
  id: string
  customerId: string
  status: string
  start: Date
  end: Date
  durationMin: number
  cleaningStartedAt: Date | null
  completedAt: Date | null
}

/** One booking's claim on a bay, from its row: the interval each status occupies, buffer included. */
export function intervalOfRow(r: BusyRow, bufferMin: number, now: Date, vip: boolean): BusyInterval | null {
  const buffer = bufferMin * MS_PER_MIN
  const startMs = r.start.getTime()
  switch (r.status) {
    case 'booked':
    case 'confirmed':
    case 'arrived':
      return { startMs, endMs: r.end.getTime() + buffer, vip, bookedStartMs: startMs }
    case 'cleaning': {
      const began = (r.cleaningStartedAt ?? r.start).getTime()
      const end = Math.max(began + r.durationMin * MS_PER_MIN, now.getTime())
      return { startMs: began, endMs: end + buffer, vip, bookedStartMs: startMs }
    }
    case 'completed': {
      const done = (r.completedAt ?? r.end).getTime()
      const from = Math.min(startMs, done)
      return { startMs: from, endMs: Math.max(done, from) + buffer, vip, bookedStartMs: startMs }
    }
    default:
      return null
  }
}

export async function loadBusyRows(
  db: Executor,
  o: { locationId: string; from: Date; to: Date; excludeAppointmentId?: string },
): Promise<BusyRow[]> {
  let q = db
    .selectFrom('appointments')
    .select([
      'id',
      'customer_id',
      'status',
      'scheduled_start',
      'scheduled_end',
      'duration_min',
      'cleaning_started_at',
      'completed_at',
    ])
    .where('location_id', '=', o.locationId)
    .where('status', 'in', ['booked', 'confirmed', 'arrived', 'cleaning', 'completed'])
    .where((eb) =>
      eb.or([
        eb.and([eb('scheduled_start', '>=', o.from), eb('scheduled_start', '<', o.to)]),
        eb('status', '=', 'cleaning'),
      ]),
    )
  if (o.excludeAppointmentId) q = q.where('id', '<>', o.excludeAppointmentId)
  const rows = await q.execute()
  return rows.map((r) => ({
    id: r.id,
    customerId: r.customer_id,
    status: r.status,
    start: r.scheduled_start,
    end: r.scheduled_end,
    durationMin: r.duration_min,
    cleaningStartedAt: r.cleaning_started_at,
    completedAt: r.completed_at,
  }))
}

export async function countActiveBays(db: Executor, locationId: string): Promise<number> {
  const r = await db
    .selectFrom('bays')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('location_id', '=', locationId)
    .where('status', '=', 'active')
    .executeTakeFirstOrThrow()
  return r.n
}

export async function sameDayGuaranteesUsed(
  db: Executor,
  o: { locationId: string; customerId: string; now: Date; tz: string },
): Promise<number> {
  const today = toBizDate(o.now, o.tz)
  const first = `${today.slice(0, 8)}01`
  const monthStart = bizDayBounds(first, o.tz).start
  const nextMonth = bizDayBounds(`${addDays(first, 31).slice(0, 8)}01`, o.tz).start
  const r = await db
    .selectFrom('appointment_overrides as ov')
    .innerJoin('appointments as a', 'a.id', 'ov.appointment_id')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('a.location_id', '=', o.locationId)
    .where('a.customer_id', '=', o.customerId)
    .where('ov.kind', '=', 'same_day_guarantee')
    .where('ov.created_at', '>=', monthStart)
    .where('ov.created_at', '<', nextMonth)
    .executeTakeFirstOrThrow()
  return r.n
}

export interface DayData {
  date: string
  tz: string
  now: Date
  day: DayInfo
  settings: SettingsBundle
  activeBays: number
  rows: BusyRow[]
  vipIds: Set<string>
  holds: VipHold[]
}

/** Everything the engine reads for one business date. */
export async function loadDayData(
  db: Executor,
  o: { locationId: string; tz: string; now: Date; date: string; excludeAppointmentId?: string },
): Promise<DayData> {
  const { start, end } = bizDayBounds(o.date, o.tz)
  const [settings, closures, emergency, activeBays, rows, holdRows] = await Promise.all([
    loadSettingsBundle(db, o.locationId),
    listLiveClosures(db, o.locationId, { from: o.date, to: o.date }),
    getActiveEmergency(db, o.locationId),
    countActiveBays(db, o.locationId),
    loadBusyRows(db, {
      locationId: o.locationId,
      from: new Date(start.getTime() - 12 * 3_600_000),
      to: end,
      excludeAppointmentId: o.excludeAppointmentId,
    }),
    db.selectFrom('vip_holds').select(['weekday', 'time_min']).where('location_id', '=', o.locationId).execute(),
  ])
  const day = dayInfo({
    date: o.date,
    hours: settings.hours,
    closures,
    emergency: emergencySnapshot(emergency, o.tz),
  })
  const vipIds = await vipCustomerIds(
    db,
    o.locationId,
    [...new Set(rows.map((r) => r.customerId))],
  )
  return {
    date: o.date,
    tz: o.tz,
    now: o.now,
    day,
    settings,
    activeBays,
    rows,
    vipIds,
    holds: holdRows.map((h) => ({ weekday: h.weekday, timeMin: h.time_min })),
  }
}

export function engineInput(
  d: DayData,
  o: { durationMin: number; channel: Channel; isVip: boolean; sameDayUsed?: number },
): AvailabilityInput {
  return {
    date: d.date,
    tz: d.tz,
    now: d.now,
    day: d.day,
    rules: d.settings.rules,
    activeBays: d.activeBays,
    durationMin: o.durationMin,
    channel: o.channel,
    isVip: o.isVip,
    intervals: d.rows
      .map((r) => intervalOfRow(r, d.settings.rules.bufferMinutes, d.now, d.vipIds.has(r.customerId)))
      .filter((x): x is BusyInterval => x !== null),
    holds: d.holds,
    releaseHours: d.settings.vip.releaseHours,
    windowVipDays: d.settings.vip.windowVipDays,
    windowStdDays: d.settings.vip.windowStdDays,
    sameDayUsed: o.sameDayUsed,
    sameDayLimit: d.settings.vip.sameDayPerMonth,
  }
}

export interface AvailabilityQuery {
  locationId: string
  tz: string
  now: Date
  date: string
  serviceId: string
  channel: Channel
  customerId?: string
  excludeAppointmentId?: string
}

export interface AvailabilityAnswer extends AvailabilityResult {
  channel: Channel
  isVip: boolean
  durationMin: number
  slotMinutes: number
  releaseHours: number
}

/** GET /availability: the slot states of a date for a package. */
export async function getAvailability(db: Executor, q: AvailabilityQuery): Promise<AvailabilityAnswer> {
  const service = await requireService(db, q.locationId, q.serviceId)
  if (service.kind !== 'package')
    throw new AppError('VALIDATION_FAILED', {
      detail: 'Pick a package to check availability.',
      errors: [{ path: 'serviceId', message: 'Pick a package to check availability.' }],
    })
  const data = await loadDayData(db, q)
  const isVip = q.customerId ? (await vipCustomerIds(db, q.locationId, [q.customerId])).has(q.customerId) : false
  const sameDayUsed =
    isVip && q.customerId
      ? await sameDayGuaranteesUsed(db, {
          locationId: q.locationId,
          customerId: q.customerId,
          now: q.now,
          tz: q.tz,
        })
      : 0
  const input = engineInput(data, {
    durationMin: service.durationMin,
    channel: q.channel,
    isVip,
    sameDayUsed,
  })
  return {
    ...computeSlots(input),
    channel: q.channel,
    isVip,
    durationMin: service.durationMin,
    slotMinutes: data.settings.rules.slotMinutes,
    releaseHours: data.settings.vip.releaseHours,
  }
}

export type { Evaluation }
export { evaluateStart }
