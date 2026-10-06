import { systemClock, type Clock } from '../../platform/clock.js'
import type { SmsDeviceHealth, SmsEvent, SmsProvider, SmsSendRequest, SmsSendResult, SmsState } from '../ports/sms.js'
import { SMSGATE_WEBHOOK_EVENTS } from '../smsgate/types.js'
import { SimDevice, type SimDelivery } from '../smsgate/sim-device.js'
import { verifyAndParse, type ParsedWebhook } from '../smsgate/webhook.js'
import { SmsProviderError } from './errors.js'
import { isE164 } from './phone.js'

export type SimOutage = 'off' | 'down' | 'error5xx' | 'hang_after_accept'

export interface SimulatorProviderOptions {
  clock?: Clock
  signingKey?: string
  /** 'instant' (default) walks every accepted message to Delivered; 'manual' waits for deliver()/fail()/markSent(). */
  autoProgress?: 'instant' | 'manual'
  toleranceSec?: number
  /** Called for every signed webhook the simulated device emits (wire it to the webhook handler in dev). */
  onWebhook?: (delivery: SimDelivery) => void
}

/**
 * In-process SmsProvider backed by the same device model as the HTTP simulator. Webhooks it produces are signed exactly
 * like the real device's, so verifyAndParseWebhook exercises the production verification path.
 */
export class SimulatorProvider implements SmsProvider {
  readonly device: SimDevice
  private readonly clock: Clock
  private readonly toleranceSec: number
  private secret: string
  private outage: SimOutage = 'off'
  private outageOnce = false
  private readonly pending: SimDelivery[] = []

  constructor(opts: SimulatorProviderOptions = {}) {
    this.clock = opts.clock ?? systemClock
    this.secret = opts.signingKey ?? 'sim-signing-key'
    this.toleranceSec = opts.toleranceSec ?? 86_400
    this.device = new SimDevice({ clock: this.clock, signingKey: this.secret, autoProgress: opts.autoProgress ?? 'instant', allowInsecureWebhookUrl: true })
    this.device.onDelivery((d) => {
      this.pending.push(d)
      opts.onWebhook?.(d)
    })
  }

  // ---- SmsProvider -----------------------------------------------------------------------------------------------

  async send(req: SmsSendRequest): Promise<SmsSendResult> {
    if (!isE164(req.to)) throw new SmsProviderError('rejected', 'Recipient is not E.164')
    if (!req.body) throw new SmsProviderError('rejected', 'Empty message body')
    this.assertReachable()
    const reply = this.device.enqueue({
      id: req.id,
      textMessage: { text: req.body },
      phoneNumbers: [req.to],
      simNumber: req.simSlot,
      withDeliveryReport: true,
      ttl: req.ttlSec,
      priority: req.priority,
    })
    if (reply.status === 409) {
      const existing = await this.status(req.id)
      return { providerMessageId: req.id, state: existing?.state ?? 'Pending' }
    }
    if (reply.status >= 400) throw new SmsProviderError('rejected', (reply.body as { message: string }).message, { status: reply.status })
    const body = reply.body as { id: string; state: string }
    if (this.outage === 'hang_after_accept') {
      this.consumeOnce()
      throw new SmsProviderError('transient', 'send timed out after the device accepted the message')
    }
    return { providerMessageId: body.id, state: body.state === 'Pending' || body.state === 'Processed' || body.state === 'Sent' || body.state === 'Delivered' || body.state === 'Failed' ? (body.state as SmsState) : 'Pending' }
  }

  async status(id: string): Promise<{ state: SmsState; reason?: string } | null> {
    this.assertReachable()
    const m = this.device.message(id)
    if (!m) return null
    if (m.state === 'Cancelled') return { state: 'Failed', reason: 'cancelled' }
    if (m.state === 'Cancelling') return { state: 'Pending' }
    return m.error ? { state: m.state, reason: m.error } : { state: m.state }
  }

  async health(): Promise<SmsDeviceHealth> {
    if (this.outage === 'down' || this.outage === 'error5xx') return { ok: false, details: { reachable: false, status: 'unreachable' } }
    const h = this.device.health()
    return { ok: h.body.status !== 'fail', battery: this.device.battery, details: { reachable: true, status: h.body.status, checks: h.body.checks } }
  }

  async registerWebhooks(urlBase: string, secret: string): Promise<void> {
    this.assertReachable()
    this.secret = secret
    this.device.signingKey = secret
    for (const event of SMSGATE_WEBHOOK_EVENTS) {
      const reply = this.device.putWebhook({ id: `oasis-${event.replace(/[^a-z0-9]+/g, '-')}`, url: urlBase, event })
      if (reply.status >= 400) throw new SmsProviderError('rejected', (reply.body as { message: string }).message)
    }
  }

  parseWebhook(headers: Record<string, string | undefined>, rawBody: string): ParsedWebhook {
    return verifyAndParse(headers, rawBody, { secret: this.secret, toleranceSec: this.toleranceSec, clock: this.clock })
  }

  verifyAndParseWebhook(headers: Record<string, string | undefined>, rawBody: string): SmsEvent {
    return this.parseWebhook(headers, rawBody).event
  }

  // ---- controls ---------------------------------------------------------------------------------------------------

  setOutage(mode: SimOutage, opts: { once?: boolean } = {}): void {
    this.outage = mode
    this.outageOnce = opts.once ?? false
  }

  private consumeOnce(): void {
    if (this.outageOnce) {
      this.outage = 'off'
      this.outageOnce = false
    }
  }

  private assertReachable(): void {
    if (this.outage === 'down' || this.outage === 'error5xx') {
      const mode = this.outage
      this.consumeOnce()
      throw new SmsProviderError('transient', mode === 'down' ? 'device unreachable' : 'device error 503', { status: mode === 'down' ? undefined : 503 })
    }
  }

  injectInbound(from: string, body: string, opts?: { simNumber?: number; messageId?: string; at?: Date }): string {
    return this.device.injectInbound(from, body, opts)
  }

  markSent(id: string): boolean {
    return this.device.markSent(id)
  }

  deliver(id: string): boolean {
    return this.device.markDelivered(id)
  }

  fail(id: string, reason?: string): boolean {
    return this.device.markFailed(id, reason)
  }

  ping(): void {
    this.device.ping()
  }

  appStarted(): void {
    this.device.appStarted()
  }

  /** Signed webhooks emitted since the last call. */
  takeDeliveries(): SimDelivery[] {
    return this.pending.splice(0)
  }

  /** The app lost its database: it no longer knows any message id. */
  wipeDevice(): void {
    this.device.wipeMessages()
  }

  messageCount(): number {
    return this.device.listMessages().length
  }
}
