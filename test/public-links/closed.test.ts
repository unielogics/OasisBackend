// PUBLIC_LINKS_ENABLED=false (the production default): every personal-link route answers exactly what an unknown route answers, 404
// ROUTE_NOT_FOUND, before validation and before any limit, session lookup or record; nothing else of the API changes.
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { json, useLinksHarness } from './harness.js'

const h = useLinksHarness({ env: { PUBLIC_LINKS_ENABLED: 'false' } })

const ROUTES: ['GET' | 'POST', string, unknown][] = [
  ['POST', 'exchange', { token: 'x'.repeat(43) }],
  ['POST', 'exchange', { nonsense: true }],
  ['GET', 'me', undefined],
  ['GET', 'availability?days=99&junk=1', undefined],
  ['POST', 'verify/code', { purpose: 'verify', phone: '+12015550129' }],
  ['POST', 'verify/code/confirm', { challengeId: 'nope', code: '1' }],
  ['POST', 'verify/pin', { pin: '1' }],
  ['POST', 'pin', { pin: '1' }],
  ['POST', 'pin/reset', {}],
  ['POST', 'bookings', { serviceKey: 1 }],
  ['POST', 'appointments/OAS-00001/reschedule', {}],
  ['POST', 'membership/start', { email: 'not-an-email' }],
  ['POST', 'pay/start', { extra: 1 }],
]

// the date, request id, body length (the problem names the path) and the shared address counter differ per request
const PER_REQUEST = /^(date|x-request-id|content-length|x-ratelimit-.*|retry-after)$/
const headersOf = (r: { headers: Record<string, unknown> }) => Object.fromEntries(Object.entries(r.headers).filter(([k]) => !PER_REQUEST.test(k)))

describe('personal links closed', () => {
  it('answers every route like an unknown route: 404 ROUTE_NOT_FOUND, no no-store header, nothing validated, limited or written', async () => {
    const unknown = await h.call('POST', 'no-such-route', { body: {} })
    expect(unknown.statusCode).toBe(404)
    for (const [method, path, body] of ROUTES) {
      const r = await h.call(method, path, { body, session: 'A'.repeat(43), key: h.nextKey() })
      expect(r.statusCode, `${method} ${path} ${r.body}`).toBe(404)
      expect(json(r)).toMatchObject({ code: 'ROUTE_NOT_FOUND', status: 404, title: json(unknown).title, detail: json(unknown).detail })
      expect(r.headers['cache-control'], path).toBeUndefined()
      expect(r.headers['content-type']).toBe(unknown.headers['content-type'])
      // the same headers as an unknown route (no X-API-Version that would tell a prober the path exists), apart from per-request ones
      expect(headersOf(r), `${method} ${path}`).toEqual(headersOf(unknown))
    }
    const counts = await sql<{ limits: number; sessions: number; keys: number }>`select
      (select count(*)::int from public_rate_limits) as limits,
      (select count(*)::int from client_link_sessions) as sessions,
      (select count(*)::int from idempotency_keys) as keys`.execute(h.db)
    expect(counts.rows[0]).toEqual({ limits: 0, sessions: 0, keys: 0 })
  })

  it('a real link cannot be opened while the routes are closed, and the website’s routes are unchanged', async () => {
    const id = await h.customer()
    const link = await h.link({ customerId: id })
    const r = await h.call('POST', 'exchange', { body: { token: link.token } })
    expect(r.statusCode).toBe(404)
    expect(await h.db.selectFrom('client_link_sessions').selectAll().execute()).toEqual([])
    for (const path of ['/api/v1/public/hours', '/api/v1/public/catalog'])
      expect((await h.t.app.inject({ method: 'GET', url: path })).statusCode, path).toBe(200)
  })
})
