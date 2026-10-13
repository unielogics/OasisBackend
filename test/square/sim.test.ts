// The in-process Square simulator: honest to the sandbox's answers (same wire schemas, the fields the fixtures carry), real
// idempotency, clock-driven refunds and subscription billing, scheduled actions, the event log, fault injection.
import { describe, expect, it } from 'vitest'
import { createSquareApi } from '../../src/integrations/square/api/index.js'
import { SquareClient } from '../../src/integrations/square/client.js'
import { SquareIdempotencyReused, SquareNetworkError, SquareDeclined } from '../../src/integrations/square/errors.js'
import { sqKey } from '../../src/integrations/square/keys.js'
import { usd } from '../../src/integrations/square/money.js'
import { SquareSimApi, SquareSimStore, simFetch } from '../../src/integrations/square/sim/index.js'
import { wire } from '../../src/integrations/square/wire.js'
import { FixedClock } from '../../src/platform/clock.js'
import { fixture } from './fixtures.js'

function rig(o: { email?: string } = {}) {
  const clock = new FixedClock('2026-10-12T14:00:00Z')
  const store = new SquareSimStore(clock, { locationId: 'LTEST', timezone: 'America/New_York' })
  const sim = new SquareSimApi(store, { tokens: ['t-123456789'] })
  const sleeps: number[] = []
  const client = new SquareClient({ baseUrl: 'http://sim', accessToken: 't-123456789', fetch: simFetch(sim), sleeper: { sleep: async (ms) => void sleeps.push(ms) } })
  const api = createSquareApi(client)
  const customer = async () => api.customers.create(sqKey('cu', `c-${Math.random()}`), { given_name: 'Ana', email_address: o.email ?? 'ana@oasisautospanj.com', reference_id: 'client-1' })
  return { clock, store, sim, api, sleeps, customer }
}

/** The keys an object of the fixture carries that our schema reads must also be there in the simulator's object. */
function sameShape(simObj: Record<string, unknown>, fixtureObj: Record<string, unknown>, keys: string[]): string[] {
  return keys.filter((k) => fixtureObj[k] !== undefined && simObj[k] === undefined)
}

describe('Square simulator', () => {
  it('answers in the sandbox shape for every object Oasis reads', async () => {
    const r = rig()
    const c = await r.customer()
    const card = await r.api.cards.create(sqKey('cd', 'k1'), { source_id: 'cnon:card-nonce-ok', card: { customer_id: c.id } })
    const p = await r.api.payments.create(sqKey('py', 'p1'), { source_id: card.id, customer_id: c.id, amount_money: usd(100), location_id: 'LTEST', autocomplete: true })
    const rf = await r.api.refunds.refund(sqKey('rf', 'r1'), { payment_id: p.id, amount_money: usd(100) })
    const link = await r.api.checkout.createLink(sqKey('pl', 'l1'), { order: { location_id: 'LTEST', line_items: [{ name: 'Wash', quantity: '1', base_price_money: usd(4000) }] } })
    const PAY = ['id', 'status', 'source_type', 'card_details', 'location_id', 'order_id', 'customer_id', 'receipt_number', 'receipt_url', 'application_details', 'total_money', 'approved_money']
    expect(sameShape(p, wire.payment.parse(fixture('payment-card-on-file').body).payment, PAY)).toEqual([])
    expect(p.card_details?.entry_method).toBe('ON_FILE')
    expect(sameShape(rf, wire.refund.parse(fixture('refund-create').body).refund, ['id', 'status', 'payment_id', 'order_id', 'location_id', 'amount_money'])).toEqual([])
    expect(rf.status).toBe('PENDING')
    expect(sameShape(link.link, wire.paymentLink.parse(fixture('payment-link-create').body).payment_link, ['id', 'version', 'order_id', 'url', 'long_url', 'created_at'])).toEqual([])
    expect(link.order).toMatchObject({ state: 'DRAFT' })
    expect(sameShape(card, wire.card.parse(fixture('card-create').body).card, ['id', 'card_brand', 'last_4', 'exp_month', 'exp_year', 'customer_id', 'enabled', 'card_type', 'fingerprint'])).toEqual([])
    const locs = await r.api.locations.list()
    expect(sameShape(locs[0]!, wire.locations.parse(fixture('locations').body).locations[0]!, ['id', 'status', 'currency', 'capabilities', 'merchant_id', 'timezone'])).toEqual([])
  })

  it('same key and body answer the same object; the same key with another body is IDEMPOTENCY_KEY_REUSED', async () => {
    const r = rig()
    const key = sqKey('cu', 'same')
    const a = await r.api.customers.create(key, { given_name: 'A', reference_id: 'x' })
    const b = await r.api.customers.create(key, { given_name: 'A', reference_id: 'x' })
    expect(b.id).toBe(a.id)
    expect(r.store.customers.size).toBe(1)
    await expect(r.api.customers.create(key, { given_name: 'B', reference_id: 'x' })).rejects.toBeInstanceOf(SquareIdempotencyReused)
    // a decline is replayed too: the same charge key never charges twice
    const pk = sqKey('ch', 'decline')
    const first = await r.api.payments.create(pk, { source_id: 'cnon:card-nonce-declined', amount_money: usd(100), location_id: 'LTEST' }).catch((e: unknown) => e)
    const second = await r.api.payments.create(pk, { source_id: 'cnon:card-nonce-declined', amount_money: usd(100), location_id: 'LTEST' }).catch((e: unknown) => e)
    expect(first).toBeInstanceOf(SquareDeclined)
    expect((second as SquareDeclined).code).toBe('GENERIC_DECLINE')
    expect(r.store.payments.size).toBe(1)
  })

  it('test nonces: CreateCard refuses every declined nonce with INVALID_CARD_DATA, CreatePayment declines with the mapped codes', async () => {
    const r = rig()
    const c = await r.customer()
    for (const [nonce, code] of [
      ['cnon:card-nonce-declined', 'GENERIC_DECLINE'],
      ['cnon:card-nonce-rejected-cvv', 'CVV_FAILURE'],
      ['cnon:card-nonce-rejected-postalcode', 'ADDRESS_VERIFICATION_FAILURE'],
      ['cnon:card-nonce-rejected-expiration', 'INVALID_EXPIRATION'],
    ] as const) {
      await expect(r.api.cards.create(sqKey('cd', nonce), { source_id: nonce, card: { customer_id: c.id } })).rejects.toMatchObject({ code: 'INVALID_CARD_DATA' })
      await expect(r.api.payments.create(sqKey('ch', nonce), { source_id: nonce, amount_money: usd(100), location_id: 'LTEST' })).rejects.toMatchObject({ code })
    }
  })

  it('refunds settle with the clock; a failed refund can be simulated', async () => {
    const r = rig()
    const p = await r.api.payments.create(sqKey('ch', 'p'), { source_id: 'cnon:card-nonce-ok', amount_money: usd(5000), tip_money: usd(500), location_id: 'LTEST' })
    const a = await r.api.refunds.refund(sqKey('rf', 'a'), { payment_id: p.id, amount_money: usd(2000) })
    const b = await r.api.refunds.refund(sqKey('rf', 'b'), { payment_id: p.id, amount_money: usd(3000) })
    await expect(r.api.refunds.refund(sqKey('rf', 'c'), { payment_id: p.id, amount_money: usd(501) })).rejects.toMatchObject({ code: 'REFUND_AMOUNT_INVALID' })
    r.store.failRefund(b.id, 'REJECTED')
    r.clock.advance(3000)
    expect((await r.api.refunds.get(a.id)).status).toBe('COMPLETED')
    expect((await r.api.refunds.get(b.id)).status).toBe('REJECTED')
    expect((await r.api.payments.get(p.id)).refunded_money).toEqual(usd(2000))
  })

  it('a payment link order is DRAFT until opened, is paid only for its exact amount, and keeps the link', async () => {
    const r = rig()
    const { link, order } = await r.api.checkout.createLink(sqKey('pl', 'x'), {
      order: { location_id: 'LTEST', line_items: [{ name: 'Wash', quantity: '1', base_price_money: usd(4000) }, { name: 'Sales tax', quantity: '1', base_price_money: usd(265) }] },
    })
    expect(order?.total_money).toEqual(usd(4265))
    await expect(r.api.payments.create(sqKey('ch', '1'), { source_id: 'cnon:card-nonce-ok', order_id: link.order_id!, amount_money: usd(4265), location_id: 'LTEST' })).rejects.toMatchObject({
      errors: [{ code: 'BAD_REQUEST', detail: 'The order must be OPEN to be paid.' }],
    })
    const paid = r.store.payLink(link.id, { tipCents: 300 })
    expect(paid).toMatchObject({ order_id: link.order_id, status: 'COMPLETED', tip_money: usd(300), total_money: usd(4565) })
    expect((await r.api.orders.retrieve(link.order_id!)).net_amount_due_money).toEqual(usd(0))
    expect(await r.api.checkout.deleteLink(link.id)).toBe(true)
    expect(await r.api.checkout.deleteLink(link.id)).toBe(false)
  })

  it('a subscription with a card bills its first period at once and renews with the clock; its invoice order cannot be paid directly', async () => {
    const r = rig()
    const c = await r.customer()
    const card = await r.api.cards.create(sqKey('cd', 'c'), { source_id: 'cnon:card-nonce-ok', card: { customer_id: c.id } })
    const plan = await r.api.catalog.upsert(sqKey('ct', 'p'), { type: 'SUBSCRIPTION_PLAN', id: '#p', subscription_plan_data: { name: 'Gold' } })
    const vars = await r.api.catalog.batchUpsert(sqKey('ct', 'v'), [[
      { type: 'SUBSCRIPTION_PLAN_VARIATION', id: '#v', subscription_plan_variation_data: { name: 'Gold Compact', subscription_plan_id: plan.object.id, phases: [{ cadence: 'MONTHLY', ordinal: 0, pricing: { type: 'STATIC', price_money: usd(12900) } }] } },
    ]])
    const sub = await r.api.subscriptions.create(sqKey('sb', 's'), { location_id: 'LTEST', plan_variation_id: vars.objects[0]!.id, customer_id: c.id, card_id: card.id })
    expect(sub).toMatchObject({ status: 'ACTIVE', start_date: '2026-10-12' })
    expect(sub.invoice_ids).toBeUndefined()
    const s1 = await r.api.subscriptions.retrieve(sub.id)
    expect(s1).toMatchObject({ status: 'ACTIVE', charged_through_date: '2026-11-12' })
    const inv = await r.api.invoices.get(s1.invoice_ids![0]!)
    expect(inv).toMatchObject({ status: 'PAID', subscription_id: sub.id })
    await expect(r.api.payments.create(sqKey('ch', 'inv'), { source_id: card.id, customer_id: c.id, order_id: inv.order_id!, amount_money: usd(12900), location_id: 'LTEST' })).rejects.toMatchObject({ status: 403 })
    r.clock.set('2026-11-12T12:00:00Z')
    const s2 = await r.api.subscriptions.retrieve(sub.id)
    expect(s2.invoice_ids).toHaveLength(2)
    expect(s2.charged_through_date).toBe('2026-12-12')
    // a failed renewal: the invoice stays unpaid and Square says so
    r.store.billNow(sub.id, 'failed')
    const types = r.store.events.map((e) => e.type)
    expect(types).toContain('invoice.payment_made')
    expect(types).toContain('invoice.scheduled_charge_failed')
    expect(() => r.store.deleteCatalog(vars.objects[0]!.id)).toThrow(/cannot be deleted/)
  })

  it('pause, resume, swap and cancel follow the sandbox: scheduled for the next billing date, resume of a scheduled pause refused', async () => {
    const r = rig()
    const c = await r.customer()
    const card = await r.api.cards.create(sqKey('cd', 'c'), { source_id: 'cnon:card-nonce-ok', card: { customer_id: c.id } })
    const plan = await r.api.catalog.upsert(sqKey('ct', 'p'), { type: 'SUBSCRIPTION_PLAN', id: '#p', subscription_plan_data: { name: 'Gold' } })
    const v = (await r.api.catalog.batchUpsert(sqKey('ct', 'v'), [[
      { type: 'SUBSCRIPTION_PLAN_VARIATION', id: '#a', subscription_plan_variation_data: { name: 'A', subscription_plan_id: plan.object.id, phases: [{ cadence: 'MONTHLY', ordinal: 0, pricing: { type: 'STATIC', price_money: usd(100) } }] } },
      { type: 'SUBSCRIPTION_PLAN_VARIATION', id: '#b', subscription_plan_variation_data: { name: 'B', subscription_plan_id: plan.object.id, phases: [{ cadence: 'MONTHLY', ordinal: 0, pricing: { type: 'STATIC', price_money: usd(200) } }] } },
    ]])).objects
    const sub = await r.api.subscriptions.create(sqKey('sb', 's'), { location_id: 'LTEST', plan_variation_id: v[0]!.id, customer_id: c.id, card_id: card.id })
    await r.api.subscriptions.retrieve(sub.id)
    const swap = await r.api.subscriptions.swapPlan(sub.id, { new_plan_variation_id: v[1]!.id })
    expect(swap.actions[0]).toMatchObject({ type: 'SWAP_PLAN', effective_date: '2026-11-12' })
    expect(swap.subscription.plan_variation_id).toBe(v[0]!.id)
    await r.api.subscriptions.deleteAction(sub.id, swap.actions[0]!.id)
    const pause = await r.api.subscriptions.pause(sub.id, {})
    expect(pause.actions[0]).toMatchObject({ type: 'PAUSE', effective_date: '2026-11-12' })
    await expect(r.api.subscriptions.resume(sub.id, { resume_change_timing: 'IMMEDIATE' })).rejects.toMatchObject({ code: 'INVALID_DATE' })
    r.clock.set('2026-11-12T15:00:00Z')
    expect((await r.api.subscriptions.retrieve(sub.id)).status).toBe('PAUSED')
    expect((await r.api.subscriptions.resume(sub.id, { resume_change_timing: 'IMMEDIATE' })).subscription.status).toBe('ACTIVE')
    const cancel = await r.api.subscriptions.cancel(sub.id)
    expect(cancel?.subscription.canceled_date).toBeDefined()
    expect(await r.api.subscriptions.cancel(sub.id)).toBeNull() // "already has a pending cancel date" counts as done
  })

  it('a customer email Square cannot deliver to deactivates the subscription within seconds (sandbox 2026-10-12)', async () => {
    const r = rig({ email: 'someone@example.com' })
    const c = await r.customer()
    const plan = await r.api.catalog.upsert(sqKey('ct', 'p'), { type: 'SUBSCRIPTION_PLAN', id: '#p', subscription_plan_data: { name: 'Gold' } })
    const v = await r.api.catalog.upsert(sqKey('ct', 'v'), { type: 'SUBSCRIPTION_PLAN_VARIATION', id: '#v', subscription_plan_variation_data: { name: 'A', subscription_plan_id: plan.object.id, phases: [{ cadence: 'MONTHLY', ordinal: 0, pricing: { type: 'STATIC', price_money: usd(100) } }] } })
    const sub = await r.api.subscriptions.create(sqKey('sb', 's'), { location_id: 'LTEST', plan_variation_id: v.object.id, customer_id: c.id })
    r.clock.advance(5)
    expect((await r.api.subscriptions.retrieve(sub.id)).status).toBe('DEACTIVATED')
  })

  it('logs events for SearchEvents in order, filters by type and time, and pages', async () => {
    const r = rig()
    for (let i = 0; i < 5; i++) {
      await r.api.payments.create(sqKey('ch', `e${i}`), { source_id: 'cnon:card-nonce-ok', amount_money: usd(100 + i), location_id: 'LTEST' })
      r.clock.advance(1000)
    }
    const all = await r.api.events.search({ event_types: ['payment.created'] })
    expect(all.items).toHaveLength(5)
    const page = await r.api.events.search({ event_types: ['payment.created'], limit: 2 })
    expect(page.items).toHaveLength(2)
    expect(page.cursor).toBeDefined()
    const rest = await r.api.events.search({ event_types: ['payment.created'], limit: 10, cursor: page.cursor })
    expect(rest.items).toHaveLength(3)
    const late = await r.api.events.search({ start_at: '2026-10-12T14:00:03Z', event_types: ['payment.created'] })
    expect(late.items).toHaveLength(2)
    expect(all.items.map((e) => e.created_at)).toEqual([...all.items.map((e) => e.created_at)].sort())
  })

  it('injected faults: 500 and a hang are retried for keyed calls, auth is checked', async () => {
    const r = rig()
    r.sim.injectFault({ status: 500, times: 1, path: '/v2/customers' })
    r.sim.injectFault({ hang: true, times: 1, path: '/v2/customers' })
    const c = await r.api.customers.create(sqKey('cu', 'f'), { given_name: 'F' })
    expect(c.id).toBeDefined()
    expect(r.store.customers.size).toBe(1)
    expect(r.sleeps).toHaveLength(2)
    r.sim.injectFault({ hang: true, times: 1, path: '/cancel' })
    await expect(r.api.payments.cancel('P1')).rejects.toBeInstanceOf(SquareNetworkError)
    const bad = createSquareApi(new SquareClient({ baseUrl: 'http://sim', accessToken: 'wrong-token-0000', fetch: simFetch(r.sim), maxAttempts: 1 }))
    await expect(bad.locations.list()).rejects.toMatchObject({ status: 401 })
  })
})
