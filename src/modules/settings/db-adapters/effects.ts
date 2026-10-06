// Emergency side effects that other verticals will refine later. "Alert on-shift crew" is real today: a bell
// notification (and a targeted realtime event) for every active employee with a login whose schedule covers now.
// "Protect member credits" stays unimplemented until Memberships exists; the port is left unset.
import '../../people/schema.js'
import type { Clock } from '../../../platform/clock.js'
import type { Tx } from '../../../platform/db.js'
import type { NewId } from '../../../platform/ids.js'
import * as realtime from '../../../platform/realtime.js'
import { bizWeekday, minutesOfDay, toBizDate } from '../../../platform/time.js'
import type { EmergencyEffects } from '../ports.js'

export interface CrewAlertOptions {
  clock: Clock
  newId: NewId
  tz: string
}

export async function onShiftUsers(
  tx: Tx,
  o: { locationId: string; now: Date; tz: string },
): Promise<{ userId: string; employeeId: string }[]> {
  const weekday = bizWeekday(toBizDate(o.now, o.tz))
  const nowMin = minutesOfDay(o.now, o.tz)
  const rows = await tx
    .selectFrom('employees as e')
    .innerJoin('users as u', 'u.employee_id', 'e.id')
    .innerJoin('employee_schedules as s', 's.employee_id', 'e.id')
    .select(['u.id as user_id', 'e.id as employee_id'])
    .where('e.status', '=', 'active')
    .where('u.disabled_at', 'is', null)
    .where('s.is_on', '=', true)
    .where('s.weekday', '=', weekday)
    .where('s.from_min', '<=', nowMin)
    .where('s.to_min', '>', nowMin)
    .where((eb) =>
      eb.or([
        eb.exists(
          eb
            .selectFrom('employee_locations as l')
            .select('l.employee_id')
            .whereRef('l.employee_id', '=', 'e.id')
            .where('l.location_id', '=', o.locationId),
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
    .orderBy('e.id')
    .execute()
  return rows.map((r) => ({ userId: r.user_id, employeeId: r.employee_id }))
}

export function createEmergencyEffects(o: CrewAlertOptions): EmergencyEffects {
  return {
    async alertCrew(tx, ctx) {
      const people = await onShiftUsers(tx, { locationId: ctx.locationId, now: o.clock.now(), tz: o.tz })
      for (const p of people) {
        const id = o.newId()
        await tx
          .insertInto('notifications')
          .values({
            id,
            location_id: ctx.locationId,
            employee_id: p.employeeId,
            role_target: null,
            kind: 'emergency',
            title: 'Emergency closure',
            body: ctx.summary,
            entity_type: 'emergency_closure',
            entity_id: ctx.emergencyClosureId,
            read_at: null,
          })
          .execute()
        await realtime.publish(tx, {
          locationId: ctx.locationId,
          channel: 'notifications',
          type: 'notification.new',
          payload: { id, kind: 'emergency' },
          targetUserId: p.userId,
        })
      }
    },
  }
}
