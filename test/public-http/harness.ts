// Harness of the public website's HTTP tests (ADR 0150): the real app through the production module list (apiModules) over the
// `design` seed (two bays, Saturday 8 to 5, the VIP holds, the catalog, the simulator SMS device), a frozen Saturday 10:36 clock,
// the real messaging queue with the test numbers on the allowlist, and a permissive authorizer for the dashboard-side reads
// (the public routes never consult it). Every test starts from an empty booking table and no web-created customers.
import type { LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { sql } from 'kysely'
import { runSeed } from '../../db/seeds/index.js'
import { apiModules } from '../../src/http/modules.js'
import { createPermissiveAuthorizer } from '../../src/http/authorizer.js'
import { FixedClock, PARITY_NOW } from '../../src/platform/clock.js'
import { createIdGenerator, type NewId } from '../../src/platform/ids.js'
import { hashCode } from '../../src/modules/public/otp.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { createTestDb, truncateAll, type TestDb } from '../helpers/db.js'
import { makeUser } from '../helpers/factories.js'

export const START = PARITY_NOW // Saturday 2026-06-13 10:36 America/New_York
export const TODAY = '2026-06-13'
export const SITE_ORIGIN = 'https://site.example.test'

/** Test numbers (valid US numbers, never texted: the SMS provider is the simulator and these are on the allowlist). */
export const PHONES = {
  guest: '+12015550101',
  member: '+12015550102',
  joiner: '+12015550103',
  otp: '+12015550104',
  /** Not on the allowlist: every text to it is suppressed outside production. */
  stranger: '+12015550105',
  extra: '+12015550106',
} as const
const ALLOWLIST = [PHONES.guest, PHONES.member, PHONES.joiner, PHONES.otp, PHONES.extra].join(',')

export interface PublicHarness {
  readonly t: TestApp
  readonly db: TestDb['db']
  readonly clock: FixedClock
  readonly newId: NewId
  readonly locationId: string
  /** Package or add-on key by seeded name. */
  key(name: string): string
  get(url: string, o?: { ip?: string; headers?: Record<string, string> }): Promise<LightMyRequestResponse>
  post(
    url: string,
    body: unknown,
    o?: { ip?: string; key?: string | null; origin?: string | null; headers?: Record<string, string> },
  ): Promise<LightMyRequestResponse>
  /** A dashboard-side call (the permissive authorizer signs it in with every permission). */
  staff(method: 'GET' | 'POST', url: string, body?: unknown): Promise<LightMyRequestResponse>
  /** The texts queued for a number, oldest first (sms_outbox keeps the real body; messages redacts the sensitive classes). */
  texts(phone: string): Promise<{ body: string; klass: string; state: string }[]>
  /** The six-digit code the text for this challenge carried (found by its hash: the code is never stored). */
  codeSentTo(phone: string, challengeId: string): Promise<string>
  nextIp(): string
  nextKey(): string
}

let keyN = 0
let ipN = 0

export function usePublicHarness(o: { env?: Record<string, string>; poolMax?: number } = {}): PublicHarness {
  let t: TestDb
  let app: TestApp
  let clock: FixedClock
  let locationId = ''
  let newId: NewId
  const keys = new Map<string, string>()

  beforeAll(async () => {
    clock = new FixedClock(START)
    t = await createTestDb({ clock, poolMax: o.poolMax ?? 8 })
    await truncateAll(t.db)
    await runSeed({ db: t.db, clock, profile: 'design' })
    locationId = (await t.db.selectFrom('locations').select('id').executeTakeFirstOrThrow()).id
    newId = createIdGenerator(clock)
    // managers (people holding sched.override or set.billing) need a login row to receive notifications
    await sql`insert into users (id, employee_id, email, password_hash)
      select gen_random_uuid(), e.id, lower(e.first) || '@public.example.test', 'not-a-real-hash' from employees e
      where not exists (select 1 from users u where u.employee_id = e.id)`.execute(t.db)
    const user = await makeUser(t.db, newId, { first: 'Desk', email: 'desk-public@example.test' })
    app = await createTestApp({
      testDb: t,
      modules: apiModules,
      authorizer: (location) =>
        createPermissiveAuthorizer({
          locationId: location.id,
          userId: user.userId,
          employeeId: user.employeeId,
          actorName: 'Desk U.',
        }),
      env: {
        SMS_ALLOWLIST: ALLOWLIST,
        SMSGATE_MIN_INTERVAL_MS: '0',
        SMS_DISPATCH_MODE: 'off',
        PUBLIC_SITE_URL: SITE_ORIGIN,
        PUBLIC_WRITES_ENABLED: 'true',
        ...o.env,
      },
    })
    const c = await app.app.inject({ method: 'GET', url: '/api/v1/public/catalog' })
    const cat = c.json() as { services: { key: string; name: string }[]; addons: { key: string; name: string }[] }
    for (const s of [...cat.services, ...cat.addons]) keys.set(s.name, s.key)
  })

  beforeEach(async () => {
    clock.set(START)
    await sql`truncate table messages, message_threads, sms_outbox, sms_inbox, sms_usage, sms_processed_events, sms_opt_outs, outbox_emails,
      notifications, notice_debounce, realtime_events, appointments, activity_log, audit_log, idempotency_keys,
      memberships, membership_credit_events, sqsp_alerts, sqsp_products,
      public_otp_challenges, public_member_tokens, public_rate_limits restart identity cascade`.execute(t.db)
    await sql`delete from vehicles where customer_id in (select id from customers where synthetic = false)`.execute(t.db)
    await sql`delete from vip_clients where customer_id in (select id from customers where synthetic = false)`.execute(t.db)
    await sql`delete from customers where synthetic = false`.execute(t.db)
    await sql`delete from settings where key = 'booking.guest_fee'`.execute(t.db)
  })

  afterAll(async () => {
    await app?.close()
    await t?.close()
  })

  const nextIp = (): string => `10.90.${Math.floor(ipN / 200)}.${(ipN++ % 200) + 1}`
  const nextKey = (): string => `public-key-${++keyN}-${'k'.repeat(8)}`

  const self: PublicHarness = {
    get t() {
      return app
    },
    get db() {
      return t.db
    },
    get clock() {
      return clock
    },
    get newId() {
      return newId
    },
    get locationId() {
      return locationId
    },
    key(name) {
      const k = keys.get(name)
      if (!k) throw new Error(`no catalog key for "${name}"; have ${[...keys.keys()].join(', ')}`)
      return k
    },
    get: (url, c = {}) =>
      app.app.inject({
        method: 'GET',
        url: url.startsWith('/') ? url : `/api/v1/${url}`,
        headers: { 'x-test-anonymous': '1', ...c.headers },
        remoteAddress: c.ip ?? nextIp(),
      }),
    post: (url, body, c = {}) => {
      const headers: Record<string, string> = { 'x-test-anonymous': '1', ...c.headers }
      if (c.key !== null) headers['idempotency-key'] = c.key ?? nextKey()
      if (c.origin !== null) headers.origin = c.origin ?? SITE_ORIGIN
      return app.app.inject({
        method: 'POST',
        url: url.startsWith('/') ? url : `/api/v1/${url}`,
        headers,
        remoteAddress: c.ip ?? nextIp(),
        payload: body as object,
      })
    },
    staff: (method, url, body) =>
      app.app.inject({
        method,
        url: `/api/v1/${url}`,
        headers: method === 'POST' ? { 'idempotency-key': nextKey() } : {},
        ...(body !== undefined ? { payload: body as object } : {}),
      }),
    texts: async (phone) =>
      (
        await t.db
          .selectFrom('sms_outbox')
          .select(['body', 'klass', 'state'])
          .where('to_e164', '=', phone)
          .orderBy('queued_at')
          .orderBy('id')
          .execute()
      ).map((r) => ({ body: r.body, klass: r.klass, state: r.state })),
    codeSentTo: async (phone, challengeId) => {
      const rows = await self.texts(phone)
      const row = await t.db.selectFrom('public_otp_challenges').select('code_hash').where('id', '=', challengeId).executeTakeFirstOrThrow()
      for (const r of rows.filter((x) => x.klass === 'otp_code')) {
        const code = /\b(\d{6})\b/.exec(r.body)?.[1]
        if (code && hashCode(challengeId, code) === row.code_hash) return code
      }
      throw new Error(`no code text for challenge ${challengeId} to ${phone}; texts: ${JSON.stringify(rows)}`)
    },
    nextIp,
    nextKey,
  }
  return self
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>
export const json = (r: LightMyRequestResponse): Json => r.json() as Json

/** Every key, nested, of a JSON value (for the "no personal or operations data" checks). */
export const keysOf = (x: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(x)) x.forEach((v) => keysOf(v, out))
  else if (x && typeof x === 'object')
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      out.add(k)
      keysOf(v, out)
    }
  return out
}

/** A guest booking body for a seeded package at a Saturday time. */
export const bookingBody = (h: PublicHarness, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'Nina Guest',
  phone: PHONES.guest,
  email: 'nina@example.test',
  vehicle: { label: '2021 Tesla Model 3', plate: 'NJ-NINA1' },
  serviceKey: h.key('Express Hand Wash'),
  addonKeys: [],
  date: TODAY,
  startMin: 13 * 60,
  smsConsent: true,
  website: '',
  ...extra,
})
