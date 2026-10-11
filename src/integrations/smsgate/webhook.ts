import { z } from 'zod'
import type { Clock } from '../../platform/clock.js'
import { MMS_INCOMPLETE_SUFFIX, type MmsPart, type SmsEvent } from '../ports/sms.js'
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

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const BASE64URL = /^[A-Za-z0-9_-]*={0,2}$/

/** Strict base64 (standard or URL alphabet, optional data: prefix, whitespace ignored); null when it is not base64. */
export function decodeBase64(raw: string): Buffer | null {
  let text = raw.replace(/\s+/g, '')
  const comma = text.startsWith('data:') ? text.indexOf(',') : -1
  if (comma >= 0) text = text.slice(comma + 1)
  if (text.length === 0 || text.length % 4 === 1) return null
  if (BASE64.test(text)) return Buffer.from(text, 'base64')
  if (BASE64URL.test(text)) return Buffer.from(text, 'base64url')
  return null
}

const mediaType = (v: string | undefined): string => (v ? (v.split(';')[0] ?? '').trim().toLowerCase() : '') || 'application/octet-stream'

/** The text read from an MMS's text parts (each, and all of them together) is cut to this many bytes / characters. */
export const MMS_TEXT_MAX_BYTES = 16 * 1024

/** text/* types that are documents, not the text of the message, whatever their charset. */
const NOT_MESSAGE_TEXT = new Set(['text/vcard', 'text/x-vcard', 'text/directory', 'text/calendar', 'text/x-vcalendar', 'text/vcalendar'])

function charsetOf(rawType: string | undefined): string | null {
  const m = rawType ? /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(rawType) : null
  return m ? m[1]!.toLowerCase() : null
}

/**
 * The text of a text part: text/plain always, any other text/* only when it declares a charset (contact cards and calendars
 * never). Decoded with the declared charset (UTF-8 when none, or when the label is unknown), NUL dropped, trimmed, and only
 * its first MMS_TEXT_MAX_BYTES bytes are read.
 */
function partText(rawType: string | undefined, type: string, bytes: Buffer): string | undefined {
  const charset = charsetOf(rawType)
  if (type !== 'text/plain' && !(type.startsWith('text/') && charset !== null && !NOT_MESSAGE_TEXT.has(type))) return undefined
  let decoder: InstanceType<typeof TextDecoder>
  try {
    decoder = new TextDecoder(charset ?? 'utf-8')
  } catch {
    decoder = new TextDecoder('utf-8')
  }
  return noNul(decoder.decode(bytes.subarray(0, MMS_TEXT_MAX_BYTES))).trim()
}

/** The attachments of mms:downloaded. Each part is kept even when its data is missing or broken (recorded as unavailable). */
function mmsParts(raw: unknown): MmsPart[] {
  if (!Array.isArray(raw)) return []
  const out: MmsPart[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const a = item as Record<string, unknown>
    const partId = str(a, 'partId') ?? (typeof a.partId === 'number' ? String(a.partId) : null)
    const declared = num(a, 'size')
    const size = declared !== undefined && Number.isSafeInteger(declared) && declared >= 0 ? declared : null
    const rawType = str(a, 'contentType') ?? str(a, 'mimeType')
    const part: MmsPart = { partId, contentType: mediaType(rawType).slice(0, 255), name: str(a, 'name')?.slice(0, 255) ?? null, size, data: null }
    const data = str(a, 'data')
    if (data === undefined) part.problem = 'missing'
    else {
      const bytes = decodeBase64(data)
      if (bytes === null || bytes.length === 0) part.problem = 'decode_failed'
      else {
        part.data = bytes
        part.size = bytes.length
        const text = partText(rawType, part.contentType, bytes)
        if (text !== undefined) part.text = text
      }
    }
    out.push(part)
  }
  return out
}

/**
 * The provider id of an MMS: the device's messageId under an `mms:` prefix. Android numbers MMS on their own (the tablet logged
 * "id=4"), so a bare id could equal an SMS's and be taken for a repeat of it in the inbox and the reply keys.
 */
export const MMS_ID_PREFIX = 'mms:'

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
  const ctx = { event: envelope.event, envelopeId: envelope.id }
  const fail = (code: 'bad_body' | 'unsupported_event', message: string): never => {
    throw new SmsWebhookError(code, message, ctx)
  }
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
      if (!messageId || !sender || message === undefined) return fail('bad_body', 'sms:received payload is incomplete')
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
    case 'mms:downloaded': {
      // The MMS is on the device in full. Field names per docs.sms-gate.app/features/mms; samples disagree on
      // sender vs phoneNumber, so both are read. A sender the device could not tell ("unknown", absent) is kept as reported:
      // the router quarantines it, and the message is still recorded and announced.
      const messageId = str(p, 'messageId')
      if (!messageId) return fail('bad_body', 'mms:downloaded payload has no messageId')
      const sender = str(p, 'sender') ?? str(p, 'phoneNumber')
      const subject = str(p, 'subject')?.trim() || null
      const parts = mmsParts(p.attachments)
      const own = (typeof p.body === 'string' ? noNul(p.body) : typeof p.message === 'string' ? noNul(p.message) : '').trim()
      // Many phones put the words of an MMS in a text/plain part and leave the body empty: a STOP must be read from there too.
      const fromParts = parts
        .map((x) => x.text ?? '')
        .filter((t) => t.length > 0)
        .join('\n')
        .slice(0, MMS_TEXT_MAX_BYTES)
        .trim()
      const text = own || fromParts || subject || ''
      // Nothing Oasis can act on (no sender, or neither text nor a part with bytes): filed under its own id, so the complete
      // delivery of the same message that may follow is routed rather than dropped as a repeat (ADR 0151).
      const incomplete = !sender || (!text && !parts.some((x) => x.data !== null))
      event = {
        kind: 'received',
        ...base,
        from: sender ? (normalizeE164(sender) ?? sender.trim()) : 'unknown',
        body: text,
        at: when(p, 'receivedAt', signedAt),
        deviceId: envelope.deviceId,
        providerMessageId: `${MMS_ID_PREFIX}${messageId}${incomplete ? MMS_INCOMPLETE_SUFFIX : ''}`,
        mms: { subject, parts, incomplete },
      }
      break
    }
    case 'mms:received': {
      // The WAP push only: metadata, no text yet. mms:downloaded follows when the device has fetched the content.
      const messageId = str(p, 'messageId')
      if (!messageId) return fail('bad_body', 'mms:received payload has no messageId')
      const sender = str(p, 'sender') ?? str(p, 'phoneNumber')
      event = {
        kind: 'mms_notified',
        ...base,
        deviceId: envelope.deviceId,
        providerMessageId: `${MMS_ID_PREFIX}${messageId}`,
        from: sender ? (normalizeE164(sender) ?? sender.trim()) : null,
        at: when(p, 'receivedAt', signedAt),
      }
      break
    }
    case 'sms:sent':
    case 'sms:delivered':
    case 'sms:failed':
    case 'sms:cancelled': {
      const messageId = str(p, 'messageId')
      if (!messageId) return fail('bad_body', `${envelope.event} payload has no messageId`)
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
      return fail('unsupported_event', `Event ${envelope.event} is not handled`)
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
