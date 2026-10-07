// Squarespace contact -> Oasis customer links (sqsp_customer_links): unambiguous email first, then phone. A contact that
// matches more than one customer links nobody (a person decides); a manual link is never overwritten by a sync.
import { sql } from 'kysely'
import type { Clock } from '../../../platform/clock.js'
import type { Executor } from '../../../platform/db.js'
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
      const rows = await q.limit(2).execute()
      if (rows.length === 1) {
        hit = { id: rows[0]!.id, source }
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

/** A person links a Squarespace customer id to an Oasis customer (replaces an automatic link). */
export async function setManualLink(
  db: Executor,
  d: { locationId: string; clock: Clock },
  o: { sqspCustomerId: string; customerId: string; userId: string | null },
): Promise<void> {
  const v = { customer_id: o.customerId, source: 'manual' as const, linked_by: o.userId, created_at: d.clock.now() }
  await db
    .insertInto('sqsp_customer_links')
    .values({ location_id: d.locationId, sqsp_customer_id: o.sqspCustomerId, ...v })
    .onConflict((oc) => oc.columns(['location_id', 'sqsp_customer_id']).doUpdateSet(v))
    .execute()
}
