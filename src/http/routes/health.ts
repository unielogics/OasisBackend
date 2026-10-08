import { sql } from 'kysely'
import {
  isFullyMigrated,
  loadMigrationFiles,
  migrationStatusFromDb,
  type MigrationFile,
} from '../../platform/migrate.js'
import type { FastifyRequest } from 'fastify'
import type { JobsHealth } from '../../platform/jobs.js'
import { access } from '../access.js'
import type { AppInstance } from '../types.js'

type Check = { ok: boolean; detail: string } & Partial<Pick<JobsHealth, 'queue' | 'worker'>>

const isLoopbackAddress = (a: string | undefined): boolean => {
  if (!a) return false
  let v = a.trim().replace(/^"|"$/g, '')
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(v)
  if (bracketed) v = bracketed[1]!
  else v = v.replace(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/, '$1')
  return v === '::1' || /^(::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(v)
}

/** Addresses a proxy reports for the request (X-Forwarded-For, X-Real-IP, Forwarded: for=...). */
function forwardedAddresses(req: FastifyRequest): string[] {
  const one = (h: string | string[] | undefined): string => (Array.isArray(h) ? h.join(',') : (h ?? ''))
  const out = [...one(req.headers['x-forwarded-for']).split(','), one(req.headers['x-real-ip'])]
  for (const m of one(req.headers.forwarded).matchAll(/for=("[^"]*"|[^;,\s]+)/gi)) out.push(m[1]!)
  return out.map((s) => s.trim()).filter(Boolean)
}

/**
 * The probes answer their details (database error text, migration names, queue state) only to the server itself: the socket peer
 * is a loopback address and no proxy says the request came from anywhere else. Everyone else gets `{status}` and the status code.
 */
export function isLoopbackCaller(req: FastifyRequest): boolean {
  return isLoopbackAddress(req.socket.remoteAddress) && forwardedAddresses(req).every(isLoopbackAddress)
}

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
    async (req) => {
      const db = await checkDb()
      const jobs: Check = !db.ok
        ? { ok: false, detail: 'skipped: database unavailable' }
        : app.jobs
          ? await app.jobs.health().catch((e: Error) => ({ ok: false, detail: e.message }))
          : { ok: true, detail: 'not configured' }
      const status = db.ok && jobs.ok ? 'ok' : 'degraded'
      return isLoopbackCaller(req) ? { status, checks: { db, jobs } } : { status }
    },
  )

  app.get(
    '/readyz',
    {
      config: { access: access.public('Readiness probe for the proxy and uptime monitor'), rateLimit: false },
      schema: { hide: true },
    },
    async (req, reply) => {
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
      const status = ok ? 'ready' : 'degraded'
      return reply
        .status(ok ? 200 : 503)
        .send(isLoopbackCaller(req) ? { status, checks: { db, migrations, jobs } } : { status })
    },
  )
}
