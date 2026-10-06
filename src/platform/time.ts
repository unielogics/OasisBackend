// Business-timezone helpers. Instants are UTC; "today", hours, closures and weekdays are computed in the
// business tz (locations.timezone, America/New_York). Business dates are plain 'YYYY-MM-DD' strings and
// wall-clock times are minutes from midnight, so no helper here ever shifts a calendar date by a UTC offset.
import { DateTime, IANAZone } from 'luxon'

export const DEFAULT_TZ = 'America/New_York'

const BIZ_DATE = /^\d{4}-\d{2}-\d{2}$/

export function isValidTimeZone(tz: string): boolean {
  return IANAZone.isValidZone(tz)
}

export function isValidBizDate(s: string): boolean {
  return BIZ_DATE.test(s) && DateTime.fromISO(s, { zone: 'utc' }).isValid
}

function at(instant: Date, tz: string): DateTime {
  const dt = DateTime.fromJSDate(instant, { zone: tz })
  if (!dt.isValid) throw new RangeError(`Invalid instant or time zone (${tz})`)
  return dt
}

function civil(bizDate: string): DateTime {
  if (!BIZ_DATE.test(bizDate)) throw new RangeError(`Invalid business date: ${bizDate}`)
  const dt = DateTime.fromISO(bizDate, { zone: 'utc' })
  if (!dt.isValid) throw new RangeError(`Invalid business date: ${bizDate}`)
  return dt
}

/** The business date (YYYY-MM-DD) of an instant. */
export function toBizDate(instant: Date, tz: string = DEFAULT_TZ): string {
  return at(instant, tz).toFormat('yyyy-LL-dd')
}

/** Weekday of a business date, Sunday = 0 (matches business_hours.weekday). */
export function bizWeekday(bizDate: string): number {
  return civil(bizDate).weekday % 7
}

export function addDays(bizDate: string, days: number): string {
  return civil(bizDate).plus({ days }).toFormat('yyyy-LL-dd')
}

/** Whole days from a to b (b - a), calendar based. */
export function diffDays(a: string, b: string): number {
  return Math.round(civil(b).diff(civil(a), 'days').days)
}

/** Minutes from local midnight, wall-clock (DST aware: 1:30 AM after fall-back is still 90). */
export function minutesOfDay(instant: Date, tz: string = DEFAULT_TZ): number {
  const dt = at(instant, tz)
  return dt.hour * 60 + dt.minute
}

/** [start, end) of a business day as UTC instants; 23, 24 or 25 hours long on DST days. */
export function bizDayBounds(bizDate: string, tz: string = DEFAULT_TZ): { start: Date; end: Date } {
  const start = DateTime.fromISO(bizDate, { zone: tz }).startOf('day')
  if (!start.isValid) throw new RangeError(`Invalid business date or time zone: ${bizDate} ${tz}`)
  const end = start.plus({ days: 1 }).startOf('day')
  return { start: start.toJSDate(), end: end.toJSDate() }
}

export function dayLengthMinutes(bizDate: string, tz: string = DEFAULT_TZ): number {
  const { start, end } = bizDayBounds(bizDate, tz)
  return Math.round((end.getTime() - start.getTime()) / 60_000)
}

/**
 * The instant at which the wall clock in `tz` reads `minutes` on `bizDate`.
 * A time skipped by spring-forward lands after the gap; an ambiguous fall-back time resolves to the first occurrence.
 */
export function wallToInstant(bizDate: string, minutes: number, tz: string = DEFAULT_TZ): Date {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= 24 * 60) {
    throw new RangeError(`Invalid minutes from midnight: ${minutes}`)
  }
  const dt = DateTime.fromISO(bizDate, { zone: tz }).set({
    hour: Math.floor(minutes / 60),
    minute: minutes % 60,
  })
  if (!dt.isValid) throw new RangeError(`Invalid business date or time zone: ${bizDate} ${tz}`)
  return dt.toJSDate()
}

/** h:mm AM/PM with no zero-padded hour. Values wrap modulo 24 h (an ETA past midnight shows the next day's time). */
export function fmtT(min: number): string {
  if (!Number.isFinite(min)) throw new RangeError(`Invalid minutes: ${min}`)
  const m = ((Math.round(min) % 1440) + 1440) % 1440
  const h24 = Math.floor(m / 60)
  const mm = String(m % 60).padStart(2, '0')
  return `${h24 % 12 || 12}:${mm} ${h24 < 12 ? 'AM' : 'PM'}`
}

const T_RE = /^\s*(\d{1,2}):(\d{2})\s*([AaPp])[Mm]\s*$/

/** Inverse of fmtT; returns null when the text is not h:mm AM/PM. */
export function tryParseT(text: string): number | null {
  const m = T_RE.exec(text)
  if (!m) return null
  const h = Number(m[1])
  const mm = Number(m[2])
  if (h < 1 || h > 12 || mm > 59) return null
  return (h % 12) * 60 + mm + (m[3]!.toLowerCase() === 'p' ? 720 : 0)
}

export function parseT(text: string): number {
  const v = tryParseT(text)
  if (v === null) throw new RangeError(`Invalid time of day: "${text}"`)
  return v
}

/** Wall-clock label of an instant, e.g. "10:36 AM". */
export function clockLabel(instant: Date, tz: string = DEFAULT_TZ): string {
  return fmtT(minutesOfDay(instant, tz))
}

/** "Saturday, June 13". */
export function dateLabel(instant: Date, tz: string = DEFAULT_TZ): string {
  return at(instant, tz).setLocale('en-US').toFormat('cccc, LLLL d')
}

/**
 * Ledger/timeline label: "Today 3:07 PM", "Yesterday 4:40 PM", otherwise "Jun 11 · 9:12 AM".
 * The year is appended ("Dec 30, 2025 · 9:12 AM") only when it differs from the reference year.
 */
export function atLabel(instant: Date, now: Date, tz: string = DEFAULT_TZ): string {
  const dt = at(instant, tz).setLocale('en-US')
  const day = dt.toFormat('yyyy-LL-dd')
  const today = toBizDate(now, tz)
  const time = fmtT(dt.hour * 60 + dt.minute)
  if (day === today) return `Today ${time}`
  if (day === addDays(today, -1)) return `Yesterday ${time}`
  const sameYear = dt.year === at(now, tz).year
  return `${dt.toFormat(sameYear ? 'LLL d' : 'LLL d, yyyy')} · ${time}`
}

export interface NowInfo {
  now: string
  tz: string
  bizDate: string
  weekday: number
  minutes: number
  dateLabel: string
}

/** Payload of GET /api/v1/meta/now. */
export function nowInfo(instant: Date, tz: string = DEFAULT_TZ): NowInfo {
  const bizDate = toBizDate(instant, tz)
  return {
    now: instant.toISOString(),
    tz,
    bizDate,
    weekday: bizWeekday(bizDate),
    minutes: minutesOfDay(instant, tz),
    dateLabel: dateLabel(instant, tz),
  }
}

/** ISO-8601 with the business offset, e.g. 2026-06-13T10:36:00-04:00 (used in CSV and parity fixtures). */
export function isoInTz(instant: Date, tz: string = DEFAULT_TZ): string {
  return at(instant, tz).toFormat("yyyy-LL-dd'T'HH:mm:ssZZ")
}
