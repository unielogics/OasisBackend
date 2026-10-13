// Migration 20261016200000 (ADR 0174) on top of existing roles and people: set.assistant is appended to the catalog (sort 28), every
// role that holds set.hours gets it (built-in or custom), a role without set.hours does not, and a person's own Allow or Deny
// exception for set.hours is copied to set.assistant: who may edit the assistant is exactly who could before.
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
const schema = `${schemaPrefix}_mig_set_assistant`
const MIGRATION = '20261016200000_assistant_set_permission.sql'
let admin: Db

beforeAll(async () => {
  admin = createDb({ url, poolMax: 2 })
  await dropSchema(admin, schema)
})
afterAll(async () => {
  await dropSchema(admin, schema)
  await admin.destroy()
})

const id = (n: number): string => `00000000-0000-7000-8000-0000000004${String(n).padStart(2, '0')}`

describe('migration 20261016200000: set.assistant', () => {
  it('is granted to every role holding set.hours and copies the set.hours exceptions', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oasis-mig-set-assistant-'))
    for (const f of loadMigrationFiles().filter((x) => x.name < MIGRATION)) copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f.name), path.join(dir, f.name))
    await migrateUp({ url }, { schema, clock, dir })

    const db = createDb({ url, poolMax: 2, searchPath: `${schema},public` })
    try {
      // roles: Management (set.hours), a custom "Shift Lead" with set.hours, Crew without it
      await sql`insert into roles (id, key, name, is_custom) values (${id(1)}, 'mgmt', 'Management', false), (${id(3)}, 'crew', 'Crew', false),
        (${id(2)}, null, 'Shift Lead', true)`.execute(db)
      await sql`insert into role_permissions (role_id, permission_key) values (${id(1)}, 'set.hours'), (${id(1)}, 'sched.view'),
        (${id(2)}, 'set.hours'), (${id(3)}, 'sched.view')`.execute(db)
      // people: one allowed set.hours by exception, one denied it, one with an unrelated exception
      await sql`insert into employees (id, first) values (${id(11)}, 'Ana'), (${id(12)}, 'Ben'), (${id(13)}, 'Cy')`.execute(db)
      await sql`insert into employee_permission_overrides (employee_id, permission_key, effect) values
        (${id(11)}, 'set.hours', 'allow'), (${id(12)}, 'set.hours', 'deny'), (${id(13)}, 'sched.override', 'allow')`.execute(db)

      await migrateUp({ url }, { schema, clock })

      const perm = await sql<{ key: string; module: string; label: string; has_limit: boolean; sort: number }>`
        select key, module, label, has_limit, sort from permissions where key = 'set.assistant'`.execute(db)
      expect(perm.rows).toEqual([{ key: 'set.assistant', module: 'Settings', label: 'Oasis AI assistant', has_limit: false, sort: 28 }])
      const max = await sql<{ max: number }>`select max(sort)::int as max from permissions`.execute(db)
      expect(max.rows[0]!.max).toBe(28)

      const roles = await sql<{ role_id: string }>`select role_id from role_permissions where permission_key = 'set.assistant' order by role_id`.execute(db)
      expect(roles.rows.map((r) => r.role_id)).toEqual([id(1), id(2)])

      const overrides = await sql<{ employee_id: string; effect: string }>`
        select employee_id, effect from employee_permission_overrides where permission_key = 'set.assistant' order by employee_id`.execute(db)
      expect(overrides.rows).toEqual([
        { employee_id: id(11), effect: 'allow' },
        { employee_id: id(12), effect: 'deny' },
      ])
    } finally {
      await db.destroy()
    }
  })
})
