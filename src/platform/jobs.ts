// pg-boss bootstrap (Postgres-backed queue, schema "pgboss"). Jobs are idempotent and named <area>.<action>.
import PgBoss from 'pg-boss'
import { sql } from 'kysely'
import type { Clock } from './clock.js'
import { assertIdentifier, type Db } from './db.js'
import type { Logger } from './logging.js'

export interface JobContext {
  db: Db
  clock: Clock
  logger: Logger
}

export interface JobDefinition<Data extends object = Record<string, never>> {
  name: string
  /** Five-field cron in the business tz; omit for queue-only jobs enqueued by code. */
  cron?: string
  tz?: string
  /**
   * Queue policy: 'short' keeps at most one queued job per singletonKey, 'singleton' one active job per key,
   * 'stately' one job per state per key. The default 'standard' never collapses jobs.
   */
  policy?: 'standard' | 'short' | 'singleton' | 'stately'
  retryLimit?: number
  retryDelaySeconds?: number
  expireInSeconds?: number
  handler(ctx: JobContext, data: Data, job: { id: string }): Promise<void>
}

export interface EnqueueOptions {
  /** Collapses duplicates when the queue policy is short, singleton or stately (see JobDefinition.policy). */
  singletonKey?: string
  startAfter?: Date | number
}

export interface JobsHealth {
  ok: boolean
  detail: string
}

export interface Jobs {
  /** Starts the queue; with workers=true also registers handlers and cron schedules (the worker process). */
  start(opts: { workers: boolean }): Promise<void>
  enqueue(name: string, data?: object, opts?: EnqueueOptions): Promise<string | null>
  health(): Promise<JobsHealth>
  stop(): Promise<void>
}

export interface JobsConfig {
  connectionString: string
  schema?: string
  db: Db
  clock: Clock
  logger: Logger
  enabled: boolean
  definitions: readonly JobDefinition<never>[]
  tz: string
  pollSeconds?: number
}

export function createJobs(cfg: JobsConfig): Jobs {
  if (!cfg.enabled) {
    return {
      start: async () => undefined,
      enqueue: async (name) => {
        cfg.logger.debug({ job: name }, 'JOBS_ENABLED=false: job not enqueued')
        return null
      },
      health: async () => ({ ok: true, detail: 'disabled' }),
      stop: async () => undefined,
    }
  }

  const schema = assertIdentifier(cfg.schema ?? 'pgboss')
  const boss = new PgBoss({
    connectionString: cfg.connectionString,
    schema,
    application_name: 'oasis-jobs',
    max: 4,
  })
  boss.on('error', (err: Error) => cfg.logger.error({ err: err.message }, 'pg-boss error'))
  let started = false
  const ctx: JobContext = { db: cfg.db, clock: cfg.clock, logger: cfg.logger }

  return {
    async start({ workers }) {
      await boss.start()
      started = true
      for (const def of cfg.definitions as readonly JobDefinition<object>[]) {
        await boss.createQueue(def.name, {
          name: def.name,
          policy: def.policy ?? 'standard',
          retryLimit: def.retryLimit ?? 3,
          retryDelay: def.retryDelaySeconds ?? 30,
          retryBackoff: true,
          ...(def.expireInSeconds ? { expireInSeconds: def.expireInSeconds } : {}),
        })
        if (!workers) continue
        await boss.work(def.name, { pollingIntervalSeconds: cfg.pollSeconds ?? 2 }, async (jobs) => {
          for (const job of jobs) {
            const log = cfg.logger.child({ job: def.name, jobId: job.id })
            try {
              await def.handler({ ...ctx, logger: log }, job.data as never, { id: job.id })
            } catch (err) {
              log.error({ err: (err as Error).message }, 'job failed')
              throw err
            }
          }
        })
        if (def.cron) await boss.schedule(def.name, def.cron, {}, { tz: def.tz ?? cfg.tz })
      }
    },
    async enqueue(name, data = {}, opts = {}) {
      if (!started) throw new Error('jobs are not started')
      return boss.send(name, data, {
        ...(opts.singletonKey ? { singletonKey: opts.singletonKey } : {}),
        ...(opts.startAfter ? { startAfter: opts.startAfter } : {}),
      })
    },
    async health() {
      if (!started) return { ok: false, detail: 'not started' }
      try {
        const r = await sql<{
          n: number
        }>`select count(*)::int as n from ${sql.table(`${schema}.job`)} where state = 'failed'`.execute(
          cfg.db,
        )
        return { ok: true, detail: `${r.rows[0]?.n ?? 0} failed job rows retained` }
      } catch (e) {
        return { ok: false, detail: (e as Error).message }
      }
    },
    async stop() {
      if (started) await boss.stop({ graceful: true, timeout: 10_000, close: true })
      started = false
    },
  }
}
