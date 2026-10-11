// Fixture of the identity-core suites (ADR 0160): an empty worker schema per test with one location, clients inserted on demand,
// the real messaging queue (the test numbers are on the allowlist, so a code is queued like in production) wrapped to record what
// was enqueued, a frozen clock, and the identity deps with a cheap scrypt cost (the production cost is the auth default).
import { beforeAll, beforeEach } from 'vitest'
import { sql } from 'kysely'
import { loadEnv, type Env } from '../../src/config/env.js'
import { FixedClock } from '../../src/platform/clock.js'
import type { Tx } from '../../src/platform/db.js'
import { createIdGenerator, type NewId } from '../../src/platform/ids.js'
import { ensureLocation } from '../../src/platform/locations.js'
import { messagingConfig } from '../../src/modules/messaging/config.js'
import { DbMessageQueue, type EnqueueArgs, type EnqueueOutcome } from '../../src/modules/messaging/queue.js'
import { identityDeps, type IdentityDeps } from '../../src/modules/identity/deps.js'
import { issueClientLink, type IssueLinkInput, type IssuedLink } from '../../src/modules/identity/links.js'
import { exchangeLink, type Exchanged } from '../../src/modules/identity/sessions.js'
import { hashCode } from '../../src/modules/public/otp.js'
import { ensurePermissionCatalog } from '../../src/modules/rbac/repository.js'
import { makeUser } from '../helpers/factories.js'
import { useTestDb } from '../helpers/db.js'
import { testDatabaseUrl } from '../helpers/env.js'

export const START = '2026-06-13T10:36:00-04:00'
export const PHONES = {
  maria: '+12015550111',
  liam: '+12015550112',
  stranger: '+12015550113',
  other: '+12015550114',
} as const
export const CHEAP_SCRYPT = { ln: 6, r: 8, p: 1 }

export class RecordingQueue {
  calls: EnqueueArgs[] = []
  constructor(private readonly inner: DbMessageQueue) {}
  async enqueueFor(tx: Tx, a: EnqueueArgs): Promise<EnqueueOutcome> {
    this.calls.push(a)
    return this.inner.enqueueFor(tx, a)
  }
}

export interface IdentityWorld {
  readonly t: ReturnType<typeof useTestDb>
  readonly clock: FixedClock
  readonly newId: NewId
  readonly env: Env
  readonly locationId: string
  readonly queue: RecordingQueue
  readonly d: IdentityDeps
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
  /** Inserts a live client (non-synthetic, opted in) and returns its id. */
  customer(o: { name?: string; phone?: string | null; email?: string | null; createdAt?: Date }): Promise<string>
  link(o: Partial<IssueLinkInput> & { customerId: string | null }): Promise<IssuedLink>
  /** Issues a link and exchanges it. */
  session(o: Partial<IssueLinkInput> & { customerId: string | null }): Promise<Exchanged & { link: IssuedLink }>
  /** The code the last otp_code text to `phone` carried (from the recorded enqueue; checked against the stored hash). */
  lastCode(challengeId: string): Promise<string>
  /** A signed-in employee holding set.billing: notifyManagers reaches them. */
  manager(): Promise<{ userId: string; employeeId: string }>
  advance(ms: number): void
  bumpEpoch(): Promise<void>
}

export function useIdentityWorld(): IdentityWorld {
  const clock = new FixedClock(START)
  // only the tables these suites touch are emptied (a full truncate per test costs a second): the location, the roles and the
  // permission catalog stay
  const t = useTestDb({ clock, truncate: false })
  const newId = createIdGenerator(clock)
  let env: Env
  let locationId = ''
  let queue: RecordingQueue
  let d: IdentityDeps

  beforeAll(async () => {
    await sql`truncate table customers, employees, settings, audit_log, notifications, public_otp_challenges, public_rate_limits,
      sms_opt_outs, sms_inbox, sms_devices, messages, message_threads, outbox_emails, realtime_events, identity_pin_failures, client_links,
      client_link_sessions, phone_trust, customer_pins, assistant_pending_actions, assistant_conversations restart identity cascade`.execute(t.db)
  })

  beforeEach(async () => {
    // deletes, not a truncate (a cascading truncate costs a second per test); the order follows the foreign keys
    await sql`truncate table audit_log`.execute(t.db)
    for (const table of [
      'client_link_sessions', 'client_links', 'phone_trust', 'customer_pins', 'assistant_pending_actions', 'assistant_conversations',
      'identity_pin_failures', 'public_otp_challenges', 'public_rate_limits', 'sms_opt_outs', 'sms_outbox', 'messages', 'sms_inbox',
      'sms_devices', 'message_threads', 'outbox_emails', 'notifications', 'realtime_events', 'memberships', 'appointments', 'vehicles',
      'customers', 'employee_permission_overrides', 'users', 'employees', 'settings',
    ])
      await sql`delete from ${sql.table(table)}`.execute(t.db)
    await t.db.transaction().execute((tx) => ensurePermissionCatalog(tx))
    env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: testDatabaseUrl(),
      SMS_ALLOWLIST: Object.values(PHONES).join(','),
      SMSGATE_MIN_INTERVAL_MS: '0',
    })
    locationId = (await ensureLocation(t.db, newId)).id
    queue = new RecordingQueue(new DbMessageQueue({ clock, newId, config: messagingConfig(env) }))
    d = { ...identityDeps({ db: t.db, clock, newId, env, queue, scrypt: CHEAP_SCRYPT }) }
  })

  const self: IdentityWorld = {
    get t() {
      return t
    },
    clock,
    newId,
    get env() {
      return env
    },
    get locationId() {
      return locationId
    },
    get queue() {
      return queue
    },
    get d() {
      return d
    },
    tx: (fn) => t.db.transaction().execute(fn),
    async customer(o) {
      const id = newId()
      await t.db
        .insertInto('customers')
        .values({
          id,
          full_name: o.name ?? 'Maria Delgado',
          phone_e164: o.phone === undefined ? PHONES.maria : o.phone,
          phone_display: null,
          email: o.email ?? null,
          notes: null,
          sms_opted_in: true,
          sms_opt_in_source: 'online',
          synthetic: false,
          needs_details: false,
          ...(o.createdAt ? { created_at: o.createdAt } : {}),
        })
        .execute()
      return id
    },
    link: (o) =>
      self.tx((tx) =>
        issueClientLink(tx, { newId, now: clock.now() }, { locationId, kind: 'calendar', issuedBy: 'staff', ...o }),
      ),
    async session(o) {
      const link = await self.link(o)
      const ex = await exchangeLink(t.db, { token: link.token, ip: '203.0.113.7', now: clock.now() })
      return { ...ex, link }
    },
    async lastCode(challengeId) {
      const call = [...queue.calls].reverse().find((c) => c.templateKey === 'otp_code')
      const code = String(call?.vars?.code ?? '')
      const row = await t.db.selectFrom('public_otp_challenges').select('code_hash').where('id', '=', challengeId).executeTakeFirstOrThrow()
      if (hashCode(challengeId, code) !== row.code_hash) throw new Error('the recorded code does not match the challenge')
      return code
    },
    async manager() {
      const u = await makeUser(t.db, newId, { first: 'Owner' })
      await t.db.insertInto('employee_permission_overrides').values({ employee_id: u.employeeId, permission_key: 'set.billing', effect: 'allow' }).execute()
      return u
    },
    advance(ms) {
      clock.set(new Date(clock.now().getTime() + ms))
    },
    async bumpEpoch() {
      await sql`insert into settings (location_id, key, value) values (${locationId}, 'links.epoch', '2'::jsonb)
        on conflict (location_id, key) do update set value = to_jsonb((settings.value)::text::int + 1), version = settings.version + 1`.execute(t.db)
    },
  }
  return self
}
