// The SMS Gate webhook: verify the HMAC over the raw body, persist the envelope in webhook_log (unique per envelope id),
// answer 2xx at once, and apply the event asynchronously in one transaction (envelope marker, outbox and message state,
// inbound routing, device health). A crash between "persisted" and "applied" leaves a `received` row that the sweep picks up.
import { createHash } from 'node:crypto'
import { sql } from 'kysely'
import { transaction, type Tx } from '../../platform/db.js'
import { SmsProviderError } from '../../integrations/sms/errors.js'
import { SmsWebhookError } from '../../integrations/sms/errors.js'
import { normalizeE164 } from '../../integrations/sms/phone.js'
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
import { InboundService, type InboundOutcome } from './inbound/service.js'
import { CODE_MASK, parseReplyCode } from './inbound/keywords.js'
import { maskCardNumbers } from './inbound/cards.js'
import { noteAppStarted } from './device-notices.js'
import { notifyManagers } from './notify.js'
import type { MessagingRuntime } from './runtime.js'
import './schema.js'

export interface WebhookResponse {
  status: number
  body: { ok: boolean; status: string; message?: string }
}

const STORED_HEADERS = ['x-signature', 'x-timestamp', 'content-type', 'user-agent'] as const
/** An unparsed delivery keeps only the start of its body: enough to see what the device sent (ADR 0151). */
export const UNPARSED_BODY_BYTES = 4096

function firstBytes(raw: string, max: number): string {
  const clean = raw.replaceAll('\u0000', '')
  const buf = Buffer.from(clean, 'utf8')
  return buf.length <= max ? clean : buf.subarray(0, max).toString('utf8')
}

/** A base64 run this long in a "data" field of a body that is not readable JSON is taken for attachment bytes. */
const BASE64_RUN = /("data"\s*:\s*")(?:data:[^,"]{0,100},)?[A-Za-z0-9+/=_\-\s\\]{64,}("?)/g

/**
 * A stored delivery without its attachment bytes, for every row that is final (processed, ignored, failed, unparsed): the
 * pictures are in the photos store or were never usable, and 90 days of webhook_log need not hold megabytes of base64 per MMS.
 * Readable JSON keeps its shape (each part's `data` becomes null with `dataRedacted: true`); anything else (a body cut short,
 * broken JSON) has its long base64 runs in "data" fields replaced. The signature no longer verifies, which no longer matters
 * once the delivery is final. A body with nothing to strip is returned as it is.
 */
export function stripAttachmentData(raw: string): string {
  let env: unknown
  try {
    env = JSON.parse(raw)
  } catch {
    return raw.replace(BASE64_RUN, '$1[redacted]$2')
  }
  const parts = (env as { payload?: { attachments?: unknown } } | null)?.payload?.attachments
  if (!Array.isArray(parts)) return raw
  let changed = false
  for (const p of parts) {
    if (p && typeof p === 'object' && typeof (p as Record<string, unknown>).data === 'string') {
      ;(p as Record<string, unknown>).data = null
      ;(p as Record<string, unknown>).dataRedacted = true
      changed = true
    }
  }
  return changed ? JSON.stringify(env) : raw
}

/** The body column update that strips attachment bytes from a final row, or nothing when there is nothing to strip. */
const stripped = (body: string | null, o: { redactText?: boolean } = {}): { body?: string } => {
  if (body === null) return {}
  const out = o.redactText
    ? redactInboundText(stripAttachmentData(body))
    : maskInboundCards(stripAttachmentData(body))
  return out === body ? {} : { body: out }
}

/**
 * A stored delivery's text with its card numbers masked to the last four digits (ADR 0160 W4b X6: "[card ending 1234]"), in the
 * payload's text fields (`message`, `body`) and the text of its MMS parts; a body that is not readable JSON is masked as a whole.
 */
export function maskInboundCards(raw: string): string {
  let env: unknown
  try {
    env = JSON.parse(raw)
  } catch {
    return maskCardNumbers(raw)
  }
  const p = (env as { payload?: Record<string, unknown> } | null)?.payload
  if (!p || typeof p !== 'object') return raw
  let changed = false
  const mask = (o: Record<string, unknown>, k: string): void => {
    const v = o[k]
    if (typeof v !== 'string') return
    const m = maskCardNumbers(v)
    if (m !== v) {
      o[k] = m
      changed = true
    }
  }
  for (const k of ['message', 'body', 'text']) mask(p, k)
  if (Array.isArray(p.attachments))
    for (const a of p.attachments) if (a && typeof a === 'object') mask(a as Record<string, unknown>, 'text')
  return changed ? JSON.stringify(env) : raw
}

/**
 * A stored delivery whose text was a code (ADR 0160: a reply number or a link-page code is never kept readable): the text fields of
 * the payload (`message`, `body`) become CODE_MASK. A body that is not readable JSON is replaced by a note: a code must not survive
 * in webhook_log. The signature no longer verifies, which no longer matters once the delivery is final.
 */
export function redactInboundText(raw: string): string {
  let env: unknown
  try {
    env = JSON.parse(raw)
  } catch {
    return JSON.stringify({ redacted: true })
  }
  const p = (env as { payload?: Record<string, unknown> } | null)?.payload
  if (!p || typeof p !== 'object') return raw
  for (const k of ['message', 'body'] as const) if (typeof p[k] === 'string') p[k] = CODE_MASK
  return JSON.stringify(env)
}

/**
 * Whether a stored delivery's text is a digits-only reply code (4-8 digits, parseReplyCode). Used for the rows that are final
 * without ever being routed (an unknown device, an envelope the sweep gives up on): nothing decided whether the digits were a
 * code, so they are masked (ADR 0160: a reply number or a link-page code is never kept readable).
 */
function holdsCode(raw: string | null): boolean {
  if (raw === null) return false
  let env: unknown
  try {
    env = JSON.parse(raw)
  } catch {
    return false
  }
  const p = (env as { payload?: Record<string, unknown> } | null)?.payload
  if (!p || typeof p !== 'object') return false
  return (['message', 'body'] as const).some((k) => typeof p[k] === 'string' && parseReplyCode(p[k]) !== null)
}

/**
 * The number a received text was sent to, for the assistant gate's own-number check. The parser's `recipient` falls back to
 * `phoneNumber`, which on sms:received is the SENDER: a delivery without `recipient` (absent, null, the older phoneNumber-only
 * payload) would hand the sender over as the number it texted, and the gate would hold every texter back as "our own number".
 * So a recipient equal to the sender counts only when the payload really says `recipient` (the device texting itself, a loop);
 * the stored body is read again only in that rare case.
 */
export function textedNumber(event: SmsEvent, recipient: string | undefined, rawBody: string): string | undefined {
  if (!recipient || event.kind !== 'received') return undefined
  const same = (a: string, b: string): boolean => (normalizeE164(a) ?? a.trim()) === (normalizeE164(b) ?? b.trim())
  if (!same(recipient, event.from)) return recipient
  let stated: unknown
  try {
    stated = (JSON.parse(rawBody) as { payload?: Record<string, unknown> } | null)?.payload?.recipient
  } catch {
    return undefined
  }
  return typeof stated === 'string' && same(stated, event.from) ? recipient : undefined
}

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
      if (err.signed) await this.keepUnparsed(device, headers, raw, err)
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

  /**
   * A signed delivery Oasis cannot use (an event it does not handle, a payload it cannot read) is kept as 'unparsed' so it can
   * be diagnosed (body cut to its first 4 KB, purged after 7 days), and logged by event name only, never its content.
   */
  private async keepUnparsed(device: DeviceRow, headers: Record<string, string | undefined>, raw: string, err: SmsWebhookError): Promise<void> {
    const event = err.event?.slice(0, 64) ?? null
    this.rt.log.warn({ device: device.device_key, event, code: err.code }, 'smsgate webhook not parsed; kept in webhook_log')
    const stored: Record<string, string> = { 'x-device-key': device.device_key }
    for (const h of STORED_HEADERS) if (headers[h]) stored[h] = headers[h]!
    if (event) stored['x-event'] = event
    const externalId = err.envelopeId ? err.envelopeId.slice(0, 200) : `unparsed:${createHash('sha256').update(raw).digest('hex').slice(0, 40)}`
    await this.rt.db
      .insertInto('webhook_log')
      .values({
        id: this.rt.newId(),
        provider: 'smsgate',
        external_id: externalId,
        headers: JSON.stringify(stored),
        // the bytes go first, so the 4 KB kept show the envelope and its fields rather than the start of a picture
        body: firstBytes(stripAttachmentData(raw), UNPARSED_BODY_BYTES),
        signature_valid: true,
        received_at: this.rt.clock.now(),
        processed_at: this.rt.clock.now(),
        status: 'unparsed',
        error: `${err.code}: ${err.message}`.replaceAll('\u0000', '').slice(0, 500),
      })
      .onConflict((oc) => oc.columns(['provider', 'external_id']).doNothing())
      .execute()
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
    // the conversations this event handed to the assistant: their turns start once the transaction committed
    let kicks: string[] = []
    const outcome = await transaction(this.rt.db, async (tx) => {
      const row = await tx.selectFrom('webhook_log').selectAll().where('id', '=', logId).where('status', '=', 'received').forUpdate().skipLocked().executeTakeFirst()
      if (!row || row.body === null) return 'skipped' as const
      const key = (row.headers as Record<string, string>)['x-device-key']
      const device = key ? await this.rt.store.getByKey(key) : null
      if (!device) {
        await tx
          .updateTable('webhook_log')
          .set({ status: 'failed', processed_at: this.rt.clock.now(), error: 'unknown device', ...stripped(row.body, { redactText: holdsCode(row.body) }) })
          .where('id', '=', logId)
          .execute()
        return 'ignored' as const
      }
      const parsed = verifyAndParse(row.headers as Record<string, string>, row.body, {
        secret: this.rt.store.secrets(device).webhookSecret,
        toleranceSec: FOREVER,
        clock: this.rt.clock,
      })
      const event = this.withDeviceId(parsed.event, device.id)
      let inbound: InboundOutcome | null = null
      const result = await this.apply(tx, device, event, parsed, row.body, (o) => void (inbound = o))
      const routed = inbound as InboundOutcome | null
      if (result.outcome === 'handled' && result.health?.appStarted) {
        appStartedFor = device
        // `device` was read before this event touched it: a restart moments after the last signal was not a reboot
        await noteAppStarted(tx, this.rt.deps, device, event.kind === 'app_started' ? event.at : this.rt.clock.now())
      }
      const ignored = result.outcome === 'duplicate' || (result.outcome === 'handled' && result.result.detail === 'ignored_unknown_message')
      await tx
        .updateTable('webhook_log')
        .set({
          status: ignored ? 'ignored' : 'processed',
          processed_at: this.rt.clock.now(),
          error: null,
          // the pictures are saved; 90 days of webhook_log need not hold megabytes of base64 per MMS; a code is never kept readable
          // (a repeat of a delivery filed as a code is masked too: the same text came in a second envelope)
          ...stripped(row.body, { redactText: routed !== null && (routed.duplicate ? routed.redacted === true : routed.decision.redacted === true) }),
        })
        .where('id', '=', logId)
        .execute()
      if (routed && !routed.duplicate) kicks = routed.assistantConversations
      return ignored ? ('ignored' as const) : ('processed' as const)
    }).catch(async (err: unknown) => {
      await sql`update webhook_log set error = ${(err as Error).message.slice(0, 500)} where id = ${logId}`.execute(this.rt.db).catch(() => undefined)
      throw err
    })
    // The app restarted (reboot, update, crash): its webhook registrations may be gone.
    if (appStartedFor) await this.rt.registerWebhooks(appStartedFor)
    // The assistant's turn starts only after the marker is committed (ADR 0160); a failed kick is left to the sweep (wave 3).
    if (kicks.length > 0) {
      try {
        await this.rt.assistant().kick.kick(kicks)
      } catch (err) {
        this.rt.log.warn({ err: (err as Error).message.slice(0, 200), conversations: kicks.length }, 'assistant kick failed; the sweep will start the turn')
      }
    }
    return outcome
  }

  private withDeviceId(e: SmsEvent, deviceId: string): SmsEvent {
    return 'deviceId' in e ? { ...e, deviceId } : e
  }

  private async apply(tx: Tx, device: DeviceRow, event: SmsEvent, parsed: ParsedWebhook, rawBody: string, onInbound: (o: InboundOutcome) => void): Promise<IngestResult> {
    const rt = this.rt
    const assistant = rt.assistant()
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
        storage: () => rt.storage(),
        assistant: { inbox: assistant.inbox, actionCodes: assistant.actionCodes, newTexters: assistant.newTexters },
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
      {
        timeZone: rt.config.tz,
        ...(rt.config.businessPhone ? { businessPhone: rt.config.businessPhone } : {}),
        assistant: {
          gate: (input) => assistant.gate.evaluate(tx, { ...input, locationId: device.location_id, now: rt.clock.now() }),
          hasPendingAction: (phone) => assistant.actionCodes.hasPending(tx, { locationId: device.location_id, phone, now: rt.clock.now() }),
        },
      },
    )
    const to = textedNumber(event, parsed.extras.recipient, rawBody)
    const ingestor = new SmsEventIngestor(new PgProcessedEvents(tx), dispatcher, rt.clock, async (e) => {
      onInbound(await inbound.handleReceived(e, to ? { to } : {}))
    })
    await rt.store.noteRemoteId(device.id, parsed.deviceId)
    const result = await ingestor.ingest(event, parsed.extras.health ? { health: parsed.extras.health } : {})
    if (event.kind === 'received' && result.outcome === 'received') await rt.store.bumpReceived(device.id)
    return result
  }

  /**
   * Applies envelopes that were persisted but never applied (a crash, a lock timeout); gives up on ones older than a day, which
   * are failed without their attachment bytes (one row at a time: an MMS body can be megabytes).
   */
  async sweep(limit = 50): Promise<{ processed: number; abandoned: number }> {
    const now = this.rt.clock.now()
    const stale = await this.rt.db
      .selectFrom('webhook_log')
      .select('id')
      .where('provider', '=', 'smsgate')
      .where('status', '=', 'received')
      .where('received_at', '<', new Date(now.getTime() - GIVE_UP_AFTER_MS))
      .execute()
    const abandoned: string[] = []
    for (const { id } of stale) {
      const row = await this.rt.db.selectFrom('webhook_log').select('body').where('id', '=', id).where('status', '=', 'received').executeTakeFirst()
      if (!row) continue
      const r = await this.rt.db
        .updateTable('webhook_log')
        .set({ status: 'failed', processed_at: now, error: 'not applied within 24 hours', ...stripped(row.body, { redactText: holdsCode(row.body) }) })
        .where('id', '=', id)
        .where('status', '=', 'received')
        .executeTakeFirst()
      if (Number(r.numUpdatedRows) > 0) abandoned.push(id)
    }
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
