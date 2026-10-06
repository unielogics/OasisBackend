// Business-date ranges and the labels the Payments design shows for them. All in the business timezone: a range is a
// set of inclusive calendar days ending today, an invoice belongs to it by its biz_date (not by when money moved).
import { DateTime } from 'luxon'
import { addDays, bizWeekday, dateLabel, toBizDate } from '../../platform/time.js'

export const RANGE_KEYS = ['today', '7d', '30d', 'mtd'] as const
export type RangeKey = (typeof RANGE_KEYS)[number]

export interface ResolvedRange {
  key: RangeKey
  from: string
  to: string
  label: string
}

const civil = (d: string): DateTime => DateTime.fromISO(d, { zone: 'utc' }).setLocale('en-US')

/** "Jun 7" (the year is added only when it differs from the reference year). */
export function shortDate(d: string, refYear?: number): string {
  const dt = civil(d)
  return dt.toFormat(refYear !== undefined && dt.year !== refYear ? 'LLL d, yyyy' : 'LLL d')
}

export function resolveRange(key: RangeKey, now: Date, tz: string): ResolvedRange {
  const to = toBizDate(now, tz)
  const from =
    key === 'today'
      ? to
      : key === '7d'
        ? addDays(to, -6)
        : key === '30d'
          ? addDays(to, -29)
          : `${to.slice(0, 8)}01`
  const year = civil(to).year
  const label = key === 'today' ? dateLabel(now, tz) : `${shortDate(from, year)} – ${shortDate(to, year)}`
  return { key, from, to, label }
}

/** Every business date from..to inclusive. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
  return out
}

/** "Today" / "Yesterday" / "Jun 11" for a business date relative to today. */
export function dayLabel(bizDate: string, today: string): string {
  if (bizDate === today) return 'Today'
  if (bizDate === addDays(today, -1)) return 'Yesterday'
  return shortDate(bizDate, civil(today).year)
}

/** Daily chart label of the design: "S 7" for 7d/mtd, a bare day number every third day for 30d. */
export function dayBucketLabel(bizDate: string, spanDays: number): string {
  const day = civil(bizDate).day
  if (spanDays > 14) return day % 3 === 1 ? String(day) : ''
  return `${['S', 'M', 'T', 'W', 'T', 'F', 'S'][bizWeekday(bizDate)]} ${day}`
}

/** JS Date.toDateString() style ("Sun Jun 07 2026"), the design's bar tooltip title. */
export const dayBucketTitle = (bizDate: string): string => civil(bizDate).toFormat('ccc LLL dd yyyy')

/** "8a", "12p", "5p". */
export const hourBucketLabel = (h: number): string => `${h % 12 || 12}${h >= 12 ? 'p' : 'a'}`
