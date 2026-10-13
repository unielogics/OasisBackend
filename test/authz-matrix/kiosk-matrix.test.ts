// The kiosk side of the authz matrix (ADR 0180), generated from the route registry and the kiosk route list, so a new route is covered
// the moment it is registered:
//   not on the list           -> 403 KIOSK_FORBIDDEN (the account routes: 403 KIOSK_SESSION), even with an acting employee
//   on the list, 'actor'      -> 428 without X-Oasis-Employee, 422 with an unknown one, never 401/403 with a valid one,
//                                403 CSRF_INVALID without the CSRF token
//   on the list, 'none'       -> never 401/403/428; unsafe ones still need the CSRF token
//   the API contract marks exactly the listed operations x-oasis-kiosk; a bad entry stops the app from starting
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { RouteRecord } from '../../src/http/access.js'
import { apiModules } from '../../src/http/modules.js'
import {
  checkKioskAllowlist,
  KIOSK_ROUTES,
  KIOSK_SESSION_ROUTES,
  kioskRouteKey,
} from '../../src/modules/kiosk/allowlist.js'
import { createTestApp } from '../helpers/app.js'
import { createTestDb } from '../helpers/db.js'
import { useHarness } from '../auth/harness.js'

const NIL = '00000000-0000-7000-8000-000000000000'
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const fill = (url: string): string =>
  url.replace(/:(\w+)/g, (_m, name: string) =>
    name === 'key' ? 'sched.view' : name === 'kind' ? 'refund' : name === 'id' || name.endsWith('Id') ? NIL : 'x',
  )
const label = (r: RouteRecord): string => `${r.method} ${r.url}`
const codeOf = (res: { statusCode: number; body: string; headers: Record<string, unknown> }): string | undefined =>
  res.statusCode >= 400 && String(res.headers['content-type']).includes('json')
    ? (JSON.parse(res.body) as { code?: string }).code
    : undefined

describe('authz matrix: a kiosk (generated from the route registry and the kiosk route list)', () => {
  const h = useHarness({ env: { RATE_LIMIT_PER_MIN: '1000000' } })

  it('covers every registered route', async () => {
    const routes = [...h.t.app.routeRegistry].filter((r) => !['/healthz', '/readyz'].includes(r.url))
    const { device, kiosk: first } = await h.kioskSetup()
    const marco = await h.createUser({ email: 'marco@example.test', first: 'Marco', last: 'Rossi', roles: ['crew'] })
    let kiosk = first
    let ip = 0
    const addr = () => `10.50.${Math.floor(ip / 200)}.${(ip++ % 200) + 1}`

    const failures: string[] = []
    const check = (what: string, r: RouteRecord, res: { statusCode: number; body: string }, ok: boolean) => {
      if (!ok) failures.push(`${label(r)} ${what}: got ${res.statusCode} ${res.body.slice(0, 160)}`)
    }
    const counts = { forbidden: 0, session: 0, actor: 0, none: 0 }

    for (const r of routes) {
      if (r.access.kind === 'public' || r.access.kind === 'webhook') continue
      const method = r.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
      const url = fill(r.url)
      const key = kioskRouteKey(r.method, r.url)
      const body = UNSAFE.has(method) ? {} : undefined
      const mode = Object.hasOwn(KIOSK_ROUTES, key) ? KIOSK_ROUTES[key] : undefined

      if (!mode) {
        const res = await h.kioskCall(method, url, kiosk, { body, actor: marco.employeeId, ip: addr() })
        const want = KIOSK_SESSION_ROUTES.has(key) ? 'KIOSK_SESSION' : 'KIOSK_FORBIDDEN'
        counts[want === 'KIOSK_SESSION' ? 'session' : 'forbidden']++
        check(`not on the kiosk list (want ${want})`, r, res, res.statusCode === 403 && codeOf(res) === want)
        continue
      }

      if (mode === 'actor') {
        counts.actor++
        const none = await h.kioskCall(method, url, kiosk, { body, ip: addr() })
        check('without X-Oasis-Employee', r, none, none.statusCode === 428 && codeOf(none) === 'KIOSK_EMPLOYEE_REQUIRED')
        const bad = await h.kioskCall(method, url, kiosk, { body, actor: randomUUID(), ip: addr() })
        check('with an unknown employee', r, bad, bad.statusCode === 422 && codeOf(bad) === 'KIOSK_EMPLOYEE_INVALID')
      } else counts.none++

      const actor = mode === 'actor' ? marco.employeeId : undefined
      const ok = await h.kioskCall(method, url, kiosk, { body, actor, ip: addr() })
      check(
        'listed, with what it needs',
        r,
        ok,
        ok.statusCode !== 401 && ok.statusCode !== 403 && ok.statusCode !== 428 && !String(codeOf(ok)).startsWith('KIOSK_'),
      )
      if (key === 'POST /api/v1/kiosk/lock') kiosk = await h.unlock(device) // that call ended the session
      if (UNSAFE.has(method)) {
        const noCsrf = await h.kioskCall(method, url, kiosk, { body, actor, csrf: false, ip: addr() })
        check('without X-CSRF-Token', r, noCsrf, noCsrf.statusCode === 403 && codeOf(noCsrf) === 'CSRF_INVALID')
      }
    }
    expect(counts.actor).toBe(Object.values(KIOSK_ROUTES).filter((m) => m === 'actor').length)
    expect(counts.none).toBe(Object.values(KIOSK_ROUTES).filter((m) => m === 'none').length)
    expect(counts.session).toBe(KIOSK_SESSION_ROUTES.size)
    expect(counts.forbidden).toBeGreaterThan(150)
    expect(failures, failures.join('\n')).toEqual([])
  }, 300_000)

  it('the API contract marks exactly the listed operations with x-oasis-kiosk', async () => {
    const spec = h.t.app.swagger() as unknown as { paths: Record<string, Record<string, Record<string, unknown>>> }
    const marked: Record<string, unknown> = {}
    for (const [path, ops] of Object.entries(spec.paths))
      for (const [m, op] of Object.entries(ops))
        if (op['x-oasis-kiosk'] !== undefined) marked[`${m.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`] = op['x-oasis-kiosk']
    expect(marked).toEqual({ ...KIOSK_ROUTES })
  })

  it('the boot check accepts the real list and names every bad entry', () => {
    const records = h.t.app.routeRegistry
    expect(() => checkKioskAllowlist(records)).not.toThrow()
    expect(() => checkKioskAllowlist(records, { ...KIOSK_ROUTES, 'GET /api/v1/nope': 'none' })).toThrow(/GET \/api\/v1\/nope: no such route/)
    expect(() => checkKioskAllowlist(records, { 'POST /api/v1/invoices/:id/refunds': 'actor' })).toThrow(/cannot satisfy pay\.refund/)
    expect(() => checkKioskAllowlist(records, { 'GET /api/v1/settings/hours': 'none', 'GET /api/v1/payments/summary': 'none' })).toThrow(
      /payments\/summary: the kiosk cannot satisfy pay\.reports/,
    )
    expect(() => checkKioskAllowlist(records, { 'POST /api/v1/auth/login': 'none' })).toThrow(/public routes are not kiosk routes/)
    expect(() => checkKioskAllowlist(records, { 'GET /api/v1/appointments': 'actor' })).toThrow(/a read never needs/)
    expect(() => checkKioskAllowlist(records, { ...KIOSK_ROUTES, 'GET /api/v1/me': 'none' })).toThrow(/account route/)
  })
})

describe('the kiosk route list is checked at boot', () => {
  it('an entry that matches no route stops the app from starting', async () => {
    const testDb = await createTestDb({})
    try {
      await expect(
        createTestApp({
          testDb,
          modules: apiModules,
          deps: { kioskRoutes: { ...KIOSK_ROUTES, 'POST /api/v1/appointments/:id/teleport': 'actor' } },
        }),
      ).rejects.toThrow(/teleport: no such route/)
    } finally {
      await testDb.close()
    }
  })
})
