// The authz matrix is generated from the route registry, so a new route is covered the moment it is registered:
//   no session             -> 401 on every route that needs one (also with a bogus cookie)
//   lacking the permission -> 403 FORBIDDEN naming what was required (the user holds everything else)
//   holding exactly it     -> never 401 and never the permission 403 (business-rule 403s must be listed in GUARD_403)
//   unsafe method, valid session and permission, no CSRF token -> 403 CSRF_INVALID
// Public and webhook routes are listed so that adding one is a deliberate act in this file.
import { describe, expect, it } from 'vitest'
import type { RouteRecord } from '../../src/http/access.js'
import { PERMISSION_KEYS } from '../../src/modules/rbac/catalog.js'
import { useHarness, type TestUser } from '../auth/harness.js'

const NIL = '00000000-0000-7000-8000-000000000000'
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const PUBLIC_ROUTES = new Set([
  'GET /api/v1/meta/now',
  'GET /api/v1/openapi.json',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/invite/accept',
  'POST /api/v1/auth/password/forgot',
  'POST /api/v1/auth/password/reset',
  // the simulator object store (STORAGE_PROVIDER=fs, never production): every URL carries its own signature
  'GET /dev-storage/*',
  'POST /dev-storage/*',
  // the customer's phone has no session; the per-appointment link token authenticates it (ADR 0083)
  'POST /api/v1/arrivals/ping',
  // the public website's opening hours: computed from the Settings, no personal or operations data (ADR 0145)
  'GET /api/v1/public/hours',
])

/** 403 codes a permitted caller may still get from a business rule, keyed by "METHOD url". Empty with the generic {} body. */
const GUARD_403: Record<string, string[]> = {}

const fill = (url: string): string =>
  url.replace(/:(\w+)/g, (_m, name: string) =>
    name === 'key'
      ? 'sched.view'
      : name === 'kind'
        ? 'refund'
        : name === 'id' || name.endsWith('Id')
          ? NIL
          : 'x',
  )

const label = (r: RouteRecord): string => `${r.method} ${r.url}`

describe('authz matrix (generated from the route registry)', () => {
  const h = useHarness()

  it('covers every registered route', async () => {
    const routes = [...h.t.app.routeRegistry].filter((r) => !['/healthz', '/readyz'].includes(r.url))
    expect(routes.length).toBeGreaterThanOrEqual(25)

    const publics = routes.filter((r) => r.access.kind === 'public' || r.access.kind === 'webhook')
    expect(new Set(publics.map(label))).toEqual(PUBLIC_ROUTES)
    for (const r of routes) {
      if (r.access.kind === 'permission')
        for (const p of r.access.perms) expect(PERMISSION_KEYS, `${label(r)} names ${p}`).toContain(p)
    }

    // One user per distinct permission set; a fresh login per call because some routes (logout) consume the session.
    const users = new Map<string, TestUser>()
    let n = 0
    const userFor = async (key: string, perms: string[]): Promise<TestUser> => {
      const hit = users.get(key)
      if (hit) return hit
      const { user } = await h.userWithPermissions(perms, `matrix${n++}@example.test`)
      users.set(key, user)
      return user
    }
    let ip = 0
    const addr = () => `10.40.${Math.floor(ip / 200)}.${(ip++ % 200) + 1}`
    const session = (u: TestUser) => h.login(u, addr())

    const failures: string[] = []
    const check = (what: string, r: RouteRecord, res: { statusCode: number; body: string }, ok: boolean) => {
      if (!ok) failures.push(`${label(r)} ${what}: got ${res.statusCode} ${res.body.slice(0, 160)}`)
    }

    let covered = 0
    for (const r of routes) {
      if (r.access.kind === 'public' || r.access.kind === 'webhook') continue
      covered++
      const method = r.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
      const url = fill(r.url)
      const body = UNSAFE.has(method) ? {} : undefined

      const anon = await h.call(method, url, { body, ip: addr() })
      check('without a session', r, anon, anon.statusCode === 401)
      const bogus = await h.call(method, url, {
        body,
        session: { cookie: `${h.cookieName}=${'z'.repeat(43)}`, csrf: 'x' },
        ip: addr(),
      })
      check('with a bogus cookie', r, bogus, bogus.statusCode === 401)

      const required = r.access.kind === 'permission' ? r.access.perms : []
      const mode = r.access.kind === 'permission' ? r.access.mode : 'all'
      if (r.access.kind === 'permission') {
        const lacking =
          mode === 'all'
            ? PERMISSION_KEYS.filter((k) => k !== required[0])
            : PERMISSION_KEYS.filter((k) => !required.includes(k))
        const u = await userFor(`lack:${mode}:${required.join(',')}`, [...lacking])
        const denied = await h.call(method, url, { session: await session(u), body, ip: addr() })
        const parsed =
          denied.statusCode === 403
            ? (denied.json() as { code?: string; meta?: { required?: string[] } })
            : {}
        check(
          'lacking the permission',
          r,
          denied,
          parsed.code === 'FORBIDDEN' && JSON.stringify(parsed.meta?.required) === JSON.stringify(required),
        )
      }

      const holds = r.access.kind === 'permission' ? (mode === 'all' ? [...required] : [required[0]!]) : []
      const holder = await userFor(`hold:${mode}:${holds.join(',')}`, holds)
      const allowed = await h.call(method, url, { session: await session(holder), body, ip: addr() })
      const code =
        allowed.statusCode >= 400 && String(allowed.headers['content-type']).includes('json')
          ? (allowed.json() as { code?: string }).code
          : undefined
      const gate =
        allowed.statusCode === 401 ||
        (allowed.statusCode === 403 && !(GUARD_403[label(r)] ?? []).includes(code ?? ''))
      check('holding the permission', r, allowed, !gate)

      if (UNSAFE.has(method)) {
        const noCsrf = await h.call(method, url, {
          session: await session(holder),
          csrf: false,
          body,
          ip: addr(),
        })
        check(
          'without X-CSRF-Token',
          r,
          noCsrf,
          noCsrf.statusCode === 403 && (noCsrf.json() as { code?: string }).code === 'CSRF_INVALID',
        )
      }
    }
    expect(covered).toBeGreaterThanOrEqual(20)
    expect(failures, failures.join('\n')).toEqual([])
    // One login and several requests per registered route: about 26 s alone on this box, so the 30 s default is a coin flip when
    // another process is busy. The assertion above is what matters; the budget is only headroom.
  }, 180_000)
})
