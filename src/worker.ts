import { loadEnv } from './config/env.js'
import { createClock } from './platform/clock.js'
import { createDb } from './platform/db.js'
import { jobDefinitions } from './platform/job-registry.js'
import { createJobs } from './platform/jobs.js'
import { createLogger } from './platform/logging.js'

async function main(): Promise<void> {
  const env = loadEnv()
  const logger = createLogger({
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV === 'development' && Boolean(process.stdout.isTTY),
  })
  if (!env.JOBS_ENABLED) {
    logger.warn('JOBS_ENABLED=false: worker not started')
    return
  }
  const clock = createClock(env.CLOCK_FREEZE_AT)
  const db = createDb({
    url: env.DATABASE_URL,
    poolMax: env.DB_POOL_MAX,
    searchPath: env.DB_SEARCH_PATH,
    statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
    clock,
    applicationName: 'oasis-worker',
  })
  const jobs = createJobs({
    connectionString: env.DATABASE_URL,
    schema: env.PGBOSS_SCHEMA,
    db,
    clock,
    logger,
    enabled: true,
    definitions: jobDefinitions,
    tz: env.BUSINESS_TZ,
  })
  await jobs.start({ workers: true })
  logger.info({ jobs: jobDefinitions.map((j) => j.name) }, 'worker started')

  let stopping = false
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    logger.info({ signal }, 'worker stopping')
    await jobs.stop()
    await db.destroy()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
