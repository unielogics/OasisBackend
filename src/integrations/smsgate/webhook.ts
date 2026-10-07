import { z } from 'zod'
import type { Clock } from '../../platform/clock.js'
import type { SmsEvent } from '../ports/sms.js'
import { SmsWebhookError } from '../sms/errors.js'
import { normalizeE164 } from '../sms/phone.js'
import { verifySignature } from './signature.js'
import type { SmsGateHealthBody, SmsGateWebhookEnvelope } from './types.js'

export interface WebhookVerifyOptions {
  secret: string
  /** Accepted |now - X-Timestamp| in seconds. Default 24 h because the device retries a failed delivery for about two days. */
  toleranceSec: number
  clock: Clock
}

/** Extra facts the port's SmsEvent does not carry; the dispatcher uses them for health and multipart accounting. */
export interface WebhookExtras {
  recipient?: string
  simNumber?: number
  partsCount?: number
  health?: { status: 'pass' | 'warn' | 'fail'; battery?: number; charging?: boolean /* on external power or charging */; checks?: SmsGateHealthBody['checks'] }
  simCards?: Array<{ slotIndex?: number; simNumber?: number; phoneNumber?: string; carrierName?: string }>
}

export interface ParsedWebhook {
  /** Envelope id: the dedupe key. Stable across the device's retries of one delivery. */
  envelopeId: string
  webhookId?: string
  deviceId: string
  eventName: string
  event: SmsEvent
  /** The signing time from X-Timestamp. */
  signedAt: Date
  extras: WebhookExtras
}

const envelopeSchema = z.object({
  deviceId: z.string().min(1),
  event: z.string().min(1),
  id: z.string().min(1),
  webhookId: z.string().optional(),
  payload: z.record(z.unknown()),
})

function header(headers: Record<string, string | undefined>, name: string): string | undefined {
  const wanted = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === wanted && v !== undefined) return v
  return undefined
}

// Postgres text cannot hold U+0000: one such character in a sender's text would fail the event transaction on every retry
// (and a STOP carrying one would never be recorded), so it is dropped where the payload is read.
const noNul = (v: string): string => v.replaceAll('\u0000', '')

function str(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key]
  const clean = typeof v === 'string' ? noNul(v) : ''
  return clean.length > 0 ? clean : undefined
}

function num(payload: Record<string, unknown>, key: string): number | undefined {
  const v = payload[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function when(payload: Record<string, unknown>, key: string, fallback: Date): Date {
  const raw = str(payload, key)
  if (!raw) return fallback
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? fallback : d
}

/**
 * Verifies the signature and timestamp, then parses one webhook delivery. Throws SmsWebhookError (code says why).
 * The caller must pass the raw request body exactly as received; a re-serialised body will not verify.
 */
export function verifyAndParse(
  headers: Record<string, string | undefined>,
  rawBody: string,
  opts: WebhookVerifyOptions,
): ParsedWebhook {
  const signature = header(headers, 'x-signature')
  const timestamp = header(headers, 'x-timestamp')
  if (!signature) throw new SmsWebhookError('missing_header', 'X-Signature header is missing')
  if (!timestamp) throw new SmsWebhookError('missing_header', 'X-Timestamp header is missing')
  if (!/^\d{9,12}$/.test(timestamp.trim())) throw new SmsWebhookError('bad_timestamp', 'X-Timestamp is not a Unix time in seconds')

  const ts = timestamp.trim()
  // Signature first, so an unauthenticated caller learns nothing about the tolerance window.
  if (!verifySignature(opts.secret, rawBody, ts, signature)) throw new SmsWebhookError('bad_signature', 'Signature mismatch')

  const signedAt = new Date(Number(ts) * 1000)
  const skewSec = Math.abs(opts.clock.now().getTime() - signedAt.getTime()) / 1000
  if (skewSec > opts.toleranceSec) throw new SmsWebhookError('stale_timestamp', `Timestamp is ${Math.round(skewSec)}s from now`)

  let envelope: SmsGateWebhookEnvelope
  try {
    envelope = envelopeSchema.parse(JSON.parse(rawBody))
  } catch (err) {
    throw new SmsWebhookError('bad_body', `Body is not a webhook envelope: ${(err as Error).message.slice(0, 160)}`)
  }

  const p = envelope.payload
  const base = { eventId: envelope.id }
  const extras: WebhookExtras = {}
  const recipient = str(p, 'recipient') ?? str(p, 'phoneNumber')
  if (recipient) extras.recipient = recipient
  const simNumber = num(p, 'simNumber')
  if (simNumber !== undefined) extras.simNumber = simNumber

  let event: SmsEvent
  switch (envelope.event) {
    case 'sms:received': {
      const messageId = str(p, 'messageId')
      const sender = str(p, 'sender') ?? str(p, 'phoneNumber')
      const message = typeof p.message === 'string' ? noNul(p.message) : undefined
      if (!messageId || !sender || message === undefined) throw new SmsWebhookError('bad_body', 'sms:received payload is incomplete')
      event = {
        kind: 'received',
        ...base,
        from: normalizeE164(sender) ?? sender.trim(),
        body: message,
        at: when(p, 'receivedAt', signedAt),
        deviceId: envelope.deviceId,
        providerMessageId: messageId,
      }
      break
    }
    case 'sms:sent':
    case 'sms:delivered':
    case 'sms:failed':
    case 'sms:cancelled': {
      const messageId = str(p, 'messageId')
      if (!messageId) throw new SmsWebhookError('bad_body', `${envelope.event} payload has no messageId`)
      const kind = envelope.event.slice(4) as 'sent' | 'delivered' | 'failed' | 'cancelled'
      const atKey = { sent: 'sentAt', delivered: 'deliveredAt', failed: 'failedAt', cancelled: 'cancelledAt' }[kind]
      event = { kind, ...base, providerMessageId: messageId, at: when(p, atKey, signedAt) }
      if (kind === 'failed') event.reason = str(p, 'reason') ?? 'unknown'
      const parts = num(p, 'partsCount')
      if (parts !== undefined) extras.partsCount = parts
      break
    }
    case 'system:ping': {
      event = { kind: 'ping', ...base, deviceId: envelope.deviceId, at: signedAt }
      // The ping payload is the device's health document (status, version, checks).
      const status = p.status
      if (status === 'pass' || status === 'warn' || status === 'fail') {
        const checks = (p.checks ?? undefined) as SmsGateHealthBody['checks']
        const level = checks?.['battery:level']?.observedValue
        const charging = checks?.['battery:charging']?.observedValue
        extras.health = {
          status,
          ...(typeof level === 'number' ? { battery: level } : {}),
          ...(typeof charging === 'number' ? { charging: charging > 0 } : {}),
          ...(checks ? { checks } : {}),
        }
      }
      break
    }
    case 'app:started': {
      event = { kind: 'app_started', ...base, deviceId: envelope.deviceId, at: signedAt }
      if (Array.isArray(p.simCards)) extras.simCards = p.simCards as WebhookExtras['simCards']
      break
    }
    default:
      throw new SmsWebhookError('unsupported_event', `Event ${envelope.event} is not handled`)
  }

  return {
    envelopeId: envelope.id,
    webhookId: envelope.webhookId,
    deviceId: envelope.deviceId,
    eventName: envelope.event,
    event,
    signedAt,
    extras,
  }
}
