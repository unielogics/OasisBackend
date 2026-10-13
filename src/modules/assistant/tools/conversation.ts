// Tools about the conversation itself (ADR 0160, design section 4): what the texter is interested in (their lead), a personal link
// to their own number, a natural-language opt-out, and the handoff to staff.
import { z } from 'zod/v4'
import { TOOL_MIN_TRUST, type AssistantTool, type ToolContext, type ToolInputs, type ToolOutcome } from '../contract.js'
import { atLeast, fail, json, ok, withHandoff } from './common.js'
import { effectsOf } from './effects-live.js'
import { POLICY_OFF_MESSAGE } from '../tool-runner.js'

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
    const interests = await effectsOf(ctx).noteInterest(ctx, keys, { openLead: true })
    return ok({ noted: keys, interests: interests ?? keys })
  },
}

const LINK_KINDS = ['calendar', 'verify', 'pin', 'membership', 'pay'] as const

export const sendLink: AssistantTool<ToolInputs['send_link']> = {
  name: 'send_link',
  description:
    'Texts a secure personal link to the client’s own number and returns a placeholder like {link1} to put in your reply exactly as given. calendar: book or change visits online (appointmentRef to change that visit); verify: confirm it is them (needed before you can book, move or cancel by text); pin: set their website PIN; membership: join a plan (tier: a plan key from SHOP FACTS memberships); pay: pay an open invoice (appointmentRef of that visit, or null for the latest). At most 3 links a day. When the client cannot find a link texted earlier, call it again for that kind: the server texts the same link again when it can.',
  input: z.strictObject({
    kind: z.enum(LINK_KINDS),
    appointmentRef: z.enum(['A1', 'A2', 'A3']).nullable(),
    tier: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).nullable(),
  }),
  minTrust: TOOL_MIN_TRUST.send_link,
  run: (ctx, input) => issueLinkOutcome(ctx, input),
}

/**
 * send_link's work: issues the personal link to the number that is texting, registers it with the turn ({linkN}) and says how to
 * use it. check_availability calls it too (W4b X4: an unverified booking gets the calendar link in the same reply), without the
 * re-text (`retext: false`: a link of the hour is pointed to, not texted again; only send_link re-texts, when the client asks).
 */
export async function issueLinkOutcome(ctx: ToolContext, input: ToolInputs['send_link'], o: { retext?: boolean } = {}): Promise<ToolOutcome> {
  // ADR 0174 §3b: a kind the owner switched off is never texted (the runner refuses it too; check_availability asks for calendar)
  if (ctx.policy && !ctx.policy.linkKinds.has(input.kind)) return fail('not_allowed', POLICY_OFF_MESSAGE)
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
  if (input.kind === 'membership' && !input.tier) return fail('invalid', 'Say which plan: tier, a plan key from SHOP FACTS memberships.')
  // a tier with no current price is not sold online (plan decision 3): only the plans of SHOP FACTS (facts-v4) get a link
  if (input.kind === 'membership' && !ctx.facts.plans.some((p) => p.key === input.tier))
    return fail('unavailable', 'That plan cannot be started by link right now; a team member can help.')
  // the link row, its audit and the placeholder (or the link of the hour again): the context's effects (ADR 0174 §4b)
  return effectsOf(ctx).issueLink(ctx, input, o)
}

export const optOut: AssistantTool<ToolInputs['opt_out']> = {
  name: 'opt_out',
  description: 'The texter asked to stop getting texts in their own words ("stop texting me"): records the opt-out exactly like the STOP keyword.',
  input: z.strictObject({}),
  minTrust: TOOL_MIN_TRUST.opt_out,
  async run(ctx) {
    return effectsOf(ctx).optOut(ctx)
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
    await effectsOf(ctx).cancelPending(ctx)
    return withHandoff(ctx, ok({ handedOff: true, instruction: 'Tell them a team member will text them back shortly.' }), reason, clean)
  },
}
