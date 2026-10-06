// Audit entry plus a settings.changed event for one mutation, inside the caller's transaction.
import type { Tx } from '../../platform/db.js'
import * as audit from '../../platform/audit.js'
import * as realtime from '../../platform/realtime.js'
import type { JsonValue } from '../../platform/schema.js'

export interface ChangeRecord {
  locationId: string
  /** Audit action, for example "settings.hours.update". */
  action: string
  entityType: string
  entityId?: string | null
  before?: unknown
  after?: unknown
  section: string
  version?: number
  audit?: audit.AuditContext
  /** Publish on this channel instead of "settings" (emergencies also show on the Operations banner). */
  channel?: realtime.RealtimeChannel
  eventType?: string
  payload?: Record<string, JsonValue>
}

export async function recordChange(tx: Tx, c: ChangeRecord): Promise<void> {
  await audit.record(tx, {
    locationId: c.locationId,
    action: c.action,
    entityType: c.entityType,
    entityId: c.entityId,
    before: c.before,
    after: c.after,
    ctx: c.audit,
  })
  await realtime.publish(tx, {
    locationId: c.locationId,
    channel: c.channel ?? 'settings',
    type: c.eventType ?? 'settings.changed',
    payload: c.payload ?? {
      section: c.section,
      key: c.entityId ?? c.section,
      ...(c.version === undefined ? {} : { version: c.version }),
    },
  })
}
