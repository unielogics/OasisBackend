// The revocation hooks (ADR 0160, design section 5): a phone change, a PIN reset or clear, a merge, a STOP, a staff revoke and an
// epoch bump end the client's links, link sessions and phone trust. The epoch and STOP are also enforced on every read (common.ts),
// so these writes are the record of what happened and the immediate effect; a pending in-chat action of the number is canceled too.
import { sql } from 'kysely'
import type { Tx } from '../../platform/db.js'
import { revokeLinks } from './links.js'
import { cancelPendingActions } from './pending-actions.js'
import type { IdentityRevokeReason } from './schema.js'
import { revokeSessions } from './sessions.js'
import { revokeTrust } from './trust.js'

export interface RevokedCounts {
  links: number
  sessions: number
  trust: number
  pendingActions: number
}

/**
 * Ends what a client (and/or a number) holds: live links, live sessions, the phone trust and a pending in-chat action. `keep*` spare
 * the page doing the change (a PIN set or reset keeps its own link and session).
 */
export async function revokeIdentity(
  tx: Tx,
  o: {
    locationId?: string
    customerId?: string | null
    phone?: string | null
    reason: IdentityRevokeReason
    now?: Date
    /** False keeps the phone trust (default: ended too). */
    trust?: boolean
    /** False keeps a pending in-chat action (default: canceled). */
    pendingActions?: boolean
    keepLinkId?: string | null
    keepSessionHash?: string | null
  },
): Promise<RevokedCounts> {
  const now = o.now ?? (await sql<{ now: Date }>`select app_now() as now`.execute(tx)).rows[0]!.now
  const links = await revokeLinks(tx, { locationId: o.locationId, customerId: o.customerId, phone: o.phone, reason: o.reason, now, keepLinkId: o.keepLinkId })
  const sessions = await revokeSessions(tx, { customerId: o.customerId, phone: o.phone, now, keepTokenHash: o.keepSessionHash })
  const trust = o.trust === false ? 0 : await revokeTrust(tx, { locationId: o.locationId, customerId: o.customerId, phone: o.phone, reason: o.reason, now })
  const pendingActions = o.pendingActions === false ? 0 : await cancelPendingActions(tx, { locationId: o.locationId, customerId: o.customerId, phone: o.phone, now, error: `identity revoked: ${o.reason}` })
  return { links, sessions, trust, pendingActions }
}

/** A client's number changed (or was removed): everything bound to the old number ends. Called by updateCustomer. */
export async function revokeForPhoneChange(tx: Tx, o: { customerId: string; oldPhone: string | null }): Promise<RevokedCounts> {
  return revokeIdentity(tx, { customerId: o.customerId, phone: o.oldPhone, reason: 'phone_change' })
}

/** Two client records were merged: both lose their links, sessions and trust (each number is verified again). */
export async function revokeForMerge(tx: Tx, o: { fromCustomerId: string; intoCustomerId: string }): Promise<RevokedCounts> {
  const a = await revokeIdentity(tx, { customerId: o.fromCustomerId, reason: 'merge' })
  const b = await revokeIdentity(tx, { customerId: o.intoCustomerId, reason: 'merge' })
  return { links: a.links + b.links, sessions: a.sessions + b.sessions, trust: a.trust + b.trust, pendingActions: a.pendingActions + b.pendingActions }
}

/** The number texted STOP (or staff recorded an opt-out): its links, sessions, trust and pending action end (the router calls this). */
export async function revokeForOptOut(tx: Tx, o: { locationId: string; phone: string; now?: Date }): Promise<RevokedCounts> {
  return revokeIdentity(tx, { locationId: o.locationId, phone: o.phone, reason: 'opt_out', now: o.now })
}
