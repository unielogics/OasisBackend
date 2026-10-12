// The hand-written Square client (ADR 0171 D1: no SDK). One `request()` on fetch: Bearer token, the pinned Square-Version, a
// timeout, zod-validated answers, typed errors and a strict retry rule:
//   - a GET, a read-only POST (search, batch retrieve) or a call that carries an idempotency_key is repeated on network errors,
//     timeouts, 429 (Retry-After honoured) and 5xx, with exponential backoff plus jitter;
//   - any other call that changes something (Cancel, Pause, Swap, DisableCard, DeletePaymentLink...) is repeated only when the
//     request surely never left (connection refused, DNS); its "already done" error codes count as success.
// The token is never logged, never put in an error and never echoed: onRequest sees method, path, attempt, status and time only.
import { randomInt } from 'node:crypto'
import type { z } from 'zod'
import {
  SquareNetworkError,
  SquareWireError,
  SquareWritesDisabled,
  squareErrorFrom,
  type SquareApiError,
} from './errors.js'
import type { SquareKey } from './keys.js'
import { SQUARE_API_VERSION } from './config.js'

export interface SquareRequestInfo {
  method: string
  path: string
  attempt: number
  status?: number
  ms: number
  error?: string
}

export interface Sleeper {
  sleep(ms: number): Promise<void>
}

export const realSleeper: Sleeper = { sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms))) }

export interface SquareClientOptions {
  /** Origin without /v2, e.g. https://connect.squareupsandbox.com or a simulator's http://127.0.0.1:4591. */
  baseUrl: string
  accessToken: string
  apiVersion?: string
  fetch?: typeof fetch
  timeoutMs?: number
  /** Total tries of a request that may be repeated. Default 4. */
  maxAttempts?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
  sleeper?: Sleeper
  /**
   * false = observe-only (SQUARE_WRITES_ENABLED=false): a call that would change something at Square throws SquareWritesDisabled
   * before anything is sent. Setup calls (EnableEvents, webhook subscriptions) are marked `setup` and still go.
   */
  writesEnabled?: boolean
  /** Observability hook (metrics, logs, tests). Must not throw. Never receives the token or a body. */
  onRequest?: (info: SquareRequestInfo) => void
}

export type Query = Record<string, string | number | boolean | undefined | null>

export type AlreadyDone = string | { code: string; detail: RegExp }

export interface SquareRequest<S extends z.ZodTypeAny> {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** Path below the origin, starting with /v2/. */
  path: string
  query?: Query
  body?: Record<string, unknown>
  schema: S
  /** The idempotency key the body carries: makes the call repeatable. Put it in the body yourself (field names differ by call). */
  idempotencyKey?: SquareKey
  /** A POST or PUT that only reads (SearchCustomers, BatchRetrieveOrders, SearchEvents...): repeatable, allowed when observe-only. */
  readOnly?: boolean
  /** Configuration rather than money (EnableEvents, webhook subscriptions): allowed when observe-only. */
  setup?: boolean
  /**
   * Errors that mean the change is already in place (a code, or a code whose detail matches: Square answers some repeats with a
   * generic BAD_REQUEST); the call then resolves to null instead of throwing.
   */
  alreadyDone?: readonly AlreadyDone[]
}

const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'EHOSTUNREACH', 'ENETUNREACH'])

export class SquareClient {
  readonly baseUrl: string
  readonly apiVersion: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly sleeper: Sleeper
  readonly writesEnabled: boolean
  /** Every HTTP attempt (retries included). */
  requestCount = 0

  constructor(private readonly opts: SquareClientOptions) {
    if (!opts.accessToken) throw new Error('Square client needs an access token')
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.apiVersion = opts.apiVersion ?? SQUARE_API_VERSION
    this.fetchImpl = opts.fetch ?? fetch
    this.timeoutMs = opts.timeoutMs ?? 15_000
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 4)
    this.backoffBaseMs = opts.backoffBaseMs ?? 250
    this.backoffMaxMs = opts.backoffMaxMs ?? 8_000
    this.sleeper = opts.sleeper ?? realSleeper
    this.writesEnabled = opts.writesEnabled ?? true
  }

  async request<S extends z.ZodTypeAny>(r: SquareRequest<S> & { alreadyDone: readonly AlreadyDone[] }): Promise<z.infer<S> | null>
  async request<S extends z.ZodTypeAny>(r: SquareRequest<S>): Promise<z.infer<S>>
  async request<S extends z.ZodTypeAny>(r: SquareRequest<S>): Promise<z.infer<S> | null> {
    const changes = r.method !== 'GET' && !r.readOnly
    if (changes && !r.setup && !this.writesEnabled) throw new SquareWritesDisabled(`${r.method} ${r.path}`)
    if (r.idempotencyKey && r.body && !JSON.stringify(r.body).includes(r.idempotencyKey))
      throw new Error(`Square ${r.method} ${r.path}: the idempotency key is not in the body`)
    const repeatable = !changes || !!r.idempotencyKey
    const url = this.url(r.path, r.query)
    const body = r.body === undefined ? undefined : JSON.stringify(r.body)
    for (let attempt = 1; ; attempt++) {
      this.requestCount++
      const started = performance.now()
      let res: Response
      try {
        res = await this.fetchImpl(url, {
          method: r.method,
          headers: {
            Authorization: `Bearer ${this.opts.accessToken}`,
            'Square-Version': this.apiVersion,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        })
      } catch (e) {
        const sent = !neverSent(e)
        const why = describeFetchError(e)
        this.report({ method: r.method, path: r.path, attempt, ms: performance.now() - started, error: why })
        if (attempt < this.maxAttempts && (repeatable || !sent)) {
          await this.sleeper.sleep(this.backoff(attempt))
          continue
        }
        throw new SquareNetworkError(`Square ${r.method} ${r.path}: ${why}`, sent, { cause: e })
      }
      this.report({ method: r.method, path: r.path, attempt, status: res.status, ms: performance.now() - started })
      const text = await res.text().catch(() => '')
      let json: unknown
      try {
        json = text ? JSON.parse(text) : {}
      } catch {
        json = undefined
      }
      if (res.ok) {
        if (json === undefined) throw new SquareWireError(`Square ${r.method} ${r.path}: the answer is not JSON`)
        const parsed = r.schema.safeParse(json)
        if (!parsed.success)
          throw new SquareWireError(
            `Square ${r.method} ${r.path}: unexpected answer shape: ${parsed.error.issues
              .slice(0, 3)
              .map((i) => `${i.path.join('.')} ${i.message}`)
              .join('; ')}`,
          )
        return parsed.data
      }
      const err: SquareApiError = squareErrorFrom(res.status, json, r.method, r.path)
      if (r.alreadyDone && isAlreadyDone(err, r.alreadyDone)) return null
      if (err.retryable && repeatable && attempt < this.maxAttempts) {
        const wait = res.status === 429 ? retryAfterMs(res.headers.get('retry-after')) : undefined
        await this.sleeper.sleep(Math.min(this.backoffMaxMs * 4, wait ?? this.backoff(attempt)))
        continue
      }
      throw err
    }
  }

  private url(path: string, query?: Query): string {
    if (!path.startsWith('/v2/')) throw new Error(`Square path must start with /v2/: ${path}`)
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
    return `${this.baseUrl}${path}${qs.size ? `?${qs.toString()}` : ''}`
  }

  private backoff(attempt: number): number {
    const base = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** (attempt - 1))
    return base + (this.backoffBaseMs > 0 ? randomInt(0, Math.max(1, Math.floor(base / 2))) : 0)
  }

  private report(info: SquareRequestInfo): void {
    try {
      this.opts.onRequest?.({ ...info, ms: Math.round(info.ms) })
    } catch {
      // observability must never break a payment call
    }
  }
}

export function isAlreadyDone(err: SquareApiError, list: readonly AlreadyDone[]): boolean {
  return err.errors.some((e) =>
    list.some((a) => (typeof a === 'string' ? e.code === a : e.code === a.code && a.detail.test(e.detail ?? ''))),
  )
}

function causeCode(e: unknown): string | undefined {
  const c = (e as { cause?: { code?: unknown } } | null)?.cause?.code
  const own = (e as { code?: unknown } | null)?.code
  return typeof c === 'string' ? c : typeof own === 'string' ? own : undefined
}

/** True when the request surely never reached Square (nothing to fear from sending it again). */
export function neverSent(e: unknown): boolean {
  const code = causeCode(e)
  return !!code && NEVER_SENT.has(code)
}

function describeFetchError(e: unknown): string {
  const name = (e as { name?: unknown } | null)?.name
  if (name === 'TimeoutError' || name === 'AbortError') return 'timed out'
  const code = causeCode(e)
  return code ? `network error ${code}` : `network error${e instanceof Error ? `: ${e.message}` : ''}`
}

function retryAfterMs(h: string | null): number | undefined {
  if (!h) return undefined
  const s = Number(h)
  return Number.isFinite(s) && s >= 0 ? s * 1000 : undefined
}
