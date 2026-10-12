// Membership checkouts over real Postgres and the Squarespace simulator (ADR 0160, design section 5): a personal-link checkout
// intent links its order first and activates the pending membership; an order matching a client only through an unverified email
// waits for staff (awaiting_match, notice, alert) who match or reject it over the API; an intent never takes an order another
// client holds (a legacy member's email-made link, their membership row, their email verified or not) nor binds to it (F1);
// a verified email links; a contact linked by
// an unverified email is no way around it; a duplicate paid order is flagged once; open intents expire, pending web memberships
// are closed after 7 days; and an email change drops email_verified.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { createPermissiveAuthorizer } from '../../src/http/authorizer.js'
import { apiModules } from '../../src/http/modules.js'
import {
  CHECKOUT_ABANDONED,
  loadIntentRefs,
  openCheckoutIntent,
  sweepCheckouts,
} from '../../src/modules/memberships/checkouts.js'
import { runMembershipPass } from '../../src/modules/memberships/jobs.js'
import { createManualMembership, patchMembership } from '../../src/modules/memberships/service.js'
import { setVerifiedEmail } from '../../src/modules/memberships/verified-email.js'
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
    await r.db.updateTable('membership_plans').set({ checkout_url: GOLD_URL, public_label: 'Gold' }).where('key', '=', 'gold').execute()
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
      openCheckoutIntent(tx, dctx(r), { customerId: ana, planKey: 'gold', email: ' Ana.Ruiz@Example.com ', linkId: null }, SYSTEM),
    )
    expect(started).toMatchObject({ checkoutUrl: GOLD_URL, membershipCreated: true })
    expect(started.expiresAt.getTime() - r.clock.now().getTime()).toBe(72 * H)
    const pending = await memberOf(r, ana)
    expect(pending).toMatchObject({ id: started.membershipId, status: 'pending', source: 'manual', plan_label: 'Gold', sqsp_product_key: 'MEM-GOLD' })
    // a second start (the client came back) supersedes the first intent and reuses the pending membership
    r.advance(H)
    const again = await transaction(r.db, (tx) =>
      openCheckoutIntent(tx, dctx(r), { customerId: ana, planKey: 'gold', email: 'ana.ruiz@example.com' }, SYSTEM),
    )
    expect(again).toMatchObject({ membershipId: started.membershipId, membershipCreated: false })
    expect((await checkouts(r)).map((c) => [c.state, c.expected_email, c.origin])).toEqual([
      ['superseded', 'ana.ruiz@example.com', 'link'],
      ['open', 'ana.ruiz@example.com', 'link'],
    ])
    // the order carries the confirmed email (not the one on file), her own phone and name (W4c fixes: another phone or name would wait
    // for staff, see below), and the plan's product
    r.advance(2 * H)
    const o = r.store.createOrder({ email: 'ana.ruiz@example.com', name: 'Ana R', phone: '2015550188', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    const p = await pass(r)
    expect(p.sync).toMatchObject({ intentsMatched: 1, updated: 1, needsCustomer: 0, awaitingMatch: 0 })
    const active = await memberOf(r, ana)
    expect(active).toMatchObject({ id: started.membershipId, status: 'active', source: 'squarespace', last_sqsp_order_id: o.orderId })
    const rows = await checkouts(r)
    expect(rows[1]).toMatchObject({ state: 'matched' })
    expect(rows[1]!.matched_order_id).not.toBeNull()
    expect(await openAlerts(r)).toEqual([])
    // the matched intent carries its order's Squarespace customer: its renewals must come from that customer (F1)
    const bought = await r.db.selectFrom('sqsp_orders').select('sqsp_customer_id').where('sqsp_order_id', '=', o.orderId).executeTakeFirstOrThrow()
    expect(bought.sqsp_customer_id).not.toBeNull()
    expect((await loadIntentRefs(r.db, r.locationId)).find((i) => i.id === rows[1]!.id)).toMatchObject({
      state: 'matched',
      orderId: o.orderId,
      orderSqspCustomerId: bought.sqsp_customer_id,
    })
    // the renewal a month later (same email and product) follows the matched intent
    r.advance(31 * D)
    r.store.createOrder({ email: 'ana.ruiz@example.com', name: 'Ana R', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    await pass(r)
    expect(await memberOf(r, ana)).toMatchObject({ status: 'active', paid_order_count: 2 })
    // a member cannot start another checkout
    await expect(
      transaction(r.db, (tx) => openCheckoutIntent(tx, dctx(r), { customerId: ana, planKey: 'gold', email: 'a@example.com' }, SYSTEM)),
    ).rejects.toMatchObject({ code: 'MEMBERSHIP_EXISTS' })
  })

  /** A member the identity migration imported: their Squarespace customer on the membership row, one paid order (Bob in F1). */
  async function legacyMembership(r: Rig, customerId: string, sqspCustomerId: string, orderId: string) {
    const id = r.newId()
    const now = r.clock.now()
    await r.db
      .insertInto('memberships')
      .values({
        id,
        location_id: r.locationId,
        customer_id: customerId,
        plan_id: (await r.db.selectFrom('membership_plans').select('id').where('key', '=', 'gold').executeTakeFirstOrThrow()).id,
        plan_label: 'Gold',
        status: 'active',
        source: 'squarespace',
        sqsp_customer_id: sqspCustomerId,
        sqsp_product_key: 'MEM-GOLD',
        started_at: now,
        current_period_start: now,
        current_period_end: new Date(now.getTime() + 31 * D),
        last_sqsp_order_id: orderId,
        last_paid_at: now,
        paid_order_count: 1,
      })
      .execute()
    return id
  }
  const sqspCustomerOf = async (r: Rig, orderId: string) =>
    (await r.db.selectFrom('sqsp_orders').select('sqsp_customer_id').where('sqsp_order_id', '=', orderId).executeTakeFirstOrThrow()).sqsp_customer_id!
  const orderRow = async (r: Rig, orderId: string) =>
    (await r.db.selectFrom('sqsp_orders').select('id').where('sqsp_order_id', '=', orderId).executeTakeFirstOrThrow()).id

  it('a legacy member (email never verified, contact linked BY that email, existing membership): another client’s intent naming the email takes none of the orders and binds nothing (F1)', async () => {
    const r = rig()
    const { env } = await setup(r)
    const bob = await makeCustomer(r.db, env, { name: 'Bob Legacy', email: 'bob@example.com', phone: '+12015550111' })
    const eve = await makeCustomer(r.db, env, { name: 'Eve Taker', email: 'eve@example.com', phone: '+12015550122' })
    // before W2e: Bob paid, the contacts job linked his Squarespace contact by his (unverified) email, the import made his membership
    const o1 = r.store.createOrder({ email: 'bob@example.com', name: 'Bob Legacy', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    await r.rt.syncContacts(r.locationId)
    const sqBob = await sqspCustomerOf(r, o1.orderId)
    expect(await r.db.selectFrom('sqsp_customer_links').select(['customer_id', 'source']).where('sqsp_customer_id', '=', sqBob).execute()).toEqual([
      { customer_id: bob, source: 'email' },
    ])
    const bobMembership = await legacyMembership(r, bob, sqBob, o1.orderId)
    // a month later Eve starts a checkout naming Bob's email, and Bob's renewal arrives inside her window
    r.advance(30 * D)
    const started = await transaction(r.db, (tx) =>
      openCheckoutIntent(tx, dctx(r), { customerId: eve, planKey: 'gold', email: 'bob@example.com' }, SYSTEM),
    )
    r.advance(H)
    const o2 = r.store.createOrder({ email: 'bob@example.com', name: 'Bob Legacy', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    const p = await pass(r)
    expect(p.sync).toMatchObject({ intentsMatched: 0, created: 0, awaitingMatch: 0, needsCustomer: 0 })
    // Eve's intent is not consumed and her membership gets nothing; the order is Bob's renewal: his Squarespace customer already
    // paid on his record, so it is Bob whatever made the contact link (W4c re-review 3, D1; before it, the order waited for staff)
    const eveMembership = async () => r.db.selectFrom('memberships').selectAll().where('customer_id', '=', eve).execute()
    expect(await eveMembership()).toEqual([
      expect.objectContaining({ id: started.membershipId, status: 'pending', paid_order_count: 0, sqsp_customer_id: null, last_sqsp_order_id: null }),
    ])
    const rows = await checkouts(r)
    expect(rows.find((c) => c.id === started.checkoutId)).toMatchObject({ state: 'open', matched_order_id: null })
    expect(rows.filter((c) => c.id !== started.checkoutId)).toEqual([])
    expect(await memberOf(r, bob)).toMatchObject({ id: bobMembership, status: 'active', paid_order_count: 2, last_sqsp_order_id: o2.orderId })
    expect((await loadIntentRefs(r.db, r.locationId)).find((i) => i.id === started.checkoutId)).toMatchObject({ state: 'open', orderId: undefined })

    // the state the first fix left (re-verifier probe): Eve's intent matched to Bob's renewal. loadIntentRefs never binds it to
    // Bob's Squarespace customer, and the renewals after it are not Eve's either
    await r.db
      .updateTable('membership_checkouts')
      .set({ state: 'matched', matched_order_id: await orderRow(r, o2.orderId), matched_at: r.clock.now() })
      .where('id', '=', started.checkoutId)
      .execute()
    expect((await loadIntentRefs(r.db, r.locationId)).find((i) => i.id === started.checkoutId)).toMatchObject({
      state: 'matched',
      orderId: o2.orderId,
      orderSqspCustomerId: sqBob,
      orderHeldByAnother: true,
    })
    for (const month of [1, 2]) {
      r.advance(31 * D)
      // Eve tries again each month: a new intent on her pending membership
      if (month === 2)
        await transaction(r.db, (tx) => openCheckoutIntent(tx, dctx(r), { customerId: eve, planKey: 'gold', email: 'bob@example.com' }, SYSTEM))
      r.advance(H)
      r.store.createOrder({ email: 'bob@example.com', name: 'Bob Legacy', lineItems: [item('MEM-GOLD', 'Gold')] })
      await sync(r)
      expect((await pass(r)).sync).toMatchObject({ intentsMatched: 0 })
      expect(await eveMembership()).toEqual([expect.objectContaining({ paid_order_count: 0, status: 'pending', sqsp_customer_id: null, last_sqsp_order_id: null })])
    }
    // every order is Bob's renewal; none was ever bound to Eve beyond the forced row
    const after = await checkouts(r)
    expect(after.filter((c) => c.customer_id === eve).map((c) => c.state).sort()).toEqual(['matched', 'open'])
    expect(after.filter((c) => c.customer_id !== eve)).toEqual([])
    expect(await memberOf(r, bob)).toMatchObject({ id: bobMembership, status: 'active', paid_order_count: 4 })
  })

  for (const paid of [true, false])
    it(`a member known only by the Squarespace customer on their membership row (${paid ? 'a matched payment reached it' : 'no matched payment on it'}): another client’s intent naming the order email takes nothing (F1)${paid ? '; the order is the member’s (D1)' : ', and the alert says why'}`, async () => {
      const r = rig()
      const { env } = await setup(r)
      const meg = await makeCustomer(r.db, env, { name: 'Meg Member', email: null, phone: '+12015550144' })
      const eve = await makeCustomer(r.db, env, { name: 'Eve Taker', email: 'eve@example.com', phone: '+12015550122' })
      const o1 = r.store.createOrder({ email: 'meg@example.com', name: 'Meg', lineItems: [item('MEM-GOLD', 'Gold')] })
      await sync(r)
      const sqMeg = await sqspCustomerOf(r, o1.orderId)
      const megMembership = await legacyMembership(r, meg, sqMeg, o1.orderId)
      // a row an import named the Squarespace customer on without any payment the sync matched: it links nothing by itself
      if (!paid) await r.db.updateTable('memberships').set({ last_paid_at: null, paid_order_count: 0 }).where('id', '=', megMembership).execute()
      expect(await r.db.selectFrom('sqsp_customer_links').select('customer_id').execute()).toEqual([])
      r.advance(30 * D)
      const started = await transaction(r.db, (tx) =>
        openCheckoutIntent(tx, dctx(r), { customerId: eve, planKey: 'gold', email: 'meg@example.com' }, SYSTEM),
      )
      r.advance(H)
      const o2 = r.store.createOrder({ email: 'meg@example.com', name: 'Meg', lineItems: [item('MEM-GOLD', 'Gold')] })
      await sync(r)
      const p = await pass(r)
      expect(p.sync).toMatchObject({ intentsMatched: 0, needsCustomer: paid ? 0 : 1 })
      expect((await checkouts(r)).find((c) => c.id === started.checkoutId)).toMatchObject({ state: 'open', matched_order_id: null })
      expect(await memberOf(r, eve)).toMatchObject({ status: 'pending', paid_order_count: 0, sqsp_customer_id: null })
      const alerts = await openAlerts(r)
      if (paid) {
        // the Squarespace customer already paid on Meg's record: her renewal (W4c re-review 3, D1), and staff are told Eve's
        // checkout named it (W4c re-review 4, E3)
        expect(alerts).toEqual([expect.objectContaining({ code: 'membership_intent_conflict', sqsp_order_id: o2.orderId })])
        expect(alerts[0]!.message).toContain("paid from Meg Member's Squarespace account for Eve Taker's checkout")
        expect(await memberOf(r, meg)).toMatchObject({ id: megMembership, status: 'active', paid_order_count: 2, last_sqsp_order_id: o2.orderId })
        return
      }
      expect(alerts.map((a) => a.code)).toEqual(['membership_needs_customer'])
      expect(alerts[0]!.message).toContain('carries the email of a checkout another client started')
      expect(alerts[0]!.message).toContain(o2.orderId)
    })

  it('the honest case: a brand-new client’s intent takes the order of a new Squarespace customer, its renewals follow, and a later intent of someone else naming that email takes none (F1)', async () => {
    const r = rig()
    const { env } = await setup(r)
    const nina = await makeCustomer(r.db, env, { name: 'Nina New', email: 'nina@example.com', phone: '+12015550133' })
    const eve = await makeCustomer(r.db, env, { name: 'Eve Taker', email: 'eve@example.com', phone: '+12015550122' })
    const started = await transaction(r.db, (tx) =>
      openCheckoutIntent(tx, dctx(r), { customerId: nina, planKey: 'gold', email: 'nina@example.com' }, SYSTEM),
    )
    r.advance(H)
    const o1 = r.store.createOrder({ email: 'nina@example.com', name: 'Nina', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    expect((await pass(r)).sync).toMatchObject({ intentsMatched: 1, awaitingMatch: 0, needsCustomer: 0 })
    const sqNina = await sqspCustomerOf(r, o1.orderId)
    expect(await memberOf(r, nina)).toMatchObject({ id: started.membershipId, status: 'active', paid_order_count: 1, sqsp_customer_id: sqNina })
    // the contacts job links her Squarespace contact by her own email: hers, no conflict
    await r.rt.syncContacts(r.locationId)
    expect(await r.db.selectFrom('sqsp_customer_links').select(['customer_id', 'source']).execute()).toEqual([{ customer_id: nina, source: 'email' }])
    r.advance(31 * D)
    r.store.createOrder({ email: 'nina@example.com', name: 'Nina', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    await pass(r)
    expect(await memberOf(r, nina)).toMatchObject({ status: 'active', paid_order_count: 2 })
    // Eve names Nina's email; Nina's next renewal arrives inside Eve's window and is still Nina's
    r.advance(29 * D)
    const eves = await transaction(r.db, (tx) =>
      openCheckoutIntent(tx, dctx(r), { customerId: eve, planKey: 'gold', email: 'nina@example.com' }, SYSTEM),
    )
    r.advance(H)
    const o3 = r.store.createOrder({ email: 'nina@example.com', name: 'Nina', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    expect((await pass(r)).sync).toMatchObject({ intentsMatched: 0 })
    expect(await memberOf(r, nina)).toMatchObject({ status: 'active', paid_order_count: 3, last_sqsp_order_id: o3.orderId })
    expect(await memberOf(r, eve)).toMatchObject({ id: eves.membershipId, status: 'pending', paid_order_count: 0 })
    expect((await checkouts(r)).find((c) => c.id === eves.checkoutId)).toMatchObject({ state: 'open', matched_order_id: null })
    // not silently: staff are told Eve's checkout named an order Nina's own account paid (W4c re-review 4, E3)
    const alerts = await openAlerts(r)
    expect(alerts).toEqual([expect.objectContaining({ code: 'membership_intent_conflict', sqsp_order_id: o3.orderId })])
    expect(alerts[0]!.message).toContain("paid from Nina New's Squarespace account for Eve Taker's checkout")
  })

  it('a plan without a checkout URL cannot start a checkout', async () => {
    const r = rig()
    const { env } = await setup(r)
    const c = await makeCustomer(r.db, env, { name: 'No Url' })
    await expect(
      transaction(r.db, (tx) => openCheckoutIntent(tx, dctx(r), { customerId: c, planKey: 'vip', email: 'x@example.com' }, SYSTEM)),
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

  it('an order matching an open intent only by its typed email but carrying another phone or name waits for staff (W4c fixes P7)', async () => {
    const r = rig()
    const { env, manager } = await setup(r)
    const ana = await makeCustomer(r.db, env, { name: 'Ana Ruiz', email: null, phone: '+12015550188' })
    const started = await transaction(r.db, (tx) => openCheckoutIntent(tx, dctx(r), { customerId: ana, planKey: 'gold', email: 'ana.ruiz@example.com' }, SYSTEM))
    r.advance(H)
    // someone Oasis does not know pays with Ana's typed email within the window
    const o = r.store.createOrder({ email: 'ana.ruiz@example.com', name: 'Eve Squatter', phone: '9735550100', lineItems: [item('MEM-GOLD', 'Gold')] })
    await sync(r)
    const p = await pass(r)
    expect(p.sync).toMatchObject({ intentsMatched: 0, awaitingMatch: 1, updated: 0, created: 0 })
    expect(await memberOf(r, ana)).toMatchObject({ id: started.membershipId, status: 'pending' })
    const rows = await checkouts(r)
    expect(rows.map((c) => [c.state, c.origin])).toEqual([
      ['open', 'link'],
      ['awaiting_match', 'sync'],
    ])
    const [note] = await r.db.selectFrom('notifications').select(['kind', 'body', 'employee_id']).execute()
    expect(note).toMatchObject({ kind: 'membership.awaiting_match', employee_id: manager.employeeId })
    expect(note!.body).toContain('the order\'s phone or name is not theirs')
    expect((await openAlerts(r)).map((a) => [a.code, a.sqsp_order_id])).toEqual([['membership_awaiting_match', o.orderId]])
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
      openCheckoutIntent(tx, dctx(r), { customerId: ana, planKey: 'gold', email: 'ana@example.com' }, SYSTEM),
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
        plan_id: (await r.db.selectFrom('membership_plans').select('id').where('key', '=', 'gold').executeTakeFirstOrThrow()).id,
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

  it('the sweep never closes a membership staff made or edited, even one staff put on pending by hand (F2)', async () => {
    const r = rig()
    const { env } = await setup(r)
    const staff = { userId: 'test', name: 'Gerald', audit: { actor: { name: 'Gerald' } } }
    const sam = await makeCustomer(r.db, env, { name: 'Sam Staffmade' })
    const made = await transaction(r.db, (tx) => createManualMembership(tx, dctx(r), { customerId: sam, planKey: 'gold' }, staff))
    r.advance(10 * D)
    await transaction(r.db, (tx) => patchMembership(tx, dctx(r), made.id, { status: 'pending' }, staff))
    // a website join staff touched (any hand edit) is staff's too
    const web = await makeCustomer(r.db, env, { name: 'Web Joiner' })
    const webId = r.newId()
    await r.db
      .insertInto('memberships')
      .values({
        id: webId,
        location_id: r.locationId,
        customer_id: web,
        plan_id: (await r.db.selectFrom('membership_plans').select('id').where('key', '=', 'gold').executeTakeFirstOrThrow()).id,
        plan_label: 'Gold',
        status: 'pending',
        source: 'manual',
        started_at: r.clock.now(),
      })
      .execute()
    await transaction(r.db, (tx) => patchMembership(tx, dctx(r), webId, { autoApply: false }, staff))
    r.advance(8 * D)
    expect(await sweepCheckouts(r.db, dctx(r))).toEqual({ expired: 0, abandoned: 0 })
    expect(await memberOf(r, sam)).toMatchObject({ status: 'pending', cancel_reason: null })
    expect(await memberOf(r, web)).toMatchObject({ status: 'pending', cancel_reason: null })
  })

  it('a restarted checkout gets its full window: the 7 days run from the newest checkout attempt, never from the membership start (F3)', async () => {
    const r = rig()
    const { env } = await setup(r)
    const ana = await makeCustomer(r.db, env, { name: 'Ana Ruiz' })
    const open = () =>
      transaction(r.db, (tx) => openCheckoutIntent(tx, dctx(r), { customerId: ana, planKey: 'gold', email: 'ana@example.com' }, SYSTEM))
    const first = await open()
    r.advance(6 * D + 23 * H)
    const second = await open()
    expect(second.membershipId).toBe(first.membershipId)
    r.advance(2 * H)
    expect(await sweepCheckouts(r.db, dctx(r))).toEqual({ expired: 0, abandoned: 0 })
    expect(await memberOf(r, ana)).toMatchObject({ status: 'pending' })
    expect((await checkouts(r)).find((c) => c.id === second.checkoutId)!.state).toBe('open')
    // the new intent expires after its own 72 hours; the membership is still inside its 7 days
    r.advance(70 * H)
    expect(await sweepCheckouts(r.db, dctx(r))).toEqual({ expired: 1, abandoned: 0 })
    // 7 days after the second attempt: closed
    r.advance(4 * D - 1 * H)
    expect(await sweepCheckouts(r.db, dctx(r))).toEqual({ expired: 0, abandoned: 0 })
    r.advance(1 * H)
    expect(await sweepCheckouts(r.db, dctx(r))).toEqual({ expired: 0, abandoned: 1 })
    expect(await memberOf(r, ana)).toMatchObject({ status: 'canceled', cancel_reason: CHECKOUT_ABANDONED })
    expect((await checkouts(r)).find((c) => c.id === second.checkoutId)!.state).toBe('abandoned')
  })

  it('an email that changes always drops email_verified; only setVerifiedEmail sets a new verified email, even over a verified one (F4)', async () => {
    const r = rig()
    const { env } = await setup(r)
    const c = await makeCustomer(r.db, env, { name: 'Eve Email', email: 'eve@example.com' })
    const flag = async () =>
      (await r.db.selectFrom('customers').select(['email', 'email_verified']).where('id', '=', c).executeTakeFirstOrThrow())
    await sql`update customers set email_verified = true where id = ${c}`.execute(r.db)
    // the same address in another letter case is the same email (citext): the flag stays
    await sql`update customers set email = 'EVE@example.com' where id = ${c}`.execute(r.db)
    expect((await flag()).email_verified).toBe(true)
    await sql`update customers set full_name = 'Eve E.', email = email where id = ${c}`.execute(r.db)
    expect((await flag()).email_verified).toBe(true)
    // a verified client changing to a new address and claiming it verified in the same statement: dropped (no signal)
    await sql`update customers set email = 'eve.claim@example.com', email_verified = true where id = ${c}`.execute(r.db)
    expect((await flag()).email_verified).toBe(false)
    // from unverified too
    await sql`update customers set email = 'eve.claim2@example.com', email_verified = true where id = ${c}`.execute(r.db)
    expect((await flag()).email_verified).toBe(false)
    // the one way: setVerifiedEmail, from unverified ...
    expect(await transaction(r.db, (tx) => setVerifiedEmail(tx, c, ' Eve.Page@Example.com '))).toBe(true)
    expect(await flag()).toEqual({ email: 'eve.page@example.com', email_verified: true })
    // ... and over an already-verified email (the case a single statement cannot express)
    expect(await transaction(r.db, (tx) => setVerifiedEmail(tx, c, 'eve.next@example.com'))).toBe(true)
    expect(await flag()).toEqual({ email: 'eve.next@example.com', email_verified: true })
    // the signal does not outlive the call: a later change in the same transaction still drops the flag
    await transaction(r.db, async (tx) => {
      await setVerifiedEmail(tx, c, 'eve.again@example.com')
      await sql`update customers set email = 'eve.again@example.com', email_verified = true where id = ${c}`.execute(tx)
      await sql`update customers set email = 'eve.other@example.com', email_verified = true where id = ${c}`.execute(tx)
    })
    expect((await flag()).email_verified).toBe(false)
    // an invalid address or an unknown client changes nothing
    await expect(transaction(r.db, (tx) => setVerifiedEmail(tx, c, 'not an email'))).rejects.toThrow()
    expect(await transaction(r.db, (tx) => setVerifiedEmail(tx, r.newId(), 'x@example.com'))).toBe(false)
  })
})
