// Per-worker isolation on a shared Postgres server. The oasis role has no CREATEDB, so instead of cloning a template
// database each worker owns a schema (t_<worktree hash>_<worker id>) migrated with the real runner and reused between
// runs while the migration checksums still match. Schemas never collide across git worktrees or concurrent agents.
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { sql } from 'kysely'
import { FixedClock, type Clock } from '../../src/platform/clock.js'
import { createDb, type Db, type DbOptions } from '../../src/platform/db.js'
import { migrateUp } from '../../src/platform/migrate.js'
import { testDatabaseUrl } from './env.js'

export const worktreeHash = createHash('sha1').update(process.cwd()).digest('hex').slice(0, 8)
export const schemaPrefix = `t_${worktreeHash}`
export const workerSchema = (suffix = process.env.VITEST_POOL_ID ?? '0'): string =>
  `${schemaPrefix}_${suffix}`

export interface TestDb {
  db: Db
  schema: string
  /** Connection settings for services that open their own connection (hub, migrate, jobs). */
  connection: DbOptions
  clock: Clock
  close(): Promise<void>
}

export async function dropSchema(db: Db, schema: string): Promise<void> {
  await sql`drop schema if exists ${sql.id(schema)} cascade`.execute(db)
}

/**
 * Migrates the schema; if that fails (a migration was edited during development, or an earlier run was killed midway
 * and left the schema inconsistent) the schema is dropped and rebuilt once before giving up.
 */
export async function prepareSchema(schema: string, clock: Clock): Promise<void> {
  const url = testDatabaseUrl()
  try {
    await migrateUp({ url }, { schema, clock })
  } catch {
    const admin = createDb({ url, poolMax: 1 })
    try {
      await dropSchema(admin, schema)
    } finally {
      await admin.destroy()
    }
    await migrateUp({ url }, { schema, clock })
  }
}

export async function createTestDb(
  o: { schema?: string; clock?: Clock; poolMax?: number } = {},
): Promise<TestDb> {
  const schema = o.schema ?? workerSchema()
  const clock = o.clock ?? new FixedClock('2026-06-13T10:36:00-04:00')
  await prepareSchema(schema, clock)
  const connection: DbOptions = {
    url: testDatabaseUrl(),
    searchPath: `${schema},public`,
    clock,
    poolMax: o.poolMax ?? 4,
    applicationName: 'oasis-test',
  }
  const db = createDb(connection)
  return { db, schema, connection, clock, close: () => db.destroy() }
}

/** Empties every table in the worker schema (except schema_migrations) and restarts identities. */
export async function truncateAll(db: Db, except: readonly string[] = []): Promise<void> {
  const r = await sql<{ tablename: string }>`
    select tablename from pg_tables where schemaname = current_schema() and tablename <> 'schema_migrations'`.execute(
    db,
  )
  const tables = r.rows.map((x) => x.tablename).filter((t) => !except.includes(t))
  if (tables.length === 0) return
  await sql`truncate table ${sql.join(tables.map((t) => sql.id(t)))} restart identity cascade`.execute(db)
}

/**
 * Registers vitest lifecycle hooks: migrates the worker schema once per file, truncates before each test and closes the
 * pool afterwards. Returns a handle whose members are valid inside tests.
 */
export function useTestDb(o: { clock?: Clock; truncate?: boolean; poolMax?: number } = {}): TestDb {
  let current: TestDb | undefined
  let startedAt: Date | undefined
  const get = (): TestDb => {
    if (!current) throw new Error('useTestDb handle used outside a test')
    return current
  }
  beforeAll(async () => {
    current = await createTestDb({ clock: o.clock, poolMax: o.poolMax })
    startedAt = current.clock.now()
  })
  beforeEach(async () => {
    if (current?.clock instanceof FixedClock && startedAt) current.clock.set(startedAt) // tests may move the clock
    if (o.truncate !== false) await truncateAll(get().db)
  })
  afterAll(async () => {
    await current?.close()
    current = undefined
  })
  return {
    get db() {
      return get().db
    },
    get schema() {
      return get().schema
    },
    get connection() {
      return get().connection
    },
    get clock() {
      return get().clock
    },
    close: () => get().close(),
  }
}
