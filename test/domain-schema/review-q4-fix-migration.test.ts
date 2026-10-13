// 20261015100100_review_q4_fix.sql on top of existing data (sandbox run F1, review Q4 SQ-SEM-5-R1): the default tiers' inclusions
// nobody edited are turned to auto-apply, an inclusion of a tier saved in Settings or switched by hand keeps what it says; failed
// webhook rows start at one attempt.
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { FixedClock } from '../../src/platform/clock.js'
import { createDb, type Db } from '../../src/platform/db.js'
import { DEFAULT_MIGRATIONS_DIR, loadMigrationFiles, migrateUp } from '../../src/platform/migrate.js'
import { dropSchema, schemaPrefix } from '../helpers/db.js'
import { testDatabaseUrl } from '../helpers/env.js'

const url = testDatabaseUrl()
const clock = new FixedClock('2026-10-13T14:36:00Z')
const schema = `${schemaPrefix}_mig_q4fix`
const MIGRATION = '20261015100100_review_q4_fix.sql'
let admin: Db

beforeAll(async () => {
  admin = createDb({ url, poolMax: 2 })
  await dropSchema(admin, schema)
})
afterAll(async () => {
  await dropSchema(admin, schema)
  await admin.destroy()
})

const LOC = '00000000-0000-7000-8000-0000000000e1'
const id = (prefix: string, n: number): string => `00000000-0000-7000-8000-${prefix}${String(n).padStart(12 - prefix.length, '0')}`
const plan = (n: number) => id('4', n)
const inc = (n: number) => id('5', n)

describe('the review Q4 fix migration on top of existing data', () => {
  it('turns on auto-apply for unedited inclusions only, and counts one attempt for each failed webhook row', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oasis-mig-q4fix-'))
    for (const f of loadMigrationFiles().filter((x) => x.name < MIGRATION)) copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f.name), path.join(dir, f.name))
    await migrateUp({ url }, { schema, clock, dir })

    const db = createDb({ url, poolMax: 2, searchPath: `${schema},public` })
    try {
      await sql`insert into locations (id, name, slug) values (${LOC}, 'Oasis Auto Spa', 'oasis')`.execute(db)
      // gold: the default tier, never touched; vip: saved in Settings; essential: untouched tier, one inclusion switched off by hand
      for (const [n, key] of [[1, 'gold'], [2, 'vip'], [3, 'essential']] as const)
        await sql`insert into membership_plans (id, location_id, key, name, color, bg_color, tint) values (${plan(n)}, ${LOC}, ${key}, ${key}, '#000', '#fff', '#eee')`.execute(db)
      const rows: [number, number, boolean][] = [
        [1, 1, false], // gold, default: turned on
        [2, 1, false], // gold, default: turned on
        [3, 2, false], // vip, its tier was saved in Settings: kept
        [4, 3, false], // essential, switched off by hand: kept
        [5, 3, false], // essential, default: turned on
        [6, 3, true], // already on
      ]
      for (const [n, p, auto] of rows)
        await sql`insert into membership_inclusions (id, plan_id, label, auto_apply, sort) values (${inc(n)}, ${plan(p)}, ${`Inclusion ${n}`}, ${auto}, ${n})`.execute(db)
      await sql`insert into audit_log (location_id, action, entity_type, entity_id) values
        (${LOC}, 'catalog.tier.update', 'membership_plan', 'vip'),
        (${LOC}, 'membership.rule.update', 'membership_inclusion', ${inc(4)})`.execute(db)
      await sql`insert into webhook_log (id, provider, external_id, signature_valid, status) values
        (${id('a', 1)}, 'square', 'ev-failed', true, 'failed'), (${id('a', 2)}, 'square', 'ev-ok', true, 'processed')`.execute(db)

      copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION), path.join(dir, MIGRATION))
      await migrateUp({ url }, { schema, clock, dir })

      const after = await sql<{ id: string; auto_apply: boolean }>`select id, auto_apply from membership_inclusions order by sort`.execute(db)
      expect(after.rows.map((r) => r.auto_apply)).toEqual([true, true, false, false, true, true])
      const log = await sql<{ external_id: string; attempts: number }>`select external_id, attempts from webhook_log order by external_id`.execute(db)
      expect(log.rows).toEqual([
        { external_id: 'ev-failed', attempts: 1 },
        { external_id: 'ev-ok', attempts: 0 },
      ])
      const state = await sql<{ column_name: string }>`select column_name from information_schema.columns where table_schema = ${schema} and table_name = 'square_state' and column_name = 'connected_at'`.execute(db)
      expect(state.rows).toHaveLength(1)
    } finally {
      await db.destroy()
    }
  })
})
