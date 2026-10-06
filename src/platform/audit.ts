// audit.record(tx, ...) is called inside the transaction of every mutation. audit_log is insert-only (DB trigger).
import { isIP } from 'node:net'
import type { Tx } from './db.js'

export interface AuditActor {
  userId?: string | null
  employeeId?: string | null
  name?: string | null
  roles?: string | null
  /** Role being viewed-as; the actor fields stay the real person. */
  viewAsRoleId?: string | null
}

/** Per-request facts the HTTP layer captures once and passes to services. */
export interface AuditContext {
  actor?: AuditActor
  requestId?: string | null
  idempotencyKey?: string | null
  ip?: string | null
}

export interface AuditEntry {
  locationId: string
  action: string
  entityType: string
  entityId?: string | null
  before?: unknown
  after?: unknown
  ctx?: AuditContext
}

const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v))

export async function record(tx: Tx, e: AuditEntry): Promise<number> {
  const c = e.ctx
  const row = await tx
    .insertInto('audit_log')
    .values({
      location_id: e.locationId,
      actor_user_id: c?.actor?.userId ?? null,
      actor_employee_id: c?.actor?.employeeId ?? null,
      actor_name: c?.actor?.name ?? null,
      actor_roles: c?.actor?.roles ?? null,
      view_as_role_id: c?.actor?.viewAsRoleId ?? null,
      action: e.action,
      entity_type: e.entityType,
      entity_id: e.entityId ?? null,
      before: json(e.before),
      after: json(e.after),
      request_id: c?.requestId ?? null,
      idempotency_key: c?.idempotencyKey ?? null,
      ip: c?.ip && isIP(c.ip) ? c.ip : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
  return row.id
}
