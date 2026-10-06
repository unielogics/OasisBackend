// Employee schedules that stop fitting inside business hours after a Working hours save. The save never moves anything;
// it reports these as warnings (design 4.8) so the manager can fix the schedules.
import '../../people/schema.js'
import type { Tx } from '../../../platform/db.js'
import { scheduleViolations, type DayHours } from '../../people/business-hours.js'
import type { EmployeeScheduleConflict, HoursWarningHooks } from '../hours.js'

export async function employeeScheduleConflicts(
  tx: Tx,
  ctx: {
    locationId: string
    days: readonly { weekday: number; isOpen: boolean; openMin: number; closeMin: number }[]
  },
): Promise<EmployeeScheduleConflict[]> {
  const hours: DayHours[] = ctx.days.map((d) => ({
    weekday: d.weekday,
    open: d.isOpen,
    fromMin: d.openMin,
    toMin: d.closeMin,
  }))
  // Employees are brand-global; one without any location link belongs to the single location.
  const rows = await tx
    .selectFrom('employees as e')
    .innerJoin('employee_schedules as s', 's.employee_id', 'e.id')
    .select(['e.id', 'e.first', 'e.last', 's.weekday', 's.from_min', 's.to_min'])
    .where('e.status', 'in', ['active', 'invited'])
    .where('s.is_on', '=', true)
    .where((eb) =>
      eb.or([
        eb.exists(
          eb
            .selectFrom('employee_locations as l')
            .select('l.employee_id')
            .whereRef('l.employee_id', '=', 'e.id')
            .where('l.location_id', '=', ctx.locationId),
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
    .orderBy('e.first')
    .orderBy('e.id')
    .orderBy('s.weekday')
    .execute()
  const out: EmployeeScheduleConflict[] = []
  for (const r of rows) {
    const [message] = scheduleViolations(
      [{ weekday: r.weekday, on: true, fromMin: r.from_min, toMin: r.to_min }],
      hours,
    )
    if (message)
      out.push({
        employeeId: r.id,
        employeeName: `${r.first} ${r.last}`.trim(),
        weekday: r.weekday,
        message,
      })
  }
  return out
}

export const dbHoursWarningHooks: HoursWarningHooks = { employeeScheduleConflicts }
