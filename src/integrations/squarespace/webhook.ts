import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Clock } from '../../platform/clock.js'
import { wireNotification, type WireNotification } from './wire.js'

/**
 * Squarespace webhook verification, per https://developers.squarespace.com/commerce-apis/webhooks/verifying-notifications
 * (fetched 2026-10-06):
 *   Squarespace-Signature = hex( HMAC-SHA256( hexToBytes(secret), raw request body ) )
 * The hex secret must be decoded to bytes first. There is no timestamp in the signature, so replay protection is
 * ours: dedupe on the notification `id` and reject notifications older than the replay window.
 * Delivery is at-least-once for up to 48 hours, may arrive out of order, and may repeat.
 */
export const SIGNATURE_HEADER = 'squarespace-signature'

export function signSquarespacePayload(rawBody: string | Buffer, secretHex: string): string {
  return createHmac('sha256', hexKey(secretHex)).update(rawBody).digest('hex')
}

function hexKey(secretHex: string): Buffer {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(secretHex))
    throw new Error('Squarespace webhook secret must be a hex string')
  return Buffer.from(secretHex, 'hex')
}

export function verifySquarespaceSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined | null,
  secretHex: string,
): boolean {
  if (!signatureHeader) return false
  const expected = Buffer.from(signSquarespacePayload(rawBody, secretHex), 'utf8')
  const given = Buffer.from(signatureHeader.trim().toLowerCase(), 'utf8')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export type Headers = Record<string, string | string[] | undefined>

export function headerValue(headers: Headers, name: string): string | undefined {
  const wanted = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === wanted) return Array.isArray(v) ? v[0] : v
  }
  return undefined
}

export interface NotificationDedupe {
  /** Returns true the first time an id is claimed, false if it was already claimed (a duplicate or replay). */
  claim(notificationId: string, now: Date): Promise<boolean>
  /** Give the id back after a failed enqueue so Squarespace's retry can be accepted. */
  release(notificationId: string): Promise<void>
}

export class InMemoryNotificationDedupe implements NotificationDedupe {
  private readonly seen = new Map<string, number>()
  constructor(private readonly ttlMs = 7 * 24 * 3600_000) {}
  async claim(id: string, now: Date): Promise<boolean> {
    const t = now.getTime()
    for (const [k, at] of this.seen) if (at + this.ttlMs <= t) this.seen.delete(k)
    if (this.seen.has(id)) return false
    this.seen.set(id, t)
    return true
  }
  async release(id: string): Promise<void> {
    this.seen.delete(id)
  }
  get size(): number {
    return this.seen.size
  }
}

export const ORDER_TOPICS = ['order.create', 'order.update'] as const

export type OrderUpdateKind =
  'FULFILLED' | 'REFUNDED' | 'CANCELED' | 'MARKED_PENDING' | 'EMAIL_UPDATED' | string

export type WebhookOutcome =
  | { status: 'invalid_signature' }
  | { status: 'malformed'; reason: string }
  | { status: 'stale'; notificationId: string }
  | { status: 'duplicate'; notificationId: string }
  | { status: 'ignored'; notificationId: string; topic: string }
  | {
      status: 'accepted'
      notificationId: string
      topic: 'order.create' | 'order.update'
      orderId: string
      update?: OrderUpdateKind
      subscriptionId?: string
      createdOn: Date
    }

export interface WebhookDeps {
  clock: Clock
  dedupe: NotificationDedupe
  /** Secret(s) to try. A subscription id is passed when the body names one; rotation allows two secrets. */
  secrets: (subscriptionId: string | undefined) => readonly string[]
  /** Notifications older than this are rejected so a captured request cannot be replayed after the dedupe TTL. */
  replayWindowMs?: number
}

/**
 * Verify, parse, dedupe. The caller answers 2xx fast and enqueues `sqsp.webhook.process` (fetch the order, upsert)
 * for `accepted`; on an enqueue failure it calls `dedupe.release(notificationId)` and returns 5xx so Squarespace
 * retries. Anything else is acknowledged or rejected according to the status.
 */
export async function receiveWebhook(
  deps: WebhookDeps,
  req: { rawBody: string | Buffer; headers: Headers },
): Promise<WebhookOutcome> {
  let json: unknown
  try {
    json = JSON.parse(req.rawBody.toString('utf8'))
  } catch {
    return { status: 'malformed', reason: 'body is not JSON' }
  }
  const parsed = wireNotification.safeParse(json)
  // Verification comes first: nothing below acts on an unverified body.
  const signature = headerValue(req.headers, SIGNATURE_HEADER)
  const candidates = deps.secrets(parsed.success ? (parsed.data.subscriptionId ?? undefined) : undefined)
  if (!candidates.some((s) => verifySquarespaceSignature(req.rawBody, signature, s))) {
    return { status: 'invalid_signature' }
  }
  if (!parsed.success) return { status: 'malformed', reason: 'not a Squarespace notification' }
  const n: WireNotification = parsed.data
  const createdOn = new Date(n.createdOn)
  if (Number.isNaN(createdOn.getTime()))
    return { status: 'malformed', reason: `bad createdOn ${n.createdOn}` }
  const now = deps.clock.now()
  if (now.getTime() - createdOn.getTime() > (deps.replayWindowMs ?? 7 * 24 * 3600_000)) {
    return { status: 'stale', notificationId: n.id }
  }
  if (!(await deps.dedupe.claim(n.id, now))) return { status: 'duplicate', notificationId: n.id }
  if (n.topic !== 'order.create' && n.topic !== 'order.update') {
    return { status: 'ignored', notificationId: n.id, topic: n.topic }
  }
  const orderId = n.data?.orderId
  if (typeof orderId !== 'string' || !orderId)
    return { status: 'malformed', reason: 'order notification without orderId' }
  const update = n.data?.update
  return {
    status: 'accepted',
    notificationId: n.id,
    topic: n.topic,
    orderId,
    update: typeof update === 'string' ? update : undefined,
    subscriptionId: n.subscriptionId ?? undefined,
    createdOn,
  }
}

/** Build a signed delivery the way Squarespace does (used by the simulator and tests). */
export function buildSignedNotification(opts: {
  secretHex: string
  id: string
  websiteId: string
  subscriptionId: string
  topic: string
  createdOn: Date
  data: Record<string, unknown>
}): { rawBody: string; headers: Record<string, string> } {
  const rawBody = JSON.stringify({
    id: opts.id,
    websiteId: opts.websiteId,
    subscriptionId: opts.subscriptionId,
    topic: opts.topic,
    createdOn: opts.createdOn.toISOString(),
    data: opts.data,
  })
  return {
    rawBody,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Squarespace/1.0',
      'Squarespace-Signature': signSquarespacePayload(rawBody, opts.secretHex),
    },
  }
}
