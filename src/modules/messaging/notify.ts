import type { Executor, Tx } from '../../platform/db.js'
import type { Clock } from '../../platform/clock.js'
import type { NewId } from '../../platform/ids.js'
import * as realtime from '../../platform/realtime.js'
import type { JsonValue } from '../../platform/schema.js'
import { loadAuthority } from '../rbac/service.js'

export interface Manager {
  employeeId: string
  userId: string
}

/** The people who run the shop and can fix a dead device: active, able to sign in, holding set.billing or sched.override. */
export async function managersOf(db: Executor, locationId: string): Promise<Manager[]> {
  const people = await db
    .selectFrom('employees as e')
    .innerJoin('users as u', 'u.employee_id', 'e.id')
    .select(['e.id as employee_id', 'u.id as user_id'])
    .where('e.status', '=', 'active')
    .where('u.disabled_at', 'is', null)
    .where((eb) =>
      eb.or([
        eb.exists(
          eb
            .selectFrom('employee_locations as l')
            .select('l.employee_id')
            .whereRef('l.employee_id', '=', 'e.id')
            .where('l.location_id', '=', locationId),
        ),
        eb.not(
          eb.exists(
            eb
              .selectFrom('employee_locations as l2')
              .select('l2.employee_id')
              .whereRef('l2.employee_id', '=', 'e.id'),
          ),
        ),
      ]),
    )
    .orderBy('e.created_at')
    .execute()
  const out: Manager[] = []
  for (const p of people) {
    const a = await loadAuthority(db, p.employee_id)
    if (a.permissions.has('sched.override') || a.permissions.has('set.billing'))
      out.push({ employeeId: p.employee_id, userId: p.user_id })
  }
  return out
}

export interface NoticeSpec {
  locationId: string
  kind: string
  title: string
  body: string
  entityType: string | null
  entityId: string | null
  /** Extra SSE event published to each manager on the notifications channel (e.g. sms.device.health). */
  event?: { type: string; payload: Record<string, JsonValue> }
}

/** A notification row and a notification.new event per manager, in the caller's transaction. */
export async function notifyManagers(
  tx: Tx,
  n: NoticeSpec,
  o: { newId: NewId; clock: Clock },
): Promise<number> {
  const managers = await managersOf(tx, n.locationId)
  for (const m of managers) {
    const id = o.newId()
    await tx
      .insertInto('notifications')
      .values({
        id,
        location_id: n.locationId,
        employee_id: m.employeeId,
        role_target: null,
        kind: n.kind,
        title: n.title,
        body: n.body,
        entity_type: n.entityType,
        entity_id: n.entityId,
        created_at: o.clock.now(),
        read_at: null,
      })
      .execute()
    await realtime.publish(tx, {
      locationId: n.locationId,
      channel: 'notifications',
      type: 'notification.new',
      payload: { id, kind: n.kind },
      targetUserId: m.userId,
    })
    if (n.event)
      await realtime.publish(tx, {
        locationId: n.locationId,
        channel: 'notifications',
        type: n.event.type,
        payload: n.event.payload,
        targetUserId: m.userId,
      })
  }
  return managers.length
}

/** SSE only, no notification row (a state change worth showing live but not worth an inbox entry). */
export async function publishToManagers(
  tx: Tx,
  locationId: string,
  type: string,
  payload: Record<string, JsonValue>,
): Promise<void> {
  for (const m of await managersOf(tx, locationId))
    await realtime.publish(tx, {
      locationId,
      channel: 'notifications',
      type,
      payload,
      targetUserId: m.userId,
    })
}
