// A household (ADR 0170): the holder of a membership plus the clients in membership_household. A client who shares a live
// membership is a member through it, so no path gives them a membership of their own while they do: staff (createManualMembership,
// 409 MEMBERSHIP_HOUSEHOLD_TAKEN), a personal link's membership start (the same code, LINK_ALREADY_MEMBER on the page) and the
// verified website join (PUBLIC_ALREADY_MEMBER). Remove them from the household first.
import type { Executor } from '../../platform/db.js'

const LIVE = ['pending', 'active', 'past_due', 'paused'] as const

/** The id of the live membership a client shares as a household member (not one they hold); undefined when none. */
export async function sharedMembershipId(db: Executor, customerId: string): Promise<string | undefined> {
  const r = await db
    .selectFrom('membership_household as h')
    .innerJoin('memberships as m', 'm.id', 'h.membership_id')
    .select('m.id')
    .where('h.customer_id', '=', customerId)
    .where('h.removed_at', 'is', null)
    .where('m.status', 'in', [...LIVE])
    .executeTakeFirst()
  return r?.id
}
