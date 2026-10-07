import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import Fastify from 'fastify'
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod'
import type { DestinationStream } from 'pino'
import type { Env } from './config/env.js'
import { installErrorHandling } from './http/error-handler.js'
import { installRequestHooks, installRouteRegistry } from './http/hooks.js'
import { apiModules, hookModules, type ApiModule } from './http/modules.js'
import { registerOpenApi } from './http/openapi.js'
import { registerEventsRoute } from './http/routes/events.js'
import { registerDevStorageRoutes, shouldMountDevStorage } from './http/routes/dev-storage.js'
import { registerHealthRoutes } from './http/routes/health.js'
import { registerMetaRoutes } from './http/routes/meta.js'
import { access, type RouteRecord } from './http/access.js'
import type { Authorizer } from './http/authorizer.js'
import { installRawBodyParsers } from './http/webhooks.js'
import type { AppInstance } from './http/types.js'
import type { Clock } from './platform/clock.js'
import type { Db } from './platform/db.js'
import { createIdGenerator, type NewId } from './platform/ids.js'
import type { Jobs } from './platform/jobs.js'
import { createLogger } from './platform/logging.js'
import type { RealtimeHub } from './platform/realtime.js'

export type { AppInstance } from './http/types.js'

export interface AppDeps {
  env: Env
  db: Db
  clock: Clock
  authorizer: Authorizer
  newId?: NewId
  /** Fan-out for GET /api/v1/events; without it the stream answers 503. */
  hub?: RealtimeHub | null
  /** Queue producer used by services and /readyz. */
  jobs?: Jobs | null
  /** Override the module lists (tests); defaults to src/http/modules.ts. */
  modules?: ApiModule[]
  hookModules?: ApiModule[]
  /** Destination for log lines (tests capture them). */
  logStream?: DestinationStream
}

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/

export async function buildApp(deps: AppDeps): Promise<AppInstance> {
  const { env } = deps
  const newId = deps.newId ?? createIdGenerator(deps.clock)
  const logger = createLogger(
    {
      level: env.LOG_LEVEL,
      pretty: env.NODE_ENV === 'development' && !deps.logStream && Boolean(process.stdout.isTTY),
    },
    deps.logStream,
  )

  const raw = Fastify({
    loggerInstance: logger,
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id']
      return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : newId()
    },
  })
  const app = raw.withTypeProvider<ZodTypeProvider>() as unknown as AppInstance
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  const records: RouteRecord[] = []
  app.decorate('env', env)
  app.decorate('db', deps.db)
  app.decorate('clock', deps.clock)
  app.decorate('newId', newId)
  app.decorate('authorizer', deps.authorizer)
  app.decorate('hub', deps.hub ?? null)
  app.decorate('jobs', deps.jobs ?? null)
  app.decorate('routeRegistry', records)

  installRouteRegistry(app, records)
  installErrorHandling(app)

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    hsts: env.COOKIE_SECURE ? { maxAge: 15_552_000 } : false,
  })
  await app.register(cookie, env.SESSION_SECRET ? { secret: env.SESSION_SECRET } : {})
  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_PER_MIN,
    timeWindow: '1 minute',
    hook: 'preHandler',
    keyGenerator: (req) => req.auth?.userId ?? req.ip,
  })
  await registerOpenApi(app)
  installRequestHooks(app)

  registerHealthRoutes(app)

  await app.register(
    async (api) => {
      registerMetaRoutes(api)
      registerEventsRoute(api)
      api.get(
        '/openapi.json',
        {
          config: { access: access.public('API contract; contains no data'), rateLimit: false },
          schema: { hide: true },
        },
        async () => api.swagger(),
      )
      for (const mod of deps.modules ?? apiModules) await mod(api, deps)
    },
    { prefix: '/api/v1' },
  )

  await app.register(
    async (hooks) => {
      installRawBodyParsers(hooks)
      for (const mod of deps.hookModules ?? hookModules) await mod(hooks, deps)
    },
    { prefix: '/hooks' },
  )

  if (shouldMountDevStorage(env)) await registerDevStorageRoutes(app)

  await app.ready()
  return app
}
