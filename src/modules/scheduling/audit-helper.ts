// One-line audit.record for appointment entities, shared by the scheduling services.
import * as auditLog from '../../platform/audit.js'
import type { Tx } from '../../platform/db.js'
import type { Actor, SchedulingCtx } from './context.js'

export async function audit(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  action: string,
  appointmentId: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await auditLog.record(tx, {
    locationId: c.locationId,
    action: `appointment.${action}`,
    entityType: 'appointment',
    entityId: appointmentId,
    before: before as never,
    after: after as never,
    ctx: actor.audit,
  })
}
