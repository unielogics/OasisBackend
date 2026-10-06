// pnpm migrate up|status|new <name>
//   --test targets DATABASE_URL_TEST; --url <url> overrides; --schema <name> migrates a separate schema (scratch/test);
//   --dir <path> uses another migrations directory.
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createClock } from '../src/platform/clock.js'
import {
  DEFAULT_MIGRATIONS_DIR,
  isFullyMigrated,
  migrateUp,
  migrationStatus,
} from '../src/platform/migrate.js'

if (existsSync('.env')) process.loadEnvFile('.env')

const args = process.argv.slice(2)
const cmd = args[0]
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function targetUrl(): string {
  const url =
    flag('--url') ?? (args.includes('--test') ? process.env.DATABASE_URL_TEST : process.env.DATABASE_URL)
  if (!url) throw new Error('DATABASE_URL (or DATABASE_URL_TEST with --test) is not set')
  return url
}

async function main(): Promise<void> {
  const clock = createClock(process.env.CLOCK_FREEZE_AT)
  const opts = { schema: flag('--schema'), dir: flag('--dir') }
  if (cmd === 'up') {
    const r = await migrateUp(
      { url: targetUrl(), applicationName: 'oasis-migrate' },
      { clock, log: (l) => console.log(l), ...opts },
    )
    console.log(r.applied.length ? `${r.applied.length} migration(s) applied` : 'up to date')
  } else if (cmd === 'status') {
    const s = await migrationStatus({ url: targetUrl() }, opts)
    for (const a of s.applied)
      console.log(
        `  applied  ${a.name}${s.drifted.includes(a.name) ? '  (EDITED)' : ''}${s.missing.includes(a.name) ? '  (FILE MISSING)' : ''}`,
      )
    for (const p of s.pending) console.log(`  pending  ${p}`)
    if (!isFullyMigrated(s)) process.exitCode = 1
  } else if (cmd === 'new') {
    const name = (args[1] ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
    if (!name) throw new Error('usage: pnpm migrate new <name>')
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
    const file = path.join(opts.dir ?? DEFAULT_MIGRATIONS_DIR, `${stamp}_${name}.sql`)
    writeFileSync(
      file,
      `-- ${name.replace(/_/g, ' ')}\n-- Forward-only. Use app_now(), never now() or current_timestamp.\n\n`,
      { flag: 'wx' },
    )
    console.log(path.relative(process.cwd(), file))
  } else {
    console.error(
      'usage: pnpm migrate up|status|new <name> [--test] [--url <url>] [--schema <name>] [--dir <path>]',
    )
    process.exitCode = 2
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})
