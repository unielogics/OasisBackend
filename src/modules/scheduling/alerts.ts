// "Needs attention": computed on read with the real clock and returned as structured data plus the design's copy
// (backend design 4.4). Generation order, then a STABLE sort by priority (1 for a VIP client's job). Alerts 1-9 come
// from appointments; 10-12 (new reply, SMS device down, card awaiting Squarespace) come from an ExternalAlertSource.
import type { Executor } from '../../platform/db.js'
import { addDays, fmtT, minutesOfDay, toBizDate } from '../../platform/time.js'
import type { BoardRow } from './board.js'
import { sortRows } from './board.js'
import type { OpsSettings, SchedulingCtx } from './context.js'
import { loadSettingsBundle } from './context.js'
import { isLate } from './appointments.js'
import type { AlertTone, ExternalAlert } from './ports.js'
import { loadOpsRows } from './kpis.js'

export type AlertKind =
  | 'ready_for_pickup'
  | 'running_late'
  | 'needs_bay'
  | 'arriving_soon'
  | 'unconfirmed'
  | 'special_instructions'
  | 'arriving_eta'
  | 'auto_checked_in'
  | 'confirm_checkin'
  | 'member_credit'
  | ExternalAlert['kind']

export type AlertActionType =
  | 'mark_picked_up'
  | 'message_customer'
  | 'assign_bay'
  | 'prep_bay'
  | 'send_reminder'
  | 'view_file'
  | 'start_cleaning'
  | 'mark_arrived'
  | 'apply_credit'
  | 'open'

export interface Alert {
  key: string
  kind: AlertKind
  tone: AlertTone
  /** The design's glyph: ↑ ! ◳ → ? ★ ◎ ✓ ◆. */
  glyph: string
  appointmentId: string | null
  priority: number
  title: string
  desc: string
  actionLabel: string
  action: { type: AlertActionType; appointmentId: string | null }
}

const ARRIVAL_KINDS = new Set<AlertKind>([
  'arriving_soon',
  'arriving_eta',
  'auto_checked_in',
  'confirm_checkin',
])

const SPECIAL_PREVIEW = 46

export interface AlertInputs {
  now: Date
  tz: string
  rows: readonly BoardRow[]
  ops: OpsSettings
  external?: readonly ExternalAlert[]
}

const timeOf = (d: Date, tz: string): string => fmtT(minutesOfDay(d, tz))
const bayNo = (r: BoardRow, bays: ReadonlyMap<string, number>): number | null => {
  const id = r.a.plannedBayId ?? r.a.bayId
  return id ? (bays.get(id) ?? null) : null
}

/**
 * `bays` maps bay id to its number. Rows are generated in start order (then booking order) like the design's array.
 */
export function buildAlerts(i: AlertInputs, bays: ReadonlyMap<string, number>): Alert[] {
  const today = toBizDate(i.now, i.tz)
  const tomorrow = addDays(today, 1)
  const rows = sortRows(i.rows)
  const dayOf = (r: BoardRow): string => toBizDate(r.a.scheduledStart, i.tz)
  const inWindow = (r: BoardRow): boolean => [today, tomorrow].includes(dayOf(r))
  const out: Alert[] = []
  const push = (
    r: BoardRow,
    kind: AlertKind,
    tone: AlertTone,
    glyph: string,
    title: string,
    desc: string,
    actionLabel: string,
    type: AlertActionType,
  ): void => {
    const boosted = r.vip && (!ARRIVAL_KINDS.has(kind) || i.ops.vipFirst)
    out.push({
      key: `${kind}:${r.a.id}`,
      kind,
      tone,
      glyph,
      appointmentId: r.a.id,
      priority: boosted ? 1 : 0,
      title,
      desc,
      actionLabel,
      action: { type, appointmentId: r.a.id },
    })
  }
  const name = (r: BoardRow): string => r.customer.fullName
  const make = (r: BoardRow): string => r.vehicle?.make ?? 'vehicle'
  const makeModel = (r: BoardRow): string =>
    [r.vehicle?.make, r.vehicle?.model].filter(Boolean).join(' ') || 'vehicle'

  for (const r of rows) {
    const a = r.a
    const active =
      a.status === 'booked' || a.status === 'confirmed' || a.status === 'arrived' || a.status === 'cleaning'
    if (a.status === 'completed' && a.pickupState !== 'collected') {
      const due = (r.invoice?.balanceCents ?? 0) > 0
      push(
        r,
        'ready_for_pickup',
        'green',
        '↑',
        'Ready for pickup',
        `${name(r)}'s ${make(r)} is done${due ? ' · payment due' : ''}`,
        'Mark picked up',
        'mark_picked_up',
      )
    }
    if (!inWindow(r)) continue
    if (isLate(a, i.now, i.ops.lateGraceMin))
      push(
        r,
        'running_late',
        'red',
        '!',
        `Running late · ${name(r)}`,
        `${timeOf(a.scheduledStart, i.tz)} ${makeModel(r)} — no arrival logged`,
        'Message customer',
        'message_customer',
      )
    if (
      dayOf(r) === today &&
      (a.status === 'booked' || a.status === 'confirmed' || a.status === 'arrived') &&
      a.plannedBayId === null
    )
      push(
        r,
        'needs_bay',
        'amber',
        '◳',
        'Needs bay assignment',
        `${name(r)} · ${a.packageName}`,
        'Assign bay',
        'assign_bay',
      )
    const untilStart = a.scheduledStart.getTime() - i.now.getTime()
    if (
      a.status === 'confirmed' &&
      a.etaMinutes === null &&
      untilStart > 0 &&
      untilStart <= i.ops.prepAtMin * 60_000
    )
      push(
        r,
        'arriving_soon',
        'blue',
        '→',
        'Arriving soon',
        `${name(r)} in ${Math.ceil(untilStart / 60_000)} min · ${makeModel(r)}`,
        `Prep bay ${bayNo(r, bays) ?? '—'}`,
        'prep_bay',
      )
    if (a.status === 'booked')
      push(
        r,
        'unconfirmed',
        'amber',
        '?',
        'Unconfirmed',
        `${name(r)} · ${timeOf(a.scheduledStart, i.tz)} hasn't confirmed`,
        'Send reminder',
        'send_reminder',
      )
    if (a.specialInstructions && active) {
      const s = a.specialInstructions
      const preview = s.length > SPECIAL_PREVIEW ? `${s.slice(0, SPECIAL_PREVIEW)}…` : s
      push(
        r,
        'special_instructions',
        'violet',
        '★',
        'Special instructions',
        `${name(r)}: ${preview}`,
        'View file',
        'view_file',
      )
    }
  }
  for (const r of rows) {
    const a = r.a
    if (!inWindow(r)) continue
    const upcoming = a.status === 'booked' || a.status === 'confirmed'
    if (a.etaMinutes !== null && upcoming && a.etaMinutes <= i.ops.etaVisibleMaxMin) {
      const bay = bayNo(r, bays)
      push(
        r,
        'arriving_eta',
        r.vip ? 'violet' : 'blue',
        '◎',
        `${r.vip ? 'VIP arriving in ' : 'Arriving in '}${a.etaMinutes} min · ${name(r)}`,
        `Geofence ETA · ${makeModel(r)}${bay ? ` · Bay ${bay}` : ''}`,
        a.bayPreppedAt ? 'Bay ready ✓' : `Prep bay ${bay ?? '—'}`,
        'prep_bay',
      )
    }
    if (a.geoCheckedInAt && a.status === 'arrived')
      push(
        r,
        'auto_checked_in',
        'green',
        '✓',
        `Auto checked in · ${name(r)}`,
        `Geofence at ${timeOf(a.geoCheckedInAt, i.tz)} · vehicle in the lot`,
        'Start cleaning',
        'start_cleaning',
      )
    if (a.geoCheckedInAt && upcoming && !i.ops.autoArrive)
      push(
        r,
        'confirm_checkin',
        'green',
        '✓',
        `Checked in at the lot · ${name(r)}`,
        `Geofence at ${timeOf(a.geoCheckedInAt, i.tz)} · confirm the arrival`,
        'Mark arrived',
        'mark_arrived',
      )
  }
  const credit = rows.find(
    (r) => r.a.status === 'completed' && (r.invoice?.balanceCents ?? 0) > 0 && r.member?.creditAvailable,
  )
  if (credit)
    push(
      credit,
      'member_credit',
      'blue',
      '◆',
      'Member credit available',
      `${name(credit)} has 1 unused ${credit.member!.plan.split(' ')[0]} credit this cycle`,
      'Apply credit',
      'apply_credit',
    )

  // Stable sort: Array.prototype.sort is stable in Node 22.
  const sorted = [...out].sort((x, y) => y.priority - x.priority)
  for (const e of i.external ?? [])
    sorted.push({
      key: e.key,
      kind: e.kind,
      tone: e.tone,
      glyph: '!',
      appointmentId: e.appointmentId,
      priority: e.priority,
      title: e.title,
      desc: e.desc,
      actionLabel: e.actionLabel,
      action: { type: 'open', appointmentId: e.appointmentId },
    })
  return sorted
}

export async function loadAlerts(
  db: Executor,
  c: SchedulingCtx,
  o: { manager?: boolean; preloaded?: BoardRow[] } = {},
): Promise<Alert[]> {
  const now = c.clock.now()
  const [rows, settings, bayRows, external] = await Promise.all([
    o.preloaded ? Promise.resolve(o.preloaded) : loadOpsRows(db, c, now),
    loadSettingsBundle(db, c.locationId),
    db.selectFrom('bays').select(['id', 'number']).where('location_id', '=', c.locationId).execute(),
    c.ports.externalAlerts.list(db, { locationId: c.locationId, now, manager: o.manager ?? false }),
  ])
  return buildAlerts(
    { now, tz: c.tz, rows, ops: settings.ops, external },
    new Map(bayRows.map((b) => [b.id, b.number])),
  )
}
