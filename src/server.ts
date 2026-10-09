import { buildApp } from './app.js'
import type { Env } from './config/env.js'
import { loadRuntimeEnv } from './config/secrets-source.js'
import { createPermissiveAuthorizer, type Authorizer } from './http/authorizer.js'
import { createIdentity, bootstrapAdmin, type IdentityAuthorizer } from './modules/auth/index.js'
import type { NotificationPort } from './modules/auth/notifications.js'
import { MessagingAccountNotifier } from './modules/messaging/adapters/accounts.js'
import { buildHooksApp, type HooksApp } from './modules/messaging/http/hooks-app.js'
import { startInlineRunner, type InlineRunner } from './modules/messaging/jobs/runner.js'
import { DbBusinessHours } from './modules/settings/db-adapters/index.js'
import { enqueueStartupJobs } from './modules/settings/jobs/index.js'
import { configureProductionPayments, configureProductionSettings, messagingRuntimeFor } from './composition.js'
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
  notifier: NotificationPort,
): Authorizer | IdentityAuthorizer {
  if (env.DEV_AUTH_BYPASS) return createPermissiveAuthorizer({ locationId })
  return createIdentity({
    db,
    clock,
    env,
    newId,
    locationId,
    businessHours: new DbBusinessHours(db),
    notifier,
  })
}

async function main(): Promise<void> {
  const env = await loadRuntimeEnv() // the Secrets Manager secret (OASIS_SECRET_ID) under the process environment
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
  await enqueueStartupJobs(jobs, (err, job) =>
    logger.warn({ err: err.message, job }, 'startup job not enqueued'),
  )
  const messaging = messagingRuntimeFor({ db, clock, env, newId }, { logger })
  configureProductionSettings({ clock, newId, messaging })
  configureProductionPayments(messaging)

  const authorizer = makeAuthorizer(env, location.id, db, clock, newId, new MessagingAccountNotifier(messaging))
  if (env.SMS_PROVIDER === 'sim' || env.EMAIL_PROVIDER === 'sim')
    logger.warn(
      'SMS_PROVIDER or EMAIL_PROVIDER is sim: invite and reset links are not really delivered, so a Super Admin receives them in the API response',
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

  // The SMS Gate webhook is served only here, on the tailnet-facing listener; the public listener answers 404 for it.
  let hooks: HooksApp | undefined
  if (env.HOOKS_PORT > 0) {
    const candidate = await buildHooksApp(messaging, { host: env.HOOKS_HOST, port: env.HOOKS_PORT, logger: logger.child({ listener: 'hooks' }) })
    try {
      logger.info({ address: await candidate.listen() }, 'hooks listener started')
      hooks = candidate
    } catch (err) {
      // Another instance already owns the port (two stacks on one host): sending still works, inbound texts do not.
      if ((err as { code?: string }).code !== 'EADDRINUSE') throw err
      await candidate.close()
      logger.error({ port: env.HOOKS_PORT }, 'hooks listener port is in use: SMS webhooks (inbound texts, delivery receipts) are NOT being received by this instance; set HOOKS_PORT')
    }
  }
  let runner: InlineRunner | undefined
  if (env.SMS_DISPATCH_MODE === 'inline')
    runner = await startInlineRunner(messaging, { url: env.DATABASE_URL, searchPath: env.DB_SEARCH_PATH, clock })
  else if (env.SMS_DISPATCH_MODE === 'jobs')
    await jobs.enqueue('sms.webhooks.register', {}, { singletonKey: 'boot' }).catch((err: Error) => logger.warn({ err: err.message }, 'webhook registration not enqueued'))

  let stopping = false
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    app.log.info({ signal }, 'shutting down')
    await runner?.stop()
    await hooks?.close()
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
