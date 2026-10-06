import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { systemClock, type Clock } from '../../platform/clock.js'
import { signWebhook } from './signature.js'
import { SimDevice, type SimDelivery } from './sim-device.js'

export type ServerOutage = 'off' | 'down' | 'error5xx' | 'hang' | 'hang_after_accept'

export interface SimServerOptions {
  clock?: Clock
  host?: string
  port?: number
  username?: string
  password?: string
  signingKey?: string
  deviceId?: string
  autoProgress?: 'instant' | 'manual'
  /** Delay before each retry of a failed webhook delivery; its length is the retry budget. The app uses 10 s doubling, 14 tries. */
  retryDelaysMs?: number[]
  /** The real app refuses http:// targets other than 127.0.0.1. The simulator accepts them unless this is true. */
  strictWebhookUrls?: boolean
  schedule?: (fn: () => void, ms: number) => unknown
  webhookTimeoutMs?: number
}

export interface DeliveryRecord {
  envelopeId: string
  event: string
  url: string
  webhookId: string
  state: 'pending' | 'delivered' | 'failed'
  attempts: Array<{ at: string; status?: number; error?: string }>
  body: string
}

const DEFAULT_RETRY = Array.from({ length: 14 }, (_, i) => 10_000 * 2 ** i)

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, { ...(text ? { 'content-type': 'application/json' } : {}), ...headers })
  res.end(text)
}

/** HTTP front for SimDevice: the SMS Gate local-server API plus /__sim/* control endpoints (no auth, simulator only). */
export class SimServer {
  readonly device: SimDevice
  outage: ServerOutage = 'off'
  private outageOnce = false
  private server?: Server
  private readonly sockets = new Set<Socket>()
  private readonly clock: Clock
  private readonly opts: Required<Pick<SimServerOptions, 'host' | 'username' | 'password' | 'retryDelaysMs' | 'webhookTimeoutMs'>> & SimServerOptions
  readonly deliveries: DeliveryRecord[] = []
  private stopped = false

  constructor(opts: SimServerOptions = {}) {
    this.clock = opts.clock ?? systemClock
    this.opts = {
      host: '127.0.0.1',
      username: 'sim',
      password: 'sim',
      retryDelaysMs: DEFAULT_RETRY,
      webhookTimeoutMs: 10_000,
      ...opts,
    }
    this.device = new SimDevice({
      clock: this.clock,
      deviceId: opts.deviceId,
      signingKey: opts.signingKey,
      autoProgress: opts.autoProgress ?? 'instant',
      allowInsecureWebhookUrl: !opts.strictWebhookUrls,
    })
    this.device.onDelivery((d) => this.dispatch(d))
  }

  get url(): string {
    const addr = this.server?.address()
    if (!addr || typeof addr === 'string') throw new Error('simulator is not listening')
    return `http://${this.opts.host}:${addr.port}`
  }

  async start(): Promise<string> {
    this.stopped = false
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) send(res, 500, { message: (err as Error).message })
        else res.end()
      })
    })
    this.server.on('connection', (s) => {
      this.sockets.add(s)
      s.on('close', () => this.sockets.delete(s))
    })
    await new Promise<void>((resolve) => this.server?.listen(this.opts.port ?? 0, this.opts.host, resolve))
    return this.url
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const s of this.sockets) s.destroy()
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
  }

  // ---- webhook transport ------------------------------------------------------------------------------------------

  private dispatch(d: SimDelivery): void {
    // A duplicate injected by duplicateNextDeliveries() is a separate transmission of the same envelope.
    const record: DeliveryRecord = { envelopeId: d.envelopeId, event: d.event, url: d.url, webhookId: d.webhookId, state: 'pending', attempts: [], body: d.body }
    this.deliveries.push(record)
    void this.attempt(record, 0)
  }

  private async attempt(record: DeliveryRecord, n: number): Promise<void> {
    if (this.stopped) return
    // Every attempt is signed afresh with the current time, as the app does, over the identical body.
    const ts = String(Math.floor(this.clock.now().getTime() / 1000))
    const headers = {
      'content-type': 'application/json',
      'x-signature': signWebhook(this.device.signingKey, record.body, ts),
      'x-timestamp': ts,
      'user-agent': 'me.capcom.smsgateway/sim',
    }
    let ok = false
    try {
      const res = await fetch(record.url, { method: 'POST', headers, body: record.body, signal: AbortSignal.timeout(this.opts.webhookTimeoutMs) })
      record.attempts.push({ at: this.clock.now().toISOString(), status: res.status })
      ok = res.status >= 200 && res.status < 300
    } catch (err) {
      record.attempts.push({ at: this.clock.now().toISOString(), error: (err as Error).message })
    }
    if (ok) {
      record.state = 'delivered'
      return
    }
    const delay = this.opts.retryDelaysMs[n]
    if (delay === undefined) {
      record.state = 'failed'
      return
    }
    const schedule = this.opts.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
    schedule(() => void this.attempt(record, n + 1), delay)
  }

  /** Resolves when no delivery is pending (tests). */
  async settled(maxWaitMs = 5000): Promise<void> {
    for (let waited = 0; this.deliveries.some((r) => r.state === 'pending'); waited += 5) {
      if (waited > maxWaitMs) throw new Error('webhook deliveries did not settle')
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  // ---- request handling -------------------------------------------------------------------------------------------

  private consumeOnce(): void {
    if (this.outageOnce) {
      this.outage = 'off'
      this.outageOnce = false
    }
  }

  private authorised(req: IncomingMessage): boolean {
    const h = req.headers.authorization
    if (!h?.startsWith('Basic ')) return false
    return Buffer.from(h.slice(6), 'base64').toString('utf8') === `${this.opts.username}:${this.opts.password}`
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://sim')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const method = req.method ?? 'GET'

    if (path.startsWith('/__sim')) return this.control(method, path, req, res)

    if (this.outage === 'down') {
      this.consumeOnce()
      req.socket.destroy()
      return
    }
    if (this.outage === 'hang') {
      this.consumeOnce()
      return
    }
    if (this.outage === 'error5xx') {
      this.consumeOnce()
      return send(res, 503, { message: 'Service unavailable (simulated)' })
    }

    if (method === 'GET' && path === '/health') {
      const h = this.device.health()
      return send(res, h.status, h.body)
    }
    if (!this.authorised(req)) {
      res.setHeader('www-authenticate', 'Basic realm="Access to SMS Gateway"')
      return send(res, 401)
    }

    const raw = method === 'GET' || method === 'DELETE' ? '' : await readBody(req)
    let json: unknown
    if (raw) {
      try {
        json = JSON.parse(raw)
      } catch {
        return send(res, 400, { message: 'Invalid JSON' })
      }
    }

    const seg = path.split('/').filter(Boolean)
    const head = seg[0]

    if (path === '/' && method === 'GET') return send(res, 200, { status: 'ok', model: 'SimTablet' })

    if (head === 'message' || head === 'messages') {
      const id = seg[1] ? decodeURIComponent(seg[1]) : undefined
      if (!id && method === 'POST') {
        const reply = this.device.enqueue(json)
        if (this.outage === 'hang_after_accept' && reply.status === 202) {
          this.consumeOnce()
          return // the device accepted the message but the response never arrives
        }
        const headers: Record<string, string> = reply.status === 202 ? { location: `/messages/${(reply.body as { id: string }).id}` } : {}
        return send(res, reply.status, reply.body, headers)
      }
      if (!id && method === 'GET') {
        const list = this.device.listMessages().map((m) => this.device.getMessage(m.id).body)
        return send(res, 200, list, { 'x-total-count': String(list.length) })
      }
      if (id && method === 'GET') {
        const reply = this.device.getMessage(id)
        return reply.status === 404 ? send(res, 404) : send(res, 200, reply.body)
      }
      if (id && method === 'DELETE') {
        const reply = this.device.cancelMessage(id)
        return reply.status === 404 ? send(res, 404) : send(res, reply.status, reply.body)
      }
    }

    if (head === 'webhook' || head === 'webhooks') {
      const id = seg[1] ? decodeURIComponent(seg[1]) : undefined
      if (!id && method === 'GET') return send(res, 200, this.device.listWebhooks())
      if (!id && method === 'POST') {
        const reply = this.device.putWebhook(json)
        return send(res, reply.status, reply.body)
      }
      if (id && method === 'DELETE') {
        this.device.deleteWebhook(id)
        return send(res, 204)
      }
    }

    if (head === 'settings' && (method === 'PATCH' || method === 'PUT')) {
      this.device.patchSettings(json)
      return send(res, 200, { webhooks: { signing_key: '***' } })
    }

    return send(res, 404, { message: 'not found' })
  }

  // ---- control endpoints ------------------------------------------------------------------------------------------

  private async control(method: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = method === 'POST' ? await readBody(req) : ''
    let b: Record<string, unknown> = {}
    if (raw) {
      try {
        b = JSON.parse(raw) as Record<string, unknown>
      } catch {
        return send(res, 400, { message: 'Invalid JSON' })
      }
    }
    const seg = path.split('/').filter(Boolean) // ['__sim', action, id?]
    const action = seg[1]
    const id = seg[2] ? decodeURIComponent(seg[2]) : undefined
    const ok = (extra: Record<string, unknown> = {}) => send(res, 200, { ok: true, ...extra })

    switch (`${method} ${action}`) {
      case 'POST inbound': {
        if (typeof b.from !== 'string' || typeof b.message !== 'string') return send(res, 400, { message: 'from and message are required' })
        const messageId = this.device.injectInbound(b.from, b.message, {
          simNumber: typeof b.simNumber === 'number' ? b.simNumber : undefined,
          messageId: typeof b.messageId === 'string' ? b.messageId : undefined,
        })
        return ok({ messageId })
      }
      case 'POST processed':
        return ok({ changed: id ? this.device.markProcessed(id) : false })
      case 'POST sent':
        return ok({ changed: id ? this.device.markSent(id) : false })
      case 'POST delivered':
        return ok({ changed: id ? this.device.markDelivered(id) : false })
      case 'POST failed':
        return ok({ changed: id ? this.device.markFailed(id, typeof b.reason === 'string' ? b.reason : undefined) : false })
      case 'POST outage': {
        const mode = b.mode
        if (!['off', 'down', 'error5xx', 'hang', 'hang_after_accept'].includes(String(mode))) return send(res, 400, { message: 'bad mode' })
        this.outage = mode as ServerOutage
        this.outageOnce = b.once === true
        return ok({ outage: this.outage })
      }
      case 'POST duplicate':
        this.device.duplicateNextDeliveries(typeof b.count === 'number' ? b.count : 1)
        return ok()
      case 'POST hold':
        this.device.holdDeliveries(b.on !== false)
        return ok()
      case 'POST flush':
        return ok({ released: this.device.flushHeld(b.order === 'fifo' ? 'fifo' : 'reverse') })
      case 'POST ping':
        this.device.ping()
        return ok()
      case 'POST app-started':
        this.device.appStarted()
        return ok()
      case 'POST health':
        if (b.status === 'pass' || b.status === 'warn' || b.status === 'fail') this.device.healthStatus = b.status
        if (typeof b.battery === 'number') this.device.battery = b.battery
        if (typeof b.charging === 'boolean') this.device.charging = b.charging
        return ok()
      case 'POST signing-key':
        if (typeof b.key === 'string' && b.key) this.device.signingKey = b.key
        return ok()
      case 'GET state':
        return send(res, 200, {
          outage: this.outage,
          deviceId: this.device.deviceId,
          messages: this.device.listMessages().map((m) => ({ id: m.id, state: m.state, to: m.phone, text: m.text })),
          webhooks: this.device.listWebhooks(),
        })
      case 'GET deliveries':
        return send(res, 200, this.deliveries)
      default:
        return send(res, 404, { message: 'unknown control endpoint' })
    }
  }
}
