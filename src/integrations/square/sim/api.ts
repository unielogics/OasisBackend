// The Square simulator's API surface (framework free): every /v2 call Oasis makes, with Square's auth answer, real idempotency
// (the same key and body answer the same result; the same key with another body is IDEMPOTENCY_KEY_REUSED), fault injection (429,
// 500, a timeout), a request log, signed webhook delivery and the /__sim controls. The HTTP server (http.ts), the in-process
// fetch (fetch.ts) and pnpm sim:square all go through handle().
import { createHash, randomBytes } from 'node:crypto'
import { SQUARE_EVENT_TYPES } from '../webhook.js'
import { SimError, SquareSimStore, type SimEventRecord } from './store.js'
import { SquareSimWebhooks, type DeliveryMode } from './webhooks.js'

type Obj = Record<string, unknown>

export interface SimRequest {
  method: string
  path: string
  query: URLSearchParams
  headers: Record<string, string | undefined>
  body?: unknown
}

export interface SimResponse {
  status: number
  headers: Record<string, string>
  body: unknown
  /** Fault injection: the transport must not answer at all (the client sees a timeout or a reset). */
  hang?: boolean
}

export interface SimFault {
  /** 429 or 5xx; omitted with `hang`. */
  status?: number
  hang?: boolean
  times: number
  /** Substring of the path; omitted = any /v2 request. */
  path?: string
  method?: string
  retryAfterSeconds?: number
}

export interface SquareSimApiOptions {
  /** Bearer tokens accepted. Default: the simulator's own (SIM_ACCESS_TOKEN). */
  tokens?: string[]
  pageSize?: number
  /** Used to deliver webhooks (default: global fetch). */
  fetch?: typeof fetch
}

export interface LoggedRequest {
  at: string
  method: string
  path: string
  status: number
  version?: string
  idempotencyKey?: string
}

/** Every event type the simulator emits or lists (ours plus what the sandbox also sends). */
export const SIM_EVENT_TYPES = [
  ...SQUARE_EVENT_TYPES,
  'customer.created',
  'invoice.created',
  'invoice.published',
  'invoice.deleted',
  'order.created',
  'order.updated',
  'order.fulfillment.updated',
  'catalog.version.updated',
]

export class SquareSimApi {
  readonly log: LoggedRequest[] = []
  readonly webhooks: SquareSimWebhooks
  private faults: SimFault[] = []
  private readonly idem = new Map<string, { fingerprint: string; status: number; body: unknown }>()
  private readonly tokens: string[]
  private readonly pageSize: number
  /** subscription id -> signature key (Square shows a key once, at creation). */
  private readonly hookKeys = new Map<string, string>()

  constructor(
    readonly store: SquareSimStore,
    o: SquareSimApiOptions = {},
  ) {
    this.tokens = o.tokens ?? ['sim-square-access-token']
    this.pageSize = o.pageSize ?? 100
    this.webhooks = new SquareSimWebhooks(store, { fetch: o.fetch, keyOf: (id) => this.hookKeys.get(id) })
  }

  injectFault(f: SimFault): void {
    this.faults.push({ ...f })
  }

  /** Registers a webhook subscription directly (scripts, tests): returns its id; the key is the one given. */
  addWebhookSubscription(o: { url: string; signatureKey: string; eventTypes?: string[] }): string {
    const id = `wbhk_${randomBytes(16).toString('hex')}`
    this.store.webhookSubscriptions.set(id, {
      id,
      name: 'Oasis (simulator)',
      enabled: true,
      event_types: o.eventTypes ?? [...SQUARE_EVENT_TYPES],
      notification_url: o.url,
      api_version: '2026-09-16',
      created_at: this.store.now().toISOString(),
      updated_at: this.store.now().toISOString(),
    })
    this.hookKeys.set(id, o.signatureKey)
    return id
  }

  async handle(req: SimRequest): Promise<SimResponse> {
    if (req.path.startsWith('/__sim/')) {
      try {
        return await this.control(req)
      } catch (e) {
        return fromError(e)
      }
    }
    const res = await this.api(req)
    this.log.push({
      at: this.store.now().toISOString(),
      method: req.method,
      path: req.path,
      status: res.status,
      version: req.headers['square-version'],
      idempotencyKey: (req.body as Obj | undefined)?.idempotency_key as string | undefined,
    })
    // deliveries run in the background (a receiver may call back into this simulator); controls and tests await them
    return res
  }

  private async api(req: SimRequest): Promise<SimResponse> {
    if (!req.path.startsWith('/v2/')) return json(404, { errors: [err('INVALID_REQUEST_ERROR', 'NOT_FOUND', 'Not found')] })
    const auth = req.headers.authorization ?? ''
    const token = /^Bearer (.+)$/.exec(auth)?.[1]
    if (!token || !this.tokens.includes(token))
      return json(401, { errors: [err('AUTHENTICATION_ERROR', 'UNAUTHORIZED', 'This request could not be authorized.')] })
    const fault = this.faults.find((f) => f.times > 0 && (!f.path || req.path.includes(f.path)) && (!f.method || f.method === req.method))
    if (fault) {
      fault.times--
      if (fault.hang) return { status: 0, headers: {}, body: null, hang: true }
      const status = fault.status ?? 500
      return {
        status,
        headers: status === 429 ? { 'retry-after': String(fault.retryAfterSeconds ?? 1) } : {},
        body: { errors: [status === 429 ? err('RATE_LIMIT_ERROR', 'RATE_LIMITED', 'Rate limited') : err('API_ERROR', 'INTERNAL_SERVER_ERROR', 'Simulated failure')] },
      }
    }
    this.store.tick()
    const body = (req.body ?? {}) as Obj
    const key = typeof body.idempotency_key === 'string' ? body.idempotency_key : undefined
    if (key) {
      const scope = `${req.method} ${req.path} ${key}`
      const fingerprint = createHash('sha256').update(JSON.stringify(body)).digest('hex')
      const prior = this.idem.get(scope)
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          return json(400, { errors: [err('INVALID_REQUEST_ERROR', 'IDEMPOTENCY_KEY_REUSED', 'The idempotency key can only be retried with the same request data.', 'idempotency_key')] })
        return json(prior.status, structuredClone(prior.body))
      }
      const res = await this.route(req, body)
      if (res.status < 500) this.idem.set(scope, { fingerprint, status: res.status, body: structuredClone(res.body) })
      return res
    }
    return this.route(req, body)
  }

  private async route(req: SimRequest, body: Obj): Promise<SimResponse> {
    const s = this.store
    const m = req.method
    const p = req.path
    const q = req.query
    let x: RegExpExecArray | null
    try {
      // locations
      if (m === 'GET' && p === '/v2/locations') return ok({ locations: [s.location()] })
      if (m === 'GET' && (x = /^\/v2\/locations\/([^/]+)$/.exec(p))) {
        if (dec(x[1]) !== s.locationId) throw new SimError(404, 'INVALID_REQUEST_ERROR', 'NOT_FOUND', 'Location not found.')
        return ok({ location: s.location() })
      }
      // payments
      if (m === 'POST' && p === '/v2/payments') return ok({ payment: s.createPayment(body) })
      if (m === 'GET' && p === '/v2/payments') return this.page('payments', s.listPayments(listQuery(q)), q)
      if (m === 'GET' && (x = /^\/v2\/payments\/([^/]+)$/.exec(p))) return ok({ payment: s.getPayment(dec(x[1])) })
      if (m === 'POST' && (x = /^\/v2\/payments\/([^/]+)\/cancel$/.exec(p))) return ok({ payment: s.cancelPayment(dec(x[1])) })
      // refunds
      if (m === 'POST' && p === '/v2/refunds') return ok({ refund: s.refundPayment(body) })
      if (m === 'GET' && p === '/v2/refunds') return this.page('refunds', s.listRefunds(listQuery(q)), q)
      if (m === 'GET' && (x = /^\/v2\/refunds\/([^/]+)$/.exec(p))) return ok({ refund: s.getRefund(dec(x[1])) })
      // payment links
      if (m === 'POST' && p === '/v2/online-checkout/payment-links') {
        const r = s.createLink(body)
        return ok({ payment_link: r.link, related_resources: { orders: [r.order] } })
      }
      if (m === 'GET' && p === '/v2/online-checkout/payment-links') return this.page('payment_links', [...s.links.values()].map((l) => structuredClone(l)), q)
      if ((x = /^\/v2\/online-checkout\/payment-links\/([^/]+)$/.exec(p))) {
        const id = dec(x[1])
        if (m === 'GET') return ok({ payment_link: s.retrieveLink(id) })
        if (m === 'PUT') return ok({ payment_link: s.updateLink(id, (body.payment_link ?? {}) as Obj) })
        if (m === 'DELETE') return ok(s.deleteLink(id))
      }
      // orders
      if (m === 'POST' && p === '/v2/orders/batch-retrieve') {
        const ids = (body.order_ids as string[] | undefined) ?? []
        return ok({ orders: ids.filter((id) => s.orders.has(id)).map((id) => s.retrieveOrder(id)) })
      }
      if ((x = /^\/v2\/orders\/([^/]+)$/.exec(p))) {
        if (m === 'GET') return ok({ order: s.retrieveOrder(dec(x[1])) })
        if (m === 'PUT') return ok({ order: s.updateOrder(dec(x[1]), body) })
      }
      // customers
      if (m === 'POST' && p === '/v2/customers') return ok({ customer: s.createCustomer(body) })
      if (m === 'POST' && p === '/v2/customers/search')
        return this.page('customers', s.searchCustomers(((body.query as Obj | undefined)?.filter ?? {}) as Obj), q, body)
      if ((x = /^\/v2\/customers\/([^/]+)$/.exec(p))) {
        const id = dec(x[1])
        if (m === 'GET') return ok({ customer: s.retrieveCustomer(id) })
        if (m === 'PUT') return ok({ customer: s.updateCustomer(id, body) })
        if (m === 'DELETE') {
          s.deleteCustomer(id)
          return ok({})
        }
      }
      // cards
      if (m === 'POST' && p === '/v2/cards') return ok({ card: s.createCard(body) })
      if (m === 'GET' && p === '/v2/cards')
        return this.page(
          'cards',
          s.listCards({
            customer_id: q.get('customer_id') ?? undefined,
            include_disabled: q.get('include_disabled') === 'true',
            reference_id: q.get('reference_id') ?? undefined,
          }),
          q,
        )
      if (m === 'GET' && (x = /^\/v2\/cards\/([^/]+)$/.exec(p))) return ok({ card: s.retrieveCard(dec(x[1])) })
      if (m === 'POST' && (x = /^\/v2\/cards\/([^/]+)\/disable$/.exec(p))) return ok({ card: s.disableCard(dec(x[1])) })
      // catalog
      if (m === 'POST' && p === '/v2/catalog/object') {
        const r = s.upsertCatalog([(body.object ?? {}) as Obj])
        return ok({ catalog_object: r.objects[0], id_mappings: r.id_mappings })
      }
      if (m === 'POST' && p === '/v2/catalog/batch-upsert') {
        const objects = ((body.batches as Obj[] | undefined) ?? []).flatMap((b) => (b.objects as Obj[] | undefined) ?? [])
        return ok(s.upsertCatalog(objects))
      }
      if (m === 'POST' && p === '/v2/catalog/search') return this.page('objects', s.searchCatalog((body.object_types as string[] | undefined) ?? []), q, body)
      if ((x = /^\/v2\/catalog\/object\/([^/]+)$/.exec(p))) {
        if (m === 'GET') return ok({ object: s.retrieveCatalog(dec(x[1])) })
        if (m === 'DELETE') return ok({ deleted_object_ids: s.deleteCatalog(dec(x[1])), deleted_at: s.now().toISOString() })
      }
      // subscriptions
      if (m === 'POST' && p === '/v2/subscriptions') return ok({ subscription: s.createSubscription(body) })
      if (m === 'POST' && p === '/v2/subscriptions/search') {
        const f = (((body.query as Obj | undefined)?.filter ?? {}) as { customer_ids?: string[]; location_ids?: string[] })
        return this.page('subscriptions', s.searchSubscriptions(f), q, body)
      }
      if (m === 'POST' && p === '/v2/subscriptions/bulk-swap-plan') return ok({ affected_subscriptions: s.bulkSwapPlan(body) })
      if ((x = /^\/v2\/subscriptions\/([^/]+)$/.exec(p))) {
        const id = dec(x[1])
        if (m === 'GET') {
          const r = s.retrieveSubscription(id)
          return ok(q.get('include') === 'actions' && r.actions.length ? { subscription: { ...r.subscription, actions: r.actions } } : { subscription: r.subscription })
        }
        if (m === 'PUT') return ok({ subscription: s.updateSubscription(id, (body.subscription ?? {}) as Obj) })
      }
      if (m === 'POST' && (x = /^\/v2\/subscriptions\/([^/]+)\/(pause|resume|cancel|swap-plan)$/.exec(p))) {
        const id = dec(x[1])
        const r =
          x[2] === 'pause'
            ? s.pauseSubscription(id, body)
            : x[2] === 'resume'
              ? s.resumeSubscription(id, body)
              : x[2] === 'cancel'
                ? s.cancelSubscription(id)
                : s.swapPlan(id, body)
        return ok(r)
      }
      if (m === 'DELETE' && (x = /^\/v2\/subscriptions\/([^/]+)\/actions\/([^/]+)$/.exec(p)))
        return ok({ subscription: s.deleteAction(dec(x[1]), dec(x[2])) })
      // invoices
      if (m === 'GET' && (x = /^\/v2\/invoices\/([^/]+)$/.exec(p))) return ok({ invoice: s.getInvoice(dec(x[1])) })
      if (m === 'POST' && p === '/v2/invoices/search')
        return this.page('invoices', s.searchInvoices((((body.query as Obj | undefined)?.filter ?? {}) as Obj) as never), q, body)
      // events
      if (m === 'POST' && p === '/v2/events') {
        const query = (body.query ?? {}) as Obj
        const f = (query.filter ?? {}) as Obj
        const created = (f.created_at ?? {}) as Obj
        const rows: SimEventRecord[] = s.searchEvents({
          event_types: f.event_types as string[] | undefined,
          location_ids: f.location_ids as string[] | undefined,
          merchant_ids: f.merchant_ids as string[] | undefined,
          start_at: created.start_at as string | undefined,
          end_at: created.end_at as string | undefined,
        })
        if ((query.sort as Obj | undefined)?.order === 'DESC') rows.reverse()
        const r = this.page('events', rows, q, body)
        const b = r.body as { events: SimEventRecord[] }
        return ok({ ...b, metadata: b.events.map((e) => ({ event_id: e.event_id, api_version: '2026-09-16' })) })
      }
      if (m === 'PUT' && (p === '/v2/events/enable' || p === '/v2/events/disable')) {
        s.eventsEnabled = p.endsWith('enable')
        return ok({})
      }
      if (m === 'GET' && (p === '/v2/events/types' || p === '/v2/webhooks/event-types'))
        return ok({ event_types: SIM_EVENT_TYPES, metadata: SIM_EVENT_TYPES.map((t) => ({ event_type: t, api_version_introduced: '2026-09-16' })) })
      // webhook subscriptions
      if (p === '/v2/webhooks/subscriptions') {
        if (m === 'GET') return this.page('subscriptions', [...s.webhookSubscriptions.values()].map((w) => structuredClone(w)), q)
        if (m === 'POST') {
          const sub = (body.subscription ?? {}) as Obj
          const types = (sub.event_types as string[] | undefined) ?? []
          const unknown = types.filter((t) => !SIM_EVENT_TYPES.includes(t))
          if (unknown.length) throw new SimError(400, 'INVALID_REQUEST_ERROR', 'INVALID_VALUE', `Unknown event types: ${unknown.join(', ')}`)
          if (typeof sub.notification_url !== 'string') throw new SimError(400, 'INVALID_REQUEST_ERROR', 'MISSING_REQUIRED_PARAMETER', 'notification_url is required.')
          const key = randomBytes(16).toString('base64url')
          const id = this.addWebhookSubscription({ url: sub.notification_url, signatureKey: key, eventTypes: types })
          const w = s.webhookSubscriptions.get(id)!
          Object.assign(w, { name: sub.name ?? w.name, api_version: sub.api_version ?? w.api_version, enabled: sub.enabled ?? true })
          return ok({ subscription: { ...structuredClone(w), signature_key: key } })
        }
      }
      if ((x = /^\/v2\/webhooks\/subscriptions\/([^/]+)(\/test|\/signature-key)?$/.exec(p))) {
        const id = dec(x[1])
        const w = s.webhookSubscriptions.get(id)
        if (!w) throw new SimError(404, 'INVALID_REQUEST_ERROR', 'NOT_FOUND', `Subscription \`${id}\` not found.`)
        if (m === 'PUT' && !x[2]) {
          const patch = (body.subscription ?? {}) as Obj
          for (const k of ['name', 'enabled', 'event_types', 'notification_url', 'api_version'])
            if (patch[k] !== undefined) w[k] = patch[k]
          w.updated_at = s.now().toISOString()
          return ok({ subscription: structuredClone(w) })
        }
        if (m === 'POST' && x[2] === '/signature-key') {
          const key = randomBytes(16).toString('base64url')
          this.hookKeys.set(id, key)
          return ok({ signature_key: key })
        }
        if (m === 'POST' && x[2] === '/test') {
          const r = await this.webhooks.testDelivery(id, String(body.event_type ?? 'payment.updated'))
          return ok({ subscription_test_result: r })
        }
      }
      return json(404, { errors: [err('INVALID_REQUEST_ERROR', 'NOT_FOUND', `The simulator has no ${m} ${p}`)] })
    } catch (e) {
      return fromError(e)
    }
  }

  private page(field: string, rows: unknown[], q: URLSearchParams, body: Obj = {}): SimResponse {
    const limit = Math.min(Number(body.limit ?? q.get('limit') ?? this.pageSize) || this.pageSize, this.pageSize)
    const cursor = (body.cursor as string | undefined) ?? q.get('cursor') ?? undefined
    const start = cursor ? Number(Buffer.from(cursor, 'base64url').toString('utf8')) || 0 : 0
    const items = rows.slice(start, start + limit)
    const next = start + limit < rows.length ? Buffer.from(String(start + limit)).toString('base64url') : undefined
    return ok({ [field]: items, ...(next ? { cursor: next } : {}) })
  }

  // ---- /__sim controls ---------------------------------------------------------------------------------------------------------

  private async control(req: SimRequest): Promise<SimResponse> {
    const s = this.store
    const b = (req.body ?? {}) as Obj
    const p = req.path
    let x: RegExpExecArray | null
    if (req.method === 'GET' && p === '/__sim/state')
      return ok({
        now: s.now().toISOString(),
        locationId: s.locationId,
        merchantId: s.merchantId,
        eventsEnabled: s.eventsEnabled,
        counts: {
          customers: s.customers.size,
          cards: s.cards.size,
          payments: s.payments.size,
          refunds: s.refunds.size,
          links: s.links.size,
          orders: s.orders.size,
          subscriptions: s.subscriptions.size,
          invoices: s.invoices.size,
          events: s.events.length,
          webhookSubscriptions: s.webhookSubscriptions.size,
        },
      })
    if (req.method === 'GET' && p === '/__sim/requests') return ok({ requests: this.log })
    if (req.method === 'GET' && p === '/__sim/deliveries') return ok({ deliveries: this.webhooks.deliveries })
    if (req.method !== 'POST') return json(404, { error: 'unknown control' })
    if (p === '/__sim/clock') {
      s.advance(Number(b.advanceMs ?? 0))
      await this.webhooks.pending()
      return ok({ now: s.now().toISOString() })
    }
    if (p === '/__sim/faults') {
      this.injectFault({ status: num(b.status), hang: b.hang === true, times: num(b.times) ?? 1, path: str(b.path), method: str(b.method), retryAfterSeconds: num(b.retryAfterSeconds) })
      return ok({ faults: this.faults.filter((f) => f.times > 0).length })
    }
    if (p === '/__sim/webhooks') {
      if (typeof b.url === 'string' && typeof b.signatureKey === 'string')
        return ok({ id: this.addWebhookSubscription({ url: b.url, signatureKey: b.signatureKey, eventTypes: b.eventTypes as string[] | undefined }) })
      if (b.mode) this.webhooks.mode = b.mode as DeliveryMode
      if (b.deliver !== undefined) this.webhooks.enabled = b.deliver === true
      return ok({ mode: this.webhooks.mode, deliver: this.webhooks.enabled })
    }
    if (p === '/__sim/webhooks/flush') {
      await this.webhooks.flush()
      return ok({ delivered: this.webhooks.deliveries.length })
    }
    let result: unknown
    if ((x = /^\/__sim\/links\/([^/]+)\/pay$/.exec(p))) result = { payment: s.payLink(dec(x[1]), { tipCents: num(b.tipCents), nonce: str(b.nonce) }) }
    else if (p === '/__sim/pos/payment')
      result = {
        payment: s.posPayment({
          amountCents: num(b.amountCents) ?? 0,
          tipCents: num(b.tipCents),
          note: str(b.note),
          sourceType: b.sourceType === 'CASH' ? 'CASH' : 'CARD',
          customerId: str(b.customerId),
        }),
      }
    else if (p === '/__sim/pos/refund')
      result = { refund: s.refundPayment({ payment_id: b.paymentId, amount_money: { amount: num(b.amountCents) ?? 0, currency: 'USD' }, reason: 'Refunded in the Square app' }) }
    else if ((x = /^\/__sim\/subscriptions\/([^/]+)\/bill$/.exec(p))) result = { invoice: s.billNow(dec(x[1]), b.outcome === 'failed' ? 'failed' : 'paid') }
    else if ((x = /^\/__sim\/cards\/([^/]+)\/auto-update$/.exec(p))) result = { card: s.autoUpdateCard(dec(x[1]), { last4: str(b.last4), expYear: num(b.expYear) }) }
    else if ((x = /^\/__sim\/cards\/([^/]+)\/forget$/.exec(p))) result = { card: s.disableCard(dec(x[1]), 'forgotten') }
    else if ((x = /^\/__sim\/refunds\/([^/]+)\/fail$/.exec(p))) result = { refund: s.failRefund(dec(x[1]), b.status === 'REJECTED' ? 'REJECTED' : 'FAILED') }
    else if (p === '/__sim/reset') {
      this.faults = []
      this.idem.clear()
      this.log.length = 0
      return ok({ reset: true, note: 'requests, faults and idempotency forgotten; objects are kept (restart the simulator for an empty merchant)' })
    } else return json(404, { error: `unknown control ${p}` })
    await this.webhooks.pending()
    return ok(result)
  }
}

function ok(body: unknown): SimResponse {
  return json(200, body)
}

function json(status: number, body: unknown): SimResponse {
  return { status, headers: {}, body }
}

function err(category: string, code: string, detail: string, field?: string): Obj {
  return { category, code, detail, ...(field ? { field } : {}) }
}

function fromError(e: unknown): SimResponse {
  if (e instanceof SimError) return json(e.status, { errors: [err(e.category, e.code, e.detail)], ...e.extra })
  return json(500, { errors: [err('API_ERROR', 'INTERNAL_SERVER_ERROR', e instanceof Error ? e.message : String(e))] })
}

function dec(s: string | undefined): string {
  return decodeURIComponent(s ?? '')
}

function num(v: unknown): number | undefined {
  return v === undefined || v === null || v === '' ? undefined : Number(v)
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function listQuery(q: URLSearchParams) {
  return {
    begin_time: q.get('begin_time') ?? undefined,
    end_time: q.get('end_time') ?? undefined,
    sort_order: q.get('sort_order') ?? undefined,
    location_id: q.get('location_id') ?? undefined,
  }
}

