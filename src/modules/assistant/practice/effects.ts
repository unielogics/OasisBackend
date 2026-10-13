// The practice chat's tool effects (ADR 0174 §4b and §4c): the same tools run with the same checks and reads, but what they would
// DO only changes the practice session's own state. A link becomes "[booking link]" (nothing is issued or texted), a proposal shows
// the confirmation the server would text ("... Reply #### to confirm."), a saved name or vehicle, an interest or an opt-out are kept in
// the session; nothing is written to a client record, a lead, a link, a pending action, the outbox or the audit log. Each effect
// answers the model exactly what the live effect answers (tools/effects-live.ts linkIssued, proposed, vehicleSaved, OPTED_OUT), so
// the model reads the same tool results in practice and live.
import { sql } from 'kysely'
import { LINK_POLICY } from '../../identity/links.js'
import type { ProposeEffect, ToolContext, ToolEffects, ToolInputs, ToolOutcome, VehicleEffect } from '../contract.js'
import { actionConfirmText, withDisclosure, type ConvoLang } from '../lang.js'
import type { LinkKind } from '../policy.js'
import { fail, ok, ownAppointment } from '../tools/common.js'
import { linkIssued, MAX_VEHICLES, OPTED_OUT, proposed, vehicleSaved } from '../tools/effects-live.js'

/** What the practice effects did in a session (assistant_practice_sessions.state). */
export interface PracticeState {
  /** The synthetic new texter (persona new_texter): its id and fictional number, never in a prompt. */
  persona?: { customerId: string; phone: string }
  /** The name set_my_name saved in this session. */
  name: string | null
  /** The categories note_interest (or check_availability) noted. */
  interests: string[]
  /** The vehicles set_my_vehicle saved in this session. */
  vehicles: { year: number | null; make: string; model: string; color: string | null; size: string; sizeLabel: string }[]
  /** get_membership_info answered in this session (the intake's memberships step is done). */
  membershipsShown: boolean
  /** The links send_link (or check_availability) "texted". */
  links: { kind: string; seq: number; at: string }[]
  /** A proposal waiting for its reply number. */
  pending: { kind: string; summary: string } | null
  optedOut: boolean
  /** What earlier turns saved and the open times they got, for the policy judge's record (tool-runner.ts recordLine). */
  lines: string[]
  availabilityChecked: boolean
  /** The client's language as the session's texts showed it. */
  lang: ConvoLang | null
  /** The first text the client would get has gone (the disclosure is on it). */
  disclosed: boolean
}

export const emptyPracticeState = (): PracticeState => ({
  name: null,
  interests: [],
  vehicles: [],
  membershipsShown: false,
  links: [],
  pending: null,
  optedOut: false,
  lines: [],
  availabilityChecked: false,
  lang: null,
  disclosed: false,
})

/** A stored state (jsonb) read back with every field present. */
export function parsePracticeState(raw: unknown): PracticeState {
  const s = (typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {})) as Partial<PracticeState>
  return { ...emptyPracticeState(), ...s }
}

/** How a link shows in the practice preview. */
export const LINK_LABELS: Record<LinkKind, string> = {
  calendar: '[booking link]',
  verify: '[verify link]',
  pin: '[PIN link]',
  membership: '[membership link]',
  pay: '[payment link]',
}

/** The session state the effects change, and the texts the server would send besides the reply. */
export interface PracticeSink {
  state: PracticeState
  extraTexts: string[]
  /** The turn's place (the links' record). */
  seq: number
  /** The client's own vehicles on file (persona client), counted against MAX_VEHICLES. */
  vehiclesOnFile: number
  /** The client on file has a real name (persona client): set_my_name refuses unless it was saved in this session. */
  namedOnFile: boolean
}

export function practiceEffects(sink: PracticeSink): ToolEffects {
  const st = sink.state
  return {
    async noteInterest(_ctx, categories) {
      st.interests = [...new Set([...st.interests, ...categories])]
      return st.interests
    },
    async issueLink(ctx, input, o) {
      const refused = await linkRefusal(ctx, input)
      if (refused) return refused
      const now = ctx.now.getTime()
      const recent = st.links.find((l) => l.kind === input.kind && now - Date.parse(l.at) < 3600_000)
      // the live limit: one link of a kind an hour; send_link texts the same one again, check_availability points to it
      if (recent && o.retext === false) return fail('rate_limited', 'No new link can go to this number right now.')
      const label = LINK_LABELS[input.kind]
      const ttl = LINK_POLICY[input.kind].ttlMs
      const placeholder = ctx.addLink(label, { kind: input.kind, expiresAt: new Date(now + ttl) })
      st.links.push({ kind: input.kind, seq: sink.seq, at: ctx.now.toISOString() })
      if (recent)
        return ok({
          placeholder,
          kind: input.kind,
          resent: true,
          instruction: `This is the same link texted earlier, sent again. Put ${placeholder} in your reply exactly once ("Here it is again: ${placeholder}"); it is replaced by the secure link. Never write a URL yourself, never mention a limit.`,
        })
      return linkIssued(placeholder, input.kind, Math.round(ttl / 60_000))
    },
    async propose(ctx, o: ProposeEffect) {
      st.pending = { kind: o.kind, summary: o.summary }
      const lang = ctx.lang ?? 'en'
      const body = actionConfirmText(o.summary, lang).replace('{code}', '####')
      sink.extraTexts.push(st.disclosed ? body : withDisclosure(body, lang))
      st.disclosed = true
      return proposed(o)
    },
    async saveName(_ctx, name) {
      if (sink.namedOnFile && st.name === null) return fail('not_allowed', 'This client already has a name on file; it is not changed by text.')
      st.name = name
      return ok({ saved: true, firstName: name.split(' ')[0]! })
    },
    async saveVehicle(ctx, v: VehicleEffect) {
      const same = st.vehicles.find((x) => x.make.toLowerCase() === v.make.toLowerCase() && x.model.toLowerCase() === v.model.toLowerCase() && (v.year === null || x.year === v.year))
      if (!same && sink.vehiclesOnFile + st.vehicles.length >= MAX_VEHICLES)
        return fail('rate_limited', 'This client has many vehicles on file already; the team can add more.')
      if (same) Object.assign(same, { size: v.size.key, sizeLabel: v.size.label, year: same.year ?? v.year, color: same.color ?? v.color })
      else st.vehicles.push({ year: v.year, make: v.make, model: v.model, color: v.color, size: v.size.key, sizeLabel: v.size.label })
      return vehicleSaved(ctx, v)
    },
    async optOut() {
      st.optedOut = true
      return OPTED_OUT
    },
    async cancelPending() {
      st.pending = null
    },
  }
}

/**
 * The live effect's own refusals that depend on the client's record (read through the practice's read-only database): a visit that
 * is not theirs, no open invoice to pay, a plan that is not sold by link. Null: the link would be texted.
 */
async function linkRefusal(ctx: ToolContext, input: ToolInputs['send_link']): Promise<ToolOutcome | null> {
  if (input.appointmentRef && (input.kind === 'calendar' || input.kind === 'pay')) {
    const a = await ownAppointment(ctx.db, ctx, input.appointmentRef)
    if (!a) return fail('not_found', 'No such appointment for this client.')
  }
  if (input.kind === 'pay') {
    const rows = await sql<{ id: string }>`
      select i.id from invoices i cross join lateral invoice_calc_of(i.id) c
      where i.customer_id = ${ctx.identity.customerId} and i.location_id = ${ctx.identity.locationId} and i.canceled_at is null and c.balance > 0
      limit 1`.execute(ctx.db)
    if (rows.rows.length === 0) return fail('not_found', 'There is no open invoice to pay.')
  }
  if (input.kind === 'membership') {
    const plan = await ctx.db
      .selectFrom('membership_plans')
      .select('key')
      .where('location_id', '=', ctx.identity.locationId)
      .where('key', '=', input.tier ?? '')
      .where('active', '=', true)
      .where('public', '=', true)
      .executeTakeFirst()
    if (!plan) return fail('unavailable', 'Memberships cannot be started by link right now; a team member can help.')
  }
  return null
}
