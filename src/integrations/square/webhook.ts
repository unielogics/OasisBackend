// Square webhooks (ADR 0171): signature, envelope and the event types Oasis subscribes to.
//   x-square-hmacsha256-signature = base64( HMAC-SHA256( signature key, notification URL + raw body ) )
// The URL is the one registered with Square, taken from SQUARE_WEBHOOK_URL and never from the request (a Host header is the
// caller's to choose). The current key and, during a rotation, the previous one are accepted; the comparison is constant time.
// Square delivers at least once, retries for up to 3 days, may repeat and may reorder: we dedupe on event_id (webhook_log) and
// always re-fetch the object instead of trusting the payload.
import { hmacSha256Base64, safeEqual } from '../../http/webhooks.js'
import { wireEvent, type WireEvent } from './wire.js'

export const SQUARE_SIGNATURE_HEADER = 'x-square-hmacsha256-signature'

/** The event types our subscription must carry (and the catch-up asks the Events API for). */
export const SQUARE_EVENT_TYPES = [
  'payment.created',
  'payment.updated',
  'refund.created',
  'refund.updated',
  'invoice.payment_made',
  'invoice.scheduled_charge_failed',
  'invoice.updated',
  'invoice.canceled',
  'invoice.refunded',
  'subscription.created',
  'subscription.updated',
  'card.created',
  'card.updated',
  'card.disabled',
  'card.forgotten',
  'card.automatically_updated',
  'customer.updated',
  'customer.deleted',
] as const

export function signSquareWebhook(signatureKey: string, notificationUrl: string, rawBody: string): string {
  return hmacSha256Base64(signatureKey, notificationUrl + rawBody)
}

/**
 * Which key verified the delivery ('current' or 'previous'), or null. Nothing verifies without a URL and at least one key.
 */
export function verifySquareSignature(o: {
  notificationUrl: string | undefined
  rawBody: string
  signature: string | undefined | null
  keys: { current?: string; previous?: string }
}): 'current' | 'previous' | null {
  const sig = o.signature?.trim()
  if (!o.notificationUrl || !sig) return null
  for (const which of ['current', 'previous'] as const) {
    const key = o.keys[which]
    if (key && safeEqual(signSquareWebhook(key, o.notificationUrl, o.rawBody), sig)) return which
  }
  return null
}

export type EnvelopeResult = { ok: true; event: WireEvent } | { ok: false; reason: string }

/** The delivery's envelope {merchant_id, type, event_id, created_at, data:{type,id}}; the object inside is never trusted. */
export function parseSquareEvent(raw: string | unknown): EnvelopeResult {
  let json: unknown = raw
  if (typeof raw === 'string') {
    try {
      json = JSON.parse(raw)
    } catch {
      return { ok: false, reason: 'body is not JSON' }
    }
  }
  const r = wireEvent.safeParse(json)
  if (!r.success) return { ok: false, reason: `not a Square event: ${r.error.issues[0]?.path.join('.') ?? ''} ${r.error.issues[0]?.message ?? ''}`.trim() }
  return { ok: true, event: r.data }
}

export type SquareObjectKind = 'payment' | 'refund' | 'invoice' | 'subscription' | 'card' | 'customer'

export interface ClassifiedEvent {
  /** What object the event is about, or null for a type Oasis does not handle. */
  kind: SquareObjectKind | null
  objectId: string
  /** customer.deleted and other deletions: the object is gone, there is nothing to re-fetch. */
  deleted: boolean
  type: string
}

const KIND_BY_PREFIX: Record<string, SquareObjectKind> = {
  payment: 'payment',
  refund: 'refund',
  invoice: 'invoice',
  subscription: 'subscription',
  card: 'card',
  customer: 'customer',
}

/** Pure dispatch decision for one event (the job, the catch-up and pnpm verify:square use it). */
export function classifySquareEvent(e: Pick<WireEvent, 'type' | 'data'>): ClassifiedEvent {
  const prefix = e.type.split('.')[0] ?? ''
  let kind: SquareObjectKind | null = KIND_BY_PREFIX[prefix] ?? null
  // customers: only updates and deletions concern our links; invoices: only the subscription billing events
  if (kind === 'customer' && !['customer.updated', 'customer.deleted'].includes(e.type)) kind = null
  if (kind === 'invoice' && !SQUARE_EVENT_TYPES.includes(e.type as (typeof SQUARE_EVENT_TYPES)[number])) kind = null
  if (!e.data.id) kind = null
  return {
    kind,
    objectId: e.data.id ?? '',
    deleted: e.data.deleted === true || e.type.endsWith('.deleted'),
    type: e.type,
  }
}
