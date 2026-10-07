// Real-time view of SMS Gate webhook deliveries for `pnpm verify:smsgate --watch`.
//   listener  binds the hooks listener address (HOOKS_HOST:HOOKS_PORT, default 127.0.0.1:3002) and answers like the app does:
//             the signature is checked with the real verifier against the raw body, 200 for a good delivery, 401 for a bad one.
//             Needs the port: stop oasis-api first, or pass --listen with another port that the tailnet mount points at.
//   database  follows webhook_log (provider smsgate) when the API keeps the port: it proves the whole production path, because a
//             row exists only after the tablet reached the tailnet mount, the hooks listener verified the signature and persisted it.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import pg from 'pg'
import { SmsWebhookError } from '../../src/integrations/sms/errors.js'
import { verifyAndParse } from '../../src/integrations/smsgate/webhook.js'
import { systemClock } from '../../src/platform/clock.js'

export interface WatchedEvent {
  at: Date
  envelopeId: string
  event: string
  payload: Record<string, unknown>
  /** The signature matched the shared secret (always true for the database source: the app verified it). */
  signatureOk: boolean
  via: 'listener' | 'database'
  /** Which delivery attempt of this envelope this is (1 = first), listener only. */
  attempt: number
  /** Why the delivery was refused, when it was. */
  rejected?: string
}

export interface Watcher {
  readonly kind: 'listener' | 'database'
  readonly where: string
  readonly events: WatchedEvent[]
  /** Attempt times per envelope id, listener only (retry spacing). */
  readonly attempts: Map<string, Date[]>
  waitFor(pred: (e: WatchedEvent) => boolean, timeoutMs: number): Promise<WatchedEvent | undefined>
  stop(): Promise<void>
}

type Sleep = (ms: number) => Promise<void>

abstract class BaseWatcher implements Watcher {
  abstract readonly kind: 'listener' | 'database'
  abstract readonly where: string
  readonly events: WatchedEvent[] = []
  readonly attempts = new Map<string, Date[]>()

  constructor(
    protected readonly sleep: Sleep,
    protected readonly onEvent?: (e: WatchedEvent) => void,
  ) {}

  protected push(e: WatchedEvent): void {
    this.events.push(e)
    this.onEvent?.(e)
  }

  async waitFor(pred: (e: WatchedEvent) => boolean, timeoutMs: number): Promise<WatchedEvent | undefined> {
    const deadline = Date.now() + timeoutMs
    let seen = 0
    for (;;) {
      for (; seen < this.events.length; seen++) if (pred(this.events[seen]!)) return this.events[seen]
      if (Date.now() >= deadline) return undefined
      await this.sleep(Math.min(50, Math.max(1, deadline - Date.now())))
    }
  }

  abstract stop(): Promise<void>
}

export interface ListenerOptions {
  host: string
  port: number
  secret: string
  toleranceSec: number
  /** Answer 500 to the first N attempts of every envelope, to measure the device's retry schedule. */
  rejectFirst?: number
  sleep: Sleep
  onEvent?: (e: WatchedEvent) => void
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export const PROBE_KEY = 'verify-live-probe'

export class ListenerWatcher extends BaseWatcher {
  readonly kind = 'listener' as const
  private server?: Server
  private address = ''

  constructor(private readonly o: ListenerOptions) {
    super(o.sleep, o.onEvent)
  }

  get where(): string {
    return this.address
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      void this.handle(req).then(
        (r) => res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.body)),
        () => res.writeHead(500).end(),
      )
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.o.port, this.o.host, resolve)
    })
    this.server = server
    const a = server.address() as AddressInfo
    this.address = `http://${this.o.host}:${a.port}`
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const url = new URL(req.url ?? '/', 'http://x')
    const m = /^\/hooks\/smsgate\/([^/]+)$/.exec(url.pathname)
    const raw = req.method === 'POST' ? await readBody(req) : ''
    // The same answers as src/modules/messaging/http/hooks-app.ts, so the probe for the tailnet mount behaves identically.
    if (req.method !== 'POST' || !m) return { status: 404, body: { ok: false, status: 'not_found' } }
    if (m[1] === PROBE_KEY) return { status: 404, body: { ok: false, status: 'unknown_device' } }
    const headers: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v
    const at = systemClock.now()
    try {
      const parsed = verifyAndParse(headers, raw, {
        secret: this.o.secret,
        toleranceSec: this.o.toleranceSec,
        clock: systemClock,
      })
      const times = this.attempts.get(parsed.envelopeId) ?? []
      times.push(at)
      this.attempts.set(parsed.envelopeId, times)
      const attempt = times.length
      const refuse = (this.o.rejectFirst ?? 0) >= attempt
      this.push({
        at,
        envelopeId: parsed.envelopeId,
        event: parsed.eventName,
        payload: JSON.parse(raw).payload as Record<string, unknown>,
        signatureOk: true,
        via: 'listener',
        attempt,
        ...(refuse ? { rejected: 'answered 500 on purpose (--reject)' } : {}),
      })
      return refuse
        ? { status: 500, body: { ok: false, status: 'rejected_for_test' } }
        : { status: 200, body: { ok: true } }
    } catch (e) {
      if (!(e instanceof SmsWebhookError)) throw e
      if (e.code === 'unsupported_event') return { status: 200, body: { ok: true, status: 'ignored' } }
      let envelope: { id?: string; event?: string; payload?: Record<string, unknown> } = {}
      try {
        envelope = JSON.parse(raw) as typeof envelope
      } catch {
        /* not JSON */
      }
      this.push({
        at,
        envelopeId: envelope.id ?? '(unreadable)',
        event: envelope.event ?? '(unknown)',
        payload: envelope.payload ?? {},
        signatureOk: e.code !== 'bad_signature' && e.code !== 'missing_header',
        via: 'listener',
        attempt: 1,
        rejected: `${e.code}: ${e.message}`,
      })
      return { status: e.code === 'bad_body' ? 400 : 401, body: { ok: false, status: e.code } }
    }
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
    this.server?.closeAllConnections()
  }
}

export interface DatabaseWatchOptions {
  url: string
  since: Date
  everyMs?: number
  sleep: Sleep
  onEvent?: (e: WatchedEvent) => void
}

export class DatabaseWatcher extends BaseWatcher {
  readonly kind = 'database' as const
  readonly where = 'webhook_log (provider smsgate)'
  private readonly client: pg.Client
  private timer?: NodeJS.Timeout
  private lastSeen: Date
  private readonly seen = new Set<string>()
  private busy = false

  constructor(private readonly o: DatabaseWatchOptions) {
    super(o.sleep, o.onEvent)
    this.client = new pg.Client({ connectionString: o.url, application_name: 'oasis-verify-live' })
    this.lastSeen = o.since
  }

  async start(): Promise<void> {
    await this.client.connect()
    await this.poll()
    this.timer = setInterval(() => void this.poll(), this.o.everyMs ?? 1000)
  }

  private async poll(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const r = await this.client.query<{
        external_id: string
        body: string | null
        signature_valid: boolean
        received_at: Date
      }>(
        `select external_id, body, signature_valid, received_at from webhook_log
         where provider = 'smsgate' and received_at >= $1 order by received_at, id`,
        [this.lastSeen],
      )
      for (const row of r.rows) {
        if (this.seen.has(row.external_id)) continue
        this.seen.add(row.external_id)
        if (row.received_at > this.lastSeen) this.lastSeen = row.received_at
        let envelope: { event?: string; payload?: Record<string, unknown> } = {}
        try {
          envelope = JSON.parse(row.body ?? '{}') as typeof envelope
        } catch {
          /* leave empty */
        }
        this.push({
          at: row.received_at,
          envelopeId: row.external_id,
          event: envelope.event ?? '(unknown)',
          payload: envelope.payload ?? {},
          signatureOk: row.signature_valid,
          via: 'database',
          attempt: 1,
        })
      }
    } finally {
      this.busy = false
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    await this.client.end().catch(() => {})
  }
}

/** Starts the listener on host:port; returns undefined when the port is taken (the API owns it). */
export async function tryListener(o: ListenerOptions): Promise<ListenerWatcher | undefined> {
  const w = new ListenerWatcher(o)
  try {
    await w.start()
    return w
  } catch (e) {
    if ((e as { code?: string }).code === 'EADDRINUSE') return undefined
    throw e
  }
}
