// The welcome flow's provisional client (ADR 0160, design section 0, owner 2026-10-11). The first text the gate admits from a number
// with no client creates the client at once, so staff see the thread from the start: name placeholder "New texter ••NNNN" (the
// number's last four digits), source inbound_sms, consent inbound_text (transactional only: never marketing), needs_details. The
// assistant fills the name later (set_my_name). A provisional client that never gives a name and never books is archived 30 days
// after its last text: soft-deleted with archived_at (never deleted; the thread is kept for retention; reversible), and restored when
// the number texts again, unless the stale-record rule holds it (identity/stale.ts; W4c re-review M1): a number quiet that long may
// have changed hands, so the text makes a NEW provisional client and the archived record stays archived, loses the number and is
// flagged "number reassigned" for staff (phone_reassigned_at / _to), exactly as identity/rebind.ts does for a live record.
import { sql } from 'kysely'
import type { Db, Executor, Tx } from '../../../platform/db.js'
import type { NewId } from '../../../platform/ids.js'
import * as audit from '../../../platform/audit.js'
import { formatPhoneDisplay, maskPhone } from '../../../platform/phone.js'
import { AI_ACTOR_NAME } from '../contract.js'
import { revokeIdentity } from '../../identity/revoke.js'
import { staleRecord } from '../../identity/stale.js'
import { closeLead } from '../../leads/service.js'
import './schema.js'

export const PROVISIONAL_PREFIX = 'New texter ••'
export const ARCHIVE_AFTER_DAYS = 30
const DAY = 86_400_000

/** "New texter ••0142". */
export const provisionalName = (phone: string): string => `${PROVISIONAL_PREFIX}${phone.replace(/\D/g, '').slice(-4)}`

/** The name is still the welcome flow's placeholder. */
export const isProvisionalName = (name: string): boolean => name.startsWith(PROVISIONAL_PREFIX)

/**
 * The client is the welcome flow's provisional record (W3a's TurnIdentity.provisional reads this): created from a text, no name yet.
 * A client staff created or edited (needs_details cleared, a real name) is never provisional.
 */
export const isProvisional = (c: { source: string; needsDetails: boolean; fullName: string }): boolean =>
  c.source === 'inbound_sms' && c.needsDetails && isProvisionalName(c.fullName)

export async function isProvisionalClient(db: Executor, customerId: string): Promise<boolean> {
  const c = await db
    .selectFrom('customers')
    .select(['source', 'needs_details', 'full_name'])
    .where('id', '=', customerId)
    .where('deleted_at', 'is', null)
    .where('merged_into', 'is', null)
    .executeTakeFirst()
  return !!c && isProvisional({ source: c.source, needsDetails: c.needs_details, fullName: c.full_name })
}

/** Creates the provisional client of a number (or returns the number's live owner when one exists already). */
export async function createProvisionalClient(
  tx: Tx,
  o: { newId: NewId; locationId: string; phone: string; at: Date; optedOut: boolean },
): Promise<{ customerId: string; created: boolean; restored: boolean }> {
  const archived = await restoreArchivedClient(tx, { locationId: o.locationId, phone: o.phone, at: o.at })
  if (archived?.restored) return { customerId: archived.id, created: false, restored: true }
  const id = o.newId()
  const inserted = await tx
    .insertInto('customers')
    .values({
      id,
      full_name: provisionalName(o.phone),
      phone_e164: o.phone,
      phone_display: formatPhoneDisplay(o.phone),
      email: null,
      notes: null,
      source: 'inbound_sms',
      synthetic: false,
      needs_details: true,
      // their own text is the consent of a transactional-only kind (never marketing; design section 1 "Consent")
      ...(o.optedOut ? {} : { sms_opted_in: true, sms_opt_in_source: 'inbound_text' as const, sms_opt_in_at: o.at }),
    })
    .onConflict((oc) =>
      oc.column('phone_e164').where('phone_e164', 'is not', null).where('merged_into', 'is', null).where('deleted_at', 'is', null).doNothing(),
    )
    .returning('id')
    .executeTakeFirst()
  if (!inserted) {
    // another text of the same number created the client first (or staff did): theirs is the client
    const owner = await tx
      .selectFrom('customers')
      .select('id')
      .where('phone_e164', '=', o.phone)
      .where('merged_into', 'is', null)
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow()
    return { customerId: owner.id, created: false, restored: false }
  }
  await audit.record(tx, {
    locationId: o.locationId,
    action: 'assistant.client.created',
    entityType: 'customer',
    entityId: id,
    after: { name: provisionalName(o.phone), source: 'inbound_sms', consent: o.optedOut ? null : 'inbound_text', provisional: true },
    ctx: { actor: { name: AI_ACTOR_NAME } },
  })
  if (archived) await flagReassigned(tx, { locationId: o.locationId, phone: o.phone, from: archived.id, to: id, at: o.at })
  return { customerId: id, created: true, restored: false }
}

/**
 * A returning texter's archived provisional record comes back (only while nobody else holds the number): `{id, restored: true}`. The
 * stale-record rule holding it (W4c re-review M1) leaves it archived: `{id, restored: false}`, and the caller creates a new client
 * and flags the old one (flagReassigned). Null when the number has no archived record (or a live owner).
 */
export async function restoreArchivedClient(tx: Tx, o: { locationId: string; phone: string; at: Date }): Promise<{ id: string; restored: boolean } | null> {
  const owner = await tx
    .selectFrom('customers')
    .select('id')
    .where('phone_e164', '=', o.phone)
    .where('merged_into', 'is', null)
    .where('deleted_at', 'is', null)
    .executeTakeFirst()
  if (owner) return null
  const row = await tx
    .selectFrom('customers')
    .select('id')
    .where('phone_e164', '=', o.phone)
    .where('archived_at', 'is not', null)
    .where('merged_into', 'is', null)
    .orderBy('archived_at', 'desc')
    .limit(1)
    .forUpdate()
    .executeTakeFirst()
  if (!row) return null
  if ((await staleRecord(tx, { locationId: o.locationId, customerId: row.id, phone: o.phone, now: o.at })).stale) return { id: row.id, restored: false }
  await tx
    .updateTable('customers')
    .set((eb) => ({ deleted_at: null, archived_at: null, version: eb('version', '+', 1), updated_at: o.at }))
    .where('id', '=', row.id)
    .execute()
  await audit.record(tx, {
    locationId: o.locationId,
    action: 'assistant.client.restored',
    entityType: 'customer',
    entityId: row.id,
    before: { archived: true },
    after: { archived: false },
    ctx: { actor: { name: AI_ACTOR_NAME } },
  })
  return { id: row.id, restored: true }
}

/**
 * The archived record `from` the stale-record rule holds stays archived and loses the number to the new client `to` (a phone change:
 * its links, sessions, trust and pending action end), flagged phone_reassigned_at / _to for staff (the staff view's numberReassigned)
 * and audited customer.phone_reassigned. No manager notice: nobody gave that record a name or booked on it.
 */
async function flagReassigned(tx: Tx, o: { locationId: string; phone: string; from: string; to: string; at: Date }): Promise<void> {
  await tx
    .updateTable('customers')
    .set((eb) => ({
      phone_e164: null,
      phone_display: null,
      phone_version: eb('phone_version', '+', 1),
      phone_reassigned_at: o.at,
      phone_reassigned_to: o.to,
      version: eb('version', '+', 1),
      updated_at: o.at,
    }))
    .where('id', '=', o.from)
    .execute()
  const revoked = await revokeIdentity(tx, { locationId: o.locationId, customerId: o.from, reason: 'phone_change', now: o.at })
  await audit.record(tx, {
    locationId: o.locationId,
    action: 'customer.phone_reassigned',
    entityType: 'customer',
    entityId: o.from,
    before: { phone: maskPhone(o.phone), archived: true },
    after: { phone: null, reassignedTo: o.to, revoked: { ...revoked } },
    ctx: { actor: { name: AI_ACTOR_NAME } },
  })
}

export interface ArchiveReport {
  archived: number
}

/**
 * Archives the provisional clients that never gave a name and never booked, 30 days after their last text (or their creation): the
 * row is soft-deleted (deleted_at) and marked archived_at, the open lead of the number is closed, and an audit row records it. The
 * messages and the thread stay. Safe to repeat: an archived row is no longer live.
 */
export async function archiveStaleProvisionalClients(db: Db, o: { now: Date }): Promise<ArchiveReport> {
  const cutoff = new Date(o.now.getTime() - ARCHIVE_AFTER_DAYS * DAY)
  const candidates = await sql<{ id: string; phone_e164: string | null; full_name: string }>`
    select c.id, c.phone_e164, c.full_name from customers c
    where c.source = 'inbound_sms' and c.needs_details and c.deleted_at is null and c.merged_into is null
      and c.full_name like ${`${PROVISIONAL_PREFIX}%`}
      and c.created_at <= ${cutoff}
      and not exists (select 1 from appointments a where a.customer_id = c.id)
      and not exists (select 1 from memberships m where m.customer_id = c.id)
      and coalesce((select max(i.received_at) from sms_inbox i where i.from_e164 = c.phone_e164), c.created_at) <= ${cutoff}
    order by c.created_at, c.id
    limit 500`.execute(db)
  let archived = 0
  for (const c of candidates.rows) {
    const done = await db.transaction().execute((tx) => archiveOne(tx, c, o.now))
    if (done) archived += 1
  }
  return { archived }
}

async function archiveOne(tx: Tx, c: { id: string; phone_e164: string | null }, now: Date): Promise<boolean> {
  const r = await tx
    .updateTable('customers')
    .set((eb) => ({ deleted_at: now, archived_at: now, version: eb('version', '+', 1), updated_at: now }))
    .where('id', '=', c.id)
    .where('deleted_at', 'is', null)
    .where('needs_details', '=', true)
    .where((eb) => eb.not(eb.exists(eb.selectFrom('appointments').select('id').where('customer_id', '=', c.id))))
    .executeTakeFirst()
  if (Number(r.numUpdatedRows) === 0) return false
  const locations = await tx.selectFrom('locations').select('id').execute()
  for (const loc of locations) {
    if (c.phone_e164) await closeLead(tx, { locationId: loc.id, phone: c.phone_e164, at: now })
  }
  const loc = locations[0]
  if (loc)
    await audit.record(tx, {
      locationId: loc.id,
      action: 'assistant.client.archived',
      entityType: 'customer',
      entityId: c.id,
      before: { archived: false },
      after: { archived: true, reason: `no name and no booking ${ARCHIVE_AFTER_DAYS} days after the last text` },
      ctx: { actor: { name: AI_ACTOR_NAME } },
    })
  return true
}
