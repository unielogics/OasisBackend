// pnpm staff-events:backfill [--url <db url>] [--location <id>]
// Once, after the release that brings the Team activity report (ADR 0180): rebuilds the staff events of everything recorded before it
// (src/modules/kiosk/backfill.ts). Running it again adds nothing.
import { existsSync } from 'node:fs'
import { applySecretEnvironment } from '../src/config/secrets-source.js'
import { backfillStaffEvents } from '../src/modules/kiosk/backfill.js'
import { createClock } from '../src/platform/clock.js'
import { createDb } from '../src/platform/db.js'

if (existsSync('.env')) process.loadEnvFile('.env')

const args = process.argv.slice(2).filter((a) => a !== '--')
const flag = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)

async function main(): Promise<void> {
  // DATABASE_URL may live in the Secrets Manager secret (OASIS_SECRET_ID); --url does not need it
  if (!flag('--url')) await applySecretEnvironment()
  const url = flag('--url') ?? process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set (or pass --url)')
  const db = createDb({
    url,
    searchPath: process.env.DB_SEARCH_PATH,
    clock: createClock(process.env.CLOCK_FREEZE_AT),
    poolMax: 2,
    applicationName: 'oasis-staff-events-backfill',
  })
  try {
    const location = flag('--location')
    await backfillStaffEvents(db, { ...(location ? { locationId: location } : {}), log: (l) => console.log(l) })
  } finally {
    await db.destroy()
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
})
