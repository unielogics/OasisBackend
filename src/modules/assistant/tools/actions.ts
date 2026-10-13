// The in-chat actions (ADR 0160, design sections 0 and 4): propose_booking, propose_reschedule, propose_cancel. Only for a number
// trusted in the last 30 days (verified on a link page) and only while AI_ACTIONS_ENABLED and assistant.actions_enabled; each one is a
// PROPOSAL: the server records it (identity/pending-actions.ts: the trust is checked again there) and texts the client the summary
// with a 4-digit reply number (class action_confirm, the number a secretVar: masked in the thread). Nothing changes until the client
// texts that number back (actions/handler.ts). The model never sees the number. Untrusted: needs_verification (send a verify link).
// While staff hold the chat (an open handoff, a staff pause) nothing is proposed: unavailable (identity/pending-actions.ts). Nor once
// the turn itself has asked for a handoff (handoff_to_staff or a tool's; the handoff opens when the turn ends): unavailable, nothing
// is recorded or texted (W4c re-review 2, N3).
// A cancel inside the late window or with money held on the visit is the staff's (handoff).
import { z } from 'zod/v4'
import { toBizDate, minutesOfDay } from '../../../platform/time.js'
import { listVehicles } from '../../customers/service.js'
import { loadBoardServices } from '../../public/availability-loader.js'
import { TOOL_MIN_TRUST, type AssistantTool, type ProposeEffect, type ToolContext, type ToolInputs, type ToolOutcome } from '../contract.js'
import { cancelBlockOf, serviceWithAddons, type BookPayload, type CancelPayload, type ReschedulePayload } from '../actions/plan.js'
import { bookablePackage, vipFor } from './availability.js'
import { actionSummaryIn, conversationVoice, whenIn } from '../lang.js'
import { effectsOf, HANDED_OFF, NEEDS_VERIFY } from './effects-live.js'
import {
  aiBookingsAhead,
  BIZ_DATE,
  fail,
  json,
  MAX_AI_BOOKINGS_AHEAD,
  ownAppointment,
  slotVerdict,
  whenWords,
  windowDaysFor,
  withHandoff,
  type SlotVerdict,
} from './common.js'

const Ref = z.enum(['A1', 'A2', 'A3'])
const StartMin = z.number().int().min(0).max(24 * 60 - 1)

const OFF = 'Booking, moving or canceling by text is switched off right now. Offer the booking link or a team member.'

/** The pre-checks every action shares: actions on, no handoff asked for in this turn, a client, a trust the server agrees with. */
function precheck(ctx: ToolContext): ToolOutcome | null {
  if (!ctx.actionsEnabled) return fail('unavailable', OFF)
  if (ctx.handoffRequested()) return fail('unavailable', HANDED_OFF)
  if (!ctx.identity.customerId) return fail('not_allowed', 'There is no client record for this number.')
  if (ctx.identity.trust !== 'trusted') return fail('needs_verification', NEEDS_VERIFY)
  return null
}

function slotFailure(v: Extract<SlotVerdict, { ok: false }>): ToolOutcome {
  return fail('invalid', v.message, { detail: json({ openTimesThatDay: v.open }) })
}

/** Records the proposal and texts its reply number (the context's effects, ADR 0174 §4b), unless the turn asked for a handoff. */
async function propose(ctx: ToolContext, o: ProposeEffect): Promise<ToolOutcome> {
  if (ctx.handoffRequested()) return fail('unavailable', HANDED_OFF)
  return effectsOf(ctx).propose(ctx, o)
}

export const proposeBooking: AssistantTool<ToolInputs['propose_booking']> = {
  name: 'propose_booking',
  description:
    'Proposes a booking for the verified client: serviceKey (a package from list_services), addonKeys (add-on keys, or []), date (YYYY-MM-DD), startMin (from check_availability), vehicle (the client’s own vehicle as they named it, or null: a vehicle is never needed, so never ask for one before proposing), vehicleClass (the car’s size key from SHOP FACTS when the client said it or a vehicle on file has it, else null: the visit is then priced at the starting price and the size is confirmed at the shop). The server texts them a confirmation number; nothing is booked until they reply with it.',
  input: z.strictObject({
    serviceKey: z.string().min(1).max(80),
    addonKeys: z.array(z.string().min(1).max(80)).max(6),
    date: z.string().regex(BIZ_DATE),
    startMin: StartMin,
    vehicle: z.string().max(60).nullable(),
    vehicleClass: z.string().max(32).nullable(),
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
    // facts-v4: the size the client said, one of the shop's sizes (Settings → Vehicle sizes)
    let said: string | null = null
    if (input.vehicleClass !== null) {
      const size = ctx.facts.catalog.sizes.find((x) => x.key === input.vehicleClass!.trim().toLowerCase())
      if (!size) return fail('invalid', 'Use a size key from SHOP FACTS for vehicleClass, or null.', { detail: json({ sizes: ctx.facts.catalog.sizes }) })
      said = size.key
    }
    let vehicleId: string | null = null
    let vehicleClass: string | null = said
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
      // the size the visit is priced at (ADR 0170): a size staff set on the car wins over what the client says; else the size the
      // client said, else the car's size on file
      const car = match[0]!
      vehicleClass = car.vehicleClassSource === 'staff' && car.vehicleClass ? car.vehicleClass : (said ?? car.vehicleClass)
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
    const lang = ctx.lang ?? (await conversationVoice(ctx.db, ctx.conversationId)).lang
    const service = serviceWithAddons(found.item.name, addons.map((a) => a.name))
    const payload: BookPayload = {
      serviceKey: found.item.key,
      serviceName: found.item.name,
      addonKeys: addons.map((a) => a.key),
      date: input.date,
      startMin: input.startMin,
      vehicleId,
      vehicleClass,
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
    const lang = ctx.lang ?? (await conversationVoice(ctx.db, ctx.conversationId)).lang
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
    const lang = ctx.lang ?? (await conversationVoice(ctx.db, ctx.conversationId)).lang
    const summary = actionSummaryIn(lang, { kind: 'cancel', service: a.serviceName, when: lang === 'en' ? when : whenIn(lang, toBizDate(a.start, tz), minutesOfDay(a.start, tz), today) })
    return propose(ctx, { kind: 'cancel', summary, payload, appointmentId: a.id })
  },
}
