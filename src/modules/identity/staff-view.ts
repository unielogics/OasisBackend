// What staff see of a client's phone identity (the client file's Overview: "Website PIN: Set · trusted to Nov 9", ADR 0160 design
// section 8): the PIN state, the number's trust, how many links and sessions are live, a pending in-chat action, the stale-record
// verdict and the "number reassigned" flag. Numbers are masked to their last four digits; no token, hash or code ever leaves the server.
import type { Executor } from '../../platform/db.js'
import { maskPhone } from '../../platform/phone.js'
import { pinStateOf } from './codes.js'
import { liveCustomer } from './common.js'
import type { ClientLinkKind, IdentityRevokeReason, PendingActionKind, VerifiedBy } from './schema.js'
import { staleRecord } from './stale.js'
import { evaluateTrust, type TrustEndReason } from './trust.js'
import './schema.js'

export type PinStatus = 'none' | 'set' | 'locked' | 'disabled' | 'cleared'

export interface IdentityState {
  customerId: string
  /** The client's number, masked ("+1******0142"), or null. */
  phone: string | null
  pin: {
    status: PinStatus
    setAt: Date | null
    lockedUntil: Date | null
    /** After a reset by texted code, member privileges wait until then. */
    resetHoldUntil: Date | null
  }
  trust: {
    trusted: boolean
    until: Date | null
    verifiedAt: Date | null
    verifiedBy: VerifiedBy | null
    /** Why the number is not trusted (null when it is). */
    reason: TrustEndReason | null
    revokeReason: IdentityRevokeReason | null
  }
  links: { live: number; byKind: Partial<Record<ClientLinkKind, number>>; lastIssuedAt: Date | null }
  sessions: { live: number }
  pendingAction: { kind: PendingActionKind; expiresAt: Date } | null
  stale: { stale: boolean; reason: 'inactive' | 'invalid_number' | null; lastActivityAt: Date } | null
  /** The number was moved to a new client (a party verified only the number on this stale record): the staff flag. */
  numberReassigned: { at: Date; toCustomerId: string | null } | null
}

/** The client's identity state, or null when the client does not exist (or was merged or deleted). */
export async function identityStateOf(db: Executor, o: { locationId: string; customerId: string; now: Date }): Promise<IdentityState | null> {
  const c = await liveCustomer(db, o.customerId)
  if (!c) return null
  const { now } = o
  const pinRow = await db.selectFrom('customer_pins').select(['pin_hash', 'cleared_at']).where('customer_id', '=', c.id).executeTakeFirst()
  const p = await pinStateOf(db, c.id)
  const status: PinStatus = !pinRow
    ? 'none'
    : !p.set
      ? 'cleared'
      : p.lockLevel >= 3
        ? 'disabled'
        : p.lockedUntil && p.lockedUntil.getTime() > now.getTime()
          ? 'locked'
          : 'set'
  const trust = c.phoneE164
    ? await evaluateTrust(db, { locationId: o.locationId, phone: c.phoneE164, customerId: c.id, now })
    : { trusted: false, until: null, verifiedAt: null, verifiedBy: null, reason: 'none' as const, revokeReason: null }
  const links = await db
    .selectFrom('client_links')
    .select(['kind', (eb) => eb.fn.countAll<string>().as('n'), (eb) => eb.fn.max('created_at').as('last')])
    .where('location_id', '=', o.locationId)
    .where('customer_id', '=', c.id)
    .where('revoked_at', 'is', null)
    .where('consumed_at', 'is', null)
    .where('expires_at', '>', now)
    .groupBy('kind')
    .execute()
  const byKind: Partial<Record<ClientLinkKind, number>> = {}
  let live = 0
  let last: Date | null = null
  for (const l of links) {
    byKind[l.kind] = Number(l.n)
    live += Number(l.n)
    const at = l.last ? new Date(l.last as unknown as string) : null
    if (at && (!last || at > last)) last = at
  }
  const sessions = await db
    .selectFrom('client_link_sessions')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('customer_id', '=', c.id)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', now)
    .where('idle_expires_at', '>', now)
    .executeTakeFirstOrThrow()
  const action = await db
    .selectFrom('assistant_pending_actions')
    .select(['kind', 'expires_at'])
    .where('customer_id', '=', c.id)
    .where('state', '=', 'pending')
    .where('expires_at', '>', now)
    .executeTakeFirst()
  const stale = c.phoneE164 ? await staleRecord(db, { locationId: o.locationId, customerId: c.id, phone: c.phoneE164, now }) : null
  const moved = await db.selectFrom('customers').select(['phone_reassigned_at', 'phone_reassigned_to']).where('id', '=', c.id).executeTakeFirstOrThrow()
  return {
    customerId: c.id,
    phone: c.phoneE164 ? maskPhone(c.phoneE164) : null,
    pin: {
      status,
      setAt: p.set ? p.setAt : null,
      lockedUntil: status === 'locked' ? p.lockedUntil : null,
      resetHoldUntil: p.resetHoldUntil && p.resetHoldUntil.getTime() > now.getTime() ? p.resetHoldUntil : null,
    },
    trust: {
      trusted: trust.trusted,
      until: trust.until,
      verifiedAt: trust.verifiedAt,
      verifiedBy: trust.verifiedBy,
      reason: trust.reason,
      revokeReason: trust.revokeReason,
    },
    links: { live, byKind, lastIssuedAt: last },
    sessions: { live: Number(sessions.n) },
    pendingAction: action ? { kind: action.kind, expiresAt: action.expires_at } : null,
    stale,
    numberReassigned: moved.phone_reassigned_at ? { at: moved.phone_reassigned_at, toCustomerId: moved.phone_reassigned_to } : null,
  }
}
