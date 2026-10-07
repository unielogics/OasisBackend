// The dates of a standing series (pure). weekly, biweekly and triweekly step 7, 14 and 21 days from the start date; monthly
// repeats on the same weekday and the same occurrence in the month as the start date (the 2nd Saturday stays the 2nd Saturday;
// a 5th weekday becomes the last one of shorter months). All dates are business dates, 'YYYY-MM-DD'.
import { DateTime } from 'luxon'
import type { Cadence } from './schema.js'

const civil = (d: string): DateTime => DateTime.fromISO(d, { zone: 'utc' })
const iso = (d: DateTime): string => d.toFormat('yyyy-LL-dd')

export const CADENCE_DAYS: Record<Exclude<Cadence, 'monthly'>, number> = {
  weekly: 7,
  biweekly: 14,
  triweekly: 21,
}

/** 0 = Sunday ... 6 = Saturday. */
export const weekdayOf = (date: string): number => civil(date).weekday % 7

/** 1 for the first weekday of its month ... 5 for the fifth. */
export const ordinalOf = (date: string): number => Math.ceil(civil(date).day / 7)

/** The `ordinal`th `weekday` of the month containing `anchor`; ordinal 5 falls back to the last one when the month has no fifth. */
export function nthWeekdayOfMonth(year: number, month: number, weekday: number, ordinal: number): string {
  const first = DateTime.utc(year, month, 1)
  const offset = (weekday - (first.weekday % 7) + 7) % 7
  let day = 1 + offset + (ordinal - 1) * 7
  while (day > first.daysInMonth!) day -= 7
  return iso(first.set({ day }))
}

export interface SeriesShape {
  cadence: Cadence
  startDate: string
  endDate: string | null
}

/** Every occurrence date of the series in [from, through], inclusive, ascending. */
export function occurrenceDates(s: SeriesShape, from: string, through: string): string[] {
  const last = s.endDate && s.endDate < through ? s.endDate : through
  const out: string[] = []
  if (s.cadence !== 'monthly') {
    const step = CADENCE_DAYS[s.cadence]
    for (let d = civil(s.startDate); iso(d) <= last; d = d.plus({ days: step })) {
      const x = iso(d)
      if (x >= from) out.push(x)
    }
    return out
  }
  const weekday = weekdayOf(s.startDate)
  const ordinal = ordinalOf(s.startDate)
  const start = civil(s.startDate)
  for (let m = start.startOf('month'); iso(m) <= last; m = m.plus({ months: 1 })) {
    const x = nthWeekdayOfMonth(m.year, m.month, weekday, ordinal)
    if (x >= s.startDate && x >= from && x <= last) out.push(x)
  }
  return out
}
