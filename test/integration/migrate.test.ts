import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { FixedClock } from '../../src/platform/clock.js'
import { createDb, type Db } from '../../src/platform/db.js'
import {
  DEFAULT_MIGRATIONS_DIR,
  loadMigrationFiles,
  migrateUp,
  migrationStatus,
} from '../../src/platform/migrate.js'
import { dropSchema, schemaPrefix } from '../helpers/db.js'
import { testDatabaseUrl } from '../helpers/env.js'

const url = testDatabaseUrl()
const clock = new FixedClock('2026-06-13T14:36:00Z')
const schemas: string[] = []
let admin: Db

const freshSchema = async (name: string): Promise<string> => {
  const schema = `${schemaPrefix}_mig_${name}`
  schemas.push(schema)
  await dropSchema(admin, schema)
  return schema
}
const tables = async (schema: string): Promise<string[]> =>
  (
    await sql<{
      t: string
    }>`select tablename as t from pg_tables where schemaname = ${schema} order by 1`.execute(admin)
  ).rows.map((r) => r.t)

beforeAll(() => {
  admin = createDb({ url, poolMax: 2 })
})
afterAll(async () => {
  for (const s of schemas) await dropSchema(admin, s)
  await admin.destroy()
})

describe('migration runner', () => {
  it('applies every migration to an empty schema and is idempotent', async () => {
    const schema = await freshSchema('empty')
    const first = await migrateUp({ url }, { schema, clock })
    const names = loadMigrationFiles().map((f) => f.name)
    expect(first.applied).toEqual(names)
    expect(await tables(schema)).toEqual(
      expect.arrayContaining([
        'locations',
        'settings',
        'idempotency_keys',
        'realtime_events',
        'audit_log',
        'webhook_log',
        'notifications',
        'schema_migrations',
      ]),
    )

    const second = await migrateUp({ url }, { schema, clock })
    expect(second.applied).toEqual([])
    const status = await migrationStatus({ url }, { schema })
    expect(status.pending).toEqual([])
    expect(status.drifted).toEqual([])
    expect(status.applied.map((a) => a.name)).toEqual(names)
    expect(status.applied[0]?.appliedAt.toISOString()).toBe('2026-06-13T14:36:00.000Z')
  })

  it('serialises concurrent runners with the advisory lock (applied exactly once)', async () => {
    const schema = await freshSchema('race')
    const runs = await Promise.all([1, 2, 3, 4].map(() => migrateUp({ url }, { schema, clock })))
    const appliedCounts = runs.map((r) => r.applied.length)
    expect(appliedCounts.filter((n) => n > 0)).toHaveLength(1)
    const rows = await sql<{
      n: number
    }>`select count(*)::int as n from ${sql.id(schema, 'schema_migrations')}`.execute(admin)
    expect(rows.rows[0]?.n).toBe(loadMigrationFiles().length)
  })

  describe('with a scratch migrations directory', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oasis-mig-'))
    const base = readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, loadMigrationFiles()[0]!.name), 'utf8')
    const put = (name: string, body: string): void => writeFileSync(path.join(dir, name), body)
    put('20261006130000_platform_core.sql', base)

    it('rolls a failing migration back completely and records nothing', async () => {
      const schema = await freshSchema('fail')
      put('20261007000000_bad.sql', 'create table partial_one (id int);\nselect 1/0;')
      await expect(migrateUp({ url }, { schema, clock, dir })).rejects.toThrow(
        /20261007000000_bad\.sql failed/,
      )
      expect(await tables(schema)).not.toContain('partial_one')
      const status = await migrationStatus({ url }, { schema, dir })
      expect(status.pending).toEqual(['20261007000000_bad.sql'])
      expect(status.applied.map((a) => a.name)).toEqual(['20261006130000_platform_core.sql'])
    })

    it('refuses to run when an applied migration was edited', async () => {
      const schema = await freshSchema('drift')
      put('20261007000000_bad.sql', 'create table drift_ok (id int);')
      await migrateUp({ url }, { schema, clock, dir })
      put('20261007000000_bad.sql', 'create table drift_ok (id int, extra int);')
      await expect(migrateUp({ url }, { schema, clock, dir })).rejects.toThrow(/edited after the fact/)
      expect((await migrationStatus({ url }, { schema, dir })).drifted).toEqual(['20261007000000_bad.sql'])
    })

    it('applies a migration that sorts before the last applied one, with a warning', async () => {
      const schema = await freshSchema('order')
      put('20261007000000_bad.sql', 'create table order_b (id int);')
      await migrateUp({ url }, { schema, clock, dir })
      put('20261006140000_late_arrival.sql', 'create table order_a (id int);')
      const log: string[] = []
      const r = await migrateUp({ url }, { schema, clock, dir, log: (l) => log.push(l) })
      expect(r.applied).toEqual(['20261006140000_late_arrival.sql'])
      expect(log.some((l) => /sorts before the last applied/.test(l))).toBe(true)
    })

    it('rejects badly named files', () => {
      put('0002_oops.sql', 'select 1;')
      expect(() => loadMigrationFiles(dir)).toThrow(/Bad migration file name/)
    })
  })

  it('supports a single-statement no-transaction migration', async () => {
    const schema = await freshSchema('notx')
    const dir = mkdtempSync(path.join(tmpdir(), 'oasis-mig-notx-'))
    writeFileSync(path.join(dir, '20261006130000_t.sql'), 'create table t (id int);')
    writeFileSync(
      path.join(dir, '20261006140000_idx.sql'),
      '-- migrate:no-transaction\ncreate index concurrently t_id_idx on t (id);',
    )
    const r = await migrateUp({ url }, { schema, clock, dir })
    expect(r.applied).toHaveLength(2)
    const idx = await sql<{
      n: number
    }>`select count(*)::int as n from pg_indexes where schemaname = ${schema} and indexname = 't_id_idx'`.execute(
      admin,
    )
    expect(idx.rows[0]?.n).toBe(1)
  })
})
