import { describe, expect, it, vi } from 'vitest'
import { FixedClock } from '../../../src/platform/clock.js'
import { SquarespaceClient } from '../../../src/integrations/squarespace/client.js'
import {
  SquarespaceApiError,
  SquarespaceAuthError,
  SquarespaceNetworkError,
  SquarespacePermissionError,
  SquarespaceRateLimitError,
} from '../../../src/integrations/squarespace/errors.js'
import { SlidingWindowLimiter, parseRetryAfter } from '../../../src/integrations/squarespace/limiter.js'
import { FakeSleeper } from '../../../src/integrations/squarespace/sleeper.js'
import { StaticTokenProvider } from '../../../src/integrations/squarespace/auth.js'
import { fixture, NOW } from '../../fixtures/squarespace/load.js'
import { API_KEY, WINDOW, clientFor, drain, loadFixtures, rig } from './helpers.js'

interface Call {
  url: URL
  headers: Headers
}

function scripted(responses: (Response | Error | ((c: Call) => Response))[]): {
  fetch: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  let i = 0
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: new URL(String(input)), headers: new Headers(init?.headers) }
    calls.push(call)
    const next = responses[Math.min(i++, responses.length - 1)]!
    if (next instanceof Error) throw next
    return typeof next === 'function' ? next(call) : next.clone()
  }) as typeof fetch
  return { fetch: f, calls }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

function make(
  responses: Parameters<typeof scripted>[0],
  extra: Partial<ConstructorParameters<typeof SquarespaceClient>[0]> = {},
) {
  const clock = new FixedClock(NOW)
  const sleeper = new FakeSleeper(clock)
  const s = scripted(responses)
  const client = new SquarespaceClient({
    auth: { kind: 'api_key', apiKey: API_KEY },
    clock,
    sleeper,
    fetch: s.fetch,
    userAgent: 'OasisTest/1.0',
    ...extra,
  })
  return { client, clock, sleeper, calls: s.calls }
}

const emptyOrders = {
  pagination: { hasNextPage: false, nextPageCursor: null, nextPageUrl: null },
  result: [],
}

describe('request construction', () => {
  it('sends Authorization bearer, a User-Agent, and versioned paths on the documented base URL', async () => {
    const { client, calls } = make([json(emptyOrders)])
    await client.listOrders(WINDOW)
    const c = calls[0]!
    expect(c.url.origin).toBe('https://api.squarespace.com')
    expect(c.url.pathname).toBe('/1.0/commerce/orders')
    expect(c.headers.get('authorization')).toBe(`Bearer ${API_KEY}`)
    expect(c.headers.get('user-agent')).toBe('OasisTest/1.0')
    expect(c.url.searchParams.get('modifiedAfter')).toBe('2026-01-01T00:00:00.000Z')
    expect(c.url.searchParams.get('modifiedBefore')).toBe('2026-10-06T13:59:00.000Z')
  })

  it('requests all nine payment states so payment-plan and failed orders are not hidden by the API default', async () => {
    const { client, calls } = make([json(emptyOrders)])
    await client.listOrders(WINDOW)
    expect(calls[0]!.url.searchParams.get('paymentStates')).toBe(
      'NOT_CHARGED,AUTHORIZED,PAID,PARTIALLY_PAID,PENDING,FAILED,REFUND_PENDING,REFUNDED,REFUND_FAILED',
    )
    const off = make([json(emptyOrders)], { orderPaymentStates: null })
    await off.client.listOrders(WINDOW)
    expect(off.calls[0]!.url.searchParams.has('paymentStates')).toBe(false)
  })

  it('sends only the cursor when continuing a page (the API forbids other parameters with a cursor)', async () => {
    const { client, calls } = make([json(emptyOrders)])
    await client.listOrders({ ...WINDOW, cursor: 'abc' })
    expect([...calls[0]!.url.searchParams.keys()]).toEqual(['cursor'])
    await client.listTransactions({ ...WINDOW, cursor: 'xyz' })
    expect([...calls[1]!.url.searchParams.keys()]).toEqual(['cursor'])
  })

  it('uses /v1/contacts with pageSize, and /1.0/commerce/transactions with orderId', async () => {
    const { client, calls } = make([
      json({ contacts: [], pagination: {} }),
      json({ documents: [], pagination: {} }),
    ])
    await client.listContacts({})
    expect(calls[0]!.url.pathname).toBe('/v1/contacts')
    expect(calls[0]!.url.searchParams.get('pageSize')).toBe('500')
    await client.listTransactionsForOrder('o1')
    expect(calls[1]!.url.pathname).toBe('/1.0/commerce/transactions')
    expect(calls[1]!.url.searchParams.get('orderId')).toBe('o1')
  })

  it('refuses to start without a User-Agent (Squarespace rejects such requests)', () => {
    expect(
      () =>
        new SquarespaceClient({
          auth: { kind: 'api_key', apiKey: 'k' },
          clock: new FixedClock(NOW),
          sleeper: new FakeSleeper(new FixedClock(NOW)),
          userAgent: ' ',
        }),
    ).toThrow(/User-Agent/)
  })

  it('collects unmappable rows in page.rejected instead of failing the page', async () => {
    const orders = fixture<unknown[]>('orders.json')
    const { client } = make([
      json({
        pagination: { hasNextPage: false },
        result: [orders[0], { id: 'bad', orderNumber: 1 }, orders[1]],
      }),
      json({ documents: [fixture<unknown[]>('transactions.json')[0], { id: 'baddoc' }], pagination: {} }),
    ])
    const page = await client.listOrders(WINDOW)
    expect(page.items.map((o) => o.orderNumber)).toEqual(['20457', '20512'])
    expect(page.rejected).toHaveLength(1)
    expect(page.rejected![0]).toMatchObject({ id: 'bad' })
    const t = await client.listTransactions(WINDOW)
    expect(t.items).toHaveLength(1)
    expect(t.rejected![0]!.id).toBe('baddoc')
  })
})

describe('rate limiting (429)', () => {
  it('honours Retry-After seconds with the injected sleeper, then succeeds', async () => {
    const { client, sleeper } = make([
      json({ type: 'TOO_MANY_REQUESTS_ERROR' }, 429, { 'Retry-After': '17' }),
      json(emptyOrders),
    ])
    await client.listOrders(WINDOW)
    expect(sleeper.sleeps).toEqual([17_000])
    expect(client.requestCount).toBe(2)
  })

  it('falls back to the documented one-minute cool down when there is no Retry-After', async () => {
    const { client, sleeper } = make([json({}, 429), json(emptyOrders)])
    await client.listOrders(WINDOW)
    expect(sleeper.sleeps).toEqual([60_000])
  })

  it('accepts an HTTP-date Retry-After', async () => {
    const date = new Date(Date.parse(NOW) + 5_000).toUTCString()
    const { client, sleeper } = make([json({}, 429, { 'Retry-After': date }), json(emptyOrders)])
    await client.listOrders(WINDOW)
    expect(sleeper.sleeps[0]).toBeGreaterThanOrEqual(4_000)
    expect(sleeper.sleeps[0]).toBeLessThanOrEqual(5_000)
  })

  it('gives up with SquarespaceRateLimitError after max429Retries consecutive 429s', async () => {
    const { client } = make(
      [json({ type: 'TOO_MANY_REQUESTS_ERROR', message: 'slow down' }, 429, { 'Retry-After': '1' })],
      { max429Retries: 2 },
    )
    const err = await client.listOrders(WINDOW).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SquarespaceRateLimitError)
    expect((err as SquarespaceRateLimitError).retryAfterMs).toBe(1000)
    expect(client.requestCount).toBe(3)
  })

  it('a 429 cools down every later request too (shared limiter), not just the failed one', async () => {
    const { client, sleeper, clock } = make([
      json({}, 429, { 'Retry-After': '30' }),
      json(emptyOrders),
      json(emptyOrders),
    ])
    await client.listOrders(WINDOW)
    const t = clock.now().getTime()
    await client.listOrders(WINDOW)
    expect(clock.now().getTime()).toBe(t)
    expect(sleeper.sleeps).toEqual([30_000])
  })

  it('end to end against the simulator rate limiter: 7 requests under a 5/min budget never see a 429', async () => {
    const r = rig()
    loadFixtures(r.store)
    r.api.setRateLimit({ maxPerWindow: 5, windowMs: 60_000, cooldownMs: 60_000 })
    const client = clientFor(r, {
      limiter: new SlidingWindowLimiter(r.clock, r.sleeper, 5, 60_000),
    })
    for (let i = 0; i < 7; i++) await client.listContacts({})
    expect(r.api.log.filter((l) => l.status === 429)).toHaveLength(0)
    expect(r.sleeper.totalSleptMs).toBeGreaterThan(0)
  })

  it('an unthrottled client against the same sim limiter is recovered by 429 handling', async () => {
    const r = rig()
    loadFixtures(r.store)
    r.api.setRateLimit({ maxPerWindow: 3, windowMs: 60_000, cooldownMs: 60_000 })
    const client = clientFor(r, { limiter: new SlidingWindowLimiter(r.clock, r.sleeper, 1000, 60_000) })
    for (let i = 0; i < 5; i++) await client.listContacts({})
    const statuses = r.api.log.map((l) => l.status)
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0)
    expect(statuses.filter((s) => s === 200)).toHaveLength(5)
  })
})

describe('limiter', () => {
  it('spreads requests across the window by sleeping until the oldest stamp expires', async () => {
    const clock = new FixedClock(NOW)
    const sleeper = new FakeSleeper(clock)
    const limiter = new SlidingWindowLimiter(clock, sleeper, 3, 60_000)
    for (let i = 0; i < 3; i++) await limiter.acquire()
    expect(sleeper.sleeps).toEqual([])
    await limiter.acquire()
    expect(sleeper.sleeps).toEqual([60_000])
    expect(limiter.acquired).toBe(4)
  })

  it('parseRetryAfter handles seconds, dates, garbage', () => {
    const now = new Date(NOW)
    expect(parseRetryAfter('120', now)).toBe(120_000)
    expect(parseRetryAfter('1.5', now)).toBe(1500)
    expect(parseRetryAfter('soon', now)).toBeUndefined()
    expect(parseRetryAfter(null, now)).toBeUndefined()
    expect(parseRetryAfter(new Date(now.getTime() - 5000).toUTCString(), now)).toBe(0)
  })
})

describe('errors and retries', () => {
  it('retries 5xx with exponential backoff and then succeeds', async () => {
    const { client, sleeper } = make([
      json({ type: 'SERVER_ERROR' }, 503),
      json({ type: 'SERVER_ERROR' }, 500),
      json(emptyOrders),
    ])
    await client.listOrders(WINDOW)
    expect(sleeper.sleeps).toEqual([500, 1000])
  })

  it('stops after maxAttempts and throws the API error with its context id', async () => {
    const { client, sleeper } = make(
      [json({ type: 'SERVER_ERROR', message: 'boom', contextId: 'CTX1' }, 502)],
      { maxAttempts: 3 },
    )
    const err = await client.listOrders(WINDOW).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SquarespaceApiError)
    expect((err as SquarespaceApiError).status).toBe(502)
    expect((err as Error).message).toMatch(/CTX1/)
    expect(sleeper.sleeps).toEqual([500, 1000])
  })

  it('retries network failures, then wraps the last one', async () => {
    const ok = make([new TypeError('fetch failed'), json(emptyOrders)])
    await ok.client.listOrders(WINDOW)
    expect(ok.sleeper.sleeps).toEqual([500])
    const bad = make([new TypeError('fetch failed')], { maxAttempts: 2 })
    await expect(bad.client.listOrders(WINDOW)).rejects.toBeInstanceOf(SquarespaceNetworkError)
  })

  it('does not retry 400, 402, 403 or 404', async () => {
    for (const status of [400, 402, 403, 404]) {
      const { client, calls } = make([json({ type: 'X', message: 'nope' }, status)])
      await expect(client.listOrders(WINDOW)).rejects.toBeInstanceOf(SquarespaceApiError)
      expect(calls).toHaveLength(1)
    }
    const { client } = make([json({}, 403)])
    await expect(client.listOrders(WINDOW)).rejects.toBeInstanceOf(SquarespacePermissionError)
  })

  it('401 with an API key is a SquarespaceAuthError, never retried', async () => {
    const { client, calls } = make([json({ type: 'AUTHORIZATION_ERROR' }, 401)])
    await expect(client.listOrders(WINDOW)).rejects.toBeInstanceOf(SquarespaceAuthError)
    expect(calls).toHaveLength(1)
  })

  it('401 with OAuth refreshes once and retries with the new token', async () => {
    let token = 'old'
    const tokens = {
      getAccessToken: async () => token,
      refreshAfterUnauthorized: vi.fn(async () => {
        token = 'new'
        return token
      }),
    }
    const { client, calls } = make(
      [(c) => (c.headers.get('authorization') === 'Bearer new' ? json(emptyOrders) : json({}, 401))],
      { auth: { kind: 'oauth', tokens } },
    )
    await client.listOrders(WINDOW)
    expect(tokens.refreshAfterUnauthorized).toHaveBeenCalledTimes(1)
    expect(calls.map((c) => c.headers.get('authorization'))).toEqual(['Bearer old', 'Bearer new'])
    const stuck = make([json({}, 401)], { auth: { kind: 'oauth', tokens: new StaticTokenProvider('x') } })
    await expect(stuck.client.listOrders(WINDOW)).rejects.toBeInstanceOf(SquarespaceAuthError)
  })

  it('reports each attempt through onRequest', async () => {
    const seen: (number | undefined)[] = []
    const { client } = make([json({}, 500), json(emptyOrders)], { onRequest: (i) => seen.push(i.status) })
    await client.listOrders(WINDOW)
    expect(seen).toEqual([500, 200])
  })
})

describe('against the simulator over its HTTP surface', () => {
  it('rejects a bad API key and a missing User-Agent like the real service', async () => {
    const r = rig()
    await expect(
      clientFor(r, { auth: { kind: 'api_key', apiKey: 'nope' } }).listOrders(WINDOW),
    ).rejects.toBeInstanceOf(SquarespaceAuthError)
    const noUa = await r.api.handle({
      method: 'GET',
      path: '/1.0/commerce/orders',
      query: new URLSearchParams(),
      headers: { authorization: `Bearer ${API_KEY}` },
    })
    expect(noUa.status).toBe(400)
  })

  it('injected failures: 500s are retried, a 429 with Retry-After is waited out', async () => {
    const r = rig()
    loadFixtures(r.store)
    r.api.injectFailure({ status: 500, times: 2 })
    r.api.injectFailure({ status: 429, times: 1, retryAfterSeconds: 12 })
    const page = await clientFor(r).listOrders(WINDOW)
    expect(page.items.length).toBeGreaterThan(0)
    expect(r.sleeper.sleeps).toContain(12_000)
    expect(r.api.log.map((l) => l.status)).toEqual([500, 500, 429, 200])
  })

  it('the sim enforces the documented parameter rules', async () => {
    const r = rig()
    const q = (s: string) =>
      r.api.handle({
        method: 'GET',
        path: '/1.0/commerce/orders',
        query: new URLSearchParams(s),
        headers: { authorization: `Bearer ${API_KEY}`, 'user-agent': 'x' },
      })
    expect((await q('modifiedAfter=2026-01-01T00:00:00.000Z')).status).toBe(400)
    expect((await q('cursor=abc')).status).toBe(400)
    expect(
      (await q('modifiedAfter=2026-01-01T00:00:00.000Z&modifiedBefore=2026-02-01T00:00:00.000Z')).status,
    ).toBe(200)
    const page = await drain((c) => clientFor(r).listOrders({ ...WINDOW, cursor: c }))
    expect(page.items).toEqual([])
    // cursor plus another parameter
    loadFixtures(r.store)
    const first = (await q('modifiedAfter=2026-01-01T00:00:00.000Z&modifiedBefore=2026-12-01T00:00:00.000Z'))
      .body as { pagination: { nextPageCursor: string } }
    expect(
      (await q(`cursor=${first.pagination.nextPageCursor}&modifiedAfter=2026-01-01T00:00:00.000Z`)).status,
    ).toBe(400)
  })

  it('default order filter hides PARTIALLY_PAID unless asked (documented API default)', async () => {
    const r = rig({ pageSize: 50 })
    loadFixtures(r.store)
    const q = (s: string) =>
      r.api.handle({
        method: 'GET',
        path: '/1.0/commerce/orders',
        query: new URLSearchParams(s),
        headers: { authorization: `Bearer ${API_KEY}`, 'user-agent': 'x' },
      })
    const win = 'modifiedAfter=2026-01-01T00:00:00.000Z&modifiedBefore=2026-12-01T00:00:00.000Z'
    const dflt = (await q(win)).body as { result: unknown[] }
    const all = (await q(`${win}&paymentStates=PARTIALLY_PAID,PAID,REFUNDED,NOT_CHARGED`)).body as {
      result: unknown[]
    }
    expect(dflt.result).toHaveLength(8)
    expect(all.result).toHaveLength(9)
  })
})
