// The Square client's rules: headers, typed errors, and which calls may be repeated (GETs, read-only POSTs and keyed creates on
// network errors, timeouts, 429 and 5xx; other writes only when the request surely never left), observe-only, and no token anywhere.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createSquareApi } from '../../src/integrations/square/api/index.js'
import { SquareClient, type SquareRequestInfo } from '../../src/integrations/square/client.js'
import {
  SquareAuthError,
  SquareDeclined,
  SquareIdempotencyReused,
  SquareNetworkError,
  SquareNotFound,
  SquareRateLimited,
  SquareWireError,
  SquareWritesDisabled,
  declineText,
} from '../../src/integrations/square/errors.js'
import { sqKey } from '../../src/integrations/square/keys.js'
import { usd } from '../../src/integrations/square/money.js'

const TOKEN = 'test-token-not-real-abcdef'
type Step = { status: number; body?: unknown; headers?: Record<string, string> } | { throw: unknown }

function harness(steps: Step[], o: { writesEnabled?: boolean; maxAttempts?: number } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const sleeps: number[] = []
  const infos: SquareRequestInfo[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} })
    const s = steps.shift()
    if (!s) throw new Error('no more scripted answers')
    if ('throw' in s) throw s.throw
    return new Response(s.body === undefined ? '' : JSON.stringify(s.body), { status: s.status, headers: s.headers })
  }
  const client = new SquareClient({
    baseUrl: 'https://connect.squareupsandbox.com/',
    accessToken: TOKEN,
    fetch: fetchImpl,
    sleeper: { sleep: async (ms) => void sleeps.push(ms) },
    backoffBaseMs: 100,
    maxAttempts: o.maxAttempts ?? 4,
    writesEnabled: o.writesEnabled,
    onRequest: (i) => infos.push(i),
  })
  return { client, api: createSquareApi(client), calls, sleeps, infos }
}

const payment = { id: 'P1', status: 'COMPLETED', created_at: '2026-10-12T13:00:00Z', amount_money: usd(100) }
const refused = (code: string, category = 'INVALID_REQUEST_ERROR', status = 400) => ({ status, body: { errors: [{ category, code, detail: `${code} detail` }] } })
const netError = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } })
const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')

describe('SquareClient', () => {
  it('sends Bearer, the pinned Square-Version and JSON to /v2, and validates the answer', async () => {
    const h = harness([{ status: 200, body: { payment } }])
    expect(await h.api.payments.get('P 1')).toMatchObject({ id: 'P1', status: 'COMPLETED' })
    expect(h.calls[0]!.url).toBe('https://connect.squareupsandbox.com/v2/payments/P%201')
    const headers = h.calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(headers['Square-Version']).toBe('2026-09-16')
    expect(h.calls[0]!.init.method).toBe('GET')
  })

  it('repeats a GET on 500, a timeout and a reset, with backoff', async () => {
    const h = harness([{ status: 500, body: { errors: [] } }, { throw: timeout() }, { throw: netError('ECONNRESET') }, { status: 200, body: { payment } }])
    expect((await h.api.payments.get('P1')).id).toBe('P1')
    expect(h.calls).toHaveLength(4)
    expect(h.sleeps).toHaveLength(3)
    expect(h.sleeps[1]!).toBeGreaterThanOrEqual(h.sleeps[0]!)
  })

  it('repeats a keyed create on 429 (honouring Retry-After) and 503 with the same key and body', async () => {
    const h = harness([
      { status: 429, body: { errors: [{ category: 'RATE_LIMIT_ERROR', code: 'RATE_LIMITED' }] }, headers: { 'retry-after': '2' } },
      { status: 503, body: {} },
      { status: 200, body: { payment } },
    ])
    const key = sqKey('ch', '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b')
    await h.api.payments.create(key, { source_id: 'ccof:1', amount_money: usd(100), location_id: 'L1' })
    expect(h.calls).toHaveLength(3)
    expect(h.sleeps[0]).toBe(2000)
    const bodies = h.calls.map((c) => JSON.parse(String(c.init.body)) as { idempotency_key: string })
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1)
    expect(bodies[0]!.idempotency_key).toBe(key)
  })

  it('a write without a key is not repeated on 500 or a timeout, only when the request surely never left', async () => {
    const h1 = harness([{ status: 500, body: { errors: [{ category: 'API_ERROR', code: 'INTERNAL_SERVER_ERROR' }] } }])
    await expect(h1.api.payments.cancel('P1')).rejects.toMatchObject({ status: 500 })
    expect(h1.calls).toHaveLength(1)
    const h2 = harness([{ throw: timeout() }])
    const e = await h2.api.subscriptions.pause('S1').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(SquareNetworkError)
    expect((e as SquareNetworkError).sent).toBe(true)
    expect(h2.calls).toHaveLength(1)
    const h3 = harness([{ throw: netError('ECONNREFUSED') }, { throw: netError('ENOTFOUND') }, { status: 200, body: { card: { id: 'C1', enabled: false } } }])
    expect(await h3.api.cards.disable('C1')).toMatchObject({ id: 'C1', enabled: false })
    expect(h3.calls).toHaveLength(3)
  })

  it('a read-only POST (search) is repeated like a GET', async () => {
    const h = harness([{ status: 502, body: {} }, { status: 200, body: { customers: [{ id: 'K1' }] } }])
    expect((await h.api.customers.search({ reference_id: 'abc' })).items.map((c) => c.id)).toEqual(['K1'])
    expect(JSON.parse(String(h.calls[0]!.init.body))).toEqual({ query: { filter: { reference_id: { exact: 'abc' } } }, limit: 100 })
  })

  it('gives typed errors: auth, decline (with the friendly text), idempotency reuse, rate limit, not found', async () => {
    const one = async (s: Step, call: (a: ReturnType<typeof harness>['api']) => Promise<unknown>) => {
      const h = harness([s], { maxAttempts: 1 })
      return call(h.api).catch((e: unknown) => e)
    }
    const key = sqKey('ch', 'x')
    const pay = (a: ReturnType<typeof harness>['api']) => a.payments.create(key, { source_id: 'cnon:x', amount_money: usd(1), location_id: 'L' })
    expect(await one(refused('UNAUTHORIZED', 'AUTHENTICATION_ERROR', 401), pay)).toBeInstanceOf(SquareAuthError)
    expect(await one(refused('ACCESS_TOKEN_EXPIRED', 'AUTHENTICATION_ERROR', 401), pay)).toBeInstanceOf(SquareAuthError)
    const declined = await one(refused('CVV_FAILURE', 'PAYMENT_METHOD_ERROR'), pay)
    expect(declined).toBeInstanceOf(SquareDeclined)
    expect((declined as SquareDeclined).friendly).toBe('The security code did not match. Please check it and try again.')
    expect(declineText('SOMETHING_NEW')).toBe('The payment did not go through. Please try another card.')
    expect(await one(refused('IDEMPOTENCY_KEY_REUSED'), pay)).toBeInstanceOf(SquareIdempotencyReused)
    expect(await one({ status: 429, body: { errors: [{ code: 'RATE_LIMITED' }] } }, pay)).toBeInstanceOf(SquareRateLimited)
    expect(await one(refused('NOT_FOUND', 'INVALID_REQUEST_ERROR', 404), (a) => a.payments.get('P9'))).toBeInstanceOf(SquareNotFound)
  })

  it('"already done" answers resolve instead of throwing: a gone link, a pending cancel', async () => {
    const h = harness([refused('NOT_FOUND', 'INVALID_REQUEST_ERROR', 404)])
    expect(await h.api.checkout.deleteLink('L1')).toBe(false)
    const h2 = harness([{ status: 400, body: { errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'BAD_REQUEST', detail: 'The provided subscription `S1` already has a pending cancel date of `2026-11-12`.' }] } }])
    expect(await h2.api.subscriptions.cancel('S1')).toBeNull()
    const h3 = harness([{ status: 400, body: { errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'BAD_REQUEST', detail: 'something else' }] } }])
    await expect(h3.api.subscriptions.cancel('S1')).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('observe-only refuses every change before sending; reads, searches and setup calls still go', async () => {
    const h = harness([{ status: 200, body: { customers: [] } }, { status: 200, body: {} }, { status: 200, body: { payment } }], { writesEnabled: false })
    await expect(h.api.payments.create(sqKey('ch', 'x'), { source_id: 's', amount_money: usd(1), location_id: 'L' })).rejects.toBeInstanceOf(SquareWritesDisabled)
    await expect(h.api.subscriptions.cancel('S1')).rejects.toBeInstanceOf(SquareWritesDisabled)
    await expect(h.api.checkout.deleteLink('L1')).rejects.toBeInstanceOf(SquareWritesDisabled)
    expect(h.calls).toHaveLength(0)
    await h.api.customers.search({ reference_id: 'x' })
    await h.api.events.enable()
    await h.api.payments.get('P1')
    expect(h.calls.map((c) => c.init.method)).toEqual(['POST', 'PUT', 'GET'])
  })

  it('a 2xx with the wrong shape is a wire error; a key missing from the body is refused before sending', async () => {
    const h = harness([{ status: 200, body: { payment: { id: 'P1' } } }])
    await expect(h.api.payments.get('P1')).rejects.toBeInstanceOf(SquareWireError)
    const h2 = harness([])
    await expect(
      h2.client.request({ method: 'POST', path: '/v2/payments', body: { idempotency_key: 'other' }, idempotencyKey: sqKey('ch', 'x'), schema: z.object({}) }),
    ).rejects.toThrow(/the idempotency key is not in the body/)
    await expect(h2.client.request({ method: 'GET', path: '/payments', schema: z.object({}) })).rejects.toThrow(/must start with \/v2\//)
  })

  it('never puts the token in an error, a log line or the request record', async () => {
    const h = harness([refused('UNAUTHORIZED', 'AUTHENTICATION_ERROR', 401), { throw: netError('ECONNREFUSED') }], { maxAttempts: 1 })
    const e1 = await h.api.payments.get('P1').catch((e: unknown) => e as Error)
    const e2 = await h.api.payments.get('P1').catch((e: unknown) => e as Error)
    for (const text of [e1.message, e2.message, JSON.stringify(e1), JSON.stringify(h.infos), String(e2.stack)]) expect(text).not.toContain(TOKEN)
    expect(h.infos[0]).toMatchObject({ method: 'GET', path: '/v2/payments/P1', attempt: 1, status: 401 })
  })
})
