// The Settings module owns business hours; people only needs to ask "when is the shop open on this weekday". This port
// is the seam. Until real hours exist the default reports "not configured" and employee schedules are saved with a
// warning instead of being validated.
import { fmtT } from '../../platform/time.js'

export interface DayHours {
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number
  open: boolean
  fromMin: number
  toMin: number
}

export interface BusinessHoursPort {
  /** Seven days for the location, or null when hours are not configured. */
  get(locationId: string): Promise<DayHours[] | null>
}

export const unconfiguredBusinessHours: BusinessHoursPort = { get: async () => null }

export class InMemoryBusinessHours implements BusinessHoursPort {
  private readonly byLocation = new Map<string, DayHours[]>()

  set(locationId: string, days: DayHours[]): void {
    this.byLocation.set(
      locationId,
      days.map((d) => ({ ...d })),
    )
  }

  clear(): void {
    this.byLocation.clear()
  }

  async get(locationId: string): Promise<DayHours[] | null> {
    return this.byLocation.get(locationId) ?? null
  }
}

/** Design hours: Sun 9-3, Mon-Fri 8-6, Sat 8-5. */
export function designBusinessHours(): DayHours[] {
  return [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    open: true,
    fromMin: weekday === 0 ? 540 : 480,
    toMin: weekday === 0 ? 900 : weekday === 6 ? 1020 : 1080,
  }))
}

export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

export interface ScheduleDay {
  weekday: number
  on: boolean
  fromMin: number
  toMin: number
}

/** "{Day}: availability must sit inside business hours ({from} – {to})." for every day outside the hours. */
export function scheduleViolations(schedule: readonly ScheduleDay[], hours: readonly DayHours[]): string[] {
  const out: string[] = []
  for (const s of schedule) {
    if (!s.on) continue
    const h = hours.find((x) => x.weekday === s.weekday)
    const range = h?.open ? `${fmtT(h.fromMin)} – ${fmtT(h.toMin)}` : 'closed'
    const inside = h?.open && s.fromMin >= h.fromMin && s.toMin <= h.toMin
    if (!inside) out.push(`${DAY_NAMES[s.weekday]}: availability must sit inside business hours (${range}).`)
  }
  return out
}
