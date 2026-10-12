// Stale-record re-binding (ADR 0160, "W4c fixes"; design sections 0 and 5). Proving control of a NUMBER (a texted code, or holding a
// link texted to it) is not proof of being the OLD CLIENT the shop has on file for it. While the stale-record rule holds a record
// (identity/stale.ts), a party who verified only the number never books onto it, never un-hides it and never changes it: the party
// gets a NEW client record and the number moves to it. The old record keeps its history, loses the phone (its links, link sessions,
// trust and pending action end as on any phone change) and is flagged for staff ("number reassigned"): if it was the same person after
// all, staff merge the two. The client's own PIN (or staff) is the proof that keeps a stale record: identity_confirmed_at.
import * as audit from '../../platform/audit.js'
import type { AuditContext } from '../../platform/audit.js'
import type { Clock } from '../../platform/clock.js'
import type { Executor, Tx } from '../../platform/db.js'
import type { NewId } from '../../platform/ids.js'
import { maskPhone } from '../../platform/phone.js'
import type { CustomerSource, SmsOptInSource } from '../customers/schema.js'
import { upsertCustomerByPhone } from '../customers/service.js'
import { notifyManagers } from '../messaging/notify.js'
import { ownerOf } from './common.js'
import { revokeIdentity } from './revoke.js'
import { staleRecord } from './stale.js'
import './schema.js'
import '../assistant/schema.js'
import '../leads/schema.js'

/** Records a proof of being this client (their PIN on a link page, staff confirming the number): it ends the stale-record rule. */
export async function confirmClientIdentity(tx: Tx, o: { customerId: string; now: Date }): Promise<void> {
  await tx.updateTable('customers').set({ identity_confirmed_at: o.now }).where('id', '=', o.customerId).execute()
}

/** True when the stale-record rule holds the client's record for `phone` now. */
export async function isStale(db: Executor, o: { locationId: string; customerId: string; phone: string; now: Date }): Promise<boolean> {
  return (await staleRecord(db, o)).stale
}

export interface PartyInput {
  locationId: string
  phone: string
  /** The client whose PIN the party entered (a session verified by PIN): that client is proven, stale or not. */
  provenByPinOf?: string | null
  /** What the party typed: their name (a placeholder when empty), email, consent; the new record's source. */
  name: string | null
  email: string | null
  smsOptIn: SmsOptInSource | null
  source: CustomerSource
  /** The link page doing it (a stranger's link): its link and session stay alive for the new client. */
  keepLinkId?: string | null
  keepSessionHash?: string | null
  audit: AuditContext
}

export interface PartyBinding {
  customerId: string
  /** A new client record was created for the party. */
  created: boolean
  /** The stale record the number was taken from (null when nothing moved). */
  reassignedFrom: string | null
}

/**
 * The client a party who verified only the number books as: nobody owns the number -> a new client; the owner's record is not stale,
 * or the party entered the owner's PIN -> the owner; the owner's record is stale -> a new client, and the number moves to it
 * (reassignNumber).
 */
export async function bindPartyToNumber(tx: Tx, d: { newId: NewId; clock: Clock }, o: PartyInput): Promise<PartyBinding> {
  const now = d.clock.now()
  const owner = await ownerOf(tx, o.phone)
  if (owner && o.provenByPinOf !== owner && (await isStale(tx, { locationId: o.locationId, customerId: owner, phone: o.phone, now })))
    return reassignNumber(tx, d, { ...o, from: owner })
  // the number's client (only a placeholder name, an empty email and missing consent are filled), or a new client
  const r = await upsertCustomerByPhone(tx, { newId: d.newId, now, fullName: o.name, phone: o.phone, email: o.email, source: o.source, smsOptIn: o.smsOptIn })
  return { customerId: r.customer.id, created: r.created, reassignedFrom: null }
}

/**
 * Moves the number from the stale record `from` to a new client record for the party: the old record loses the phone (a phone
 * change: its links, link sessions, trust and pending action end, except the page doing it), keeps everything else and is flagged
 * (phone_reassigned_at / _to); the number's assistant conversation and lead follow the number; the managers are told and it is
 * audited (customer.phone_reassigned).
 */
export async function reassignNumber(tx: Tx, d: { newId: NewId; clock: Clock }, o: PartyInput & { from: string }): Promise<PartyBinding> {
  const now = d.clock.now()
  const old = await tx
    .selectFrom('customers')
    .select(['id', 'full_name', 'phone_e164'])
    .where('id', '=', o.from)
    .forUpdate()
    .executeTakeFirstOrThrow()
  await tx
    .updateTable('customers')
    .set((eb) => ({
      phone_e164: null,
      phone_display: null,
      phone_version: eb('phone_version', '+', 1),
      needs_details: true,
      phone_reassigned_at: now,
      version: eb('version', '+', 1),
      updated_at: now,
    }))
    .where('id', '=', old.id)
    .execute()
  const revoked = await revokeIdentity(tx, {
    locationId: o.locationId,
    customerId: old.id,
    phone: o.phone,
    reason: 'phone_change',
    now,
    keepLinkId: o.keepLinkId ?? null,
    keepSessionHash: o.keepSessionHash ?? null,
  })
  const r = await upsertCustomerByPhone(tx, { newId: d.newId, now, fullName: o.name, phone: o.phone, email: o.email, source: o.source, smsOptIn: o.smsOptIn })
  const id = r.customer.id
  await tx.updateTable('customers').set({ phone_reassigned_to: id }).where('id', '=', old.id).execute()
  await tx
    .updateTable('assistant_conversations')
    .set({ customer_id: id, updated_at: now })
    .where('location_id', '=', o.locationId)
    .where('phone_e164', '=', o.phone)
    .where('customer_id', '=', old.id)
    .execute()
  await tx
    .updateTable('leads')
    .set({ customer_id: id, updated_at: now })
    .where('location_id', '=', o.locationId)
    .where('phone_e164', '=', o.phone)
    .where('customer_id', '=', old.id)
    .execute()
  await audit.record(tx, {
    locationId: o.locationId,
    action: 'customer.phone_reassigned',
    entityType: 'customer',
    entityId: old.id,
    before: { phone: maskPhone(o.phone) },
    after: { phone: null, reassignedTo: id, revoked: { ...revoked } },
    ctx: o.audit,
  })
  await notifyManagers(
    tx,
    {
      locationId: o.locationId,
      kind: 'identity.number_reassigned',
      title: `Number reassigned: ${old.full_name}`,
      body:
        `${maskPhone(o.phone)} had not been used by ${old.full_name} for a long time (or bounced as invalid), and someone who verified ` +
        `only that number booked as ${r.customer.fullName}. The number now belongs to the new client; ${old.full_name}'s record keeps ` +
        'its history without a phone. If it is the same person, merge the two records.',
      entityType: 'customer',
      entityId: old.id,
    },
    d,
  )
  return { customerId: id, created: true, reassignedFrom: old.id }
}
