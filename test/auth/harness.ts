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

/** A shop browser (ADR 0180 amendment: it gets its device cookie at its first unlock at the shop): its cookie. */
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
  /** The shop address it was unlocked from: its requests come from there unless a call says otherwise (ADR 0180 A13). */
  ip: string
  res: LightMyRequestResponse
}

/** A PIN that passes every rule (tests that type a known PIN). */
export const KIOSK_PIN = '58203917'
/** The address kioskSetup's shop network is, unless it says otherwise. */
export const SHOP_IP = '10.0.0.7'

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
  // --- kiosk mode (ADR 0180 and its 2026-10-14 amendment) ---
  /** "This is the shop's network": a Super Admin's POST /kiosk/networks {confirmAddress} from `ip`; returns the network id. */
  addShopNetwork(admin: Pick<Session, 'cookie' | 'csrf'>, ip?: string): Promise<string>
  /** PUT /kiosk/staff/:employeeId/pin: `pin`, or a generated one; returns the PIN. */
  setPin(admin: Pick<Session, 'cookie' | 'csrf'>, employeeId: string, pin?: string): Promise<string>
  /** Turns kiosk mode on or off through PUT /kiosk/settings. */
  setKioskMode(admin: Pick<Session, 'cookie' | 'csrf'>, enabled: boolean): Promise<void>
  /**
   * POST /kiosk/unlock from `ip` (default: the shop address kioskSetup last used) with `pin` (default: kioskSetup's last PIN), from
   * the browser of `device` (null: a browser without a device cookie, which gets one); throws unless it answers 200.
   */
  unlock(device: KioskDevice | null, pin?: string, ip?: string): Promise<KioskSession>
  /** A request from an unlocked kiosk (from the address it was unlocked at unless `ip` says otherwise); `actor` becomes X-Oasis-Employee. */
  kioskCall(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    k: Pick<KioskSession, 'cookie' | 'csrf'> & { ip?: string },
    o?: { actor?: string; body?: unknown; headers?: Record<string, string>; csrf?: boolean; ip?: string },
  ): Promise<LightMyRequestResponse>
  /**
   * A Super Admin signed in at a shop address of its own, that address added as the shop's network, a PIN set for the Super Admin,
   * and the "tablet" (a fresh browser) unlocked there with it: it got its device cookie.
   */
  kioskSetup(): Promise<{ admin: Session; adminUser: TestUser; device: KioskDevice; kiosk: KioskSession; pin: string; shopIp: string }>
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
  let lastPin = KIOSK_PIN
  let lastShopIp = SHOP_IP

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
    identity.kioskNetworks.reset()
    lastPin = KIOSK_PIN
    lastShopIp = SHOP_IP
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

    async addShopNetwork(admin, ip = SHOP_IP) {
      const res = await self.call('POST', 'kiosk/networks', { session: admin, body: { confirmAddress: ip }, ip })
      if (res.statusCode !== 201 && res.statusCode !== 200) throw new Error(`add network failed: ${res.statusCode} ${res.body}`)
      return (res.json() as { network: { id: string } }).network.id
    },

    async setPin(admin, employeeId, pin) {
      const res = await self.call('PUT', `kiosk/staff/${employeeId}/pin`, { session: admin, body: pin ? { pin } : { generate: true } })
      if (res.statusCode !== 200) throw new Error(`set PIN failed: ${res.statusCode} ${res.body}`)
      return pin ?? (res.json() as { pin: string }).pin
    },

    async setKioskMode(admin, enabled) {
      const cur = await self.call('GET', 'kiosk', { session: admin })
      const version = (cur.json() as { version: number }).version
      const res = await self.call('PUT', 'kiosk/settings', { session: admin, body: { enabled, version } })
      if (res.statusCode !== 200) throw new Error(`kiosk mode failed: ${res.statusCode} ${res.body}`)
    },

    async unlock(device, pin = lastPin, ip = lastShopIp) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/v1/kiosk/unlock',
        headers: { origin, ...(device ? { cookie: device.cookie } : {}) },
        remoteAddress: ip,
        payload: { pin },
      })
      if (res.statusCode !== 200) throw new Error(`unlock failed: ${res.statusCode} ${res.body}`)
      const c = res.cookies.find((x) => x.name === kioskSessionCookieName(t.env))!
      const d = res.cookies.find((x) => x.name === kioskDeviceCookieName(t.env))!
      const me = res.json() as { csrfToken: string; device: { id: string; name: string } }
      const dev: KioskDevice = device ?? { id: me.device.id, name: me.device.name, token: d.value, cookie: `${d.name}=${d.value}` }
      return {
        device: dev,
        token: c.value,
        cookie: `${dev.cookie}; ${c.name}=${c.value}`,
        csrf: me.csrfToken,
        ip,
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
        ip: c.ip ?? k.ip,
      })
    },

    async kioskSetup() {
      counter++
      const adminUser = await self.createUser({ email: `kiosk-admin${counter}@example.test`, roles: ['super'], first: 'Rafael', last: 'Mendes' })
      // each setup is its own shop address: the per-address limits (a frozen clock never lets their minute pass) never mix
      const shopIp = `10.3.${Math.floor(counter / 250) % 250}.${(counter % 250) + 1}`
      const admin = await self.login(adminUser, shopIp)
      await self.addShopNetwork(admin, shopIp)
      const pin = await self.setPin(admin, adminUser.employeeId)
      lastPin = pin
      lastShopIp = shopIp
      const kiosk = await self.unlock(null, pin, shopIp)
      return { admin, adminUser, device: kiosk.device, kiosk, pin, shopIp }
    },
  }

  async function ensureRoles(): Promise<void> {
    await testDb.db.transaction().execute((tx) => ensureDefaultRoles(tx, identity.newId))
  }

  return self
}
