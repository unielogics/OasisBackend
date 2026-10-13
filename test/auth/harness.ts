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
  kioskDeviceCookieName,
  kioskSessionCookieName,
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

/** A registered kiosk device: its cookie (ADR 0180). */
export interface KioskDevice {
  id: string
  name: string
  token: string
  /** "oasis_kdev=<token>" */
  cookie: string
}

/** An unlocked kiosk: both cookies, its CSRF token and the unlock answer. */
export interface KioskSession {
  device: KioskDevice
  token: string
  /** "oasis_kdev=...; oasis_ksid=..." */
  cookie: string
  csrf: string
  res: LightMyRequestResponse
}

export const KIOSK_CODE = '58203917'

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
  // --- kiosk mode (ADR 0180) ---
  /** "Make this a kiosk" by a manager's session; returns the device cookie. */
  registerDevice(admin: Pick<Session, 'cookie' | 'csrf'>, name?: string): Promise<KioskDevice>
  /** Sets the shop code through PUT /kiosk/code (default KIOSK_CODE). */
  setCode(admin: Pick<Session, 'cookie' | 'csrf'>, code?: string): Promise<void>
  /** Turns kiosk mode on or off through PUT /kiosk/settings. */
  setKioskMode(admin: Pick<Session, 'cookie' | 'csrf'>, enabled: boolean): Promise<void>
  /** POST /kiosk/unlock from the device; throws unless it answers 200. */
  unlock(device: KioskDevice, code?: string, ip?: string): Promise<KioskSession>
  /** A request from an unlocked kiosk; `actor` becomes X-Oasis-Employee. */
  kioskCall(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    k: Pick<KioskSession, 'cookie' | 'csrf'>,
    o?: { actor?: string; body?: unknown; headers?: Record<string, string>; csrf?: boolean; ip?: string },
  ): Promise<LightMyRequestResponse>
  /** A super admin signed in, the code set, this "tablet" registered, kiosk mode on and the kiosk unlocked. */
  kioskSetup(): Promise<{ admin: Session; adminUser: TestUser; device: KioskDevice; kiosk: KioskSession }>
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
            SESSION_SECRET: o.env?.SESSION_SECRET,
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
    identity.kioskGuard.reset()
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

    async registerDevice(admin, name = 'Front desk tablet') {
      const res = await self.call('POST', 'kiosk/devices', { session: admin, body: { name } })
      if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`)
      const c = res.cookies.find((x) => x.name === kioskDeviceCookieName(t.env))!
      const body = res.json() as { device: { id: string; name: string } }
      return { id: body.device.id, name: body.device.name, token: c.value, cookie: `${c.name}=${c.value}` }
    },

    async setCode(admin, code = KIOSK_CODE) {
      const res = await self.call('PUT', 'kiosk/code', { session: admin, body: { code } })
      if (res.statusCode !== 200) throw new Error(`set code failed: ${res.statusCode} ${res.body}`)
    },

    async setKioskMode(admin, enabled) {
      const cur = await self.call('GET', 'kiosk', { session: admin })
      const version = (cur.json() as { version: number }).version
      const res = await self.call('PUT', 'kiosk/settings', { session: admin, body: { enabled, version } })
      if (res.statusCode !== 200) throw new Error(`kiosk mode failed: ${res.statusCode} ${res.body}`)
    },

    async unlock(device, code = KIOSK_CODE, ip = '10.0.0.7') {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/v1/kiosk/unlock',
        headers: { origin, cookie: device.cookie },
        remoteAddress: ip,
        payload: { code },
      })
      if (res.statusCode !== 200) throw new Error(`unlock failed: ${res.statusCode} ${res.body}`)
      const c = res.cookies.find((x) => x.name === kioskSessionCookieName(t.env))!
      return {
        device,
        token: c.value,
        cookie: `${device.cookie}; ${c.name}=${c.value}`,
        csrf: (res.json() as { csrfToken: string }).csrfToken,
        res,
      }
    },

    async kioskCall(method, url, k, c = {}) {
      const headers: Record<string, string> = { ...c.headers }
      if (c.actor) headers['x-oasis-employee'] = c.actor
      return self.call(method, url, {
        session: k,
        csrf: c.csrf,
        body: c.body,
        headers,
        ip: c.ip,
      })
    },

    async kioskSetup() {
      counter++
      const adminUser = await self.createUser({ email: `kiosk-admin${counter}@example.test`, roles: ['super'], first: 'Rafael', last: 'Mendes' })
      const admin = await self.login(adminUser, `10.3.${counter % 250}.1`)
      await self.setCode(admin)
      const device = await self.registerDevice(admin)
      await self.setKioskMode(admin, true)
      const kiosk = await self.unlock(device)
      return { admin, adminUser, device, kiosk }
    },
  }

  async function ensureRoles(): Promise<void> {
    await testDb.db.transaction().execute((tx) => ensureDefaultRoles(tx, identity.newId))
  }

  return self
}
