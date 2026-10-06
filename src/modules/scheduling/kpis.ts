// The seven KPI tiles, every number computed (backend design 4.5 with the review's definitions). Search and range tabs
// never affect them. "24h" is today plus tomorrow in the business tz.
//
//   Appointments 24h   non-canceled, non-no-show jobs today and tomorrow; sub "N booked" = upcoming booked + confirmed
//   Active jobs        jobs in a bay now                        ("in bays")
//   Ready for pickup   completed, not collected, bounded to yesterday..tomorrow   ("notify" or "clear")
//   Pending payments   today's jobs with a balance; sub = the sum of those balances
//   Bay time free      free bay-minutes left in today's open window, shown "2.8h"          ("today")
//   Members today      today's jobs of active members ("of N")
//   Revenue today      cash basis (the payments module's events of today); without that port, the fully paid invoices of
//                      today's jobs (the design's own definition)
import { formatUsdOps } from '../../platform/money.js'
import type { Executor } from '../../platform/db.js'
import { addDays, bizDayBounds, toBizDate, wallToInstant } from '../../platform/time.js'
import type { BoardRow } from './board.js'
import { loadBoardRows } from './board.js'
import type { SchedulingCtx } from './context.js'
import { loadDayData } from './availability-loader.js'
import { MS_PER_MIN } from './availability.js'

export type KpiKey =
  | 'appointments24h'
  | 'activeJobs'
  | 'readyForPickup'
  | 'pendingPayments'
  | 'bayTimeFree'
  | 'membersToday'
  | 'revenueToday'

export interface Kpi {
  key: KpiKey
  label: string
  value: string
  sub: string
  /** The number behind the value (count, minutes or cents). */
  raw: number
}

export interface KpiInputs {
  now: Date
  tz: string
  /** Rows from yesterday's start through the end of tomorrow. */
  rows: readonly BoardRow[]
  /** Today's open window (null when closed), bays that can take a car, buffer between jobs. */
  openMin: number | null
  closeMin: number | null
  activeBays: number
  bufferMin: number
  revenueTodayCents: number
}

const OUT = new Set(['canceled', 'no_show'])

/** Free bay-minutes left today: remaining open time of every active bay minus what the day still commits. */
export function bayMinutesFree(i: {
  now: Date
  tz: string
  openMin: number | null
  closeMin: number | null
  activeBays: number
  bufferMin: number
  jobs: readonly {
    status: string
    start: Date
    end: Date
    cleaningStartedAt: Date | null
    durationMin: number
  }[]
}): number {
  if (i.openMin === null || i.closeMin === null || i.activeBays === 0) return 0
  const date = toBizDate(i.now, i.tz)
  const openAt = wallToInstant(date, i.openMin, i.tz).getTime()
  const closeAt = wallToInstant(date, i.closeMin, i.tz).getTime()
  const from = Math.max(i.now.getTime(), openAt)
  if (closeAt <= from) return 0
  const remaining = ((closeAt - from) / MS_PER_MIN) * i.activeBays
  const buffer = i.bufferMin * MS_PER_MIN
  let committed = 0
  for (const j of i.jobs) {
    let s: number
    let e: number
    if (j.status === 'cleaning') {
      const began = (j.cleaningStartedAt ?? j.start).getTime()
      s = from
      e = Math.max(began + j.durationMin * MS_PER_MIN, i.now.getTime()) + buffer
    } else if (j.status === 'booked' || j.status === 'confirmed' || j.status === 'arrived') {
      s = Math.max(j.start.getTime(), from)
      e = j.end.getTime() + buffer
    } else continue
    const cs = Math.max(s, from)
    const ce = Math.min(e, closeAt)
    if (ce > cs) committed += (ce - cs) / MS_PER_MIN
  }
  return Math.max(0, Math.round(remaining - committed))
}

/** "2.8h": tenths of an hour, no trailing zero (the design showed "3.5h"). */
export const hoursLabel = (minutes: number): string => `${Math.round(minutes / 6) / 10}h`

export function computeKpis(i: KpiInputs): Kpi[] {
  const today = toBizDate(i.now, i.tz)
  const tomorrow = addDays(today, 1)
  const dayOf = (r: BoardRow): string => toBizDate(r.a.scheduledStart, i.tz)
  const window = i.rows.filter((r) => !OUT.has(r.a.status) && [today, tomorrow].includes(dayOf(r)))
  const todayRows = window.filter((r) => dayOf(r) === today)
  const booked = window.filter((r) => r.a.status === 'booked' || r.a.status === 'confirmed').length
  const active = i.rows.filter((r) => r.a.status === 'cleaning').length
  const ready = i.rows.filter((r) => r.a.status === 'completed' && r.a.pickupState !== 'collected').length
  const pending = todayRows.filter((r) => (r.invoice?.balanceCents ?? 0) > 0)
  const pendingSum = pending.reduce((n, r) => n + r.invoice!.balanceCents, 0)
  const members = todayRows.filter((r) => r.member !== null).length
  const free = bayMinutesFree({
    now: i.now,
    tz: i.tz,
    openMin: i.openMin,
    closeMin: i.closeMin,
    activeBays: i.activeBays,
    bufferMin: i.bufferMin,
    jobs: todayRows.map((r) => ({
      status: r.a.status,
      start: r.a.scheduledStart,
      end: r.a.scheduledEnd,
      cleaningStartedAt: r.a.cleaningStartedAt,
      durationMin: r.a.durationMin,
    })),
  })
  return [
    {
      key: 'appointments24h',
      label: 'Appointments 24h',
      value: String(window.length),
      sub: `${booked} booked`,
      raw: window.length,
    },
    { key: 'activeJobs', label: 'Active jobs', value: String(active), sub: 'in bays', raw: active },
    {
      key: 'readyForPickup',
      label: 'Ready for pickup',
      value: String(ready),
      sub: ready > 0 ? 'notify' : 'clear',
      raw: ready,
    },
    {
      key: 'pendingPayments',
      label: 'Pending payments',
      value: String(pending.length),
      sub: formatUsdOps(pendingSum),
      raw: pendingSum,
    },
    { key: 'bayTimeFree', label: 'Bay time free', value: hoursLabel(free), sub: 'today', raw: free },
    {
      key: 'membersToday',
      label: 'Members today',
      value: String(members),
      sub: `of ${todayRows.length}`,
      raw: members,
    },
    {
      key: 'revenueToday',
      label: 'Revenue today',
      value: formatUsdOps(i.revenueTodayCents),
      sub: 'paid',
      raw: i.revenueTodayCents,
    },
  ]
}

/** The rows the KPIs and alerts read: yesterday's start through the end of tomorrow, plus anything in a bay. */
export async function loadOpsRows(db: Executor, c: SchedulingCtx, now: Date): Promise<BoardRow[]> {
  const today = toBizDate(now, c.tz)
  return loadBoardRows(db, c, {
    from: bizDayBounds(addDays(today, -1), c.tz).start,
    to: bizDayBounds(addDays(today, 2), c.tz).start,
    includeCleaning: true,
  })
}

export async function loadKpis(db: Executor, c: SchedulingCtx, preloaded?: BoardRow[]): Promise<Kpi[]> {
  const now = c.clock.now()
  const today = toBizDate(now, c.tz)
  const [rows, data] = await Promise.all([
    preloaded ? Promise.resolve(preloaded) : loadOpsRows(db, c, now),
    loadDayData(db, { locationId: c.locationId, tz: c.tz, now, date: today }),
  ])
  const { start, end } = bizDayBounds(today, c.tz)
  let revenue: number
  if (c.ports.revenue) revenue = await c.ports.revenue.revenueCents(db, c.locationId, start, end)
  else
    revenue = rows
      .filter((r) => toBizDate(r.a.scheduledStart, c.tz) === today && !OUT.has(r.a.status))
      .filter((r) => r.invoice?.status === 'paid')
      .reduce((n, r) => n + r.invoice!.paidCents, 0)
  return computeKpis({
    now,
    tz: c.tz,
    rows,
    openMin: data.day.closed ? null : data.day.openMin,
    closeMin: data.day.closed ? null : data.day.closeMin,
    activeBays: data.activeBays,
    bufferMin: data.settings.rules.bufferMinutes,
    revenueTodayCents: revenue,
  })
}
