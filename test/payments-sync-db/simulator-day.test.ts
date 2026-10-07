// A whole day of Squarespace against the simulator and real Postgres: the real client (rate limiter, 429 handling) over the
// simulator's HTTP surface, the real sync engine with Postgres repositories, the real match runner over the real ledger and
// the real HTTP routes for the manual queue. Money is checked on the invoices (invoice_calc), not on mocks.
import { describe, expect, it } from 'vitest'
import { createPermissiveAuthorizer } from '../../src/http/authorizer.js'
import { apiModules } from '../../src/http/modules.js'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { replaceProductRows } from '../../src/modules/payments-sync/db/product-map.js'
import { transaction } from '../../src/platform/db.js'
import { createTestApp } from '../helpers/app.js'
import { makeUser } from '../helpers/factories.js'
import { addEvent, makeCustomer, makeInvoice, setupEnv } from '../payments/helpers.js'
import { H, SECRETS_KEY, SIM_KEY, useRig } from './harness.js'

let keyN = 0
const key = (): string => `day-key-${++keyN}-${'x'.repeat(8)}`

describe('a full day in the Squarespace simulator', () => {
  const rig = useRig({ pageSize: 2 })

  it('confirms, matches, queues, refunds and ignores correctly, and a repeated poll changes nothing', async () => {
    const r = rig()
    const env = await setupEnv({ db: r.db, clock: r.clock })
    const user = await makeUser(r.db, r.newId, { first: 'Desk' })
    const { store, api } = r

    // ---- the shop: customers, invoices, the product map --------------------------------------------------------------
    const liam = await makeCustomer(r.db, env, { name: 'Liam Chen', email: 'liam.chen@example.com', phone: '+13055550142' })
    const maria = await makeCustomer(r.db, env, { name: 'Maria Alvarez', email: 'maria.alvarez@example.com', phone: '+15557120188' })
    const tom = await makeCustomer(r.db, env, { name: 'Tom Bradley', email: 'tom@example.com', phone: '+13058870042' })
    const priya = await makeCustomer(r.db, env, { name: 'Priya Nair', email: 'priya@example.com', phone: '+13057783321' })
    const detail = [{ name: 'Full Detail', priceCents: 18900 }] // 189.00 + 7% = 202.23
    const liamInv = await makeInvoice(r.db, env, { customerId: liam, items: detail })
    const mariaInv = await makeInvoice(r.db, env, { customerId: maria, items: detail })
    const tomInv = await makeInvoice(r.db, env, { customerId: tom, items: [{ name: 'Express Hand Wash', priceCents: 4500 }] })
    await ensurePlans(r.db, { locationId: r.locationId, clock: r.clock, newId: r.newId })
    await transaction(r.db, (tx) =>
      replaceProductRows(tx, { locationId: r.locationId, clock: r.clock, newId: r.newId }, [
        { sku: 'DET-SEDAN', kind: 'service', name: 'Full Detail - Sedan' },
        { sku: 'WASH-EXPRESS', kind: 'service', name: 'Express Hand Wash' },
        { sku: 'MEM-PREMIUM', kind: 'membership', plan: 'premium', planLabel: 'Premium Care', name: 'Premium Care Membership' },
      ]),
    )
    const app = await createTestApp({
      testDb: r.t,
      modules: apiModules,
      env: { SQSP_PROVIDER: 'live', SQSP_API_KEY: SIM_KEY, SECRETS_KEY },
      authorizer: (location) =>
        createPermissiveAuthorizer({ locationId: location.id, userId: user.userId, employeeId: user.employeeId, actorName: 'Desk U.' }),
    })
    const post = (url: string, body: unknown) =>
      app.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: { 'idempotency-key': key() }, payload: body as object })
    const cycle = async () => {
      r.advance(120_000)
      return r.rt.syncCycle(r.locationId)
    }
    const calcOf = async (id: string) =>
      r.db.selectFrom('invoice_calc').select(['paid', 'refunded', 'balance', 'status']).where('invoice_id', '=', id).executeTakeFirstOrThrow()
    const eventsOf = (id: string) =>
      r.db.selectFrom('ledger_events').selectAll().where('invoice_id', '=', id).orderBy('seq').execute()

    // ---- history that exists before the first sync: Priya's first Premium Care payment 30 days ago -----------------
    const sep6 = new Date(r.clock.now().getTime() - 30 * 86_400_000)
    const m1 = store.createOrder({
      email: 'priya@example.com',
      name: 'Priya Nair',
      phone: '3057783321',
      lineItems: [{ productId: 'p-mem', sku: 'MEM-PREMIUM', name: 'Premium Care Membership', unitCents: 14900, lineItemType: 'SERVICE' }],
      taxCents: 1043,
      createdOn: sep6,
    })
    const first = await r.rt.syncCycle(r.locationId)
    expect(first.status).toBe('ok')
    expect(first.orders?.inserted).toBe(1)
    expect(first.match?.membership).toBe(1)
    const { runMembershipPass } = await import('../../src/modules/memberships/jobs.js')
    const pass1 = await runMembershipPass(r.db, r.clock, r.locationId, r.env)
    expect(pass1.sync.created).toBe(1)
    const m = await r.db.selectFrom('memberships').selectAll().where('customer_id', '=', priya).executeTakeFirstOrThrow()
    expect(m).toMatchObject({ status: 'active', source: 'squarespace', plan_label: 'Premium Care', sqsp_subscription_ref: expect.stringContaining('priya@example.com') })
    expect(m.current_period_start?.toISOString()).toBe(sep6.toISOString())

    // ---- the morning: a staff-recorded card payment, a payment link, a stranger, a test order, an unmapped product -----
    r.advance(40 * 60_000)
    const now = () => r.clock.now()
    const staffEv = await addEvent(r.db, env, liamInv, {
      type: 'pay',
      amountCents: 20223,
      method: 'Card',
      methodKind: 'card',
      processorState: 'awaiting_processor',
      at: new Date(now().getTime() - 40 * 60_000),
    })
    await r.db
      .insertInto('payment_links')
      .values({ id: r.newId(), location_id: r.locationId, invoice_id: mariaInv.id, url: 'https://oasis.squarespace.com/pay/abc', expected_cents: 20223, sent_at: new Date(now().getTime() - 3 * H) })
      .execute()
    const line = { productId: 'p-det', sku: 'DET-SEDAN', name: 'Full Detail - Sedan', unitCents: 18900 }
    const orderA = store.createOrder({ email: 'liam.chen@example.com', name: 'Liam Chen', phone: '3055550142', lineItems: [line], taxCents: 1323 })
    const orderB = store.createOrder({ email: 'maria.alvarez@example.com', name: 'Maria Alvarez', phone: '5557120188', lineItems: [line], taxCents: 1323 })
    const orderC = store.createOrder({
      email: 'grace.adeyemi@example.com',
      name: 'Grace Adeyemi',
      phone: '3056602231',
      lineItems: [{ productId: 'p-wash', sku: 'WASH-EXPRESS', name: 'Express Hand Wash', unitCents: 4500 }],
      taxCents: 315,
    })
    const orderT = store.createOrder({ email: 'test@example.com', name: 'Test Buyer', lineItems: [line], taxCents: 1323, testMode: true })
    const orderU = store.createOrder({
      email: 'gift@example.com',
      name: 'Gift Buyer',
      lineItems: [{ productId: 'p-mug', sku: 'MUG-1', name: 'Oasis mug', unitCents: 1500 }],
      taxCents: 105,
    })
    const day1 = await cycle()
    expect(day1.status).toBe('ok')
    expect(day1.orders?.inserted).toBe(5)
    expect(day1.transactions?.inserted).toBe(5)

    // the staff-recorded payment was confirmed, not duplicated
    const liamEvents = await eventsOf(liamInv.id)
    expect(liamEvents).toHaveLength(1)
    expect(liamEvents[0]).toMatchObject({ id: staffEv, processor_state: 'confirmed', sqsp_order_id: orderA.orderId, processor_ref: orderA.paymentId, source: 'oasis' })
    expect(await calcOf(liamInv.id)).toMatchObject({ paid: 20223, balance: 0, status: 'paid' })
    // the payment-link order created exactly one squarespace pay event
    const mariaEvents = await eventsOf(mariaInv.id)
    expect(mariaEvents).toHaveLength(1)
    expect(mariaEvents[0]).toMatchObject({ type: 'pay', source: 'squarespace', processor_state: 'confirmed', amount_cents: 20223, sqsp_order_id: orderB.orderId, method: 'Visa' })
    expect((await r.db.selectFrom('payment_links').select('state').where('invoice_id', '=', mariaInv.id).executeTakeFirstOrThrow()).state).toBe('paid')
    // the stranger is in the manual queue, with the order and its payment held there
    const queue = await r.db.selectFrom('sqsp_manual_queue').selectAll().where('state', '=', 'open').execute()
    expect(queue.map((q) => [q.sqsp_order_id, q.reason])).toEqual([[orderC.orderId, 'no_candidate']])
    const orderRows = await r.db.selectFrom('sqsp_orders').select(['sqsp_order_id', 'match_state', 'ignore_reason']).execute()
    const stateOf = (id: string) => orderRows.find((o) => o.sqsp_order_id === id)
    expect(stateOf(orderA.orderId)?.match_state).toBe('auto')
    expect(stateOf(orderB.orderId)?.match_state).toBe('auto')
    expect(stateOf(orderC.orderId)?.match_state).toBe('manual')
    expect(stateOf(orderT.orderId)).toMatchObject({ match_state: 'ignored', ignore_reason: 'test_mode' })
    expect(stateOf(orderU.orderId)).toMatchObject({ match_state: 'ignored', ignore_reason: 'unmapped_sku' })
    expect(stateOf(m1.orderId)?.match_state).toBe('membership')
    // test-mode money never reached any invoice or the manual queue
    expect(await r.db.selectFrom('ledger_events').select('id').where('sqsp_order_id', '=', orderT.orderId).execute()).toHaveLength(0)
    // the Payments reconciliation list shows the stranger
    const rec = await app.app.inject({ method: 'GET', url: '/api/v1/payments/reconciliation' })
    expect(rec.statusCode).toBe(200)
    expect((rec.json() as { unmatchedOrders: { sqspOrderId: string }[] }).unmatchedOrders.map((o) => o.sqspOrderId)).toEqual([orderC.orderId])
    // the unmatched queue endpoint
    const listed = await app.app.inject({ method: 'GET', url: '/api/v1/integrations/squarespace/orders?state=unmatched' })
    const items = (listed.json() as { items: { sqspOrderId: string; queue: { reason: string }[]; transactions: { amountCents: number }[] }[] }).items
    expect(items.map((i) => i.sqspOrderId)).toEqual([orderC.orderId])
    expect(items[0]?.queue[0]?.reason).toBe('no_candidate')
    expect(items[0]?.transactions[0]?.amountCents).toBe(4815)
    // realtime: an order_synced event per stored order
    const sse = await r.db.selectFrom('realtime_events').select(['channel', 'type']).where('type', '=', 'squarespace.order_synced').execute()
    expect(sse.length).toBeGreaterThanOrEqual(5)
    expect(new Set(sse.map((s) => s.channel))).toEqual(new Set(['payments']))

    // ---- a repeated poll changes nothing (idempotent, overlap window re-reads the same rows) -----------------------
    const snapshot = async () => ({
      events: (await r.db.selectFrom('ledger_events').select('id').execute()).length,
      matches: (await r.db.selectFrom('sqsp_matches').select('id').execute()).length,
      queue: (await r.db.selectFrom('sqsp_manual_queue').select('id').execute()).length,
      alerts: (await r.db.selectFrom('sqsp_alerts').select('id').execute()).length,
    })
    const before = await snapshot()
    const again = await cycle()
    expect(again.orders).toMatchObject({ inserted: 0, updated: 0 })
    expect(again.orders?.unchanged).toBeGreaterThan(0)
    expect(again.match?.paymentsRecorded).toBe(0)
    expect(await snapshot()).toEqual(before)

    // ---- midday: Priya's renewal arrives, a staff member resolves the stranger through the endpoint --------------
    r.advance(2 * H)
    const renewal = store.renewSubscription(m1.orderId, { createdOn: new Date(now().getTime() - 60_000) })
    const day2 = await cycle()
    expect(day2.orders?.inserted).toBe(1)
    expect(day2.ordersChanged).toBe(true)
    const { runSyncJob } = await import('../../src/modules/payments-sync/jobs/sync.js')
    // the job path runs the membership inference too
    r.advance(120_000)
    const jobRun = await runSyncJob(r.db, r.clock, r.locationId, { env: r.env })
    expect(jobRun.status).toBe('ok')
    await runMembershipPass(r.db, r.clock, r.locationId, r.env)
    const renewed = await r.db.selectFrom('memberships').selectAll().where('id', '=', m.id).executeTakeFirstOrThrow()
    expect(renewed.status).toBe('active')
    expect(renewed.last_sqsp_order_id).toBe(renewal.orderId)
    expect(renewed.paid_order_count).toBe(2)
    expect(renewed.current_period_start!.getTime()).toBeGreaterThan(sep6.getTime())
    const grants = await r.db
      .selectFrom('membership_credit_events')
      .select(['cycle_start', 'kind', 'qty'])
      .where('membership_id', '=', m.id)
      .where('kind', '=', 'grant')
      .execute()
    expect(grants.map((g) => g.cycle_start.getTime()).sort()).toEqual([sep6.getTime(), renewed.current_period_start!.getTime()])

    const match = await post(`/integrations/squarespace/orders/${orderC.orderId}/match`, { invoiceId: tomInv.id })
    expect(match.statusCode, match.body).toBe(200)
    const matched = match.json() as { applied: { how: string; eventId: string }[] }
    expect(matched.applied).toHaveLength(1)
    expect(matched.applied[0]?.how).toBe('recorded')
    const tomEvents = await eventsOf(tomInv.id)
    expect(tomEvents).toHaveLength(1)
    expect(tomEvents[0]).toMatchObject({ type: 'pay', source: 'squarespace', amount_cents: 4815, sqsp_order_id: orderC.orderId, processor_ref: orderC.paymentId, processor_state: 'confirmed' })
    expect(await calcOf(tomInv.id)).toMatchObject({ paid: 4815, balance: 0, status: 'paid' })
    expect(await r.db.selectFrom('sqsp_manual_queue').select('state').executeTakeFirstOrThrow()).toEqual({ state: 'resolved' })
    expect((await r.db.selectFrom('sqsp_orders').select(['match_state', 'matched_invoice_id']).where('sqsp_order_id', '=', orderC.orderId).executeTakeFirstOrThrow())).toEqual({ match_state: 'manual', matched_invoice_id: tomInv.id })
    // a later poll recognises that money as recorded: no second pay event
    const afterMatch = await cycle()
    expect(afterMatch.match?.paymentsRecorded).toBe(0)
    expect(await eventsOf(tomInv.id)).toHaveLength(1)
    // asking again with a fresh key finds nothing left to match
    const twice = await post(`/integrations/squarespace/orders/${orderC.orderId}/match`, { invoiceId: tomInv.id })
    expect(twice.statusCode).toBe(409)
    expect((twice.json() as { code: string }).code).toBe('SQSP_NOTHING_TO_MATCH')

    // ---- afternoon: a refund made directly in Squarespace is ingested, never silently ---------------------------------
    r.advance(H)
    store.refund(orderA.orderId, { amountCents: 5000 })
    const refundCycle = await cycle()
    expect(refundCycle.match?.externalRefunds).toBe(1)
    const refunds = (await eventsOf(liamInv.id)).filter((e) => e.type === 'refund')
    expect(refunds).toHaveLength(1)
    expect(refunds[0]).toMatchObject({ source: 'squarespace', status: 'done', dest: 'card', processor_state: 'confirmed', needs_review: true, amount_cents: 5000 })
    expect(await calcOf(liamInv.id)).toMatchObject({ paid: 20223, refunded: 5000, status: 'partially_refunded' })
    const alerts = await r.db.selectFrom('sqsp_alerts').select(['code', 'sqsp_order_id']).where('resolved_at', 'is', null).execute()
    expect(alerts).toContainEqual({ code: 'external_refund', sqsp_order_id: orderA.orderId })
    // polling it again does not ingest it twice
    await cycle()
    expect((await eventsOf(liamInv.id)).filter((e) => e.type === 'refund')).toHaveLength(1)

    // ---- evening: Squarespace rate-limits the poll (a 429 storm); the client waits, the sync still completes -----
    store.createOrder({ email: 'late@example.com', name: 'Late Buyer', lineItems: [line], taxCents: 1323 })
    api.injectFailure({ status: 429, times: 3, retryAfterSeconds: 60 })
    const slept = r.sleeper.totalSleptMs
    const storm = await cycle()
    expect(storm.status).toBe('ok')
    expect(storm.orders?.inserted).toBe(1)
    expect(r.sleeper.totalSleptMs - slept).toBeGreaterThanOrEqual(3 * 60_000)

    // ---- health: nothing failed, nothing dead-lettered, lag is small ---------------------------------------------------
    const health = await r.db.selectFrom('sqsp_sync_state').select(['resource', 'status', 'consecutive_failures']).execute()
    for (const s of health) {
      if (s.resource === 'orders' || s.resource === 'transactions') {
        expect(s.status).toBe('ok')
        expect(s.consecutive_failures).toBe(0)
      }
    }
    expect(await r.db.selectFrom('sqsp_sync_errors').select('id').execute()).toHaveLength(0)
    await app.close()
  })
})
