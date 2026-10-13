// One-line audit.record for appointment entities, shared by the scheduling services. It also records the acting employee's activity
// (ADR 0180): every action maps to a staff_events kind, or to null when it is nobody's activity for the Team activity report. The map is
// exhaustive over AppointmentAuditAction, so a new action does not compile until it is mapped here.
import * as auditLog from '../../platform/audit.js'
import type { Tx } from '../../platform/db.js'
import type { JsonValue } from '../../platform/schema.js'
import { recordStaffEvent } from '../../platform/staff-events.js'
import type { StaffEventKind } from '../kiosk/schema.js'
import type { Actor, SchedulingCtx } from './context.js'

/** Every action the scheduling services audit as `appointment.<action>`. */
export type AppointmentAuditAction =
  | 'create'
  | 'confirm'
  | 'arrive'
  | 'assign_bay'
  | 'start'
  | 'complete'
  | 'cancel'
  | 'no_show'
  | 'reopen'
  | 'reschedule'
  | 'prep_bay'
  | 'pickup'
  | 'notify_ready'
  | 'update'
  | 'arrival_link'
  | 'addon.add'
  | 'addon.remove'
  | 'vehicle_class.set'
  | 'checklist.item'
  | 'checklist.bulk'
  | 'photo.add'
  | 'photo.note'
  | 'photo.delete'
  /** ops-routes: a bay's status (the entity is the bay, kept as it always was). */
  | 'bay.status'

export interface StaffEventOf {
  kind: StaffEventKind
  meta?: Record<string, JsonValue>
}

type Rec = Record<string, unknown> | null | undefined
type Mapper = StaffEventKind | null | ((before: Rec, after: Rec) => StaffEventOf | null)

const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

/**
 * The staff event of each appointment action (the backfill reads the same map over audit_log). Cancel, no-show, reopen and deleting a
 * photo are not on the kiosk and not counted in the report; a bay's status is not an appointment.
 */
export const STAFF_EVENT_OF: Record<AppointmentAuditAction, Mapper> = {
  create: (_b, a) => ({ kind: a?.source === 'walk_in' ? 'walk_in' : 'book', meta: { source: String(a?.source ?? 'dashboard') } }),
  confirm: 'confirm',
  arrive: 'arrive',
  // a drag from booked or confirmed is also the car's arrival (counted as a check-in)
  assign_bay: (b) => ({
    kind: 'assign_bay',
    meta: { implicitArrival: b?.status === 'booked' || b?.status === 'confirmed' },
  }),
  start: 'start',
  complete: 'complete',
  cancel: null,
  no_show: null,
  reopen: null,
  reschedule: 'reschedule',
  prep_bay: 'prep_bay',
  pickup: (_b, a) => ({ kind: a?.pickup === 'pending' ? 'pickup_reopen' : 'pickup' }),
  notify_ready: 'notify_ready',
  update: 'update',
  arrival_link: 'arrival_link',
  'addon.add': 'addon_add',
  'addon.remove': 'addon_remove',
  'vehicle_class.set': 'size_change',
  'checklist.item': (_b, a) => ({ kind: 'checklist', meta: { count: 1, done: a?.done === true } }),
  'checklist.bulk': (_b, a) => ({
    kind: 'checklist',
    meta: { count: typeof a?.count === 'number' ? a.count : 1, done: a?.done === true },
  }),
  'photo.add': (_b, a) => ({ kind: 'photo', meta: { category: String(a?.category ?? '') } }),
  'photo.note': () => ({ kind: 'photo', meta: { category: 'issue', note: true } }),
  'photo.delete': null,
  'bay.status': null,
}

/** The staff event of an audited appointment action, or null. */
export function staffEventOf(action: AppointmentAuditAction, before: unknown, after: unknown): StaffEventOf | null {
  const m = STAFF_EVENT_OF[action]
  if (m === null) return null
  if (typeof m === 'string') return { kind: m }
  return m(rec(before), rec(after))
}

export const isAppointmentAuditAction = (a: string): a is AppointmentAuditAction => Object.hasOwn(STAFF_EVENT_OF, a)

export async function audit(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  action: AppointmentAuditAction,
  appointmentId: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  const auditId = await auditLog.record(tx, {
    locationId: c.locationId,
    action: `appointment.${action}`,
    entityType: 'appointment',
    entityId: appointmentId,
    before: before as never,
    after: after as never,
    ctx: actor.audit,
  })
  const ev = staffEventOf(action, before, after)
  if (ev)
    await recordStaffEvent(tx, {
      locationId: c.locationId,
      ctx: actor.audit,
      kind: ev.kind,
      appointmentId,
      auditId,
      meta: { action, ...ev.meta },
    })
}
