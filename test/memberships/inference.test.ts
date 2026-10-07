// Membership inference over real Postgres and the simulator: orders become members, status follows the paid period, grace and
// the lagged cancellation, refunds flag instead of cancelling, people are linked by Squarespace id, email then phone, and a hand
// edit holds until a newer paid order arrives.
import { describe, expect, it } from 'vitest'
import { createPermissiveAuthorizer } from '../../src/http/authorizer.js'
import { apiModules } from '../../src/http/modules.js'
import { runMembershipPass } from '../../src/modules/memberships/jobs.js'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { patchMembership } from '../../src/modules/memberships/service.js'
import { replaceProductRows } from '../../src/modules/payments-sync/db/product-map.js'
import { transaction } from '../../src/platform/db.js'
import { createTestApp } from '../helpers/app.js'
import { makeUser } from '../helpers/factories.js'
import { makeCustomer, setupEnv } from '../payments/helpers.js'
import { D, H, SECRETS_KEY, SIM_KEY, useRig, type Rig } from '../payments-sync-db/harness.js'

const SKUS = [
  { sku: 'MEM-ESS', kind: 'membership', plan: 'essential' },
  { sku: 'MEM-PREM', kind: 'membership', plan: 'premium', planLabel: 'Premium Care' },
  { sku: 'MEM-EXEC', kind: 'membership', plan: 'executive' },
] as const

const item = (sku: string, name: string) => ({ productId: `p-${sku}`, sku, name, unitCents: 14900 })

describe('membership inference from subscription orders', () => {
  const rig = useRig({ pageSize: 50 })

  async function setup(r: Rig) {
    const env = await setupEnv({ db: r.db, clock: r.clock })
    await ensurePlans(r.db, { locationId: r.locationId, clock: r.clock, newId: r.newId })
    await transaction(r.db, (tx) =>
      replaceProductRows(tx, { locationId: r.locationId, clock: r.clock, newId: r.newId }, [...SKUS]),
    )
    return env
  }
  // the simulator's window bounds are strict, so an order created in this instant is read by the next poll: move on first
  const sync = (r: Rig) => {
    r.advance(60_000)
    return r.rt.syncCycle(r.locationId)
  }
  const pass = (r: Rig) => runMembershipPass(r.db, r.clock, r.locationId, r.env)
  const member = (r: Rig, customerId: string) =>
    r.db
      .selectFrom('memberships')
      .selectAll()
      .where('customer_id', '=', customerId)
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow()
  const flags = (m: { review_flags: unknown }) => (m.review_flags as { code: string }[]).map((f) => f.code)

  it('active until the paid period ends, active in grace, past_due after it, canceled (lagged, flagged) after 60 more days, active again on a new payment', async () => {
    const r = rig()
    const env = await setup(r)
    const priya = await makeCustomer(r.db, env, {
      name: 'Priya Nair',
      email: 'priya@example.com',
      phone: '+13057783321',
    })
    const t0 = r.clock.now()
    r.store.createOrder({
      email: 'priya@example.com',
      name: 'Priya Nair',
      phone: '3057783321',
      lineItems: [item('MEM-PREM', 'Premium Care')],
      taxCents: 1043,
    })
    await sync(r)
    await pass(r)
    const end = new Date('2026-11-06T14:00:00.000Z') // one calendar month after the paid order
    const rows: [string, Date, string, boolean][] = [
      ['10 days in', new Date(t0.getTime() + 10 * D), 'active', false],
      ['the last paid minute', new Date(end.getTime()), 'active', false],
      ['3 days past the period (inside the 7-day grace)', new Date(end.getTime() + 3 * D), 'active', true],
      ['exactly the end of grace', new Date(end.getTime() + 7 * D), 'active', true],
      ['an hour past grace', new Date(end.getTime() + 7 * D + H), 'past_due', false],
      ['59 days past grace', new Date(end.getTime() + 66 * D), 'past_due', false],
      ['exactly 60 days past grace', new Date(end.getTime() + 67 * D), 'past_due', false],
      ['an hour past the lapse', new Date(end.getTime() + 67 * D + H), 'canceled', false],
    ]
    for (const [label, at, status, inGrace] of rows) {
      r.clock.set(at)
      await pass(r)
      const m = await member(r, priya)
      expect({ label, status: m.status, inGrace: m.in_grace }, label).toEqual({ label, status, inGrace })
    }
    const canceled = await member(r, priya)
    expect(flags(canceled)).toContain('lagged_cancellation')
    expect(canceled.canceled_at).not.toBeNull()
    expect(canceled.cancel_reason).toMatch(/Inferred/)
    expect(canceled.inference_reason).toMatch(/lagged/)
    // a payment arrives after the lapse: the same membership is active again with a new cycle
    r.store.createOrder({
      email: 'priya@example.com',
      name: 'Priya Nair',
      phone: '3057783321',
      lineItems: [item('MEM-PREM', 'Premium Care')],
      taxCents: 1043,
    })
    const again = await sync(r)
    expect(again.status).toBe('ok')
    await pass(r)
    const back = await member(r, priya)
    expect(back.id).toBe(canceled.id)
    expect(back).toMatchObject({ status: 'active', canceled_at: null, paid_order_count: 2 })
    expect(back.current_period_start!.getTime()).toBeGreaterThan(end.getTime())
    expect(
      await r.db.selectFrom('memberships').select('id').where('customer_id', '=', priya).execute(),
    ).toHaveLength(1)
  })

  it('a full refund flags the member for review and never cancels; a partial refund flags and stays paid; nothing paid creates nobody', async () => {
    const r = rig()
    const env = await setup(r)
    const a = await makeCustomer(r.db, env, { name: 'Full Refund', email: 'full@example.com' })
    const b = await makeCustomer(r.db, env, { name: 'Part Refund', email: 'part@example.com' })
    const only = await makeCustomer(r.db, env, { name: 'Only Refunded', email: 'only@example.com' })
    const never = await makeCustomer(r.db, env, { name: 'Never Paid', email: 'never@example.com' })
    // refunded in full before the first sync ever saw it: there is nothing paid, so there is no member
    const n1 = r.store.createOrder({
      email: 'never@example.com',
      name: 'Never Paid',
      lineItems: [item('MEM-ESS', 'Essential')],
    })
    r.store.refund(n1.orderId)
    const a1 = r.store.createOrder({
      email: 'full@example.com',
      name: 'Full Refund',
      lineItems: [item('MEM-ESS', 'Essential')],
    })
    const b1 = r.store.createOrder({
      email: 'part@example.com',
      name: 'Part Refund',
      lineItems: [item('MEM-ESS', 'Essential')],
    })
    const o1 = r.store.createOrder({
      email: 'only@example.com',
      name: 'Only Refunded',
      lineItems: [item('MEM-ESS', 'Essential')],
    })
    await sync(r)
    await pass(r)
    expect((await member(r, a)).status).toBe('active')
    expect(
      await r.db.selectFrom('memberships').select('id').where('customer_id', '=', never).execute(),
    ).toHaveLength(0)
    r.advance(D)
    const a2 = r.store.renewSubscription(a1.orderId)
    r.store.refund(a2.orderId) // the renewal is refunded in full
    r.store.refund(b1.orderId, { amountCents: 2000 })
    r.store.refund(o1.orderId) // the only payment is refunded in full
    await sync(r)
    await pass(r)
    const full = await member(r, a)
    const part = await member(r, b)
    expect(full.status).toBe('active') // the earlier paid order still covers the period
    expect(flags(full)).toContain('full_refund')
    expect(full.paid_order_count).toBe(1)
    expect(part.status).toBe('active')
    expect(flags(part)).toContain('partial_refund')
    // nothing paid is left: pending and flagged for a person, never canceled automatically
    const refunded = await member(r, only)
    expect(refunded.status).toBe('pending')
    expect(flags(refunded)).toContain('full_refund')
    expect(refunded.canceled_at).toBeNull()
    expect(
      await r.db.selectFrom('memberships').select('id').where('customer_id', '=', never).execute(),
    ).toHaveLength(0)
  })

  it('links by Squarespace customer id before email, and by email before phone', async () => {
    const r = rig()
    const env = await setup(r)
    const byEmail = await makeCustomer(r.db, env, {
      name: 'By Email',
      email: 'shared@example.com',
      phone: '+13055550001',
    })
    const byLink = await makeCustomer(r.db, env, {
      name: 'By Link',
      email: 'other@example.com',
      phone: '+13055550002',
    })
    const byPhone = await makeCustomer(r.db, env, {
      name: 'By Phone',
      email: 'nomatch@example.com',
      phone: '+13055550003',
    })
    const o1 = r.store.createOrder({
      email: 'shared@example.com',
      name: 'Shared',
      phone: '3055550099',
      lineItems: [item('MEM-ESS', 'Essential')],
    })
    const o3 = r.store.createOrder({
      email: 'unknown@example.com',
      name: 'Phone Only',
      phone: '3055550003',
      lineItems: [item('MEM-EXEC', 'Executive')],
    })
    await sync(r)
    const stored = await r.db
      .selectFrom('sqsp_orders')
      .select(['sqsp_order_id', 'sqsp_customer_id'])
      .where('sqsp_order_id', '=', o1.orderId)
      .executeTakeFirstOrThrow()
    // the Squarespace customer of the first order is explicitly linked to someone else
    await r.db
      .insertInto('sqsp_customer_links')
      .values({
        location_id: r.locationId,
        sqsp_customer_id: stored.sqsp_customer_id!,
        customer_id: byLink,
        source: 'manual',
      })
      .execute()
    await pass(r)
    expect((await member(r, byLink)).plan_label).toBe('Essential')
    expect(
      await r.db.selectFrom('memberships').select('id').where('customer_id', '=', byEmail).execute(),
    ).toHaveLength(0)
    const phone = await member(r, byPhone)
    expect(phone).toMatchObject({
      plan_label: 'Executive',
      last_sqsp_order_id: o3.orderId,
      status: 'active',
      source: 'squarespace',
    })
    expect(phone.sqsp_subscription_ref).toMatch(
      /^sqsp:unknown@example.com:p-MEM-EXEC$|^sqsp:unknown@example.com:/,
    )
  })

  it('someone who matches no customer raises a membership_needs_customer alert; linking them creates the member and closes it', async () => {
    const r = rig()
    const env = await setup(r)
    const user = await makeUser(r.db, r.newId)
    r.store.createOrder({
      email: 'newbie@example.com',
      name: 'New Bie',
      phone: '3055559999',
      lineItems: [item('MEM-ESS', 'Essential')],
    })
    await sync(r)
    const p = await pass(r)
    expect(p.sync.needsCustomer).toBe(1)
    expect(p.sync.created).toBe(0)
    const open = await r.db
      .selectFrom('sqsp_alerts')
      .select(['code', 'message'])
      .where('resolved_at', 'is', null)
      .execute()
    expect(open.map((a) => a.code)).toEqual(['membership_needs_customer'])
    // re-running does not duplicate the alert
    await pass(r)
    expect(
      await r.db
        .selectFrom('sqsp_alerts')
        .select('id')
        .where('code', '=', 'membership_needs_customer')
        .execute(),
    ).toHaveLength(1)

    const customer = await makeCustomer(r.db, env, { name: 'New Bie', email: null, phone: '+13055550011' })
    const order = await r.db.selectFrom('sqsp_orders').select('sqsp_customer_id').executeTakeFirstOrThrow()
    const app = await createTestApp({
      testDb: r.t,
      modules: apiModules,
      env: { SQSP_PROVIDER: 'live', SQSP_API_KEY: SIM_KEY, SECRETS_KEY },
      authorizer: (l) =>
        createPermissiveAuthorizer({ locationId: l.id, userId: user.userId, employeeId: user.employeeId }),
    })
    const res = await app.app.inject({
      method: 'PUT',
      url: `/api/v1/integrations/squarespace/customer-links/${order.sqsp_customer_id}`,
      payload: { customerId: customer },
    })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ membershipsCreated: 1 })
    expect((await member(r, customer)).status).toBe('active')
    expect(
      await r.db.selectFrom('sqsp_alerts').select('id').where('resolved_at', 'is', null).execute(),
    ).toHaveLength(0)
    await app.close()
  })

  it('an email shared by two customers links nobody and is flagged', async () => {
    const r = rig()
    const env = await setup(r)
    await makeCustomer(r.db, env, { name: 'Twin One', email: 'twin@example.com', phone: '+13055550021' })
    await makeCustomer(r.db, env, { name: 'Twin Two', email: 'twin@example.com', phone: '+13055550022' })
    r.store.createOrder({
      email: 'twin@example.com',
      name: 'Twin',
      lineItems: [item('MEM-ESS', 'Essential')],
    })
    await sync(r)
    const p = await pass(r)
    expect(p.sync).toMatchObject({ created: 0, needsCustomer: 1 })
    expect(await r.db.selectFrom('memberships').select('id').execute()).toHaveLength(0)
  })

  it('a hand edit holds against the inference until a newer paid order arrives', async () => {
    const r = rig()
    const env = await setup(r)
    const user = await makeUser(r.db, r.newId)
    const c = await makeCustomer(r.db, env, { name: 'Held', email: 'held@example.com' })
    r.store.createOrder({
      email: 'held@example.com',
      name: 'Held',
      lineItems: [item('MEM-ESS', 'Essential')],
    })
    await sync(r)
    await pass(r)
    const m = await member(r, c)
    expect(m.status).toBe('active')
    r.advance(H)
    await transaction(r.db, (tx) =>
      patchMembership(
        tx,
        { locationId: r.locationId, clock: r.clock, newId: r.newId },
        m.id,
        { status: 'paused', note: 'on vacation' },
        { userId: user.userId, name: 'Desk', audit: { actor: { userId: user.userId, name: 'Desk' } } },
      ),
    )
    r.advance(D)
    const held = await pass(r)
    expect(held.sync.held).toBeGreaterThanOrEqual(1)
    expect((await member(r, c)).status).toBe('paused')
    // a newer paid order reactivates it
    r.store.createOrder({
      email: 'held@example.com',
      name: 'Held',
      lineItems: [item('MEM-ESS', 'Essential')],
    })
    r.advance(120_000)
    await sync(r)
    await pass(r)
    const after = await member(r, c)
    expect(after.status).toBe('active')
    expect(after.manual_status_at).toBeNull()
  })

  it('a tier change on a later order moves the member to the new plan, flags it and starts that plan’s credits', async () => {
    const r = rig()
    const env = await setup(r)
    const c = await makeCustomer(r.db, env, { name: 'Upgrader', email: 'up@example.com' })
    r.store.createOrder({
      email: 'up@example.com',
      name: 'Upgrader',
      lineItems: [item('MEM-ESS', 'Essential')],
    })
    await sync(r)
    await pass(r)
    expect((await member(r, c)).plan_label).toBe('Essential')
    r.advance(5 * D)
    r.store.createOrder({
      email: 'up@example.com',
      name: 'Upgrader',
      lineItems: [item('MEM-EXEC', 'Executive')],
    })
    await sync(r)
    await pass(r)
    const m = await member(r, c)
    expect(m.plan_label).toBe('Executive')
    expect(flags(m)).toContain('tier_changed')
    const plan = await r.db
      .selectFrom('membership_plans')
      .select('key')
      .where('id', '=', m.plan_id)
      .executeTakeFirstOrThrow()
    expect(plan.key).toBe('executive')
    const grants = await r.db
      .selectFrom('membership_credit_events')
      .select(['rule_id', 'qty'])
      .where('membership_id', '=', m.id)
      .where('cycle_start', '=', m.current_period_start!)
      .where('kind', '=', 'grant')
      .execute()
    expect(grants.map((g) => g.qty).sort()).toEqual([2, null])
  })
})
