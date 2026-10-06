import pg from 'pg'
import {
  CompiledQuery,
  Kysely,
  PostgresDialect,
  sql,
  type DatabaseConnection,
  type Driver,
  type Transaction,
  type TransactionSettings,
} from 'kysely'
import type { Clock } from './clock.js'
import type { Database } from './schema.js'

export type { Database } from './schema.js'
export type Db = Kysely<Database>
export type Tx = Transaction<Database>
/** Services accept either, so a caller can compose them inside its own transaction. */
export type Executor = Db | Tx

export interface DbOptions {
  url: string
  poolMax?: number
  /** Comma-separated search_path (test schemas use "t_ab12_0,public"). Production leaves it unset. */
  searchPath?: string
  /** A synthetic clock is mirrored into the oasis.now GUC so app_now() agrees with the injected Clock. */
  clock?: Clock
  statementTimeoutMs?: number
  applicationName?: string
}

const IDENT = /^[a-z_][a-z0-9_]*$/i

export function assertIdentifier(name: string): string {
  if (!IDENT.test(name) || name.length > 63) throw new Error(`Invalid SQL identifier: ${name}`)
  return name
}

function startupOptions(o: DbOptions): string {
  const opts = ['-c timezone=UTC', '-c idle_in_transaction_session_timeout=60000']
  if (o.statementTimeoutMs) opts.push(`-c statement_timeout=${Math.floor(o.statementTimeoutMs)}`)
  if (o.searchPath) {
    const path = o.searchPath.split(',').map((s) => assertIdentifier(s.trim()))
    opts.push(`-c search_path=${path.join(',')}`)
  }
  if (o.clock?.synthetic) opts.push(`-c oasis.now=${o.clock.now().toISOString()}`)
  return opts.join(' ')
}

const int8Safe = (v: string): number => {
  const n = Number(v)
  if (!Number.isSafeInteger(n)) throw new RangeError(`int8 value ${v} exceeds the safe integer range`)
  return n
}

// int8 (bigint sums, bigserial ids) parse to number; date stays 'YYYY-MM-DD' so business dates never shift by offset.
const typeParsers: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: 'text' | 'binary') => {
    if (oid === 20) return int8Safe
    if (oid === 1082) return (v: string) => v
    return pg.types.getTypeParser(oid, format as 'text')
  }) as pg.CustomTypesConfig['getTypeParser'],
}

export function pgConfig(o: DbOptions): pg.PoolConfig {
  return {
    connectionString: o.url,
    max: o.poolMax ?? 10,
    options: startupOptions(o),
    application_name: o.applicationName ?? 'oasis-api',
    types: typeParsers,
  }
}

class ClockSyncDriver implements Driver {
  constructor(
    private readonly inner: Driver,
    private readonly clock: Clock,
  ) {}
  init(): Promise<void> {
    return this.inner.init()
  }
  async acquireConnection(): Promise<DatabaseConnection> {
    const conn = await this.inner.acquireConnection()
    await conn.executeQuery(
      CompiledQuery.raw('select set_config($1, $2, false)', ['oasis.now', this.clock.now().toISOString()]),
    )
    return conn
  }
  beginTransaction(c: DatabaseConnection, s: TransactionSettings): Promise<void> {
    return this.inner.beginTransaction(c, s)
  }
  commitTransaction(c: DatabaseConnection): Promise<void> {
    return this.inner.commitTransaction(c)
  }
  rollbackTransaction(c: DatabaseConnection): Promise<void> {
    return this.inner.rollbackTransaction(c)
  }
  releaseConnection(c: DatabaseConnection): Promise<void> {
    return this.inner.releaseConnection(c)
  }
  destroy(): Promise<void> {
    return this.inner.destroy()
  }
}

class OasisDialect extends PostgresDialect {
  constructor(
    pool: pg.Pool,
    private readonly clock: Clock | undefined,
  ) {
    super({ pool })
  }
  override createDriver(): Driver {
    const driver = super.createDriver()
    return this.clock?.synthetic ? new ClockSyncDriver(driver, this.clock) : driver
  }
}

export function createDb(o: DbOptions): Db {
  const pool = new pg.Pool(pgConfig(o))
  pool.on('error', () => {
    // idle client errors (server restart) are surfaced by the next query; do not crash the process
  })
  return new Kysely<Database>({ dialect: new OasisDialect(pool, o.clock) })
}

export async function destroyDb(db: Db): Promise<void> {
  await db.destroy()
}

export type Isolation = 'read committed' | 'repeatable read' | 'serializable'

/** Runs fn in one transaction; every mutation (audit, realtime publish, idempotency record) shares it. */
export function transaction<T>(db: Db, fn: (tx: Tx) => Promise<T>, isolation?: Isolation): Promise<T> {
  const t = db.transaction()
  return (isolation ? t.setIsolationLevel(isolation) : t).execute(fn)
}

/** Transaction-scoped advisory lock keyed by a name (e.g. capacity checks per bay and day). */
export async function advisoryXactLock(tx: Tx, name: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${name}))`.execute(tx)
}

/**
 * A dedicated, non-pooled connection for LISTEN and session advisory locks. The caller owns it and must end() it.
 * It never goes through the pool, so pool exhaustion or PgBouncer-style recycling cannot drop subscriptions.
 */
export async function connectDedicated(o: DbOptions): Promise<pg.Client> {
  const cfg = pgConfig(o)
  const client = new pg.Client({
    connectionString: cfg.connectionString,
    options: cfg.options,
    application_name: `${cfg.application_name}-listen`,
    types: typeParsers,
    keepAlive: true,
  })
  await client.connect()
  return client
}

export async function currentSchema(db: Executor): Promise<string> {
  const r = await sql<{ s: string }>`select current_schema() as s`.execute(db)
  return r.rows[0]!.s
}
