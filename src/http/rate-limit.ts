// Request rate limits (SEC-14). Three layers, all in memory (@fastify/rate-limit's store):
//   1. Before authentication, every rate-limited route (and an unmatched path) counts against its client address, with a ceiling
//      of RATE_LIMIT_PER_MIN x PRE_AUTH_IP_FACTOR a minute. It runs ahead of the session lookup, so a flood costs no database work
//      once it is over the ceiling; the factor leaves room for several staff behind one shop address.
//   2. The global budget, RATE_LIMIT_PER_MIN a minute per signed-in user (per address when there is no session), is charged after
//      the session is resolved and BEFORE the 401/403 decision, so floods of rejected requests are throttled like any other.
//   3. Routes that declare their own `config.rateLimit` (sign-in, password reset, the event stream, the arrival ping) keep that
//      limit alone, charged in preHandler as before; `rateLimit: false` (probes, webhooks, the dev object store) is exempt.
import rateLimit from '@fastify/rate-limit'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../platform/errors.js'
import type { AppInstance } from './types.js'

export const PRE_AUTH_IP_FACTOR = 4

type Limiter = ReturnType<AppInstance['createRateLimit']>

export interface RateLimits {
  /** The global per-caller budget; call it once the request's session is known (req.auth set or not). */
  charge(req: FastifyRequest, reply: FastifyReply): Promise<void>
}

const routeLimit = (req: FastifyRequest): unknown => req.routeOptions.config?.rateLimit

async function enforce(limiter: Limiter, req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const r = await limiter(req)
  if (r.isAllowed) return
  void reply.header('x-ratelimit-limit', r.max)
  void reply.header('x-ratelimit-remaining', r.remaining)
  void reply.header('x-ratelimit-reset', r.ttlInSeconds)
  if (!r.isExceeded) return
  const retry = String(Math.max(1, r.ttlInSeconds))
  void reply.header('retry-after', retry)
  throw new AppError('RATE_LIMITED', { headers: { 'Retry-After': retry } })
}

/** Registers the plugin (per-route limits) and the pre-authentication ceiling; returns the global budget for the auth hook. */
export async function installRateLimits(app: AppInstance): Promise<RateLimits> {
  const max = app.env.RATE_LIMIT_PER_MIN
  await app.register(rateLimit, {
    // routes without their own config are charged by `charge` below, not by the plugin
    global: false,
    max,
    timeWindow: '1 minute',
    hook: 'preHandler',
    keyGenerator: (req) => req.auth?.userId ?? req.ip,
  })
  const perAddress = app.createRateLimit({
    max: max * PRE_AUTH_IP_FACTOR,
    timeWindow: '1 minute',
    keyGenerator: (req) => `ip:${req.ip}`,
  })
  const perCaller = app.createRateLimit({
    max,
    timeWindow: '1 minute',
    keyGenerator: (req) => (req.auth ? `user:${req.auth.userId}` : `ip:${req.ip}`),
  })

  app.addHook('onRequest', async (req, reply) => {
    if (routeLimit(req) === false) return
    await enforce(perAddress, req, reply)
  })

  return {
    async charge(req, reply) {
      if (routeLimit(req) !== undefined) return
      await enforce(perCaller, req, reply)
    },
  }
}
