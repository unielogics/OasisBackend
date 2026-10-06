// GET /ops/snapshot: one call for the whole board (backend design 5.3). KPIs, alerts, bays and arrivals ignore the
// search box and the range tab; the lists (timeline, completed, queue, staff columns) follow both.
import type { Executor } from '../../platform/db.js'
import { addDays, dateLabel, fmtT, minutesOfDay, toBizDate } from '../../platform/time.js'
import '../customers/schema.js'
import { getActiveEmergency } from '../settings/emergency.js'
import { listBays } from './appointments.js'
import { loadAlerts, type Alert } from './alerts.js'
import {
  dayRange,
  loadBoardRows,
  matchesSearch,
  sortRows,
  toCard,
  type BoardRow,
  type OpsCard,
} from './board.js'
import { loadSettingsBundle, type SchedulingCtx } from './context.js'
import { loadKpis, loadOpsRows, type Kpi } from './kpis.js'
import { listBayStaff } from './staff.js'

export type OpsWindow = 'next24' | 'today' | 'tomorrow' | 'week'

export interface TimelineGroup {
  key: string
  bizDate: string
  /** "Today", "Tomorrow", a date, or "" for a later group of the same day. */
  divider: string
  /** "10" and "AM". */
  time: string
  ampm: string
  items: OpsCard[]
}

export interface BayCard {
  id: string
  number: number
  name: string
  status: 'active' | 'maintenance' | 'blocked'
  occupied: boolean
  free: boolean
  occupant: null | {
    card: OpsCard
    worker: { id: string; name: string; initials: string } | null
    startedAt: string
    elapsedSec: number
    /** "27:04". */
    elapsedLabel: string
    progressPct: number
    /** "36% complete". */
    progressLabel: string
    /** "75 min". */
    durLabel: string
    /** cleaning start + duration, never earlier than now. */
    estCompletion: string
    estCompletionLabel: string
    overrun: boolean
  }
  /** "Next: Liam Chen · 10:45 AM" or "No vehicles queued". */
  nextUp: string
  nextUpAppointmentId: string | null
}

export interface ArrivalCard {
  appointmentId: string
  title: string
  desc: string
  vip: boolean
  etaMinutes: number
  bay: { id: string; number: number } | null
  prepLabel: string
  prepped: boolean
}

export interface StaffColumn {
  employeeId: string | null
  name: string
  role: string
  initials: string
  avatarColor: string | null
  count: number
  jobs: OpsCard[]
}

export interface OpsSnapshot {
  now: { iso: string; tz: string; bizDate: string; time: string; dateLabel: string }
  window: OpsWindow
  q: string
  kpis: Kpi[]
  alerts: Alert[]
  inFacilityLabel: string
  timeline: { count: number; groups: TimelineGroup[] }
  completed: { count: number; items: OpsCard[] }
  queue: OpsCard[]
  bays: BayCard[]
  arrivals: ArrivalCard[]
  staff: StaffColumn[]
  emergency: { active: boolean; summary: string | null; startedAt: string | null }
}

export function windowRange(
  c: Pick<SchedulingCtx, 'tz'>,
  now: Date,
  w: OpsWindow,
): { from: Date; to: Date } {
  switch (w) {
    case 'today':
      return dayRange(c, now, 0, 1)
    case 'tomorrow':
      return dayRange(c, now, 1, 2)
    case 'week':
      return dayRange(c, now, 0, 7)
    default:
      return dayRange(c, now, 0, 2)
  }
}

/** The design's time-row label: "10:45" and "AM". */
const hhmm = (d: Date, tz: string): { time: string; ampm: string } => {
  const [time, ampm] = fmtT(minutesOfDay(d, tz)).split(' ')
  return { time: time!, ampm: ampm! }
}

const dividerFor = (bizDate: string, today: string, startsAt: Date, tz: string): string =>
  bizDate === today ? 'Today' : bizDate === addDays(today, 1) ? 'Tomorrow' : dateLabel(startsAt, tz)

export async function loadSnapshot(
  db: Executor,
  c: SchedulingCtx,
  o: { window: OpsWindow; q?: string; canContact: boolean; manager?: boolean },
): Promise<OpsSnapshot> {
  const now = c.clock.now()
  const today = toBizDate(now, c.tz)
  const q = o.q?.trim() ?? ''
  const range = windowRange(c, now, o.window)
  const [settings, bays, staffRows, emergency, opsRows, windowRowsRaw] = await Promise.all([
    loadSettingsBundle(db, c.locationId),
    listBays(db, c.locationId),
    listBayStaff(db, c.locationId),
    getActiveEmergency(db, c.locationId),
    loadOpsRows(db, c, now),
    loadBoardRows(db, c, { ...range, includeCleaning: false }),
  ])
  const index = { byId: new Map(bays.map((b) => [b.id, { id: b.id, number: b.number }])) }
  const card = (r: BoardRow): OpsCard =>
    toCard(r, { now, tz: c.tz, lateGraceMin: settings.ops.lateGraceMin, bays: index })

  const pool = sortRows(windowRowsRaw.filter((r) => matchesSearch(r, q, o.canContact)))
  const ordered = sortRows(opsRows)

  // timeline: upcoming only (in-bay cars live in the bays column, finished cars in the completed column)
  const upcoming = pool.filter((r) => r.a.status !== 'completed' && r.a.status !== 'cleaning')
  const groups: TimelineGroup[] = []
  let lastDay = ''
  for (const r of upcoming) {
    const bizDate = toBizDate(r.a.scheduledStart, c.tz)
    const key = `${bizDate}|${r.a.scheduledStart.toISOString()}`
    let g = groups[groups.length - 1]
    if (!g || g.key !== key) {
      const t = hhmm(r.a.scheduledStart, c.tz)
      g = {
        key,
        bizDate,
        divider: bizDate !== lastDay ? dividerFor(bizDate, today, r.a.scheduledStart, c.tz) : '',
        time: t.time,
        ampm: t.ampm,
        items: [],
      }
      groups.push(g)
      lastDay = bizDate
    }
    g.items.push(card(r))
  }

  // completed column: finished jobs of the window, plus yesterday's cars still waiting for pickup
  const carried =
    o.window === 'tomorrow'
      ? []
      : sortRows(
          opsRows.filter(
            (r) =>
              r.a.status === 'completed' &&
              r.a.pickupState !== 'collected' &&
              r.a.scheduledStart < range.from &&
              matchesSearch(r, q, o.canContact),
          ),
        )
  const completed = [...carried, ...pool.filter((r) => r.a.status === 'completed')].map(card)

  const queue = upcoming
    .filter((r) => r.a.status !== 'completed' && r.a.status !== 'cleaning')
    .sort((x, y) => Number(y.vip) - Number(x.vip))
    .slice(0, 6)
    .map(card)

  // bays and arrivals ignore search and range
  const nowMs = now.getTime()
  const bayCards: BayCard[] = bays.map((bay) => {
    const occRow = ordered.find((r) => r.a.status === 'cleaning' && r.a.bayId === bay.id)
    const nextRow = ordered.find(
      (r) => r.a.plannedBayId === bay.id && r.a.status !== 'cleaning' && r.a.status !== 'completed',
    )
    const nextUp = nextRow
      ? `Next: ${nextRow.customer.fullName} · ${fmtT(minutesOfDay(nextRow.a.scheduledStart, c.tz))}`
      : 'No vehicles queued'
    if (!occRow)
      return {
        id: bay.id,
        number: bay.number,
        name: bay.name,
        status: bay.status,
        occupied: false,
        free: bay.status === 'active',
        occupant: null,
        nextUp,
        nextUpAppointmentId: nextRow?.a.id ?? null,
      }
    const started = (occRow.a.cleaningStartedAt ?? occRow.a.scheduledStart).getTime()
    const elapsedMs = Math.max(0, nowMs - started)
    const elapsedMin = Math.floor(elapsedMs / 60_000)
    const pct = Math.min(100, (elapsedMs / 60_000 / occRow.a.durationMin) * 100)
    const est = Math.max(started + occRow.a.durationMin * 60_000, nowMs)
    return {
      id: bay.id,
      number: bay.number,
      name: bay.name,
      status: bay.status,
      occupied: true,
      free: false,
      occupant: {
        card: card(occRow),
        worker: occRow.staff,
        startedAt: new Date(started).toISOString(),
        elapsedSec: Math.floor(elapsedMs / 1000),
        elapsedLabel: `${elapsedMin}:${String(Math.floor(elapsedMs / 1000) % 60).padStart(2, '0')}`,
        progressPct: Math.round(pct * 100) / 100,
        progressLabel: `${Math.round(pct)}% complete`,
        durLabel: `${occRow.a.durationMin} min`,
        estCompletion: new Date(est).toISOString(),
        estCompletionLabel: fmtT(minutesOfDay(new Date(est), c.tz)),
        overrun: started + occRow.a.durationMin * 60_000 < nowMs,
      },
      nextUp,
      nextUpAppointmentId: nextRow?.a.id ?? null,
    }
  })

  const arrivals: ArrivalCard[] = ordered
    .filter((r) => r.a.etaMinutes !== null && (r.a.status === 'confirmed' || r.a.status === 'booked'))
    .sort((x, y) => Number(y.vip) - Number(x.vip) || x.a.etaMinutes! - y.a.etaMinutes!)
    .map((r) => {
      const cd = card(r)
      const svc = r.a.packageName.split(' + ')[0]!
      const v = r.vehicle
      const bayNumber = cd.bay?.number
      return {
        appointmentId: r.a.id,
        title: `${r.vip ? 'VIP arriving in ' : 'Arriving in '}${r.a.etaMinutes} min · ${r.customer.fullName}`,
        desc: `Geofence ETA · ${[v?.year, v?.make, v?.model].filter(Boolean).join(' ')} · ${svc}${bayNumber ? ` · Bay ${bayNumber}` : ''}`,
        vip: r.vip,
        etaMinutes: r.a.etaMinutes!,
        bay: cd.bay,
        prepLabel: r.a.bayPreppedAt ? `Bay ${bayNumber ?? ''} ready ✓` : `Prep Bay ${bayNumber ?? '—'}`,
        prepped: r.a.bayPreppedAt !== null,
      }
    })

  const staff: StaffColumn[] = [
    ...staffRows.map((s) => {
      const jobs = pool.filter((r) => r.staff?.id === s.id).map(card)
      return {
        employeeId: s.id,
        name: s.name,
        role: s.title,
        initials: s.initials,
        avatarColor: s.avatarColor,
        count: jobs.length,
        jobs,
      }
    }),
    (() => {
      const jobs = pool.filter((r) => !r.staff).map(card)
      return { employeeId: null, name: 'Unassigned', role: 'Queue', initials: '—', avatarColor: null, count: jobs.length, jobs }
    })(),
  ]

  const [kpis, alerts] = await Promise.all([
    loadKpis(db, c, opsRows),
    loadAlerts(db, c, { manager: o.manager, preloaded: opsRows }),
  ])
  return {
    now: {
      iso: now.toISOString(),
      tz: c.tz,
      bizDate: today,
      time: fmtT(minutesOfDay(now, c.tz)),
      dateLabel: dateLabel(now, c.tz),
    },
    window: o.window,
    q,
    kpis,
    alerts,
    inFacilityLabel: `${opsRows.filter((r) => r.a.status === 'cleaning').length} in facility`,
    timeline: { count: upcoming.length, groups },
    completed: { count: completed.length, items: completed },
    queue,
    bays: bayCards,
    arrivals,
    staff,
    emergency: {
      active: !!emergency?.active,
      summary: emergency?.active ? emergency.summary : null,
      startedAt: emergency?.active ? emergency.startedAt.toISOString() : null,
    },
  }
}

