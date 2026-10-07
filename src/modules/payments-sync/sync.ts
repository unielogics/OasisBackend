import type { Clock } from '../../platform/clock.js'
import type {
  Page,
  SqspContact,
  SqspOrder,
  SqspTransaction,
  SquarespaceSource,
} from '../../integrations/ports/squarespace.js'
import type {
  ContactRepository,
  OrderRepository,
  SyncErrorRepository,
  SyncStateRepository,
  TransactionRepository,
} from './repositories.js'
import type { InFlightWindow, SyncResource, SyncState, UpsertOutcome } from './types.js'

const MINUTE = 60_000
const DAY = 86_400_000

export interface SyncConfig {
  /** Re-read this far behind the watermark: covers clock skew and records Squarespace commits late. Default 5 min. */
  overlapMs: number
  /** First run reads this far back. Default 45 days (same as the reconcile horizon). */
  initialLookbackMs: number
  /** One request window never exceeds this; long gaps are read in chunks so progress persists. Default 7 days. */
  maxWindowMs: number
  /** Port calls per run; leaves room under the 300/min limit and lets a long backlog resume next run. Default 120. */
  maxRequestsPerRun: number
  /** Budget for one reconcile invocation. Default 400 (the client limiter still spreads them over minutes). */
  reconcileMaxRequests: number
  reconcileDays: number
  /** test_mode orders are stored as ignored unless this is true. */
  includeTestMode: boolean
  /** A persist failure for the same item this many times is dead-lettered so it cannot wedge the watermark. */
  maxItemAttempts: number
  /** Consecutive failed runs before the resource goes to dead_letter and stops polling until resumed. */
  deadLetterAfterFailures: number
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  overlapMs: 5 * MINUTE,
  initialLookbackMs: 45 * DAY,
  maxWindowMs: 7 * DAY,
  maxRequestsPerRun: 120,
  reconcileMaxRequests: 400,
  reconcileDays: 45,
  includeTestMode: false,
  maxItemAttempts: 5,
  deadLetterAfterFailures: 5,
}

export interface SyncDeps {
  source: SquarespaceSource
  orders: OrderRepository
  transactions: TransactionRepository
  contacts: ContactRepository
  state: SyncStateRepository
  errors: SyncErrorRepository
  clock: Clock
}

export interface RunStats {
  requests: number
  pages: number
  seen: number
  inserted: number
  updated: number
  unchanged: number
  stale: number
  /** Rows the adapter could not map; dead-lettered immediately because mapping is deterministic. */
  rejected: number
  /** Rows that failed to persist this run and will be retried. */
  failed: number
  /** Rows given up on after maxItemAttempts. */
  deadLettered: number
  ignoredTestMode: number
}

export interface RunResult extends RunStats {
  resource: SyncResource
  status: 'ok' | 'partial' | 'error' | 'dead_letter' | 'skipped'
  windowFrom?: Date
  windowTo?: Date
  error?: string
}

export interface ReconcileReport {
  status: 'ok' | 'partial' | 'error' | 'dead_letter' | 'skipped'
  complete: boolean
  requests: number
  windowStart?: Date
  windowEnd?: Date
  orders: Pick<RunStats, 'seen' | 'inserted' | 'updated' | 'unchanged' | 'stale'>
  transactions: Pick<RunStats, 'seen' | 'inserted' | 'updated' | 'unchanged' | 'stale'>
  /** Stored orders inside the window that Squarespace no longer returns. Only computed when one invocation covers the whole window. */
  missingRemoteOrderIds?: string[]
  error?: string
}

export interface SyncHealth {
  ok: boolean
  resources: Record<
    string,
    { status: string; lastSuccessAt?: Date; lagMs?: number; consecutiveFailures: number; lastError?: string }
  >
  deadLetteredItems: number
}

class ChunkIncomplete extends Error {}

function emptyStats(): RunStats {
  return {
    requests: 0,
    pages: 0,
    seen: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    stale: 0,
    rejected: 0,
    failed: 0,
    deadLettered: 0,
    ignoredTestMode: 0,
  }
}

function freshState(resource: SyncResource): SyncState {
  return { resource, status: 'idle', consecutiveFailures: 0 }
}

function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null)?.status
  return typeof s === 'number' ? s : undefined
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export class SyncEngine {
  readonly cfg: SyncConfig

  constructor(
    private readonly d: SyncDeps,
    cfg: Partial<SyncConfig> = {},
  ) {
    this.cfg = { ...DEFAULT_SYNC_CONFIG, ...cfg }
    if (this.cfg.maxWindowMs <= this.cfg.overlapMs)
      throw new Error('maxWindowMs must exceed overlapMs or windows cannot advance')
    if (this.cfg.maxRequestsPerRun < 1) throw new Error('maxRequestsPerRun must be >= 1')
  }

  /** Orders first so the transaction pass can see which orders are test-mode. */
  async runCycle(): Promise<{ orders: RunResult; transactions: RunResult }> {
    const orders = await this.pollOrders()
    const transactions = await this.pollTransactions()
    return { orders, transactions }
  }

  pollOrders(): Promise<RunResult> {
    return this.pollWindows<SqspOrder>(
      'orders',
      (w) => this.d.source.listOrders({ modifiedAfter: w.from, modifiedBefore: w.to, cursor: w.cursor }),
      (o) => o.id,
      (o, s) => this.storeOrder(o, s),
    )
  }

  pollTransactions(): Promise<RunResult> {
    return this.pollWindows<SqspTransaction>(
      'transactions',
      (w) =>
        this.d.source.listTransactions({ modifiedAfter: w.from, modifiedBefore: w.to, cursor: w.cursor }),
      (t) => t.id,
      (t) => this.storeTransaction(t),
    )
  }

  /** Webhook path: fetch the one order named by a notification and upsert it (idempotent with the poll). */
  async ingestOrder(orderId: string): Promise<UpsertOutcome> {
    return this.storeOrder(await this.d.source.getOrder(orderId), emptyStats())
  }

  /** Contacts have no modified filter: read the whole list, resuming from a saved cursor if a run was cut short. */
  async syncContacts(): Promise<RunResult> {
    const stats = emptyStats()
    const resource: SyncResource = 'contacts'
    const state = (await this.d.state.get(resource)) ?? freshState(resource)
    if (state.status === 'dead_letter') return { ...stats, resource, status: 'skipped' }
    const now = this.d.clock.now()
    state.lastRunAt = now
    let window: InFlightWindow = state.inFlight ?? { from: now, to: now }
    const known = await this.knownErrorKeys(resource)
    try {
      for (;;) {
        if (stats.requests >= this.cfg.maxRequestsPerRun) {
          state.inFlight = window
          state.status = 'partial'
          await this.d.state.save(state)
          return { ...stats, resource, status: 'partial' }
        }
        const page = await this.d.source.listContacts({ cursor: window.cursor })
        stats.requests++
        stats.pages++
        await this.handlePage<SqspContact>(
          resource,
          page,
          (c) => c.id,
          (c) => this.d.contacts.upsert(c, { now }),
          stats,
          known,
        )
        this.failIfIncomplete(stats)
        if (!page.nextCursor) break
        window = { ...window, cursor: page.nextCursor }
      }
      state.inFlight = undefined
      return await this.finishOk(state, now, stats, resource)
    } catch (e) {
      return this.finishError(state, stats, resource, e, window.cursor ? window : undefined)
    }
  }

  /**
   * Nightly full re-read of the last `days` days (default 45), orders then transactions, upserting anything the poll missed or
   * saw in an older version. Resumes if the request budget runs out. Does not touch the poll watermarks.
   */
  async reconcile(opts: { days?: number } = {}): Promise<ReconcileReport> {
    const resource: SyncResource = 'reconcile'
    const state = (await this.d.state.get(resource)) ?? freshState(resource)
    const zero = () => ({ seen: 0, inserted: 0, updated: 0, unchanged: 0, stale: 0 })
    const report: ReconcileReport = {
      status: 'ok',
      complete: false,
      requests: 0,
      orders: zero(),
      transactions: zero(),
    }
    if (state.status === 'dead_letter') return { ...report, status: 'skipped' }
    const now = this.d.clock.now()
    state.lastRunAt = now
    const resumed =
      state.status === 'partial' &&
      state.windowStart !== undefined &&
      state.phase !== undefined &&
      state.watermark !== undefined
    const days = opts.days ?? this.cfg.reconcileDays
    const windowStart =
      resumed && state.windowStart ? state.windowStart : new Date(now.getTime() - days * DAY)
    const windowEnd = resumed && state.watermark ? state.watermark : now
    let phase: 'orders' | 'transactions' = resumed && state.phase ? state.phase : 'orders'
    let chunk: InFlightWindow =
      resumed && state.inFlight ? state.inFlight : this.windowFrom(windowStart, windowEnd)
    report.windowStart = windowStart
    report.windowEnd = windowEnd
    const seenOrders = new Set<string>()
    const stats = emptyStats()
    // An item is the same item whoever reads it: the reconcile records and clears errors under the poll's resource names, so a
    // dead letter the poll gave up on is closed when the reconcile finally stores the item.
    const known = { orders: await this.knownErrorKeys('orders'), transactions: await this.knownErrorKeys('transactions') }
    const save = async (patch: Partial<SyncState>): Promise<void> => {
      Object.assign(state, { phase, windowStart, watermark: windowEnd }, patch)
      await this.d.state.save(state)
    }
    try {
      for (;;) {
        if (stats.requests >= this.cfg.reconcileMaxRequests) {
          await save({ inFlight: chunk, status: 'partial' })
          return { ...report, status: 'partial', requests: stats.requests }
        }
        const s = emptyStats()
        let next: string | undefined
        if (phase === 'orders') {
          const page = await this.d.source.listOrders({
            modifiedAfter: chunk.from,
            modifiedBefore: chunk.to,
            cursor: chunk.cursor,
          })
          stats.requests++
          await this.handlePage<SqspOrder>(
            'orders',
            page,
            (o) => o.id,
            (o) => {
              seenOrders.add(o.id)
              return this.storeOrder(o, s)
            },
            s,
            known.orders,
          )
          accumulate(report.orders, s)
          next = page.nextCursor
        } else {
          const page = await this.d.source.listTransactions({
            modifiedAfter: chunk.from,
            modifiedBefore: chunk.to,
            cursor: chunk.cursor,
          })
          stats.requests++
          await this.handlePage<SqspTransaction>(
            'transactions',
            page,
            (t) => t.id,
            (t) => this.storeTransaction(t),
            s,
            known.transactions,
          )
          accumulate(report.transactions, s)
          next = page.nextCursor
        }
        this.failIfIncomplete(s)
        if (next) {
          chunk = { ...chunk, cursor: next }
        } else if (chunk.to.getTime() < windowEnd.getTime()) {
          chunk = this.windowFrom(new Date(chunk.to.getTime() - this.cfg.overlapMs), windowEnd)
        } else if (phase === 'orders') {
          phase = 'transactions'
          chunk = this.windowFrom(windowStart, windowEnd)
        } else {
          break
        }
      }
      if (!resumed) {
        const stored = await this.d.orders.listModifiedBetween(windowStart, windowEnd)
        report.missingRemoteOrderIds = stored
          .filter((r) => !seenOrders.has(r.order.id))
          .map((r) => r.order.id)
      }
      Object.assign(state, {
        phase: undefined,
        windowStart: undefined,
        watermark: undefined,
        inFlight: undefined,
      })
      await this.finishOk(state, now, stats, resource)
      return { ...report, complete: true, requests: stats.requests }
    } catch (e) {
      const keep = e instanceof ChunkIncomplete ? undefined : chunk
      const r = await this.finishError(state, stats, resource, e, keep)
      await save({})
      return {
        ...report,
        status: r.status === 'dead_letter' ? 'dead_letter' : 'error',
        requests: stats.requests,
        error: r.error,
      }
    }
  }

  /** Clear a dead-lettered resource so the next run polls again (ops action). */
  async resume(resource: SyncResource): Promise<void> {
    const state = await this.d.state.get(resource)
    if (!state) return
    state.status = 'idle'
    state.consecutiveFailures = 0
    state.lastError = undefined
    await this.d.state.save(state)
  }

  async health(opts: { maxLagMs?: number } = {}): Promise<SyncHealth> {
    const now = this.d.clock.now().getTime()
    const maxLag = opts.maxLagMs ?? 10 * MINUTE
    const resources: SyncHealth['resources'] = {}
    let ok = true
    for (const r of ['orders', 'transactions'] as const) {
      const s = await this.d.state.get(r)
      if (!s) {
        resources[r] = { status: 'never_run', consecutiveFailures: 0 }
        ok = false
        continue
      }
      const lagMs = s.lastSuccessAt ? now - s.lastSuccessAt.getTime() : undefined
      resources[r] = {
        status: s.status,
        lastSuccessAt: s.lastSuccessAt,
        lagMs,
        consecutiveFailures: s.consecutiveFailures,
        lastError: s.lastError,
      }
      if (s.status === 'dead_letter' || s.status === 'error' || lagMs === undefined || lagMs > maxLag)
        ok = false
    }
    return { ok, resources, deadLetteredItems: (await this.d.errors.list()).length }
  }

  // ---- internals ----

  private async pollWindows<T>(
    resource: 'orders' | 'transactions',
    fetchPage: (w: InFlightWindow) => Promise<Page<T>>,
    keyOf: (item: T) => string,
    store: (item: T, stats: RunStats) => Promise<UpsertOutcome>,
  ): Promise<RunResult> {
    const stats = emptyStats()
    const state = (await this.d.state.get(resource)) ?? freshState(resource)
    if (state.status === 'dead_letter') return { ...stats, resource, status: 'skipped' }
    const now = this.d.clock.now()
    state.lastRunAt = now
    const known = await this.knownErrorKeys(resource)
    let window: InFlightWindow = state.inFlight ?? this.nextWindow(state, now)
    const first = window
    try {
      for (;;) {
        for (;;) {
          if (stats.requests >= this.cfg.maxRequestsPerRun) {
            state.inFlight = window
            state.status = 'partial'
            await this.d.state.save(state)
            return { ...stats, resource, status: 'partial', windowFrom: first.from, windowTo: window.to }
          }
          const page = await fetchPage(window)
          stats.requests++
          stats.pages++
          await this.handlePage(resource, page, keyOf, (item) => store(item, stats), stats, known)
          if (!page.nextCursor) break
          window = { ...window, cursor: page.nextCursor }
        }
        this.failIfIncomplete(stats)
        state.watermark = window.to
        state.inFlight = undefined
        await this.d.state.save(state)
        if (window.to.getTime() >= now.getTime()) break
        window = this.nextWindow(state, now)
      }
      return {
        ...(await this.finishOk(state, now, stats, resource)),
        windowFrom: first.from,
        windowTo: window.to,
      }
    } catch (e) {
      const resumeAt =
        e instanceof ChunkIncomplete || (statusOf(e) === 400 && window.cursor) ? undefined : window
      return {
        ...(await this.finishError(state, stats, resource, e, resumeAt)),
        windowFrom: first.from,
        windowTo: window.to,
      }
    }
  }

  private nextWindow(state: SyncState, now: Date): InFlightWindow {
    const base = state.watermark ?? new Date(now.getTime() - this.cfg.initialLookbackMs)
    return this.windowFrom(new Date(base.getTime() - this.cfg.overlapMs), now)
  }

  /** A window starting at `from`, at most maxWindowMs long, never beyond `end`. */
  private windowFrom(from: Date, end: Date): InFlightWindow {
    return { from, to: new Date(Math.min(end.getTime(), from.getTime() + this.cfg.maxWindowMs)) }
  }

  private async handlePage<T>(
    resource: SyncResource,
    page: Page<T>,
    keyOf: (item: T) => string,
    store: (item: T) => Promise<UpsertOutcome>,
    stats: RunStats,
    known: Set<string>,
  ): Promise<void> {
    const now = this.d.clock.now()
    for (const r of page.rejected ?? []) {
      stats.rejected++
      await this.d.errors.record({
        resource,
        key: r.id ?? '(unknown id)',
        kind: 'mapping',
        message: r.reason,
        raw: r.raw,
        at: now,
      })
    }
    for (const item of page.items) {
      const key = keyOf(item)
      stats.seen++
      try {
        const outcome = await store(item)
        stats[outcome]++
        if (known.has(key)) {
          known.delete(key)
          await this.d.errors.clear(resource, key)
        }
      } catch (e) {
        const { attempts } = await this.d.errors.record({
          resource,
          key,
          kind: 'persist',
          message: describe(e),
          at: now,
        })
        if (attempts >= this.cfg.maxItemAttempts) stats.deadLettered++
        else stats.failed++
      }
    }
  }

  private failIfIncomplete(stats: RunStats): void {
    if (stats.failed > 0) throw new ChunkIncomplete(`${stats.failed} item(s) failed to persist`)
  }

  private async storeOrder(o: SqspOrder, stats: RunStats): Promise<UpsertOutcome> {
    const now = this.d.clock.now()
    const ignore = o.testMode && !this.cfg.includeTestMode
    if (ignore) stats.ignoredTestMode++
    return this.d.orders.upsert(o, {
      now,
      initial: ignore ? { matchState: 'ignored', ignoreReason: 'test_mode' } : { matchState: 'unmatched' },
    })
  }

  private async storeTransaction(t: SqspTransaction): Promise<UpsertOutcome> {
    const now = this.d.clock.now()
    let initial: { state: 'new' | 'ignored'; ignoreReason?: string } = { state: 'new' }
    if (!t.orderId)
      initial = { state: 'ignored', ignoreReason: 'no_order' } // donations have no salesOrderId
    else if (!this.cfg.includeTestMode) {
      const order = await this.d.orders.get(t.orderId)
      if (order?.ignoreReason === 'test_mode') initial = { state: 'ignored', ignoreReason: 'test_mode' }
    }
    return this.d.transactions.upsert(t, { now, initial })
  }

  private async knownErrorKeys(resource: SyncResource): Promise<Set<string>> {
    return new Set((await this.d.errors.list(resource)).map((e) => e.key))
  }

  private async finishOk(
    state: SyncState,
    now: Date,
    stats: RunStats,
    resource: SyncResource,
  ): Promise<RunResult> {
    state.status = 'ok'
    state.lastSuccessAt = now
    state.lastError = undefined
    state.consecutiveFailures = 0
    await this.d.state.save(state)
    return { ...stats, resource, status: 'ok' }
  }

  private async finishError(
    state: SyncState,
    stats: RunStats,
    resource: SyncResource,
    e: unknown,
    resumeAt: InFlightWindow | undefined,
  ): Promise<RunResult> {
    state.consecutiveFailures++
    state.lastError = describe(e)
    state.inFlight = resumeAt
    state.status = state.consecutiveFailures >= this.cfg.deadLetterAfterFailures ? 'dead_letter' : 'error'
    await this.d.state.save(state)
    return { ...stats, resource, status: state.status, error: state.lastError }
  }
}

function accumulate(
  into: Pick<RunStats, 'seen' | 'inserted' | 'updated' | 'unchanged' | 'stale'>,
  from: RunStats,
): void {
  into.seen += from.seen
  into.inserted += from.inserted
  into.updated += from.updated
  into.unchanged += from.unchanged
  into.stale += from.stale
}
