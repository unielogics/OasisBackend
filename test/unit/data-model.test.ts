// docs/data-model.md cannot go stale (gap 6). Chain: migrations -> db/schema.sql (test/integration/seeds-cli.test.ts and the live
// comparison below) -> the generated schema reference of the document (compared here) -> the hand-written sections, which must name
// every table and every migration and nothing that does not exist.
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { sql } from 'kysely'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSchema, renderReference } from '../../scripts/data-model-lib.js'
import { createTestDb, type TestDb } from '../helpers/db.js'

const root = path.resolve(import.meta.dirname, '../..')
const doc = readFileSync(path.join(root, 'docs/data-model.md'), 'utf8')
const START = '<!-- schema-reference:start -->'
const END = '<!-- schema-reference:end -->'
const schema = parseSchema(readFileSync(path.join(root, 'db/schema.sql'), 'utf8'))
const narrative = doc.slice(0, doc.indexOf(START))

/** Table names in the first cell of a row of the hand-written sections: | `name` | ... */
const documentedTables = (): Set<string> =>
  new Set([...narrative.matchAll(/^\| `([a-z_][a-z0-9_]*)`\s*\|/gm)].map((m) => m[1]!))

describe('docs/data-model.md', () => {
  let t: TestDb
  beforeAll(async () => {
    t = await createTestDb({})
  })
  afterAll(async () => {
    await t?.close()
  })

  it('names every table of the schema in its hand-written sections, and no table that does not exist', () => {
    const real = new Set(schema.tables.map((x) => x.name))
    const documented = documentedTables()
    expect([...real].filter((x) => !documented.has(x)).sort(), 'tables missing from the document').toEqual([])
    // rows of the "Foreign keys" and column tables name columns (table.column) and are not table rows
    const phantom = [...documented].filter((x) => !real.has(x))
    expect(phantom.sort(), 'documented tables that do not exist').toEqual([])
  })

  it('lists every migration file in its migration table', () => {
    const files = readdirSync(path.join(root, 'db/migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort()
    const listed = [...narrative.matchAll(/^\| `(\d{14}_[a-z0-9_]+\.sql)`/gm)].map((m) => m[1]!)
    expect(listed.sort()).toEqual(files)
  })

  it('its generated schema reference is exactly what db/schema.sql renders to (run pnpm data-model)', () => {
    const a = doc.indexOf(START)
    const b = doc.indexOf(END)
    expect(a).toBeGreaterThan(0)
    expect(doc.slice(a + START.length, b).trim()).toBe(renderReference(schema).trim())
  })

  it('db/schema.sql has the tables and columns of the live migrated database (so the reference describes what runs)', async () => {
    const live = await sql<{ table_name: string; column_name: string }>`
      select table_name, column_name from information_schema.columns
      where table_schema = current_schema()
        and table_name in (select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE')
      order by table_name, ordinal_position`.execute(t.db)
    const fromLive = new Map<string, string[]>()
    for (const r of live.rows)
      fromLive.set(r.table_name, [...(fromLive.get(r.table_name) ?? []), r.column_name])
    const fromDump = new Map(schema.tables.map((x) => [x.name, x.columns.map((c) => c.name)]))
    expect([...fromLive.keys()].sort()).toEqual([...fromDump.keys()].sort())
    for (const [name, columns] of fromLive) expect(fromDump.get(name), name).toEqual(columns)
  })

  it('pnpm data-model:check agrees', () => {
    const out = execFileSync('pnpm', ['--silent', 'data-model:check'], { cwd: root, encoding: 'utf8' })
    expect(out).toContain('up to date')
  })
})
