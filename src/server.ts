import { buildApp } from './app.js'
import { loadEnv, type Env } from './config/env.js'
import { createPermissiveAuthorizer, createDenyAuthorizer, type Authorizer } from './http/authorizer.js'
import { createClock } from './platform/clock.js'
import { createDb, type DbOptions } from './platform/db.js'
import { createIdGenerator } from './platform/ids.js'
import { jobDefinitions } from './platform/job-registry.js'
import { createJobs } from './platform/jobs.js'
import { ensureLocation } from './platform/locations.js'
import { createLogger } from './platform/logging.js'
import { RealtimeHub } from './platform/realtime.js'

/**
 * The auth/RBAC module replaces this function with its session-backed Authorizer. Until then production fails closed
 * (every non-public route answers 401); DEV_AUTH_BYPASS gives local development a signed-in user with all permissions.
 */
function makeAuthorizer(env: Env, locationId: string): Authorizer {
  if (env.DEV_AUTH_BYPASS) return createPermissiveAuthorizer({ locationId })
  return createDenyAuthorizer()
}

async function main(): Promise<void> {
  const env = loadEnv()
  const clock = createClock(env.CLOCK_FREEZE_AT)
  const logger = createLogger({
    level: env.LOG_LEVEL,
    pretty: env.NODE_ENV === 'development' && Boolean(process.stdout.isTTY),
  })
  const newId = createIdGenerator(clock)
  const conn: DbOptions = {
    url: env.DATABASE_URL,
    poolMax: env.DB_POOL_MAX,
    searchPath: env.DB_SEARCH_PATH,
    statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
    clock,
  }
  const db = createDb(conn)
  const location = await ensureLocation(db, newId, { timezone: env.BUSINESS_TZ })

  const hub = new RealtimeHub({ db, connection: { ...conn, statementTimeoutMs: undefined }, logger })
  await hub.start()

  const jobs = createJobs({
    connectionString: env.DATABASE_URL,
    schema: env.PGBOSS_SCHEMA,
    db,
    clock,
    logger,
    enabled: env.JOBS_ENABLED,
    definitions: jobDefinitions,
    tz: env.BUSINESS_TZ,
  })
  await jobs.start({ workers: false })

  const app = await buildApp({
    env,
    db,
    clock,
    newId,
    hub,
    jobs,
    authorizer: makeAuthorizer(env, location.id),
  })
  await app.listen({ port: env.PORT, host: env.HOST })

  let stopping = false
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    app.log.info({ signal }, 'shutting down')
    await hub.close()
    await app.close()
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
