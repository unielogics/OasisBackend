// The personal-link API as declared (ADR 0160, design section 5): exactly these routes under /api/v1/public/links/, every one public
// with a reason, an Idempotency-Key on the booking, the `public-links` tag in the OpenAPI document with no cookie security.
import { describe, expect, it } from 'vitest'
import { describeAccess } from '../../src/http/access.js'
import { json, useLinksHarness } from './harness.js'

const h = useLinksHarness()

const EXPECTED: [string, string, 'required' | undefined][] = [
  ['POST', '/api/v1/public/links/exchange', undefined],
  ['GET', '/api/v1/public/links/me', undefined],
  ['GET', '/api/v1/public/links/availability', undefined],
  ['POST', '/api/v1/public/links/verify/code', undefined],
  ['POST', '/api/v1/public/links/verify/code/confirm', undefined],
  ['POST', '/api/v1/public/links/verify/pin', undefined],
  ['POST', '/api/v1/public/links/pin', undefined],
  ['POST', '/api/v1/public/links/pin/reset', undefined],
  ['POST', '/api/v1/public/links/bookings', 'required'],
  ['POST', '/api/v1/public/links/appointments/:ref/reschedule', undefined],
  ['POST', '/api/v1/public/links/membership/start', undefined],
  ['POST', '/api/v1/public/links/pay/start', undefined],
  ['POST', '/api/v1/public/links/deposit/start', undefined],
  ['POST', '/api/v1/public/links/cards', 'required'],
  ['DELETE', '/api/v1/public/links/cards/:cardId', undefined],
  ['POST', '/api/v1/public/links/membership/subscribe', undefined],
  ['GET', '/api/v1/public/links/membership/status', undefined],
]

describe('the personal-link API contract', () => {
  it('declares exactly the expected routes, each public with a reason, and the booking’s Idempotency-Key', () => {
    const registered = h.t.app.routeRegistry.filter((r) => r.url.startsWith('/api/v1/public/links/'))
    expect(new Set(registered.map((r) => `${r.method} ${r.url}`))).toEqual(new Set(EXPECTED.map(([m, u]) => `${m} ${u}`)))
    for (const [method, url, idem] of EXPECTED) {
      const r = registered.find((x) => x.method === method && x.url === url)!
      expect(describeAccess(r.access), `${method} ${url}`).toBe('public')
      expect(r.access.kind === 'public' && r.access.reason.length > 30, `${method} ${url} reason`).toBe(true)
      expect(r.idempotency, `${method} ${url}`).toBe(idem)
      expect(r.tags, `${method} ${url}`).toEqual(['public-links'])
    }
  })

  it('documents them in the OpenAPI document as public, without cookie security', async () => {
    const r = await h.t.app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
    const spec = json(r) as { paths: Record<string, Record<string, Record<string, unknown>>> }
    for (const [method, url, idem] of EXPECTED) {
      const op = spec.paths[url.replace(/:(\w+)/g, '{$1}')]?.[method.toLowerCase()]
      expect(op, `${method} ${url}`).toBeDefined()
      expect(op!['x-oasis-access']).toBe('public')
      expect(op!.security).toEqual([])
      if (idem) expect(op!['x-oasis-idempotency']).toBe('required')
    }
  })
})
