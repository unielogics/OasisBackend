// Assembles the Squarespace read side for one location over Postgres: the HTTP client (or an injected source), the sync engine,
// the match runner over the real ledger, the product map and the connection. Jobs, routes and tests all build parts through
// here. Nothing in this file reads the wall clock or opens a socket by itself: time comes from the Clock, waiting from the
// Sleeper, HTTP from fetch, so the whole read side runs against the simulator under a frozen clock.
import { createHash } from 'node:crypto'
import type { Env } from '../../../config/env.js'
import { SquarespaceClient } from '../../../integrations/squarespace/client.js'
import { SlidingWindowLimiter } from '../../../integrations/squarespace/limiter.js'
import { systemSleeper, type Sleeper } from '../../../integrations/squarespace/sleeper.js'
import type { SquarespaceEnv } from '../../../integrations/squarespace/config.js'
import type { SquarespaceSource } from '../../../integrations/ports/squarespace.js'
import type { Clock } from '../../../platform/clock.js'
import type { Db } from '../../../platform/db.js'
import type { NewId } from '../../../platform/ids.js'
import { paymentsSyncConfigFromEnv } from '../config.js'
import { MatchRunner, type MatchRunReport } from '../match-runner.js'
import type { MatcherConfig } from '../matcher.js'
import type { ProductMap } from '../product-map.js'
import { SyncEngine, type RunResult, type SyncConfig } from '../sync.js'
import { PgAlertSink, raiseAlert, resolveAlerts } from './alerts.js'
import { ConnectionStore } from './connection.js'
import { linkContacts, type LinkResult } from './links.js'
import { PgLedger } from './ledger.js'
import { requeueManual } from './manual.js'
import { buildProductMap } from './product-map.js'
import {
  PgContactRepository,
  PgOrderRepository,
  PgSyncErrorRepository,
  PgSyncStateRepository,
  PgTransactionRepository,
} from './repositories.js'
import { createSecretBox, type SecretBox } from './secrets.js'

export const SIM_API_KEY = 'sim-api-key'
export const SIM_API_BASE = 'http://127.0.0.1:4590'
const REAL_API_BASE = 'https://api.squarespace.com'

export interface SqspRuntimeDeps {
  db: Db
  clock: Clock
  newId: NewId
  env: Env
  sleeper?: Sleeper
  fetch?: typeof fetch
  /** Test seam: builds the source for a key instead of the HTTP client. */
  sourceFactory?: (c: { locationId: string; apiKey: string }) => SquarespaceSource
}

export interface LocationParts {
  locationId: string
  source: SquarespaceSource
  productMap: ProductMap
  engine: SyncEngine
  runner: MatchRunner
  ledger: PgLedger
  repos: {
    orders: PgOrderRepository
    transactions: PgTransactionRepository
    contacts: PgContactRepository
    state: PgSyncStateRepository
    errors: PgSyncErrorRepository
  }
  matcher: Partial<MatcherConfig>
  sync: Partial<SyncConfig>
}

export interface SyncCycleResult {
  status: 'ok' | 'not_configured' | 'error'
  orders?: RunResult
  transactions?: RunResult
  match?: MatchRunReport
  /** At least one order was inserted or changed (the membership pass only needs to run then). */
  ordersChanged: boolean
  requeued?: number
}

export interface SyncOptions {
  /** Clear a dead-lettered resource before polling again. */
  resume?: boolean
  /** Give the matcher another chance at everything in the manual queue first. */
  rematch?: boolean
}

export class SqspRuntime {
  private readonly clients = new Map<string, SquarespaceClient>()

  constructor(readonly d: SqspRuntimeDeps) {}

  secrets(): SecretBox {
    const k = this.d.env.SECRETS_KEY
    if (!k) throw new Error('SECRETS_KEY is not configured')
    return createSecretBox([k])
  }

  connection(locationId: string): ConnectionStore {
    return new ConnectionStore(this.d.db, {
      locationId,
      clock: this.d.clock,
      newId: this.d.newId,
      secrets: () => this.secrets(),
    })
  }

  /** The key to call Squarespace with: the stored connection, else SQSP_API_KEY, else the simulator's key in sim mode. */
  async resolveKey(locationId: string): Promise<string | undefined> {
    if (this.d.env.SECRETS_KEY) {
      const stored = await this.connection(locationId).apiKey()
      if (stored) return stored
    }
    if (this.d.env.SQSP_API_KEY) return this.d.env.SQSP_API_KEY
    return this.d.env.SQSP_PROVIDER === 'sim' ? SIM_API_KEY : undefined
  }

  baseUrl(): string {
    const e = this.d.env
    return e.SQSP_PROVIDER === 'sim' && e.SQSP_API_BASE === REAL_API_BASE ? SIM_API_BASE : e.SQSP_API_BASE
  }

  /** One client per key, kept for the process lifetime so the request budget (sliding window) and 429 cool-downs are shared. */
  sourceFor(locationId: string, apiKey: string): SquarespaceSource {
    if (this.d.sourceFactory) return this.d.sourceFactory({ locationId, apiKey })
    const id = `${locationId}:${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}:${this.baseUrl()}`
    let c = this.clients.get(id)
    if (!c) {
      const sleeper = this.d.sleeper ?? systemSleeper
      c = new SquarespaceClient({
        auth: { kind: 'api_key', apiKey },
        clock: this.d.clock,
        sleeper,
        baseUrl: this.baseUrl(),
        userAgent: this.d.env.SQSP_USER_AGENT,
        fetch: this.d.fetch,
        limiter: new SlidingWindowLimiter(this.d.clock, sleeper, this.d.env.SQSP_REQUESTS_PER_MINUTE, 60_000),
      })
      this.clients.set(id, c)
    }
    return c
  }

  async partsFor(locationId: string): Promise<LocationParts | undefined> {
    const apiKey = await this.resolveKey(locationId)
    if (!apiKey) return undefined
    const { db, clock, newId, env } = this.d
    const source = this.sourceFor(locationId, apiKey)
    const cfg = paymentsSyncConfigFromEnv({ ...(env as unknown as SquarespaceEnv), SQSP_PRODUCT_MAP: undefined })
    const productMap = await buildProductMap(db, locationId, env.SQSP_PRODUCT_MAP)
    const now = () => clock.now()
    const repos = {
      orders: new PgOrderRepository({ db, locationId, newId, now }),
      transactions: new PgTransactionRepository({ db, locationId, newId, now }),
      contacts: new PgContactRepository({ db, locationId, newId, now }),
      state: new PgSyncStateRepository(db, locationId, now),
      errors: new PgSyncErrorRepository(db, locationId, newId, now),
    }
    const engine = new SyncEngine({ source, clock, ...repos }, cfg.sync)
    const ledger = new PgLedger(db, { locationId, clock, newId })
    const runner = new MatchRunner({
      orders: repos.orders,
      transactions: repos.transactions,
      ledger,
      alerts: new PgAlertSink(db, { locationId, newId, clock }),
      clock,
      productMap,
      config: cfg.matcher,
    })
    return { locationId, source, productMap, engine, runner, ledger, repos, matcher: cfg.matcher, sync: cfg.sync }
  }

  /** Orders then transactions, then the matcher; records connection health and raises sync alerts. */
  async syncCycle(locationId: string, opts: SyncOptions = {}): Promise<SyncCycleResult> {
    const parts = await this.partsFor(locationId)
    if (!parts) return { status: 'not_configured', ordersChanged: false }
    const { db, clock, newId } = this.d
    const alertDeps = { locationId, newId, clock }
    if (opts.resume) for (const r of ['orders', 'transactions', 'contacts', 'reconcile'] as const) await parts.engine.resume(r)
    const requeued = opts.rematch ? (await requeueManual(db, { locationId })).orders : undefined
    const cycle = await parts.engine.runCycle()
    const match = await parts.runner.run()
    if (parts.productMap.size > 0) await resolveAlerts(db, alertDeps, ['product_map_empty'])
    const conn = this.d.env.SECRETS_KEY ? this.connection(locationId) : undefined
    const bad = [cycle.orders, cycle.transactions].find((r) => r.status === 'error' || r.status === 'dead_letter')
    for (const r of [cycle.orders, cycle.transactions]) {
      if (r.status === 'dead_letter')
        await raiseAlert(db, alertDeps, {
          code: 'sync_dead_letter',
          subject: r.resource,
          message: `Squarespace ${r.resource} sync stopped after repeated failures: ${r.error ?? 'unknown error'}. Fix the cause, then press Sync now.`,
        })
    }
    if (bad) {
      const failing = [cycle.orders, cycle.transactions].map((r) => r.error).find(Boolean)
      const state = await parts.repos.state.get(bad.resource as 'orders' | 'transactions')
      if ((state?.consecutiveFailures ?? 0) >= 3)
        await raiseAlert(db, alertDeps, {
          code: 'sync_failing',
          subject: bad.resource,
          message: `Squarespace ${bad.resource} sync has failed ${state?.consecutiveFailures} times in a row: ${failing ?? 'unknown error'}`,
        })
      await conn?.setHealth('error', failing ?? 'sync failed')
    } else {
      await resolveAlerts(db, alertDeps, ['sync_dead_letter', 'sync_failing'])
      await conn?.setHealth('connected')
    }
    return {
      status: bad ? 'error' : 'ok',
      orders: cycle.orders,
      transactions: cycle.transactions,
      match,
      ordersChanged: cycle.orders.inserted + cycle.orders.updated > 0,
      requeued,
    }
  }

  /** Webhook path: fetch the order a notification names, store it (idempotent with the poll), then match. */
  async ingestOrder(locationId: string, orderId: string): Promise<{ match: MatchRunReport } | undefined> {
    const parts = await this.partsFor(locationId)
    if (!parts) return undefined
    await parts.engine.ingestOrder(orderId)
    return { match: await parts.runner.run() }
  }

  async syncContacts(locationId: string): Promise<{ run: RunResult; links: LinkResult } | undefined> {
    const parts = await this.partsFor(locationId)
    if (!parts) return undefined
    const run = await parts.engine.syncContacts()
    const links = await linkContacts(this.d.db, { locationId, clock: this.d.clock })
    return { run, links }
  }
}
