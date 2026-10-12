// Signed webhook delivery from the Square simulator: every event goes to every enabled webhook subscription that lists its type,
// signed like Square (x-square-hmacsha256-signature = base64 HMAC-SHA256(key, notification URL + body)). Modes reproduce what
// Square may do: `duplicate` sends each event twice, `out_of_order` holds one event and sends it after the next one.
import { randomUUID } from 'node:crypto'
import { SQUARE_SIGNATURE_HEADER, signSquareWebhook } from '../webhook.js'
import type { SimEventRecord, SquareSimStore } from './store.js'

export type DeliveryMode = 'normal' | 'duplicate' | 'out_of_order'

export interface SimDelivery {
  at: string
  eventId: string
  type: string
  url: string
  status: number | 'error'
  attempt: number
}

export class SquareSimWebhooks {
  mode: DeliveryMode = 'normal'
  /** false: events are logged (SearchEvents) but nothing is delivered. */
  enabled = true
  readonly deliveries: SimDelivery[] = []
  private held: SimEventRecord | undefined
  private inflight: Promise<void>[] = []
  private readonly fetchImpl: typeof fetch

  constructor(
    private readonly store: SquareSimStore,
    private readonly o: { fetch?: typeof fetch; keyOf: (subscriptionId: string) => string | undefined },
  ) {
    this.fetchImpl = o.fetch ?? fetch
    store.onEvent((e) => this.onEvent(e))
  }

  /** Resolves when every delivery started so far has been answered. */
  async pending(): Promise<void> {
    while (this.inflight.length) await Promise.all(this.inflight.splice(0))
  }

  /** Sends the event held back by out_of_order mode. */
  async flush(): Promise<void> {
    const h = this.held
    this.held = undefined
    if (h) this.fanOut(h)
    await this.pending()
  }

  private onEvent(e: SimEventRecord): void {
    if (!this.enabled) return
    if (this.mode === 'out_of_order') {
      const prev = this.held
      this.held = e
      if (prev) {
        // the newer event first, then the one held back
        this.held = undefined
        this.fanOut(e)
        this.fanOut(prev)
      }
      return
    }
    this.fanOut(e)
    if (this.mode === 'duplicate') this.fanOut(e, 2)
  }

  private targets(type: string): Array<{ id: string; url: string; key: string }> {
    const out: Array<{ id: string; url: string; key: string }> = []
    for (const w of this.store.webhookSubscriptions.values()) {
      const key = this.o.keyOf(String(w.id))
      if (w.enabled === false || !key || typeof w.notification_url !== 'string') continue
      if (!(w.event_types as string[] | undefined)?.includes(type)) continue
      out.push({ id: String(w.id), url: w.notification_url, key })
    }
    return out
  }

  private fanOut(e: SimEventRecord, attempt = 1): void {
    for (const t of this.targets(e.type)) this.inflight.push(this.send(t, e, attempt))
  }

  private async send(t: { url: string; key: string }, e: SimEventRecord, attempt: number): Promise<void> {
    const body = JSON.stringify(e)
    let status: number | 'error'
    try {
      const res = await this.fetchImpl(t.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Square Connect v2 (simulator)',
          'square-environment': 'Sandbox',
          'square-initial-delivery-timestamp': e.created_at,
          ...(attempt > 1 ? { 'square-retry-number': String(attempt - 1), 'square-retry-reason': 'simulated duplicate' } : {}),
          [SQUARE_SIGNATURE_HEADER]: signSquareWebhook(t.key, t.url, body),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      })
      status = res.status
      await res.arrayBuffer().catch(() => undefined)
    } catch {
      status = 'error'
    }
    this.deliveries.push({ at: this.store.now().toISOString(), eventId: e.event_id, type: e.type, url: t.url, status, attempt })
  }

  /** TestWebhookSubscription: a signed sample event of the type, delivered now; answers what the endpoint answered. */
  async testDelivery(subscriptionId: string, type: string): Promise<{ id: string; status_code: number | null; payload: string; created_at: string }> {
    const w = this.store.webhookSubscriptions.get(subscriptionId)
    const key = this.o.keyOf(subscriptionId)
    const e: SimEventRecord = {
      merchant_id: this.store.merchantId,
      location_id: this.store.locationId,
      type,
      event_id: randomUUID(),
      created_at: this.store.now().toISOString(),
      data: { type: type.split('.')[0]!, id: 'test-object', object: {} },
    }
    const body = JSON.stringify(e)
    let code: number | null = null
    if (w && key && typeof w.notification_url === 'string') {
      try {
        const res = await this.fetchImpl(w.notification_url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [SQUARE_SIGNATURE_HEADER]: signSquareWebhook(key, w.notification_url, body) },
          body,
          signal: AbortSignal.timeout(10_000),
        })
        code = res.status
      } catch {
        code = null
      }
    }
    return { id: randomUUID(), status_code: code, payload: body, created_at: e.created_at }
  }
}
