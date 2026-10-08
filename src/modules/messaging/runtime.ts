// The messaging runtime: everything that turns the pure dispatcher, router and policy into a working SMS channel on
// Postgres. It owns the device store, the per-device providers, the outbound queue, the email sender and the operations
// the jobs and the HTTP routes call (tick, reconcile, health poll, webhook registration, webhook processing).
// Construction does no I/O, so an app built with inert dependencies (the OpenAPI script) can still register its routes.
import { sql } from 'kysely'
import type { Env } from '../../config/env.js'
import type { Clock } from '../../platform/clock.js'
import { connectDedicated, type Db, type DbOptions, type Executor, type Tx } from '../../platform/db.js'
import type { NewId } from '../../platform/ids.js'
import * as realtime from '../../platform/realtime.js'
import { createEmailProvider } from '../../integrations/email/config.js'
import type { EmailProvider } from '../../integrations/ports/email.js'
import { withSuppression } from '../../integrations/email/suppression.js'
import type { SmsProvider } from '../../integrations/ports/sms.js'
import { SimulatorProvider } from '../../integrations/sms/simulator.js'
import type { SchedulingCtx } from '../scheduling/context.js'
import { locationTimezone } from '../scheduling/context.js'
import type { SchedulingPorts } from '../scheduling/ports.js'
import { messagingConfig, type MessagingConfig } from './config.js'
import { createSecretBox, type SecretBox } from './crypto.js'
import { DeviceStore, type DeviceRow } from './db/devices.js'
import { PgDeviceRepository, type DeviceTransition } from './db/device-repo.js'
import { PgOutboxRepository } from './db/outbox-repo.js'
import { DeviceHealthMonitor, pollDeviceHealth, signalFromHealth, type HealthEvaluation } from './dispatch/health.js'
import { Dispatcher, type TickReport } from './dispatch/dispatcher.js'
import type { HealthConfig } from './dispatch/health.js'
import { dbSuppressionCheck, noticeSuppressedAccountLink } from './email/feedback.js'
import { EmailSender, queueEmail, type EmailVars } from './email/service.js'
import { notifyManagers, publishToManagers, type NoticeSpec } from './notify.js'
import { ProviderRegistry } from './providers.js'
import { DbMessageQueue } from './queue.js'
import { WebhookService } from './webhook.js'
import './schema.js'

export interface LoggerLike {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

const silent: LoggerLike = { info: () => undefined, warn: () => undefined, error: () => undefined }

export interface RuntimeDeps {
  db: Db
  clock: Clock
  newId: NewId
  env: Env
  /** Settings for dedicated connections (the leader lock). Defaults to DATABASE_URL and DB_SEARCH_PATH. */
  connection?: DbOptions
  logger?: LoggerLike
  /** Replaces the EmailProvider factory (tests). */
  emailProvider?: EmailProvider
  /** The scheduling ports a customer's "C" reply is confirmed through; defaults to a context that cannot touch invoices. */
  schedulingPorts?: () => SchedulingPorts
  /** Replaces SmsProvider construction (tests, spikes). */
  providerOverride?: (row: DeviceRow, secrets: { password: string | null; webhookSecret: string }) => SmsProvider | undefined
  simAutoProgress?: 'instant' | 'manual'
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
}

export interface DeviceTick {
  device: DeviceRow
  report: TickReport
}

export class MessagingRuntime {
  readonly config: MessagingConfig
  readonly secrets: SecretBox
  readonly store: DeviceStore
  readonly providers: ProviderRegistry
  readonly queue: DbMessageQueue
  readonly emailSender: EmailSender
  readonly webhooks: WebhookService
  readonly log: LoggerLike
  private email: EmailProvider | undefined

  constructor(readonly deps: RuntimeDeps) {
    this.config = messagingConfig(deps.env)
    this.log = deps.logger ?? silent
    this.secrets = createSecretBox(deps.env.SECRETS_KEY, deps.env.NODE_ENV)
    this.store = new DeviceStore(deps.db, this.secrets, { clock: deps.clock, newId: deps.newId })
    this.webhooks = new WebhookService(this)
    this.providers = new ProviderRegistry({
      config: this.config,
      clock: deps.clock,
      secrets: (row) => this.store.secrets(row),
      onSimDelivery: (device, d) => this.webhooks.receiveSim(device, d),
      ...(deps.providerOverride ? { override: deps.providerOverride } : {}),
      ...(deps.simAutoProgress ? { simAutoProgress: deps.simAutoProgress } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    })
    this.queue = new DbMessageQueue({
      clock: deps.clock,
      newId: deps.newId,
      config: this.config,
      warn: (msg, detail) => this.log.warn(detail, msg),
    })
    this.emailSender = new EmailSender(deps.db, deps.clock, () => this.emailProvider())
  }

  get db(): Db {
    return this.deps.db
  }
  get clock(): Clock {
    return this.deps.clock
  }
  get newId(): NewId {
    return this.deps.newId
  }

  /** The EmailProvider of this process; an address on the suppression list (SES bounces, complaints) is never mailed. */
  emailProvider(): EmailProvider {
    return (this.email ??= withSuppression(
      this.deps.emailProvider ?? createEmailProvider(this.deps.env, { clock: this.deps.clock, onSimSend: this.emailSender.capture }),
      dbSuppressionCheck(this.deps.db),
    ))
  }

  /** The deployment's single location (the oldest row). */
  async location(db: Executor = this.db): Promise<{ id: string; tz: string }> {
    const r = await db.selectFrom('locations').select(['id', 'timezone']).orderBy('created_at').orderBy('id').limit(1).executeTakeFirstOrThrow()
    return { id: r.id, tz: r.timezone }
  }

  async schedulingCtx(locationId: string): Promise<SchedulingCtx> {
    const ports = this.deps.schedulingPorts?.()
    if (!ports) throw new Error('messaging: no scheduling ports configured; a customer reply cannot confirm an appointment')
    return { clock: this.clock, newId: this.newId, locationId, tz: await locationTimezone(this.db, locationId), ports }
  }

  // ---- devices ---------------------------------------------------------------------------------------------------

  /** Pushes a device-state change to the people who can act on it. Runs inside the transaction that saved the state. */
  readonly onTransition = async (tx: Tx, t: DeviceTransition): Promise<void> => {
    const dev = await tx.selectFrom('sms_devices').select(['location_id', 'label']).where('id', '=', t.deviceId).executeTakeFirst()
    if (!dev) return
    const payload = { deviceId: t.deviceId, label: dev.label, from: t.from, to: t.to }
    const spec = (kind: string, title: string, body: string): NoticeSpec => ({
      locationId: dev.location_id,
      kind,
      title,
      body,
      entityType: 'sms_device',
      entityId: t.deviceId,
      event: { type: 'sms.device.health', payload },
    })
    if (t.to === 'offline')
      await notifyManagers(tx, spec('sms.device_offline', 'SMS device offline', `${dev.label} stopped responding. Texts wait in the queue until it is back.`), this.deps)
    else if (t.from === 'offline')
      await notifyManagers(tx, spec('sms.device_recovered', 'SMS device back online', `${dev.label} is responding again. Queued texts are being sent.`), this.deps)
    else if (t.from !== 'unknown') await publishToManagers(tx, dev.location_id, 'sms.device.health', payload)
    await realtime.publish(tx, { locationId: dev.location_id, channel: 'ops', type: 'alerts.changed', payload: { source: 'sms', kind: 'device_health' } })
  }

  dispatcherFor(device: DeviceRow, exec: Executor = this.db): { dispatcher: Dispatcher; monitor: DeviceHealthMonitor; health: HealthConfig; provider: SmsProvider } {
    const cfg = this.config.dispatch({
      id: device.id,
      simSlotDefault: device.sim_slot_default,
      minIntervalMs: device.min_interval_ms,
      maxPerWindow: device.max_per_window,
      windowMinutes: device.window_minutes,
    })
    const provider = this.providers.forDevice(device)
    const monitor = new DeviceHealthMonitor(new PgDeviceRepository(exec, this.onTransition), this.clock, cfg.health)
    const dispatcher = new Dispatcher(provider, new PgOutboxRepository(exec, { deviceId: device.id }), monitor, this.clock, cfg.dispatcher)
    return { dispatcher, monitor, health: cfg.health, provider }
  }

  // ---- operations the jobs call ----------------------------------------------------------------------------------

  async tickAll(): Promise<DeviceTick[]> {
    const out: DeviceTick[] = []
    for (const device of await this.store.listEnabled()) {
      try {
        const { dispatcher } = this.dispatcherFor(device)
        const report = await dispatcher.tick()
        if (report.p0FallbackCandidates.length > 0) await this.emailFallback(report.p0FallbackCandidates)
        if (report.sent.length || report.failed.length || report.expired.length)
          this.log.info({ device: device.device_key, sent: report.sent.length, failed: report.failed.length, expired: report.expired.length }, 'sms tick')
        out.push({ device, report })
      } catch (err) {
        this.log.error({ err: (err as Error).message, device: device.device_key }, 'sms tick failed')
      }
    }
    return out
  }

  async reconcileAll(): Promise<Array<{ device: DeviceRow; checked: number; updated: number; resent: number; errors: number }>> {
    const out = []
    for (const device of await this.store.listEnabled()) {
      try {
        out.push({ device, ...(await this.dispatcherFor(device).dispatcher.reconcile()) })
      } catch (err) {
        this.log.error({ err: (err as Error).message, device: device.device_key }, 'sms reconcile failed')
      }
    }
    await this.purge()
    return out
  }

  /** Asks each device for its health and feeds the monitor. Returns the evaluation per device. */
  async pollHealthAll(): Promise<Array<{ device: DeviceRow; evaluation: HealthEvaluation }>> {
    const out = []
    for (const device of await this.store.listEnabled()) out.push({ device, evaluation: await this.pollHealth(device) })
    return out
  }

  async pollHealth(device: DeviceRow): Promise<HealthEvaluation> {
    const { monitor, provider } = this.dispatcherFor(device)
    try {
      const evaluation = await pollDeviceHealth(provider, monitor, device.id, this.clock)
      await this.store.noteError(device.id, null)
      return evaluation
    } catch (err) {
      await this.store.noteError(device.id, (err as Error).message.slice(0, 300))
      return monitor.record(device.id, signalFromHealth({ ok: false, details: { reachable: false } }, this.clock.now()))
    }
  }

  /** The URL the tablet calls for this device, or null when SMSGATE_WEBHOOK_PUBLIC_URL is not set. */
  webhookUrlFor(device: DeviceRow): string | null {
    if (this.config.webhookPublicUrl) return `${this.config.webhookPublicUrl}/${device.device_key}`
    return device.provider === 'sim' ? `http://127.0.0.1:${this.deps.env.HOOKS_PORT}/hooks/smsgate/${device.device_key}` : null
  }

  async registerWebhooks(device: DeviceRow): Promise<{ registered: boolean; url: string | null; error?: string }> {
    const url = this.webhookUrlFor(device)
    if (!url) {
      const error = 'SMSGATE_WEBHOOK_PUBLIC_URL is not set, so the tablet has no address to send webhooks to'
      await this.store.noteError(device.id, error)
      return { registered: false, url: null, error }
    }
    try {
      await this.providers.forDevice(device).registerWebhooks(url, this.store.secrets(device).webhookSecret)
      await this.store.noteRegistered(device.id, url, this.clock.now())
      return { registered: true, url }
    } catch (err) {
      const error = (err as Error).message.slice(0, 300)
      await this.store.noteError(device.id, error)
      this.log.warn({ err: error, device: device.device_key }, 'webhook registration failed')
      return { registered: false, url, error }
    }
  }

  async registerAll(): Promise<Array<{ device: DeviceRow; registered: boolean; error?: string }>> {
    const out = []
    for (const device of await this.store.listEnabled()) out.push({ device, ...(await this.registerWebhooks(device)) })
    return out
  }

  /** Housekeeping the reconcile job runs: old window accounting, old envelope ids, sensitive text that outlived its use. */
  async purge(): Promise<void> {
    const now = this.clock.now()
    const day = 86_400_000
    await sql`delete from sms_usage where coalesce(sent_at, accepted_at) < ${new Date(now.getTime() - 2 * day)}`.execute(this.db)
    await sql`delete from sms_processed_events where processed_at < ${new Date(now.getTime() - 30 * day)}`.execute(this.db)
    await sql`update sms_outbox set body = '[link sent privately]'
      where klass in ('staff_invite', 'password_reset') and state in ('sent', 'accepted')
        and coalesce(sent_at, accepted_at) < ${new Date(now.getTime() - 6 * 3600_000)}`.execute(this.db)
  }

  /**
   * A staff invite or reset that sat in the queue while the device was away is e-mailed instead (once), reusing the link in
   * the queued text. Customer-facing texts have no e-mail template: they wait (and expire) and managers already hold the
   * device-down notification.
   */
  async emailFallback(outboxIds: string[]): Promise<number> {
    let n = 0
    for (const id of outboxIds) {
      const r = await this.db
        .selectFrom('sms_outbox as o')
        .innerJoin('messages as m', 'm.id', 'o.message_id')
        .innerJoin('employees as e', 'e.id', 'm.employee_id')
        .select(['o.klass', 'o.body', 'm.location_id', 'm.employee_id', 'e.first', 'e.email'])
        .where('o.id', '=', id)
        .where('o.fallback_emailed_at', 'is', null)
        .where('o.state', '=', 'pending')
        .executeTakeFirst()
      if (!r || !r.email || (r.klass !== 'staff_invite' && r.klass !== 'password_reset')) continue
      const link = /https?:\/\/\S+/.exec(r.body)?.[0]
      if (!link) continue
      const vars: EmailVars =
        r.klass === 'staff_invite' ? { inviteeName: r.first, inviteUrl: link } : { recipientName: r.first, resetUrl: link, expiresMinutes: 30 }
      const queued = await this.db.transaction().execute(async (tx) => {
        const q = await queueEmail(
          tx,
          { locationId: r.location_id, to: r.email!, template: r.klass, vars, purpose: 'sms-fallback', employeeId: r.employee_id, dedupeKey: `sms-fallback:${id}` },
          this.deps,
        )
        await tx.updateTable('sms_outbox').set({ fallback_emailed_at: this.clock.now() }).where('id', '=', id).execute()
        return q
      })
      if (!queued.duplicate) {
        const sent = await this.emailSender.sendNow(queued.emailId)
        if (sent === 'suppressed')
          await noticeSuppressedAccountLink(
            this.db,
            { locationId: r.location_id, employeeId: r.employee_id!, firstName: r.first, kind: r.klass === 'staff_invite' ? 'invite' : 'password_reset', address: r.email },
            this.deps,
          )
        n += 1
      }
    }
    return n
  }

  // ---- leadership ------------------------------------------------------------------------------------------------

  private connectionOptions(): DbOptions {
    const e = this.deps.env
    return this.deps.connection ?? { url: e.DATABASE_URL, ...(e.DB_SEARCH_PATH ? { searchPath: e.DB_SEARCH_PATH } : {}), clock: this.clock }
  }

  /**
   * Runs fn only while holding the named session advisory lock (scoped to the database schema), so two processes never
   * run the dispatch loop at once. Returns null when another process is the leader.
   */
  async withLeader<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
    const client = await connectDedicated(this.connectionOptions())
    try {
      const r = await client.query<{ ok: boolean }>('select pg_try_advisory_lock(hashtext($1 || current_schema())) as ok', [name])
      if (!r.rows[0]?.ok) return null
      return await fn()
    } finally {
      await client.end().catch(() => undefined)
    }
  }

  /** The simulated device behind a provider=sim row (inject inbound, fail, outage), when it is one. */
  simulator(device: DeviceRow): SimulatorProvider | undefined {
    return this.providers.sim(device)
  }

  /** Resolves once the webhook events accepted so far have been processed (tests, graceful shutdown). */
  idle(): Promise<void> {
    return this.webhooks.idle()
  }
}

let shared: WeakMap<object, MessagingRuntime> | undefined

/** One runtime per db handle, so the API modules, the hooks listener and the jobs of a process share providers and state. */
export function runtimeFor(deps: RuntimeDeps, key: object = deps.db): MessagingRuntime {
  shared ??= new WeakMap()
  let rt = shared.get(key)
  if (!rt) {
    rt = new MessagingRuntime(deps)
    shared.set(key, rt)
  }
  return rt
}
