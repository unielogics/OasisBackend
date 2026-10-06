// SQL implementation of the affected-appointment queries (closures and emergencies).
import { sql } from 'kysely'
import type { Executor } from '../../platform/db.js'
import { NIL_UUID } from '../../platform/ids.js'
import { bizDayBounds, fmtT, minutesOfDay, toBizDate, wallToInstant } from '../../platform/time.js'
import '../customers/schema.js'
import type { AppointmentStatus } from '../customers/schema.js'
import type { AffectedAppointment, AffectedCounter, ClosureWindow } from './ports.js'

const firstName = (full: string): string => full.trim().split(/\s+/)[0] ?? full

export interface AppointmentRangeQuery {
  locationId: string
  /** Start instants in [from, to); omit both to look at every start. */
  from?: Date
  to?: Date
  /** Restrict to these appointments. */
  ids?: readonly string[]
  statuses: readonly AppointmentStatus[]
  tz: string
  /** Extra restriction on the start instant (reduced-hours window). */
  outside?: { from: Date; to: Date }
}

export async function listAppointmentsInRange(
  db: Executor,
  q: AppointmentRangeQuery,
): Promise<AffectedAppointment[]> {
  let query = db
    .selectFrom('appointments as a')
    .innerJoin('customers as c', 'c.id', 'a.customer_id')
    .leftJoin('vehicles as v', 'v.id', 'a.vehicle_id')
    .select([
      'a.id as appointment_id',
      'a.customer_id',
      'a.status',
      'a.scheduled_start',
      'c.full_name',
      'c.phone_e164',
      'c.email',
      'c.sms_opted_out_at',
      'v.make',
      'v.model',
      'v.year',
    ])
    .where('a.location_id', '=', q.locationId)
    .where('a.status', 'in', [...q.statuses])
  if (q.from) query = query.where('a.scheduled_start', '>=', q.from)
  if (q.to) query = query.where('a.scheduled_start', '<', q.to)
  if (q.ids) query = query.where('a.id', 'in', q.ids.length > 0 ? [...q.ids] : [NIL_UUID])
  if (q.outside) {
    const { from, to } = q.outside
    query = query.where((eb) =>
      eb.or([eb('a.scheduled_start', '<', from), eb('a.scheduled_start', '>=', to)]),
    )
  }
  const rows = await query.orderBy('a.scheduled_start').orderBy('a.id').execute()
  return rows.map((r) => ({
    appointmentId: r.appointment_id,
    customerId: r.customer_id,
    customerName: r.full_name,
    firstName: firstName(r.full_name),
    vehicle: [r.make, r.model].filter(Boolean).join(' ') || null,
    vehicleYear: r.year,
    startsAt: r.scheduled_start,
    bizDate: toBizDate(r.scheduled_start, q.tz),
    time: fmtT(minutesOfDay(r.scheduled_start, q.tz)),
    status: r.status,
    phoneE164: r.phone_e164,
    email: r.email,
    smsOptedOut: r.sms_opted_out_at !== null,
  }))
}

function windowQuery(
  w: ClosureWindow,
  tz: string,
): { from: Date; to: Date; outside?: { from: Date; to: Date } } {
  const { start, end } = bizDayBounds(w.date, tz)
  if (w.type === 'closed') return { from: start, to: end }
  const open = w.openMin ?? 0
  const close = w.closeMin ?? 1440
  return {
    from: start,
    to: end,
    outside: {
      from: open <= 0 ? start : wallToInstant(w.date, open, tz),
      to: close >= 1440 ? end : wallToInstant(w.date, close, tz),
    },
  }
}

const NON_CANCELED: readonly AppointmentStatus[] = [
  'booked',
  'confirmed',
  'arrived',
  'cleaning',
  'completed',
  'no_show',
]

export const sqlAffectedCounter: AffectedCounter = {
  async count(db, w, tz) {
    const q = windowQuery(w, tz)
    let query = db
      .selectFrom('appointments as a')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('a.location_id', '=', w.locationId)
      .where('a.scheduled_start', '>=', q.from)
      .where('a.scheduled_start', '<', q.to)
      .where('a.status', 'in', [...NON_CANCELED])
    if (q.outside) {
      const { from, to } = q.outside
      query = query.where((eb) =>
        eb.or([eb('a.scheduled_start', '<', from), eb('a.scheduled_start', '>=', to)]),
      )
    }
    return (await query.executeTakeFirstOrThrow()).n
  },
  async list(db, w, tz) {
    return listAppointmentsInRange(db, {
      locationId: w.locationId,
      statuses: NON_CANCELED,
      tz,
      ...windowQuery(w, tz),
    })
  },
}
