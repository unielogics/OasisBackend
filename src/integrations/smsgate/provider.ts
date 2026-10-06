import { systemClock, type Clock } from '../../platform/clock.js'
import type {
  SmsDeviceHealth,
  SmsEvent,
  SmsProvider,
  SmsSendRequest,
  SmsSendResult,
  SmsState,
} from '../ports/sms.js'
import { SmsProviderError } from '../sms/errors.js'
import { isE164 } from '../sms/phone.js'
import type { SmsGateConfig } from './config.js'
import {
  SMSGATE_WEBHOOK_EVENTS,
  type SmsGateHealthBody,
  type SmsGateHealthDetails,
  type SmsGateMessageState,
  type SmsGateProcessingState,
  type SmsGateSendBody,
  type SmsGateWebhookRegistration,
} from './types.js'
import { verifyAndParse, type ParsedWebhook } from './webhook.js'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface SmsGateProviderDeps {
  fetch?: FetchLike
  clock?: Clock
  sleep?: (ms: number) => Promise<void>
}

interface HttpResult {
  status: number
  json: unknown
  text: string
}

export interface WebhookSyncReport {
  created: string[]
  replaced: string[]
  unchanged: string[]
  removed: string[]
}

const MAX_ID_LENGTH = 36 // the device's documented message id limit

function mapState(state: SmsGateProcessingState): { state: SmsState; reason?: string } {
  switch (state) {
    case 'Pending':
    case 'Cancelling':
      return { state: 'Pending' }
    case 'Processed':
    case 'Sent':
    case 'Delivered':
    case 'Failed':
      return { state }
    case 'Cancelled':
      // The port has no cancelled state; to the dispatcher a cancelled message is one that will never be sent.
      return { state: 'Failed', reason: 'cancelled' }
    default:
      return { state: 'Pending' }
  }
}

function recipientError(body: SmsGateMessageState): string | undefined {
  return body.recipients?.find((r) => r.error)?.error
}

export class SmsGateProvider implements SmsProvider {
  private readonly cfg: SmsGateConfig
  private readonly fetchImpl: FetchLike
  private readonly clock: Clock
  private readonly sleep: (ms: number) => Promise<void>
  private webhookSecret: string

  constructor(config: SmsGateConfig, deps: SmsGateProviderDeps = {}) {
    this.cfg = config
    this.webhookSecret = config.webhookSecret
    this.fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init))
    this.clock = deps.clock ?? systemClock
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString('base64')}`
  }

  private async http(method: string, path: string, body?: unknown): Promise<HttpResult> {
    const url = `${this.cfg.baseUrl}${path}`
    let res: Response
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: this.authHeader(),
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      })
    } catch (err) {
      const name = (err as Error).name
      const timedOut = name === 'TimeoutError' || name === 'AbortError'
      throw new SmsProviderError('transient', timedOut ? `${method} ${path} timed out after ${this.cfg.timeoutMs} ms` : `${method} ${path} failed: ${(err as Error).message}`, {
        cause: err,
      })
    }
    let text = ''
    try {
      text = await res.text()
    } catch (err) {
      throw new SmsProviderError('transient', `${method} ${path}: response body was cut off`, { status: res.status, cause: err })
    }
    let json: unknown = undefined
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        json = undefined
      }
    }
    return { status: res.status, json, text }
  }

  private static errorMessage(res: HttpResult): string {
    const m = (res.json as { message?: unknown } | undefined)?.message
    return typeof m === 'string' ? m : res.text.slice(0, 200)
  }

  private failFor(res: HttpResult, what: string): never {
    const detail = SmsGateProvider.errorMessage(res)
    if (res.status === 401 || res.status === 403) throw new SmsProviderError('auth', `${what}: credentials rejected (${res.status})`, { status: res.status })
    if (res.status >= 500) throw new SmsProviderError('transient', `${what}: device error ${res.status} ${detail}`, { status: res.status })
    throw new SmsProviderError('rejected', `${what}: ${res.status} ${detail}`, { status: res.status })
  }

  private sendBody(req: SmsSendRequest): SmsGateSendBody {
    const body: SmsGateSendBody = {
      id: req.id,
      phoneNumbers: [req.to],
      withDeliveryReport: true,
    }
    if (this.cfg.legacyMessageField) body.message = req.body
    else body.textMessage = { text: req.body }
    const sim = req.simSlot ?? this.cfg.defaultSimNumber
    if (sim !== undefined) body.simNumber = sim
    if (req.ttlSec !== undefined) body.ttl = Math.max(5, Math.ceil(req.ttlSec))
    if (req.priority !== undefined) body.priority = this.cfg.priorityMap[req.priority]
    return body
  }

  private accepted(res: HttpResult, id: string): SmsSendResult {
    const body = res.json as SmsGateMessageState | undefined
    if (!body || typeof body.state !== 'string') {
      // The device answered 2xx without a state document; the message is queued, treat it as Pending.
      return { providerMessageId: id, state: 'Pending' }
    }
    return { providerMessageId: body.id || id, state: mapState(body.state).state }
  }

  async send(req: SmsSendRequest): Promise<SmsSendResult> {
    if (!isE164(req.to)) throw new SmsProviderError('rejected', 'Recipient is not E.164')
    if (!req.body) throw new SmsProviderError('rejected', 'Empty message body')
    if (req.id.length === 0 || req.id.length > MAX_ID_LENGTH) throw new SmsProviderError('rejected', `Message id must be 1-${MAX_ID_LENGTH} characters`)

    const body = this.sendBody(req)
    const attempts = 1 + this.cfg.resendAttempts
    let lastError: SmsProviderError | undefined

    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await this.sleep(this.cfg.resendDelayMs)
      let res: HttpResult | undefined
      try {
        res = await this.http('POST', this.cfg.messagesPath, body)
      } catch (err) {
        if (!(err instanceof SmsProviderError) || err.kind !== 'transient') throw err
        lastError = err
      }

      if (res) {
        if (res.status >= 200 && res.status < 300) return this.accepted(res, req.id)
        if (res.status === 409) {
          // The device already holds this id: an earlier attempt landed. Never post again.
          const existing = await this.status(req.id)
          if (existing) return { providerMessageId: req.id, state: existing.state }
          throw new SmsProviderError('protocol', 'Device answered 409 for an id it cannot find', { status: 409 })
        }
        if (res.status < 500) this.failFor(res, 'send')
        lastError = new SmsProviderError('transient', `send: device error ${res.status} ${SmsGateProvider.errorMessage(res)}`, { status: res.status })
      }

      // Ambiguous outcome (timeout, connection loss, 5xx): the device may have accepted the message. Ask before any re-send.
      const known = await this.status(req.id).catch((err: unknown) => {
        throw new SmsProviderError('transient', `send outcome unknown (${lastError?.message}); status check failed: ${(err as Error).message}`, { cause: err })
      })
      if (known) return { providerMessageId: req.id, state: known.state }
      // The device has never seen the id, so a re-send cannot duplicate.
    }
    throw lastError ?? new SmsProviderError('transient', 'send failed')
  }

  async status(id: string): Promise<{ state: SmsState; reason?: string } | null> {
    const res = await this.http('GET', `${this.cfg.messagesPath}/${encodeURIComponent(id)}`)
    if (res.status === 404) return null
    if (res.status < 200 || res.status >= 300) this.failFor(res, 'status')
    const body = res.json as SmsGateMessageState | undefined
    if (!body || typeof body.state !== 'string') throw new SmsProviderError('protocol', 'status: response has no state', { status: res.status })
    const mapped = mapState(body.state)
    const reason = mapped.reason ?? recipientError(body)
    return reason ? { state: mapped.state, reason } : { state: mapped.state }
  }

  async health(): Promise<SmsDeviceHealth> {
    let res: HttpResult
    try {
      res = await this.http('GET', this.cfg.healthPath)
    } catch (err) {
      const details: SmsGateHealthDetails = { reachable: false, status: 'unreachable', error: (err as Error).message }
      return { ok: false, details }
    }
    const body = res.json as SmsGateHealthBody | undefined
    if (!body || (body.status !== 'pass' && body.status !== 'warn' && body.status !== 'fail')) {
      const details: SmsGateHealthDetails = { reachable: true, status: 'unreachable', httpStatus: res.status, error: 'unrecognised health response' }
      return { ok: false, details }
    }
    const level = body.checks?.['battery:level']?.observedValue
    const plug = body.checks?.['battery:charging']?.observedValue
    const details: SmsGateHealthDetails = {
      reachable: true,
      status: body.status,
      httpStatus: res.status,
      version: body.version,
      checks: body.checks,
      ...(typeof plug === 'number' ? { charging: plug > 0 } : {}),
    }
    return { ok: body.status !== 'fail', ...(typeof level === 'number' ? { battery: level } : {}), details }
  }

  private assertWebhookUrl(url: string): void {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      throw new SmsProviderError('rejected', 'Webhook URL is not a valid URL')
    }
    const https = u.protocol === 'https:'
    const loopback = u.protocol === 'http:' && u.hostname === '127.0.0.1'
    if (!https && !loopback && !this.cfg.allowInsecureWebhookUrl) {
      throw new SmsProviderError('rejected', 'The device only accepts https:// webhook URLs (or http://127.0.0.1)')
    }
  }

  webhookId(event: string): string {
    return `${this.cfg.webhookIdPrefix}${event.replace(/[^a-z0-9]+/gi, '-')}`
  }

  /** Idempotent: converges the device to one webhook per event with fixed ids and removes stale oasis- registrations. */
  async syncWebhooks(url: string, secret: string): Promise<WebhookSyncReport> {
    this.assertWebhookUrl(url)
    if (!secret) throw new SmsProviderError('rejected', 'A webhook signing secret is required')

    if (this.cfg.syncSigningKey) {
      const res = await this.http('PATCH', this.cfg.settingsPath, { webhooks: { signing_key: secret } })
      if (res.status < 200 || res.status >= 300) this.failFor(res, 'settings')
    }
    this.webhookSecret = secret

    const listed = await this.http('GET', this.cfg.webhooksPath)
    if (listed.status < 200 || listed.status >= 300) this.failFor(listed, 'list webhooks')
    const existing = Array.isArray(listed.json) ? (listed.json as SmsGateWebhookRegistration[]) : []
    const byId = new Map(existing.map((w) => [w.id, w]))

    const report: WebhookSyncReport = { created: [], replaced: [], unchanged: [], removed: [] }
    const wanted = new Set<string>()
    for (const event of SMSGATE_WEBHOOK_EVENTS) {
      const id = this.webhookId(event)
      wanted.add(id)
      const current = byId.get(id)
      if (current && current.url === url && current.event === event) {
        report.unchanged.push(id)
        continue
      }
      const res = await this.http('POST', this.cfg.webhooksPath, { id, url, event })
      if (res.status < 200 || res.status >= 300) this.failFor(res, `register ${event}`)
      ;(current ? report.replaced : report.created).push(id)
    }
    for (const w of existing) {
      if (w.id.startsWith(this.cfg.webhookIdPrefix) && !wanted.has(w.id)) {
        const res = await this.http('DELETE', `${this.cfg.webhooksPath}/${encodeURIComponent(w.id)}`)
        if (res.status < 200 || res.status >= 300) this.failFor(res, `remove webhook ${w.id}`)
        report.removed.push(w.id)
      }
    }
    return report
  }

  async registerWebhooks(urlBase: string, secret: string): Promise<void> {
    await this.syncWebhooks(urlBase, secret)
  }

  /** Full parse including the extras the port event cannot carry. Throws SmsWebhookError. */
  parseWebhook(headers: Record<string, string | undefined>, rawBody: string): ParsedWebhook {
    return verifyAndParse(headers, rawBody, { secret: this.webhookSecret, toleranceSec: this.cfg.webhookToleranceSec, clock: this.clock })
  }

  verifyAndParseWebhook(headers: Record<string, string | undefined>, rawBody: string): SmsEvent {
    return this.parseWebhook(headers, rawBody).event
  }
}
