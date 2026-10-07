// Shared fixture of the messaging-on-Postgres suites: the `design` seed (customers with synthetic phones, catalog, bays,
// people, and the simulator SMS device), a frozen clock, a messaging runtime over the worker schema, and helpers to
// stage appointments, drive the dispatcher and read what ended up in the tables.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { sql } from 'kysely'
import { runSeed } from '../../db/seeds/index.js'
import { SIM_DEVICE_KEY, SIM_WEBHOOK_SECRET } from '../../db/seeds/messaging.js'
import { loadEnv, type Env } from '../../src/config/env.js'
import { FixedClock, PARITY_NOW } from '../../src/platform/clock.js'
import type { Tx } from '../../src/platform/db.js'
import { createIdGenerator, type NewId } from '../../src/platform/ids.js'
import { schedulingPortsFor } from '../../src/composition.js'
import type { DeviceRow } from '../../src/modules/messaging/db/devices.js'
import { MessagingRuntime, type RuntimeDeps } from '../../src/modules/messaging/runtime.js'
import type { SimulatorProvider } from '../../src/integrations/sms/simulator.js'
import type { SimDelivery } from '../../src/integrations/smsgate/sim-device.js'
import { signWebhook } from '../../src/integrations/smsgate/signature.js'
import { createTestDb, truncateAll, type TestDb } from '../helpers/db.js'
import { testDatabaseUrl } from '../helpers/env.js'

export const FRIDAY_NOON = '2026-06-12T12:00:00-04:00'
export const STRANGER = '+13055550199'

export interface World {
  readonly t: TestDb
  readonly clock: FixedClock
  readonly env: Env
  readonly rt: MessagingRuntime
  readonly newId: NewId
  readonly locationId: string
  /** The seeded simulator device row (fresh from the database). */
  device(): Promise<DeviceRow>
  sim(): Promise<SimulatorProvider>
  customer(name: string): { id: string; phone: string }
  /** Inserts a booked (or other status) appointment for a seeded customer and returns its id. */
  appointment(o: { customer: string; at: string; status?: string; service?: string; completedAt?: string }): Promise<string>
  /** One dispatcher tick over every enabled device. */
  tick(): Promise<Awaited<ReturnType<MessagingRuntime['tickAll']>>>
  /** Waits for the webhook events accepted so far to be applied. */
  settle(): Promise<void>
  /** Runs fn in a transaction like a request. */
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>
  messagesOf(customer: string): Promise<Array<{ id: string; direction: string; status: string; body: string; template_key: string | null; appointment_id: string | null; klass: string | null; error: string | null }>>
  /** A signed SMS Gate webhook body and headers for the seeded device, signed at the frozen clock. */
  signed(event: string, payload: Record<string, unknown>, o?: { id?: string; secret?: string; timestamp?: number }): { headers: Record<string, string>; body: string; id: string }
}

export function useWorld(o: { start?: string; env?: Record<string, string>; autoProgress?: 'instant' | 'manual'; deps?: Partial<RuntimeDeps> } = {}): World {
  let t: TestDb
  let clock: FixedClock
  let env: Env
  let rt: MessagingRuntime
  let locationId = ''
  let newId: NewId
  const customers = new Map<string, { id: string; phone: string }>()
  const services = new Map<string, { id: string; price: number; duration: number }>()
  const start = o.start ?? PARITY_NOW
  const mailDir = mkdtempSync(path.join(tmpdir(), 'oasis-mail-'))
  let seq = 0

  beforeAll(async () => {
    clock = new FixedClock(start)
    t = await createTestDb({ clock, poolMax: 8 })
    await truncateAll(t.db)
    await runSeed({ db: t.db, clock, profile: 'design' })
    locationId = (await t.db.selectFrom('locations').select('id').executeTakeFirstOrThrow()).id
    newId = createIdGenerator(clock)
    for (const c of await t.db.selectFrom('customers').select(['id', 'full_name', 'phone_e164']).execute())
      if (c.phone_e164) customers.set(c.full_name, { id: c.id, phone: c.phone_e164 })
    for (const s of await t.db.selectFrom('services').select(['id', 'name', 'price_cents', 'duration_min']).where('kind', '=', 'package').execute())
      services.set(s.name, { id: s.id, price: s.price_cents, duration: s.duration_min })
    const allow = [...[...customers.values()].map((c) => c.phone), STRANGER, '+13055550198'].join(',')
    env = loadEnv({
      NODE_ENV: 'test',
      DATABASE_URL: testDatabaseUrl(),
      SMS_ALLOWLIST: allow,
      EMAIL_CONSOLE_DIR: mailDir,
      SMSGATE_MIN_INTERVAL_MS: '0',
      ...o.env,
    })
  })

  const fresh = (): MessagingRuntime => {
    const holder: { rt?: MessagingRuntime } = {}
    const r = new MessagingRuntime({
      db: t.db,
      clock,
      newId,
      env,
      connection: t.connection,
      simAutoProgress: o.autoProgress ?? 'manual',
      schedulingPorts: () => schedulingPortsFor({ db: t.db, clock, env, newId }, holder.rt!),
      ...o.deps,
    })
    holder.rt = r
    return r
  }

  beforeEach(async () => {
    clock.set(start)
    await sql`truncate table messages, message_threads, sms_outbox, sms_inbox, sms_usage, sms_processed_events, sms_opt_outs, outbox_emails, notifications, realtime_events, webhook_log, appointments, activity_log, audit_log restart identity cascade`.execute(t.db)
    await sql`update customers set sms_opted_in = true, sms_opt_in_source = 'online', sms_opted_out_at = null`.execute(t.db)
    await sql`update sms_devices set status = 'unknown', state_changed_at = null, last_seen_at = null, last_ping_at = null, last_app_started_at = null,
      last_poll_ok_at = null, consecutive_poll_failures = 0, health_status = null, battery = null, charging = null, last_error = null,
      sent_count = 0, delivered_count = 0, failed_count = 0, received_count = 0, enabled = true, remote_device_id = null`.execute(t.db)
    rt = fresh()
  })

  afterAll(async () => {
    await rt?.idle()
    await t?.close()
  })

  const self: World = {
    get t() {
      return t
    },
    get clock() {
      return clock
    },
    get env() {
      return env
    },
    get rt() {
      return rt
    },
    get newId() {
      return newId
    },
    get locationId() {
      return locationId
    },
    async device() {
      return (await rt.store.getByKey(SIM_DEVICE_KEY))!
    },
    async sim() {
      return rt.simulator(await self.device())!
    },
    customer(name) {
      const c = customers.get(name)
      if (!c) throw new Error(`no customer ${name}`)
      return c
    },
    async appointment(a) {
      const svc = services.get(a.service ?? 'Express Hand Wash')!
      const startAt = new Date(a.at)
      const id = newId()
      await t.db
        .insertInto('appointments')
        .values({
          id,
          location_id: locationId,
          customer_id: self.customer(a.customer).id,
          service_id: svc.id,
          package_name: a.service ?? 'Express Hand Wash',
          price_cents: svc.price,
          duration_min: svc.duration,
          status: (a.status ?? 'booked') as never,
          scheduled_start: startAt,
          scheduled_end: new Date(startAt.getTime() + svc.duration * 60_000),
          completed_at: a.completedAt ? new Date(a.completedAt) : null,
        })
        .execute()
      return id
    },
    tick: () => rt.tickAll(),
    settle: () => rt.idle(),
    tx: (fn) => t.db.transaction().execute(fn),
    async messagesOf(name) {
      return t.db
        .selectFrom('messages')
        .select(['id', 'direction', 'status', 'body', 'template_key', 'appointment_id', 'klass', 'error'])
        .where('customer_id', '=', self.customer(name).id)
        .orderBy('queued_at')
        .orderBy('id')
        .execute()
    },
    signed(event, payload, s = {}) {
      seq += 1
      const id = s.id ?? `evt-${seq}-${newId().slice(-8)}`
      const body = JSON.stringify({ id, webhookId: `oasis-${event.replace(':', '-')}`, event, deviceId: 'remote-device-1', payload })
      const ts = s.timestamp ?? Math.floor(clock.now().getTime() / 1000)
      return {
        id,
        body,
        headers: { 'x-signature': signWebhook(s.secret ?? SIM_WEBHOOK_SECRET, body, String(ts)), 'x-timestamp': String(ts), 'content-type': 'application/json' },
      }
    },
  }
  return self
}

export const deliveryOf = (d: SimDelivery): { headers: Record<string, string>; body: string } => ({ headers: d.headers, body: d.body })
