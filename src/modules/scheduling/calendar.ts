// Calendar read models: per-date counts (week and month grids) and one day with its hour rows. Counts are real, closed
// days include today, and nothing is silently dropped: bookings outside the open hours or on a closed day are listed.
import { sql } from 'kysely'
import type { Executor } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { addDays, bizDayBounds, bizWeekday, dateLabel, diffDays, fmtT, isValidBizDate, minutesOfDay, toBizDate } from '../../platform/time.js'
import '../customers/schema.js'
import { getActiveEmergency, emergencySnapshot } from '../settings/emergency.js'
import { listLiveClosures } from '../settings/closures.js'
import { dayInfo, type DayInfo } from '../settings/day-info.js'
import { loadBoardRows, sortRows, toCard, type OpsCard } from './board.js'
import { loadSettingsBundle, type SchedulingCtx } from './context.js'
import { listBays } from './appointments.js'

export const MAX_CALENDAR_DAYS = 70

export interface CalendarDaySummary {
  date: string
  weekday: number
  /** Non-canceled, non-no-show appointments that day. */
  count: number
  /** The closure name, "Regular day off" or the emergency name; null on an open day. */
  closed: string | null
  reduced: boolean
  /** "<name> · reduced hours" or "". */
  note: string
  open: { openMin: number; closeMin: number; from: string; to: string } | null
  /** Active (booked, confirmed, arrived) appointments that need moving because the day is closed. */
  needsRebook: number
  isToday: boolean
}

function assertDate(value: string, field: string): void {
  if (!isValidBizDate(value))
    throw new AppError('VALIDATION_FAILED', {
      detail: 'Use a date like 2026-06-13.',
      errors: [{ path: field, message: 'Use a date like 2026-06-13.' }],
    })
}

const toDayView = (d: DayInfo) => ({
  closed: d.closed ? (d.reason ?? 'Closed') : null,
  reduced: d.reduced,
  note: d.note,
  open: d.closed
    ? null
    : { openMin: d.openMin!, closeMin: d.closeMin!, from: fmtT(d.openMin!), to: fmtT(d.closeMin!) },
})

export async function calendarSummary(
  db: Executor,
  c: SchedulingCtx,
  q: { from: string; to: string },
): Promise<{ from: string; to: string; days: CalendarDaySummary[]; total: number }> {
  assertDate(q.from, 'from')
  assertDate(q.to, 'to')
  const span = diffDays(q.from, q.to)
  if (span < 0 || span + 1 > MAX_CALENDAR_DAYS)
    throw new AppError('VALIDATION_FAILED', {
      detail: `Ask for 1 to ${MAX_CALENDAR_DAYS} days.`,
      errors: [{ path: 'to', message: `Ask for 1 to ${MAX_CALENDAR_DAYS} days.` }],
    })
  const now = c.clock.now()
  const today = toBizDate(now, c.tz)
  const [settings, closures, emergency, counts] = await Promise.all([
    loadSettingsBundle(db, c.locationId),
    listLiveClosures(db, c.locationId, { from: q.from, to: q.to }),
    getActiveEmergency(db, c.locationId),
    sql<{ d: string; n: number; active: number }>`
      select d, count(*) filter (where status not in ('canceled', 'no_show'))::int as n,
             count(*) filter (where status in ('booked', 'confirmed', 'arrived'))::int as active
      from (
        select (scheduled_start at time zone ${c.tz})::date as d, status
        from appointments
        where location_id = ${c.locationId}
          and scheduled_start >= ${bizDayBounds(q.from, c.tz).start}
          and scheduled_start < ${bizDayBounds(addDays(q.to, 1), c.tz).start}
      ) x
      group by d`
      .execute(db)
      .then((r) => r.rows),
  ])
  const snap = emergencySnapshot(emergency, c.tz)
  const byDate = new Map(counts.map((r) => [r.d, r]))
  const days: CalendarDaySummary[] = []
  let total = 0
  for (let i = 0; i <= span; i++) {
    const date = addDays(q.from, i)
    const info = dayInfo({ date, hours: settings.hours, closures, emergency: snap })
    const n = byDate.get(date)
    const count = n?.n ?? 0
    total += count
    days.push({
      date,
      weekday: bizWeekday(date),
      count,
      ...toDayView(info),
      needsRebook: info.closed ? (n?.active ?? 0) : 0,
      isToday: date === today,
    })
  }
  return { from: q.from, to: q.to, days, total }
}

export interface CalendarHourRow {
  hour: number
  /** "8" and "AM", as the design's row label. */
  time: string
  ampm: string
  items: OpsCard[]
}

export interface CalendarDayDetail {
  date: string
  /** "Saturday, June 13". */
  label: string
  isToday: boolean
  dayInfo: {
    closed: string | null
    reduced: boolean
    note: string
    source: string
    open: { openMin: number; closeMin: number; from: string; to: string } | null
    h0: number | null
    h1: number | null
  }
  /** "Today · 11 appointments · 8:00 AM – 5:00 PM", or "Closed". */
  sub: string
  count: number
  rows: CalendarHourRow[]
  /** Appointments the hour rows cannot show (closed day, before opening, after closing). */
  outsideHours: OpsCard[]
  appointments: OpsCard[]
}

export async function calendarDay(db: Executor, c: SchedulingCtx, date: string): Promise<CalendarDayDetail> {
  assertDate(date, 'date')
  const now = c.clock.now()
  const today = toBizDate(now, c.tz)
  const { start, end } = bizDayBounds(date, c.tz)
  const [settings, closures, emergency, rows, bays] = await Promise.all([
    loadSettingsBundle(db, c.locationId),
    listLiveClosures(db, c.locationId, { from: date, to: date }),
    getActiveEmergency(db, c.locationId),
    loadBoardRows(db, c, { from: start, to: end }),
    listBays(db, c.locationId),
  ])
  const info = dayInfo({ date, hours: settings.hours, closures, emergency: emergencySnapshot(emergency, c.tz) })
  const index = { byId: new Map(bays.map((b) => [b.id, { id: b.id, number: b.number }])) }
  const cards = sortRows(rows).map((r) => toCard(r, { now, tz: c.tz, lateGraceMin: settings.ops.lateGraceMin, bays: index }))
  const hourOf = (card: OpsCard): number => Math.floor(minutesOfDay(new Date(card.startsAt), c.tz) / 60)
  const shown = (card: OpsCard): boolean => !info.closed && hourOf(card) >= info.h0! && hourOf(card) < info.h1!
  const hourRows: CalendarHourRow[] = []
  if (!info.closed)
    for (let h = info.h0!; h < info.h1!; h++) {
      const hh = h % 12 === 0 ? 12 : h % 12
      hourRows.push({ hour: h, time: String(hh), ampm: h >= 12 ? 'PM' : 'AM', items: cards.filter((x) => hourOf(x) === h) })
    }
  const view = toDayView(info)
  const sub = info.closed
    ? 'Closed'
    : `${date === today ? 'Today · ' : ''}${cards.length} appointment${cards.length === 1 ? '' : 's'} · ${info.note ? `${info.note} · ` : ''}${fmtT(info.h0! * 60)} – ${fmtT(info.h1! * 60)}`
  return {
    date,
    // the year is appended only when it is not the current one, as the design does for 2026
    label: `${dateLabel(start, c.tz)}${date.slice(0, 4) === today.slice(0, 4) ? '' : `, ${date.slice(0, 4)}`}`,
    isToday: date === today,
    dayInfo: { closed: view.closed, reduced: view.reduced, note: view.note, source: info.source, open: view.open, h0: info.h0, h1: info.h1 },
    sub,
    count: cards.length,
    rows: hourRows,
    outsideHours: cards.filter((x) => !shown(x)),
    appointments: cards,
  }
}
