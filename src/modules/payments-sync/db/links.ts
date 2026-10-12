// Squarespace contact -> Oasis customer links (sqsp_customer_links): unambiguous email first, then phone. A contact that
// matches more than one customer links nobody (a person decides); a manual link is never overwritten by a sync. The phone of a
// record the stale-record rule holds links nothing (identity/stale.ts: numbers are recycled; W4c re-review 2, N1): the contact
// stays unlinked and is tried again on the next run. Nor does the phone or an unverified email of a record that already has ANOTHER
// Squarespace customer (linked, on a membership row, or paid on the record; W4c re-review 4, E2): a member normally has one account,
// and a second one using their number may be the number's new holder. The contact stays unlinked, and the membership sync sends its
// orders to "needs a customer" with an alert. A staff (manual) link always wins and is never overwritten (E1).
import { sql } from 'kysely'
import type { Clock } from '../../../platform/clock.js'
import type { Executor } from '../../../platform/db.js'
import { staleRecord } from '../../identity/stale.js'
import { normalizeEmail, normalizePhone } from '../identity.js'

export interface LinkResult {
  linked: number
  ambiguous: number
  unmatched: number
}

export async function linkContacts(
  db: Executor,
  d: { locationId: string; clock: Clock },
): Promise<LinkResult> {
  const pending = await sql<{ sqsp_contact_id: string; email: string | null; phone: string | null }>`
    select c.sqsp_contact_id, c.email, c.phone
    from sqsp_contacts c
    where c.location_id = ${d.locationId}
      and not exists (select 1 from sqsp_customer_links l where l.location_id = c.location_id and l.sqsp_customer_id = c.sqsp_contact_id)`.execute(
    db,
  )
  const out: LinkResult = { linked: 0, ambiguous: 0, unmatched: 0 }
  for (const c of pending.rows) {
    const email = normalizeEmail(c.email)
    const phone = normalizePhone(c.phone)
    let hit: { id: string; source: 'email' | 'phone' } | 'ambiguous' | undefined
    for (const source of ['email', 'phone'] as const) {
      const value = source === 'email' ? email : phone
      if (!value) continue
      let q = db
        .selectFrom('customers')
        .select('id')
        .where('merged_into', 'is', null)
        .where('deleted_at', 'is', null)
      q = source === 'email' ? q.where('email', '=', value) : q.where('phone_e164', '=', value)
      const rows = await q.select('email_verified').limit(2).execute()
      if (rows.length === 1) {
        const row = rows[0]!
        const stale =
          source === 'phone' && (await staleRecord(db, { locationId: d.locationId, customerId: row.id, phone: value, now: d.clock.now() })).stale
        const weak = source === 'phone' || !row.email_verified
        if (!stale && !(weak && (await hasOtherAccount(db, d.locationId, row.id, c.sqsp_contact_id)))) hit = { id: row.id, source }
        break
      }
      if (rows.length > 1) {
        hit = 'ambiguous'
        break
      }
    }
    if (hit === 'ambiguous') out.ambiguous++
    else if (!hit) out.unmatched++
    else {
      await db
        .insertInto('sqsp_customer_links')
        .values({
          location_id: d.locationId,
          sqsp_customer_id: c.sqsp_contact_id,
          customer_id: hit.id,
          source: hit.source,
          created_at: d.clock.now(),
        })
        .onConflict((oc) => oc.columns(['location_id', 'sqsp_customer_id']).doNothing())
        .execute()
      out.linked++
    }
  }
  return out
}

/** Squarespace payment states of an order whose money was taken (a refund after it included). */
const PAID_STATES = ['PAID', 'PARTIALLY_PAID', 'REFUND_PENDING', 'REFUND_FAILED', 'REFUNDED']

/**
 * The client already has a Squarespace customer other than `sqspCustomerId` (W4c re-review 4, E2): linked to them (any source), on
 * a membership row of theirs, or on a paid order linked to their record; one staff linked to another client by hand is not theirs
 * (E1).
 */
export async function hasOtherAccount(db: Executor, locationId: string, customerId: string, sqspCustomerId: string): Promise<boolean> {
  const r = await sql<{ one: number }>`
    select 1 as one from (
      select l.sqsp_customer_id as s from sqsp_customer_links l where l.location_id = ${locationId} and l.customer_id = ${customerId}
      union
      select m.sqsp_customer_id from memberships m
        where m.location_id = ${locationId} and m.customer_id = ${customerId} and m.sqsp_customer_id is not null
      union
      select o.sqsp_customer_id from sqsp_orders o
        where o.location_id = ${locationId} and o.customer_id = ${customerId} and o.sqsp_customer_id is not null
          and o.payment_state = any(${PAID_STATES}::text[])
    ) x
    where x.s <> ${sqspCustomerId}
      and not exists (select 1 from sqsp_customer_links m where m.location_id = ${locationId} and m.sqsp_customer_id = x.s
                        and m.source = 'manual' and m.customer_id <> ${customerId})
    limit 1`.execute(db)
  return r.rows.length > 0
}

/** A person links a Squarespace customer id to an Oasis customer (replaces an automatic link). */
export async function setManualLink(
  db: Executor,
  d: { locationId: string; clock: Clock },
  o: { sqspCustomerId: string; customerId: string; userId: string | null },
): Promise<void> {
  const v = {
    customer_id: o.customerId,
    source: 'manual' as const,
    linked_by: o.userId,
    created_at: d.clock.now(),
  }
  await db
    .insertInto('sqsp_customer_links')
    .values({ location_id: d.locationId, sqsp_customer_id: o.sqspCustomerId, ...v })
    .onConflict((oc) => oc.columns(['location_id', 'sqsp_customer_id']).doUpdateSet(v))
    .execute()
}
