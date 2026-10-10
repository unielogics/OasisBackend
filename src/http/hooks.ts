import type { FastifyReply, FastifyRequest, RouteOptions } from 'fastify'
import { AppError } from '../platform/errors.js'
import { assertValidKey } from '../platform/idempotency.js'
import type { Env } from '../config/env.js'
import type { RouteRecord, RouteAccess } from './access.js'
import { isIdempotentHandler } from './idempotent.js'
import type { RateLimits } from './rate-limit.js'
import type { AppInstance } from './types.js'

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function allowedOrigins(env: Env): Set<string> {
  const origins = new Set<string>()
  for (const u of [env.PUBLIC_DASHBOARD_URL, env.PUBLIC_API_URL]) origins.add(new URL(u).origin)
  // the public website posts bookings, codes and joins from its own origin (through its nginx host, same path)
  if (env.PUBLIC_SITE_URL) origins.add(new URL(env.PUBLIC_SITE_URL).origin)
  for (const o of env.ALLOWED_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean))
    origins.add(new URL(o).origin)
  return origins
}

/**
 * CSRF layer 1: browsers always send Origin (or at least Referer) on unsafe requests, and a session cookie rides along
 * only from a browser. A request without cookies cannot be forged cross-site, so it is not blocked here.
 */
export function assertOriginAllowed(req: FastifyRequest, allowed: ReadonlySet<string>): void {
  const origin = req.headers.origin
  const referer = req.headers.referer
  if (origin !== undefined) {
    if (origin !== 'null' && allowed.has(origin)) return
    throw new AppError('ORIGIN_NOT_ALLOWED')
  }
  if (referer) {
    try {
      if (allowed.has(new URL(referer).origin)) return
    } catch {
      // unparsable referer falls through to the rejection
    }
    throw new AppError('ORIGIN_NOT_ALLOWED')
  }
  if (req.headers.cookie) throw new AppError('ORIGIN_NOT_ALLOWED')
}

/** Boot-time enforcement: every route declares access; required-idempotency routes use idempotentHandler. */
export function installRouteRegistry(app: AppInstance, records: RouteRecord[]): void {
  app.addHook('onRoute', (route: RouteOptions) => {
    const methods = ([] as string[]).concat(route.method)
    const where = `${methods.join(',')} ${route.url}`
    const access = route.config?.access as RouteAccess | undefined
    if (!access) {
      throw new Error(
        `Route ${where} has no access metadata; declare config.access (access.perm/authenticated/public/webhook)`,
      )
    }
    if (access.kind === 'public' && !access.reason?.trim())
      throw new Error(`Route ${where}: access.public needs a reason`)
    if (access.kind === 'permission') {
      if (access.perms.length === 0)
        throw new Error(`Route ${where}: access.perm needs at least one permission key`)
      const known = app.authorizer.knownPermissions
      const unknown = known ? access.perms.filter((p) => !known.has(p)) : []
      if (unknown.length) throw new Error(`Route ${where} names unknown permission(s): ${unknown.join(', ')}`)
    }
    const idempotency = route.config?.idempotency
    if (idempotency === 'required' && !isIdempotentHandler(route.handler)) {
      throw new Error(
        `Route ${where} requires an Idempotency-Key; build its handler with idempotentHandler()`,
      )
    }
    if (access.kind === 'webhook' && idempotency)
      throw new Error(`Route ${where}: webhook routes are exempt from idempotency keys`)
    for (const method of methods) {
      if (method === 'HEAD' || method === 'OPTIONS') continue
      const schema = route.schema as { operationId?: string; tags?: readonly string[] } | undefined
      records.push({
        method,
        url: route.url,
        access,
        idempotency,
        operationId: schema?.operationId,
        tags: schema?.tags,
      })
    }
  })
}

/** `limits` charges the global per-caller budget before the 401/403 decision (SEC-14; src/http/rate-limit.ts). */
export function installRequestHooks(app: AppInstance, limits?: RateLimits): void {
  const origins = allowedOrigins(app.env)
  app.decorateRequest('auth', null)

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('X-Request-Id', req.id)
    const access = req.routeOptions.config?.access
    if (!access) return // unmatched route: the not-found handler answers
    if (req.url.startsWith('/api/')) reply.header('X-API-Version', '1')
    if (access.kind === 'webhook') return

    if (access.kind === 'public') {
      await limits?.charge(req, reply)
      if (UNSAFE.has(req.method)) assertOriginAllowed(req, origins)
      return
    }

    const ctx = await app.authorizer.resolve(req)
    if (ctx) req.auth = ctx
    await limits?.charge(req, reply)
    if (UNSAFE.has(req.method)) assertOriginAllowed(req, origins)
    if (!ctx) throw new AppError('UNAUTHENTICATED')
    if (access.kind === 'permission') app.authorizer.requirePerm(ctx, access.perms, access.mode)
    if (UNSAFE.has(req.method)) await app.authorizer.verifyCsrf?.(req, ctx)
  })

  app.addHook('preHandler', async (req: FastifyRequest) => {
    const cfg = req.routeOptions.config
    if (!cfg?.idempotency) return
    const header = req.headers['idempotency-key']
    if (header === undefined) {
      if (cfg.idempotency === 'required') throw new AppError('IDEMPOTENCY_KEY_REQUIRED')
      return
    }
    assertValidKey(Array.isArray(header) ? (header[0] ?? '') : header)
  })
}
