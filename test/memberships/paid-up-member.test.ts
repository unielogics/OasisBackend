// A paid-up member and the stale-record rule (ADR 0160, "W4c re-review 3 fixes" D1 and D2; the re-reviewer's yearly-renewal probe).
// D2: a membership whose paid period covers now (its current_period_end, or the plan's period after last_paid_at, plus 14 days of
// grace) is current proof of the client, so a yearly or 6-month member with no visit is never stale while paid up; a lapsed one
// counts from its last payment as before. D1: a Squarespace customer that already PAID on a client's record (the Squarespace customer
// on their membership row, or on a paid order already linked to the record) is that client: its orders link to the record whatever
// the record's staleness and whatever made the contact link (phone, an email verified or not). A NEW Squarespace customer reaching a
// stale record by its phone or an unverified email still links nothing (N1). Real Postgres and the Squarespace simulator.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { staleRecord } from '../../src/modules/identity/stale.js'
import { runMembershipPass } from '../../src/modules/memberships/jobs.js'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { replaceProductRows } from '../../src/modules/payments-sync/db/product-map.js'
import { transaction } from '../../src/platform/db.js'
import { makeCustomer, setupEnv } from '../payments/helpers.js'
import { D, useRig, type Rig } from '../payments-sync-db/harness.js'

const item = (sku: string, name: string) => ({ productId: `p-${sku}`, sku, name, unitCents: 9900 })
const YARA_PHONE = '+13055550007'
const OLGA_PHONE = '+13055550003'

describe('a paid-up member and the stale-record rule (W4c re-review 3, D1 and D2)', () => {
  const rig = useRig({ pageSize: 50 })

  async function setup(r: Rig) {
    const env = await setupEnv({ db: r.db, clock: r.clock })
    await ensurePlans(r.db, { locationId: r.locationId, clock: r.clock, newId: r.newId })
    await transaction(r.db, (tx) =>
      replaceProductRows(tx, { locationId: r.locationId, clock: r.clock, newId: r.newId }, [
        { sku: 'MEM-GOLD', kind: 'membership', plan: 'premium', planLabel: 'Gold' },
        { sku: 'MEM-GOLD-Y', kind: 'membership', plan: 'premium', planLabel: 'Gold yearly', intervalMonths: 12 },
        { sku: 'MEM-GOLD-6', kind: 'membership', plan: 'premium', planLabel: 'Gold 6m', intervalMonths: 6 },
      ]),
    )
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
      .select(['status', 'last_paid_at', 'paid_order_count', 'current_period_end'])
      .where('customer_id', '=', customerId)
      .execute()
  const openAlerts = (r: Rig) =>
    r.db.selectFrom('sqsp_alerts').select(['code', 'message']).where('resolved_at', 'is', null).orderBy('created_at').execute()
  const verdict = (r: Rig, customerId: string, phone: string) => staleRecord(r.db, { locationId: r.locationId, customerId, phone, now: r.clock.now() })

  /**
   * The probe's Yara Year: on file with an email nobody verified; she buys a plan with her phone (her record is fresh: the phone
   * links), and the contacts job then links her Squarespace contact BY that unverified email. She never comes in.
   */
  async function yara(r: Rig, sku: string, label: string) {
    const env = await setup(r)
    const t0 = r.clock.now()
    const id = await makeCustomer(r.db, env, { name: 'Yara Year', phone: YARA_PHONE, email: 'yara@example.com', emailVerified: false })
    await sql`update customers set created_at = ${t0} where id = ${id}`.execute(r.db)
    const first = r.store.createOrder({ email: 'yara@example.com', name: 'Yara Year', phone: '3055550007', lineItems: [item(sku, label)] })
    await sync(r)
    await r.rt.syncContacts(r.locationId)
    expect((await pass(r)).sync).toMatchObject({ created: 1, needsCustomer: 0 })
    expect(await r.db.selectFrom('sqsp_customer_links').select(['customer_id', 'source']).execute()).toEqual([{ customer_id: id, source: 'email' }])
    return { id, t0, first: first.orderId }
  }

  it('D2 (the re-review probe): a yearly member renews on day 364: still hers, active, no "new holder" alert', async () => {
    const r = rig()
    const y = await yara(r, 'MEM-GOLD-Y', 'Gold yearly')
    // day 300: no visit since she paid, but her paid year runs: she is not stale
    r.clock.set(new Date(y.t0.getTime() + 300 * D))
    expect(await verdict(r, y.id, YARA_PHONE)).toMatchObject({ stale: false, reason: null })
    r.clock.set(new Date(y.t0.getTime() + 364 * D))
    r.store.renewSubscription(y.first, { createdOn: r.clock.now() })
    await sync(r)
    const p = await pass(r)
    expect(p.sync).toMatchObject({ needsCustomer: 0, awaitingMatch: 0 })
    expect(await membershipsOf(r, y.id)).toEqual([expect.objectContaining({ status: 'active', paid_order_count: 2 })])
    expect(await openAlerts(r)).toEqual([])
    // and again a week after her old period ended (inside the grace)
    r.clock.set(new Date(y.t0.getTime() + 372 * D))
    expect((await pass(r)).sync).toMatchObject({ needsCustomer: 0 })
    expect(await membershipsOf(r, y.id)).toEqual([expect.objectContaining({ status: 'active', paid_order_count: 2 })])
    expect((await verdict(r, y.id, YARA_PHONE)).stale).toBe(false)
  })

  it('D2: a 6-month member renews on day 182 (her record would have gone stale on day 180): still hers', async () => {
    const r = rig()
    const y = await yara(r, 'MEM-GOLD-6', 'Gold 6m')
    r.clock.set(new Date(y.t0.getTime() + 182 * D))
    expect((await verdict(r, y.id, YARA_PHONE)).stale).toBe(false)
    r.store.renewSubscription(y.first, { createdOn: r.clock.now() })
    await sync(r)
    expect((await pass(r)).sync).toMatchObject({ needsCustomer: 0, awaitingMatch: 0 })
    expect(await membershipsOf(r, y.id)).toEqual([expect.objectContaining({ status: 'active', paid_order_count: 2 })])
    expect(await openAlerts(r)).toEqual([])
  })

  it('D1: a lapsed yearly member renews late (day 395) from her own Squarespace account: hers, though her record is stale', async () => {
    const r = rig()
    const y = await yara(r, 'MEM-GOLD-Y', 'Gold yearly')
    // her renewal failed; 30 days after her year ended (past the 14 days of grace) the rule holds her record from her last payment
    r.clock.set(new Date(y.t0.getTime() + 395 * D))
    expect(await verdict(r, y.id, YARA_PHONE)).toMatchObject({ stale: true, reason: 'inactive', staleSince: new Date(y.t0.getTime() + 180 * D) })
    r.store.renewSubscription(y.first, { createdOn: r.clock.now() })
    await sync(r)
    const p = await pass(r)
    expect(p.sync).toMatchObject({ needsCustomer: 0, awaitingMatch: 0 })
    expect(await membershipsOf(r, y.id)).toEqual([expect.objectContaining({ status: 'active', paid_order_count: 2 })])
    expect(await openAlerts(r)).toEqual([])
    // the payment is proof of her: the record is current again
    expect((await verdict(r, y.id, YARA_PHONE)).stale).toBe(false)
  })

  it('D1: a Squarespace customer with a paid order already linked to the stale record links its membership order to it', async () => {
    const r = rig()
    const env = await setup(r)
    const olga = await makeCustomer(r.db, env, { name: 'Olga Previous', phone: OLGA_PHONE, email: 'olga@example.com', emailVerified: false })
    await sql`update customers set created_at = ${new Date(r.clock.now().getTime() - 400 * D)} where id = ${olga}`.execute(r.db)
    // a while ago she paid a wash online; the order was linked to her record
    const wash = r.store.createOrder({ email: 'olga@example.com', name: 'Olga Previous', lineItems: [item('WASH', 'Express wash')] })
    await sync(r)
    const linked = await r.db.updateTable('sqsp_orders').set({ customer_id: olga }).where('sqsp_order_id', '=', wash.orderId).executeTakeFirst()
    expect(Number(linked.numUpdatedRows)).toBe(1)
    r.advance(10 * D)
    await r.rt.syncContacts(r.locationId)
    expect((await verdict(r, olga, OLGA_PHONE)).stale).toBe(true)
    // today she buys a membership from the same Squarespace account
    r.store.createOrder({ email: 'olga@example.com', name: 'Olga Previous', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    const p = await pass(r)
    expect(p.sync).toMatchObject({ created: 1, needsCustomer: 0, awaitingMatch: 0 })
    expect(await membershipsOf(r, olga)).toEqual([expect.objectContaining({ status: 'active', paid_order_count: 1 })])
  })

  it('the N1 protection holds: a NEW Squarespace customer paying with a lapsed member’s number links nothing to her stale record', async () => {
    const r = rig()
    const env = await setup(r)
    const t0 = r.clock.now()
    const lena = await makeCustomer(r.db, env, { name: 'Lena Lapsed', phone: OLGA_PHONE, email: 'lena@example.com' })
    await sql`update customers set created_at = ${t0} where id = ${lena}`.execute(r.db)
    r.store.createOrder({ email: 'lena@example.com', name: 'Lena Lapsed', phone: '3055550003', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    expect((await pass(r)).sync).toMatchObject({ created: 1 })
    r.clock.set(new Date(t0.getTime() + 400 * D))
    expect((await verdict(r, lena, OLGA_PHONE)).stale).toBe(true)
    r.store.createOrder({ email: 'nora@example.com', name: 'Nora Newholder', phone: '3055550003', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    await r.rt.syncContacts(r.locationId)
    const p = await pass(r)
    expect(p.sync).toMatchObject({ created: 0, needsCustomer: 1 })
    expect(await membershipsOf(r, lena)).toEqual([expect.objectContaining({ status: 'canceled', paid_order_count: 1 })])
    const [alert] = await openAlerts(r)
    expect(alert).toMatchObject({ code: 'membership_needs_customer' })
    expect((await verdict(r, lena, OLGA_PHONE)).stale).toBe(true)
  })

  describe('D2: what counts as paid up (identity/stale.ts)', () => {
    async function olga(r: Rig) {
      const env = await setup(r)
      const id = await makeCustomer(r.db, env, { name: 'Olga Previous', phone: OLGA_PHONE })
      await sql`update customers set created_at = ${new Date(r.clock.now().getTime() - 400 * D)} where id = ${id}`.execute(r.db)
      return id
    }
    async function member(
      r: Rig,
      customerId: string,
      o: { status: 'active' | 'past_due' | 'paused' | 'canceled'; paidDaysAgo: number | null; endInDays: number | null; manualDaysAgo?: number },
    ) {
      const plan = await r.db.selectFrom('membership_plans').select('id').where('key', '=', 'premium').executeTakeFirstOrThrow()
      const at = (days: number) => new Date(r.clock.now().getTime() + days * D)
      await r.db
        .insertInto('memberships')
        .values({
          id: r.newId(),
          location_id: r.locationId,
          customer_id: customerId,
          plan_id: plan.id,
          plan_label: 'Gold',
          status: o.status,
          source: 'squarespace',
          started_at: at(-400),
          current_period_start: o.endInDays === null ? null : at(o.endInDays - 365),
          current_period_end: o.endInDays === null ? null : at(o.endInDays),
          canceled_at: o.status === 'canceled' ? at(-1) : null,
          last_paid_at: o.paidDaysAgo === null ? null : at(-o.paidDaysAgo),
          paid_order_count: o.paidDaysAgo === null ? 0 : 1,
          manual_status_at: o.manualDaysAgo === undefined ? null : at(-o.manualDaysAgo),
          created_at: at(-400),
          updated_at: at(-400),
        })
        .execute()
    }

    it('a paid period that covers now (or ended less than 14 days ago) is current proof; past the grace the last payment counts', async () => {
      const r = rig()
      const id = await olga(r)
      await member(r, id, { status: 'active', paidDaysAgo: 300, endInDays: 65 })
      expect(await verdict(r, id, OLGA_PHONE)).toMatchObject({ stale: false, reason: null, lastActivityAt: r.clock.now() })
      await r.db.updateTable('memberships').set({ status: 'past_due', current_period_end: new Date(r.clock.now().getTime() - 13 * D) }).execute()
      expect((await verdict(r, id, OLGA_PHONE)).stale).toBe(false)
      await r.db.updateTable('memberships').set({ current_period_end: new Date(r.clock.now().getTime() - 15 * D) }).execute()
      const lastPaid = new Date(r.clock.now().getTime() - 300 * D)
      expect(await verdict(r, id, OLGA_PHONE)).toMatchObject({
        stale: true,
        reason: 'inactive',
        lastActivityAt: lastPaid,
        staleSince: new Date(lastPaid.getTime() + 180 * D),
      })
    })

    it('without a period end, the plan’s period after the last payment decides', async () => {
      const r = rig()
      const id = await olga(r)
      await r.db.updateTable('membership_plans').set({ billing_interval_months: 12 }).where('key', '=', 'premium').execute()
      await member(r, id, { status: 'active', paidDaysAgo: 300, endInDays: null })
      expect((await verdict(r, id, OLGA_PHONE)).stale).toBe(false)
      await r.db.updateTable('membership_plans').set({ billing_interval_months: 1 }).where('key', '=', 'premium').execute()
      expect((await verdict(r, id, OLGA_PHONE)).stale).toBe(true)
    })

    it('a canceled membership, or one nobody paid through Squarespace (a hand-made one), is not paid up', async () => {
      const r = rig()
      const id = await olga(r)
      await member(r, id, { status: 'canceled', paidDaysAgo: 300, endInDays: 65 })
      expect((await verdict(r, id, OLGA_PHONE)).stale).toBe(true)
      const r2 = await olga2(r)
      await member(r, r2, { status: 'active', paidDaysAgo: null, endInDays: 20, manualDaysAgo: 300 })
      expect((await verdict(r, r2, '+13055550008')).stale).toBe(true)
    })

    it('a paid-up member whose number bounced as an invalid number is still held (the number itself is gone)', async () => {
      const r = rig()
      const id = await olga(r)
      await member(r, id, { status: 'active', paidDaysAgo: 30, endInDays: 335 })
      expect((await verdict(r, id, OLGA_PHONE)).stale).toBe(false)
      await r.db
        .insertInto('messages')
        .values({
          id: r.newId(),
          location_id: r.locationId,
          direction: 'out',
          sender_kind: 'system',
          body: 'x',
          status: 'failed',
          peer_e164: OLGA_PHONE,
          error: 'Invalid destination address',
          queued_at: r.clock.now(),
          klass: 'reminder',
        })
        .execute()
      expect(await verdict(r, id, OLGA_PHONE)).toMatchObject({ stale: true, reason: 'invalid_number' })
    })

    async function olga2(r: Rig) {
      const id = r.newId()
      await r.db
        .insertInto('customers')
        .values({ id, full_name: 'Mona Manual', phone_e164: '+13055550008', email: null, email_verified: false, sms_opted_in: true, source: 'import' })
        .execute()
      await sql`update customers set created_at = ${new Date(r.clock.now().getTime() - 400 * D)} where id = ${id}`.execute(r.db)
      return id
    }
  })
})
