// Request plumbing shared by the scheduling routes: the per-request context and actor.
import type { FastifyRequest } from 'fastify'
import { auditContextOf } from '../../../http/authorizer.js'
import type { AppInstance } from '../../../http/types.js'
import { AppError } from '../../../platform/errors.js'
import { locationTimezone, type Actor, type SchedulingCtx } from '../context.js'
import type { SchedulingPorts } from '../ports.js'

export function actorOf(req: FastifyRequest): Actor {
  if (!req.auth) throw new AppError('UNAUTHENTICATED')
  return { auth: req.auth, audit: auditContextOf(req) }
}

export async function ctxOf(
  app: AppInstance,
  req: FastifyRequest,
  ports: SchedulingPorts,
): Promise<SchedulingCtx> {
  if (!req.auth) throw new AppError('UNAUTHENTICATED')
  return {
    clock: app.clock,
    newId: app.newId,
    locationId: req.auth.locationId,
    tz: await locationTimezone(app.db, req.auth.locationId),
    ports,
  }
}

/** Parses an ISO instant with an offset (the schema already checked the shape). */
export const instant = (s: string): Date => new Date(s)
