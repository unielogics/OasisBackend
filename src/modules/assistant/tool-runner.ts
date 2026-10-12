// Runs the model's tool calls (ADR 0160, design section 4; the W3 contract's AssistantTool rules): an unknown tool, an action tool
// while in-chat actions are off, a trust below the tool's minimum and an input its strict schema refuses never run; every call is
// recorded in assistant_tool_calls (input, output, outcome, latency; an exception's message is never stored: it may hold data).
import { z } from 'zod/v4'
import type { AiContentBlock, AiJson, AiJsonObject, AiToolSpec } from '../../integrations/ports/ai.js'
import type { Db } from '../../platform/db.js'
import type { NewId } from '../../platform/ids.js'
import type { AnyAssistantTool, HandoffRequest, ToolContext, ToolOutcome, ToolRegistry, TurnTrust } from './contract.js'
import { oneLine } from './facts.js'
import { redactJson } from './transcript.js'
import './schema.js'

const RANK: Record<TurnTrust, number> = { unknown: 0, caller: 1, trusted: 2 }

/** True when `have` is at least `need`. */
export const trustAtLeast = (have: TurnTrust, need: TurnTrust): boolean => RANK[have] >= RANK[need]

/** The tools offered to the model this turn, in the registry's fixed order (action tools only while actions are on). */
export function offeredTools(registry: ToolRegistry, actionsEnabled: boolean): AnyAssistantTool[] {
  return registry.tools.filter((t) => actionsEnabled || !t.action)
}

/** The strict JSON Schema of a tool's zod input, for Converse. */
export function inputSchemaOf(tool: AnyAssistantTool): AiJsonObject {
  const schema = { ...(z.toJSONSchema(tool.input as z.ZodType, { unrepresentable: 'any' }) as Record<string, unknown>) }
  delete schema.$schema
  return schema as AiJsonObject
}

export function toolSpecs(tools: readonly AnyAssistantTool[]): AiToolSpec[] {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchemaOf(t) }))
}

/** The tools whose success counts as progress for the "6 turns without progress" breaker. */
export const NON_PROGRESS_TOOLS: ReadonlySet<string> = new Set(['handoff_to_staff', 'opt_out', 'policy_judge'])

export interface ToolRoundResult {
  /** One toolResult block per toolUse, in order. */
  results: AiContentBlock[]
  /**
   * The client's own open balance (cents) when get_balance succeeded in this round (its data.openBalanceCents, else the first of its
   * amountsCents): the only value the {balance} placeholder renders (guard v3, design section 3c).
   */
  balanceCents: number | null
  /** A propose_* call texted its reply number in this round: the {confirm} placeholder may be used (facts.ts CONFIRM_PLACEHOLDER). */
  confirmTexted: boolean
  handoff: HandoffRequest | null
  /**
   * What the server did and returned in this round, in words, for the policy judge's server record (guard polish after W4b-fix: the
   * judge failed "guarde tu Honda Pilot", a vehicle the server had just saved, as a false claim): see recordLine.
   */
  record: string[]
  /** Records for the transcript. */
  calls: { tool: string; outcome: 'ok' | 'error' | 'denied'; error?: string }[]
}

type ToolUse = Extract<AiContentBlock, { type: 'toolUse' }>

export interface ToolRunnerDeps {
  db: Db
  newId: NewId
  /** Monotonic milliseconds (latency). */
  nowMs: () => number
}

const errorResult = (u: ToolUse, outcome: { error: string; message: string; detail?: AiJsonObject }): AiContentBlock => ({
  type: 'toolResult',
  toolUseId: u.id,
  status: 'error',
  content: [{ type: 'json', json: { ok: false, error: outcome.error, message: outcome.message, ...(outcome.detail ? { detail: outcome.detail } : {}) } }],
})

/** Runs one round of tool calls, in order, recording each. `seq` is the turn's running call counter (returned advanced). */
export async function runToolRound(
  d: ToolRunnerDeps,
  o: { registry: ToolRegistry; ctx: ToolContext; uses: readonly ToolUse[]; round: number; seq: number; actionsEnabled: boolean },
): Promise<ToolRoundResult & { seq: number }> {
  const out: ToolRoundResult = { results: [], balanceCents: null, confirmTexted: false, handoff: null, record: [], calls: [] }
  let seq = o.seq
  for (const u of o.uses) {
    seq += 1
    const began = d.nowMs()
    const tool = o.registry.get(u.name)
    let outcome: ToolOutcome
    let rowOutcome: 'ok' | 'error' | 'denied'
    let rowError: string | null = null
    if (!tool || (tool.action && !o.actionsEnabled)) {
      outcome = { ok: false, error: tool ? 'unavailable' : 'invalid', message: tool ? 'In-chat booking is off: send a calendar link instead.' : 'There is no such tool.' }
      rowOutcome = 'denied'
      rowError = tool ? 'actions_disabled' : 'unknown_tool'
    } else if (!trustAtLeast(o.ctx.identity.trust, tool.minTrust)) {
      outcome = { ok: false, error: 'needs_verification', message: 'This needs a quick verification first: offer a verify link with send_link.' }
      rowOutcome = 'denied'
      rowError = `trust_below_${tool.minTrust}`
    } else {
      const parsed = tool.input.safeParse(u.input)
      if (!parsed.success) {
        outcome = { ok: false, error: 'invalid', message: 'The tool input was not valid: check the fields and try again.' }
        rowOutcome = 'error'
        rowError = 'invalid_input'
      } else {
        try {
          outcome = await tool.run(o.ctx, parsed.data)
          rowOutcome = outcome.ok ? 'ok' : 'error'
          if (!outcome.ok) rowError = outcome.error
        } catch (e) {
          outcome = { ok: false, error: 'unavailable', message: 'That is not available right now.' }
          rowOutcome = 'error'
          rowError = `exception:${(e as Error)?.name ?? 'Error'}`
        }
      }
    }
    if (outcome.handoff && !out.handoff) out.handoff = outcome.handoff
    if (outcome.ok && outcome.data.confirmationTexted === true) out.confirmTexted = true
    if (outcome.ok && u.name === 'get_balance') {
      const declared = outcome.data.openBalanceCents ?? outcome.amountsCents?.[0]
      if (typeof declared === 'number' && Number.isInteger(declared) && declared >= 0) out.balanceCents = declared
    }
    const json: AiJson = outcome.ok ? { ok: true, ...outcome.data } : { ok: false, error: outcome.error, message: outcome.message, ...(outcome.detail ? { detail: outcome.detail } : {}) }
    out.results.push(
      outcome.ok
        ? { type: 'toolResult', toolUseId: u.id, status: 'success', content: [{ type: 'json', json }] }
        : errorResult(u, { error: outcome.error, message: outcome.message, ...(outcome.detail ? { detail: outcome.detail } : {}) }),
    )
    out.calls.push({ tool: u.name, outcome: rowOutcome, ...(rowError ? { error: rowError } : {}) })
    const line = recordLine(u.name, outcome)
    if (line) out.record.push(line)
    await d.db
      .insertInto('assistant_tool_calls')
      .values({
        id: d.newId(),
        turn_id: o.ctx.turnId,
        seq,
        round: o.round,
        tool: /^[a-z][a-z0-9_]{0,63}$/.test(u.name) ? u.name : 'unknown',
        tool_use_id: u.id.slice(0, 200),
        input: JSON.stringify(redactJson(u.input ?? {})),
        output: JSON.stringify(redactJson(json)),
        outcome: rowOutcome,
        error: rowError,
        latency_ms: Math.max(0, Math.round(d.nowMs() - began)),
      })
      .execute()
  }
  return { ...out, seq }
}

const PARTS = ['morning', 'afternoon', 'evening'] as const
/** The part of the day a start time falls in (tools/common.ts partOfDayOf: before noon, before 5 PM, after). */
const partOf = (startMin: number): (typeof PARTS)[number] => (startMin < 12 * 60 ? 'morning' : startMin < 17 * 60 ? 'afternoon' : 'evening')

const str = (x: unknown): string | null => (typeof x === 'string' && x.trim() !== '' ? oneLine(x, 60) : null)
const quoted = (x: unknown): string => `"${(str(x) ?? '').replace(/"/g, "'")}"`

/**
 * One tool call as the policy judge's server record reads it (what the server did or returned; null for a lookup the record has
 * elsewhere or that says nothing to check): a saved name or vehicle, a link texted, a proposal texted, the open times returned (or
 * that none were given to this phone), a handoff; a refused action as "not done". Client-entered words are quoted and cut.
 */
export function recordLine(tool: string, outcome: ToolOutcome): string | null {
  if (!outcome.ok) {
    if (['set_my_name', 'set_my_vehicle', 'send_link', 'propose_booking', 'propose_reschedule', 'propose_cancel'].includes(tool))
      return `${tool}: not done (${outcome.error})`
    if (tool === 'check_availability') return 'check_availability: no open times returned'
    return null
  }
  const d = outcome.data as Record<string, unknown>
  switch (tool) {
    case 'set_my_name':
      return `saved the client's first name ${quoted(d.firstName)}`
    case 'set_my_vehicle':
      return `saved the client's vehicle ${quoted(d.vehicle)}`
    case 'send_link':
      return d.resent === true
        ? `texted the client again the same ${str(d.kind) ?? 'personal'} link it texted earlier`
        : `texted the client a ${str(d.kind) ?? 'personal'} link`
    case 'propose_booking':
    case 'propose_reschedule':
    case 'propose_cancel':
      return `texted the client a proposal to confirm with its reply number (nothing done until they confirm): ${str(d.summary) ?? tool}`
    case 'handoff_to_staff':
      return 'handed the chat to a team member'
    case 'note_interest':
      return 'noted what the client is interested in'
    case 'check_availability': {
      const what = `${str(d.service) ?? 'the service'} on ${str(d.dateLabel) ?? str(d.date) ?? 'that day'}`
      const asked = PARTS.find((p) => p === d.partOfDay) ?? null
      if ('bookingLink' in d) {
        const link = typeof d.bookingLink === 'string' ? '; texted the client a calendar link to pick a time' : d.linkAlreadyTexted ? '; the calendar link texted earlier is where they pick a time' : ''
        // W4 final check L2: the part of the day asked about, and every part that has open times ("Friday morning has openings")
        const parts = Array.isArray(d.openParts) ? PARTS.filter((p) => (d.openParts as unknown[]).includes(p)) : null
        const which = asked ? `the ${asked}` : 'the day'
        const partsText = parts && (asked || parts.length > 0) ? `; parts of that day with open times: ${parts.length > 0 ? parts.join(', ') : 'none'}` : ''
        const day = d.closed ? '; the shop is closed that day' : d.hasOpenTimes === true ? `; ${which} has open times${partsText}` : d.hasOpenTimes === false ? `; ${which} has no open times${partsText}` : ''
        return `open times for ${what}${asked ? ` (${asked})` : ''}: none given to this phone (it picks a time on the booking page)${day}${link}`
      }
      // the times with their part of the day: "9:00 AM, 9:30 AM (morning); 1:00 PM (afternoon)"
      const list = Array.isArray(d.times) ? d.times.map((t) => t as { time?: unknown; startMin?: unknown }).filter((t) => str(t.time) !== null) : []
      const runs: { part: string | null; times: string[] }[] = []
      for (const t of list) {
        // the part of the day each time is in (not repeated when the check asked for one part)
        const part = !asked && typeof t.startMin === 'number' ? partOf(t.startMin) : null
        const time = str(t.time) ?? ''
        const last = runs.at(-1)
        if (last && last.part === part) last.times.push(time)
        else runs.push({ part, times: [time] })
      }
      const groups = runs.map((r) => `${r.times.join(', ')}${r.part ? ` (${r.part})` : ''}`)
      if (groups.length > 0) return `open times for ${what}${asked ? ` (${asked})` : ''}: ${groups.join('; ')}${typeof d.moreTimes === 'number' && d.moreTimes > 0 ? ` (and ${d.moreTimes} later)` : ''}`
      const next = Array.isArray(d.nextOpenDates)
        ? d.nextOpenDates.map((n) => { const x = n as { dateLabel?: unknown; firstTime?: unknown }; return `${str(x.dateLabel) ?? '?'} from ${str(x.firstTime) ?? '?'}` })
        : []
      return `open times for ${what}${asked ? ` (${asked})` : ''}: none${d.closed ? ' (closed)' : ''}${next.length > 0 ? `; next open: ${next.join(', ')}` : ''}`
    }
    default:
      return null
  }
}
