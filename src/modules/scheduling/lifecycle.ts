// The appointment state machine (backend design 4.1). Every command is one transaction: row lock, guard, update,
// activity log, queued message, audit row and ops events. Guard errors carry the design's toast strings.
import { advisoryXactLock, type Executor, type Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { getSetting } from '../../platform/settings.js'
import { toBizDate } from '../../platform/time.js'
import '../customers/schema.js'
import type { AppointmentStatus } from '../customers/schema.js'
import {
  invalidTransition,
  STATUS_PHRASE,
  canDrag,
  customerBrief,
  getBay,
  isLate,
  listBays,
  lockAppointment,
  logActivity,
  publishOps,
  whenLabel,
  type AppointmentRecord,
  type BayRecord,
  type CustomerBrief,
} from './appointments.js'
import { can, firstName, loadSettingsBundle, type Actor, type SchedulingCtx } from './context.js'
import type { InvoiceSummary, QueuedResult } from './ports.js'
import { audit as audited } from './audit-helper.js'
import { depositSentence } from './cancellation.js'
import { settleClosed, settlementLog, type Settlement } from './closing.js'
import { ensureInvoiceFor, staffLabel } from './invoicing.js'
import { checkSlot, recordOverrides, type OverrideRequest } from './slots.js'
import './problems.js'

export interface Toast {
  title: string
  detail: string
}

export interface AppointmentCore {
  id: string
  seq: number
  version: number
  status: AppointmentStatus
  scheduledStart: string
  scheduledEnd: string
  plannedBay: { id: string; number: number } | null
  bay: { id: string; number: number } | null
  assignedEmployeeId: string | null
  etaMinutes: number | null
  prepped: boolean
  pickupState: 'pending' | 'collected' | null
  late: boolean
  canDrag: boolean
}

export interface CommandResult {
  appointment: AppointmentCore
  /** The design's success toast for this command. */
  toast: Toast
  warnings: string[]
  invoice?: InvoiceSummary | null
}

const bayRef = (bays: BayRecord[], id: string | null): { id: string; number: number } | null => {
  const b = id ? bays.find((x) => x.id === id) : undefined
  return b ? { id: b.id, number: b.number } : null
}

export async function toCore(db: Executor, c: SchedulingCtx, a: AppointmentRecord): Promise<AppointmentCore> {
  const [bays, late] = await Promise.all([
    listBays(db, c.locationId),
    getSetting(db, c.locationId, 'ops.late_grace_min'),
  ])
  return {
    id: a.id,
    seq: a.seq,
    version: a.version,
    status: a.status,
    scheduledStart: a.scheduledStart.toISOString(),
    scheduledEnd: a.scheduledEnd.toISOString(),
    plannedBay: bayRef(bays, a.plannedBayId),
    bay: bayRef(bays, a.bayId),
    assignedEmployeeId: a.assignedEmployeeId,
    etaMinutes: a.etaMinutes,
    prepped: a.bayPreppedAt !== null,
    pickupState: a.pickupState,
    late: isLate(a, c.clock.now(), late.value),
    canDrag: canDrag(a.status),
  }
}

// Shared helpers -----------------------------------------------------------------------------------------------------

function requireAny(actor: Actor, perms: readonly string[]): void {
  if (!perms.some((p) => can(actor, p)))
    throw new AppError('FORBIDDEN', { meta: { required: [...perms], mode: 'any' } })
}

type Patch = Record<string, unknown>

/** Applies the patch with a version bump; callers re-read the row (finish) for the new state. */
async function applyPatch(tx: Tx, a: AppointmentRecord, patch: Patch): Promise<void> {
  await tx
    .updateTable('appointments')
    .set(
      (eb) =>
        ({ ...(patch as object), version: eb('version', '+', 1), updated_at: eb.fn('app_now', []) }) as never,
    )
    .where('id', '=', a.id)
    .execute()
}

async function reload(tx: Tx, c: SchedulingCtx, id: string): Promise<AppointmentRecord> {
  return lockAppointment(tx, c.locationId, id)
}

async function queue(
  tx: Tx,
  c: SchedulingCtx,
  a: AppointmentRecord,
  customer: CustomerBrief,
  m: {
    templateKey?: string
    text?: string
    vars?: Record<string, string | number | null | undefined>
    purpose: string
    dedupeKey?: string
  },
): Promise<QueuedResult> {
  return c.ports.messages.enqueue(tx, {
    customerId: customer.id,
    appointmentId: a.id,
    templateKey: m.templateKey,
    text: m.text,
    vars: m.vars,
    purpose: m.purpose,
    ...(m.dedupeKey ? { dedupeKey: m.dedupeKey } : {}),
  })
}

const SKIP_LABELS: Record<string, string> = {
  opted_out: 'customer opted out of SMS',
  not_opted_in: 'customer has not opted in to SMS',
  no_valid_phone: 'no valid mobile number',
  no_phone: 'no valid mobile number',
}

/** The activity text, annotated when the message was not queued ("... (not sent: customer opted out of SMS)"). */
const withDelivery = (text: string, r: QueuedResult): string =>
  r.queued
    ? text
    : `${text} (not sent: ${SKIP_LABELS[r.skipped ?? ''] ?? r.skipped ?? 'blocked by SMS policy'})`

async function finish(
  tx: Tx,
  c: SchedulingCtx,
  a: AppointmentRecord,
  change: string,
  o: {
    toast: Toast
    warnings?: string[]
    invoice?: InvoiceSummary | null
    bayIds?: (string | null)[]
    availabilityDates?: string[]
  },
): Promise<CommandResult> {
  const fresh = await reload(tx, c, a.id)
  await publishOps(tx, c.locationId, {
    appointment: { id: fresh.id, version: fresh.version, status: fresh.status, change },
    bayIds: (o.bayIds ?? []).filter((x): x is string => x !== null),
    availability: o.availabilityDates,
  })
  return {
    appointment: await toCore(tx, c, fresh),
    toast: o.toast,
    warnings: o.warnings ?? [],
    ...(o.invoice !== undefined ? { invoice: o.invoice } : {}),
  }
}

const bizDateOf = (c: SchedulingCtx, d: Date): string => toBizDate(d, c.tz)

// confirm ------------------------------------------------------------------------------------------------------------

export async function confirmAppointment(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  id: string,
): Promise<CommandResult> {
  requireAny(actor, ['sched.edit', 'jobs.status'])
  const a = await lockAppointment(tx, c.locationId, id)
  if (a.status !== 'booked') throw invalidTransition(a)
  const customer = await customerBrief(tx, a.customerId)
  await applyPatch(tx, a, { status: 'confirmed' })
  const sent = await queue(tx, c, a, customer, {
    templateKey: 'confirmed',
    vars: { time: whenLabel(a.scheduledStart, c.clock.now(), c.tz) },
    purpose: 'confirm',
  })
  await logActivity(tx, c, {
    appointmentId: a.id,
    text: withDelivery('Confirmation + reminder sent', sent),
    channels: ['sms'],
    actor,
  })
  await audited(tx, c, actor, 'confirm', a.id, { status: a.status }, { status: 'confirmed' })
  return finish(tx, c, a, 'confirmed', {
    toast: { title: 'Confirmation sent', detail: 'Reminder via SMS' },
  })
}

// arrive -------------------------------------------------------------------------------------------------------------

export async function arriveAppointment(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  id: string,
  o: { source?: 'manual' | 'geofence' } = {},
): Promise<CommandResult> {
  requireAny(actor, ['jobs.status', 'sched.edit'])
  const a = await lockAppointment(tx, c.locationId, id)
  if (a.status !== 'booked' && a.status !== 'confirmed') throw invalidTransition(a)
  const geofence = o.source === 'geofence'
  const now = c.clock.now()
  const customer = await customerBrief(tx, a.customerId)
  const bays = await listBays(tx, c.locationId)
  await applyPatch(tx, a, {
    status: 'arrived',
    arrived_at: now,
    eta_minutes: null,
    eta_at: null,
    ...(geofence ? { geo_checked_in_at: now } : {}),
  })
  let welcomeText = ''
  if (geofence) {
    const settings = await loadSettingsBundle(tx, c.locationId)
    if (settings.arrival.welcome) {
      const bay = bayRef(bays, a.plannedBayId)
      const sent = await queue(tx, c, a, customer, {
        templateKey: 'welcome',
        vars: { bay: bay ? bay.number : null },
        purpose: 'arrive',
      })
      welcomeText = sent.queued ? '' : withDelivery('', sent).trim()
    }
    await logActivity(tx, c, {
      appointmentId: a.id,
      text: `Auto check-in · geofence${welcomeText ? ` ${welcomeText}` : ''}`,
      channels: ['automation'],
      actorType: 'automation',
    })
  } else {
    await logActivity(tx, c, { appointmentId: a.id, text: 'Arrival logged', channels: ['internal'], actor })
  }
  await audited(
    tx,
    c,
    actor,
    'arrive',
    a.id,
    { status: a.status },
    { status: 'arrived', source: geofence ? 'geofence' : 'manual' },
  )
  return finish(tx, c, a, 'arrived', {
    toast: geofence
      ? { title: 'Checked in automatically', detail: `${customer.fullName} · welcome message sent` }
      : { title: 'Marked arrived', detail: 'Internal team notified' },
  })
}

// bay selection, start and assign-bay -----------------------------------------------------------------------------

async function occupantOf(tx: Tx, bayId: string): Promise<{ id: string; name: string } | undefined> {
  const r = await tx
    .selectFrom('appointments as a')
    .innerJoin('customers as c', 'c.id', 'a.customer_id')
    .select(['a.id', 'c.full_name'])
    .where('a.bay_id', '=', bayId)
    .where('a.status', '=', 'cleaning')
    .executeTakeFirst()
  return r ? { id: r.id, name: r.full_name } : undefined
}

const busyError = (bay: Pick<BayRecord, 'number'>, occupantName: string | null): AppError =>
  new AppError('BAY_BUSY', {
    params: { n: bay.number },
    detail: occupantName
      ? `Finish ${firstName(occupantName)}’s vehicle first`
      : 'Finish the current vehicle first',
  })

const isBayOccupiedViolation = (e: unknown): boolean =>
  typeof e === 'object' &&
  e !== null &&
  (e as { code?: string }).code === '23505' &&
  String((e as { constraint?: string }).constraint ?? '').includes('uq_bay_occupied')

async function chooseBay(
  tx: Tx,
  c: SchedulingCtx,
  a: AppointmentRecord,
  o: { bayId?: string },
): Promise<BayRecord> {
  await advisoryXactLock(tx, `bays:${c.locationId}`)
  const bays = await listBays(tx, c.locationId)
  if (o.bayId) {
    const bay = bays.find((b) => b.id === o.bayId)
    if (!bay) throw new AppError('NOT_FOUND', { detail: 'That bay does not exist' })
    if (bay.status !== 'active') throw new AppError('BAY_UNAVAILABLE', { params: { n: bay.number } })
    const occ = await occupantOf(tx, bay.id)
    if (occ) throw busyError(bay, occ.name)
    return bay
  }
  const active = bays.filter((b) => b.status === 'active')
  if (active.length === 0) throw new AppError('NO_BAY_FREE')
  const candidates = [
    ...(a.plannedBayId ? active.filter((b) => b.id === a.plannedBayId) : []),
    ...active.filter((b) => b.id !== a.plannedBayId),
  ]
  for (const bay of candidates) if (!(await occupantOf(tx, bay.id))) return bay
  const first = candidates[0]!
  const occ = await occupantOf(tx, first.id)
  throw busyError(first, occ?.name ?? null)
}

async function putInBay(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  a: AppointmentRecord,
  o: { mode: 'start' | 'assign'; bayId?: string },
): Promise<CommandResult> {
  const now = c.clock.now()
  const customer = await customerBrief(tx, a.customerId)
  const bay = await chooseBay(tx, c, a, { bayId: o.bayId })
  const implicitArrival = a.status === 'booked' || a.status === 'confirmed'
  try {
    await applyPatch(tx, a, {
      status: 'cleaning',
      bay_id: bay.id,
      cleaning_started_at: now,
      ...(implicitArrival ? { arrived_at: a.arrivedAt ?? now, eta_minutes: null, eta_at: null } : {}),
    })
  } catch (e) {
    if (isBayOccupiedViolation(e)) throw busyError(bay, null)
    throw e
  }
  if (implicitArrival)
    await logActivity(tx, c, { appointmentId: a.id, text: 'Arrival logged', channels: ['internal'], actor })
  const sent = await queue(tx, c, a, customer, { templateKey: 'in_progress', purpose: 'start' })
  await logActivity(tx, c, {
    appointmentId: a.id,
    text:
      o.mode === 'assign'
        ? withDelivery(`Assigned to Bay ${bay.number} · cleaning started`, sent)
        : withDelivery('In-progress message sent', sent),
    channels: o.mode === 'assign' ? ['internal', 'sms'] : ['sms'],
    actor,
    meta: { bay: bay.number },
  })
  await audited(
    tx,
    c,
    actor,
    o.mode === 'assign' ? 'assign_bay' : 'start',
    a.id,
    { status: a.status, bayId: a.bayId },
    { status: 'cleaning', bayId: bay.id },
  )
  return finish(tx, c, a, 'cleaning', {
    toast:
      o.mode === 'assign'
        ? { title: `Moved to Bay ${bay.number}`, detail: `${customer.fullName} · cleaning started` }
        : { title: 'Cleaning started', detail: 'In-progress message sent' },
    bayIds: [bay.id],
  })
}

export async function startCleaning(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  id: string,
  o: { bayId?: string } = {},
): Promise<CommandResult> {
  requireAny(actor, ['jobs.status'])
  const a = await lockAppointment(tx, c.locationId, id)
  if (a.status === 'cleaning' && a.bayId) throw await alreadyInBay(tx, c, a)
  if (a.status !== 'arrived') throw invalidTransition(a)
  return putInBay(tx, c, actor, a, { mode: 'start', bayId: o.bayId })
}

async function alreadyInBay(tx: Tx, c: SchedulingCtx, a: AppointmentRecord): Promise<AppError> {
  const bay = await getBay(tx, c.locationId, a.bayId!)
  return new AppError('ALREADY_IN_BAY', { params: { n: bay?.number ?? '' } })
}

/** Drag onto a bay: booked, confirmed or arrived jobs of today go straight to cleaning (arriving implicitly). */
export async function assignToBay(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  id: string,
  o: { bayId: string },
): Promise<CommandResult> {
  requireAny(actor, ['jobs.status'])
  const a = await lockAppointment(tx, c.locationId, id)
  if (a.status === 'cleaning') throw await alreadyInBay(tx, c, a)
  if (!canDrag(a.status)) throw invalidTransition(a)
  if (bizDateOf(c, a.scheduledStart) !== bizDateOf(c, c.clock.now())) throw new AppError('NOT_TODAY')
  return putInBay(tx, c, actor, a, { mode: 'assign', bayId: o.bayId })
}

// complete -----------------------------------------------------------------------------------------------------------

export async function completeAppointment(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  id: string,
): Promise<CommandResult> {
  requireAny(actor, ['jobs.status'])
  const a = await lockAppointment(tx, c.locationId, id)
  if (a.status !== 'cleaning') throw invalidTransition(a)
  const now = c.clock.now()
  const customer = await customerBrief(tx, a.customerId)
  const auto = await tx
    .updateTable('job_checklist_items')
    .set({ done: true, done_at: now, done_by_employee_id: null })
    .where('appointment_id', '=', a.id)
    .where('removed_at', 'is', null)
    .where('done', '=', false)
    .returning('id')
    .execute()
  await applyPatch(tx, a, {
    status: 'completed',
    completed_at: now,
    pickup_state: 'pending',
    ready_notified_at: now,
  })
  await c.ports.invoices.freezeDate?.(tx, a.id, now)
  const credit = await c.ports.memberships.autoApplyCredit?.(tx, c, actor, a.id)
  if (credit?.applied)
    await logActivity(tx, c, {
      appointmentId: a.id,
      text: `Membership credit applied automatically · ${credit.ruleLabel}`,
      channels: ['system'],
      actorType: 'automation',
      meta: { discountCents: credit.discountCents },
    })
  if (auto.length > 0)
    await logActivity(tx, c, {
      appointmentId: a.id,
      text: `${auto.length} remaining checklist task${auto.length === 1 ? '' : 's'} marked done on completion`,
      channels: ['system'],
      actorType: 'system',
      meta: { autoChecked: auto.length },
    })
  const sent = await queue(tx, c, a, customer, { templateKey: 'ready', purpose: 'complete' })
  await logActivity(tx, c, {
    appointmentId: a.id,
    text: withDelivery('Ready-for-pickup sent', sent),
    channels: ['sms'],
    actor,
  })
  await audited(
    tx,
    c,
    actor,
    'complete',
    a.id,
    { status: a.status },
    { status: 'completed', autoChecked: auto.length },
  )
  return finish(tx, c, a, 'completed', {
    toast: { title: 'Job completed', detail: 'Ready-for-pickup sent · moved to pickup' },
    bayIds: [a.bayId],
  })
}

// advance ------------------------------------------------------------------------------------------------------------

export const NEXT_STEP: Partial<Record<AppointmentStatus, 'confirm' | 'arrive' | 'start' | 'complete'>> = {
  booked: 'confirm',
  confirmed: 'arrive',
  arrived: 'start',
  cleaning: 'complete',
}

/**
 * The design's one button: the next valid step of the status the screen showed. `expectedStatus` is mandatory so a
 * stale screen, a double click or a swipe cannot skip a state; a mismatch is 409 STALE_STATE with the current status.
 */
export async function advanceAppointment(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  id: string,
  o: { expectedStatus: AppointmentStatus },
): Promise<CommandResult> {
  requireAny(actor, ['jobs.status', 'sched.edit'])
  const a = await lockAppointment(tx, c.locationId, id)
  if (a.status !== o.expectedStatus)
    throw new AppError('STALE_STATE', {
      detail: `This job is now ${STATUS_PHRASE[a.status]}. Refresh and try again`,
      meta: { currentStatus: a.status, expectedStatus: o.expectedStatus },
    })
  const step = NEXT_STEP[a.status]
  if (!step) {
    if (a.status === 'completed') throw new AppError('NO_NEXT_STEP')
    throw invalidTransition(a)
  }
  switch (step) {
    case 'confirm':
      return confirmAppointment(tx, c, actor, id)
    case 'arrive':
      return arriveAppointment(tx, c, actor, id)
    case 'start':
      return startCleaning(tx, c, actor, id)
    case 'complete':
      return completeAppointment(tx, c, actor, id)
  }
}

// cancel and no-show -------------------------------------------------------------------------------------------------

/** What happens to the money held on the invoice: the setting's policy (default), or the staff's explicit choice. */
export type DepositPolicy = 'policy' | 'keep' | 'refund_card' | 'refund_credit'

const blankReason = (message: string): AppError =>
  new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path: 'reason', message }] })

/** An emergency closure that cost the member the visit gives the credit it held back (ADR 0084). */
async function logReleasedCredit(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  a: AppointmentRecord,
): Promise<void> {
  const released = await c.ports.memberships.releaseCredit?.(tx, c, a.id)
  if (released)
    await logActivity(tx, c, {
      appointmentId: a.id,
      text: `Membership credit restored · emergency closure (${released.ruleLabel})`,
      channels: ['internal'],
      actor,
    })
}

/** A staff-chosen refund is the actor's own: it needs pay.refund before anything changes. */
function requireRefundRight(actor: Actor, mode: DepositPolicy): void {
  if ((mode === 'refund_card' || mode === 'refund_credit') && !can(actor, 'pay.refund'))
    throw new AppError('FORBIDDEN', { meta: { required: ['pay.refund'], mode: 'all' } })
}

/**
 * Cancels a booked or confirmed job. The money held on its invoice is settled by the cancellation policy (refunded in full when
 * the cancel is early enough, otherwise the setting's share is kept) or by the staff's explicit `deposit` choice; the refund is a
 * real ledger event (a card refund awaits Squarespace), the invoice is canceled (a kept deposit stays on it), capacity frees up
 * and the client is told, including what happens to the deposit, when `notify` is set.
 */
export async function cancelAppointment(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  id: string,
  o: { reason: string; notify?: boolean; deposit?: DepositPolicy },
): Promise<CommandResult & { depositPolicy: DepositPolicy; settlement: Settlement | null }> {
  const reason = o.reason?.trim() ?? ''
  if (reason === '') throw blankReason('Add a reason for the cancellation.')
  const mode = o.deposit ?? 'policy'
  requireRefundRight(actor, mode)
  const a = await lockAppointment(tx, c.locationId, id)
  if (a.status !== 'booked' && a.status !== 'confirmed') throw invalidTransition(a)
  const customer = await customerBrief(tx, a.customerId)
  const now = c.clock.now()
  await applyPatch(tx, a, { status: 'canceled', canceled_at: now, cancel_reason: reason })
  const settlement = await settleClosed(tx, c, actor, a, { kind: 'canceled', mode })
  const invoice = await c.ports.invoices.cancelForAppointment(tx, a.id, 'canceled', actor.audit.actor ?? {})
  await logActivity(tx, c, {
    appointmentId: a.id,
    text: `Appointment canceled · ${reason}`,
    channels: ['internal'],
    actor,
    meta: { depositPolicy: mode },
  })
  await logReleasedCredit(tx, c, actor, a)
  await c.ports.waitlist?.slotFreed(tx, c, a)
  if (settlement)
    for (const text of settlementLog(settlement, 'canceled'))
      await logActivity(tx, c, {
        appointmentId: a.id,
        text,
        channels: ['internal'],
        actor,
        meta: { rule: settlement.rule },
      })
  if (o.notify) {
    const deposit = settlement ? depositSentence(settlement) : ''
    const sent = await queue(tx, c, a, customer, {
      text: `Your appointment at Oasis Auto Spa ${whenLabel(a.scheduledStart, now, c.tz)} has been canceled. ${deposit ? `${deposit} ` : ''}Reply here if you have questions.`,
      purpose: 'cancel',
      dedupeKey: `cancel:${a.id}:v${a.version}`,
    })
    await logActivity(tx, c, {
      appointmentId: a.id,
      text: withDelivery('Cancellation notice sent', sent),
      channels: ['sms'],
      actor,
    })
  }
  await audited(
    tx,
    c,
    actor,
    'cancel',
    a.id,
    { status: a.status },
    {
      status: 'canceled',
      reason,
      notify: o.notify ?? false,
      deposit: mode,
      ...(settlement
        ? {
            heldCents: settlement.heldCents,
            refundedCents: settlement.refundedCents,
            retainedCents: settlement.retainedCents,
          }
        : {}),
    },
  )
  const result = await finish(tx, c, a, 'canceled', {
    toast: { title: 'Appointment canceled', detail: `${customer.fullName} · ${reason}` },
    invoice,
    availabilityDates: [bizDateOf(c, a.scheduledStart)],
  })
  return { ...result, depositPolicy: mode, settlement }
}

/**
 * Only after the start plus the late grace. The money held is settled by the no-show share of the policy (kept by default) or the
 * staff's explicit choice, and the invoice is canceled (reason no_show). No message is sent to the client.
 */
export async function markNoShow(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  id: string,
  o: { deposit?: DepositPolicy } = {},
): Promise<CommandResult & { depositPolicy: DepositPolicy; settlement: Settlement | null }> {
  const mode = o.deposit ?? 'policy'
  requireRefundRight(actor, mode)
  const a = await lockAppointment(tx, c.locationId, id)
  if (a.status !== 'booked' && a.status !== 'confirmed') throw invalidTransition(a)
  const { ops } = await loadSettingsBundle(tx, c.locationId)
  const now = c.clock.now()
  if (now.getTime() <= a.scheduledStart.getTime() + ops.lateGraceMin * 60_000)
    throw new AppError('TOO_EARLY_FOR_NO_SHOW', { params: { grace: ops.lateGraceMin } })
  const customer = await customerBrief(tx, a.customerId)
  await applyPatch(tx, a, { status: 'no_show', no_show_at: now })
  const settlement = await settleClosed(tx, c, actor, a, { kind: 'no_show', mode })
  const invoice = await c.ports.invoices.cancelForAppointment(tx, a.id, 'no_show', actor.audit.actor ?? {})
  await logActivity(tx, c, { appointmentId: a.id, text: 'Marked no-show', channels: ['internal'], actor })
  await logReleasedCredit(tx, c, actor, a)
  if (settlement)
    for (const text of settlementLog(settlement, 'no_show'))
      await logActivity(tx, c, {
        appointmentId: a.id,
        text,
        channels: ['internal'],
        actor,
        meta: { rule: settlement.rule },
      })
  await audited(
    tx,
    c,
    actor,
    'no_show',
    a.id,
    { status: a.status },
    {
      status: 'no_show',
      deposit: mode,
      ...(settlement
        ? {
            heldCents: settlement.heldCents,
            refundedCents: settlement.refundedCents,
            retainedCents: settlement.retainedCents,
          }
        : {}),
    },
  )
  const result = await finish(tx, c, a, 'no_show', {
    toast: { title: 'Marked no-show', detail: customer.fullName },
    invoice,
    availabilityDates: [bizDateOf(c, a.scheduledStart)],
  })
  return { ...result, depositPolicy: mode, settlement }
}

/**
 * Brings a canceled or no-show job back to booked. The slot is revalidated (override rules apply); without a new start
 * the original one is checked for capacity, hours and closures but its being in the past is not held against it.
 */
export async function reopenAppointment(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  id: string,
  o: { start?: Date; override?: OverrideRequest | null } = {},
): Promise<CommandResult> {
  const a = await lockAppointment(tx, c.locationId, id)
  if (a.status !== 'canceled' && a.status !== 'no_show') throw invalidTransition(a)
  const start = o.start ?? a.scheduledStart
  const decision = await checkSlot(tx, c, actor, {
    start,
    durationMin: a.durationMin,
    customerId: a.customerId,
    override: o.override,
    excludeAppointmentId: a.id,
    ignorePast: o.start === undefined,
  })
  await c.ports.deposits?.reopen(tx, { appointmentId: a.id, locationId: c.locationId })
  await applyPatch(tx, a, {
    status: 'booked',
    canceled_at: null,
    cancel_reason: null,
    no_show_at: null,
    scheduled_start: start,
    scheduled_end: new Date(start.getTime() + a.durationMin * 60_000),
  })
  await recordOverrides(tx, c, actor, a.id, decision)
  const fresh = await reload(tx, c, a.id)
  const invoice = await ensureInvoiceFor(tx, c, fresh)
  await logActivity(tx, c, {
    appointmentId: a.id,
    text: 'Appointment reopened',
    channels: ['internal'],
    actor,
  })
  await audited(
    tx,
    c,
    actor,
    'reopen',
    a.id,
    { status: a.status },
    { status: 'booked', start: start.toISOString() },
  )
  const customer = await customerBrief(tx, a.customerId)
  return finish(tx, c, a, 'reopened', {
    toast: { title: 'Appointment reopened', detail: customer.fullName },
    invoice,
    availabilityDates: [bizDateOf(c, a.scheduledStart), decision.bizDate],
  })
}

// reschedule ---------------------------------------------------------------------------------------------------------

/**
 * Moves a booked, confirmed or arrived job to a new start, possibly on another day. The full slot validation applies
 * (excluding the job itself); the client is told by SMS and the invoice date follows.
 */
export async function rescheduleAppointment(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  id: string,
  o: { start: Date; override?: OverrideRequest | null },
): Promise<CommandResult> {
  const a = await lockAppointment(tx, c.locationId, id)
  if (a.status === 'cleaning' || a.status === 'completed') throw new AppError('CANT_MOVE_JOB')
  if (!canDrag(a.status)) throw invalidTransition(a)
  const customer = await customerBrief(tx, a.customerId)
  if (o.start.getTime() === a.scheduledStart.getTime())
    return {
      appointment: await toCore(tx, c, a),
      toast: { title: 'No change', detail: 'That is already the appointment time' },
      warnings: [],
    }
  const decision = await checkSlot(tx, c, actor, {
    start: o.start,
    durationMin: a.durationMin,
    customerId: a.customerId,
    override: o.override,
    excludeAppointmentId: a.id,
  })
  await applyPatch(tx, a, {
    scheduled_start: o.start,
    scheduled_end: new Date(o.start.getTime() + a.durationMin * 60_000),
  })
  await recordOverrides(tx, c, actor, a.id, decision)
  const fresh = await reload(tx, c, a.id)
  const invoice = await ensureInvoiceFor(tx, c, fresh)
  const label = whenLabel(o.start, c.clock.now(), c.tz)
  const sent = await queue(tx, c, a, customer, {
    templateKey: 'reschedule',
    vars: { time: label },
    purpose: 'reschedule',
  })
  await logActivity(tx, c, {
    appointmentId: a.id,
    text: withDelivery(`Rescheduled to ${label}`, sent),
    channels: ['internal', 'sms'],
    actor,
    meta: { from: a.scheduledStart.toISOString(), to: o.start.toISOString() },
  })
  await audited(
    tx,
    c,
    actor,
    'reschedule',
    a.id,
    { start: a.scheduledStart.toISOString() },
    { start: o.start.toISOString(), overrides: decision.overrides.map((x) => x.kind) },
  )
  return finish(tx, c, a, 'moved', {
    toast: { title: `Moved to ${label}`, detail: `${customer.fullName} notified via SMS` },
    invoice,
    availabilityDates: [bizDateOf(c, a.scheduledStart), decision.bizDate],
  })
}

// prep-bay, pickup, notify-ready ---------------------------------------------------------------------------------

export async function prepBay(tx: Tx, c: SchedulingCtx, actor: Actor, id: string): Promise<CommandResult> {
  requireAny(actor, ['jobs.status', 'sched.edit'])
  const a = await lockAppointment(tx, c.locationId, id)
  if (a.status !== 'booked' && a.status !== 'confirmed' && a.status !== 'arrived') throw invalidTransition(a)
  const customer = await customerBrief(tx, a.customerId)
  const bays = await listBays(tx, c.locationId)
  const planned = bayRef(bays, a.plannedBayId)
  const warnings: string[] = []
  if (!planned) warnings.push('No bay is planned for this job')
  else {
    const occ = await occupantOf(tx, planned.id)
    if (occ && occ.id !== a.id)
      warnings.push(`Bay ${planned.number} is still occupied by ${firstName(occ.name)}’s vehicle`)
  }
  const vip = await tx
    .selectFrom('vip_clients')
    .select('customer_id')
    .where('location_id', '=', c.locationId)
    .where('customer_id', '=', a.customerId)
    .executeTakeFirst()
  if (a.bayPreppedAt === null) {
    await applyPatch(tx, a, { bay_prepped_at: c.clock.now() })
    await logActivity(tx, c, {
      appointmentId: a.id,
      text: `Bay ${planned?.number ?? ''} prepped for arrival`.replace('  ', ' '),
      channels: ['internal'],
      actor,
    })
    await audited(tx, c, actor, 'prep_bay', a.id, { prepped: false }, { prepped: true })
  }
  return finish(tx, c, a, 'prepped', {
    toast: {
      title: `Bay ${planned?.number ?? ''} prepped`.replace('  ', ' '),
      detail: `${vip ? 'VIP ' : ''}${customer.fullName} ${a.etaMinutes !== null ? `arrives in ${a.etaMinutes} min` : 'is arriving soon'}`,
    },
    warnings,
  })
}

export async function setPickup(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  id: string,
  o: { state: 'collected' | 'pending' },
): Promise<CommandResult> {
  requireAny(actor, ['jobs.status'])
  const a = await lockAppointment(tx, c.locationId, id)
  if (a.status !== 'completed') throw invalidTransition(a)
  const customer = await customerBrief(tx, a.customerId)
  const collected = o.state === 'collected'
  if (a.pickupState !== o.state) {
    await applyPatch(tx, a, { pickup_state: o.state, picked_up_at: collected ? c.clock.now() : null })
    await logActivity(tx, c, {
      appointmentId: a.id,
      text: collected ? 'Vehicle released to customer' : 'Pickup reopened',
      channels: ['internal'],
      actor,
    })
    await audited(tx, c, actor, 'pickup', a.id, { pickup: a.pickupState }, { pickup: o.state })
  }
  return finish(tx, c, a, 'pickup', {
    toast: collected
      ? { title: 'Vehicle picked up', detail: `Released to ${customer.firstName}` }
      : { title: 'Pickup reopened', detail: 'Back to ready for pickup' },
  })
}

export async function notifyReady(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  id: string,
): Promise<CommandResult> {
  const a = await lockAppointment(tx, c.locationId, id)
  if (a.status !== 'completed') throw invalidTransition(a)
  const customer = await customerBrief(tx, a.customerId)
  const sent = await queue(tx, c, a, customer, { templateKey: 'ready', purpose: 'notify_ready' })
  await applyPatch(tx, a, { ready_notified_at: c.clock.now() })
  await logActivity(tx, c, {
    appointmentId: a.id,
    text: withDelivery('Ready-for-pickup sent', sent),
    channels: ['sms'],
    actor,
  })
  await audited(tx, c, actor, 'notify_ready', a.id, null, { queued: sent.queued })
  return finish(tx, c, a, 'notified', {
    toast: { title: 'Customer notified', detail: 'Ready-for-pickup sent via SMS' },
  })
}

// plain edits --------------------------------------------------------------------------------------------------------

export interface DetailsPatch {
  plannedBayId?: string | null
  assignedEmployeeId?: string | null
  notes?: string | null
  specialInstructions?: string | null
}

const cleanText = (s: string | null | undefined): string | null => {
  if (s === null || s === undefined) return null
  const t = s.trim()
  return t === '' ? null : t
}

/** PATCH /appointments/:id: plan a bay without starting, assign staff, edit notes. */
export async function updateDetails(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  id: string,
  p: DetailsPatch,
  expectedVersion?: number,
): Promise<CommandResult> {
  const a = await lockAppointment(tx, c.locationId, id)
  if (expectedVersion !== undefined && expectedVersion !== a.version)
    throw new AppError('VERSION_CONFLICT', { meta: { currentVersion: a.version } })
  const patch: Patch = {}
  const notes: string[] = []
  if (p.plannedBayId !== undefined) {
    if (!canDrag(a.status)) throw invalidTransition(a)
    if (p.plannedBayId !== null) {
      const bay = await getBay(tx, c.locationId, p.plannedBayId)
      if (!bay) throw new AppError('NOT_FOUND', { detail: 'That bay does not exist' })
      if (bay.status !== 'active') throw new AppError('BAY_UNAVAILABLE', { params: { n: bay.number } })
      notes.push(`Planned for Bay ${bay.number}`)
    } else notes.push('Bay plan cleared')
    patch.planned_bay_id = p.plannedBayId
  }
  if (p.assignedEmployeeId !== undefined) {
    if (p.assignedEmployeeId !== null) {
      const e = await tx
        .selectFrom('employees')
        .select(['id', 'status'])
        .where('id', '=', p.assignedEmployeeId)
        .executeTakeFirst()
      if (!e || e.status !== 'active')
        throw new AppError('VALIDATION_FAILED', {
          detail: 'Pick an active team member.',
          errors: [{ path: 'assignedEmployeeId', message: 'Pick an active team member.' }],
        })
    }
    patch.assigned_employee_id = p.assignedEmployeeId
    notes.push(`Assigned to ${await staffLabel(tx, p.assignedEmployeeId)}`)
  }
  if (p.notes !== undefined) {
    patch.notes = cleanText(p.notes)
    notes.push('Notes updated')
  }
  if (p.specialInstructions !== undefined) {
    patch.special_instructions = cleanText(p.specialInstructions)
    notes.push('Special instructions updated')
  }
  if (Object.keys(patch).length > 0) {
    await applyPatch(tx, a, patch)
    for (const text of notes)
      await logActivity(tx, c, { appointmentId: a.id, text, channels: ['internal'], actor })
    await audited(tx, c, actor, 'update', a.id, null, { ...patch })
  }
  return finish(tx, c, a, 'updated', {
    toast: { title: 'Saved', detail: notes[0] ?? 'Nothing to change' },
    bayIds: [a.plannedBayId, (patch.planned_bay_id as string | null | undefined) ?? null],
  })
}
