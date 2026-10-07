// The SMS Gate webhook: verify the HMAC over the raw body, persist the envelope in webhook_log (unique per envelope id),
// answer 2xx at once, and apply the event asynchronously in one transaction (envelope marker, outbox and message state,
// inbound routing, device health). A crash between "persisted" and "applied" leaves a `received` row that the sweep picks up.
import { sql } from 'kysely'
import { transaction, type Tx } from '../../platform/db.js'
import { SmsProviderError } from '../../integrations/sms/errors.js'
import { SmsWebhookError } from '../../integrations/sms/errors.js'
import type { SmsEvent, SmsProvider } from '../../integrations/ports/sms.js'
import type { SimDelivery } from '../../integrations/smsgate/sim-device.js'
import { verifyAndParse, type ParsedWebhook } from '../../integrations/smsgate/webhook.js'
import { PgCustomerDirectory } from './db/directory.js'
import { PgDeviceRepository } from './db/device-repo.js'
import type { DeviceRow } from './db/devices.js'
import { PgInboxRepository } from './db/inbox-repo.js'
import { PgOptOutRepository } from './db/optout-repo.js'
import { PgOutboxRepository } from './db/outbox-repo.js'
import { PgProcessedEvents } from './db/processed-repo.js'
import { DeviceHealthMonitor } from './dispatch/health.js'
import { Dispatcher } from './dispatch/dispatcher.js'
import { SmsEventIngestor, type IngestResult } from './dispatch/ingest.js'
import { createInboundEffects } from './inbound-effects.js'
import { InboundService } from './inbound/service.js'
import { notifyManagers } from './notify.js'
import type { MessagingRuntime } from './runtime.js'
import './schema.js'

export interface WebhookResponse {
  status: number
  body: { ok: boolean; status: string; message?: string }
}

const STORED_HEADERS = ['x-signature', 'x-timestamp', 'content-type', 'user-agent'] as const
const FOREVER = Number.MAX_SAFE_INTEGER
const SWEEP_AFTER_MS = 30_000
const GIVE_UP_AFTER_MS = 24 * 3600_000

const unusedProvider: SmsProvider = {
  send: () => Promise.reject(new SmsProviderError('protocol', 'a webhook event never sends')),
  status: () => Promise.reject(new SmsProviderError('protocol', 'a webhook event never looks a message up')),
  health: () => Promise.reject(new SmsProviderError('protocol', 'a webhook event never polls')),
  registerWebhooks: () => Promise.reject(new SmsProviderError('protocol', 'a webhook event never registers')),
  verifyAndParseWebhook: () => {
    throw new SmsProviderError('protocol', 'already verified')
  },
}

const lower = (h: Record<string, string | string[] | undefined>): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]))

export class WebhookService {
  private readonly inflight = new Set<Promise<unknown>>()

  constructor(private readonly rt: MessagingRuntime) {}

  idle(): Promise<void> {
    return (async () => {
      while (this.inflight.size > 0) await Promise.allSettled([...this.inflight])
    })()
  }

  /** A signed delivery from an in-process simulated device, handled exactly like an HTTP hit. */
  receiveSim(device: DeviceRow, d: SimDelivery): void {
    const p = this.receive(device.device_key, d.headers, d.body).catch((err: unknown) => {
      this.rt.log.error({ err: (err as Error).message, device: device.device_key }, 'simulated webhook failed')
    })
    this.track(p)
  }

  private track<T>(p: Promise<T>): void {
    this.inflight.add(p)
    void p.finally(() => this.inflight.delete(p))
  }

  /**
   * The route handler body. 401 for anything that does not verify (missing headers, bad or stale signature), 400 for a
   * verified-but-unreadable body, 200 for everything accepted (including a repeat and an event type Oasis ignores, so the
   * device stops retrying them). The event is applied after the answer.
   */
  async receive(deviceKey: string, rawHeaders: Record<string, string | string[] | undefined>, raw: string): Promise<WebhookResponse> {
    const device = await this.rt.store.getByKey(deviceKey)
    if (!device) return { status: 404, body: { ok: false, status: 'unknown_device' } }
    const headers = lower(rawHeaders)
    const secret = this.rt.store.secrets(device).webhookSecret
    let parsed: ParsedWebhook
    try {
      parsed = verifyAndParse(headers, raw, { secret, toleranceSec: this.rt.config.webhookToleranceSec, clock: this.rt.clock })
    } catch (err) {
      if (!(err instanceof SmsWebhookError)) throw err
      if (err.code === 'unsupported_event') return { status: 200, body: { ok: true, status: 'ignored' } }
      const status = err.code === 'bad_body' ? 400 : 401
      this.rt.log.warn({ device: device.device_key, code: err.code }, 'smsgate webhook rejected')
      return { status, body: { ok: false, status: err.code, message: err.message } }
    }

    const stored: Record<string, string> = { 'x-device-key': device.device_key }
    for (const h of STORED_HEADERS) if (headers[h]) stored[h] = headers[h]!
    const inserted = await this.rt.db
      .insertInto('webhook_log')
      .values({
        id: this.rt.newId(),
        provider: 'smsgate',
        external_id: parsed.envelopeId,
        headers: JSON.stringify(stored),
        body: raw,
        signature_valid: true,
        received_at: this.rt.clock.now(),
      })
      .onConflict((oc) => oc.columns(['provider', 'external_id']).doNothing())
      .returning('id')
      .executeTakeFirst()
    if (!inserted) {
      // The device retried a delivery we already hold. If the first attempt never got applied, apply it now.
      const prior = await this.rt.db.selectFrom('webhook_log').select(['id', 'status']).where('provider', '=', 'smsgate').where('external_id', '=', parsed.envelopeId).executeTakeFirst()
      if (prior?.status === 'received') this.schedule(prior.id)
      return { status: 200, body: { ok: true, status: 'duplicate' } }
    }
    this.schedule(inserted.id)
    return { status: 200, body: { ok: true, status: 'accepted' } }
  }

  private schedule(logId: string): void {
    const p = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.process(logId))
      .catch((err: unknown) => {
        this.rt.log.error({ err: (err as Error).message, logId }, 'webhook processing failed; the sweep will retry')
      })
    this.track(p)
  }

  /** Applies one stored envelope in a single transaction. Idempotent: a row that is not `received` is left alone. */
  async process(logId: string): Promise<'processed' | 'ignored' | 'skipped'> {
    let appStartedFor: DeviceRow | null = null
    const outcome = await transaction(this.rt.db, async (tx) => {
      const row = await tx.selectFrom('webhook_log').selectAll().where('id', '=', logId).where('status', '=', 'received').forUpdate().skipLocked().executeTakeFirst()
      if (!row || row.body === null) return 'skipped' as const
      const key = (row.headers as Record<string, string>)['x-device-key']
      const device = key ? await this.rt.store.getByKey(key) : null
      if (!device) {
        await tx.updateTable('webhook_log').set({ status: 'failed', processed_at: this.rt.clock.now(), error: 'unknown device' }).where('id', '=', logId).execute()
        return 'ignored' as const
      }
      const parsed = verifyAndParse(row.headers as Record<string, string>, row.body, {
        secret: this.rt.store.secrets(device).webhookSecret,
        toleranceSec: FOREVER,
        clock: this.rt.clock,
      })
      const event = this.withDeviceId(parsed.event, device.id)
      const result = await this.apply(tx, device, event, parsed)
      if (result.outcome === 'handled' && result.health?.appStarted) appStartedFor = device
      const ignored = result.outcome === 'duplicate' || (result.outcome === 'handled' && result.result.detail === 'ignored_unknown_message')
      await tx
        .updateTable('webhook_log')
        .set({ status: ignored ? 'ignored' : 'processed', processed_at: this.rt.clock.now(), error: null })
        .where('id', '=', logId)
        .execute()
      return ignored ? ('ignored' as const) : ('processed' as const)
    }).catch(async (err: unknown) => {
      await sql`update webhook_log set error = ${(err as Error).message.slice(0, 500)} where id = ${logId}`.execute(this.rt.db).catch(() => undefined)
      throw err
    })
    // The app restarted (reboot, update, crash): its webhook registrations may be gone.
    if (appStartedFor) await this.rt.registerWebhooks(appStartedFor)
    return outcome
  }

  private withDeviceId(e: SmsEvent, deviceId: string): SmsEvent {
    return 'deviceId' in e ? { ...e, deviceId } : e
  }

  private async apply(tx: Tx, device: DeviceRow, event: SmsEvent, parsed: ParsedWebhook): Promise<IngestResult> {
    const rt = this.rt
    const cfg = rt.config.dispatch({ id: device.id, simSlotDefault: device.sim_slot_default, minIntervalMs: device.min_interval_ms, maxPerWindow: device.max_per_window, windowMinutes: device.window_minutes })
    const monitor = new DeviceHealthMonitor(new PgDeviceRepository(tx, rt.onTransition), rt.clock, cfg.health)
    const dispatcher = new Dispatcher(unusedProvider, new PgOutboxRepository(tx, { deviceId: device.id }), monitor, rt.clock, cfg.dispatcher)
    const inboxRepo = new PgInboxRepository(tx, rt.newId)
    const effects = createInboundEffects(
      tx,
      {
        clock: rt.clock,
        newId: rt.newId,
        queue: rt.queue,
        schedulingCtx: (locationId) => rt.schedulingCtx(locationId),
        notifyManagers: async (t, n) => void (await notifyManagers(t, n, rt.deps)),
        warn: (msg, detail) => rt.log.warn(detail, msg),
      },
      {
        locationId: device.location_id,
        inbox: inboxRepo,
        event: { deviceId: device.id, providerMessageId: event.kind === 'received' ? event.providerMessageId : '' },
      },
    )
    const inbound = new InboundService(
      inboxRepo,
      new PgOptOutRepository(tx, { locationId: device.location_id, newId: rt.newId }),
      new PgCustomerDirectory(tx, device.location_id),
      effects,
      rt.clock,
      { timeZone: rt.config.tz, ...(rt.config.businessPhone ? { businessPhone: rt.config.businessPhone } : {}) },
    )
    const ingestor = new SmsEventIngestor(new PgProcessedEvents(tx), dispatcher, rt.clock, async (e) => {
      await inbound.handleReceived(e)
    })
    await rt.store.noteRemoteId(device.id, parsed.deviceId)
    const result = await ingestor.ingest(event, parsed.extras.health ? { health: parsed.extras.health } : {})
    if (event.kind === 'received' && result.outcome === 'received') await rt.store.bumpReceived(device.id)
    return result
  }

  /** Applies envelopes that were persisted but never applied (a crash, a lock timeout); gives up on ones older than a day. */
  async sweep(limit = 50): Promise<{ processed: number; abandoned: number }> {
    const now = this.rt.clock.now()
    const abandoned = await this.rt.db
      .updateTable('webhook_log')
      .set({ status: 'failed', processed_at: now, error: 'not applied within 24 hours' })
      .where('provider', '=', 'smsgate')
      .where('status', '=', 'received')
      .where('received_at', '<', new Date(now.getTime() - GIVE_UP_AFTER_MS))
      .returning('id')
      .execute()
    const rows = await this.rt.db
      .selectFrom('webhook_log')
      .select('id')
      .where('provider', '=', 'smsgate')
      .where('status', '=', 'received')
      .where('received_at', '<', new Date(now.getTime() - SWEEP_AFTER_MS))
      .orderBy('received_at')
      .limit(limit)
      .execute()
    let processed = 0
    for (const r of rows) {
      try {
        if ((await this.process(r.id)) !== 'skipped') processed += 1
      } catch (err) {
        this.rt.log.error({ err: (err as Error).message, logId: r.id }, 'webhook sweep: event still failing')
      }
    }
    return { processed, abandoned: abandoned.length }
  }
}
