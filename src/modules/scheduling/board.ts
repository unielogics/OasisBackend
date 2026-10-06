// The rows behind every Operations read model (board, KPIs, alerts, calendar, search) and the card view model.
import { sql } from 'kysely'
import type { Executor } from '../../platform/db.js'
import { NIL_UUID } from '../../platform/ids.js'
import { formatUsdOps } from '../../platform/money.js'
import { addDays, bizDayBounds, fmtT, minutesOfDay, toBizDate } from '../../platform/time.js'
import { displayName, initials } from '../auth/context.js'
import '../customers/schema.js'
import type { AppointmentStatus } from '../customers/schema.js'
import {
  APPOINTMENT_COLUMNS,
  LATE_META,
  STATUS_META,
  canDrag,
  isLate,
  toAppointment,
  type AppointmentRecord,
} from './appointments.js'
import type { SchedulingCtx } from './context.js'
import type { InvoiceSummary, MembershipInfo } from './ports.js'
import { photoCounts } from './photos.js'

export interface BoardRow {
  a: AppointmentRecord
  customer: {
    id: string
    fullName: string
    phoneDisplay: string | null
    phoneE164: string | null
    email: string | null
  }
  vehicle: {
    year: number | null
    make: string | null
    model: string | null
    color: string | null
    plate: string | null
  } | null
  staff: { id: string; name: string; initials: string } | null
  addonCount: number
  hasPhotos: boolean
  vip: boolean
  member: MembershipInfo | null
  invoice: InvoiceSummary | null
}

export interface RowQuery {
  from: Date
  to: Date
  /** Load exactly these appointments (any status given, any date) instead of a range. */
  ids?: readonly string[]
  /** Statuses to load; default every status except canceled and no_show. */
  statuses?: readonly AppointmentStatus[]
  /** Also load jobs in a bay whatever their date. */
  includeCleaning?: boolean
}

export const LIVE_STATUSES: readonly AppointmentStatus[] = [
  'booked',
  'confirmed',
  'arrived',
  'cleaning',
  'completed',
]

/** Start instants of [today + fromDay, today + toDay) in the business tz. */
export function dayRange(c: Pick<SchedulingCtx, 'tz'>, now: Date, fromDay: number, toDay: number): { from: Date; to: Date } {
  const today = toBizDate(now, c.tz)
  return {
    from: bizDayBounds(addDays(today, fromDay), c.tz).start,
    to: bizDayBounds(addDays(today, toDay), c.tz).start,
  }
}

export async function loadBoardRows(db: Executor, c: SchedulingCtx, q: RowQuery): Promise<BoardRow[]> {
  const statuses = q.statuses ?? LIVE_STATUSES
  const base = db
    .selectFrom('appointments as a')
    .innerJoin('customers as cu', 'cu.id', 'a.customer_id')
    .leftJoin('vehicles as v', 'v.id', 'a.vehicle_id')
    .leftJoin('employees as e', 'e.id', 'a.assigned_employee_id')
    .select([
      ...APPOINTMENT_COLUMNS.map((col) => `a.${col}` as `a.${(typeof APPOINTMENT_COLUMNS)[number]}`),
      'cu.full_name as c_full_name',
      'cu.phone_display as c_phone_display',
      'cu.phone_e164 as c_phone_e164',
      'cu.email as c_email',
      'v.year as v_year',
      'v.make as v_make',
      'v.model as v_model',
      'v.color as v_color',
      'v.plate as v_plate',
      'e.first as e_first',
      'e.last as e_last',
      sql<number>`(select count(*)::int from appointment_addons ad where ad.appointment_id = a.id and ad.removed_at is null)`.as(
        'addon_count',
      ),
      sql<boolean>`exists (select 1 from vip_clients vc where vc.location_id = a.location_id and vc.customer_id = a.customer_id)`.as(
        'is_vip',
      ),
    ])
    .where('a.location_id', '=', c.locationId)
    .where('a.status', 'in', [...statuses])
  const rows = await (q.ids
    ? base.where('a.id', 'in', q.ids.length ? [...q.ids] : [NIL_UUID])
    : base.where((eb) => {
        const inRange = eb.and([eb('a.scheduled_start', '>=', q.from), eb('a.scheduled_start', '<', q.to)])
        return q.includeCleaning ? eb.or([inRange, eb('a.status', '=', 'cleaning')]) : inRange
      })
  )
    .orderBy('a.scheduled_start')
    .orderBy('a.seq')
    .execute()
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const [invoices, photos, memberships] = await Promise.all([
    c.ports.invoices.summariesFor(db, ids),
    photoCounts(db, ids),
    c.ports.memberships.forAppointments(
      db,
      rows.map((r) => ({ appointmentId: r.id, customerId: r.customer_id, membershipId: r.membership_id })),
    ),
  ])
  return rows.map((r) => {
    const p = photos.get(r.id)
    return {
      a: toAppointment(r),
      customer: {
        id: r.customer_id,
        fullName: r.c_full_name,
        phoneDisplay: r.c_phone_display,
        phoneE164: r.c_phone_e164,
        email: r.c_email,
      },
      vehicle: r.vehicle_id
        ? { year: r.v_year, make: r.v_make, model: r.v_model, color: r.v_color, plate: r.v_plate }
        : null,
      staff: r.e_first
        ? { id: r.assigned_employee_id!, name: displayName(r.e_first, r.e_last ?? ''), initials: initials(r.e_first, r.e_last ?? '') }
        : null,
      addonCount: r.addon_count,
      hasPhotos: !!p && p.before + p.after > 0,
      vip: r.is_vip,
      member: memberships.get(r.id) ?? null,
      invoice: invoices.get(r.id) ?? null,
    }
  })
}

// Card view model -----------------------------------------------------------------------------------------------------

export type NextStep = 'confirm' | 'arrive' | 'start' | 'complete' | 'collect' | null

export const NEXT_LABEL: Record<AppointmentStatus, string> = {
  booked: 'Confirm Appointment',
  confirmed: 'Mark Arrived',
  arrived: 'Start Cleaning',
  cleaning: 'Mark Complete',
  completed: 'Completed',
  canceled: 'Completed',
  no_show: 'Completed',
}

const NEXT_STEP_OF: Partial<Record<AppointmentStatus, NextStep>> = {
  booked: 'confirm',
  confirmed: 'arrive',
  arrived: 'start',
  cleaning: 'complete',
}

export interface PayView {
  /** "Paid", "Deposit · $228.00 due" or "$165.00 due". */
  label: string
  kind: 'paid' | 'deposit' | 'due' | 'none'
  balanceCents: number
  invoiceNo: number | null
  status: string | null
}

export function payView(inv: InvoiceSummary | null): PayView {
  if (!inv) return { label: 'No invoice', kind: 'none', balanceCents: 0, invoiceNo: null, status: null }
  const base = { balanceCents: inv.balanceCents, invoiceNo: inv.invoiceNo, status: inv.status }
  if (inv.status.startsWith('canceled')) return { ...base, label: 'Canceled', kind: 'none' }
  if (inv.balanceCents <= 0 && inv.paidCents > 0) return { ...base, label: 'Paid', kind: 'paid' }
  if (inv.paidCents > 0)
    return { ...base, label: `Deposit · ${formatUsdOps(inv.balanceCents)} due`, kind: 'deposit' }
  if (inv.balanceCents <= 0) return { ...base, label: 'Paid', kind: 'paid' }
  return { ...base, label: `${formatUsdOps(inv.balanceCents)} due`, kind: 'due' }
}

export function nextOf(row: Pick<BoardRow, 'a' | 'invoice'>): { label: string; step: NextStep } {
  const { a, invoice } = row
  if (a.status === 'completed' && invoice && invoice.balanceCents > 0)
    return { label: 'Collect Payment', step: 'collect' }
  return { label: NEXT_LABEL[a.status], step: NEXT_STEP_OF[a.status] ?? null }
}

const vehicleLine = (v: BoardRow['vehicle']): string =>
  v ? `${[v.year, v.make, v.model].filter(Boolean).join(' ')}${v.color ? ` · ${v.color}` : ''}` : 'Vehicle on file'

export interface OpsCard {
  id: string
  seq: number
  status: AppointmentStatus
  late: boolean
  badge: { label: string; color: string }
  customer: { id: string; name: string }
  vip: boolean
  member: { plan: string; label: string } | null
  vehicle: { year: number | null; make: string | null; model: string | null; color: string | null; plate: string | null } | null
  vehicleLine: string
  vehicleShort: string
  service: string
  startsAt: string
  endsAt: string
  /** "10:15 AM". */
  time: string
  bizDate: string
  bay: { id: string; number: number } | null
  /** "Bay 2" or "No bay". */
  bayLabel: string
  durationMin: number
  durLabel: string
  staff: { id: string; name: string; initials: string } | null
  pay: PayView
  hasNotes: boolean
  hasPhotos: boolean
  hasAddons: boolean
  addonCount: number
  next: { label: string; step: NextStep }
  canDrag: boolean
  etaMinutes: number | null
  prepped: boolean
  pickupState: 'pending' | 'collected' | null
  version: number
}

export interface BayIndex {
  byId: Map<string, { id: string; number: number }>
}

export function toCard(
  row: BoardRow,
  o: { now: Date; tz: string; lateGraceMin: number; bays: BayIndex },
): OpsCard {
  const { a } = row
  const late = isLate(a, o.now, o.lateGraceMin)
  const meta = late ? LATE_META : STATUS_META[a.status]
  const bayRef = (a.bayId ? o.bays.byId.get(a.bayId) : undefined) ?? (a.plannedBayId ? o.bays.byId.get(a.plannedBayId) : undefined)
  const v = row.vehicle
  return {
    id: a.id,
    seq: a.seq,
    status: a.status,
    late,
    badge: { label: meta.label, color: meta.color },
    customer: { id: row.customer.id, name: row.customer.fullName },
    vip: row.vip,
    member: row.member ? { plan: row.member.plan, label: row.member.plan.split(' ')[0]! } : null,
    vehicle: v,
    vehicleLine: vehicleLine(v),
    vehicleShort: v ? [v.make, v.model].filter(Boolean).join(' ') : 'Vehicle',
    service: a.packageName,
    startsAt: a.scheduledStart.toISOString(),
    endsAt: a.scheduledEnd.toISOString(),
    time: fmtT(minutesOfDay(a.scheduledStart, o.tz)),
    bizDate: toBizDate(a.scheduledStart, o.tz),
    bay: bayRef ? { id: bayRef.id, number: bayRef.number } : null,
    bayLabel: bayRef ? `Bay ${bayRef.number}` : 'No bay',
    durationMin: a.durationMin,
    durLabel: `Est. ${a.durationMin} min`,
    staff: row.staff,
    pay: payView(row.invoice),
    hasNotes: !!(a.specialInstructions || a.notes),
    hasPhotos: row.hasPhotos,
    hasAddons: row.addonCount > 0,
    addonCount: row.addonCount,
    next: nextOf(row),
    canDrag: canDrag(a.status),
    etaMinutes: a.etaMinutes,
    prepped: a.bayPreppedAt !== null,
    pickupState: a.pickupState,
    version: a.version,
  }
}

/** The design's sort: start time, VIP first on ties, then booking order. */
export function sortRows(rows: readonly BoardRow[]): BoardRow[] {
  return [...rows].sort(
    (x, y) =>
      x.a.scheduledStart.getTime() - y.a.scheduledStart.getTime() ||
      Number(y.vip) - Number(x.vip) ||
      x.a.seq - y.a.seq,
  )
}

/**
 * The design's search: a case-insensitive substring over name, make, model, colour, plate and package, plus the phone
 * for callers who may see contact details (without cli.contact a phone typed into the box matches nothing).
 */
export function matchesSearch(row: BoardRow, q: string, canContact: boolean): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  const v = row.vehicle
  const parts = [row.customer.fullName, v?.make, v?.model, v?.color, v?.plate, row.a.packageName]
  if (canContact) parts.push(row.customer.phoneDisplay, row.customer.phoneE164)
  return parts
    .filter((p): p is string => !!p)
    .join(' ')
    .toLowerCase()
    .includes(needle)
}
