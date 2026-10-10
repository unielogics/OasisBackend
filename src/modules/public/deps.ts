// What the public website's services need from the process: the app (db, clock, ids, env, log), the messaging queue the codes and
// confirmations go through, and the scheduling ports a web booking is created with (the same invoice gateway, membership port and
// queue the dashboard's booking uses, wired in src/http/modules.ts).
import type { AuthContext } from '../../http/authorizer.js'
import type { AppInstance } from '../../http/types.js'
import type { AuditContext } from '../../platform/audit.js'
import type { Executor } from '../../platform/db.js'
import { getDefaultLocation } from '../../platform/locations.js'
import { DEFAULT_TZ } from '../../platform/time.js'
import type { DbMessageQueue } from '../messaging/queue.js'
import type { Actor, SchedulingCtx } from '../scheduling/context.js'
import type { SchedulingPorts } from '../scheduling/ports.js'

export interface PublicDeps {
  app: AppInstance
  queue: DbMessageQueue
  scheduling: SchedulingPorts
}

export interface PublicLocation {
  id: string
  tz: string
}

/** The deployment's single location (the oldest row); the public routes have no session to read it from. */
export async function publicLocation(db: Executor, fallbackTz: string): Promise<PublicLocation | null> {
  const loc = await getDefaultLocation(db)
  return loc ? { id: loc.id, tz: loc.timezone ?? fallbackTz ?? DEFAULT_TZ } : null
}

export function schedulingCtx(d: PublicDeps, loc: PublicLocation): SchedulingCtx {
  return { clock: d.app.clock, newId: d.app.newId, locationId: loc.id, tz: loc.tz, ports: d.scheduling }
}

/** Per-request facts of a public call (no session): the request id, the idempotency key and the client address. */
export interface PublicRequest {
  ip: string
  requestId: string
  idempotencyKey?: string | null
}

/** The acting party of a web booking: no user, no employee, no permission (so no override), named "Website" in the logs. */
export function websiteActor(loc: PublicLocation, r: PublicRequest): Actor {
  const auth: AuthContext = {
    userId: 'website',
    employeeId: null,
    locationId: loc.id,
    permissions: new Set<string>(),
    actorName: 'Website',
    roles: ['website'],
  }
  const audit: AuditContext = {
    actor: { name: 'Website' },
    requestId: r.requestId,
    idempotencyKey: r.idempotencyKey ?? null,
    ip: r.ip,
  }
  return { auth, audit }
}
