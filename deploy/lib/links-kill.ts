// Break-glass kill switch of the personal links (ADR 0160, W4c fixes): bumps the links epoch, so every personal link, every page
// opened from one and every 30-day phone trust end at their next use (a reply number in chat stops running too).
//   cd /opt/oasis/current/backend && sudo -u oasis env $(grep -v '^#' /etc/oasis/common.env | xargs) \
//     pnpm exec tsx deploy/lib/links-kill.ts --reason "lost tablet"
// (deploy/scripts/links-kill.sh wraps this.) The same as the owner's POST /api/v1/identity/links/kill; audited as
// identity.links.killed (actor "break-glass CLI"; the shell user is in the system log). No restart is needed.
import { loadRuntimeEnv } from '../../src/config/secrets-source.js'
import { killAllLinks, type LinksKilled } from '../../src/modules/identity/kill.js'
import { createClock } from '../../src/platform/clock.js'
import { createDb, transaction, type Db } from '../../src/platform/db.js'

export async function killLinks(db: Db, o: { reason: string }): Promise<LinksKilled & { locationId: string }> {
  const reason = o.reason.trim()
  if (reason.length < 3) throw new Error('Give a reason (--reason "..."): it is kept in the audit log.')
  return transaction(db, async (tx) => {
    const location = await tx.selectFrom('locations').select('id').orderBy('created_at').executeTakeFirstOrThrow()
    const r = await killAllLinks(tx, { locationId: location.id, reason, audit: { actor: { name: 'break-glass CLI' } } })
    return { ...r, locationId: location.id }
  })
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== '--')
  const i = argv.indexOf('--reason')
  const reason = i >= 0 ? (argv[i + 1] ?? '') : ''
  const env = await loadRuntimeEnv()
  const db = createDb({
    url: env.DATABASE_URL,
    searchPath: env.DB_SEARCH_PATH,
    clock: createClock(env.CLOCK_FREEZE_AT),
    poolMax: 2,
    applicationName: 'oasis-links-kill',
  })
  try {
    const r = await killLinks(db, { reason })
    console.log(`links epoch ${r.epochBefore} -> ${r.epoch}: every personal link, link page and phone trust issued before has ended.`)
  } finally {
    await db.destroy()
  }
}

if (process.argv[1]?.endsWith('links-kill.ts')) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
}
