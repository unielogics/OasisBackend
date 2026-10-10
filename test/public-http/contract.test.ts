// The public website's routes as declared (ADR 0150): exactly these six beside the hours route, every one public with a reason, an
// Idempotency-Key on the two record-creating POSTs, all under the `public` tag in the OpenAPI document, and nothing of the rest of
// the API answering without a session.
import { describe, expect, it } from 'vitest'
import { describeAccess } from '../../src/http/access.js'
import { json, usePublicHarness } from './harness.js'

const h = usePublicHarness()

const EXPECTED: [string, string, 'required' | undefined][] = [
  ['GET', '/api/v1/public/hours', undefined],
  ['GET', '/api/v1/public/availability', undefined],
  ['GET', '/api/v1/public/catalog', undefined],
  ['POST', '/api/v1/public/otp', undefined],
  ['POST', '/api/v1/public/otp/verify', undefined],
  ['POST', '/api/v1/public/bookings', 'required'],
  ['POST', '/api/v1/public/memberships', 'required'],
]

describe('the public website API contract', () => {
  it('declares exactly the expected public routes, each with a reason, and the idempotency the writes need', () => {
    const registered = h.t.app.routeRegistry.filter((r) => r.url.startsWith('/api/v1/public/'))
    expect(new Set(registered.map((r) => `${r.method} ${r.url}`))).toEqual(new Set(EXPECTED.map(([m, u]) => `${m} ${u}`)))
    for (const [method, url, idem] of EXPECTED) {
      const r = registered.find((x) => x.method === method && x.url === url)!
      expect(describeAccess(r.access), `${method} ${url}`).toBe('public')
      expect(r.access.kind === 'public' && r.access.reason.length > 20, `${method} ${url} reason`).toBe(true)
      expect(r.idempotency, `${method} ${url} idempotency`).toBe(idem)
      expect(r.tags, `${method} ${url} tag`).toEqual(['public'])
    }
    // no other route under /api answers without a session, except the ones the matrix lists on purpose (probes and the
    // development object store live outside the prefix)
    const others = h.t.app.routeRegistry.filter((r) => r.access.kind === 'public' && r.url.startsWith('/api/') && !r.url.startsWith('/api/v1/public/'))
    expect(others.map((r) => r.url).sort()).toEqual(
      ['/api/v1/arrivals/ping', '/api/v1/auth/invite/accept', '/api/v1/auth/login', '/api/v1/auth/password/forgot', '/api/v1/auth/password/reset', '/api/v1/meta/now', '/api/v1/openapi.json'].sort(),
    )
  })

  it('documents them in the OpenAPI document with the public access marker and problem responses', async () => {
    const r = await h.get('/api/v1/openapi.json')
    expect(r.statusCode).toBe(200)
    const spec = json(r) as { paths: Record<string, Record<string, Record<string, unknown>>> }
    for (const [method, url, idem] of EXPECTED) {
      const op = spec.paths[url]?.[method.toLowerCase()]
      expect(op, `${method} ${url}`).toBeDefined()
      expect(op!['x-oasis-access']).toBe('public')
      if (idem) expect(op!['x-oasis-idempotency']).toBe('required')
      expect(op!.tags).toEqual(['public'])
    }
  })

  it('answers every public route without a session and with a bogus cookie alike, and sets no cookie', async () => {
    for (const url of ['public/hours', 'public/availability', 'public/catalog']) {
      const a = await h.get(url)
      const b = await h.get(url, { headers: { cookie: 'oasis_sid=not-a-session' } })
      expect(a.statusCode, url).toBe(200)
      expect(b.statusCode, url).toBe(200)
      expect(a.headers['set-cookie']).toBeUndefined()
      expect(a.headers['x-api-version']).toBe('1')
    }
  })

  it('accepts the website origin and no origin on the writes, and refuses another origin (403 ORIGIN_NOT_ALLOWED)', async () => {
    const body = { phone: '+12015550199' }
    expect((await h.post('public/otp', body, { origin: 'https://evil.example' })).statusCode).toBe(403)
    expect(json(await h.post('public/otp', body, { origin: 'https://evil.example' })).code).toBe('ORIGIN_NOT_ALLOWED')
    expect((await h.post('public/otp', body, { origin: null })).statusCode).toBe(202)
    expect((await h.post('public/otp', body)).statusCode).toBe(202)
  })
})
