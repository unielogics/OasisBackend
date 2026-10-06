// DB implementation of the people module's BusinessHoursPort: employee schedules are validated against the hours that
// Working hours actually stores (design defaults when the location has no rows yet).
import type { Executor } from '../../../platform/db.js'
import type { BusinessHoursPort, DayHours } from '../../people/business-hours.js'
import { getHours } from '../hours.js'

export class DbBusinessHours implements BusinessHoursPort {
  constructor(private readonly db: Executor) {}

  async get(locationId: string): Promise<DayHours[] | null> {
    const days = await getHours(this.db, locationId)
    return days.map((d) => ({ weekday: d.weekday, open: d.isOpen, fromMin: d.openMin, toMin: d.closeMin }))
  }
}
