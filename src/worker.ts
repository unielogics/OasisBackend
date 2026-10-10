// The worker process: registers every job handler and cron schedule and runs them against pg-boss.
// startWorker() is the factory the tests drive; main() wires it to the environment and process signals.
import { pathToFileURL } from 'node:url'
import type { Env } from './config/env.js'
import { loadRuntimeEnv } from './config/secrets-source.js'
import { configureProductionSchedulingJobs } from './composition.js'
import { notifyManagers } from './modules/messaging/notify.js'
import { createClock, type Clock } from './platform/clock.js'
import { createDb, transaction, type Db } from './platform/db.js'
import { jobDefinitions } from './platform/job-registry.js'
import { createJobs, type JobDefinition, type Jobs, type JobsConfig } from './platform/jobs.js'
import { createIdGenerator } from './platform/ids.js'
import { createLogger, type Logger } from './platform/logging.js'

/**
 * A graceful stop gives running handlers this long (sms.dispatch holds its window for about 55 s); whatever is still running
 * is failed back to the queue and retried. Give the service manager a stop timeout above it.
 */
export const WORKER_SHUTDOWN_TIMEOUT_MS = 60_000

export interface WorkerOptions {
  env: Env
  logger?: Logger
  clock?: Clock
  /** Reuse a database handle (tests); the worker then leaves it open on stop. */
  db?: Db
  definitions?: readonly JobDefinition<never>[]
  pollSeconds?: number
  shutdownTimeoutMs?: number
  boss?: JobsConfig['boss']
  /** Replaces the default (a notification to the managers) when a job exhausts its retries. */
  onDeadLetter?: JobsConfig['onDeadLetter']
}

export interface RunningWorker {
  jobs: Jobs
  db: Db
  /** Drains running handlers (up to the shutdown timeout), then stops pg-boss and closes the database. */
  stop(): Promise<void>
}

export async function startWorker(o: WorkerOptions): Promise<RunningWorker> {
  const { env } = o
  const logger = o.logger ?? createLogger({ level: env.LOG_LEVEL })
  const clock = o.clock ?? createClock(env.CLOCK_FREEZE_AT)
  const ownsDb = !o.db
  const db =
    o.db ??
    createDb({
      url: env.DATABASE_URL,
      poolMax: env.DB_POOL_MAX,
      searchPath: env.DB_SEARCH_PATH,
      statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
      connectTimeoutMs: env.DB_CONNECT_TIMEOUT_MS,
      clock,
      applicationName: 'oasis-worker',
    })
  const newId = createIdGenerator(clock)
  configureProductionSchedulingJobs({ clock, newId })
  const jobs = createJobs({
    connectionString: env.DATABASE_URL,
    schema: env.PGBOSS_SCHEMA,
    db,
    clock,
    logger,
    enabled: true,
    definitions: o.definitions ?? jobDefinitions,
    tz: env.BUSINESS_TZ,
    ...(o.pollSeconds !== undefined ? { pollSeconds: o.pollSeconds } : {}),
    shutdownTimeoutMs: o.shutdownTimeoutMs ?? WORKER_SHUTDOWN_TIMEOUT_MS,
    ...(o.boss ? { boss: o.boss } : {}),
    // a job that exhausted its retries tells the managers once, so a broken nightly job is not found by reading logs
    onDeadLetter:
      o.onDeadLetter ??
      (async (info) => {
        const loc = await db
          .selectFrom('locations')
          .select('id')
          .orderBy('created_at')
          .orderBy('id')
          .executeTakeFirst()
        if (!loc) return
        await transaction(db, (tx) =>
          notifyManagers(
            tx,
            {
              locationId: loc.id,
              kind: 'job.failed',
              title: 'Background job failed',
              body: `${info.name} failed after ${info.attempts} attempt(s): ${info.error}`,
              entityType: 'job',
              entityId: info.name,
            },
            { newId, clock },
          ),
        )
      }),
  })
  await jobs.start({ workers: true })
  logger.info({ jobs: (o.definitions ?? jobDefinitions).map((j) => j.name) }, 'worker started')
  let stopped = false
  return {
    jobs,
    db,
    async stop() {
      if (stopped) return
      stopped = true
      await jobs.stop()
      if (ownsDb) await db.destroy()
    },
  }
}

async function main(): Promise<void> {
  const env = await loadRuntimeEnv() // the Secrets Manager secret (OASIS_SECRET_ID) under the process environment
  const logger = createLogger({
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV === 'development' && Boolean(process.stdout.isTTY),
  })
  if (!env.JOBS_ENABLED) {
    logger.warn('JOBS_ENABLED=false: worker not started')
    return
  }
  const worker = await startWorker({ env, logger })
  let stopping = false
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    logger.info({ signal }, 'worker stopping')
    await worker.stop()
    logger.info('worker stopped')
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

// Runs only when started as a program (node dist/worker.js, tsx src/worker.ts), not when a test imports startWorker.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e)
    process.exit(1)
  })
}
