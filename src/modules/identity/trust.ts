// The 30-day phone trust (ADR 0160, design sections 0 and 5): verifying once on a link page (PIN or texted code) lets the AI book,
// reschedule and cancel by text for that number for 30 days, each action still confirmed by a reply number. A trust is one row per
// (location, number). It ends early on a phone change, PIN reset or clear, merge, STOP, a staff revoke or a links-epoch bump: the
// explicit ones write revoked_at, and evaluateTrust re-checks the rest on every read (the epoch it was granted in, the number's
// current owner, an opt-out since, a number that bounced as invalid since, the stale-record rule), so no path can forget one.
import { sql } from 'kysely'
import type { Executor, Tx } from '../../platform/db.js'
import type { IdentityRevokeReason, VerifiedBy } from './schema.js'
import { currentEpoch, optedOutSince, ownerOf } from './common.js'
import { staleRecord } from './stale.js'
import './schema.js'

export const TRUST_TTL_MS = 30 * 86_400_000

export type TrustEndReason = 'none' | 'expired' | 'revoked' | 'epoch' | 'owner_changed' | 'opted_out' | 'stale'

export interface TrustState {
  trusted: boolean
  /** When the trust ends (null when there is none). */
  until: Date | null
  verifiedAt: Date | null
  verifiedBy: VerifiedBy | null
  /** The client the trust belongs to. */
  customerId: string | null
  /** Why there is no trust (null when trusted). */
  reason: TrustEndReason | null
  revokeReason: IdentityRevokeReason | null
}

/** Starts (or renews) the number's 30-day trust for the client after a PIN or code entered on a link page. */
export async function grantTrust(
  tx: Tx,
  o: { locationId: string; phone: string; customerId: string; verifiedBy: VerifiedBy; now: Date },
): Promise<{ until: Date }> {
  const until = new Date(o.now.getTime() + TRUST_TTL_MS)
  const epoch = await currentEpoch(tx, o.locationId)
  await tx
    .insertInto('phone_trust')
    .values({
      location_id: o.locationId,
      phone_e164: o.phone,
      customer_id: o.customerId,
      verified_at: o.now,
      verified_by: o.verifiedBy,
      expires_at: until,
      epoch,
      revoked_at: null,
      revoke_reason: null,
      created_at: o.now,
      updated_at: o.now,
    })
    .onConflict((oc) =>
      oc.columns(['location_id', 'phone_e164']).doUpdateSet({
        customer_id: o.customerId,
        verified_at: o.now,
        verified_by: o.verifiedBy,
        expires_at: until,
        epoch,
        revoked_at: null,
        revoke_reason: null,
        updated_at: o.now,
      }),
    )
    .execute()
  return { until }
}

/**
 * Whether the number is trusted now, and for whom. With `customerId` the trust must also belong to that client. Every rule is
 * checked on read: revoked, expired, another links epoch, the number now owned by someone else (or nobody), an opt-out since the
 * verification, the stale-record rule (an invalid-number bounce since the verification).
 */
export async function evaluateTrust(
  db: Executor,
  o: { locationId: string; phone: string; now: Date; customerId?: string | null },
): Promise<TrustState> {
  const none = (reason: TrustEndReason, row?: { expires_at: Date; verified_at: Date; verified_by: VerifiedBy; customer_id: string; revoke_reason: IdentityRevokeReason | null }): TrustState => ({
    trusted: false,
    until: null,
    verifiedAt: row?.verified_at ?? null,
    verifiedBy: row?.verified_by ?? null,
    customerId: row?.customer_id ?? null,
    reason,
    revokeReason: row?.revoke_reason ?? null,
  })
  const row = await db
    .selectFrom('phone_trust')
    .selectAll()
    .where('location_id', '=', o.locationId)
    .where('phone_e164', '=', o.phone)
    .executeTakeFirst()
  if (!row) return none('none')
  if (row.revoked_at !== null) return none('revoked', row)
  if (row.expires_at.getTime() <= o.now.getTime()) return none('expired', row)
  if (row.epoch !== (await currentEpoch(db, o.locationId))) return none('epoch', row)
  const owner = await ownerOf(db, o.phone)
  if (owner !== row.customer_id || (o.customerId != null && o.customerId !== row.customer_id)) return none('owner_changed', row)
  if (await optedOutSince(db, { locationId: o.locationId, phone: o.phone, customerId: row.customer_id, since: row.verified_at }))
    return none('opted_out', row)
  const stale = await staleRecord(db, { locationId: o.locationId, customerId: row.customer_id, phone: o.phone, now: o.now })
  if (stale.stale) return none('stale', row)
  return {
    trusted: true,
    until: row.expires_at,
    verifiedAt: row.verified_at,
    verifiedBy: row.verified_by,
    customerId: row.customer_id,
    reason: null,
    revokeReason: null,
  }
}

/** Ends the live trust of a number and/or of a client (every number it was granted for). Returns how many ended. */
export async function revokeTrust(
  tx: Tx,
  o: { locationId?: string; phone?: string | null; customerId?: string | null; reason: IdentityRevokeReason; now?: Date },
): Promise<number> {
  if (!o.phone && !o.customerId) return 0
  const at = o.now ?? sql<Date>`app_now()`
  const r = await tx
    .updateTable('phone_trust')
    .set({ revoked_at: at, revoke_reason: o.reason, updated_at: at })
    .where('revoked_at', 'is', null)
    .$if(o.locationId !== undefined, (q) => q.where('location_id', '=', o.locationId!))
    .where((eb) =>
      eb.or([
        ...(o.phone ? [eb('phone_e164', '=', o.phone)] : []),
        ...(o.customerId ? [eb('customer_id', '=', o.customerId)] : []),
      ]),
    )
    .executeTakeFirst()
  return Number(r.numUpdatedRows)
}
