// The stale-record rule (ADR 0160, design section 5): phone numbers are recycled, so a client record whose number has gone quiet
// for 180 days or more, or whose last text bounced as an invalid number, says nothing about who holds that number today. Such a
// record is treated as unknown (no name, no appointments, no trust) until the number is verified again on a link page. Texts FROM
// the number are never activity: whoever holds a recycled number texts from it too, and the webhook stores that text before the
// assistant asks for the verdict, so counting it would clear the rule at the very moment it exists for.
import { sql } from 'kysely'
import type { Executor } from '../../platform/db.js'
import { isTransientReason } from '../messaging/dispatch/retry.js'
import './schema.js'

export const STALE_AFTER_DAYS = 180
const DAY_MS = 86_400_000

/** A delivery failure that says the number itself is wrong (not a transient radio or network failure). */
const INVALID_NUMBER =
  /invalid[ _-]?(destination|number|address|recipient|phone)|unknown[ _-]?(subscriber|number|destination)|unallocated|not in service|no such (number|subscriber)|number does not exist|disconnected/i

export function isInvalidNumberError(error: string | null | undefined): boolean {
  return !!error && !isTransientReason(error) && INVALID_NUMBER.test(error)
}

export interface StaleVerdict {
  stale: boolean
  reason: 'inactive' | 'invalid_number' | null
  /** The newest sign of the client: the record's creation, a visit or booking, a verification, a live membership. */
  lastActivityAt: Date
}

/**
 * The verdict for the client owning `phone`. Activity: the record's creation, an appointment (booked, or its time once passed), a
 * verification on a link page (phone_trust.verified_at, expired or not), an active membership (counts as now). A text from the
 * number is not activity (see above). The invalid-number rule: the number's newest final outbound text failed as an invalid number
 * after its last verification.
 */
export async function staleRecord(
  db: Executor,
  o: { locationId: string; customerId: string; phone: string; now: Date },
): Promise<StaleVerdict> {
  const r = await sql<{ created: Date; appt: Date | null; verified: Date | null; member: boolean }>`
    select
      c.created_at as created,
      (select max(greatest(a.created_at, least(a.scheduled_start, ${o.now}::timestamptz))) from appointments a where a.customer_id = c.id) as appt,
      (select max(t.verified_at) from phone_trust t where t.location_id = ${o.locationId} and t.phone_e164 = ${o.phone}
        and t.customer_id = c.id) as verified,
      exists (select 1 from memberships m where m.customer_id = c.id and m.status in ('active', 'past_due', 'paused')) as member
    from customers c where c.id = ${o.customerId}`.execute(db)
  const row = r.rows[0]
  if (!row) return { stale: true, reason: 'inactive', lastActivityAt: new Date(0) }
  const times = [row.created, row.appt, row.verified].filter((x): x is Date => x !== null).map((x) => new Date(x))
  const last = row.member ? o.now : new Date(Math.max(...times.map((x) => x.getTime())))

  const lastOut = await db
    .selectFrom('messages')
    .select(['status', 'error', 'queued_at'])
    .where('location_id', '=', o.locationId)
    .where('direction', '=', 'out')
    .where('peer_e164', '=', o.phone)
    .where('status', 'in', ['delivered', 'failed'])
    .orderBy('queued_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  const verifiedAt = row.verified ? new Date(row.verified).getTime() : -Infinity
  if (lastOut?.status === 'failed' && isInvalidNumberError(lastOut.error) && lastOut.queued_at.getTime() > verifiedAt)
    return { stale: true, reason: 'invalid_number', lastActivityAt: last }
  if (o.now.getTime() - last.getTime() >= STALE_AFTER_DAYS * DAY_MS) return { stale: true, reason: 'inactive', lastActivityAt: last }
  return { stale: false, reason: null, lastActivityAt: last }
}
