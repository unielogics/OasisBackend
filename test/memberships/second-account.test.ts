// Squarespace accounts and the records they pay on (ADR 0160, "W4c re-review 4 fixes" E1-E3; the re-reviewer's attacks A, B, C).
// E1: a staff (manual) link of a Squarespace customer always wins: once staff link it to client B, no other client's record takes
// its orders, though it paid on theirs before (D1's paid-by inference). E2: a Squarespace customer is never tied to a record by its
// PHONE or an UNVERIFIED email when the record already has a DIFFERENT Squarespace customer linked or paid on it (a member normally
// has one account): the contacts job links nothing and its orders go to "needs a customer" with an alert ("a second Squarespace
// account is using <client>'s number"); a first link works as before. E3: a checkout intent refused because another client holds the
// paying Squarespace customer (a family account) raises an alert naming both clients instead of linking silently. Real Postgres and
// the Squarespace simulator.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { openCheckoutIntent } from '../../src/modules/memberships/checkouts.js'
import { runMembershipPass } from '../../src/modules/memberships/jobs.js'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { linkContacts, setManualLink } from '../../src/modules/payments-sync/db/links.js'
import { replaceProductRows } from '../../src/modules/payments-sync/db/product-map.js'
import { transaction } from '../../src/platform/db.js'
import { makeCustomer, setupEnv } from '../payments/helpers.js'
import { D, H, useRig, type Rig } from '../payments-sync-db/harness.js'

const item = (sku: string, name: string) => ({ productId: `p-${sku}`, sku, name, unitCents: 9900 })
const SYSTEM = { actor: { name: 'Website (personal link)' } }
const GOLD_URL = 'https://oasis-auto-spa.squarespace.com/checkout/subscribe?itemId=gold'

describe('Squarespace accounts and the records they pay on (W4c re-review 4, E1-E3)', () => {
  const rig = useRig({ pageSize: 50 })

  async function setup(r: Rig) {
    const env = await setupEnv({ db: r.db, clock: r.clock })
    await ensurePlans(r.db, { locationId: r.locationId, clock: r.clock, newId: r.newId })
    await transaction(r.db, (tx) =>
      replaceProductRows(tx, { locationId: r.locationId, clock: r.clock, newId: r.newId }, [
        { sku: 'MEM-GOLD', kind: 'membership', plan: 'premium', planLabel: 'Gold' },
        { sku: 'MEM-GOLD-Y', kind: 'membership', plan: 'premium', planLabel: 'Gold yearly', intervalMonths: 12 },
      ]),
    )
    await r.db.updateTable('membership_plans').set({ checkout_url: GOLD_URL, public_label: 'Gold' }).where('key', '=', 'premium').execute()
    return env
  }
  const sync = (r: Rig) => {
    r.advance(60_000)
    return r.rt.syncCycle(r.locationId)
  }
  const pass = (r: Rig) => runMembershipPass(r.db, r.clock, r.locationId, r.env)
  const membershipsOf = (r: Rig, customerId: string) =>
    r.db
      .selectFrom('memberships')
      .select(['status', 'paid_order_count', 'last_sqsp_order_id', 'sqsp_customer_id', 'review_flags'])
      .where('customer_id', '=', customerId)
      .execute()
  const openAlerts = (r: Rig) =>
    r.db.selectFrom('sqsp_alerts').select(['code', 'message', 'sqsp_order_id']).where('resolved_at', 'is', null).orderBy('created_at').execute()
  const links = (r: Rig) =>
    r.db.selectFrom('sqsp_customer_links').select(['sqsp_customer_id', 'customer_id', 'source']).orderBy('created_at').execute()
  const sqspCustomerOf = async (r: Rig, orderId: string) =>
    (await r.db.selectFrom('sqsp_orders').select('sqsp_customer_id').where('sqsp_order_id', '=', orderId).executeTakeFirstOrThrow()).sqsp_customer_id!
  const fresh = (r: Rig, id: string) => sql`update customers set created_at = ${r.clock.now()} where id = ${id}`.execute(r.db)

  it('E1 (attack A): staff link a Squarespace customer that paid on Ana’s record to Bea: its orders are Bea’s from then on', async () => {
    const r = rig()
    const env = await setup(r)
    const ana = await makeCustomer(r.db, env, { name: 'Ana First', phone: '+13055550101', email: 'ana@example.com' })
    const bea = await makeCustomer(r.db, env, { name: 'Bea Second', phone: '+13055550102', email: 'bea@example.com' })
    await fresh(r, ana)
    await fresh(r, bea)
    // the first order of the account carries Ana's phone: it linked to her record (a fresh record, by phone)
    const o1 = r.store.createOrder({ email: 'shared@example.com', name: 'Ana First', phone: '3055550101', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    expect((await pass(r)).sync).toMatchObject({ created: 1 })
    const sq = await sqspCustomerOf(r, o1.orderId)
    expect(await membershipsOf(r, ana)).toEqual([expect.objectContaining({ status: 'active', paid_order_count: 1, sqsp_customer_id: sq })])
    // staff decide the account is Bea's (she pays for it)
    await setManualLink(r.db, { locationId: r.locationId, clock: r.clock }, { sqspCustomerId: sq, customerId: bea, userId: null })
    r.advance(31 * D)
    const o2 = r.store.renewSubscription(o1.orderId, { createdOn: r.clock.now() })
    await sync(r)
    const p = await pass(r)
    expect(p.sync).toMatchObject({ needsCustomer: 0, awaitingMatch: 0 })
    expect(await membershipsOf(r, bea)).toEqual([expect.objectContaining({ status: 'active', last_sqsp_order_id: o2.orderId, sqsp_customer_id: sq })])
    // Ana's record keeps its history and takes nothing new
    expect(await membershipsOf(r, ana)).toEqual([expect.objectContaining({ paid_order_count: 1, last_sqsp_order_id: o1.orderId })])
    expect((await openAlerts(r)).map((a) => a.code)).toEqual([])
  })

  /** Pam, a paid-up yearly member: her own Squarespace account (her email, her phone) linked by the contacts job. */
  async function pam(r: Rig) {
    const env = await setup(r)
    const id = await makeCustomer(r.db, env, { name: 'Pam Paid', phone: '+13055550111', email: 'pam@example.com' })
    await fresh(r, id)
    const first = r.store.createOrder({ email: 'pam@example.com', name: 'Pam Paid', phone: '3055550111', lineItems: [item('MEM-GOLD-Y', 'Gold yearly')] })
    await sync(r)
    await r.rt.syncContacts(r.locationId)
    expect((await pass(r)).sync).toMatchObject({ created: 1 })
    const sq = await sqspCustomerOf(r, first.orderId)
    expect(await links(r)).toEqual([{ sqsp_customer_id: sq, customer_id: id, source: 'email' }])
    return { env, id, sq, first: first.orderId }
  }

  it('E2 (attack C): a new holder of a paid-up member’s number opens a NEW Squarespace account: no link, "needs a customer", an alert', async () => {
    const r = rig()
    const p = await pam(r)
    // day 60: carriers recycled Pam's number; Nick checks out with his own email and that number
    r.advance(60 * D)
    const nick = r.store.createOrder({ email: 'nick@example.com', name: 'Nick Newholder', phone: '3055550111', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    const sqNick = await sqspCustomerOf(r, nick.orderId)
    expect(sqNick).not.toBe(p.sq)
    const contacts = await r.rt.syncContacts(r.locationId)
    expect(contacts?.links).toMatchObject({ linked: 0 })
    expect(await links(r)).toEqual([{ sqsp_customer_id: p.sq, customer_id: p.id, source: 'email' }])
    const res = await pass(r)
    expect(res.sync).toMatchObject({ needsCustomer: 1, duplicates: 0, created: 0 })
    // nothing landed on Pam's record: no duplicate payment, no second order
    expect(await membershipsOf(r, p.id)).toEqual([
      expect.objectContaining({ status: 'active', paid_order_count: 1, last_sqsp_order_id: p.first, review_flags: [] }),
    ])
    const alerts = await openAlerts(r)
    expect(alerts.map((a) => a.code)).toEqual(['membership_needs_customer'])
    expect(alerts[0]!.message).toContain("a second Squarespace account is using Pam Paid's number")
    expect(alerts[0]!.message).toContain('the number may have a new holder')
    expect(alerts[0]!.message).toContain(nick.orderId)
    // a second pass, and the contacts job again: still nothing on Pam
    await r.rt.syncContacts(r.locationId)
    expect((await pass(r)).sync).toMatchObject({ needsCustomer: 1, duplicates: 0 })
    expect(await links(r)).toHaveLength(1)
    // Pam's own renewal from her own account (day 363 of her year) is hers as always
    r.clock.set(new Date(r.clock.now().getTime() + 303 * D))
    r.store.renewSubscription(p.first, { createdOn: r.clock.now() })
    await sync(r)
    await pass(r)
    expect(await membershipsOf(r, p.id)).toEqual([expect.objectContaining({ status: 'active', paid_order_count: 2 })])
  })

  it('E2: the contacts job links no second contact by an unverified email either; a verified email still links', async () => {
    const r = rig()
    const p = await pam(r)
    const contact = (id: string, email: string, phone: string | null) =>
      r.db
        .insertInto('sqsp_contacts')
        .values({
          id: r.newId(),
          location_id: r.locationId,
          sqsp_contact_id: id,
          email,
          name: 'Someone',
          phone,
          created_on: r.clock.now(),
          payload_hash: id,
          synced_at: r.clock.now(),
        })
        .execute()
    // a second Squarespace profile with Pam's email (unverified on file) in another letter case, and no phone
    await contact('sq-other-1', 'PAM@example.com', null)
    const d = { locationId: r.locationId, clock: r.clock }
    expect(await linkContacts(r.db, d)).toMatchObject({ linked: 0 })
    expect(await links(r)).toHaveLength(1)
    // once staff verified her email, a contact with it is hers
    await r.db.updateTable('customers').set({ email_verified: true }).where('id', '=', p.id).execute()
    expect(await linkContacts(r.db, d)).toMatchObject({ linked: 1 })
    expect((await links(r)).map((l) => [l.sqsp_customer_id, l.customer_id, l.source])).toEqual([
      [p.sq, p.id, 'email'],
      ['sq-other-1', p.id, 'email'],
    ])
  })

  it('E2: a first link still works: a record with no Squarespace customer yet takes a contact by its phone and its orders', async () => {
    const r = rig()
    const env = await setup(r)
    const fay = await makeCustomer(r.db, env, { name: 'Fay First', phone: '+13055550121', email: null })
    await fresh(r, fay)
    const o = r.store.createOrder({ email: 'fay.sq@example.com', name: 'Fay First', phone: '3055550121', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    await r.rt.syncContacts(r.locationId)
    expect(await links(r)).toEqual([{ sqsp_customer_id: await sqspCustomerOf(r, o.orderId), customer_id: fay, source: 'phone' }])
    expect((await pass(r)).sync).toMatchObject({ created: 1, needsCustomer: 0 })
    expect(await membershipsOf(r, fay)).toEqual([expect.objectContaining({ status: 'active', paid_order_count: 1 })])
  })

  it('E3 (attack B): a daughter’s checkout paid from her lapsed mother’s Squarespace account: an alert names both clients', async () => {
    const r = rig()
    const env = await setup(r)
    const mara = await makeCustomer(r.db, env, { name: 'Mara Mother', phone: '+13055550131', email: 'family@example.com' })
    const dina = await makeCustomer(r.db, env, { name: 'Dina Daughter', phone: '+13055550132', email: 'dina@example.com' })
    await fresh(r, mara)
    await fresh(r, dina)
    const o1 = r.store.createOrder({ email: 'family@example.com', name: 'Mara Mother', phone: '3055550131', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    expect((await pass(r)).sync).toMatchObject({ created: 1 })
    const sq = await sqspCustomerOf(r, o1.orderId)
    // Mara's membership lapsed long ago; Dina starts a checkout on her personal link with the family email and pays from that account
    r.advance(200 * D)
    expect((await pass(r)).sync).toMatchObject({ needsCustomer: 0 })
    await fresh(r, dina)
    const started = await transaction(r.db, (tx) =>
      openCheckoutIntent(
        tx,
        { locationId: r.locationId, clock: r.clock, newId: r.newId },
        { customerId: dina, planKey: 'premium', email: 'family@example.com' },
        SYSTEM,
      ),
    )
    r.advance(H)
    const o2 = r.store.createOrder({ email: 'family@example.com', name: 'Dina Daughter', phone: '3055550132', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    expect(await sqspCustomerOf(r, o2.orderId)).toBe(sq)
    const p = await pass(r)
    expect(p.sync).toMatchObject({ intentsMatched: 0 })
    // the order is still counted on the account's holder (another client's intent never takes it, F1) ...
    expect(await membershipsOf(r, mara)).toEqual([expect.objectContaining({ status: 'active', last_sqsp_order_id: o2.orderId })])
    expect(await membershipsOf(r, dina)).toEqual([expect.objectContaining({ status: 'pending', paid_order_count: 0 })])
    const intent = await r.db.selectFrom('membership_checkouts').select('state').where('id', '=', started.checkoutId).executeTakeFirstOrThrow()
    expect(intent.state).toBe('open')
    // ... but not silently: staff are told whose checkout it was and whose account paid
    const alerts = await openAlerts(r)
    expect(alerts).toEqual([expect.objectContaining({ code: 'membership_intent_conflict', sqsp_order_id: o2.orderId })])
    expect(alerts[0]!.message).toContain("paid from Mara Mother's Squarespace account for Dina Daughter's checkout")
    expect(alerts[0]!.message).toContain('check who it belongs to')
    // raised once: a later pass, even after staff resolved it, does not raise it again
    await r.db.updateTable('sqsp_alerts').set({ resolved_at: r.clock.now() }).execute()
    await pass(r)
    expect(await openAlerts(r)).toEqual([])
  })
})
