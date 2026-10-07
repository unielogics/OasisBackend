// pnpm data-model [--check]: regenerates the schema reference of docs/data-model.md (between the markers) from db/schema.sql, which
// pnpm db:schema derives from the migrations. The hand-written narrative above the marker lists every table; test/unit/data-model.test.ts
// fails when a table, a column or a migration is missing from the document, so it cannot go stale. With --check it only compares.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseSchema, renderReference } from './data-model-lib.js'

const root = path.resolve(import.meta.dirname, '..')
const docFile = path.join(root, 'docs/data-model.md')
const START = '<!-- schema-reference:start -->'
const END = '<!-- schema-reference:end -->'

const check = process.argv.includes('--check')
const schema = parseSchema(readFileSync(path.join(root, 'db/schema.sql'), 'utf8'))
const block = `${START}\n${renderReference(schema)}\n${END}`
const doc = existsSync(docFile) ? readFileSync(docFile, 'utf8') : ''
const a = doc.indexOf(START)
const b = doc.indexOf(END)
if (a < 0 || b < a) throw new Error(`docs/data-model.md needs the ${START} ... ${END} markers`)
const next = doc.slice(0, a) + block + doc.slice(b + END.length)
if (check) {
  if (next !== doc) {
    console.error(
      'docs/data-model.md schema reference is out of date; run `pnpm data-model` and commit the result',
    )
    process.exitCode = 1
  } else console.log('data-model: up to date')
} else {
  writeFileSync(docFile, next)
  console.log(`wrote docs/data-model.md (${schema.tables.length} tables)`)
}
