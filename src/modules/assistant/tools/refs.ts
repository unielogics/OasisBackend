// The client's own appointments as the model knows them: refs A1..A3 (ADR 0160, design section 3; contract AppointmentRefs). The
// turn (W3a) builds them once at its claim; this is the reading of the contract's rule it may use: the open upcoming visits by start,
// then the most recent past one, at most three, only the turn's own client. A ref resolves to nothing for anyone else.
import type { Executor } from '../../../platform/db.js'
import type { AppointmentRefLabel, AppointmentRefs } from '../contract.js'

const LABELS: readonly AppointmentRefLabel[] = ['A1', 'A2', 'A3']
const OPEN = ['booked', 'confirmed', 'arrived', 'cleaning'] as const

export function refsOf(ids: readonly string[]): AppointmentRefs {
  const list = ids.slice(0, LABELS.length).map((appointmentId, i) => ({ ref: LABELS[i]!, appointmentId }))
  return {
    resolve: (ref) => list.find((r) => r.ref === ref.trim().toUpperCase())?.appointmentId ?? null,
    all: () => list,
  }
}

export const NO_REFS: AppointmentRefs = refsOf([])

export async function loadAppointmentRefs(db: Executor, o: { locationId: string; customerId: string | null; now: Date }): Promise<AppointmentRefs> {
  if (!o.customerId) return NO_REFS
  const upcoming = await db
    .selectFrom('appointments')
    .select('id')
    .where('location_id', '=', o.locationId)
    .where('customer_id', '=', o.customerId)
    .where('status', 'in', [...OPEN])
    .where('scheduled_end', '>', o.now)
    .orderBy('scheduled_start')
    .orderBy('id')
    .limit(LABELS.length)
    .execute()
  const ids = upcoming.map((r) => r.id)
  if (ids.length < LABELS.length) {
    const past = await db
      .selectFrom('appointments')
      .select('id')
      .where('location_id', '=', o.locationId)
      .where('customer_id', '=', o.customerId)
      .where('scheduled_start', '<=', o.now)
      .$if(ids.length > 0, (q) => q.where('id', 'not in', ids))
      .orderBy('scheduled_start', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst()
    if (past) ids.push(past.id)
  }
  return refsOf(ids)
}
