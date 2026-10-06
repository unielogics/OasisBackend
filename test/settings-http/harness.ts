// Harness for the Settings HTTP tests: the real app (auth, people and settings modules) over the worker schema with the
// real session authorizer, the DB business-hours adapter, a frozen Saturday 10:36 clock, recording notifiers and a
// captured job queue.
import type { LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { allowedOrigins } from '../../src/http/hooks.js'
import type { AppDeps } from '../../src/app.js'
import {
  InMemoryNotifier,
  authModule,
  createAccount,
  createIdentity,
  peopleModule,
  sessionCookieName,
  type Identity,
} from '../../src/modules/auth/index.js'
import { ensureDefaultRoles } from '../../src/modules/rbac/repository.js'
import { DbBusinessHours } from '../../src/modules/settings/db-adapters/business-hours.js'
import { createSettingsModule } from '../../src/modules/settings/http/module.js'
import { type SettingsPorts } from '../../src/modules/settings/http/runtime.js'
import { RecordingEmergencyNotifier } from '../../src/modules/settings/ports.js'
import { FixedClock } from '../../src/platform/clock.js'
import type { Db } from '../../src/platform/db.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import type { EnqueueOptions, Jobs } from '../../src/platform/jobs.js'
import { ensureLocation } from '../../src/platform/locations.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { createTestDb, truncateAll, type TestDb } from '../helpers/db.js'
import { setupLocation, type Fixture } from '../domain-schema/helpers.js'

export const START = '2026-06-13T10:36:00-04:00' // Saturday
export const TEST_PASSWORD = 'correct horse battery'

export interface TestUser {
  employeeId: string
  userId: string
  email: string
  password: string
}

export interface Session {
  cookie: string
  csrf: string
}

export interface QueuedJob {
  name: string
  data: unknown
  opts: EnqueueOptions | undefined
}

export interface SettingsHarness {
  readonly t: TestApp
  readonly db: Db
  readonly identity: Identity
  readonly clock: FixedClock
  readonly fx: Fixture
  readonly emergencyNotifier: RecordingEmergencyNotifier
  readonly queued: QueuedJob[]
  readonly ports: Partial<SettingsPorts>
  createUser(o: {
    email: string
    roles?: string[]
    first?: string
    last?: string
    phone?: string
    overrides?: Record<string, 'allow' | 'deny'>
  }): Promise<TestUser>
  login(u: Pick<TestUser, 'email' | 'password'>): Promise<Session>
  /** A signed-in super admin (the default caller). */
  admin(): Promise<Session>
  /** A signed-in user holding a custom role with exactly these permissions. */
  withPermissions(perms: string[]): Promise<Session>
  call(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    o?: { session?: Session | null; body?: unknown; headers?: Record<string, string>; csrf?: boolean },
  ): Promise<LightMyRequestResponse>
  get(url: string, s: Session): Promise<LightMyRequestResponse>
  put(
    url: string,
    s: Session,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<LightMyRequestResponse>
  post(
    url: string,
    s: Session,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<LightMyRequestResponse>
  patch(url: string, s: Session, body: unknown): Promise<LightMyRequestResponse>
  del(url: string, s: Session): Promise<LightMyRequestResponse>
}

let counter = 0

export function useSettingsHarness(o: { hub?: boolean } = {}): SettingsHarness {
  let testDb: TestDb
  let t: TestApp
  let identity: Identity
  let locationId = ''
  let fx: Fixture
  let origin = 'http://localhost:3000'
  let cookieName = 'oasis_sid'
  const queued: QueuedJob[] = []
  const emergencyNotifier = new RecordingEmergencyNotifier()
  const ports: Partial<SettingsPorts> = { emergencyNotifier }
  const jobs: Jobs = {
    start: async () => undefined,
    enqueue: async (name, data, opts) => {
      queued.push({ name, data, opts })
      return `job-${queued.length}`
    },
    health: async () => ({ ok: true, detail: 'test' }),
    stop: async () => undefined,
  }

  beforeAll(async () => {
    testDb = await createTestDb({ clock: new FixedClock(START), poolMax: 8 })
    const deps: Partial<AppDeps> = { jobs }
    t = await createTestApp({
      testDb,
      hub: o.hub,
      modules: [authModule, peopleModule, createSettingsModule(ports)],
      deps,
      authorizer: (location) => {
        locationId = location.id
        return createIdentity({
          db: testDb.db,
          clock: testDb.clock,
          env: {
            NODE_ENV: 'test',
            COOKIE_SECURE: false,
            SESSION_COOKIE_NAME: 'oasis_sid',
            PUBLIC_DASHBOARD_URL: 'http://localhost:3000',
          },
          locationId: location.id,
          notifier: new InMemoryNotifier(),
          businessHours: new DbBusinessHours(testDb.db),
          passwordParams: { ln: 10, r: 8, p: 1 },
        })
      },
    })
    identity = (t.app.authorizer as unknown as { identity: Identity }).identity
    origin = [...allowedOrigins(t.env)][0]!
    cookieName = sessionCookieName(t.env)
  })

  beforeEach(async () => {
    t.clock.set(START)
    queued.length = 0
    emergencyNotifier.sent.length = 0
    await truncateAll(testDb.db)
    await ensureLocation(testDb.db, () => locationId)
    fx = await setupLocation({ db: testDb.db, clock: testDb.clock })
    identity.rbac.clear()
    identity.throttle.reset()
  })

  afterAll(async () => {
    await t?.close()
    await testDb?.close()
  })

  let ipSeq = 0
  const nextIp = (): string => `10.60.${Math.floor(ipSeq / 200)}.${(ipSeq++ % 200) + 1}`

  const self: SettingsHarness = {
    get t() {
      return t
    },
    get db() {
      return testDb.db
    },
    get identity() {
      return identity
    },
    get clock() {
      return t.clock
    },
    get fx() {
      return fx
    },
    emergencyNotifier,
    queued,
    ports,

    async createUser(u) {
      counter++
      const made = await createAccount(identity, {
        email: u.email,
        password: TEST_PASSWORD,
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
        await testDb.db.insertInto('employee_permission_overrides').values(rows).execute()
      }
      return {
        employeeId: made!.employeeId,
        userId: made!.userId,
        email: made!.email,
        password: TEST_PASSWORD,
      }
    },

    async login(u) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin },
        remoteAddress: nextIp(),
        payload: { email: u.email, password: u.password },
      })
      if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`)
      const c = res.cookies.find((x) => x.name === cookieName)!
      return { cookie: `${cookieName}=${c.value}`, csrf: (res.json() as { csrfToken: string }).csrfToken }
    },

    async admin() {
      const user = await self.createUser({
        email: `admin${++counter}@example.test`,
        roles: ['super'],
        first: 'Amara',
        last: 'Okoye',
      })
      return self.login(user)
    },

    async withPermissions(perms) {
      counter++
      const roleId = createIdGenerator(testDb.clock)()
      await testDb.db.transaction().execute((tx) => ensureDefaultRoles(tx, identity.newId))
      await testDb.db
        .insertInto('roles')
        .values({ id: roleId, key: null, name: `Exact ${counter}`, is_custom: true })
        .execute()
      if (perms.length)
        await testDb.db
          .insertInto('role_permissions')
          .values(perms.map((permission_key) => ({ role_id: roleId, permission_key })))
          .execute()
      const user = await self.createUser({ email: `exact${counter}@example.test`, roles: [roleId] })
      return self.login(user)
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
        remoteAddress: '10.0.0.2',
        ...(c.body !== undefined ? { payload: c.body as Record<string, unknown> } : {}),
      })
    },
    get: (url, s) => self.call('GET', url, { session: s }),
    put: (url, s, body, headers) => self.call('PUT', url, { session: s, body, headers }),
    post: (url, s, body, headers) => self.call('POST', url, { session: s, body: body ?? {}, headers }),
    patch: (url, s, body) => self.call('PATCH', url, { session: s, body }),
    del: (url, s) => self.call('DELETE', url, { session: s }),
  }
  return self
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>
export const json = (r: LightMyRequestResponse): Json => r.json() as Json

/** Rows of realtime_events (newest last) for assertions on what a mutation published. */
export async function events(
  db: Db,
  channel?: string,
): Promise<{ channel: string; type: string; payload: Json }[]> {
  let q = db.selectFrom('realtime_events').select(['channel', 'type', 'payload']).orderBy('id')
  if (channel) q = q.where('channel', '=', channel)
  return (await q.execute()) as { channel: string; type: string; payload: Json }[]
}

export async function auditActions(db: Db): Promise<string[]> {
  return (await db.selectFrom('audit_log').select('action').orderBy('id').execute()).map((r) => r.action)
}
