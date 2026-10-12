// The stale-record rule (ADR 0160, design section 5): phone numbers are recycled, so a client record whose number has gone quiet
// for 180 days or more, or whose last text bounced as an invalid number, says nothing about who holds that number today. Such a
// record is treated as unknown (no name, no appointments, no trust). Proving control of the NUMBER is not proof of being the OLD
// CLIENT (W4c fixes): a texted code, a link or website booking or any text from the number never ends the rule; only proof of being
// that client does: their PIN, a staff action (a booking staff made, a visit staff served, staff confirming the number) or a
// membership paid and matched to them. A party that verified only the number on a stale record books as a new client
// (identity/rebind.ts). Texts FROM the number are never activity: whoever holds a recycled number texts from it too, and the
// webhook stores that text before the assistant asks for the verdict, so counting it would clear the rule at the very moment it
// exists for.
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
  /** The newest proof of the client: the record's creation, their PIN, a staff action, a live membership (see staleRecord). */
  lastActivityAt: Date
}

/** Appointment sources staff create (the dashboard's booking sheet, a walk-in, a phone booking, a standing series). */
export const STAFF_APPOINTMENT_SOURCES = ['dashboard', 'walk_in', 'phone', 'standing'] as const

/**
 * The verdict for the client owning `phone`. Activity, each a proof of being this client: the record's creation; a PIN entered on a
 * link page (customers.identity_confirmed_at, or a 30-day trust granted by PIN); staff confirming the number (identity_confirmed_at);
 * an appointment staff created, or one a link page or the assistant created for a session verified with this client's PIN
 * (appointments.booked_with_pin), counting its time once passed; a visit staff served (the crew started or finished the wash: an
 * arrival alone can come from the client's own phone), except a website booking (anyone can type any number there); a live membership (counts as now: its payments were matched to this client, or staff set it). Never a
 * texted code, a link or website booking by itself, or a text from the number. The invalid-number rule: the number's newest final
 * outbound text failed as an invalid number after the record's newest proof (its creation included).
 */
export async function staleRecord(
  db: Executor,
  o: { locationId: string; customerId: string; phone: string; now: Date },
): Promise<StaleVerdict> {
  const staff = sql.join(STAFF_APPOINTMENT_SOURCES.map((x) => sql`${x}`))
  const r = await sql<{ created: Date; appt: Date | null; proof: Date | null; member: boolean }>`
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
      exists (select 1 from memberships m where m.customer_id = c.id and m.status in ('active', 'past_due', 'paused')) as member
    from customers c where c.id = ${o.customerId}`.execute(db)
  const row = r.rows[0]
  if (!row) return { stale: true, reason: 'inactive', lastActivityAt: new Date(0) }
  const times = [row.created, row.appt, row.proof].filter((x): x is Date => x !== null).map((x) => new Date(x))
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
  // a bounce before the record existed (a previous holder's number) or before its newest proof says nothing about it
  const provenAt = Math.max(new Date(row.created).getTime(), row.proof ? new Date(row.proof).getTime() : -Infinity)
  if (lastOut?.status === 'failed' && isInvalidNumberError(lastOut.error) && lastOut.queued_at.getTime() > provenAt)
    return { stale: true, reason: 'invalid_number', lastActivityAt: last }
  if (o.now.getTime() - last.getTime() >= STALE_AFTER_DAYS * DAY_MS) return { stale: true, reason: 'inactive', lastActivityAt: last }
  return { stale: false, reason: null, lastActivityAt: last }
}
