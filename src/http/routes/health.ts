import { sql } from 'kysely'
import {
  isFullyMigrated,
  loadMigrationFiles,
  migrationStatusFromDb,
  type MigrationFile,
} from '../../platform/migrate.js'
import { access } from '../access.js'
import type { AppInstance } from '../types.js'

type Check = { ok: boolean; detail: string }

export function registerHealthRoutes(app: AppInstance): void {
  let files: MigrationFile[] | null = null
  try {
    files = loadMigrationFiles()
  } catch (e) {
    app.log.warn({ err: (e as Error).message }, 'migration files unavailable; /readyz will report unknown')
  }

  app.get(
    '/healthz',
    { config: { access: access.public('Liveness probe'), rateLimit: false }, schema: { hide: true } },
    async () => ({ status: 'ok' }),
  )

  app.get(
    '/readyz',
    {
      config: { access: access.public('Readiness probe for the proxy and uptime monitor'), rateLimit: false },
      schema: { hide: true },
    },
    async (_req, reply) => {
      const db: Check = await sql`select 1`
        .execute(app.db)
        .then<Check>(() => ({ ok: true, detail: 'ok' }))
        .catch((e: Error) => ({ ok: false, detail: e.message }))

      let migrations: Check = { ok: false, detail: 'unknown' }
      if (db.ok && files) {
        migrations = await migrationStatusFromDb(app.db, files)
          .then<Check>((s) =>
            isFullyMigrated(s)
              ? { ok: true, detail: `${s.applied.length} applied` }
              : {
                  ok: false,
                  detail: `pending: ${s.pending.join(', ') || 'none'}; edited: ${s.drifted.join(', ') || 'none'}`,
                },
          )
          .catch((e: Error) => ({ ok: false, detail: e.message }))
      }
      const jobs: Check = app.jobs ? await app.jobs.health() : { ok: true, detail: 'not configured' }
      const ok = db.ok && migrations.ok && jobs.ok
      return reply
        .status(ok ? 200 : 503)
        .send({ status: ok ? 'ready' : 'degraded', checks: { db, migrations, jobs } })
    },
  )
}
