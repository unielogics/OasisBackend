// The AI foundation migrations (ADR 0160) on top of a database that already holds the shop's data: the default categories appear
// for the existing location, existing services get a category from their tags, and every appointment gets the categories of its
// package and live add-ons.
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { FixedClock } from '../../src/platform/clock.js'
import { createDb, type Db } from '../../src/platform/db.js'
import { DEFAULT_MIGRATIONS_DIR, loadMigrationFiles, migrateUp } from '../../src/platform/migrate.js'
import { DEFAULT_CATEGORIES } from '../../src/modules/catalog/categories.js'
import { dropSchema, schemaPrefix } from '../helpers/db.js'
import { testDatabaseUrl } from '../helpers/env.js'

const url = testDatabaseUrl()
const clock = new FixedClock('2026-10-10T14:36:00Z')
const schema = `${schemaPrefix}_mig_ai`
const FIRST = '20261011000000_catalog_categories.sql'
let admin: Db

beforeAll(async () => {
  admin = createDb({ url, poolMax: 2 })
  await dropSchema(admin, schema)
})
afterAll(async () => {
  await dropSchema(admin, schema)
  await admin.destroy()
})

const LOC = '00000000-0000-7000-8000-0000000000c1'
const CUST = '00000000-0000-7000-8000-0000000000c2'
const svc = (n: number): string => `00000000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`
const appt = (n: number): string => `00000000-0000-7000-8000-0000000002${String(n).padStart(2, '0')}`

describe('the AI foundation migrations on top of existing data', () => {
  it('seed the categories, categorise the services by tag and backfill appointments.categories', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oasis-mig-ai-'))
    const before = loadMigrationFiles().filter((f) => f.name < FIRST)
    for (const f of before) copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f.name), path.join(dir, f.name))
    await migrateUp({ url }, { schema, clock, dir })

    const db = createDb({ url, poolMax: 2, searchPath: `${schema},public` })
    try {
      await sql`insert into locations (id, name, slug) values (${LOC}, 'Oasis Auto Spa', 'oasis')`.execute(db)
      await sql`insert into customers (id, full_name) values (${CUST}, 'Maria Delgado')`.execute(db)
      const services: [number, string, string, string[]][] = [
        [1, 'package', 'Express Hand Wash', ['express', 'handwash']],
        [2, 'package', 'Full Detail', ['detail']],
        [3, 'package', 'Ceramic Maintenance + Wax', ['ceramic']],
        [4, 'package', 'Mystery Package', []],
        [5, 'addon', 'Wax', []],
        [6, 'addon', 'Clay bar', []],
      ]
      for (const [n, kind, name, tags] of services)
        await sql`insert into services (id, location_id, kind, name, price_cents, duration_min, tags)
          values (${svc(n)}, ${LOC}, ${kind}, ${name}, 4500, ${kind === 'addon' ? 0 : 60}, ${tags}::text[])`.execute(db)
      const start = (h: number): string => `2026-10-12T${String(h).padStart(2, '0')}:00:00Z`
      const appts: [number, number][] = [
        [1, 1], // a wash with a live add-on and a removed one
        [2, 2], // a detail
        [3, 4], // an uncategorised package
      ]
      for (const [n, s] of appts)
        await sql`insert into appointments (id, location_id, customer_id, service_id, package_name, price_cents, duration_min,
            scheduled_start, scheduled_end)
          values (${appt(n)}, ${LOC}, ${CUST}, ${svc(s)}, 'x', 4500, 60, ${start(12 + n)}, ${start(13 + n)})`.execute(db)
      await sql`insert into appointment_addons (id, appointment_id, service_id, name, price_cents)
        values ('00000000-0000-7000-8000-000000000301', ${appt(1)}, ${svc(5)}, 'Wax', 4000)`.execute(db)
      await sql`insert into appointment_addons (id, appointment_id, service_id, name, price_cents, removed_at)
        values ('00000000-0000-7000-8000-000000000302', ${appt(1)}, ${svc(6)}, 'Clay bar', 5000, ${start(11)})`.execute(db)

      const rest = await migrateUp({ url }, { schema, clock })
      expect(rest.applied[0]).toBe(FIRST)

      const cats = await sql<{ key: string; label: string; colour: string }>`
        select key, label, colour from catalog_categories where location_id = ${LOC} order by sort`.execute(db)
      expect(cats.rows).toEqual(DEFAULT_CATEGORIES.map((c) => ({ key: c.key, label: c.label, colour: c.colour })))

      const byService = await sql<{ id: string; category: string | null; vip_inclusion: string; visible_online: boolean }>`
        select id, category, vip_inclusion, visible_online from services order by id`.execute(db)
      expect(byService.rows.map((r) => r.category)).toEqual(['wash', 'detail', 'detail', null, 'addons', 'addons'])
      expect(byService.rows.every((r) => r.vip_inclusion === 'none' && r.visible_online)).toBe(true)

      const byAppt = await sql<{ id: string; categories: string[] }>`select id, categories from appointments order by id`.execute(db)
      expect(byAppt.rows.map((r) => r.categories)).toEqual([['wash', 'addons'], ['detail'], []])
    } finally {
      await db.destroy()
    }
  })
})
