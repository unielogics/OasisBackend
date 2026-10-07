import type { z } from 'zod'
import type { Clock } from '../../platform/clock.js'
import type {
  Page,
  SqspContact,
  SqspOrder,
  SqspTransaction,
  SquarespaceSource,
} from '../ports/squarespace.js'
import { bearerFor, type SquarespaceAuth } from './auth.js'
import {
  SquarespaceApiError,
  SquarespaceAuthError,
  SquarespaceMappingError,
  SquarespaceNetworkError,
  SquarespaceNotFoundError,
  SquarespacePermissionError,
  SquarespaceRateLimitError,
  type SquarespaceErrorBody,
} from './errors.js'
import {
  DEFAULT_BUDGET_PER_MINUTE,
  DEFAULT_COOLDOWN_MS,
  SlidingWindowLimiter,
  parseRetryAfter,
  type RequestLimiter,
} from './limiter.js'
import { mapContact, mapOrder, mapTransactionDocument, type MapOptions } from './mappers.js'
import type { Sleeper } from './sleeper.js'
import {
  PAYMENT_STATES,
  wireContactList,
  wireOrderList,
  wireTransactionList,
  type WirePagination,
} from './wire.js'

export const DEFAULT_BASE_URL = 'https://api.squarespace.com'
export const DEFAULT_USER_AGENT = 'OasisAutoSpa-Sync/1.0 (+https://oasisautospa.example)'

/** Resource versions from the versioning guide (2026-10-06). Orders/Transactions are still 1.0; Contacts is v1. */
export const API_PATHS = {
  orders: '/1.0/commerce/orders',
  transactions: '/1.0/commerce/transactions',
  contacts: '/v1/contacts',
} as const

export interface RequestInfo {
  method: string
  path: string
  attempt: number
  status?: number
}

export interface SquarespaceClientOptions extends MapOptions {
  auth: SquarespaceAuth
  clock: Clock
  sleeper: Sleeper
  baseUrl?: string
  userAgent?: string
  fetch?: typeof fetch
  limiter?: RequestLimiter
  /** Total tries per request for 5xx/network errors (and 401 refresh). Default 5. */
  maxAttempts?: number
  /** How many 429s in a row before giving up. Default 5. */
  max429Retries?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
  /** Used when a 429 carries no Retry-After. The docs state a one-minute cool down. */
  default429CooldownMs?: number
  timeoutMs?: number
  /**
   * paymentStates filter for the orders list. Without it the API returns only NOT_CHARGED, AUTHORIZED, PAID and
   * REFUNDED and hides payment-plan and failed/pending orders. Default: all nine. `null` omits the parameter.
   */
  orderPaymentStates?: readonly string[] | null
  /** Contacts page size (documented max 1000, default 50). */
  contactsPageSize?: number
  /** Observability hook (metrics, tests). Must not throw. */
  onRequest?: (info: RequestInfo) => void
}

type Query = Record<string, string | undefined>

export class SquarespaceClient implements SquarespaceSource {
  private readonly baseUrl: string
  private readonly userAgent: string
  private readonly fetchImpl: typeof fetch
  readonly limiter: RequestLimiter
  private readonly maxAttempts: number
  private readonly max429Retries: number
  private readonly backoffBaseMs: number
  private readonly backoffMaxMs: number
  private readonly cooldown429Ms: number
  private readonly timeoutMs: number
  private readonly orderPaymentStates: readonly string[] | null
  private readonly contactsPageSize: number
  /** Every HTTP attempt that reached the limiter (retries included). */
  requestCount = 0

  constructor(private readonly opts: SquarespaceClientOptions) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT
    this.fetchImpl = opts.fetch ?? fetch
    this.limiter =
      opts.limiter ?? new SlidingWindowLimiter(opts.clock, opts.sleeper, DEFAULT_BUDGET_PER_MINUTE, 60_000)
    this.maxAttempts = opts.maxAttempts ?? 5
    this.max429Retries = opts.max429Retries ?? 5
    this.backoffBaseMs = opts.backoffBaseMs ?? 500
    this.backoffMaxMs = opts.backoffMaxMs ?? 30_000
    this.cooldown429Ms = opts.default429CooldownMs ?? DEFAULT_COOLDOWN_MS
    this.timeoutMs = opts.timeoutMs ?? 30_000
    this.orderPaymentStates = opts.orderPaymentStates === undefined ? PAYMENT_STATES : opts.orderPaymentStates
    this.contactsPageSize = opts.contactsPageSize ?? 500
    if (!this.userAgent.trim()) throw new Error('Squarespace rejects requests without a User-Agent')
  }

  async listOrders(p: {
    modifiedAfter: Date
    modifiedBefore: Date
    cursor?: string
  }): Promise<Page<SqspOrder>> {
    // The API requires modifiedAfter and modifiedBefore together and forbids any other parameter with a cursor.
    const query: Query = p.cursor
      ? { cursor: p.cursor }
      : {
          modifiedAfter: p.modifiedAfter.toISOString(),
          modifiedBefore: p.modifiedBefore.toISOString(),
          paymentStates: this.orderPaymentStates?.join(','),
        }
    const body = envelope(wireOrderList, await this.get(API_PATHS.orders, query), 'orders')
    return this.page(body.result, body.pagination, (raw) => mapOrder(raw, this.opts), 'order')
  }

  async getOrder(id: string): Promise<SqspOrder> {
    return mapOrder(await this.get(`${API_PATHS.orders}/${encodeURIComponent(id)}`, {}), this.opts)
  }

  async listTransactions(p: {
    modifiedAfter: Date
    modifiedBefore: Date
    cursor?: string
  }): Promise<Page<SqspTransaction>> {
    const query: Query = p.cursor
      ? { cursor: p.cursor }
      : { modifiedAfter: p.modifiedAfter.toISOString(), modifiedBefore: p.modifiedBefore.toISOString() }
    return this.transactionPage(query)
  }

  /** Transactions for one order (documented optional `orderId` filter). Not part of the port; used for reconciliation. */
  async listTransactionsForOrder(orderId: string, cursor?: string): Promise<Page<SqspTransaction>> {
    return this.transactionPage(cursor ? { cursor } : { orderId })
  }

  async listContacts(p: { cursor?: string }): Promise<Page<SqspContact>> {
    const query: Query = p.cursor ? { cursor: p.cursor } : { pageSize: String(this.contactsPageSize) }
    const body = envelope(wireContactList, await this.get(API_PATHS.contacts, query), 'contacts')
    return this.page(body.contacts, body.pagination, mapContact, 'contact')
  }

  private async transactionPage(query: Query): Promise<Page<SqspTransaction>> {
    const body = envelope(wireTransactionList, await this.get(API_PATHS.transactions, query), 'transactions')
    const items: SqspTransaction[] = []
    const rejected: NonNullable<Page<SqspTransaction>['rejected']> = []
    for (const raw of body.documents ?? []) {
      try {
        items.push(...mapTransactionDocument(raw))
      } catch (e) {
        rejected.push({ id: rowId(raw), reason: errorMessage(e), raw })
      }
    }
    return { items, nextCursor: nextCursor(body.pagination), ...(rejected.length ? { rejected } : {}) }
  }

  private page<T>(
    rows: unknown[] | null | undefined,
    pagination: WirePagination | null | undefined,
    map: (raw: unknown) => T,
    label: string,
  ): Page<T> {
    const items: T[] = []
    const rejected: NonNullable<Page<T>['rejected']> = []
    for (const raw of rows ?? []) {
      try {
        items.push(map(raw))
      } catch (e) {
        rejected.push({ id: rowId(raw), reason: `${label}: ${errorMessage(e)}`, raw })
      }
    }
    return { items, nextCursor: nextCursor(pagination), ...(rejected.length ? { rejected } : {}) }
  }

  private async get(path: string, query: Query): Promise<unknown> {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') qs.set(k, v)
    const fullPath = qs.size ? `${path}?${qs.toString()}` : path
    return this.request('GET', fullPath)
  }

  /** One logical request: limiter, auth, 429 cool down, 5xx/network backoff, a single 401 refresh. */
  private async request(method: string, path: string): Promise<unknown> {
    let attempt = 0
    let rateLimited = 0
    let refreshed = false
    for (;;) {
      attempt++
      await this.limiter.acquire()
      this.requestCount++
      let res: Response
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${await bearerFor(this.opts.auth)}`,
            'User-Agent': this.userAgent,
            Accept: 'application/json',
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        })
      } catch (e) {
        this.opts.onRequest?.({ method, path, attempt })
        if (attempt >= this.maxAttempts) {
          throw new SquarespaceNetworkError(`Squarespace ${method} ${path}: ${errorMessage(e)}`, { cause: e })
        }
        await this.opts.sleeper.sleep(this.backoff(attempt))
        continue
      }
      this.opts.onRequest?.({ method, path, attempt, status: res.status })
      if (res.ok) {
        if (res.status === 204) return null
        try {
          return await res.json()
        } catch (e) {
          throw new SquarespaceMappingError(`Squarespace ${method} ${path}: response body is not JSON`, {
            cause: e,
          })
        }
      }

      const body = await readErrorBody(res)
      if (res.status === 429) {
        const wait =
          parseRetryAfter(res.headers.get('retry-after'), this.opts.clock.now()) ?? this.cooldown429Ms
        this.limiter.cooldown(wait)
        rateLimited++
        if (rateLimited > this.max429Retries) throw new SquarespaceRateLimitError(body, method, path, wait)
        continue
      }
      if (res.status === 401) {
        const tokens = this.opts.auth.kind === 'oauth' ? this.opts.auth.tokens : undefined
        if (tokens?.refreshAfterUnauthorized && !refreshed) {
          refreshed = true
          await tokens.refreshAfterUnauthorized()
          continue
        }
        throw new SquarespaceAuthError(401, body, method, path)
      }
      if (res.status === 402 || res.status === 403)
        throw new SquarespacePermissionError(res.status, body, method, path)
      if (res.status === 404) throw new SquarespaceNotFoundError(404, body, method, path)
      if (res.status >= 500 && attempt < this.maxAttempts) {
        await this.opts.sleeper.sleep(this.backoff(attempt))
        continue
      }
      throw new SquarespaceApiError(res.status, body, method, path)
    }
  }

  private backoff(attempt: number): number {
    return Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** (attempt - 1))
  }
}

function envelope<S extends z.ZodTypeAny>(schema: S, body: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(body)
  if (!parsed.success)
    throw new SquarespaceMappingError(
      `${what} list response does not match the documented envelope: ${parsed.error.message}`,
    )
  return parsed.data
}

function nextCursor(p: WirePagination | null | undefined): string | undefined {
  if (!p?.hasNextPage) return undefined
  // "more pages" without a cursor is a broken response, not the end of the list: ending here would let the sync advance its
  // watermark past rows it never read.
  if (!p.nextPageCursor) throw new SquarespaceMappingError('list response says hasNextPage but carries no nextPageCursor')
  return p.nextPageCursor
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function rowId(raw: unknown): string | undefined {
  const id = (raw as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id : undefined
}

async function readErrorBody(res: Response): Promise<SquarespaceErrorBody | undefined> {
  try {
    const text = await res.text()
    if (!text) return undefined
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as SquarespaceErrorBody) : undefined
  } catch {
    return undefined
  }
}
