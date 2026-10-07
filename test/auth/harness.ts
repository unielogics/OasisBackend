// Shared harness for the auth / rbac / people / authz-matrix tests: the real app with the real session authorizer over
// the worker schema, a frozen clock, an in-memory notifier and cheap scrypt parameters.
import type { LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { sql } from 'kysely'
import { allowedOrigins } from '../../src/http/hooks.js'
import { apiModules } from '../../src/http/modules.js'
import {
  InMemoryNotifier,
  createAccount,
  createIdentity,
  sessionCookieName,
  type Identity,
  type IdentityAuthorizer,
} from '../../src/modules/auth/index.js'
import { InMemoryBusinessHours, designBusinessHours } from '../../src/modules/people/business-hours.js'
import { ensureDefaultRoles } from '../../src/modules/rbac/repository.js'
import type { ThrottleOptions } from '../../src/modules/auth/throttle.js'
import { FixedClock } from '../../src/platform/clock.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { ensureLocation } from '../../src/platform/locations.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { createTestDb, truncateAll, type TestDb } from '../helpers/db.js'

export const TEST_PASSWORD = 'correct horse battery'
export const START = '2026-06-13T10:36:00-04:00'

export interface TestUser {
  employeeId: string
  userId: string
  email: string
  password: string
}

export interface Session {
  cookie: string
  csrf: string
  token: string
  res: LightMyRequestResponse
}

export interface Harness {
  readonly t: TestApp
  readonly identity: Identity
  readonly notifier: InMemoryNotifier
  readonly hours: InMemoryBusinessHours
  readonly clock: FixedClock
  readonly origin: string
  readonly cookieName: string
  createUser(o: {
    email: string
    roles?: string[]
    first?: string
    last?: string
    password?: string
    phone?: string
    overrides?: Record<string, 'allow' | 'deny'>
  }): Promise<TestUser>
  login(u: Pick<TestUser, 'email' | 'password'>, ip?: string): Promise<Session>
  /** Creates a user holding a custom role with exactly these permissions (no others) and signs them in. */
  userWithPermissions(perms: string[], email?: string): Promise<{ user: TestUser; session: Session }>
  call(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    o?: {
      session?: Pick<Session, 'cookie' | 'csrf'> | null
      body?: unknown
      headers?: Record<string, string>
      csrf?: boolean
      ip?: string
    },
  ): Promise<LightMyRequestResponse>
  json<T = Record<string, unknown>>(res: LightMyRequestResponse): T
}

let counter = 0

export function useHarness(
  o: {
    env?: Record<string, string>
    hours?: boolean
    throttle?: ThrottleOptions
    /** Start the realtime hub so GET /api/v1/events works (the app must then be listening on a port). */
    hub?: boolean
  } = {},
): Harness {
  let testDb: TestDb
  let t: TestApp
  let identity: Identity
  let locationId: string
  const notifier = new InMemoryNotifier()
  const hours = new InMemoryBusinessHours()
  let origin = 'http://localhost:3000'
  let cookieName = 'oasis_sid'

  beforeAll(async () => {
    testDb = await createTestDb({ clock: new FixedClock(START), poolMax: 6 })
    t = await createTestApp({
      testDb,
      env: o.env,
      hub: o.hub ? { pollMs: 100 } : undefined,
      modules: apiModules,
      authorizer: (location) => {
        locationId = location.id
        const a: IdentityAuthorizer = createIdentity({
          db: testDb.db,
          clock: testDb.clock,
          env: {
            NODE_ENV: (o.env?.NODE_ENV as 'test' | 'production' | undefined) ?? 'test',
            COOKIE_SECURE: (o.env?.COOKIE_SECURE ?? 'false') === 'true',
            SESSION_COOKIE_NAME: 'oasis_sid',
            PUBLIC_DASHBOARD_URL: 'http://localhost:3000',
          },
          locationId: location.id,
          notifier,
          businessHours: hours,
          passwordParams: { ln: 10, r: 8, p: 1 },
          throttle: o.throttle,
        })
        identity = a.identity
        return a
      },
    })
    origin = [...allowedOrigins(t.env)][0]!
    cookieName = sessionCookieName(t.env)
  })

  beforeEach(async () => {
    t.clock.set(START)
    notifier.clear()
    await truncateAll(testDb.db)
    await ensureLocation(testDb.db, () => locationId)
    hours.clear()
    if (o.hours !== false) hours.set(locationId, designBusinessHours())
    identity.rbac.clear()
    identity.throttle.reset()
  })

  afterAll(async () => {
    await t?.close()
    await testDb?.close()
  })

  const self: Harness = {
    get t() {
      return t
    },
    get identity() {
      return identity
    },
    notifier,
    hours,
    get clock() {
      return t.clock
    },
    get origin() {
      return origin
    },
    get cookieName() {
      return cookieName
    },

    async createUser(u) {
      counter++
      const password = u.password ?? TEST_PASSWORD
      const made = await createAccount(identity, {
        email: u.email,
        password,
        first: u.first ?? `User${counter}`,
        last: u.last ?? 'Tester',
        phone: u.phone ?? '(305) 555-0100',
        roles: u.roles ?? ['crew'],
      })
      if (u.overrides) {
        const rows = Object.entries(u.overrides).map(([permission_key, effect]) => ({
          employee_id: made!.employeeId,
          permission_key,
          effect,
        }))
        if (rows.length) await testDb.db.insertInto('employee_permission_overrides').values(rows).execute()
        await sql`update rbac_state set version = version + 1`.execute(testDb.db)
      }
      return { employeeId: made!.employeeId, userId: made!.userId, email: made!.email, password }
    },

    async login(u, ip = '10.0.0.1') {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin },
        remoteAddress: ip,
        payload: { email: u.email, password: u.password },
      })
      if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`)
      const c = res.cookies.find((x) => x.name === cookieName)!
      return {
        cookie: `${cookieName}=${c.value}`,
        token: c.value,
        csrf: (res.json() as { csrfToken: string }).csrfToken,
        res,
      }
    },

    async userWithPermissions(perms, email) {
      counter++
      const roleId = createIdGenerator(testDb.clock)()
      await ensureRoles()
      await testDb.db
        .insertInto('roles')
        .values({ id: roleId, key: null, name: `Exact ${counter}`, is_custom: true })
        .execute()
      if (perms.length)
        await testDb.db
          .insertInto('role_permissions')
          .values(perms.map((permission_key) => ({ role_id: roleId, permission_key })))
          .execute()
      const user = await self.createUser({ email: email ?? `exact${counter}@example.test`, roles: [roleId] })
      return { user, session: await self.login(user, `10.1.${counter % 250}.${counter % 250}`) }
    },

    async call(method, url, c = {}) {
      const headers: Record<string, string> = { ...c.headers }
      if (c.session?.cookie) headers.cookie = c.session.cookie
      if (method !== 'GET') {
        headers.origin ??= origin
        if (c.session && c.csrf !== false) headers['x-csrf-token'] = c.session.csrf
      }
      return t.app.inject({
        method,
        url: url.startsWith('/') ? url : `/api/v1/${url}`,
        headers,
        remoteAddress: c.ip ?? '10.0.0.2',
        ...(c.body !== undefined ? { payload: c.body as Record<string, unknown> } : {}),
      })
    },

    json: <T>(res: LightMyRequestResponse) => res.json() as T,
  }

  async function ensureRoles(): Promise<void> {
    await testDb.db.transaction().execute((tx) => ensureDefaultRoles(tx, identity.newId))
  }

  return self
}
