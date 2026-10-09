// publicHoursView(): the opening hours as the public website shows them, computed from the same rows and the same dayInfo() the
// dashboard uses (weekly hours, planned closures, the active emergency), so the site and the shop never disagree. Pure: the route
// loads the rows and passes the clock. It carries no personal or operations data: no appointment counts, no names of people, no
// message text, no row ids (ADR 0145).
import { addDays, fmtT, minutesOfDay, toBizDate } from '../../platform/time.js'
import { dayInfo, type DayInfo, type DayInfoInput, type EmergencySnapshot } from './day-info.js'
import type { HoursDay } from './hours.js'
import { DAY_NAMES, weekdayMonthDay } from './labels.js'

/** How many days ahead the view looks for closures and the next open day (today included). */
export const PUBLIC_HOURS_DAYS = 14

export type PublicDayState = 'open' | 'opens_later' | 'closed'

export interface PublicDay {
  date: string
  weekday: number
  day: string
  closed: boolean
  /** Effective window of that day in minutes from midnight; null when closed. */
  openMin: number | null
  closeMin: number | null
  opensAt: string | null
  closesAt: string | null
  /** "Regular day off", the closure's name, or the emergency closure's name; null on an ordinary open day. */
  reason: string | null
  reduced: boolean
  emergency: boolean
}

export interface PublicToday extends PublicDay {
  openNow: boolean
  /** open: between the day's open and close; opens_later: before opening; closed: a closed day, or after closing. */
  state: PublicDayState
}

export interface PublicWeekDay {
  weekday: number
  day: string
  open: boolean
  from: string | null
  to: string | null
  fromMin: number | null
  toMin: number | null
}

export interface PublicClosure {
  date: string
  /** "Monday, Sep 7". */
  dateLabel: string
  name: string
  type: 'closed' | 'reduced'
  from?: string
  to?: string
}

export interface PublicHours {
  tz: string
  generatedAt: string
  today: PublicToday
  /** The next day the shop opens after today (within PUBLIC_HOURS_DAYS), or null when none is in sight. */
  next: PublicDay | null
  /** The regular week, Sunday first. */
  week: PublicWeekDay[]
  /** Days in the next PUBLIC_HOURS_DAYS (today included) that differ from the regular week: closed or reduced. */
  closures: PublicClosure[]
}

export interface PublicHoursInput {
  now: Date
  tz: string
  hours: readonly HoursDay[]
  closures: DayInfoInput['closures']
  emergency?: EmergencySnapshot | null
}

const publicDay = (info: DayInfo): PublicDay => ({
  date: info.date,
  weekday: info.weekday,
  day: DAY_NAMES[info.weekday]!,
  closed: info.closed,
  openMin: info.openMin,
  closeMin: info.closeMin,
  opensAt: info.openMin === null ? null : fmtT(info.openMin),
  closesAt: info.closeMin === null ? null : fmtT(info.closeMin),
  reason: info.reason,
  reduced: info.reduced,
  emergency: info.emergency,
})

export function publicHoursView(input: PublicHoursInput): PublicHours {
  const today = toBizDate(input.now, input.tz)
  const nowMin = minutesOfDay(input.now, input.tz)
  const info = (date: string): DayInfo =>
    dayInfo({ date, hours: input.hours, closures: input.closures, emergency: input.emergency ?? null })

  const t = info(today)
  let state: PublicDayState = 'closed'
  if (!t.closed) {
    if (nowMin < t.openMin!) state = 'opens_later'
    else if (nowMin < t.closeMin!) state = 'open'
  }

  let next: PublicDay | null = null
  const closures: PublicClosure[] = []
  for (let d = 0; d < PUBLIC_HOURS_DAYS; d++) {
    const date = addDays(today, d)
    const i = d === 0 ? t : info(date)
    if (d > 0 && next === null && !i.closed) next = publicDay(i)
    if (i.source === 'closure' || i.source === 'emergency') {
      const name = i.reason ?? ''
      closures.push(
        i.closed
          ? { date, dateLabel: weekdayMonthDay(date), name, type: 'closed' }
          : {
              date,
              dateLabel: weekdayMonthDay(date),
              name,
              type: 'reduced',
              from: fmtT(i.openMin!),
              to: fmtT(i.closeMin!),
            },
      )
    }
  }

  const week: PublicWeekDay[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) => {
    const h = input.hours.find((x) => x.weekday === weekday)
    const open = h?.isOpen ?? false
    return {
      weekday,
      day: DAY_NAMES[weekday]!,
      open,
      from: open ? fmtT(h!.openMin) : null,
      to: open ? fmtT(h!.closeMin) : null,
      fromMin: open ? h!.openMin : null,
      toMin: open ? h!.closeMin : null,
    }
  })

  return {
    tz: input.tz,
    generatedAt: input.now.toISOString(),
    today: { ...publicDay(t), openNow: state === 'open', state },
    next,
    week,
    closures,
  }
}
