import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { FixedClock } from '../../src/platform/clock.js'
import { createDb, type Db } from '../../src/platform/db.js'
import {
  DEFAULT_MIGRATIONS_DIR,
  isFullyMigrated,
  loadMigrationFiles,
  migrateUp,
  migrationStatus,
} from '../../src/platform/migrate.js'
import { dropSchema, schemaPrefix } from '../helpers/db.js'
import { testDatabaseUrl } from '../helpers/env.js'

const url = testDatabaseUrl()
const clock = new FixedClock('2026-06-13T14:36:00Z')
const schema = `${schemaPrefix}_mig_domain`
let admin: Db

beforeAll(async () => {
  admin = createDb({ url, poolMax: 2 })
  await dropSchema(admin, schema)
})
afterAll(async () => {
  await dropSchema(admin, schema)
  await admin.destroy()
})

describe('domain_core on top of platform_core', () => {
  it('applies cleanly to a database that already has platform data, keeps it, and is idempotent', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oasis-mig-'))
    copyFileSync(
      path.join(DEFAULT_MIGRATIONS_DIR, '20261006130000_platform_core.sql'),
      path.join(dir, '20261006130000_platform_core.sql'),
    )
    const base = await migrateUp({ url }, { schema, clock, dir })
    expect(base.applied).toEqual(['20261006130000_platform_core.sql'])

    const db = createDb({ url, poolMax: 2, searchPath: `${schema},public` })
    try {
      await sql`insert into locations (id, name, slug) values ('00000000-0000-7000-8000-0000000000b1', 'Oasis Auto Spa', 'oasis')`.execute(
        db,
      )
      await sql`insert into settings (location_id, key, value) values ('00000000-0000-7000-8000-0000000000b1', 'tax.rate_bp', '700')`.execute(
        db,
      )

      const files = loadMigrationFiles()
      const rest = files.map((f) => f.name).filter((n) => n > '20261006130000_platform_core.sql')
      expect(rest).toContain('20261006150000_domain_core.sql')
      const second = await migrateUp({ url }, { schema, clock })
      expect(second.applied).toEqual(rest)

      const status = await migrationStatus({ url }, { schema })
      expect(isFullyMigrated(status)).toBe(true)
      expect(status.pending).toEqual([])
      expect(await migrateUp({ url }, { schema, clock })).toEqual({ applied: [] })

      const loc = await sql<{ n: number }>`select count(*)::int as n from locations`.execute(db)
      const set = await sql<{ n: number }>`select count(*)::int as n from settings`.execute(db)
      expect([loc.rows[0]!.n, set.rows[0]!.n]).toEqual([1, 1])
      const domain = await sql<{
        n: number
      }>`select count(*)::int as n from pg_tables where schemaname = ${schema} and tablename in ('services', 'customers', 'appointments', 'closures', 'bays')`.execute(
        db,
      )
      expect(domain.rows[0]!.n).toBe(5)
    } finally {
      await db.destroy()
    }
  })
})
