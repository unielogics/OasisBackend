// pnpm sim:square over HTTP: the /__sim controls (a counter payment, a link paid by its buyer, a failed renewal, a failed refund, the
// clock, faults) and what they leave in the API and the event log.
import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createSquareApi } from '../../src/integrations/square/api/index.js'
import { SquareClient } from '../../src/integrations/square/client.js'
import { sqKey } from '../../src/integrations/square/keys.js'
import { usd } from '../../src/integrations/square/money.js'
import { SquareSimApi, SquareSimStore, closeSim, createSquareSimHttpServer, listenSim, seedSquareDemo } from '../../src/integrations/square/sim/index.js'
import { FixedClock } from '../../src/platform/clock.js'

const TOKEN = 'sim-http-token-0001'

describe('Square simulator over HTTP', () => {
  let server: Server | undefined
  afterEach(async () => {
    if (server) await closeSim(server)
    server = undefined
  })

  async function boot() {
    const clock = new FixedClock('2026-10-12T15:00:00Z')
    const store = new SquareSimStore(clock, { locationId: 'LHTTP0001' })
    const sim = new SquareSimApi(store, { tokens: [TOKEN] })
    server = createSquareSimHttpServer(sim)
    const base = await listenSim(server)
    const api = createSquareApi(new SquareClient({ baseUrl: base, accessToken: TOKEN, sleeper: { sleep: async () => undefined } }))
    const control = async (path: string, body: unknown = {}) => {
      const r = await fetch(`${base}/__sim/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: r.status, body: (await r.json()) as Record<string, Record<string, unknown>> }
    }
    return { clock, store, sim, base, api, control }
  }

  it('a counter payment and a refund in the Square app show up like Square shows them', async () => {
    const s = await boot()
    const pos = await s.control('pos/payment', { amountCents: 4000, tipCents: 600, note: 'INV-20640', sourceType: 'CARD' })
    expect(pos.status).toBe(200)
    const p = await s.api.payments.get(String(pos.body.payment!.id))
    expect(p).toMatchObject({ status: 'COMPLETED', source_type: 'CARD', note: 'INV-20640', tip_money: usd(600), total_money: usd(4600) })
    expect(p.application_details?.square_product).toBe('SQUARE_POS')
    const cash = await s.control('pos/payment', { amountCents: 2500, sourceType: 'CASH' })
    expect((await s.api.payments.get(String(cash.body.payment!.id))).source_type).toBe('CASH')
    const rf = await s.control('pos/refund', { paymentId: p.id, amountCents: 1000 })
    expect(rf.body.refund).toMatchObject({ status: 'PENDING', payment_id: p.id })
    await s.control('clock', { advanceMs: 5000 })
    expect((await s.api.refunds.get(String(rf.body.refund!.id))).status).toBe('COMPLETED')
    const types = s.store.events.map((e) => e.type)
    expect(types).toEqual(expect.arrayContaining(['payment.created', 'payment.updated', 'refund.created', 'refund.updated']))
  })

  it('the buyer pays a link (with a tip); a refund can be failed; a renewal can fail', async () => {
    const s = await boot()
    const { link } = await s.api.checkout.createLink(sqKey('pl', 'x'), { quick_pay: { name: 'Booking deposit', price_money: usd(2500), location_id: 'LHTTP0001' } })
    const paid = await s.control(`links/${link.id}/pay`, { tipCents: 200 })
    expect(paid.body.payment).toMatchObject({ order_id: link.order_id, amount_money: usd(2500), tip_money: usd(200) })
    const rf = await s.api.refunds.refund(sqKey('rf', 'x'), { payment_id: String(paid.body.payment!.id), amount_money: usd(2500) })
    expect((await s.control(`refunds/${encodeURIComponent(rf.id)}/fail`, { status: 'REJECTED' })).body.refund!.status).toBe('REJECTED')
    const c = await s.api.customers.create(sqKey('cu', 'x'), { given_name: 'Ana', email_address: 'ana@oasisautospanj.com' })
    const card = await s.api.cards.create(sqKey('cd', 'x'), { source_id: 'cnon:card-nonce-ok', card: { customer_id: c.id } })
    const plan = await s.api.catalog.upsert(sqKey('ct', 'p'), { type: 'SUBSCRIPTION_PLAN', id: '#p', subscription_plan_data: { name: 'Gold' } })
    const v = await s.api.catalog.upsert(sqKey('ct', 'v'), { type: 'SUBSCRIPTION_PLAN_VARIATION', id: '#v', subscription_plan_variation_data: { name: 'Gold Compact', subscription_plan_id: plan.object.id, phases: [{ cadence: 'MONTHLY', ordinal: 0, pricing: { type: 'STATIC', price_money: usd(12900) } }] } })
    const sub = await s.api.subscriptions.create(sqKey('sb', 'x'), { location_id: 'LHTTP0001', plan_variation_id: v.object.id, customer_id: c.id, card_id: card.id })
    const failed = await s.control(`subscriptions/${sub.id}/bill`, { outcome: 'failed' })
    expect(failed.body.invoice!.status).toBe('SCHEDULED')
    expect(s.store.events.some((e) => e.type === 'invoice.scheduled_charge_failed')).toBe(true)
    await s.control(`cards/${encodeURIComponent(card.id)}/auto-update`, { last4: '4242' })
    expect((await s.api.cards.retrieve(card.id)).last_4).toBe('4242')
    await s.control(`cards/${encodeURIComponent(card.id)}/forget`)
    expect((await s.api.cards.retrieve(card.id)).enabled).toBe(false)
  })

  it('faults: a 429 with Retry-After and a 500 are retried by the client for a GET; the state and request log are readable', async () => {
    const s = await boot()
    await s.control('faults', { status: 429, times: 1, path: '/v2/locations', retryAfterSeconds: 0 })
    await s.control('faults', { status: 500, times: 1, path: '/v2/locations' })
    expect((await s.api.locations.list())[0]!.id).toBe('LHTTP0001')
    const reqs = (await (await fetch(`${s.base}/__sim/requests`)).json()) as { requests: Array<{ status: number; version?: string }> }
    expect(reqs.requests.map((r) => r.status)).toEqual([429, 500, 200])
    expect(reqs.requests.every((r) => r.version === '2026-09-16')).toBe(true)
    const st = (await (await fetch(`${s.base}/__sim/state`)).json()) as { locationId: string }
    expect(st.locationId).toBe('LHTTP0001')
    expect((await fetch(`${s.base}/v2/locations`)).status).toBe(401)
    const demo = seedSquareDemo(s.store)
    expect((await s.api.checkout.retrieveLink(demo.linkId)).url).toMatch(/^https:\/\/sandbox\.square\.link\//)
  })
})
