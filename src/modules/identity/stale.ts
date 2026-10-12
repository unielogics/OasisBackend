// The stale-record rule (ADR 0160, design section 5): phone numbers are recycled, so a client record whose number has gone quiet
// for 180 days or more, or whose last text bounced as an invalid number, says nothing about who holds that number today. Such a
// record is treated as unknown (no name, no appointments, no trust). Proving control of the NUMBER is not proof of being the OLD
// CLIENT (W4c fixes): a texted code, a link or website booking or any text from the number never ends the rule; only proof of being
// that client does: their PIN, a staff action (a booking staff made, a visit staff served, staff confirming the number, staff
// setting a membership) or a membership payment matched to them, each from its own time. A party that verified only the number on a stale record books as a new client
// (identity/rebind.ts). Texts FROM the number are never activity: whoever holds a recycled number texts from it too, and the
// webhook stores that text before the assistant asks for the verdict, so counting it would clear the rule at the very moment it
// exists for. A paid-up member is never held for inactivity (W4c re-review 3, D2): a membership paid through Squarespace whose paid
// period covers now (plus 14 days of grace) is current proof of the client, so a yearly member who never comes in stays known; a
// lapsed one counts from their last payment. A bounce as an invalid number still holds a paid-up member's record: the number itself
// is gone, and carriers hand it to someone else.
import { sql } from 'kysely'
import type { Executor } from '../../platform/db.js'
import { isTransientReason } from '../messaging/dispatch/retry.js'
import './schema.js'

export const STALE_AFTER_DAYS = 180
/**
 * A membership paid through Squarespace whose paid period (its current_period_end, or the plan's period after its last payment)
 * ended less than this long ago is paid up: current proof of the client (W4c re-review 3, D2).
 */
export const PAID_UP_GRACE_DAYS = 14
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
  /** The newest proof of the client: the record's creation, their PIN, a staff action, a membership payment, now for a paid-up member (see staleRecord). */
  lastActivityAt: Date
  /**
   * Since when the rule has held the record (stale only): 180 days after its newest proof, or the invalid-number bounce. Something
   * the record got before then (a Squarespace contact linked by its phone) was given while it was still the client's (W4c re-review 2).
   */
  staleSince?: Date
}

/** Appointment sources staff create (the dashboard's booking sheet, a walk-in, a phone booking, a standing series). */
export const STAFF_APPOINTMENT_SOURCES = ['dashboard', 'walk_in', 'phone', 'standing'] as const

/**
 * The verdict for the client owning `phone`. Activity, each a proof of being this client: the record's creation; a PIN entered on a
 * link page (customers.identity_confirmed_at, or a 30-day trust granted by PIN); staff confirming the number (identity_confirmed_at);
 * an appointment staff created, or one a link page or the assistant created for a session verified with this client's PIN
 * (appointments.booked_with_pin), counting its time once passed; a visit staff served (the crew started or finished the wash: an
 * arrival alone can come from the client's own phone), except a website booking (anyone can type any number there),
 * counting from the wash (owner decision, W4c re-review: the crew served the client in person); a membership payment matched to this
 * client (memberships.last_paid_at, whatever the membership's status now) or staff setting a membership live or paused
 * (manual_status_at of an active, past_due or paused row: a checkout the system canceled is no proof), each counting from its own
 * time: a membership that is merely still live proves nothing new (W4c re-review R3), except a PAID-UP one (W4c re-review 3, D2): a
 * live (active, past_due or paused) membership with a matched payment whose paid period (current_period_end, else the plan's
 * billing interval after last_paid_at) ended less than PAID_UP_GRACE_DAYS ago counts as proof now; a lapsed one counts from its
 * last_paid_at as before, and a hand-made one (no matched payment) from its staff action. Never a texted code, a link or website
 * booking by itself, or a text from the number. The invalid-number rule: the number's newest final
 * outbound text failed as an invalid number after the record's newest proof (its creation included).
 */
export async function staleRecord(
  db: Executor,
  o: { locationId: string; customerId: string; phone: string; now: Date },
): Promise<StaleVerdict> {
  const staff = sql.join(STAFF_APPOINTMENT_SOURCES.map((x) => sql`${x}`))
  const r = await sql<{ created: Date; appt: Date | null; proof: Date | null; member: Date | null }>`
    select
      c.created_at as created,
      (select max(case
          when a.source in (${staff}) or a.booked_with_pin then greatest(a.created_at, least(a.scheduled_start, ${o.now}::timestamptz))
          when a.source <> 'online' and coalesce(a.cleaning_started_at, a.completed_at) is not null
            then least(coalesce(a.completed_at, a.cleaning_started_at), ${o.now}::timestamptz)
        end) from appointments a where a.customer_id = c.id) as appt,
      greatest(c.identity_confirmed_at,
        (select max(t.verified_at) from phone_trust t where t.location_id = ${o.locationId} and t.phone_e164 = ${o.phone}
          and t.customer_id = c.id and t.verified_by = 'pin')) as proof,
      (select max(greatest(
          case when m.status in ('active', 'past_due', 'paused') and m.last_paid_at is not null
                and coalesce(m.current_period_end, m.last_paid_at + make_interval(months => p.billing_interval_months))
                  + make_interval(days => ${PAID_UP_GRACE_DAYS}::int) >= ${o.now}::timestamptz
            then ${o.now}::timestamptz end,
          m.last_paid_at,
          case when m.status in ('active', 'past_due', 'paused') then m.manual_status_at end))
        from memberships m join membership_plans p on p.id = m.plan_id where m.customer_id = c.id) as member
    from customers c where c.id = ${o.customerId}`.execute(db)
  const row = r.rows[0]
  if (!row) return { stale: true, reason: 'inactive', lastActivityAt: new Date(0), staleSince: new Date(0) }
  // the membership's proof time, capped at now (in JS: Postgres least() would turn a missing time into now)
  const member = row.member === null ? null : new Date(Math.min(new Date(row.member).getTime(), o.now.getTime()))
  const times = [row.created, row.appt, row.proof, member].filter((x): x is Date => x !== null).map((x) => new Date(x))
  const last = new Date(Math.max(...times.map((x) => x.getTime())))

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
  // a bounce before the record existed (a previous holder's number) or before its newest proof says nothing about it
  const provenAt = Math.max(new Date(row.created).getTime(), row.proof ? new Date(row.proof).getTime() : -Infinity)
  if (lastOut?.status === 'failed' && isInvalidNumberError(lastOut.error) && lastOut.queued_at.getTime() > provenAt)
    return { stale: true, reason: 'invalid_number', lastActivityAt: last, staleSince: lastOut.queued_at }
  if (o.now.getTime() - last.getTime() >= STALE_AFTER_DAYS * DAY_MS)
    return { stale: true, reason: 'inactive', lastActivityAt: last, staleSince: new Date(last.getTime() + STALE_AFTER_DAYS * DAY_MS) }
  return { stale: false, reason: null, lastActivityAt: last }
}

/**
 * What staff are told about a stale record (W4c re-review 3, D3), for a notice or a refusal: "this number's record has been quiet
 * for N days" or "this number's last text bounced as an invalid number".
 */
export function staleWhy(v: StaleVerdict, now: Date): string {
  if (v.reason === 'invalid_number') return "this number's last text bounced as an invalid number"
  return `this number's record has been quiet for ${Math.floor((now.getTime() - v.lastActivityAt.getTime()) / DAY_MS)} days`
}
