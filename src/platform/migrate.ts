// Forward-only SQL migrations: db/migrations/<YYYYMMDDHHMMSS>_<name>.sql applied in lexical order, one transaction each,
// recorded in schema_migrations, guarded by an advisory lock so concurrent deploys serialise. Idempotent from an empty DB.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { systemClock, type Clock } from './clock.js'
import { sql } from 'kysely'
import { assertIdentifier, pgConfig, type DbOptions, type Executor } from './db.js'

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations', import.meta.url))

const NAME_RE = /^(\d{14})_([a-z0-9_]+)\.sql$/
const NO_TX = /^\s*--\s*migrate:no-transaction\b/

export interface MigrationFile {
  name: string
  checksum: string
  sql: string
  /** First line `-- migrate:no-transaction`: the file must hold a single statement (e.g. CREATE INDEX CONCURRENTLY). */
  noTransaction: boolean
}

export interface AppliedMigration {
  name: string
  checksum: string
  appliedAt: Date
}

export interface MigrationStatus {
  applied: AppliedMigration[]
  pending: string[]
  /** Applied but the file on disk changed since. Never silently re-run. */
  drifted: string[]
  /** Applied but no longer on disk. */
  missing: string[]
}

export interface MigrateOptions {
  dir?: string
  /** Create and migrate this schema instead of the search_path default (per-worker test schemas). */
  schema?: string
  clock?: Clock
  log?: (line: string) => void
}

const sha256 = (s: string): string => createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex')

export function loadMigrationFiles(dir: string = DEFAULT_MIGRATIONS_DIR): MigrationFile[] {
  const names = readdirSync(dir).filter((f) => f.endsWith('.sql'))
  for (const n of names) {
    if (!NAME_RE.test(n))
      throw new Error(`Bad migration file name "${n}" (expected YYYYMMDDHHMMSS_snake_name.sql)`)
  }
  names.sort()
  return names.map((name) => {
    const sql = readFileSync(path.join(dir, name), 'utf8')
    return { name, checksum: sha256(sql), sql, noTransaction: NO_TX.test(sql) }
  })
}

function clientFor(db: DbOptions, schema?: string): pg.Client {
  const cfg = pgConfig({ ...db, searchPath: schema ? `${assertIdentifier(schema)},public` : db.searchPath })
  return new pg.Client({
    connectionString: cfg.connectionString,
    options: cfg.options,
    application_name: 'oasis-migrate',
  })
}

async function ensureTable(c: pg.Client): Promise<void> {
  await c.query(`create table if not exists schema_migrations (
    name text primary key,
    checksum text not null,
    applied_at timestamptz not null
  )`)
}

async function readApplied(c: pg.Client): Promise<AppliedMigration[]> {
  const r = await c.query<{ name: string; checksum: string; applied_at: Date }>(
    'select name, checksum, applied_at from schema_migrations order by name',
  )
  return r.rows.map((x) => ({ name: x.name, checksum: x.checksum, appliedAt: x.applied_at }))
}

function diff(files: MigrationFile[], applied: AppliedMigration[]): MigrationStatus {
  const byName = new Map(files.map((f) => [f.name, f]))
  const done = new Set(applied.map((a) => a.name))
  return {
    applied,
    pending: files.filter((f) => !done.has(f.name)).map((f) => f.name),
    drifted: applied
      .filter((a) => byName.has(a.name) && byName.get(a.name)!.checksum !== a.checksum)
      .map((a) => a.name),
    missing: applied.filter((a) => !byName.has(a.name)).map((a) => a.name),
  }
}

async function withLock<T>(c: pg.Client, schema: string, fn: () => Promise<T>): Promise<T> {
  await c.query('select pg_advisory_lock(hashtext($1))', [`oasis:migrate:${schema}`])
  try {
    return await fn()
  } finally {
    await c
      .query('select pg_advisory_unlock(hashtext($1))', [`oasis:migrate:${schema}`])
      .catch(() => undefined)
  }
}

export async function migrationStatus(db: DbOptions, opts: MigrateOptions = {}): Promise<MigrationStatus> {
  const files = loadMigrationFiles(opts.dir)
  const c = clientFor(db, opts.schema)
  await c.connect()
  try {
    if (opts.schema) {
      const exists = await c.query('select 1 from pg_namespace where nspname = $1', [opts.schema])
      if (exists.rowCount === 0) return diff(files, [])
    }
    await ensureTable(c)
    return diff(files, await readApplied(c))
  } finally {
    await c.end()
  }
}

export async function migrateUp(db: DbOptions, opts: MigrateOptions = {}): Promise<{ applied: string[] }> {
  const log = opts.log ?? (() => undefined)
  const clock = opts.clock ?? systemClock
  const files = loadMigrationFiles(opts.dir)
  const c = clientFor(db, opts.schema)
  await c.connect()
  try {
    return await withLock(c, opts.schema ?? db.searchPath ?? 'default', async () => {
      if (opts.schema) await c.query(`create schema if not exists ${assertIdentifier(opts.schema)}`)
      await ensureTable(c)
      const status = diff(files, await readApplied(c))
      if (status.drifted.length) {
        throw new Error(
          `Applied migrations were edited after the fact: ${status.drifted.join(', ')}. Add a new migration instead.`,
        )
      }
      const last = status.applied.at(-1)?.name
      const applied: string[] = []
      for (const f of files.filter((x) => status.pending.includes(x.name))) {
        if (last && f.name < last)
          log(`warning: ${f.name} sorts before the last applied migration ${last}; applying out of order`)
        const record = (): Promise<unknown> =>
          c.query('insert into schema_migrations (name, checksum, applied_at) values ($1, $2, $3)', [
            f.name,
            f.checksum,
            clock.now(),
          ])
        try {
          if (f.noTransaction) {
            await c.query(f.sql)
            await record()
          } else {
            await c.query('begin')
            await c.query(f.sql)
            await record()
            await c.query('commit')
          }
        } catch (e) {
          if (!f.noTransaction) await c.query('rollback').catch(() => undefined)
          throw new Error(`Migration ${f.name} failed: ${(e as Error).message}`, { cause: e })
        }
        applied.push(f.name)
        log(`applied ${f.name}`)
      }
      return { applied }
    })
  } finally {
    await c.end()
  }
}

/** True when every migration on disk is applied and unchanged (used by /readyz). */
export function isFullyMigrated(status: MigrationStatus): boolean {
  return status.pending.length === 0 && status.drifted.length === 0
}

/** Same comparison as migrationStatus, through the application's own pool (used by /readyz). */
export async function migrationStatusFromDb(
  db: Executor,
  files: MigrationFile[] = loadMigrationFiles(),
): Promise<MigrationStatus> {
  const r = await sql<{ name: string; checksum: string; applied_at: Date }>`
    select name, checksum, applied_at from schema_migrations order by name`.execute(db)
  return diff(
    files,
    r.rows.map((x) => ({ name: x.name, checksum: x.checksum, appliedAt: x.applied_at })),
  )
}
