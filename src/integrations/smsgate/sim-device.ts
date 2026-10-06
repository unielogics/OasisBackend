import type { Clock } from '../../platform/clock.js'
import { mulberry32, type Rng } from '../../platform/random.js'
import { signWebhook } from './signature.js'
import {
  SMSGATE_WEBHOOK_EVENTS,
  type SmsGateHealthBody,
  type SmsGateMessageState,
  type SmsGateProcessingState,
  type SmsGateWebhookEnvelope,
  type SmsGateWebhookRegistration,
} from './types.js'

// A deterministic model of the SMS Gate Android app's local server: message lifecycle, webhook registry, signed webhook
// envelopes, and fault injection. The HTTP simulator and the in-process SimulatorProvider are both thin shells around it.

const ALPHABET = '_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

export interface SimDelivery {
  /** Webhook registration this delivery belongs to. */
  webhookId: string
  url: string
  event: string
  envelopeId: string
  headers: { 'x-signature': string; 'x-timestamp': string; 'content-type': string }
  body: string
}

export interface SimDeviceOptions {
  clock: Clock
  deviceId?: string
  signingKey?: string
  /** 'instant' walks every accepted message to Delivered at once; 'manual' waits for control calls. */
  autoProgress?: 'instant' | 'manual'
  allowInsecureWebhookUrl?: boolean
  rng?: Rng
  /** Our own phone number, reported as `sender` on outbound events. */
  phoneNumber?: string
}

export type DeviceReply<T> = { status: number; body: T | { message: string } }

export interface SimMessage {
  id: string
  createdAt: Date
  state: SmsGateProcessingState
  phone: string
  text: string
  ttl?: number
  priority: number
  simNumber?: number
  withDeliveryReport: boolean
  error?: string
  states: Record<string, string>
  parts: number
}

function offsetIso(d: Date): string {
  return d.toISOString().replace('Z', '+00:00')
}

export class SimDevice {
  readonly deviceId: string
  signingKey: string
  autoProgress: 'instant' | 'manual'
  battery = 87
  charging = true
  healthStatus: 'pass' | 'warn' | 'fail' = 'pass'
  private readonly clock: Clock
  private readonly rng: Rng
  private readonly allowInsecure: boolean
  private readonly phoneNumber: string
  private readonly messages = new Map<string, SimMessage>()
  private readonly hooks = new Map<string, SmsGateWebhookRegistration>()
  private sink: (d: SimDelivery) => void = () => {}
  private duplicateNext = 0
  private holding = false
  private held: SimDelivery[] = []
  readonly log: SimDelivery[] = []

  constructor(opts: SimDeviceOptions) {
    this.clock = opts.clock
    this.deviceId = opts.deviceId ?? 'simDevice000000001'
    this.signingKey = opts.signingKey ?? 'sim-signing-key'
    this.autoProgress = opts.autoProgress ?? 'manual'
    this.allowInsecure = opts.allowInsecureWebhookUrl ?? false
    this.rng = opts.rng ?? mulberry32(20261006)
    this.phoneNumber = opts.phoneNumber ?? '+15555550100'
  }

  onDelivery(cb: (d: SimDelivery) => void): void {
    this.sink = cb
  }

  private nanoid(n = 21): string {
    let s = ''
    for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(this.rng() * ALPHABET.length)]
    return s
  }

  // ---- device HTTP API semantics -------------------------------------------------------------------------------

  enqueue(raw: unknown): DeviceReply<SmsGateMessageState> {
    const b = (raw ?? {}) as Record<string, unknown>
    const bad = (message: string): DeviceReply<SmsGateMessageState> => ({ status: 400, body: { message } })
    const text = (b.textMessage as { text?: unknown } | undefined)?.text
    const types = [b.textMessage, b.dataMessage, b.mmsMessage, b.message].filter((v) => v !== undefined && v !== null)
    if (types.length === 0) return bad('Must specify exactly one of: textMessage, dataMessage, mmsMessage, or message')
    if (types.length > 1) return bad('Cannot specify multiple message types simultaneously')
    const content = typeof b.message === 'string' ? b.message : typeof text === 'string' ? text : undefined
    if (content === undefined) return bad('Only text messages are supported by the simulator')
    if (content.length === 0) return bad('Text message is empty')
    const phones = b.phoneNumbers
    if (!Array.isArray(phones) || phones.length === 0 || !phones.every((p) => typeof p === 'string')) return bad('Empty phone numbers list')
    if (new Set(phones).size !== phones.length) return bad('phone numbers must be unique')
    if (phones.length > 1) return bad('The simulator accepts one recipient per message')
    if (b.ttl !== undefined && b.validUntil !== undefined) return bad('fields conflict: ttl and validUntil')
    if (typeof b.ttl === 'number' && b.ttl < 5) return bad('ttl must be at least 5 seconds')
    const sim = b.simNumber
    if (sim !== undefined && (typeof sim !== 'number' || sim < 1)) return bad('SIM number cannot be less than 1')

    const id = typeof b.id === 'string' && b.id.length > 0 ? b.id : this.nanoid()
    if (this.messages.has(id)) return { status: 409, body: { message: 'Message with the same ID already exists' } }

    const msg: SimMessage = {
      id,
      createdAt: this.clock.now(),
      state: 'Pending',
      phone: phones[0] as string,
      text: content,
      ttl: typeof b.ttl === 'number' ? b.ttl : undefined,
      priority: typeof b.priority === 'number' ? b.priority : 0,
      simNumber: typeof sim === 'number' ? sim : undefined,
      withDeliveryReport: b.withDeliveryReport !== false,
      states: { Pending: offsetIso(this.clock.now()) },
      parts: Math.max(1, Math.ceil(content.length / 153)),
    }
    this.messages.set(id, msg)
    // The real app answers 202 with the message still Pending; its later states arrive by webhook and GET.
    const accepted = this.view(msg)
    if (this.autoProgress === 'instant') {
      this.markProcessed(id)
      this.markSent(id)
      if (msg.withDeliveryReport) this.markDelivered(id)
    }
    return { status: 202, body: accepted }
  }

  private view(m: SimMessage): SmsGateMessageState {
    return {
      id: m.id,
      deviceId: this.deviceId,
      state: m.state,
      recipients: [{ phoneNumber: m.phone, state: m.state, ...(m.error ? { error: m.error } : {}) }],
      states: { ...m.states },
      isHashed: false,
      isEncrypted: false,
      createdAt: offsetIso(m.createdAt),
    }
  }

  getMessage(id: string): DeviceReply<SmsGateMessageState> {
    const m = this.messages.get(id)
    return m ? { status: 200, body: this.view(m) } : { status: 404, body: { message: 'not found' } }
  }

  cancelMessage(id: string): DeviceReply<SmsGateMessageState> {
    const m = this.messages.get(id)
    if (!m) return { status: 404, body: { message: 'not found' } }
    if (m.state !== 'Pending') return { status: 400, body: { message: 'Message must be in Pending state' } }
    this.transition(m, 'Cancelled')
    this.emit('sms:cancelled', { messageId: m.id, sender: this.phoneNumber, recipient: m.phone, simNumber: m.simNumber ?? 1, cancelledAt: offsetIso(this.clock.now()) })
    return { status: 200, body: this.view(m) }
  }

  /** Simulates the app being reinstalled: it forgets every message it ever accepted. */
  wipeMessages(): void {
    this.messages.clear()
  }

  listMessages(): SimMessage[] {
    return [...this.messages.values()]
  }

  message(id: string): SimMessage | undefined {
    return this.messages.get(id)
  }

  health(): { status: number; body: SmsGateHealthBody } {
    const level = this.healthStatus === 'fail' ? Math.min(this.battery, 8) : this.battery
    const body: SmsGateHealthBody = {
      status: this.healthStatus,
      version: '1.77.1',
      releaseId: 77100,
      checks: {
        'messages:failed': { status: 'pass', observedValue: 0, observedUnit: 'messages', description: 'Failed messages for last hour' },
        'connection:status': { status: 'pass', observedValue: 1, observedUnit: 'boolean', description: 'Internet connection status' },
        'battery:level': {
          status: level < 10 ? 'fail' : level < 25 ? 'warn' : 'pass',
          observedValue: level,
          observedUnit: 'percent',
          description: 'Battery level in percent',
        },
        'battery:charging': { status: 'pass', observedValue: this.charging ? 3 : 0, observedUnit: 'flags', description: 'Is the phone charging?' },
      },
    }
    return { status: this.healthStatus === 'fail' ? 500 : 200, body }
  }

  listWebhooks(): SmsGateWebhookRegistration[] {
    return [...this.hooks.values()]
  }

  putWebhook(raw: unknown): DeviceReply<SmsGateWebhookRegistration> {
    const b = (raw ?? {}) as Record<string, unknown>
    if (typeof b.url !== 'string' || typeof b.event !== 'string') return { status: 400, body: { message: 'url and event are required' } }
    let u: URL
    try {
      u = new URL(b.url)
    } catch {
      return { status: 400, body: { message: 'invalid url' } }
    }
    const ok = u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === '127.0.0.1') || (this.allowInsecure && u.protocol === 'http:')
    if (!ok) return { status: 400, body: { message: 'url must start with https:// or http://127.0.0.1' } }
    if (!(SMSGATE_WEBHOOK_EVENTS as readonly string[]).includes(b.event)) return { status: 400, body: { message: 'Unsupported event' } }
    const id = typeof b.id === 'string' && b.id ? b.id : this.nanoid()
    const reg: SmsGateWebhookRegistration = { id, url: b.url, event: b.event, deviceId: null }
    this.hooks.set(id, reg) // same id replaces
    return { status: 201, body: reg }
  }

  deleteWebhook(id: string): void {
    this.hooks.delete(id)
  }

  patchSettings(raw: unknown): void {
    const key = ((raw as { webhooks?: { signing_key?: unknown } } | undefined)?.webhooks ?? {}).signing_key
    if (typeof key === 'string' && key) this.signingKey = key
  }

  // ---- lifecycle controls --------------------------------------------------------------------------------------

  private transition(m: SimMessage, state: SmsGateProcessingState): void {
    m.state = state
    m.states[state] = offsetIso(this.clock.now())
  }

  markProcessed(id: string): boolean {
    const m = this.messages.get(id)
    if (!m || m.state !== 'Pending') return false
    this.transition(m, 'Processed')
    return true
  }

  markSent(id: string): boolean {
    const m = this.messages.get(id)
    if (!m || !['Pending', 'Processed'].includes(m.state)) return false
    this.transition(m, 'Sent')
    this.emit('sms:sent', { messageId: m.id, sender: this.phoneNumber, recipient: m.phone, simNumber: m.simNumber ?? 1, partsCount: m.parts, sentAt: offsetIso(this.clock.now()) })
    return true
  }

  markDelivered(id: string): boolean {
    const m = this.messages.get(id)
    if (!m || !['Pending', 'Processed', 'Sent'].includes(m.state)) return false
    if (m.state !== 'Sent') this.markSent(id)
    this.transition(m, 'Delivered')
    this.emit('sms:delivered', { messageId: m.id, sender: this.phoneNumber, recipient: m.phone, simNumber: m.simNumber ?? 1, deliveredAt: offsetIso(this.clock.now()) })
    return true
  }

  markFailed(id: string, reason = 'Generic failure'): boolean {
    const m = this.messages.get(id)
    if (!m || ['Delivered', 'Failed', 'Cancelled'].includes(m.state)) return false
    m.error = reason
    this.transition(m, 'Failed')
    this.emit('sms:failed', { messageId: m.id, sender: this.phoneNumber, recipient: m.phone, simNumber: m.simNumber ?? 1, failedAt: offsetIso(this.clock.now()), reason })
    return true
  }

  injectInbound(from: string, text: string, opts: { simNumber?: number; messageId?: string; at?: Date } = {}): string {
    const messageId = opts.messageId ?? `in_${this.nanoid(12)}`
    this.emit('sms:received', {
      messageId,
      message: text,
      sender: from,
      recipient: this.phoneNumber,
      simNumber: opts.simNumber ?? 1,
      phoneNumber: from,
      receivedAt: offsetIso(opts.at ?? this.clock.now()),
    })
    return messageId
  }

  ping(): void {
    const h = this.health().body
    this.emit('system:ping', h as unknown as Record<string, unknown>)
  }

  appStarted(): void {
    this.emit('app:started', {
      simCards: [{ slotIndex: 0, simNumber: 1, phoneNumber: this.phoneNumber, carrierName: 'SimCarrier', iccid: '8901260000000000001' }],
    })
  }

  // ---- webhook faults ------------------------------------------------------------------------------------------

  /** The next `n` deliveries are each delivered twice with the same envelope id (a device retry after a lost 2xx). */
  duplicateNextDeliveries(n: number): void {
    this.duplicateNext = n
  }

  /** While holding, deliveries are queued; flushHeld() releases them newest-first (out of order). */
  holdDeliveries(on: boolean): void {
    this.holding = on
  }

  flushHeld(order: 'reverse' | 'fifo' = 'reverse'): number {
    const batch = order === 'reverse' ? [...this.held].reverse() : [...this.held]
    this.held = []
    this.holding = false
    for (const d of batch) this.sink(d)
    return batch.length
  }

  private emit(event: string, payload: Record<string, unknown>): void {
    for (const hook of this.hooks.values()) {
      if (hook.event !== event) continue
      const envelope: SmsGateWebhookEnvelope = { deviceId: this.deviceId, event, id: this.nanoid(), webhookId: hook.id, payload }
      const body = JSON.stringify(envelope)
      const ts = String(Math.floor(this.clock.now().getTime() / 1000))
      const delivery: SimDelivery = {
        webhookId: hook.id,
        url: hook.url,
        event,
        envelopeId: envelope.id,
        headers: { 'x-signature': signWebhook(this.signingKey, body, ts), 'x-timestamp': ts, 'content-type': 'application/json' },
        body,
      }
      this.log.push(delivery)
      const copies = this.duplicateNext > 0 ? 2 : 1
      if (this.duplicateNext > 0) this.duplicateNext -= 1
      for (let i = 0; i < copies; i++) {
        if (this.holding) this.held.push(delivery)
        else this.sink(delivery)
      }
    }
  }
}
