// Small reads the identity services share: the links epoch, the client's PIN version, the live owner of a number, and whether the
// number opted out (STOP or a staff opt-out) after a moment. An opt-out after a link was issued or a trust was granted voids it even
// when START later lifts the opt-out: that is the "STOP revokes" rule, enforced on read so it holds whoever records the opt-out.
import { sql } from 'kysely'
import type { Executor } from '../../platform/db.js'
import { getSetting } from '../../platform/settings.js'
import './schema.js'
import '../customers/schema.js'
import '../messaging/schema.js'

/** The links.epoch setting of the location (1 until someone bumps it). */
export async function currentEpoch(db: Executor, locationId: string): Promise<number> {
  return (await getSetting(db, locationId, 'links.epoch')).value
}

/** customer_pins.version, or 0 for a client who never had a PIN (what a link issued for them records). */
export async function pinVersionOf(db: Executor, customerId: string): Promise<number> {
  const r = await db.selectFrom('customer_pins').select('version').where('customer_id', '=', customerId).executeTakeFirst()
  return r?.version ?? 0
}

export interface LiveCustomer {
  id: string
  fullName: string
  phoneE164: string | null
  email: string | null
  emailBounced: boolean
  phoneVersion: number
  optedOutAt: Date | null
  createdAt: Date
}

/** The customer if it is live (not merged, not deleted). */
export async function liveCustomer(db: Executor, customerId: string): Promise<LiveCustomer | undefined> {
  const r = await db
    .selectFrom('customers')
    .select(['id', 'full_name', 'phone_e164', 'email', 'email_bounced_at', 'phone_version', 'sms_opted_out_at', 'created_at'])
    .where('id', '=', customerId)
    .where('merged_into', 'is', null)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  return r
    ? {
        id: r.id,
        fullName: r.full_name,
        phoneE164: r.phone_e164,
        email: r.email,
        emailBounced: r.email_bounced_at !== null,
        phoneVersion: r.phone_version,
        optedOutAt: r.sms_opted_out_at,
        createdAt: r.created_at,
      }
    : undefined
}

/** The live customer owning the number, if any. */
export async function ownerOf(db: Executor, phone: string): Promise<string | undefined> {
  const r = await db
    .selectFrom('customers')
    .select('id')
    .where('phone_e164', '=', phone)
    .where('merged_into', 'is', null)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  return r?.id
}

/**
 * True when the number (or the client) opted out at or after `since`: a STOP row in sms_opt_outs, lifted or not, or the client's own
 * opt-out mark. A START does not revive what the STOP ended.
 */
export async function optedOutSince(
  db: Executor,
  o: { locationId: string; phone: string; customerId: string | null; since: Date },
): Promise<boolean> {
  const r = await sql<{ hit: boolean }>`
    select exists (
      select 1 from sms_opt_outs
      where location_id = ${o.locationId} and phone_e164 = ${o.phone} and opted_out_at >= ${o.since}
    ) or exists (
      select 1 from customers where id = ${o.customerId}::uuid and sms_opted_out_at >= ${o.since}
    ) as hit`.execute(db)
  return r.rows[0]?.hit === true
}
