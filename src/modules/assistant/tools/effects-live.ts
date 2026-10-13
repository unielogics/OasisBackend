// The tools' LIVE side effects (ADR 0174 §4b): every write the assistant's tools make, moved here as it was from the tools
// (tools/conversation.ts, actions.ts, account.ts, availability.ts), behind the ToolEffects seam of contract.ts. The tools keep
// their checks and reads and call ctx.effects (this object when the context has none); practice (ADR 0174 §4c) passes effects that
// change only its own session, so the same tool code runs without touching a client record, a lead, a link, a pending action, the
// outbox or the audit log.
import { sql } from 'kysely'
import { transaction, type Tx } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import { listVehicles, updateCustomer, upsertVehicleByPlate } from '../../customers/service.js'
import { issueClientLink, linkTokenKey, retextClientLink, type IssuedLink } from '../../identity/links.js'
import { attachConfirmMessage, cancelPendingActions, createPendingAction } from '../../identity/pending-actions.js'
import { noteLeadInterest, openLead } from '../../leads/service.js'
import { PgOptOutRepository } from '../../messaging/db/optout-repo.js'
import { loadCustomerTarget, strangerRecipient } from '../../messaging/db/recipients.js'
import type { ProposeEffect, ToolContext, ToolEffects, ToolInputs, ToolOutcome, VehicleEffect } from '../contract.js'
import { planPlaceholder, pricePlaceholder } from '../facts.js'
import { actionConfirmText, conversationVoice, markDisclosed, serverTextEs, withDisclosure } from '../lang.js'
import { isProvisionalClient } from '../welcome/provisional.js'
import type { VehicleType } from '../welcome/schema.js'
import '../welcome/schema.js'
import { atLeast, cleanPersonName, fail, ok, ownAppointment, withHandoff } from './common.js'

/**
 * The old vehicle type (vehicles.vehicle_type, kept for one release by ADR 0170) a default size stands for: the reverse of the
 * migration's backfill (sedan_coupe -> compact_car, suv_crossover -> compact_suv, truck_van -> truck), so a car saved by text still
 * reads the same to anything that has not moved to sizes yet. A size the shop added has none.
 */
export const TYPE_OF_SIZE: Readonly<Record<string, VehicleType>> = {
  compact_car: 'sedan_coupe',
  large_car: 'sedan_coupe',
  compact_suv: 'suv_crossover',
  large_suv: 'suv_crossover',
  truck: 'truck_van',
}

/** The most package price keys set_my_vehicle hands back (the plans' follow them). */
const MAX_SIZE_KEYS = 10

/** Vehicles a client may have added by text in all (the record is theirs; a flood of vehicles is not). */
export const MAX_VEHICLES = 6

export const NEEDS_VERIFY = 'This needs a quick verification first: send the client a verify link (send_link kind verify).'
const STAFF_HOLDS = 'A team member has this conversation now: nothing was proposed. Tell the client a team member will text them.'
export const HANDED_OFF = 'This conversation was handed to a team member in this turn: nothing was proposed. Tell the client a team member will text them.'

// ---- send_link (and check_availability's calendar link)

class NoPaymentLink extends Error {}

class LinkRefused extends Error {
  constructor(readonly outcome: ReturnType<typeof fail>) {
    super('link refused')
  }
}

/** send_link's transaction part (after its checks): the link row, the audit, the placeholder; a link of the hour texted again. */
async function issueLink(ctx: ToolContext, input: ToolInputs['send_link'], o: { retext?: boolean }): Promise<ToolOutcome> {
  const id = ctx.identity
  const client = id.customerId
  try {
    const issued = await transaction(ctx.db, async (tx) => {
      let appointmentId: string | null = null
      let invoiceId: string | null = null
      if (input.appointmentRef && (input.kind === 'calendar' || input.kind === 'pay')) {
        const a = await ownAppointment(tx, ctx, input.appointmentRef)
        if (!a) throw new LinkRefused(fail('not_found', 'No such appointment for this client.'))
        appointmentId = a.id
      }
      if (input.kind === 'pay') invoiceId = await payableInvoice(tx, ctx, appointmentId)
      if (input.kind === 'membership') {
        const plan = await tx
          .selectFrom('membership_plans')
          .select('key')
          .where('location_id', '=', id.locationId)
          .where('key', '=', input.tier ?? '')
          .where('active', '=', true)
          .where('public', '=', true)
          .executeTakeFirst()
        if (!plan)
          throw new LinkRefused(
            fail('unavailable', 'Memberships cannot be started by link right now; a team member can help.'),
          )
      }
      const issued = await issueClientLink(
        tx,
        {
          newId: ctx.newId,
          now: ctx.now,
          ...(ctx.env.PUBLIC_SITE_URL ? { siteUrl: ctx.env.PUBLIC_SITE_URL } : {}),
          // a token the server can derive again (re-texting the same link, below)
          tokenKey: linkTokenKey(ctx.env),
        },
        {
          locationId: id.locationId,
          kind: input.kind,
          customerId: client,
          phone: client ? null : id.phone,
          appointmentId: input.kind === 'calendar' ? appointmentId : null,
          invoiceId,
          planKey: input.kind === 'membership' ? input.tier : null,
          issuedBy: 'assistant',
        },
      )
      // the link goes only to the number that is texting (the client's number on file is the same number)
      if (issued.phone !== id.phone)
        throw new LinkRefused(fail('not_allowed', 'This number is not the client’s number on file.'))
      await ctx.audit(tx, 'assistant.link.sent', {
        entityType: client ? 'customer' : 'lead',
        entityId: client,
        after: { kind: input.kind, expiresAt: issued.expiresAt.toISOString() },
      })
      return issued
    })
    // registered once the link row is committed: the reply never carries a link that does not exist
    const placeholder = ctx.addLink(issued.url, { kind: input.kind, expiresAt: issued.expiresAt })
    const minutes = Math.round((issued.expiresAt.getTime() - ctx.now.getTime()) / 60_000)
    return ok({
      placeholder,
      kind: input.kind,
      expiresInMinutes: minutes,
      instruction: `Put ${placeholder} in your reply exactly once; it is replaced by the secure link. Never write a URL yourself.`,
    })
  } catch (e) {
    if (e instanceof LinkRefused) return e.outcome
    // one link of a kind an hour (W4 leftover): a client who cannot find the link texted earlier gets the SAME link again (no new
    // token; once per link; counted in the day's links), not a handoff
    if (e instanceof AppError && e.code === 'IDENTITY_LINK_LIMIT' && e.meta?.limit === 'kind_hour' && o.retext !== false) {
      const again = await retext(ctx, input)
      if (again) {
        const placeholder = ctx.addLink(again.url, { kind: again.kind, expiresAt: again.expiresAt })
        return ok({
          placeholder,
          kind: input.kind,
          resent: true,
          instruction: `This is the same link texted earlier, sent again. Put ${placeholder} in your reply exactly once ("Here it is again: ${placeholder}"); it is replaced by the secure link. Never write a URL yourself, never mention a limit.`,
        })
      }
    }
    if (e instanceof AppError && e.code === 'IDENTITY_LINK_LIMIT')
      return fail(
        'rate_limited',
        // W4 live eval: "I've hit the link limit for today" confused clients (a limit they never heard of)
        // full Bedrock run: "It's good for 3 days so no rush!" and "scroll up" to a client who could not find the link
        'No new link can go to this number right now. If a link of this kind was texted earlier in this conversation and still works (a calendar link works for 3 days, a verify link for 15 minutes), point them to it (it is in their texts; never tell them how long it works); otherwise say a team member will text them. If they say they cannot find it, say a team member will text it to them and call handoff_to_staff. Never mention a limit or a count.',
      )
    if (e instanceof NoPaymentLink)
      return withHandoff(
        ctx,
        fail(
          'unavailable',
          'There is no online payment for that invoice yet; a team member will text a payment link.',
        ),
        'no_payment_link',
        'The client asked to pay online; the invoice has no payment link yet.',
      )
    if (
      e instanceof AppError &&
      (e.code === 'VALIDATION_FAILED' || e.code === 'NOT_FOUND' || e.code === 'IDENTITY_NO_PHONE')
    )
      return fail('not_found', 'There is nothing that link could be for.')
    throw e
  }}

/**
 * The same link again (identity/links.ts retextClientLink) in its own transaction, audited; null when there is none to re-text (no
 * key, none live, already re-texted, issued before re-texting) or the day's links are used up.
 */
async function retext(ctx: ToolContext, input: ToolInputs['send_link']): Promise<IssuedLink | null> {
  const tokenKey = linkTokenKey(ctx.env)
  if (!tokenKey) return null
  try {
    return await transaction(ctx.db, async (tx) => {
      // the binding the new link would have had (as in issueLinkOutcome): only a link bound to exactly that is texted again
      let visitId: string | null = null
      if (input.appointmentRef && (input.kind === 'calendar' || input.kind === 'pay')) {
        visitId = (await ownAppointment(tx, ctx, input.appointmentRef))?.id ?? null
        if (!visitId) return null
      }
      const invoiceId = input.kind === 'pay' ? await payableInvoice(tx, ctx, visitId) : null
      const again = await retextClientLink(
        tx,
        { now: ctx.now, tokenKey, ...(ctx.env.PUBLIC_SITE_URL ? { siteUrl: ctx.env.PUBLIC_SITE_URL } : {}) },
        {
          locationId: ctx.identity.locationId,
          phone: ctx.identity.phone,
          kind: input.kind,
          appointmentId: input.kind === 'calendar' ? visitId : null,
          invoiceId,
          planKey: input.kind === 'membership' ? input.tier : null,
        },
      )
      if (!again) return null
      await ctx.audit(tx, 'assistant.link.resent', {
        entityType: ctx.identity.customerId ? 'customer' : 'lead',
        entityId: ctx.identity.customerId,
        after: { kind: input.kind, expiresAt: again.expiresAt.toISOString() },
      })
      return again
    })
  } catch (e) {
    if (e instanceof AppError && e.code === 'IDENTITY_LINK_LIMIT') return null
    if (e instanceof LinkRefused || e instanceof NoPaymentLink) return null
    throw e
  }
}

/** The open invoice a pay link is for: the visit's, or the client's latest with a balance; it needs a staff-attached payment URL. */
async function payableInvoice(tx: Tx, ctx: ToolContext, appointmentId: string | null): Promise<string> {
  const rows = await sql<{ id: string; payment_link_url: string | null }>`
    select i.id, i.payment_link_url from invoices i cross join lateral invoice_calc_of(i.id) c
    where i.customer_id = ${ctx.identity.customerId} and i.location_id = ${ctx.identity.locationId} and i.canceled_at is null
      and c.balance > 0 ${appointmentId ? sql`and i.appointment_id = ${appointmentId}` : sql``}
    order by i.occurred_at desc, i.id desc limit 1`.execute(tx)
  const inv = rows.rows[0]
  if (!inv) throw new LinkRefused(fail('not_found', 'There is no open invoice to pay.'))
  // with Square the pay page makes a link for the exact balance when the client opens it (ADR 0171 D3): no staff link needed
  if (!inv.payment_link_url && ctx.env.PAYMENT_PROCESSOR !== 'square') throw new NoPaymentLink()
  return inv.id
}

// ---- note_interest and check_availability

/** The lead of the number: note_interest opens it first (a stale record is not tied to it); check_availability only adds to it. */
async function noteInterest(ctx: ToolContext, categories: readonly string[], o: { openLead: boolean }): Promise<string[] | null> {
  if (!o.openLead)
    return transaction(ctx.db, (tx) => noteLeadInterest(tx, { locationId: ctx.identity.locationId, phone: ctx.identity.phone, categories: [...categories], at: ctx.now }))
  return transaction(ctx.db, async (tx) => {
    // a record the stale-record rule hides (trust 'unknown') is not tied to the lead: whoever holds the number now may be someone else
    const customerId = atLeast(ctx.identity.trust, 'caller') ? ctx.identity.customerId : null
    await openLead(tx, ctx.newId, { locationId: ctx.identity.locationId, phone: ctx.identity.phone, customerId, source: 'text', at: ctx.now })
    return noteLeadInterest(tx, { locationId: ctx.identity.locationId, phone: ctx.identity.phone, categories, at: ctx.now })
  })
}

// ---- propose_booking / propose_reschedule / propose_cancel

class Refused extends Error {
  constructor(readonly outcome: ToolOutcome) {
    super('refused')
  }
}

/**
 * Records the proposal and texts its reply number in one transaction: the text is queued with the number as a secretVar (masked in
 * the message row) and linked to the action. When the text cannot be queued (opted out, no recent text from them, ...) nothing is kept.
 */
async function propose(ctx: ToolContext, o: ProposeEffect): Promise<ToolOutcome> {
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
        // AGENT or a staff text arrived while this turn ran (W4c re-review L2): the chat is the staff's, nothing is proposed
        if (e instanceof AppError && e.code === 'IDENTITY_STAFF_HOLDS_CHAT') throw new Refused(fail('unavailable', STAFF_HOLDS))
        // too many wrong reply numbers from this number today (W4c): no new number to guess, a person takes over
        if (e instanceof AppError && e.code === 'IDENTITY_TOO_MANY_TRIES')
          throw new Refused(
            withHandoff(
              ctx,
              fail('rate_limited', 'Too many wrong confirmation numbers from this number today. Tell the client a team member will text them shortly.'),
              'cannot_help',
              'Several wrong confirmation numbers came from this number today, so the assistant stopped proposing bookings or changes by text.',
            ),
          )
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

// ---- set_my_name

/** The name a new client gave (already cleaned): saved while the record allows it, audited. */
async function saveName(ctx: ToolContext, name: string): Promise<ToolOutcome> {
  const customerId = ctx.identity.customerId
  if (!customerId) return fail('not_allowed', 'There is no client record for this number yet.')
  return transaction(ctx.db, async (tx) => {
    // the record decides, not the turn's view: a name on file (or a client staff completed) is never replaced; the one exception
    // (W4b X7) is the client correcting the name the assistant itself saved in this conversation, while it still stands as saved
    const locked = await tx
      .selectFrom('customers')
      .select(['full_name', 'phone_e164'])
      .where('id', '=', customerId)
      .forUpdate()
      .executeTakeFirst()
    if (!locked || locked.phone_e164 !== ctx.identity.phone)
      return fail('not_allowed', 'There is no client record for this number.')
    const provisional = await isProvisionalClient(tx, customerId)
    if (
      !provisional &&
      !(await namedInThisConversation(tx, {
        conversationId: ctx.conversationId,
        customerId,
        current: locked.full_name,
      }))
    )
      return fail('not_allowed', 'This client already has a name on file; it is not changed by text.')
    if (!provisional && locked.full_name === name)
      return ok({ saved: true, firstName: name.split(' ')[0]!, unchanged: true })
    await updateCustomer(tx, { id: customerId, patch: { fullName: name, needsDetails: false } })
    await ctx.audit(tx, provisional ? 'assistant.client.named' : 'assistant.client.renamed', {
      entityType: 'customer',
      entityId: customerId,
      before: { name: locked.full_name },
      after: { name },
    })
    return ok({ saved: true, firstName: name.split(' ')[0]! })
  })
}

/**
 * Whether the client's current name is the one set_my_name saved in this conversation (its last successful call, cleaned the same
 * way): then the client may still correct it by text (W4b X7: a model padded "Rosa Rosa" and the client's "Rosa Garcia" was
 * refused). A name staff changed since, or one from before the conversation, is never changed by text.
 */
async function namedInThisConversation(
  tx: Tx,
  o: { conversationId: string; customerId: string; current: string },
): Promise<boolean> {
  const last = await tx
    .selectFrom('assistant_tool_calls as c')
    .innerJoin('assistant_turns as t', 't.id', 'c.turn_id')
    .select(['c.input'])
    .where('t.conversation_id', '=', o.conversationId)
    .where('c.tool', '=', 'set_my_name')
    .where('c.outcome', '=', 'ok')
    .orderBy('c.created_at', 'desc')
    .orderBy('c.seq', 'desc')
    .limit(1)
    .executeTakeFirst()
  if (!last) return false
  const input = (typeof last.input === 'string' ? JSON.parse(last.input) : last.input) as {
    fullName?: unknown
  }
  return typeof input.fullName === 'string' && cleanPersonName(input.fullName) === o.current
}

// ---- set_my_vehicle

/** The vehicle on the client's own record (the size the client said, never over staff's), audited; the price keys of its size. */
async function saveVehicle(ctx: ToolContext, v: VehicleEffect): Promise<ToolOutcome> {
  const customerId = ctx.identity.customerId
  if (!customerId) return fail('not_allowed', 'There is no client record for this number yet.')
  const { size, make, model, color } = v
  const sizes = ctx.facts.catalog.sizes
  return transaction(ctx.db, async (tx) => {
    const owner = await tx.selectFrom('customers').select('phone_e164').where('id', '=', customerId).forUpdate().executeTakeFirst()
    if (!owner || owner.phone_e164 !== ctx.identity.phone) return fail('not_allowed', 'There is no client record for this number.')
    const vehicles = await listVehicles(tx, customerId)
    const same = vehicles.find(
      // the same car: the same make and model, and the same year unless the client gave none (a 2022 Civic is not the 2019 one)
      (x) => (x.make ?? '').toLowerCase() === make.toLowerCase() && (x.model ?? '').toLowerCase() === model.toLowerCase() && (v.year === null || x.year === v.year),
    )
    if (!same && vehicles.length >= MAX_VEHICLES) return fail('rate_limited', 'This client has many vehicles on file already; the team can add more.')
    let vehicleId: string
    try {
      vehicleId = same
        ? same.id
        : (await upsertVehicleByPlate(tx, { newId: ctx.newId, customerId, year: v.year, make, model, color, plate: null })).vehicle.id
    } catch (e) {
      if (e instanceof AppError && e.code === 'VALIDATION_FAILED') return fail('invalid', 'That vehicle could not be saved.')
      throw e
    }
    const legacyType = TYPE_OF_SIZE[size.key]
    const saved = await tx
      .updateTable('vehicles')
      .set({
        ...(legacyType ? { vehicle_type: legacyType } : {}),
        // the size the client said (ADR 0170: source ai), never over a size staff set
        vehicle_class: sql<string>`case when vehicle_class_source = 'staff' then vehicle_class else ${size.key} end`,
        vehicle_class_source: sql<'staff' | 'ai'>`case when vehicle_class_source = 'staff' then 'staff' else 'ai' end`,
        ...(same && v.year !== null && same.year === null ? { year: v.year } : {}),
        ...(same && color && !same.color ? { color } : {}),
      })
      .where('id', '=', vehicleId)
      .where('customer_id', '=', customerId)
      .returning(['vehicle_class', 'vehicle_class_source'])
      .executeTakeFirst()
    await ctx.audit(tx, same ? 'assistant.vehicle.updated' : 'assistant.vehicle.added', {
      entityType: 'vehicle',
      entityId: vehicleId,
      after: { customerId, size: size.key, year: v.year, make, model, color },
    })
    // the size the car is priced at: staff's when they set one (the client's word does not replace it)
    const kept = saved?.vehicle_class_source === 'staff' && saved.vehicle_class !== size.key ? sizes.find((x) => x.key === saved.vehicle_class) : undefined
    const at = kept ?? size
    const priceKeys = [
      ...ctx.facts.catalog.items
        .filter((i) => i.kind === 'package' && !i.quoteOnly)
        .slice(0, MAX_SIZE_KEYS)
        .map((i) => ({ name: i.name, priceKey: pricePlaceholder(i.key, at.key) })),
      ...ctx.facts.plans.map((p) => ({ name: `${p.label} membership`, priceKey: planPlaceholder(p.key, at.key) })),
    ]
    return ok({
      saved: true,
      vehicle: [v.year, make, model].filter((x) => x !== null).join(' '),
      size: at.label,
      sizeKey: at.key,
      ...(kept ? { note: `The team already set this car as ${kept.label}; prices follow that size.` } : {}),
      // the prices for their car's size, as placeholders (the model never writes an amount); a size without a price reads "priced at the shop"
      priceKeys,
    })
  })
}

// ---- opt_out and handoff_to_staff

/** The opt-out in words: recorded exactly like STOP, the confirmation texted once, audited. */
async function optOut(ctx: ToolContext): Promise<ToolOutcome> {
  const id = ctx.identity
  await transaction(ctx.db, async (tx) => {
    const repo = new PgOptOutRepository(tx, { locationId: id.locationId, newId: ctx.newId })
    const already = (await repo.findActive(id.phone)) !== null
    await repo.optOut({ phone: id.phone, optedOutAt: ctx.now, source: 'keyword', keyword: 'stop (in words, to Oasis AI)' })
    if (!already) {
      const target = id.customerId ? await loadCustomerTarget(tx, id.locationId, id.customerId) : null
      const recipient = target?.recipient ?? (await strangerRecipient(tx, id.locationId, id.phone))
      // a Spanish conversation gets the Spanish confirmation (guard polish after W4b-fix, P3)
      const es = (await conversationVoice(tx, ctx.conversationId)).lang === 'es' ? serverTextEs('opt_out_confirm') : null
      await ctx.queue.enqueueFor(tx, {
        locationId: id.locationId,
        customerId: id.customerId,
        recipient,
        appointmentId: null,
        ...(es ? { text: es, klass: 'opt_out_confirm' as const, tag: 'opt_out_confirm' } : { templateKey: 'opt_out_confirm' }),
        purpose: 'inbound-reply',
        senderKind: 'system',
        dedupeKey: `assistant-opt-out:${ctx.turnId}`,
      })
    }
    await ctx.audit(tx, 'assistant.opt_out', { entityType: id.customerId ? 'customer' : 'phone', entityId: id.customerId, after: { optedOut: true } })
  })
  return ok({ optedOut: true, instruction: 'They are unsubscribed and got the opt-out confirmation. Send nothing else.' })
}

/** handoff_to_staff: the number's pending proposals are canceled (the chat is the staff's from here). */
async function cancelPending(ctx: ToolContext): Promise<void> {
  await transaction(ctx.db, (tx) =>
    cancelPendingActions(tx, { locationId: ctx.identity.locationId, phone: ctx.identity.phone, now: ctx.now, error: 'handed to staff' }),
  )
}

/** The live effects: the tools' writes as they have always been made. */
export const liveToolEffects: ToolEffects = { noteInterest, issueLink, propose, saveName, saveVehicle, optOut, cancelPending }

/** The effects of a context: its own, else the live ones. */
export const effectsOf = (ctx: ToolContext): ToolEffects => ctx.effects ?? liveToolEffects
