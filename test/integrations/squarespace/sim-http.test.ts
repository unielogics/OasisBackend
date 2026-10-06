import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { FixedClock } from '../../../src/platform/clock.js'
import { SquarespaceClient } from '../../../src/integrations/squarespace/client.js'
import { FakeSleeper } from '../../../src/integrations/squarespace/sleeper.js'
import { SquarespaceSimApi } from '../../../src/integrations/squarespace/sim/api.js'
import { close, createSimHttpServer, listen } from '../../../src/integrations/squarespace/sim/http.js'
import { SquarespaceSimStore } from '../../../src/integrations/squarespace/sim/store.js'
import { NOW } from '../../fixtures/squarespace/load.js'
import { API_KEY, WINDOW, drain } from './helpers.js'

/** The simulator over a real loopback socket with the real fetch: what `pnpm sim:squarespace` serves. */
describe('simulator HTTP server (real sockets)', () => {
  let server: Server
  let base: string
  let api: SquarespaceSimApi
  let clock: FixedClock
  let client: SquarespaceClient

  beforeEach(async () => {
    clock = new FixedClock(NOW)
    const store = new SquarespaceSimStore(clock, { pageSize: 2, order: 'asc', currency: 'USD' })
    api = new SquarespaceSimApi(store, clock, { apiKeys: [API_KEY] })
    server = createSimHttpServer(api)
    base = await listen(server)
    client = new SquarespaceClient({
      auth: { kind: 'api_key', apiKey: API_KEY },
      clock,
      sleeper: new FakeSleeper(clock),
      baseUrl: base,
      userAgent: 'OasisTest/1.0',
    })
  })
  afterEach(() => close(server))

  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })
    return { status: r.status, body: (await r.json()) as Record<string, unknown> }
  }

  it('control endpoints create orders, renewals, payments, partial and full refunds, test-mode orders', async () => {
    const created = await post('/__sim/orders', {
      email: 'maria@example.com',
      name: 'Maria Alvarez',
      phone: '5557120188',
      lineItems: [
        { productId: 'p-prem', sku: 'MEM-PREMIUM', name: 'Premium Care Membership', unitCents: 14900 },
      ],
      taxCents: 1043,
      createdOn: '2026-09-04T15:00:00Z',
    })
    expect(created.status).toBe(201)
    const orderId = created.body.orderId as string
    const renewal = await post(`/__sim/orders/${orderId}/renew`, { createdOn: '2026-10-04T15:00:00Z' })
    expect(renewal.status).toBe(201)
    const part = await post(`/__sim/orders/${renewal.body.orderId}/refunds`, { amountCents: 2000 })
    expect(part.status).toBe(201)
    const overRefund = await post(`/__sim/orders/${renewal.body.orderId}/refunds`, { amountCents: 999999 })
    expect(overRefund.status).toBe(400)
    await post('/__sim/orders', {
      email: 'qa@example.com',
      lineItems: [{ name: 'Wash', unitCents: 5000 }],
      testMode: true,
    })
    const staged = await post('/__sim/orders', {
      email: 'dm@example.com',
      lineItems: [{ name: 'Plan', unitCents: 90000 }],
      pay: { amountCents: 30000 },
    })
    await post(`/__sim/orders/${staged.body.orderId}/payments`, { amountCents: 60000, brand: 'DISCOVER' })

    const { items } = await drain((cursor) =>
      client.listOrders({ ...WINDOW, modifiedBefore: new Date('2026-10-07T00:00:00Z'), cursor }),
    )
    expect(items).toHaveLength(4)
    expect(items.filter((o) => o.testMode)).toHaveLength(1)
    const renew = items.find((o) => o.id === renewal.body.orderId)!
    expect(renew).toMatchObject({
      customerEmail: 'maria@example.com',
      refundedTotalCents: 2000,
      paymentState: 'REFUNDED',
      grandTotalCents: 15943,
    })
    expect(items.find((o) => o.id === staged.body.orderId)!.paymentState).toBe('PAID')
    const txns = await drain((cursor) =>
      client.listTransactions({ ...WINDOW, modifiedBefore: new Date('2026-10-07T00:00:00Z'), cursor }),
    )
    expect(txns.items.filter((t) => t.orderId === staged.body.orderId).map((t) => t.amountCents)).toEqual([
      30000, 60000,
    ])
  })

  it('a document-level refund (the sample-response shape) round-trips', async () => {
    const o = await post('/__sim/orders', {
      email: 'a@example.com',
      lineItems: [{ name: 'Wash', unitCents: 5000 }],
    })
    await post(`/__sim/orders/${o.body.orderId}/refunds`, { amountCents: 5000, documentLevel: true })
    const { items } = await drain((cursor) =>
      client.listTransactions({ ...WINDOW, modifiedBefore: new Date('2026-10-07T00:00:00Z'), cursor }),
    )
    expect(items.map((t) => t.kind).sort()).toEqual(['payment', 'refund'])
  })

  it('injects failures and a rate limit through control endpoints', async () => {
    await post('/__sim/failures', { status: 429, times: 1, retryAfterSeconds: 9 })
    await post('/__sim/failures', { status: 503, times: 1 })
    await client.listContacts({})
    expect(api.log.map((l) => l.status)).toEqual([429, 503, 200])
    await post('/__sim/rate-limit', { maxPerWindow: 1, windowMs: 60000, cooldownMs: 60000 })
    await client.listContacts({})
    await client.listContacts({}) // second call hits the sim limit, waits out the cooldown, succeeds
    expect(api.log.filter((l) => l.status === 429).length).toBeGreaterThanOrEqual(2)
    await post('/__sim/rate-limit', {})
  })

  it('returns Squarespace-style error objects', async () => {
    const res = await fetch(`${base}/1.0/commerce/orders?modifiedAfter=2026-01-01T00:00:00.000Z`, {
      headers: { authorization: `Bearer ${API_KEY}`, 'user-agent': 'x' },
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      type: 'INVALID_REQUEST_ERROR',
      subtype: 'MISSING_ARGUMENT',
      details: null,
    })
    const unauth = await fetch(`${base}/v1/contacts`, { headers: { 'user-agent': 'x' } })
    expect(unauth.status).toBe(401)
    const missing = await fetch(`${base}/1.0/commerce/orders/none`, {
      headers: { authorization: `Bearer ${API_KEY}`, 'user-agent': 'x' },
    })
    expect(missing.status).toBe(404)
  })

  it('reset empties the store and the request log', async () => {
    await post('/__sim/orders', { email: 'a@example.com', lineItems: [{ name: 'Wash', unitCents: 5000 }] })
    await post('/__sim/reset', {})
    const state = (await (await fetch(`${base}/__sim/state`)).json()) as { counts: { orders: number } }
    expect(state.counts.orders).toBe(0)
  })
})
