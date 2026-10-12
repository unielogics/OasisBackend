// A Squarespace order never reaches a STALE record by its phone (W4c re-review 2, N1; probe M1-N1): numbers are recycled, so the
// stale-record rule (identity/stale.ts) holds a record quiet for 180 days as unknown; a membership order matching it only by phone
// (the order's own phone, or a Squarespace contact linked by phone while the record was stale) or by an email nobody verified is no
// match: the order goes to "needs a customer" for staff and nothing (no membership, no last_paid_at, no awaiting row) is written on
// the stale record, which therefore stays stale. A Squarespace link made while the record was NOT stale, a staff link and a verified
// email keep linking (a real member's renewals). Real Postgres and the Squarespace simulator.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { resolveIdentity } from '../../src/modules/assistant/context.js'
import { staleRecord } from '../../src/modules/identity/stale.js'
import { runMembershipPass } from '../../src/modules/memberships/jobs.js'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { replaceProductRows } from '../../src/modules/payments-sync/db/product-map.js'
import { transaction } from '../../src/platform/db.js'
import { makeCustomer, setupEnv } from '../payments/helpers.js'
import { D, useRig, type Rig } from '../payments-sync-db/harness.js'

const item = (sku: string, name: string) => ({ productId: `p-${sku}`, sku, name, unitCents: 9900 })
const OLGA_PHONE = '+13055550003'

describe('a membership order and a stale record (W4c re-review 2, N1)', () => {
  const rig = useRig({ pageSize: 50 })

  async function setup(r: Rig) {
    const env = await setupEnv({ db: r.db, clock: r.clock })
    await ensurePlans(r.db, { locationId: r.locationId, clock: r.clock, newId: r.newId })
    await transaction(r.db, (tx) =>
      replaceProductRows(tx, { locationId: r.locationId, clock: r.clock, newId: r.newId }, [
        { sku: 'MEM-GOLD', kind: 'membership', plan: 'premium', planLabel: 'Gold' },
        { sku: 'MEM-VIP', kind: 'membership', plan: 'executive', planLabel: 'Executive' },
      ]),
    )
    return env
  }
  /** Olga Previous, on file since 400 days ago and quiet since: the stale rule holds her record. */
  async function olga(r: Rig, env: Awaited<ReturnType<typeof setup>>, o: { email?: string | null; emailVerified?: boolean } = {}) {
    const id = await makeCustomer(r.db, env, { name: 'Olga Previous', phone: OLGA_PHONE, email: o.email ?? null, emailVerified: o.emailVerified ?? false })
    await sql`update customers set created_at = ${new Date(r.clock.now().getTime() - 400 * D)} where id = ${id}`.execute(r.db)
    return id
  }
  const sync = (r: Rig) => {
    r.advance(60_000)
    return r.rt.syncCycle(r.locationId)
  }
  const pass = (r: Rig) => runMembershipPass(r.db, r.clock, r.locationId, r.env)
  const membershipsOf = (r: Rig, customerId: string) =>
    r.db.selectFrom('memberships').select(['status', 'last_paid_at', 'paid_order_count']).where('customer_id', '=', customerId).execute()
  const openAlerts = (r: Rig) =>
    r.db.selectFrom('sqsp_alerts').select(['code', 'message']).where('resolved_at', 'is', null).orderBy('created_at').execute()
  const stale = (r: Rig, customerId: string) =>
    staleRecord(r.db, { locationId: r.locationId, customerId, phone: OLGA_PHONE, now: r.clock.now() })

  it('M1-N1: the new holder of Olga’s number pays as Nora Newholder with that phone: needs a customer, nothing lands on Olga, she stays stale', async () => {
    const r = rig()
    const env = await setup(r)
    const old = await olga(r, env)
    expect((await stale(r, old)).stale).toBe(true)
    r.store.createOrder({ email: 'newholder@example.com', name: 'Nora Newholder', phone: '3055550003', lineItems: [item('MEM-VIP', 'Executive')] })
    await sync(r)
    // the contacts job would link the new Squarespace contact to Olga by its phone: not to a stale record
    await r.rt.syncContacts(r.locationId)
    expect(await r.db.selectFrom('sqsp_customer_links').select(['customer_id', 'source']).where('customer_id', '=', old).execute()).toEqual([])
    const p = await pass(r)
    expect(p.sync).toMatchObject({ created: 0, updated: 0, awaitingMatch: 0, needsCustomer: 1 })
    expect(await membershipsOf(r, old)).toEqual([])
    expect(await r.db.selectFrom('membership_checkouts').select('id').execute()).toEqual([])
    const [alert] = await openAlerts(r)
    expect(alert).toMatchObject({ code: 'membership_needs_customer' })
    expect(alert!.message).toContain('Olga Previous')
    expect(alert!.message).toMatch(/stale/)
    // the probe's checks: the record is still stale and still unknown to the assistant
    expect((await stale(r, old)).stale).toBe(true)
    const who = await resolveIdentity(r.db, { locationId: r.locationId, phone: OLGA_PHONE, customerId: null, now: r.clock.now() })
    expect(who.fullName).toBeNull()
    expect(who.identity.customerId).toBeNull()
    // a second pass (and a second contacts run) changes nothing
    await r.rt.syncContacts(r.locationId)
    expect((await pass(r)).sync).toMatchObject({ created: 0, needsCustomer: 1 })
    expect(await membershipsOf(r, old)).toEqual([])
  })

  it('a Squarespace contact the sync linked by phone WHILE the record was stale links nothing either', async () => {
    const r = rig()
    const env = await setup(r)
    const old = await olga(r, env)
    r.store.createOrder({ email: 'newholder@example.com', name: 'Nora Newholder', phone: '3055550003', lineItems: [item('MEM-VIP', 'Executive')] })
    await sync(r)
    const { sqsp_customer_id } = await r.db.selectFrom('sqsp_orders').select('sqsp_customer_id').executeTakeFirstOrThrow()
    // a link an earlier contacts run made by phone yesterday, when Olga's record was already stale
    await r.db
      .insertInto('sqsp_customer_links')
      .values({ location_id: r.locationId, sqsp_customer_id: sqsp_customer_id!, customer_id: old, source: 'phone', created_at: new Date(r.clock.now().getTime() - D) })
      .execute()
    const p = await pass(r)
    expect(p.sync).toMatchObject({ created: 0, needsCustomer: 1 })
    expect(await membershipsOf(r, old)).toEqual([])
    expect((await stale(r, old)).stale).toBe(true)
  })

  it('an order matching the stale record only by an email nobody verified opens no awaiting row on it: needs a customer', async () => {
    const r = rig()
    const env = await setup(r)
    const old = await olga(r, env, { email: 'olga@example.com' })
    r.store.createOrder({ email: 'olga@example.com', name: 'Olga P', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    const p = await pass(r)
    expect(p.sync).toMatchObject({ created: 0, awaitingMatch: 0, needsCustomer: 1 })
    expect(await membershipsOf(r, old)).toEqual([])
    expect(await r.db.selectFrom('membership_checkouts').select('id').execute()).toEqual([])
    expect((await stale(r, old)).stale).toBe(true)
  })

  it('a real member’s renewal still links: a Squarespace link made while the record was fresh, a staff link, a verified email', async () => {
    const r = rig()
    const env = await setup(r)
    const old = await olga(r, env)
    r.store.createOrder({ email: 'olga.member@example.com', name: 'Olga Previous', phone: '3055550003', lineItems: [item('MEM-VIP', 'Executive')] })
    await sync(r)
    const { sqsp_customer_id } = await r.db.selectFrom('sqsp_orders').select('sqsp_customer_id').executeTakeFirstOrThrow()
    // the contacts job linked her Squarespace customer by phone 390 days ago, ten days after her record was made
    await r.db
      .insertInto('sqsp_customer_links')
      .values({ location_id: r.locationId, sqsp_customer_id: sqsp_customer_id!, customer_id: old, source: 'phone', created_at: new Date(r.clock.now().getTime() - 390 * D) })
      .execute()
    const p = await pass(r)
    expect(p.sync).toMatchObject({ created: 1, needsCustomer: 0 })
    expect(await membershipsOf(r, old)).toEqual([expect.objectContaining({ status: 'active', paid_order_count: 1 })])

    // a staff (manual) link to a stale record links as well
    const r2Old = await makeCustomer(r.db, env, { name: 'Paula Past', phone: '+13055550004' })
    await sql`update customers set created_at = ${new Date(r.clock.now().getTime() - 400 * D)} where id = ${r2Old}`.execute(r.db)
    r.store.createOrder({ email: 'paula@example.com', name: 'Paula Past', phone: '3055550004', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    const paulaSqsp = (await r.db.selectFrom('sqsp_orders').select('sqsp_customer_id').where('customer_email', '=', 'paula@example.com').executeTakeFirstOrThrow()).sqsp_customer_id!
    await r.db.insertInto('sqsp_customer_links').values({ location_id: r.locationId, sqsp_customer_id: paulaSqsp, customer_id: r2Old, source: 'manual', created_at: r.clock.now() }).execute()
    // and a verified email
    const vera = await makeCustomer(r.db, env, { name: 'Vera Old', phone: '+13055550005', email: 'vera@example.com', emailVerified: true })
    await sql`update customers set created_at = ${new Date(r.clock.now().getTime() - 400 * D)} where id = ${vera}`.execute(r.db)
    r.store.createOrder({ email: 'vera@example.com', name: 'Someone', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    const p2 = await pass(r)
    expect(p2.sync).toMatchObject({ created: 2, needsCustomer: 0 })
    expect(await membershipsOf(r, r2Old)).toEqual([expect.objectContaining({ status: 'active' })])
    expect(await membershipsOf(r, vera)).toEqual([expect.objectContaining({ status: 'active' })])
  })

  it('a lapsed member’s own orders, placed before her record went stale, stay hers by phone; the new holder’s later order does not', async () => {
    const r = rig()
    const env = await setup(r)
    const t0 = r.clock.now()
    const lena = await makeCustomer(r.db, env, { name: 'Lena Lapsed', phone: '+13055550006', email: 'lena@example.com' })
    r.store.createOrder({ email: 'lena@example.com', name: 'Lena Lapsed', phone: '3055550006', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    expect((await pass(r)).sync).toMatchObject({ created: 1 })
    // 400 days on: no proof of Lena since her payment, so the rule holds her record; her own order still reads as hers
    r.clock.set(new Date(t0.getTime() + 400 * D))
    expect((await staleRecord(r.db, { locationId: r.locationId, customerId: lena, phone: '+13055550006', now: r.clock.now() })).stale).toBe(true)
    const p = await pass(r)
    expect(p.sync).toMatchObject({ needsCustomer: 0, awaitingMatch: 0 })
    expect(await openAlerts(r)).toEqual([])
    expect(await membershipsOf(r, lena)).toEqual([expect.objectContaining({ status: 'canceled', paid_order_count: 1 })])
    // the number's new holder pays with it: not Lena's
    r.store.createOrder({ email: 'next@example.com', name: 'Ned Next', phone: '3055550006', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    expect((await pass(r)).sync).toMatchObject({ needsCustomer: 1, created: 0 })
    expect(await membershipsOf(r, lena)).toEqual([expect.objectContaining({ status: 'canceled', paid_order_count: 1 })])
  })

  it('a phone match to a record that is NOT stale links as before', async () => {
    const r = rig()
    const env = await setup(r)
    const fresh = await makeCustomer(r.db, env, { name: 'Fran Fresh', phone: OLGA_PHONE })
    r.store.createOrder({ email: 'fran@example.com', name: 'Fran Fresh', phone: '3055550003', lineItems: [item('MEM-VIP', 'Executive')] })
    await sync(r)
    const p = await pass(r)
    expect(p.sync).toMatchObject({ created: 1, needsCustomer: 0 })
    expect(await membershipsOf(r, fresh)).toEqual([expect.objectContaining({ status: 'active' })])
  })
})
