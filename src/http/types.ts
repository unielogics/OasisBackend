import type { FastifyBaseLogger, FastifyInstance, RawServerDefault } from 'fastify'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import type {} from '@fastify/rate-limit' // augments route config with `rateLimit`
import type { Env } from '../config/env.js'
import type { Clock } from '../platform/clock.js'
import type { Db } from '../platform/db.js'
import type { NewId } from '../platform/ids.js'
import type { Jobs } from '../platform/jobs.js'
import type { RealtimeHub } from '../platform/realtime.js'
import type { IdempotencyMode, RouteAccess, RouteRecord } from './access.js'
import type { AuthContext, Authorizer } from './authorizer.js'

export type AppInstance = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null
    /** Raw request body for /hooks/* routes (signature verification needs the exact bytes). */
    rawBody?: string
  }
  interface FastifyContextConfig {
    access?: RouteAccess
    idempotency?: IdempotencyMode
  }
  interface FastifyInstance {
    env: Env
    db: Db
    clock: Clock
    newId: NewId
    authorizer: Authorizer
    hub: RealtimeHub | null
    jobs: Jobs | null
    routeRegistry: readonly RouteRecord[]
  }
}
