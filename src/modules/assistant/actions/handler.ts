// The reply-number handler (ADR 0160, design sections 0 and 3; the W2d ActionCodeHandler port; wave W3b). A digits-only text from a
// number with an in-chat action waiting for its reply number comes here, inside the webhook's transaction, before any model:
//   1. the kill switches: with AI_ENABLED or assistant.enabled off the action is canceled and nothing is said (the AI is off); with
//      AI_ACTIONS_ENABLED or assistant.actions_enabled off it is canceled and the client is told a team member will text back; the
//      turn's stage and opt-out rules (messaging/assistant/gate.ts stageAndConsent: the allowlist, a known non-stale client in the
//      customers stage, no opt-out) cancel it unanswered; so does an open handoff of the number or a staff pause of the client's
//      thread (the chat is the staff's: W4c re-review L2);
//   2. the number is checked against the pending action of THIS phone only (identity/pending-actions.ts confirmPendingAction): a
//      wrong number counts a try (3 tries lock it), an expired one is refused, and the phone's trust is checked again;
//   3. the confirmed action runs as the assistant's actor (createAppointment channel online, source sms_ai | rescheduleAppointment |
//      cancelAppointment with notify) inside a savepoint, so a refusal (the time was taken meanwhile) leaves the webhook's
//      transaction intact and the action failed;
//   4. the client gets the answer (class ai_reply: the booking confirmation, or a short line; a reschedule and a cancel are confirmed
//      by the scheduling texts themselves), and a booking closes the number's lead.
// The digits are never logged, stored readable or shown to the model (the messaging core masks them before this runs).
import type { Tx } from '../../../platform/db.js'
import * as audit from '../../../platform/audit.js'
import { getSetting } from '../../../platform/settings.js'
import { fmtT, minutesOfDay, toBizDate, wallToInstant } from '../../../platform/time.js'
import {
  findPendingAction,
  cancelPendingActions,
  completePendingAction,
  confirmPendingAction,
  failPendingAction,
  staffHoldsChat,
  type ConfirmedAction,
} from '../../identity/pending-actions.js'
import { evaluateTrust } from '../../identity/trust.js'
import { markLeadBooked } from '../../leads/service.js'
import { stageAndConsent } from '../../messaging/assistant/gate.js'
import { hasActiveOptOut, loadCustomerTarget } from '../../messaging/db/recipients.js'
import { loadBoardServices } from '../../public/availability-loader.js'
import { getAppointment, logActivity } from '../../scheduling/appointments.js'
import { createAppointment } from '../../scheduling/booking.js'
import { cancelAppointment, rescheduleAppointment } from '../../scheduling/lifecycle.js'
import type { ActionCodeHandler, ActionCodeInput } from '../ports.js'
import type { AssistantDeps, CreateActionCodeHandler } from '../contract.js'
import { usd } from '../facts.js'
import { isConvoLang, serverTextEs, whenIn, type ConvoLang } from '../lang.js'
import { actionsOn, assistantOn } from '../tools/switches.js'
import { aiBookingsAhead, dayWord, inSavepoint, MAX_AI_BOOKINGS_AHEAD, plainSchedulingError, privilegesOf, slotVerdict, windowDaysFor } from '../tools/common.js'
import { requestDepositLink } from '../../square/deposits.js'
import { BookPayload, CancelPayload, cancelBlockOf, ReschedulePayload } from './plan.js'

/** The answer: a template (English) and, for a Spanish conversation, its Spanish text (lang.ts serverTextEs), sent as ai_reply with the template key as its tag. */
type Reply = { templateKey: string; vars?: Record<string, string>; es?: string | null } | null

class ActionRefused extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

export const createActionCodeHandler: CreateActionCodeHandler = (deps): ActionCodeHandler => ({
  async hasPending(db, q) {
    return (await findPendingAction(db, q)) !== null
  },

  async handle(tx, input) {
    const at = input.at
    if (!(await assistantOn(tx, deps.env, input.locationId))) {
      await cancelPendingActions(tx, { locationId: input.locationId, phone: input.phone, now: at, error: 'the assistant is switched off' })
      return
    }
    if (!(await actionsOn(tx, deps.env, input.locationId))) {
      const n = await cancelPendingActions(tx, { locationId: input.locationId, phone: input.phone, now: at, error: 'in-chat actions are switched off' })
      if (n > 0) await answer(tx, deps, input, null, { templateKey: 'action_unavailable' })
      return
    }
    // the same stage and opt-out rules as a turn: a narrowed stage (a kill switch) or an opt-out ends the action unanswered
    const refused = await stageAndConsent(tx, {
      locationId: input.locationId,
      phone: input.phone,
      customerId: input.customerId,
      optedOut: await hasActiveOptOut(tx, input.locationId, input.phone),
      now: at,
    })
    if (refused) {
      await cancelPendingActions(tx, { locationId: input.locationId, phone: input.phone, now: at, error: `the assistant does not serve this number now (${refused})` })
      return
    }
    // the chat is the staff's (an open handoff of the number, or a staff pause of the client's thread): the action is canceled
    // unanswered and never runs, whenever it was proposed (W4c re-review L2)
    const pendingFor = await findPendingAction(tx, { locationId: input.locationId, phone: input.phone, now: at })
    if (await staffHoldsChat(tx, { locationId: input.locationId, phone: input.phone, customerId: pendingFor?.customerId ?? input.customerId, now: at })) {
      await cancelPendingActions(tx, { locationId: input.locationId, phone: input.phone, now: at, error: 'staff hold the chat (an open handoff or a staff pause)' })
      return
    }
    const outcome = await confirmPendingAction(tx, { locationId: input.locationId, phone: input.phone, code: input.code, now: at })
    switch (outcome.status) {
      case 'none':
      case 'expired':
        await answer(tx, deps, input, input.customerId, { templateKey: 'action_code_expired' })
        return
      case 'wrong':
        await answer(tx, deps, input, input.customerId, { templateKey: 'action_code_wrong' })
        return
      case 'locked':
        await answer(tx, deps, input, input.customerId, { templateKey: 'action_code_locked' })
        return
      case 'untrusted':
        await answer(tx, deps, input, input.customerId, { templateKey: 'action_needs_verify' })
        return
      case 'confirmed': {
        const action = outcome.action
        let reply: Reply
        try {
          reply = await inSavepoint(tx, 'assistant_action', () => execute(tx, deps, input, action))
        } catch (e) {
          const reason = e instanceof ActionRefused ? e.reason : plainSchedulingError(e)
          if (reason === null) throw e
          await failPendingAction(tx, action.id, { error: reason, now: at })
          await answer(tx, deps, input, action.customerId, { templateKey: 'action_failed', vars: { reason: capitalize(reason) }, es: serverTextEs('action_failed', { reason }) })
          return
        }
        await answer(tx, deps, input, action.customerId, reply)
        return
      }
    }
  },
})

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** The language of the number's assistant conversation (English when there is none). */
async function phoneLanguage(tx: Tx, locationId: string, phone: string): Promise<ConvoLang> {
  const c = await tx
    .selectFrom('assistant_conversations')
    .select('language')
    .where('location_id', '=', locationId)
    .where('phone_e164', '=', phone)
    .executeTakeFirst()
  return isConvoLang(c?.language) ? c.language : 'en'
}

/** The client's answer: ai_reply's rules (an answer to their text), the "Oasis AI" label, once per received text. */
async function answer(tx: Tx, deps: AssistantDeps, input: ActionCodeInput, customerId: string | null, reply: Reply): Promise<void> {
  if (!reply) return
  const id = customerId ?? input.customerId
  if (!id) return
  const target = await loadCustomerTarget(tx, input.locationId, id)
  if (!target || target.recipient.phone !== input.phone) return
  // guard polish after W4b-fix (P3): a Spanish conversation gets the Spanish text (the English template otherwise)
  const lang = await phoneLanguage(tx, input.locationId, input.phone)
  const es = lang === 'es' ? (reply.es ?? serverTextEs(reply.templateKey, reply.vars ?? {})) : null
  const out = await deps.queue.enqueueFor(tx, {
    locationId: input.locationId,
    customerId: id,
    recipient: target.recipient,
    appointmentId: null,
    ...(es ? { text: es, klass: 'ai_reply' as const, tag: reply.templateKey } : { templateKey: reply.templateKey, ...(reply.vars ? { vars: reply.vars } : {}) }),
    purpose: 'assistant-action',
    senderKind: 'ai',
    dedupeKey: `assistant-action-reply:${input.inboxId}`,
  })
  if (!out.queued) deps.log.warn({ template: reply.templateKey, skipped: out.skipped }, 'reply-number answer not queued')
}

/** Executes a confirmed action as the assistant's actor. Throws ActionRefused (or a scheduling AppError) when it cannot run. */
async function execute(tx: Tx, deps: AssistantDeps, input: ActionCodeInput, action: ConfirmedAction): Promise<Reply> {
  const loc = input.locationId
  const now = input.at
  const sched = deps.schedulingFor(loc)
  const actor = deps.actorFor(loc)
  const tz = sched.tz
  const today = toBizDate(now, tz)
  const customer = await tx
    .selectFrom('customers')
    .select(['id', 'phone_e164', 'deleted_at', 'merged_into'])
    .where('id', '=', action.customerId)
    .executeTakeFirst()
  if (!customer || customer.deleted_at !== null || customer.merged_into !== null || customer.phone_e164 !== input.phone)
    throw new ActionRefused('this number is no longer the one on your record.')

  if (action.kind === 'book') {
    const p = BookPayload.parse(action.payload)
    const services = await loadBoardServices(tx, loc)
    const pkg = services.packages.find((s) => s.key === p.serviceKey && s.active && s.visibleOnline && !s.quoteOnly)
    if (!pkg) throw new ActionRefused('that service is no longer offered online.')
    const addons = p.addonKeys.map((k) => services.addons.find((a) => a.key === k && a.active && !a.quoteOnly))
    if (addons.some((a) => a === undefined)) throw new ActionRefused('one of those add-ons is no longer offered online.')
    if ((await aiBookingsAhead(tx, customer.id, now)) >= MAX_AI_BOOKINGS_AHEAD)
      throw new ActionRefused(`you already have ${MAX_AI_BOOKINGS_AHEAD} upcoming visits booked by text.`)
    const priv = await privilegesOf(tx, loc, customer.id, now)
    // the VIP rules only for a VIP whose number is trusted (the action exists only inside the trust)
    const v = await slotVerdict(tx, {
      locationId: loc,
      tz,
      now,
      date: p.date,
      startMin: p.startMin,
      durationMin: pkg.durationMin,
      vip: priv.vip,
      customerId: customer.id,
      windowDays: await windowDaysFor(tx, loc, priv.vip),
    })
    if (!v.ok) throw new ActionRefused(v.problem === 'past' ? 'that time has passed.' : 'that time was just taken.')
    const vehicle = p.vehicleId
      ? await tx
          .selectFrom('vehicles')
          .select(['year', 'make', 'model', 'color', 'plate'])
          .where('id', '=', p.vehicleId)
          .where('customer_id', '=', customer.id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst()
      : undefined
    // a trust granted by the client's own PIN makes the visit proof of them for the stale-record rule (a code's never does)
    const trust = await evaluateTrust(tx, { locationId: loc, phone: input.phone, now, customerId: customer.id })
    const booked = await createAppointment(tx, sched, actor, {
      bookedWithPin: trust.trusted && trust.verifiedBy === 'pin',
      customer: { id: customer.id },
      vehicle: vehicle ?? null,
      serviceId: pkg.id,
      addonIds: addons.map((a) => a!.id),
      start: wallToInstant(p.date, p.startMin, tz),
      source: 'sms_ai',
      channel: 'online',
      vip: priv.vip,
      // the answer below is the confirmation (an answer to their reply number, labelled Oasis AI)
      message: null,
    })
    const appointmentId = booked.appointment.id
    const fee = await getSetting(tx, loc, 'booking.guest_fee')
    const dueCents = priv.member ? 0 : fee.value.cents
    const how = fee.value.collect === 'link' ? 'by payment link' : 'at the shop'
    // the deposit by Square link (ADR 0171 D2): a request the job square.deposit-link turns into a texted quick-pay link
    await requestDepositLink(tx, { newId: sched.newId, clock: sched.clock }, { locationId: loc, appointmentId, cents: dueCents, collect: fee.value.collect })
    await logActivity(tx, sched, {
      appointmentId,
      text: `Booked by text with Oasis AI · confirmed with the reply number${priv.member ? ' · member, no booking fee' : dueCents > 0 ? ` · ${usd(dueCents)} booking fee due ${how}` : ''}`,
      channels: ['system'],
      actor,
    })
    await completePendingAction(tx, action.id, { appointmentId })
    await markLeadBooked(tx, { locationId: loc, phone: input.phone, appointmentId, at: now })
    await audit.record(tx, {
      locationId: loc,
      action: 'assistant.booking.confirmed',
      entityType: 'appointment',
      entityId: appointmentId,
      after: { pendingActionId: action.id, serviceKey: p.serviceKey, date: p.date, startMin: p.startMin },
      ctx: actor.audit,
    })
    const extra: Record<string, string> = priv.member ? { member: 'yes' } : dueCents > 0 ? { fee: usd(dueCents), how } : {}
    return {
      templateKey: 'action_booked',
      vars: {
        service: p.serviceName,
        when: dayWord(p.date, today),
        time: fmtT(p.startMin),
        // the fee written the way the {fee} placeholder writes it in the same conversation (facts.ts usd: "$25", "$25.50")
        ...extra,
      },
      es: serverTextEs('action_booked', { service: p.serviceName, when: whenIn('es', p.date, p.startMin, today), ...extra }),
    }
  }

  if (action.kind === 'reschedule') {
    const p = ReschedulePayload.parse(action.payload)
    const a = await getAppointment(tx, loc, p.appointmentId)
    if (!a || a.customerId !== customer.id) throw new ActionRefused('that visit is not on your record any more.')
    if (!['booked', 'confirmed'].includes(a.status) || a.scheduledStart.getTime() <= now.getTime())
      throw new ActionRefused('that visit can no longer be changed by text.')
    const priv = await privilegesOf(tx, loc, customer.id, now)
    const v = await slotVerdict(tx, {
      locationId: loc,
      tz,
      now,
      date: p.date,
      startMin: p.startMin,
      durationMin: a.durationMin,
      vip: priv.vip,
      customerId: customer.id,
      windowDays: await windowDaysFor(tx, loc, priv.vip),
      excludeAppointmentId: a.id,
    })
    if (!v.ok) throw new ActionRefused(v.problem === 'past' ? 'that time has passed.' : 'that time was just taken.')
    // rescheduleAppointment texts the client the new time (the reschedule template): that text is the confirmation; a Spanish
    // conversation gets the Spanish ack below instead (P3)
    const es = (await phoneLanguage(tx, loc, input.phone)) === 'es'
    await rescheduleAppointment(tx, sched, actor, a.id, { start: wallToInstant(p.date, p.startMin, tz), ...(es ? { notify: false } : {}) })
    await logActivity(tx, sched, { appointmentId: a.id, text: 'Moved by text with Oasis AI · confirmed with the reply number', channels: ['system'], actor })
    await completePendingAction(tx, action.id, { appointmentId: a.id })
    await audit.record(tx, {
      locationId: loc,
      action: 'assistant.reschedule.confirmed',
      entityType: 'appointment',
      entityId: a.id,
      before: { start: a.scheduledStart.toISOString() },
      after: { pendingActionId: action.id, date: p.date, startMin: p.startMin },
      ctx: actor.audit,
    })
    return es ? { templateKey: 'reschedule', es: serverTextEs('reschedule', { when: whenIn('es', p.date, p.startMin, today) }) } : null
  }

  const p = CancelPayload.parse(action.payload)
  const a = await getAppointment(tx, loc, p.appointmentId)
  if (!a || a.customerId !== customer.id) throw new ActionRefused('that visit is not on your record any more.')
  if (!['booked', 'confirmed'].includes(a.status) || a.scheduledStart.getTime() <= now.getTime())
    throw new ActionRefused('that visit can no longer be canceled by text.')
  if (await cancelBlockOf(tx, { locationId: loc, appointmentId: a.id, start: a.scheduledStart, now }))
    throw new ActionRefused('it is now too close to the visit (or money is held on it) to cancel by text.')
  // cancelAppointment with notify texts the cancellation notice: that text is the confirmation; a Spanish conversation gets the
  // Spanish ack below instead (P3; a cancel by text never has money held on it, so the notice has no deposit sentence to lose)
  const es = (await phoneLanguage(tx, loc, input.phone)) === 'es'
  const whenEs = whenIn('es', toBizDate(a.scheduledStart, tz), minutesOfDay(a.scheduledStart, tz), today)
  await cancelAppointment(tx, sched, actor, a.id, { reason: `Canceled by the client by text (Oasis AI): ${p.reason}`, notify: !es, deposit: 'policy' })
  await completePendingAction(tx, action.id, { appointmentId: a.id })
  await audit.record(tx, {
    locationId: loc,
    action: 'assistant.cancel.confirmed',
    entityType: 'appointment',
    entityId: a.id,
    after: { pendingActionId: action.id, reason: p.reason },
    ctx: actor.audit,
  })
  return es ? { templateKey: 'cancel', es: serverTextEs('cancel', { when: whenEs }) } : null
}
