// Tools about the conversation itself (ADR 0160, design section 4): what the texter is interested in (their lead), a personal link
// to their own number, a natural-language opt-out, and the handoff to staff.
import { sql } from 'kysely'
import { z } from 'zod/v4'
import { transaction, type Tx } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import { cancelPendingActions } from '../../identity/pending-actions.js'
import { issueClientLink } from '../../identity/links.js'
import { PgOptOutRepository } from '../../messaging/db/optout-repo.js'
import { loadCustomerTarget, strangerRecipient } from '../../messaging/db/recipients.js'
import { tierSpec } from '../../public/tiers.js'
import { noteLeadInterest, openLead } from '../../leads/service.js'
import { TOOL_MIN_TRUST, type AssistantTool, type ToolContext, type ToolInputs } from '../contract.js'
import { atLeast, fail, json, ok, ownAppointment, withHandoff } from './common.js'

export const noteInterest: AssistantTool<ToolInputs['note_interest']> = {
  name: 'note_interest',
  description:
    'Records what the texter wants (category keys from the catalog, e.g. wash, tint, detail). Call it as soon as they say it, even in their first text and without asking again: it saves their lead for the team and moves the welcome intake on to its next step.',
  input: z.strictObject({ categories: z.array(z.string().max(32)).min(1).max(5) }),
  minTrust: TOOL_MIN_TRUST.note_interest,
  async run(ctx, { categories }) {
    const known = new Set(ctx.facts.catalog.categories.map((c) => c.key))
    const keys = [...new Set(categories.map((c) => c.trim().toLowerCase()))].filter((k) => known.has(k))
    if (keys.length === 0) return fail('invalid', 'Use category keys from the catalog.', { detail: json({ categories: ctx.facts.catalog.categories }) })
    const interests = await transaction(ctx.db, async (tx) => {
      // a record the stale-record rule hides (trust 'unknown') is not tied to the lead: whoever holds the number now may be someone else
      const customerId = atLeast(ctx.identity.trust, 'caller') ? ctx.identity.customerId : null
      await openLead(tx, ctx.newId, { locationId: ctx.identity.locationId, phone: ctx.identity.phone, customerId, source: 'text', at: ctx.now })
      return noteLeadInterest(tx, { locationId: ctx.identity.locationId, phone: ctx.identity.phone, categories: keys, at: ctx.now })
    })
    return ok({ noted: keys, interests: interests ?? keys })
  },
}

const LINK_KINDS = ['calendar', 'verify', 'pin', 'membership', 'pay'] as const

class NoPaymentLink extends Error {}

class LinkRefused extends Error {
  constructor(readonly outcome: ReturnType<typeof fail>) {
    super('link refused')
  }
}

export const sendLink: AssistantTool<ToolInputs['send_link']> = {
  name: 'send_link',
  description:
    'Texts a secure personal link to the client’s own number and returns a placeholder like {link1} to put in your reply exactly as given. calendar: book or change visits online (appointmentRef to change that visit); verify: confirm it is them (needed before you can book, move or cancel by text); pin: set their website PIN; membership: join a plan (tier gold or vip); pay: pay an open invoice (appointmentRef of that visit, or null for the latest). At most 3 links a day.',
  input: z.strictObject({
    kind: z.enum(LINK_KINDS),
    appointmentRef: z.enum(['A1', 'A2', 'A3']).nullable(),
    tier: z.enum(['gold', 'vip']).nullable(),
  }),
  minTrust: TOOL_MIN_TRUST.send_link,
  run: (ctx, input) => issueLinkOutcome(ctx, input),
}

/**
 * send_link's work: issues the personal link to the number that is texting, registers it with the turn ({linkN}) and says how to
 * use it. check_availability calls it too (W4b X4: an unverified booking gets the calendar link in the same reply).
 */
export async function issueLinkOutcome(ctx: ToolContext, input: ToolInputs['send_link']) {
  if (!ctx.env.PUBLIC_LINKS_ENABLED)
    return fail(
      'unavailable',
      'Personal links are not available right now. Offer to have a team member text back.',
    )
  const id = ctx.identity
  const client = id.customerId
  // a stranger (no client) or a record the stale rule hides gets only what proves the number: verify, or a calendar for a stranger
  if (input.kind === 'verify' && !client)
    return fail('not_allowed', 'There is no client record for this number yet; ask their name first.')
  if (input.kind === 'calendar' && client && !atLeast(id.trust, 'caller'))
    return fail('needs_verification', 'This number has to be verified first: send a verify link.')
  if (
    (input.kind === 'pin' || input.kind === 'membership' || input.kind === 'pay') &&
    (!client || !atLeast(id.trust, 'caller'))
  )
    return fail('not_allowed', 'That link is only for a client on file; send a verify link first.')
  if (input.kind === 'membership' && !input.tier) return fail('invalid', 'Say which plan: tier gold or vip.')
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
          .where('key', '=', tierSpec(input.tier!).planKey)
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
        },
        {
          locationId: id.locationId,
          kind: input.kind,
          customerId: client,
          phone: client ? null : id.phone,
          appointmentId: input.kind === 'calendar' ? appointmentId : null,
          invoiceId,
          planKey: input.kind === 'membership' ? tierSpec(input.tier!).planKey : null,
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
    if (e instanceof AppError && e.code === 'IDENTITY_LINK_LIMIT')
      return fail(
        'rate_limited',
        // W4 live eval: "I've hit the link limit for today" confused clients (a limit they never heard of)
        'No new link can go to this number right now. If a link of this kind was texted earlier in this conversation, point them to it (it is in their texts; a calendar link works for 3 days, a verify link for 15 minutes); otherwise say a team member will text them. Never mention a limit or a count.',
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
  if (!inv.payment_link_url) throw new NoPaymentLink()
  return inv.id
}

export const optOut: AssistantTool<ToolInputs['opt_out']> = {
  name: 'opt_out',
  description: 'The texter asked to stop getting texts in their own words ("stop texting me"): records the opt-out exactly like the STOP keyword.',
  input: z.strictObject({}),
  minTrust: TOOL_MIN_TRUST.opt_out,
  async run(ctx) {
    const id = ctx.identity
    await transaction(ctx.db, async (tx) => {
      const repo = new PgOptOutRepository(tx, { locationId: id.locationId, newId: ctx.newId })
      const already = (await repo.findActive(id.phone)) !== null
      await repo.optOut({ phone: id.phone, optedOutAt: ctx.now, source: 'keyword', keyword: 'stop (in words, to Oasis AI)' })
      if (!already) {
        const target = id.customerId ? await loadCustomerTarget(tx, id.locationId, id.customerId) : null
        const recipient = target?.recipient ?? (await strangerRecipient(tx, id.locationId, id.phone))
        await ctx.queue.enqueueFor(tx, {
          locationId: id.locationId,
          customerId: id.customerId,
          recipient,
          appointmentId: null,
          templateKey: 'opt_out_confirm',
          purpose: 'inbound-reply',
          senderKind: 'system',
          dedupeKey: `assistant-opt-out:${ctx.turnId}`,
        })
      }
      await ctx.audit(tx, 'assistant.opt_out', { entityType: id.customerId ? 'customer' : 'phone', entityId: id.customerId, after: { optedOut: true } })
    })
    return ok({ optedOut: true, instruction: 'They are unsubscribed and got the opt-out confirmation. Send nothing else.' })
  },
}

export const handoffToStaff: AssistantTool<ToolInputs['handoff_to_staff']> = {
  name: 'handoff_to_staff',
  description:
    'Hands the conversation to a team member: when the client asks for a person, is upset, asks about refunds, discounts, damage or anything legal, or you cannot help. Summary: one or two plain sentences for the team (never a PIN, code or card digits).',
  input: z.strictObject({ reason: z.enum(['client_asked', 'upset', 'cannot_help', 'policy']), summary: z.string().min(1).max(300) }),
  minTrust: TOOL_MIN_TRUST.handoff_to_staff,
  async run(ctx, { reason, summary }) {
    const clean = summary.replace(/\d[\d\s-]{3,}\d/g, '[number]').trim()
    await transaction(ctx.db, (tx) =>
      cancelPendingActions(tx, { locationId: ctx.identity.locationId, phone: ctx.identity.phone, now: ctx.now, error: 'handed to staff' }),
    )
    return withHandoff(ctx, ok({ handedOff: true, instruction: 'Tell them a team member will text them back shortly.' }), reason, clean)
  },
}
