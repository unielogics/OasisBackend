// The booking guard: recompute the slot state of a start inside the transaction, under an advisory lock per business
// date, and decide whether the booking may proceed (and which overrides it needs to be recorded).
import { advisoryXactLock, type Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { toBizDate } from '../../platform/time.js'
import '../customers/schema.js'
import type { OverrideKind } from '../customers/schema.js'
import { vipCustomerIds } from '../customers/service.js'
import type { Channel, Evaluation } from './availability.js'
import { evaluateStart } from './availability.js'
import { engineInput, loadDayData, sameDayGuaranteesUsed } from './availability-loader.js'
import { can, type Actor, type SchedulingCtx } from './context.js'
import './problems.js'

export interface OverrideRequest {
  reason: string
}

export interface SlotCheckInput {
  start: Date
  durationMin: number
  customerId: string
  override?: OverrideRequest | null
  /** Reschedule and reopen: the appointment's own interval must not count against it. */
  excludeAppointmentId?: string
  channel?: Channel
  /** Reopening a job at its original, already past start still checks capacity, hours and closures. */
  ignorePast?: boolean
}

export interface AppliedOverride {
  kind: OverrideKind
  reason: string
}

export interface SlotDecision {
  evaluation: Evaluation
  overrides: AppliedOverride[]
  bizDate: string
}

/** The guard error for a state that cannot be booked without an override. */
export function slotError(ev: Evaluation, o: { releaseHours: number; windowDays?: number }): AppError {
  switch (ev.state) {
    case 'past':
      return new AppError('SLOT_PAST')
    case 'closed':
      return ev.dayClosed
        ? new AppError('SLOT_CLOSED', { params: { reason: ev.reason ?? 'Closed' } })
        : new AppError('SLOT_OUTSIDE_HOURS', { params: { detail: ev.reason ?? 'Outside opening hours' } })
    case 'cutoff':
      return new AppError('SLOT_OUTSIDE_HOURS', { params: { detail: ev.reason ?? 'Past the booking cutoff' } })
    case 'outside_window':
      return new AppError('SLOT_OUTSIDE_WINDOW', { params: { days: o.windowDays ?? 0 } })
    case 'vip_held':
      return new AppError('SLOT_VIP_HELD', { params: { release: o.releaseHours } })
    default:
      return new AppError('SLOT_UNAVAILABLE')
  }
}

/**
 * Throws the design's guard error unless the start is bookable. A desk caller may override capacity, VIP holds, closed
 * days and out-of-hours starts with `override.reason` when they hold sched.override; a VIP client booking today on a full
 * slot may instead use a same-day guarantee (no permission, counted per month). Past starts are never overridable.
 */
export async function checkSlot(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  input: SlotCheckInput,
): Promise<SlotDecision> {
  const channel = input.channel ?? 'desk'
  const now = c.clock.now()
  const bizDate = toBizDate(input.start, c.tz)
  await advisoryXactLock(tx, `slots:${c.locationId}:${bizDate}`)
  const data = await loadDayData(tx, {
    locationId: c.locationId,
    tz: c.tz,
    now,
    date: bizDate,
    excludeAppointmentId: input.excludeAppointmentId,
  })
  if (input.ignorePast && input.start.getTime() < now.getTime()) data.now = input.start
  const isVip = (await vipCustomerIds(tx, c.locationId, [input.customerId])).has(input.customerId)
  const sameDayUsed = isVip
    ? await sameDayGuaranteesUsed(tx, { locationId: c.locationId, customerId: input.customerId, now, tz: c.tz })
    : 0
  const ev = evaluateStart(
    engineInput(data, { durationMin: input.durationMin, channel, isVip, sameDayUsed }),
    input.start,
  )
  const fail = () =>
    slotError(ev, {
      releaseHours: data.settings.vip.releaseHours,
      windowDays: isVip ? data.settings.vip.windowVipDays : data.settings.vip.windowStdDays,
    })

  if (ev.state === 'available') return { evaluation: ev, overrides: [], bizDate }
  if (ev.overrideKind === null) throw fail()

  const reason = input.override?.reason?.trim() ?? ''
  if (input.override) {
    if (!can(actor, 'sched.override')) throw new AppError('OVERRIDE_NOT_ALLOWED')
    if (reason === '') throw new AppError('OVERRIDE_REASON_REQUIRED')
    return { evaluation: ev, overrides: [{ kind: ev.overrideKind, reason }], bizDate }
  }
  if (ev.sameDayEligible) {
    return {
      evaluation: ev,
      overrides: [{ kind: 'same_day_guarantee', reason: 'Same-day guarantee for a VIP client' }],
      bizDate,
    }
  }
  throw fail()
}

/** Writes the overrides the decision used (appointment_overrides), one row each. */
export async function recordOverrides(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  appointmentId: string,
  decision: SlotDecision,
): Promise<void> {
  for (const o of decision.overrides) {
    await tx
      .insertInto('appointment_overrides')
      .values({
        id: c.newId(),
        appointment_id: appointmentId,
        kind: o.kind,
        reason: o.reason,
        employee_id: actor.auth.employeeId,
      })
      .execute()
  }
}

