// The in-chat actions (ADR 0160, design sections 0 and 4): propose_booking, propose_reschedule, propose_cancel. Only for a number
// trusted in the last 30 days (verified on a link page) and only while AI_ACTIONS_ENABLED and assistant.actions_enabled; each one is a
// PROPOSAL: the server records it (identity/pending-actions.ts: the trust is checked again there) and texts the client the summary
// with a 4-digit reply number (class action_confirm, the number a secretVar: masked in the thread). Nothing changes until the client
// texts that number back (actions/handler.ts). The model never sees the number. Untrusted: needs_verification (send a verify link).
// A cancel inside the late window or with money held on the visit is the staff's (handoff).
import { z } from 'zod/v4'
import { transaction } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import { toBizDate, minutesOfDay } from '../../../platform/time.js'
import { listVehicles } from '../../customers/service.js'
import { attachConfirmMessage, createPendingAction } from '../../identity/pending-actions.js'
import type { PendingActionKind } from '../../identity/schema.js'
import type { JsonValue } from '../../../platform/schema.js'
import { loadCustomerTarget } from '../../messaging/db/recipients.js'
import { loadBoardServices } from '../../public/availability-loader.js'
import { TOOL_MIN_TRUST, type AssistantTool, type ToolContext, type ToolInputs, type ToolOutcome } from '../contract.js'
import { cancelBlockOf, serviceWithAddons, type BookPayload, type CancelPayload, type ReschedulePayload } from '../actions/plan.js'
import { bookablePackage, vipFor } from './availability.js'
import { actionConfirmText, actionSummaryIn, conversationVoice, markDisclosed, whenIn, withDisclosure } from '../lang.js'
import {
  aiBookingsAhead,
  BIZ_DATE,
  fail,
  json,
  MAX_AI_BOOKINGS_AHEAD,
  ok,
  ownAppointment,
  slotVerdict,
  whenWords,
  windowDaysFor,
  withHandoff,
  type SlotVerdict,
} from './common.js'

const Ref = z.enum(['A1', 'A2', 'A3'])
const StartMin = z.number().int().min(0).max(24 * 60 - 1)

const NEEDS_VERIFY = 'This needs a quick verification first: send the client a verify link (send_link kind verify).'
const OFF = 'Booking, moving or canceling by text is switched off right now. Offer the booking link or a team member.'

class Refused extends Error {
  constructor(readonly outcome: ToolOutcome) {
    super('refused')
  }
}

/** The pre-checks every action shares: actions on, a client, a trust the server agrees with. */
function precheck(ctx: ToolContext): ToolOutcome | null {
  if (!ctx.actionsEnabled) return fail('unavailable', OFF)
  if (!ctx.identity.customerId) return fail('not_allowed', 'There is no client record for this number.')
  if (ctx.identity.trust !== 'trusted') return fail('needs_verification', NEEDS_VERIFY)
  return null
}

function slotFailure(v: Extract<SlotVerdict, { ok: false }>): ToolOutcome {
  return fail('invalid', v.message, { detail: json({ openTimesThatDay: v.open }) })
}

/**
 * Records the proposal and texts its reply number in one transaction: the text is queued with the number as a secretVar (masked in
 * the message row) and linked to the action. When the text cannot be queued (opted out, no recent text from them, ...) nothing is kept.
 */
async function propose(
  ctx: ToolContext,
  o: { kind: PendingActionKind; summary: string; payload: { [key: string]: JsonValue }; appointmentId: string | null },
): Promise<ToolOutcome> {
  const customerId = ctx.identity.customerId!
  try {
    await transaction(ctx.db, async (tx) => {
      let proposal
      try {
        proposal = await createPendingAction(
          tx,
          { newId: ctx.newId, now: ctx.now },
          { locationId: ctx.identity.locationId, conversationId: ctx.conversationId, customerId, phone: ctx.identity.phone, kind: o.kind, payload: o.payload },
        )
      } catch (e) {
        if (e instanceof AppError && e.code === 'IDENTITY_NOT_TRUSTED') throw new Refused(fail('needs_verification', NEEDS_VERIFY))
        throw e
      }
      const target = await loadCustomerTarget(tx, ctx.identity.locationId, customerId)
      if (!target || target.recipient.phone !== ctx.identity.phone)
        throw new Refused(fail('not_allowed', 'This number is not the client’s number on file.'))
      // W4b X1: when this is the first text of the conversation's AI flow (a trusted client's first text can be a proposal), it
      // carries the automated-assistant disclosure and the STOP footer, and the reply that follows does not repeat them; X5: in the
      // conversation's language
      const voice = await conversationVoice(tx, ctx.conversationId)
      const body = actionConfirmText(o.summary, voice.lang)
      const out = await ctx.queue.enqueueFor(tx, {
        locationId: ctx.identity.locationId,
        customerId,
        recipient: target.recipient,
        appointmentId: o.appointmentId,
        text: voice.disclosed ? body : withDisclosure(body, voice.lang),
        klass: 'action_confirm',
        tag: 'action_confirm',
        secretVars: { code: proposal.code },
        purpose: `assistant-${o.kind}-confirm`,
        senderKind: 'ai',
        dedupeKey: `action-confirm:${proposal.id}`,
      })
      if (!out.queued)
        throw new Refused(
          fail(
            'unavailable',
            'The confirmation text could not be sent to this number. Offer a team member instead.',
          ),
        )
      if (!voice.disclosed) await markDisclosed(tx, ctx.conversationId, ctx.now)
      await attachConfirmMessage(tx, proposal.id, out.messageId)
      await ctx.audit(tx, `assistant.${o.kind}.proposed`, {
        entityType: o.appointmentId ? 'appointment' : 'customer',
        entityId: o.appointmentId ?? customerId,
        after: { kind: o.kind, summary: o.summary, expiresAt: proposal.expiresAt.toISOString() },
      })
    })
  } catch (e) {
    if (e instanceof Refused) return e.outcome
    throw e
  }
  return ok({
    proposed: o.kind,
    summary: o.summary,
    confirmationTexted: true,
    expiresInMinutes: 15,
    // the server's own text already says how to confirm; the policy judge fails any reply of the model that asks for a number they
    // received (design 3c rubric (c)), so the model only points at that text
    instruction:
      'The server just texted the client this summary with how to confirm it. In your reply write the placeholder {confirm} as its own sentence ("{confirm}."): the server writes "I just texted you the details with how to confirm." Add nothing else about confirming, and never mention, ask for or repeat any number or code. Nothing is booked or changed until they confirm.',
  })
}

export const proposeBooking: AssistantTool<ToolInputs['propose_booking']> = {
  name: 'propose_booking',
  description:
    'Proposes a booking for the verified client: serviceKey (a package from list_services), addonKeys (add-on keys, or []), date (YYYY-MM-DD), startMin (from check_availability), vehicle (the client’s own vehicle as they named it, or null: a vehicle is never needed, so never ask for one before proposing). The server texts them a confirmation number; nothing is booked until they reply with it.',
  input: z.strictObject({
    serviceKey: z.string().min(1).max(80),
    addonKeys: z.array(z.string().min(1).max(80)).max(6),
    date: z.string().regex(BIZ_DATE),
    startMin: StartMin,
    vehicle: z.string().max(60).nullable(),
  }),
  minTrust: TOOL_MIN_TRUST.propose_booking,
  action: true,
  async run(ctx, input) {
    const pre = precheck(ctx)
    if (pre) return pre
    const customerId = ctx.identity.customerId!
    const found = await bookablePackage(ctx, input.serviceKey)
    if (!found) return fail('invalid', 'Unknown or not bookable service. Use a package key from list_services that is not quote-only.')
    const services = await loadBoardServices(ctx.db, ctx.identity.locationId)
    const addons = []
    for (const key of [...new Set(input.addonKeys)]) {
      const item = ctx.facts.catalog.items.find((i) => i.key === key && i.kind === 'addon' && !i.quoteOnly)
      const svc = services.addons.find((a) => a.key === key && a.active)
      if (!item || !svc) return fail('invalid', `Unknown add-on "${key}". Use add-on keys from list_services.`)
      addons.push(item)
    }
    if ((await aiBookingsAhead(ctx.db, customerId, ctx.now)) >= MAX_AI_BOOKINGS_AHEAD)
      return fail('rate_limited', `This client already has ${MAX_AI_BOOKINGS_AHEAD} upcoming visits booked by text; more go through the team or the booking link.`)
    let vehicleId: string | null = null
    if (input.vehicle) {
      const words = input.vehicle.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && w !== 'the' && w !== 'my')
      const vehicles = await listVehicles(ctx.db, customerId)
      const match = vehicles.filter((v) => {
        const label = [v.year, v.make, v.model, v.color].filter((x) => x !== null && x !== undefined).join(' ').toLowerCase()
        return words.length > 0 && words.every((w) => label.includes(w))
      })
      if (match.length !== 1)
        return fail('invalid', match.length === 0 ? 'That vehicle is not on the client’s record. Save it with set_my_vehicle first, or pass null.' : 'Several vehicles match; name it more precisely.')
      vehicleId = match[0]!.id
    }
    const vip = await vipFor(ctx)
    const v = await slotVerdict(ctx.db, {
      locationId: ctx.identity.locationId,
      tz: ctx.scheduling.tz,
      now: ctx.now,
      date: input.date,
      startMin: input.startMin,
      durationMin: found.pkg.durationMin,
      vip,
      customerId,
      windowDays: await windowDaysFor(ctx.db, ctx.identity.locationId, vip),
    })
    if (!v.ok) return slotFailure(v)
    const today = toBizDate(ctx.now, ctx.scheduling.tz)
    const { lang } = await conversationVoice(ctx.db, ctx.conversationId)
    const service = serviceWithAddons(found.item.name, addons.map((a) => a.name))
    const payload: BookPayload = {
      serviceKey: found.item.key,
      serviceName: found.item.name,
      addonKeys: addons.map((a) => a.key),
      date: input.date,
      startMin: input.startMin,
      vehicleId,
    }
    // guard polish after W4b-fix (P3): the summary and its date in the conversation's language ("vie 16 oct, 11:00 a. m.")
    return propose(ctx, { kind: 'book', summary: actionSummaryIn(lang, { kind: 'book', service, when: whenIn(lang, input.date, input.startMin, today) }), payload, appointmentId: null })
  },
}

export const proposeReschedule: AssistantTool<ToolInputs['propose_reschedule']> = {
  name: 'propose_reschedule',
  description:
    'Proposes moving one of the verified client’s upcoming visits (appointmentRef A1..A3) to a new date and startMin (from check_availability). The server texts them a confirmation number; nothing moves until they reply with it.',
  input: z.strictObject({ appointmentRef: Ref, date: z.string().regex(BIZ_DATE), startMin: StartMin }),
  minTrust: TOOL_MIN_TRUST.propose_reschedule,
  action: true,
  async run(ctx, input) {
    const pre = precheck(ctx)
    if (pre) return pre
    const a = await ownAppointment(ctx.db, ctx, input.appointmentRef)
    if (!a) return fail('not_found', 'No such appointment for this client.')
    if (!['booked', 'confirmed'].includes(a.status) || a.start.getTime() <= ctx.now.getTime())
      return fail('not_allowed', 'That visit can no longer be moved by text.')
    const vip = await vipFor(ctx)
    const v = await slotVerdict(ctx.db, {
      locationId: ctx.identity.locationId,
      tz: ctx.scheduling.tz,
      now: ctx.now,
      date: input.date,
      startMin: input.startMin,
      durationMin: a.durationMin,
      vip,
      customerId: a.customerId,
      windowDays: await windowDaysFor(ctx.db, ctx.identity.locationId, vip),
      excludeAppointmentId: a.id,
    })
    if (!v.ok) return slotFailure(v)
    const tz = ctx.scheduling.tz
    const today = toBizDate(ctx.now, tz)
    if (toBizDate(a.start, tz) === input.date && minutesOfDay(a.start, tz) === input.startMin) return fail('invalid', 'That is already the time of that visit.')
    const payload: ReschedulePayload = { appointmentId: a.id, serviceName: a.serviceName, date: input.date, startMin: input.startMin }
    const { lang } = await conversationVoice(ctx.db, ctx.conversationId)
    return propose(ctx, {
      kind: 'reschedule',
      summary: actionSummaryIn(lang, { kind: 'reschedule', service: a.serviceName, when: whenIn(lang, input.date, input.startMin, today) }),
      payload,
      appointmentId: a.id,
    })
  },
}

export const proposeCancel: AssistantTool<ToolInputs['propose_cancel']> = {
  name: 'propose_cancel',
  description:
    'Proposes canceling one of the verified client’s upcoming visits (appointmentRef A1..A3) with their reason in a few words. Too close to the visit, or with money already paid on it, a team member handles it instead. The server texts them a confirmation number; nothing is canceled until they reply with it.',
  input: z.strictObject({ appointmentRef: Ref, reason: z.string().min(1).max(200) }),
  minTrust: TOOL_MIN_TRUST.propose_cancel,
  action: true,
  async run(ctx, input) {
    const pre = precheck(ctx)
    if (pre) return pre
    const a = await ownAppointment(ctx.db, ctx, input.appointmentRef)
    if (!a) return fail('not_found', 'No such appointment for this client.')
    if (!['booked', 'confirmed'].includes(a.status) || a.start.getTime() <= ctx.now.getTime())
      return fail('not_allowed', 'That visit can no longer be canceled by text.')
    const block = await cancelBlockOf(ctx.db, { locationId: ctx.identity.locationId, appointmentId: a.id, start: a.start, now: ctx.now })
    const tz = ctx.scheduling.tz
    const today = toBizDate(ctx.now, tz)
    const when = whenWords(toBizDate(a.start, tz), minutesOfDay(a.start, tz), today)
    if (block)
      return withHandoff(
        ctx,
        fail('not_allowed', 'A team member handles this cancellation (it is close to the visit or money is held on it). Tell the client a team member will text them shortly.'),
        'late_cancel',
        `The client asked by text to cancel their ${a.serviceName} ${when} (${block === 'late' ? 'inside the free-cancellation window' : 'money is held on the visit'}). Reason: ${input.reason.slice(0, 120)}`,
      )
    const payload: CancelPayload = { appointmentId: a.id, serviceName: a.serviceName, reason: input.reason.replace(/\s+/g, ' ').trim().slice(0, 200) }
    const { lang } = await conversationVoice(ctx.db, ctx.conversationId)
    const summary = actionSummaryIn(lang, { kind: 'cancel', service: a.serviceName, when: lang === 'en' ? when : whenIn(lang, toBizDate(a.start, tz), minutesOfDay(a.start, tz), today) })
    return propose(ctx, { kind: 'cancel', summary, payload, appointmentId: a.id })
  },
}
