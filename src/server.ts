import { buildApp } from './app.js'
import { loadEnv, type Env } from './config/env.js'
import { createPermissiveAuthorizer, type Authorizer } from './http/authorizer.js'
import { createIdentity, bootstrapAdmin, type IdentityAuthorizer } from './modules/auth/index.js'
import { createClock, type Clock } from './platform/clock.js'
import { createDb, type Db, type DbOptions } from './platform/db.js'
import { createIdGenerator, type NewId } from './platform/ids.js'
import { jobDefinitions } from './platform/job-registry.js'
import { createJobs } from './platform/jobs.js'
import { ensureLocation } from './platform/locations.js'
import { createLogger } from './platform/logging.js'
import { RealtimeHub } from './platform/realtime.js'

/**
 * Session-backed authorizer (src/modules/auth): cookie sessions, RBAC engine, CSRF. DEV_AUTH_BYPASS keeps a permissive
 * signed-in user with every permission for local development only (refused in production by the env schema).
 */
function makeAuthorizer(
  env: Env,
  locationId: string,
  db: Db,
  clock: Clock,
  newId: NewId,
): Authorizer | IdentityAuthorizer {
  if (env.DEV_AUTH_BYPASS) return createPermissiveAuthorizer({ locationId })
  return createIdentity({ db, clock, env, newId, locationId })
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

  const authorizer = makeAuthorizer(env, location.id, db, clock, newId)
  if ('identity' in authorizer)
    logger.warn(
      'invite and password-reset links are not delivered by SMS or email until a NotificationPort is wired into createIdentity; a Super Admin receives them in the API response instead',
    )
  if ('identity' in authorizer && env.BOOTSTRAP_ADMIN_EMAIL && env.BOOTSTRAP_ADMIN_PASSWORD) {
    const r = await bootstrapAdmin(authorizer.identity, {
      email: env.BOOTSTRAP_ADMIN_EMAIL,
      password: env.BOOTSTRAP_ADMIN_PASSWORD,
    })
    if (r.created) logger.info({ email: env.BOOTSTRAP_ADMIN_EMAIL }, 'bootstrapped the first Super Admin')
  }

  const app = await buildApp({
    env,
    db,
    clock,
    newId,
    hub,
    jobs,
    authorizer,
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
