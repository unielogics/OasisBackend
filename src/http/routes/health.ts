import { sql } from 'kysely'
import {
  isFullyMigrated,
  loadMigrationFiles,
  migrationStatusFromDb,
  type MigrationFile,
} from '../../platform/migrate.js'
import type { JobsHealth } from '../../platform/jobs.js'
import { access } from '../access.js'
import type { AppInstance } from '../types.js'

type Check = { ok: boolean; detail: string } & Partial<Pick<JobsHealth, 'queue' | 'worker'>>

export function registerHealthRoutes(app: AppInstance): void {
  let files: MigrationFile[] | null = null
  try {
    files = loadMigrationFiles()
  } catch (e) {
    app.log.warn({ err: (e as Error).message }, 'migration files unavailable; /readyz will report unknown')
  }

  const checkDb = (): Promise<Check> =>
    sql`select 1`
      .execute(app.db)
      .then<Check>(() => ({ ok: true, detail: 'ok' }))
      .catch((e: Error) => ({ ok: false, detail: e.message }))

  // Liveness: always 200 while the process answers (a database blip must not make a supervisor restart a healthy API), but the
  // body reports the database and queue state so a human or a monitor can see them without a second call.
  app.get(
    '/healthz',
    { config: { access: access.public('Liveness probe'), rateLimit: false }, schema: { hide: true } },
    async () => {
      const db = await checkDb()
      const jobs: Check = !db.ok
        ? { ok: false, detail: 'skipped: database unavailable' }
        : app.jobs
          ? await app.jobs.health().catch((e: Error) => ({ ok: false, detail: e.message }))
          : { ok: true, detail: 'not configured' }
      return { status: db.ok && jobs.ok ? 'ok' : 'degraded', checks: { db, jobs } }
    },
  )

  app.get(
    '/readyz',
    {
      config: { access: access.public('Readiness probe for the proxy and uptime monitor'), rateLimit: false },
      schema: { hide: true },
    },
    async (_req, reply) => {
      const db = await checkDb()

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
