// Membership checkouts over real Postgres and the Squarespace simulator (ADR 0160, design section 5): a personal-link checkout
// intent links its order first and activates the pending membership; an order matching a client only through an unverified email
// waits for staff (awaiting_match, notice, alert) who match or reject it over the API; a verified email links; a contact linked by
// an unverified email is no way around it; a duplicate paid order is flagged once; open intents expire, pending web memberships
// are closed after 7 days; and an email change drops email_verified.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { createPermissiveAuthorizer } from '../../src/http/authorizer.js'
import { apiModules } from '../../src/http/modules.js'
import {
  CHECKOUT_ABANDONED,
  openCheckoutIntent,
  sweepCheckouts,
} from '../../src/modules/memberships/checkouts.js'
import { runMembershipPass } from '../../src/modules/memberships/jobs.js'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { replaceProductRows } from '../../src/modules/payments-sync/db/product-map.js'
import { ensureDefaultRoles } from '../../src/modules/rbac/repository.js'
import { transaction } from '../../src/platform/db.js'
import { createTestApp } from '../helpers/app.js'
import { makeUser } from '../helpers/factories.js'
import { makeCustomer, setupEnv } from '../payments/helpers.js'
import { D, H, SECRETS_KEY, SIM_KEY, useRig, type Rig } from '../payments-sync-db/harness.js'

const GOLD_URL = 'https://oasis-auto-spa.squarespace.com/checkout/subscribe?itemId=gold'
const item = (sku: string, name: string, productId = `p-${sku}`) => ({ productId, sku, name, unitCents: 9900 })
const SYSTEM = { actor: { name: 'Website (personal link)' } }

describe('membership checkouts', () => {
  const rig = useRig({ pageSize: 50 })

  async function setup(r: Rig) {
    const env = await setupEnv({ db: r.db, clock: r.clock })
    await ensurePlans(r.db, { locationId: r.locationId, clock: r.clock, newId: r.newId })
    await transaction(r.db, (tx) =>
      replaceProductRows(tx, { locationId: r.locationId, clock: r.clock, newId: r.newId }, [
        { sku: 'MEM-GOLD', kind: 'membership', plan: 'premium', planLabel: 'Gold' },
        { sku: 'MEM-VIP', kind: 'membership', plan: 'executive', planLabel: 'VIP' },
      ]),
    )
    await r.db.updateTable('membership_plans').set({ checkout_url: GOLD_URL, public_label: 'Gold' }).where('key', '=', 'premium').execute()
    // a manager receives the staff notices
    const roles = await transaction(r.db, (tx) => ensureDefaultRoles(tx, r.newId))
    const manager = await makeUser(r.db, r.newId, { first: 'Gerald' })
    await r.db.insertInto('employee_roles').values({ employee_id: manager.employeeId, role_id: roles.get('super')! }).execute()
    return { env, manager }
  }
  const sync = (r: Rig) => {
    r.advance(60_000)
    return r.rt.syncCycle(r.locationId)
  }
  const pass = (r: Rig) => runMembershipPass(r.db, r.clock, r.locationId, r.env)
  const dctx = (r: Rig) => ({ locationId: r.locationId, clock: r.clock, newId: r.newId })
  const memberOf = (r: Rig, customerId: string) =>
    r.db.selectFrom('memberships').selectAll().where('customer_id', '=', customerId).orderBy('created_at', 'desc').executeTakeFirstOrThrow()
  const checkouts = (r: Rig) =>
    r.db.selectFrom('membership_checkouts').selectAll().orderBy('created_at').orderBy('id').execute()
  const openAlerts = (r: Rig) =>
    r.db.selectFrom('sqsp_alerts').select(['code', 'message', 'sqsp_order_id']).where('resolved_at', 'is', null).orderBy('created_at').execute()
  async function api(r: Rig, userId: string) {
    return createTestApp({
      testDb: r.t,
      modules: apiModules,
      env: { SQSP_PROVIDER: 'live', SQSP_API_KEY: SIM_KEY, SECRETS_KEY },
      authorizer: (l) => createPermissiveAuthorizer({ locationId: l.id, userId }),
    })
  }

  it('a personal-link checkout: pending membership + open intent; its order (another email on file, none verified) links through the intent and activates it', async () => {
    const r = rig()
    const { env } = await setup(r)
    const ana = await makeCustomer(r.db, env, { name: 'Ana Ruiz', email: 'old-ana@example.com', phone: '+12015550188' })
    const started = await transaction(r.db, (tx) =>
      openCheckoutIntent(tx, dctx(r), { customerId: ana, planKey: 'premium', email: ' Ana.Ruiz@Example.com ', linkId: null }, SYSTEM),
    )
    expect(started).toMatchObject({ checkoutUrl: GOLD_URL, membershipCreated: true })
    expect(started.expiresAt.getTime() - r.clock.now().getTime()).toBe(72 * H)
    const pending = await memberOf(r, ana)
    expect(pending).toMatchObject({ id: started.membershipId, status: 'pending', source: 'manual', plan_label: 'Gold', sqsp_product_key: 'MEM-GOLD' })
    // a second start (the client came back) supersedes the first intent and reuses the pending membership
    r.advance(H)
    const again = await transaction(r.db, (tx) =>
      openCheckoutIntent(tx, dctx(r), { customerId: ana, planKey: 'premium', email: 'ana.ruiz@example.com' }, SYSTEM),
    )
    expect(again).toMatchObject({ membershipId: started.membershipId, membershipCreated: false })
    expect((await checkouts(r)).map((c) => [c.state, c.expected_email, c.origin])).toEqual([
      ['superseded', 'ana.ruiz@example.com', 'link'],
      ['open', 'ana.ruiz@example.com', 'link'],
    ])
    // the order carries the confirmed email (not the one on file), another phone, and the plan's product
    r.advance(2 * H)
    const o = r.store.createOrder({ email: 'ana.ruiz@example.com', name: 'Ana R', phone: '9735550100', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    const p = await pass(r)
    expect(p.sync).toMatchObject({ intentsMatched: 1, updated: 1, needsCustomer: 0, awaitingMatch: 0 })
    const active = await memberOf(r, ana)
    expect(active).toMatchObject({ id: started.membershipId, status: 'active', source: 'squarespace', last_sqsp_order_id: o.orderId })
    const rows = await checkouts(r)
    expect(rows[1]).toMatchObject({ state: 'matched' })
    expect(rows[1]!.matched_order_id).not.toBeNull()
    expect(await openAlerts(r)).toEqual([])
    // the renewal a month later (same email and product) follows the matched intent
    r.advance(31 * D)
    r.store.createOrder({ email: 'ana.ruiz@example.com', name: 'Ana R', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    await pass(r)
    expect(await memberOf(r, ana)).toMatchObject({ status: 'active', paid_order_count: 2 })
    // a member cannot start another checkout
    await expect(
      transaction(r.db, (tx) => openCheckoutIntent(tx, dctx(r), { customerId: ana, planKey: 'premium', email: 'a@example.com' }, SYSTEM)),
    ).rejects.toMatchObject({ code: 'MEMBERSHIP_EXISTS' })
  })

  it('a plan without a checkout URL cannot start a checkout', async () => {
    const r = rig()
    const { env } = await setup(r)
    const c = await makeCustomer(r.db, env, { name: 'No Url' })
    await expect(
      transaction(r.db, (tx) => openCheckoutIntent(tx, dctx(r), { customerId: c, planKey: 'executive', email: 'x@example.com' }, SYSTEM)),
    ).rejects.toMatchObject({ code: 'MEMBERSHIP_CHECKOUT_UNAVAILABLE' })
  })

  it('an order matching only an unverified email waits for staff (row, notice, alert, once); staff match it and the membership activates', async () => {
    const r = rig()
    const { env, manager } = await setup(r)
    const ana = await makeCustomer(r.db, env, { name: 'Ana Ruiz', email: 'ana@example.com', phone: '+12015550188' })
    const o = r.store.createOrder({ email: 'ana@example.com', name: 'Ana Ruiz', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    const p = await pass(r)
    expect(p.sync).toMatchObject({ awaitingMatch: 1, needsCustomer: 0, created: 0 })
    const waiting = await memberOf(r, ana)
    expect(waiting).toMatchObject({ status: 'pending', source: 'squarespace', plan_label: 'Gold', paid_order_count: 0 })
    const [row] = await checkouts(r)
    expect(row).toMatchObject({ state: 'awaiting_match', origin: 'sync', membership_id: waiting.id, customer_id: ana, expected_email: 'ana@example.com', checkout_url: null })
    const notices = await r.db.selectFrom('notifications').select(['kind', 'title', 'body', 'employee_id']).execute()
    expect(notices).toEqual([
      expect.objectContaining({ kind: 'membership.awaiting_match', title: 'Confirm Ana’s membership payment', employee_id: manager.employeeId }),
    ])
    expect(notices[0]!.body).toContain('only through an email nobody verified')
    expect((await openAlerts(r)).map((a) => [a.code, a.sqsp_order_id])).toEqual([['membership_awaiting_match', o.orderId]])
    // a second pass changes nothing
    const p2 = await pass(r)
    expect(p2.sync).toMatchObject({ awaitingMatch: 1, created: 0, updated: 0 })
    expect(await checkouts(r)).toHaveLength(1)
    expect(await r.db.selectFrom('notifications').select('id').execute()).toHaveLength(1)
    // the membership view shows the waiting checkout
    const app = await api(r, manager.userId)
    const view = (await app.app.inject({ method: 'GET', url: `/api/v1/customers/${ana}/membership` })).json()
    expect(view.membership.checkout).toMatchObject({ id: row!.id, state: 'awaiting_match', expectedEmail: 'ana@example.com', order: { id: o.orderId } })
    const list = await app.app.inject({ method: 'GET', url: '/api/v1/membership-checkouts?state=awaiting_match' })
    expect(list.statusCode, list.body).toBe(200)
    expect(list.json()).toMatchObject({ awaitingMatch: 1, items: [{ id: row!.id, customer: { id: ana, name: 'Ana Ruiz' }, order: { id: o.orderId, email: 'ana@example.com' } }] })
    // staff confirmed with Ana: the pass runs at once and links the order through the matched row
    const res = await app.app.inject({ method: 'POST', url: `/api/v1/membership-checkouts/${row!.id}/match`, payload: { note: 'Called Ana' } })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ checkout: { state: 'matched' }, membership: { id: waiting.id, status: 'active', checkout: null } })
    expect(await openAlerts(r)).toEqual([])
    const audits = await r.db.selectFrom('audit_log').select('action').where('entity_id', '=', waiting.id).execute()
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(['membership.checkout.awaiting_match', 'membership.checkout.confirmed', 'membership.synced']),
    )
    // only a waiting row can be decided
    const twice = await app.app.inject({ method: 'POST', url: `/api/v1/membership-checkouts/${row!.id}/reject`, payload: {} })
    expect(twice.statusCode).toBe(409)
    expect(twice.json()).toMatchObject({ code: 'MEMBERSHIP_CHECKOUT_NOT_WAITING' })
    await app.close()
  })

  it('a rejected waiting order goes back to "needs a customer", and the pending membership the sync opened for it is canceled', async () => {
    const r = rig()
    const { env, manager } = await setup(r)
    const ana = await makeCustomer(r.db, env, { name: 'Ana Ruiz', email: 'ana@example.com' })
    r.store.createOrder({ email: 'ana@example.com', name: 'Someone Else', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    await pass(r)
    const [row] = await checkouts(r)
    const app = await api(r, manager.userId)
    const res = await app.app.inject({ method: 'POST', url: `/api/v1/membership-checkouts/${row!.id}/reject`, payload: { note: 'Not Ana' } })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ checkout: { state: 'rejected' }, membership: { status: 'canceled' } })
    const p = await pass(r)
    expect(p.sync).toMatchObject({ needsCustomer: 1, awaitingMatch: 0 })
    expect((await openAlerts(r)).map((a) => a.code)).toEqual(['membership_needs_customer'])
    expect(await checkouts(r)).toHaveLength(1)
    expect((await memberOf(r, ana)).status).toBe('canceled')
    await app.close()
  })

  it('a verified email links directly; a contact the sync linked by an unverified email does not', async () => {
    const r = rig()
    const { env } = await setup(r)
    const vera = await makeCustomer(r.db, env, { name: 'Vera Verified', email: 'vera@example.com' })
    await sql`update customers set email_verified = true where id = ${vera}`.execute(r.db)
    const una = await makeCustomer(r.db, env, { name: 'Una Unverified', email: 'una@example.com' })
    r.store.createOrder({ email: 'vera@example.com', name: 'Vera', lineItems: [item('MEM-GOLD', 'Gold')] })
    r.store.createOrder({ email: 'una@example.com', name: 'Una', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    // the contacts job links Squarespace contacts by email, verified or not
    await r.rt.syncContacts(r.locationId)
    const links = await r.db.selectFrom('sqsp_customer_links').select(['customer_id', 'source']).execute()
    expect(links).toEqual(expect.arrayContaining([{ customer_id: una, source: 'email' }]))
    const p = await pass(r)
    expect(p.sync).toMatchObject({ created: 1, awaitingMatch: 1 })
    expect(await memberOf(r, vera)).toMatchObject({ status: 'active', source: 'squarespace' })
    expect(await memberOf(r, una)).toMatchObject({ status: 'pending', paid_order_count: 0 })
  })

  it('a second paid order of the same plan while the membership runs is flagged and alerted once, and does not move the renewal date', async () => {
    const r = rig()
    const { env } = await setup(r)
    const bo = await makeCustomer(r.db, env, { name: 'Bo Double', email: 'bo@example.com', phone: '+12015550177' })
    r.store.createOrder({ email: 'bo@example.com', phone: '2015550177', name: 'Bo', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    await pass(r)
    const first = await memberOf(r, bo)
    r.advance(5 * D)
    const dup = r.store.createOrder({ email: 'bo@example.com', phone: '2015550177', name: 'Bo', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    const p = await pass(r)
    expect(p.sync.duplicates).toBe(1)
    const m = await memberOf(r, bo)
    expect(m.current_period_end).toEqual(first.current_period_end)
    expect((m.review_flags as { code: string; orderId?: string }[]).filter((f) => f.code === 'duplicate_payment')).toEqual([
      expect.objectContaining({ orderId: dup.orderId }),
    ])
    expect((await openAlerts(r)).map((a) => [a.code, a.sqsp_order_id])).toEqual([['membership_duplicate_payment', dup.orderId]])
    // staff resolve the alert: the next pass does not raise it again
    await r.db.updateTable('sqsp_alerts').set({ resolved_at: r.clock.now() }).execute()
    expect((await pass(r)).sync.duplicates).toBe(0)
    expect(await openAlerts(r)).toEqual([])
  })

  it('the sweep: open intents expire after 72 h; a pending web membership with no paid order is closed after 7 days; nothing else moves; twice is once', async () => {
    const r = rig()
    const { env } = await setup(r)
    // nothing to do: nothing happens
    expect(await sweepCheckouts(r.db, dctx(r))).toEqual({ expired: 0, abandoned: 0 })
    const ana = await makeCustomer(r.db, env, { name: 'Ana Ruiz' })
    const started = await transaction(r.db, (tx) =>
      openCheckoutIntent(tx, dctx(r), { customerId: ana, planKey: 'premium', email: 'ana@example.com' }, SYSTEM),
    )
    // a website join (POST /public/memberships) leaves the same kind of pending membership, without an intent
    const web = await makeCustomer(r.db, env, { name: 'Web Joiner' })
    const webId = r.newId()
    await r.db
      .insertInto('memberships')
      .values({
        id: webId,
        location_id: r.locationId,
        customer_id: web,
        plan_id: (await r.db.selectFrom('membership_plans').select('id').where('key', '=', 'premium').executeTakeFirstOrThrow()).id,
        plan_label: 'Gold',
        status: 'pending',
        source: 'manual',
        started_at: r.clock.now(),
      })
      .execute()
    // an order waiting for staff keeps its pending membership
    const una = await makeCustomer(r.db, env, { name: 'Una Waiting', email: 'una@example.com' })
    r.store.createOrder({ email: 'una@example.com', name: 'Una', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    await pass(r)

    r.advance(72 * H - 2 * 60_000)
    expect(await sweepCheckouts(r.db, dctx(r))).toEqual({ expired: 0, abandoned: 0 })
    r.advance(2 * 60_000)
    expect(await sweepCheckouts(r.db, dctx(r))).toEqual({ expired: 1, abandoned: 0 })
    expect((await checkouts(r)).find((c) => c.id === started.checkoutId)!.state).toBe('expired')

    r.advance(4 * D)
    const swept = await sweepCheckouts(r.db, dctx(r))
    expect(swept).toEqual({ expired: 0, abandoned: 2 })
    for (const id of [ana, web])
      expect(await memberOf(r, id)).toMatchObject({ status: 'canceled', cancel_reason: CHECKOUT_ABANDONED })
    expect((await checkouts(r)).find((c) => c.id === started.checkoutId)!.state).toBe('abandoned')
    expect(await memberOf(r, una)).toMatchObject({ status: 'pending' })
    const audit = await r.db.selectFrom('audit_log').select(['action', 'actor_name', 'after']).where('entity_id', '=', webId).execute()
    expect(audit).toEqual([expect.objectContaining({ action: 'membership.canceled', actor_name: 'Membership checkouts' })])
    expect(await sweepCheckouts(r.db, dctx(r))).toEqual({ expired: 0, abandoned: 0 })
  })

  it('an email that changes drops email_verified, unless the same update sets it', async () => {
    const r = rig()
    const { env } = await setup(r)
    const c = await makeCustomer(r.db, env, { name: 'Eve Email', email: 'eve@example.com' })
    const flag = async () =>
      (await r.db.selectFrom('customers').select('email_verified').where('id', '=', c).executeTakeFirstOrThrow()).email_verified
    await sql`update customers set email_verified = true where id = ${c}`.execute(r.db)
    await sql`update customers set email = 'EVE@example.com' where id = ${c}`.execute(r.db)
    expect(await flag()).toBe(true)
    await sql`update customers set full_name = 'Eve E.', email = email where id = ${c}`.execute(r.db)
    expect(await flag()).toBe(true)
    await sql`update customers set email = 'eve.new@example.com' where id = ${c}`.execute(r.db)
    expect(await flag()).toBe(false)
    await sql`update customers set email = 'eve.page@example.com', email_verified = true where id = ${c}`.execute(r.db)
    expect(await flag()).toBe(true)
  })
})
