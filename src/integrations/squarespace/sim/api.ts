import type { Clock } from '../../../platform/clock.js'
import { buildSignedNotification } from '../webhook.js'
import {
  SimBadRequest,
  SimNotFound,
  SquarespaceSimStore,
  type SimEvent,
  type SimOrderInput,
  type SimRefundInput,
} from './store.js'

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
}

export interface SimRateLimit {
  maxPerWindow: number
  windowMs: number
  cooldownMs: number
}

export interface SimFailure {
  status: number
  times: number
  /** Substring of the request path; omitted = any /1.0 or /v1 request. */
  path?: string
  retryAfterSeconds?: number
  body?: unknown
}

export interface SimWebhookConfig {
  url: string
  /** Hex secret; the real service returns it once when a subscription is created. */
  secret: string
  subscriptionId: string
  websiteId: string
  autoDeliver: boolean
}

export interface SimApiOptions {
  apiKeys?: string[]
  requireUserAgent?: boolean
  rateLimit?: SimRateLimit | null
  sendRetryAfter?: boolean
  webhook?: SimWebhookConfig | null
  fetch?: typeof fetch
}

export interface LoggedRequest {
  at: string
  method: string
  path: string
  status: number
  userAgent?: string
}

/** The Squarespace Commerce API surface Oasis reads, plus /__sim control endpoints. Framework-free. */
export class SquarespaceSimApi {
  readonly log: LoggedRequest[] = []
  readonly deliveries: {
    at: string
    topic: string
    orderId: string
    status: number | 'error'
    notificationId: string
  }[] = []
  private failures: SimFailure[] = []
  private stamps: number[] = []
  private cooldownUntil = 0
  private notificationSeq = 0
  opts: Required<Pick<SimApiOptions, 'requireUserAgent' | 'sendRetryAfter'>> & SimApiOptions
  private pendingDeliveries: Promise<void>[] = []

  constructor(
    readonly store: SquarespaceSimStore,
    private readonly clock: Clock,
    opts: SimApiOptions = {},
  ) {
    this.opts = {
      apiKeys: ['sim-api-key'],
      requireUserAgent: true,
      sendRetryAfter: true,
      rateLimit: null,
      webhook: null,
      ...opts,
    }
    store.onEvent((e) => {
      const w = this.opts.webhook
      if (w?.autoDeliver) this.pendingDeliveries.push(this.deliver(e))
    })
  }

  /** Resolves when all auto-delivered webhooks have completed (tests). */
  async settled(): Promise<void> {
    await Promise.all(this.pendingDeliveries.splice(0))
  }

  injectFailure(f: SimFailure): void {
    this.failures.push({ ...f })
  }

  setRateLimit(r: SimRateLimit | null): void {
    this.opts.rateLimit = r
    this.stamps = []
    this.cooldownUntil = 0
  }

  async handle(req: SimRequest): Promise<SimResponse> {
    const res = await this.route(req)
    if (req.path.startsWith('/__sim/')) return res
    this.log.push({
      at: this.clock.now().toISOString(),
      method: req.method,
      path: req.path + (req.query.size ? `?${req.query.toString()}` : ''),
      status: res.status,
      userAgent: req.headers['user-agent'],
    })
    return res
  }

  private async route(req: SimRequest): Promise<SimResponse> {
    const isControl = req.path.startsWith('/__sim/')
    if (isControl) return this.control(req)

    const gate = this.gate(req)
    if (gate) return gate
    try {
      return this.api(req)
    } catch (e) {
      if (e instanceof SimBadRequest) return error(400, 'INVALID_REQUEST_ERROR', e.subtype, e.message)
      if (e instanceof SimNotFound) return error(404, 'NOT_FOUND', null, e.message)
      throw e
    }
  }

  private gate(req: SimRequest): SimResponse | undefined {
    const ua = req.headers['user-agent']
    if (this.opts.requireUserAgent && !ua?.trim()) {
      return error(
        400,
        'INVALID_REQUEST_ERROR',
        'MISSING_USER_AGENT',
        'Requests without a User-Agent header are rejected.',
      )
    }
    const auth = req.headers['authorization']
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined
    if (!token || !this.opts.apiKeys?.includes(token)) {
      return error(401, 'AUTHORIZATION_ERROR', 'INVALID_TOKEN', 'The provided token is invalid or expired.')
    }
    const now = this.clock.now().getTime()
    const rl = this.opts.rateLimit
    if (rl) {
      if (this.cooldownUntil > now) return this.tooMany(this.cooldownUntil - now)
      this.stamps = this.stamps.filter((t) => t > now - rl.windowMs)
      if (this.stamps.length >= rl.maxPerWindow) {
        this.cooldownUntil = now + rl.cooldownMs
        return this.tooMany(rl.cooldownMs)
      }
      this.stamps.push(now)
    }
    const idx = this.failures.findIndex((f) => !f.path || req.path.includes(f.path))
    const failure = idx >= 0 ? this.failures[idx] : undefined
    if (failure) {
      if (--failure.times <= 0) this.failures.splice(idx, 1)
      if (failure.status === 429)
        return this.tooMany((failure.retryAfterSeconds ?? 60) * 1000, failure.retryAfterSeconds !== undefined)
      return {
        status: failure.status,
        headers: {},
        body: failure.body ?? errorBody('SERVER_ERROR', null, 'Injected failure'),
      }
    }
    return undefined
  }

  private tooMany(ms: number, forceHeader = false): SimResponse {
    return {
      status: 429,
      headers: this.opts.sendRetryAfter || forceHeader ? { 'Retry-After': String(Math.ceil(ms / 1000)) } : {},
      body: errorBody('TOO_MANY_REQUESTS_ERROR', null, 'Rate limit exceeded; cool down for one minute.'),
    }
  }

  private api(req: SimRequest): SimResponse {
    if (req.method !== 'GET')
      return error(405, 'METHOD_NOT_ALLOWED', null, 'The sim only serves GET for commerce resources.')
    const q = Object.fromEntries(req.query.entries())
    let m: RegExpMatchArray | null
    if (req.path === '/1.0/commerce/orders') {
      const page = this.store.queryOrders(q)
      return ok({ pagination: pagination(page.nextCursor, '/1.0/commerce/orders'), result: page.rows })
    }
    if ((m = req.path.match(/^\/1\.0\/commerce\/orders\/([^/]+)$/)))
      return ok(this.store.getOrder(decodeURIComponent(m[1] ?? '')))
    if (req.path === '/1.0/commerce/transactions') {
      const page = this.store.queryDocuments(q)
      return ok({
        documents: page.rows,
        pagination: pagination(page.nextCursor, '/1.0/commerce/transactions'),
      })
    }
    if ((m = req.path.match(/^\/1\.0\/commerce\/transactions\/([^/]+)$/))) {
      return ok({ documents: this.store.getDocuments(decodeURIComponent(m[1] ?? '').split(',')) })
    }
    if (req.path === '/v1/contacts') {
      const page = this.store.queryContacts({
        cursor: q.cursor,
        pageSize: q.pageSize === undefined ? undefined : Number(q.pageSize),
      })
      return ok({ contacts: page.rows, pagination: pagination(page.nextCursor, '/v1/contacts') })
    }
    return error(404, 'NOT_FOUND', null, `no such resource ${req.path}`)
  }

  // ---- control surface ----

  private async control(req: SimRequest): Promise<SimResponse> {
    const body = (req.body ?? {}) as Record<string, unknown>
    try {
      const path = req.path.replace(/^\/__sim/, '')
      let m: RegExpMatchArray | null
      if (req.method === 'GET' && path === '/state') {
        return ok({
          counts: this.store.counts(),
          requests: this.log.length,
          deliveries: this.deliveries.length,
          webhook: this.opts.webhook,
        })
      }
      if (req.method === 'GET' && path === '/requests') return ok(this.log.slice(-200))
      if (req.method !== 'POST') return error(405, 'METHOD_NOT_ALLOWED', null, 'control endpoints are POST')
      if (path === '/reset') {
        this.store.reset()
        this.log.length = 0
        this.failures = []
        return ok({ ok: true })
      }
      if (path === '/orders') return ok(this.store.createOrder(orderInput(body)), 201)
      if ((m = path.match(/^\/orders\/([^/]+)\/renew$/))) {
        return ok(
          this.store.renewSubscription(m[1] ?? '', {
            createdOn: optDate(body.createdOn),
            paid: body.paid === false ? false : undefined,
          }),
          201,
        )
      }
      if ((m = path.match(/^\/orders\/([^/]+)\/payments$/))) {
        const id = this.store.addPayment(m[1] ?? '', {
          amountCents: num(body.amountCents, 'amountCents'),
          brand: body.brand === null ? null : (body.brand as string | undefined),
          paidOn: optDate(body.paidOn),
          provider: body.provider as string | undefined,
        })
        return ok({ paymentId: id }, 201)
      }
      if ((m = path.match(/^\/orders\/([^/]+)\/refunds$/))) {
        const r: SimRefundInput = {
          amountCents: body.amountCents === undefined ? undefined : num(body.amountCents, 'amountCents'),
          paymentId: body.paymentId as string | undefined,
          refundedOn: optDate(body.refundedOn),
          documentLevel: body.documentLevel === true,
        }
        return ok({ refundId: this.store.refund(m[1] ?? '', r) }, 201)
      }
      if ((m = path.match(/^\/orders\/([^/]+)\/state$/))) {
        this.store.setState(m[1] ?? '', {
          paymentState: body.paymentState as string | undefined,
          fulfillmentStatus: body.fulfillmentStatus as string | undefined,
        })
        return ok({ ok: true })
      }
      if (path === '/failures') {
        this.injectFailure({
          status: num(body.status, 'status'),
          times: body.times === undefined ? 1 : num(body.times, 'times'),
          path: body.path as string | undefined,
          retryAfterSeconds:
            body.retryAfterSeconds === undefined
              ? undefined
              : num(body.retryAfterSeconds, 'retryAfterSeconds'),
        })
        return ok({ ok: true }, 201)
      }
      if (path === '/rate-limit') {
        this.setRateLimit(
          body.maxPerWindow === undefined
            ? null
            : {
                maxPerWindow: num(body.maxPerWindow, 'maxPerWindow'),
                windowMs: Number(body.windowMs ?? 60_000),
                cooldownMs: Number(body.cooldownMs ?? 60_000),
              },
        )
        return ok({ ok: true })
      }
      if (path === '/webhook-config') {
        this.opts.webhook = {
          url: String(body.url),
          secret: String(body.secret),
          subscriptionId: String(body.subscriptionId ?? 'sim_subscription'),
          websiteId: String(body.websiteId ?? 'sim_website'),
          autoDeliver: body.autoDeliver !== false,
        }
        return ok({ ok: true })
      }
      if (path === '/webhooks/deliver') {
        const status = await this.deliver({
          topic: (body.topic as 'order.create' | 'order.update' | undefined) ?? 'order.update',
          orderId: String(body.orderId),
          update: body.update as string | undefined,
        })
        return ok({ delivered: status })
      }
      return error(404, 'NOT_FOUND', null, `no such control endpoint ${req.path}`)
    } catch (e) {
      if (e instanceof SimBadRequest) return error(400, 'INVALID_REQUEST_ERROR', e.subtype, e.message)
      if (e instanceof SimNotFound) return error(404, 'NOT_FOUND', null, e.message)
      throw e
    }
  }

  /** Send a signed notification to the configured endpoint, exactly as Squarespace would. */
  async deliver(e: SimEvent): Promise<void> {
    const w = this.opts.webhook
    if (!w) throw new SimBadRequest('no webhook configured: POST /__sim/webhook-config first')
    const notificationId = (++this.notificationSeq).toString(16).padStart(24, '0')
    const signed = buildSignedNotification({
      secretHex: w.secret,
      id: notificationId,
      websiteId: w.websiteId,
      subscriptionId: w.subscriptionId,
      topic: e.topic,
      createdOn: this.clock.now(),
      data: e.update ? { orderId: e.orderId, update: e.update } : { orderId: e.orderId },
    })
    try {
      const res = await (this.opts.fetch ?? fetch)(w.url, {
        method: 'POST',
        headers: signed.headers,
        body: signed.rawBody,
      })
      this.deliveries.push({
        at: this.clock.now().toISOString(),
        topic: e.topic,
        orderId: e.orderId,
        status: res.status,
        notificationId,
      })
    } catch {
      this.deliveries.push({
        at: this.clock.now().toISOString(),
        topic: e.topic,
        orderId: e.orderId,
        status: 'error',
        notificationId,
      })
    }
  }
}

function ok(body: unknown, status = 200): SimResponse {
  return { status, headers: {}, body }
}

function errorBody(type: string, subtype: string | null, message: string) {
  return { type, subtype, message, details: null, contextId: 'SIMCTX' }
}

function error(status: number, type: string, subtype: string | null, message: string): SimResponse {
  return { status, headers: {}, body: errorBody(type, subtype, message) }
}

function pagination(cursor: string | undefined, path: string) {
  return cursor
    ? { hasNextPage: true, nextPageCursor: cursor, nextPageUrl: `${path}?cursor=${cursor}` }
    : { hasNextPage: false, nextPageCursor: null, nextPageUrl: null }
}

function num(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new SimBadRequest(`${name} must be a number`)
  return v
}

function optDate(v: unknown): Date | undefined {
  if (v === undefined || v === null) return undefined
  const d = new Date(String(v))
  if (Number.isNaN(d.getTime())) throw new SimBadRequest(`invalid date ${String(v)}`)
  return d
}

function orderInput(b: Record<string, unknown>): SimOrderInput {
  const items = b.lineItems
  if (!Array.isArray(items) || items.length === 0) throw new SimBadRequest('lineItems is required')
  const pay = b.pay
  return {
    email: b.email as string | undefined,
    name: b.name as string | undefined,
    phone: b.phone as string | undefined,
    lineItems: items.map((li: Record<string, unknown>) => ({
      productId: li.productId as string | undefined,
      sku: li.sku as string | undefined,
      name: String(li.name ?? 'Item'),
      unitCents: num(li.unitCents, 'unitCents'),
      qty: li.qty as number | undefined,
      lineItemType: li.lineItemType as string | undefined,
    })),
    taxCents: b.taxCents as number | undefined,
    shippingCents: b.shippingCents as number | undefined,
    discountCents: b.discountCents as number | undefined,
    createdOn: optDate(b.createdOn),
    testMode: b.testMode === true,
    channel: b.channel as 'web' | 'pos' | undefined,
    pay:
      pay === false
        ? false
        : pay && typeof pay === 'object'
          ? {
              amountCents: (pay as Record<string, unknown>).amountCents as number | undefined,
              brand: (pay as Record<string, unknown>).brand as string | null | undefined,
              paidOn: optDate((pay as Record<string, unknown>).paidOn),
            }
          : undefined,
  }
}
