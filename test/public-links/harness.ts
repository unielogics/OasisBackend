// Harness of the personal-link API tests (ADR 0160, design section 5, wave W3c): the real app through the production module list
// (the link module rebuilt with a cheap scrypt cost, nothing else changed) over the `design` seed (two bays, Saturday 8 to 5, the VIP
// holds, the catalog, the simulator SMS device), a frozen Saturday 10:36 clock, the real messaging queue with the test numbers on
// the allowlist (texts stay queued: dispatch is off), PUBLIC_LINKS_ENABLED=true and a test PIN pepper. Links are issued with the
// identity core's own issueClientLink, as the assistant and staff will.
import type { LightMyRequestResponse } from 'fastify'
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { sql } from 'kysely'
import { runSeed } from '../../db/seeds/index.js'
import { apiModules, publicLinksModule, publicLinksWiring } from '../../src/http/modules.js'
import { createPermissiveAuthorizer } from '../../src/http/authorizer.js'
import { FixedClock, PARITY_NOW } from '../../src/platform/clock.js'
import { createIdGenerator, type NewId } from '../../src/platform/ids.js'
import { hashCode } from '../../src/modules/public/otp.js'
import { issueClientLink, type IssueLinkInput, type IssuedLink } from '../../src/modules/identity/links.js'
import { grantTrust } from '../../src/modules/identity/trust.js'
import { createPublicLinksModule } from '../../src/modules/public/links/module.js'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { createTestDb, truncateAll, type TestDb } from '../helpers/db.js'
import { makeUser } from '../helpers/factories.js'

export const START = PARITY_NOW // Saturday 2026-06-13 10:36 America/New_York
export const TODAY = '2026-06-13'
export const SITE_ORIGIN = 'https://site.example.test'
export const PEPPER = '5c1b7e0a9f3d2c6b8a4e1f07d9c2b5a3e6f1d8c4b7a2e9f0c3d6b1a8e5f2c7d4'
export const CHEAP_SCRYPT = { ln: 6, r: 8, p: 1 }

/** Test numbers (valid US numbers, never texted: dispatch is off and they are on the allowlist). */
export const PHONES = {
  maria: '+12015550121',
  liam: '+12015550122',
  stranger: '+12015550123',
  other: '+12015550124',
  /** Not on the allowlist (and never a link's number): a `phone` in a body must never get a text. */
  intruder: '+12015550129',
} as const
const ALLOWLIST = [PHONES.maria, PHONES.liam, PHONES.stranger, PHONES.other].join(',')

export interface CallOptions {
  session?: string | null
  body?: unknown
  ip?: string
  key?: string | null
  origin?: string | null
  headers?: Record<string, string>
}

export interface LinksHarness {
  readonly t: TestApp
  readonly db: TestDb['db']
  readonly clock: FixedClock
  readonly newId: NewId
  readonly locationId: string
  /** Package or add-on key by seeded name. */
  key(name: string): string
  call(method: 'GET' | 'POST', path: string, o?: CallOptions): Promise<LightMyRequestResponse>
  /** Inserts a live, opted-in client (not synthetic) and returns its id. */
  customer(o?: { name?: string; phone?: string; email?: string | null; createdAt?: Date; needsDetails?: boolean }): Promise<string>
  link(o: Partial<IssueLinkInput> & { customerId: string | null }): Promise<IssuedLink>
  /** POST exchange; returns the session token and the answer. */
  open(token: string, o?: { ip?: string }): Promise<{ session: string; body: Json; res: LightMyRequestResponse }>
  /** Issues a link and opens it. */
  page(o: Partial<IssueLinkInput> & { customerId: string | null }): Promise<{ session: string; body: Json; link: IssuedLink }>
  /** The number's 30-day trust for the client, as a verification would leave it. */
  trust(customerId: string, phone?: string): Promise<void>
  /** Requests a code on the page and confirms it with the code the text carried. */
  verifyByCode(session: string, purpose?: 'verify' | 'pin_set' | 'pin_reset'): Promise<LightMyRequestResponse>
  /** The six-digit code the text for this challenge carried (found by its hash: the code is never stored). */
  codeOf(challengeId: string): Promise<string>
  texts(phone: string): Promise<{ body: string; klass: string }[]>
  advance(ms: number): void
  nextIp(): string
  nextKey(): string
}

let keyN = 0
let ipN = 0

export function useLinksHarness(o: { env?: Record<string, string> } = {}): LinksHarness {
  let t: TestDb
  let app: TestApp
  let clock: FixedClock
  let locationId = ''
  let newId: NewId
  const keys = new Map<string, string>()

  beforeAll(async () => {
    clock = new FixedClock(START)
    t = await createTestDb({ clock, poolMax: 8 })
    await truncateAll(t.db)
    await runSeed({ db: t.db, clock, profile: 'design' })
    locationId = (await t.db.selectFrom('locations').select('id').executeTakeFirstOrThrow()).id
    newId = createIdGenerator(clock)
    await ensurePlans(t.db, { locationId, clock, newId })
    // managers (people holding sched.override or set.billing) need a login row to receive notifications
    await sql`insert into users (id, employee_id, email, password_hash)
      select gen_random_uuid(), e.id, lower(e.first) || '@links.example.test', 'not-a-real-hash' from employees e
      where not exists (select 1 from users u where u.employee_id = e.id)`.execute(t.db)
    const user = await makeUser(t.db, newId, { first: 'Desk', email: 'desk-links@example.test' })
    const cheap = createPublicLinksModule(publicLinksWiring, { scrypt: CHEAP_SCRYPT })
    app = await createTestApp({
      testDb: t,
      modules: apiModules.map((m) => (m === publicLinksModule ? cheap : m)),
      authorizer: (location) =>
        createPermissiveAuthorizer({ locationId: location.id, userId: user.userId, employeeId: user.employeeId, actorName: 'Desk U.' }),
      env: {
        SMS_ALLOWLIST: ALLOWLIST,
        SMSGATE_MIN_INTERVAL_MS: '0',
        SMS_DISPATCH_MODE: 'off',
        PUBLIC_SITE_URL: SITE_ORIGIN,
        PUBLIC_LINKS_ENABLED: 'true',
        PIN_PEPPER: PEPPER,
        ...o.env,
      },
    })
    const c = await app.app.inject({ method: 'GET', url: '/api/v1/public/catalog' })
    const cat = c.json() as { services: { key: string; name: string }[]; addons: { key: string; name: string }[] }
    for (const s of [...cat.services, ...cat.addons]) keys.set(s.name, s.key)
  })

  beforeEach(async () => {
    clock.set(START)
    await sql`truncate table client_link_sessions, client_links, phone_trust, customer_pins, identity_pin_failures, assistant_pending_actions,
      membership_checkouts, messages, message_threads, sms_outbox, sms_inbox, sms_usage, sms_processed_events, sms_opt_outs, outbox_emails,
      notifications, notice_debounce, realtime_events, appointments, activity_log, audit_log, idempotency_keys, memberships,
      membership_credit_events, sqsp_alerts, sqsp_products, public_otp_challenges, public_member_tokens, public_rate_limits
      restart identity cascade`.execute(t.db)
    await sql`delete from vehicles where customer_id in (select id from customers where synthetic = false)`.execute(t.db)
    await sql`delete from vip_clients where customer_id in (select id from customers where synthetic = false)`.execute(t.db)
    await sql`delete from customers where synthetic = false`.execute(t.db)
    await sql`delete from settings where key in ('booking.guest_fee', 'links.epoch')`.execute(t.db)
    await sql`update membership_plans set checkout_url = null`.execute(t.db)
    app.logs.length = 0
  })

  afterAll(async () => {
    await app?.close()
    await t?.close()
  })

  const nextIp = (): string => `10.91.${Math.floor(ipN / 200)}.${(ipN++ % 200) + 1}`
  const nextKey = (): string => `links-key-${++keyN}-${'k'.repeat(8)}`

  const self: LinksHarness = {
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
    call(method, path, c = {}) {
      const headers: Record<string, string> = { 'x-test-anonymous': '1', ...c.headers }
      if (c.session) headers.authorization = `Bearer ${c.session}`
      if (method === 'POST') {
        if (c.key !== null && c.key !== undefined) headers['idempotency-key'] = c.key
        if (c.origin !== null) headers.origin = c.origin ?? SITE_ORIGIN
      } else if (c.origin) headers.origin = c.origin
      return app.app.inject({
        method,
        url: `/api/v1/public/links/${path}`,
        headers,
        remoteAddress: c.ip ?? nextIp(),
        ...(method === 'POST' ? { payload: (c.body ?? {}) as object } : {}),
      })
    },
    async customer(c = {}) {
      const id = newId()
      await t.db
        .insertInto('customers')
        .values({
          id,
          full_name: c.name ?? 'Maria Delgado',
          phone_e164: c.phone ?? PHONES.maria,
          phone_display: null,
          email: c.email ?? null,
          notes: null,
          sms_opted_in: true,
          sms_opt_in_source: 'online',
          synthetic: false,
          needs_details: c.needsDetails ?? false,
          ...(c.createdAt ? { created_at: c.createdAt } : {}),
        })
        .execute()
      return id
    },
    link: (l) =>
      t.db.transaction().execute((tx) => issueClientLink(tx, { newId, now: clock.now() }, { locationId, kind: 'calendar', issuedBy: 'staff', ...l })),
    async open(token, c = {}) {
      const res = await self.call('POST', 'exchange', { body: { token }, ip: c.ip })
      const body = res.json() as Json
      return { session: String(body.session ?? ''), body, res }
    },
    async page(l) {
      const link = await self.link(l)
      const o = await self.open(link.token)
      if (o.res.statusCode !== 200) throw new Error(`exchange failed: ${o.res.statusCode} ${o.res.body}`)
      return { session: o.session, body: o.body, link }
    },
    async trust(customerId, phone = PHONES.maria) {
      await t.db.transaction().execute((tx) => grantTrust(tx, { locationId, phone, customerId, verifiedBy: 'code', now: clock.now() }))
    },
    async verifyByCode(session, purpose = 'verify') {
      const r = await self.call('POST', 'verify/code', { session, body: { purpose } })
      if (r.statusCode !== 202) throw new Error(`code request failed: ${r.statusCode} ${r.body}`)
      const challengeId = (r.json() as Json).challengeId as string
      return self.call('POST', 'verify/code/confirm', { session, body: { challengeId, code: await self.codeOf(challengeId) } })
    },
    async codeOf(challengeId) {
      const row = await t.db.selectFrom('public_otp_challenges').select(['code_hash', 'phone_e164']).where('id', '=', challengeId).executeTakeFirstOrThrow()
      for (const r of (await self.texts(row.phone_e164)).filter((x) => x.klass === 'otp_code')) {
        const code = /\b(\d{6})\b/.exec(r.body)?.[1]
        if (code && hashCode(challengeId, code) === row.code_hash) return code
      }
      throw new Error(`no code text for challenge ${challengeId}`)
    },
    texts: async (phone) =>
      (
        await t.db.selectFrom('sms_outbox').select(['body', 'klass']).where('to_e164', '=', phone).orderBy('queued_at').orderBy('id').execute()
      ).map((r) => ({ body: r.body, klass: r.klass })),
    advance(ms) {
      clock.set(new Date(clock.now().getTime() + ms))
    },
    nextIp,
    nextKey,
  }
  return self
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>
export const json = (r: LightMyRequestResponse): Json => r.json() as Json

export const MIN = 60_000
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR
