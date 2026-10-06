// pnpm openapi [--check]: builds the app with inert dependencies, writes docs/openapi.json (stable key order) and
// refreshes the endpoint table in docs/api-spec.md. With --check it only compares and fails when either is stale.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildApp } from '../src/app.js'
import { loadEnv } from '../src/config/env.js'
import { describeAccess } from '../src/http/access.js'
import { createDenyAuthorizer } from '../src/http/authorizer.js'
import { FixedClock } from '../src/platform/clock.js'
import { createDb } from '../src/platform/db.js'

const check = process.argv.includes('--check')
const root = path.resolve(import.meta.dirname, '..')
const specFile = path.join(root, 'docs/openapi.json')
const mdFile = path.join(root, 'docs/api-spec.md')
const START = '<!-- openapi:start -->'
const END = '<!-- openapi:end -->'

const sortKeys = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, sortKeys(x)]),
    )
  }
  return v
}

async function main(): Promise<void> {
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://oasis:unused@127.0.0.1:1/oasis' })
  const db = createDb({ url: env.DATABASE_URL })
  const app = await buildApp({
    env,
    db,
    clock: new FixedClock('2026-06-13T10:36:00-04:00'),
    authorizer: createDenyAuthorizer(),
    logStream: { write: () => undefined },
  })
  const doc = JSON.stringify(sortKeys(app.swagger()), null, 2) + '\n'
  const rows = [...app.routeRegistry]
    .filter((r) => !['/healthz', '/readyz'].includes(r.url))
    .sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method))
    .map((r) => `| ${r.method} | \`${r.url}\` | ${describeAccess(r.access)} | ${r.idempotency ?? ''} |`)
  const table = [
    START,
    '| Method | Path | Access | Idempotency-Key |',
    '|---|---|---|---|',
    ...rows,
    END,
  ].join('\n')
  await app.close()
  await db.destroy()

  const md = existsSync(mdFile) ? readFileSync(mdFile, 'utf8') : ''
  const next = md.includes(START)
    ? md.replace(new RegExp(`${START}[\\s\\S]*?${END}`), table)
    : `${md}\n${table}\n`
  const stale = (existsSync(specFile) ? readFileSync(specFile, 'utf8') : '') !== doc || md !== next

  if (check) {
    if (stale) {
      console.error(
        'docs/openapi.json or docs/api-spec.md is out of date; run `pnpm openapi` and commit the result',
      )
      process.exitCode = 1
    } else console.log('openapi: up to date')
    return
  }
  writeFileSync(specFile, doc)
  writeFileSync(mdFile, next)
  console.log(`wrote docs/openapi.json (${rows.length} operations) and refreshed docs/api-spec.md`)
}

main().catch((e: unknown) => {
  console.error(e)
  process.exitCode = 1
})
