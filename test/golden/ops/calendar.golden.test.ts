// Oracle: the original's calendar (counts for -210..+210 days, and the week, month and day views as rendered) against
// /calendar/summary and /calendar/day for the parity-ops seed. Procedural days are real rows, so counts reproduce; the one
// deviation is tomorrow, which the design counts as 4 procedural jobs + a12 while its board lists only a12.
import { describe, expect, it } from 'vitest'
import { addDays, bizWeekday } from '../../../src/platform/time.js'
import { calendarDay, calendarSummary, type CalendarDaySummary } from '../../../src/modules/scheduling/calendar.js'
import { asDeviations, diff } from './diff.js'
import { original, useParityOps, type CalendarShot } from './parity.js'

const w = useParityOps()
const BASE = '2026-06-13'
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

const dateOf = (offset: number): string => addDays(BASE, offset)
const offsetOf = (date: string): number => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${BASE}T00:00:00Z`)) / 86_400_000)

async function summary(from: string, to: string): Promise<CalendarDaySummary[]> {
  return (await calendarSummary(w.t.db, w.ctx, { from, to })).days
}

/** The design's week cell from the API's day (what the dashboard derives). */
const weekCell = (d: CalendarDaySummary) => ({
  dow: DOW[d.weekday]!,
  num: String(Number(d.date.slice(8))),
  count: String(d.count),
  countLabel: d.count === 1 ? 'appointment' : 'appointments',
  closed: d.closed !== null,
  reason: d.closed ?? '',
  isToday: d.isToday,
})

const monthCell = (d: CalendarDaySummary, inMonth: boolean) => ({
  num: String(Number(d.date.slice(8))),
  showCount: d.closed === null && d.count > 0,
  countLabel: `${d.count} ${d.count === 1 ? 'appt' : 'appts'}`,
  closed: d.closed !== null && inMonth,
  reason: d.closed ?? '',
})

describe('per-date counts (countFor / dayInfo for -210..+210 days)', () => {
  it('real rows reproduce every count, closure and reduced window; tomorrow is the one deviation', async () => {
    // the summary is limited to 70 days per call: walk the range in chunks
    const all: CalendarDaySummary[] = []
    for (let o = -210; o <= 210; o += 70) {
      const to = Math.min(o + 69, 210)
      all.push(...(await summary(dateOf(o), dateOf(to))))
    }
    const got = all.map((d) => ({
      offset: offsetOf(d.date),
      iso: d.date,
      count: d.count,
      closed: d.closed,
      note: d.note,
      h0: d.open ? Math.floor(d.open.openMin / 60) : null,
      h1: d.open ? Math.ceil(d.open.closeMin / 60) : null,
    }))
    const want = original.dayCounts
    const byOffset = new Map(got.map((g) => [g.offset, g]))
    expect(want.length).toBe(421)
    const diffs: Record<string, unknown> = {}
    for (const o of want) {
      const g = byOffset.get(o.offset)!
      for (const d of diff(o, g)) diffs[`${o.offset}.${d.path}`] = [d.original, d.actual]
    }
    expect(diffs).toEqual({ '1.count': [5, 1] })
    // sanity: the design really has closed days and a reduced day in range
    expect(want.filter((d) => d.closed !== null).map((d) => d.closed)).toEqual(
      expect.arrayContaining(['Independence Day', 'Thanksgiving', 'Christmas Day']),
    )
    expect(want.some((d) => d.note.includes('reduced hours'))).toBe(true)
  })
})

describe('the calendar as rendered', () => {
  const shots = Object.entries(original.calendar)

  it.each(shots.filter(([k]) => k.startsWith('week:')))('%s', async (key, shot: CalendarShot) => {
    const k = Number(key.slice(5))
    // the week containing today + 7k, Sunday first
    const anchor = dateOf(7 * k)
    const start = addDays(anchor, -bizWeekday(anchor))
    const days = await summary(start, addDays(start, 6))
    const got = days.map(weekCell)
    const total = days.reduce((n, d) => n + d.count, 0)
    const want = shot.calWeek
    const dev = asDeviations(diff(want, got))
    // week:+1 is June 14-20: Sunday June 14 is tomorrow
    expect(dev).toEqual(
      key === 'week:+1'
        ? { '[0].count': ['5', '1'], '[0].countLabel': ['appointments', 'appointment'] }
        : {},
    )
    expect(shot.calSub).toBe(`${total + (key === 'week:+1' ? 4 : 0)} appointments this week · tap a day to open it`)
  })

  it.each(shots.filter(([k]) => k.startsWith('month:')))('%s', async (key, shot: CalendarShot) => {
    const [label] = [shot.calLabel]
    const [monthName, year] = label.split(' ')
    const m = MONTHS.indexOf(monthName!)
    const first = `${year}-${String(m + 1).padStart(2, '0')}-01`
    const lead = bizWeekday(first)
    const dim = new Date(Date.UTC(Number(year), m + 1, 0)).getUTCDate()
    const cells = Math.ceil((lead + dim) / 7) * 7
    const from = addDays(first, -lead)
    const days = await summary(from, addDays(from, cells - 1))
    const got = days.map((d) => monthCell(d, d.date.startsWith(first.slice(0, 7))))
    const inMonthTotal = days.filter((d) => d.date.startsWith(first.slice(0, 7))).reduce((n, d) => n + d.count, 0)
    const dev = asDeviations(diff(shot.calMonth, got))
    const june = key === 'month:0'
    const tomorrowCell = days.findIndex((d) => d.date === dateOf(1))
    expect(dev).toEqual(june ? { [`[${tomorrowCell}].countLabel`]: ['5 appts', '1 appt'] } : {})
    expect(shot.calSub).toBe(`${inMonthTotal + (june ? 4 : 0)} appointments in ${monthName} · tap a date to open it`)
  })

  it.each(shots.filter(([k]) => k.startsWith('day:')))('%s', async (key, shot: CalendarShot) => {
    const off = Number(key.slice(4))
    const day = await calendarDay(w.t.db, w.ctx, dateOf(off))
    const got = {
      calLabel: day.label,
      calSub: day.sub,
      calClosed: day.dayInfo.closed !== null,
      calClosedReason: day.dayInfo.closed ?? '',
      calRows: day.rows.map((r) => ({
        time: r.time,
        ampm: r.ampm,
        empty: r.items.length === 0,
        items: r.items.map((i) => ({ name: i.customer.name, badgeLabel: i.badge.label })),
      })),
    }
    const { calWeek, calMonth, ...want } = shot
    void calWeek
    void calMonth
    const dev = asDeviations(diff(want, got))
    if (key === 'day:+1') {
      // the design adds four procedural jobs to tomorrow's grid; the backend has only a12
      expect(want.calRows.flatMap((r) => r.items).length).toBe(5)
      expect(got.calRows.flatMap((r) => r.items)).toEqual([{ name: 'Nathan Brooks', badgeLabel: 'Confirmed' }])
      expect(dev['calSub']).toEqual([expect.stringContaining('5 appointments'), expect.stringContaining('1 appointment ·')])
    } else expect(dev).toEqual({})
    expect(day.outsideHours).toEqual([])
  })
})
