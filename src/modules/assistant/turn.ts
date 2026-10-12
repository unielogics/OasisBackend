// The assistant's turn (ADR 0160, design sections 3 and 3b; plan C): one answer to the texts a conversation's marker holds.
//
//   gate again -> caps (per number 8/h, 25/day, unknown 10/day; global 100/h, 600/day; AI_DAILY_BUDGET_USD of today's cost)
//   -> claim (conversation lock, lease running_since, the turn row) -> context (shop facts, the turn context, the last texts)
//   -> Converse loop (system: rules + SHOP FACTS [cache point], turn context; tools [cache point]; at most 4 tool rounds, then one
//      "reply now without tools" call; AI_TIMEOUT_MS per call, AI_TURN_DEADLINE_MS per turn)
//   -> output guard v4 (design 3c): the deterministic layer on the model's RAW text (one rewrite call, one shorten call, else a
//      sentence cut or the fallback), the server renders the placeholders ({price:..}, {plan:..}, {fee}, {balance}: self-contained
//      phrases, each its own clause) from the current facts, the only way a $ amount reaches a client; then the POLICY JUDGE reads
//      the rendered reply (judge.ts: fail -> one rewrite -> the guard and the judge again -> fallback; an error fails closed)
//   -> the reply (ai_reply, or personal_link with the links as secretVars; the first AI text discloses the assistant; a verify, PIN,
//      membership or payment link gets the server's safety line)
//   -> audit assistant.reply -> the marker cleared, or kept and kicked again when newer texts arrived meanwhile.
// Every failure (the model's error, refusal, cut answer or unknown stop, the guard, a cap, the loop breaker) sends the fixed
// fallback (at most one per 2 hours) and hands the conversation to staff. Nothing runs while AI_ENABLED=false or the settings
// switch is off: the gate refuses before anything is loaded or called.
import { sql } from 'kysely'
import type { Env } from '../../config/env.js'
import { addUsage, aiCostMicros } from '../../integrations/ai/cost.js'
import {
  AiProviderError,
  textOf,
  type AiContentBlock,
  type AiConverseRequest,
  type AiConverseResponse,
  type AiMessage,
  type AiProvider,
  type AiSystemBlock,
  type AiUsage,
} from '../../integrations/ports/ai.js'
import * as audit from '../../platform/audit.js'
import type { Clock } from '../../platform/clock.js'
import { transaction, type Db, type Tx } from '../../platform/db.js'
import type { NewId } from '../../platform/ids.js'
import { getSetting } from '../../platform/settings.js'
import { bizDayBounds, toBizDate } from '../../platform/time.js'
import { renderTemplate } from '../messaging/templates/render.js'
import { hasActiveOptOut } from '../messaging/db/recipients.js'
import { notifyManagers } from '../messaging/notify.js'
import type { Actor, SchedulingCtx } from '../scheduling/context.js'
import { AI_ACTOR_NAME, type AssistantLog, type AssistantQueue, type HandoffRequest, type ShopFactsSource, type ToolContext, type ToolRegistry, type TurnIdentity } from './contract.js'
import type { AssistantConfig } from './config.js'
import { appointmentRefs, loadAppointmentRefs, loadConversation, loadTurnContext, resolveIdentity } from './context.js'
import { factLiterals, openingWindow, placeholderValues, renderShopFacts } from './facts.js'
import { CARD_LINE, cutAfterFirstQuestion, cutAtSentence, guardReply, HARD_PROBLEMS, looksLikeCardNumber, MAX_REPLY_CHARS, SAFETY_LINE, SAFETY_LINK_KINDS, type GuardProblem, type ReplySegment } from './guard.js'
import { JUDGE_HINTS, runJudge } from './judge.js'
import { HANDOFF_SUMMARIES, markUnanswered, openTurnHandoff, recipientOf, sendFallback, type ConversationRef, type HandoffDeps } from './handoff.js'
import type { AssistantGate, AssistantInbox } from './ports.js'
import { judgeRewriteInstruction, PROMPT_VERSION, REPLY_NOW_TEXT, STATIC_RULES, renderConversation, renderTurnContext, rewriteInstruction } from './prompt.js'
import { NON_PROGRESS_TOOLS, offeredTools, runToolRound, toolSpecs } from './tool-runner.js'
import { redactText, Transcript } from './transcript.js'
import './schema.js'
import '../messaging/schema.js'

export interface TurnDeps {
  db: Db
  clock: Clock
  newId: NewId
  env: Env
  cfg: AssistantConfig
  provider: AiProvider
  /** The output guard's policy judge (judge.ts); called only while cfg.judge.enabled. */
  judge: AiProvider
  registry: ToolRegistry
  facts: ShopFactsSource
  queue: AssistantQueue
  inbox: AssistantInbox
  gate: AssistantGate
  log: AssistantLog
  schedulingFor(locationId: string): SchedulingCtx
  actorFor(locationId: string): Actor
  /** Starts the conversation's next turn (pg-boss ai.respond); newer texts arrived while this one ran. */
  kick(conversationIds: readonly string[]): Promise<void>
  /** Monotonic milliseconds for latencies (tests may replace it). */
  nowMs?: () => number
}

export type TurnResult =
  | { status: 'none' }
  | { status: 'busy' }
  | { status: 'skipped'; reason: string; turnId?: string }
  | { status: 'replied'; turnId: string; messageId: string; text: string; handoff: boolean }
  | { status: 'handed_off'; turnId: string; reason: string; fallbackMessageId: string | null }
  | { status: 'failed'; turnId: string; reason: string }

type CapKind = 'number_hour' | 'number_day' | 'unknown_day' | 'global_hour' | 'global_day' | 'budget'
const GLOBAL_CAPS: ReadonlySet<CapKind> = new Set(['global_hour', 'global_day', 'budget'])

const COLUMNS = ['id', 'location_id', 'phone_e164', 'customer_id', 'pending_since', 'last_inbound_at', 'running_since', 'handoff_state', 'disclosed_at'] as const

const ZERO_USAGE: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

/** The caps of design section 3 that a new turn of this conversation would cross, or null. */
export async function capReached(
  db: Db | Tx,
  o: { locationId: string; conversationId: string; trust: TurnIdentity['trust']; now: Date; tz: string; cfg: AssistantConfig },
): Promise<CapKind | null> {
  const hourAgo = new Date(o.now.getTime() - 3600_000)
  const dayStart = bizDayBounds(toBizDate(o.now, o.tz), o.tz).start
  const r = await sql<{ nh: number; nd: number; gh: number; gd: number; spent: string | number }>`
    select
      (select count(*)::int from assistant_turns where conversation_id = ${o.conversationId} and model is not null and started_at > ${hourAgo}) as nh,
      (select count(*)::int from assistant_turns where conversation_id = ${o.conversationId} and model is not null and started_at >= ${dayStart}) as nd,
      (select count(*)::int from assistant_turns t join assistant_conversations c on c.id = t.conversation_id
         where c.location_id = ${o.locationId} and t.model is not null and t.started_at > ${hourAgo}) as gh,
      (select count(*)::int from assistant_turns t join assistant_conversations c on c.id = t.conversation_id
         where c.location_id = ${o.locationId} and t.model is not null and t.started_at >= ${dayStart}) as gd,
      (select coalesce(sum(t.cost_micros), 0) from assistant_turns t join assistant_conversations c on c.id = t.conversation_id
         where c.location_id = ${o.locationId} and t.started_at >= ${dayStart}) as spent`.execute(db)
  const x = r.rows[0]!
  const caps = o.cfg.caps
  if (Number(x.spent) >= caps.dailyBudgetMicros) return 'budget'
  if (x.gd >= caps.globalDay) return 'global_day'
  if (x.gh >= caps.globalHour) return 'global_hour'
  if (o.trust === 'unknown' && x.nd >= caps.unknownDay) return 'unknown_day'
  if (x.nd >= caps.perNumberDay) return 'number_day'
  if (x.nh >= caps.perNumberHour) return 'number_hour'
  return null
}

/** "6 turns without progress" (design section 3): the last N answered turns of the day made no successful tool call. */
export async function noProgress(db: Db | Tx, o: { conversationId: string; now: Date; turns: number }): Promise<boolean> {
  const recent = await db
    .selectFrom('assistant_turns')
    .select(['id', 'status'])
    .where('conversation_id', '=', o.conversationId)
    .where('status', '!=', 'running')
    .where('started_at', '>', new Date(o.now.getTime() - 86_400_000))
    .orderBy('started_at', 'desc')
    .limit(o.turns)
    .execute()
  if (recent.length < o.turns || recent.some((t) => t.status !== 'replied')) return false
  const progress = await db
    .selectFrom('assistant_tool_calls')
    .select('id')
    .where(
      'turn_id',
      'in',
      recent.map((t) => t.id),
    )
    .where('outcome', '=', 'ok')
    .where('tool', 'not in', [...NON_PROGRESS_TOOLS])
    .limit(1)
    .executeTakeFirst()
  return progress === undefined
}

/**
 * The reply as queued: the ai_reply template (the disclosure on the first AI text), links as secretVars (class personal_link), and
 * with `safety` (a verify, PIN, membership or payment link) the server's SAFETY_LINE after the reply: the model never writes it.
 */
export function composeReply(o: { text: string; disclose: boolean; links: ReadonlyMap<string, string>; safety?: boolean; card?: boolean }): {
  text: string
  klass: 'ai_reply' | 'personal_link'
  secretVars?: Record<string, string>
} {
  let reply = o.text
  // a registered link the reply left out is appended (the contract: the model may forget the placeholder)
  for (const p of o.links.keys()) if (!reply.includes(p)) reply = `${reply} ${p}`
  if (o.safety) reply = `${reply} ${SAFETY_LINE}`
  if (o.card) reply = `${reply} ${CARD_LINE}`
  const text = renderTemplate('ai_reply', { reply, ...(o.disclose ? { disclosure: 'yes' } : {}) }).text
  const used = [...o.links.entries()].filter(([p]) => text.includes(p))
  if (used.length === 0) return { text, klass: 'ai_reply' }
  return { text, klass: 'personal_link', secretVars: Object.fromEntries(used.map(([p, url]) => [p.slice(1, -1), url])) }
}

class TurnAbort extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

/** One turn of the conversation. Never throws for the model's failures (they become the fallback); database errors propagate. */
export async function runTurn(d: TurnDeps, conversationId: string): Promise<TurnResult> {
  const nowMs = d.nowMs ?? (() => performance.now())
  const tz = d.env.BUSINESS_TZ
  const now = d.clock.now()
  const conv = await d.db.selectFrom('assistant_conversations').select([...COLUMNS]).where('id', '=', conversationId).executeTakeFirst()
  if (!conv || !conv.pending_since) return { status: 'none' }
  const ref = (threadCustomerId: string | null): ConversationRef => ({ id: conv.id, locationId: conv.location_id, phone: conv.phone_e164, threadCustomerId })
  const hd: HandoffDeps = { clock: d.clock, newId: d.newId, queue: d.queue, inbox: d.inbox }

  // ---- the gate again: switches, stage, opt-out, staff pause, open handoff, loop breakers
  const newest = await d.db
    .selectFrom('sms_inbox')
    .select('body')
    .where('assistant_conversation_id', '=', conv.id)
    .orderBy('received_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst()
  const resolved = await resolveIdentity(d.db, { locationId: conv.location_id, phone: conv.phone_e164, customerId: conv.customer_id, now })
  const verdict = await d.gate.evaluate(d.db, {
    locationId: conv.location_id,
    from: conv.phone_e164,
    phone: conv.phone_e164,
    customerId: resolved.threadCustomerId,
    optedOut: await hasActiveOptOut(d.db, conv.location_id, conv.phone_e164),
    body: newest?.body ?? '',
    now,
  })
  if (!verdict.allow) {
    const reason = `gate:${verdict.reason ?? 'closed'}`
    await transaction(d.db, async (tx) => {
      const n = await tx
        .updateTable('assistant_conversations')
        .set({ pending_since: null, updated_at: now })
        .where('id', '=', conv.id)
        .where('pending_since', 'is not', null)
        .returning('id')
        .execute()
      // the texts were filed read for the assistant: staff must see them now (not for an opted-out number: nobody answers it)
      if (n.length > 0 && verdict.reason !== 'opted_out') await markUnanswered(tx, ref(resolved.threadCustomerId))
    })
    d.log.info({ conversation: conv.id, reason }, 'assistant turn skipped')
    return { status: 'skipped', reason }
  }

  const identity0 = resolved.identity
  const cap = await capReached(d.db, { locationId: conv.location_id, conversationId: conv.id, trust: identity0.trust, now, tz, cfg: d.cfg })

  // ---- claim: the conversation's lock, its lease and the turn row
  const claim = await transaction(d.db, async (tx) => {
    const c = await tx.selectFrom('assistant_conversations').select([...COLUMNS]).where('id', '=', conv.id).forUpdate().executeTakeFirstOrThrow()
    if (!c.pending_since) return null
    if (c.running_since && now.getTime() - c.running_since.getTime() < d.cfg.leaseMs) return 'busy' as const
    await tx
      .updateTable('assistant_turns')
      .set({ status: 'failed', error: 'lease_timeout', finished_at: now })
      .where('conversation_id', '=', c.id)
      .where('status', '=', 'running')
      .execute()
    const turnId = d.newId()
    await tx
      .insertInto('assistant_turns')
      .values({
        id: turnId,
        conversation_id: c.id,
        trust: identity0.trust === 'caller' ? 'known' : identity0.trust,
        provider: d.provider.name,
        prompt_version: PROMPT_VERSION,
        started_at: now,
      })
      .execute()
    await tx.updateTable('assistant_conversations').set({ running_since: now, customer_id: identity0.customerId ?? c.customer_id, updated_at: now }).where('id', '=', c.id).execute()
    return { turnId, conv: c }
  })
  if (claim === null) return { status: 'none' }
  if (claim === 'busy') return { status: 'busy' }
  const { turnId } = claim
  const snapshotInbound = claim.conv.last_inbound_at
  const transcript = new Transcript()
  const state = { identity: identity0, threadCustomerId: resolved.threadCustomerId }
  const began = nowMs()
  // the judge's calls: their own model and prices, counted in the turn's tokens and cost_micros (the daily budget sums them)
  let judgeUsage = ZERO_USAGE
  const costOf = (usage: AiUsage): number => aiCostMicros(usage, d.cfg.prices) + aiCostMicros(judgeUsage, d.cfg.judge.prices)
  const tokensOf = (usage: AiUsage) => {
    const all = addUsage(usage, judgeUsage)
    return { tokens_in: all.inputTokens, tokens_out: all.outputTokens, tokens_cache_read: all.cacheReadTokens, tokens_cache_write: all.cacheWriteTokens }
  }

  const finishHandoff = async (o: { reason: string; status: 'handed_off' | 'failed'; fallback: boolean; error?: string; summary?: string; usage?: AiUsage; model?: string | null; rounds?: number; stop?: string | null }): Promise<TurnResult> => {
    transcript.add({ kind: 'handoff', reason: o.reason })
    const usage = o.usage ?? ZERO_USAGE
    const fallbackId = await transaction(d.db, async (tx) => {
      await tx.selectFrom('assistant_conversations').select('id').where('id', '=', conv.id).forUpdate().executeTakeFirstOrThrow()
      const c = ref(state.threadCustomerId)
      const msg = o.fallback ? await sendFallback(tx, hd, c, { turnId, everyMs: d.cfg.fallbackEveryMs }) : null
      await openTurnHandoff(tx, hd, c, { reason: o.reason, summary: o.summary ?? HANDOFF_SUMMARIES[o.reason] ?? HANDOFF_SUMMARIES.fallback! })
      await tx
        .updateTable('assistant_turns')
        .set({
          status: o.status,
          error: (o.error ?? o.reason).slice(0, 2000),
          model: o.model ?? null,
          rounds: o.rounds ?? 0,
          ...tokensOf(usage),
          cost_micros: costOf(usage),
          stop_reason: o.stop ?? null,
          latency_ms: Math.max(0, Math.round(nowMs() - began)),
          reply_message_id: msg,
          transcript: JSON.stringify(transcript.toJson()) as never,
          finished_at: d.clock.now(),
        })
        .where('id', '=', turnId)
        .execute()
      await tx.updateTable('sms_inbox').set({ assistant_turn_id: turnId }).where('assistant_conversation_id', '=', conv.id).where('assistant_turn_id', 'is', null).execute()
      await tx.updateTable('assistant_conversations').set({ pending_since: null, running_since: null, updated_at: d.clock.now() }).where('id', '=', conv.id).execute()
      await audit.record(tx, {
        locationId: conv.location_id,
        action: 'assistant.handoff',
        entityType: 'assistant_conversation',
        entityId: conv.id,
        after: { turnId, reason: o.reason, fallback: msg !== null },
        ctx: { actor: { name: AI_ACTOR_NAME }, requestId: turnId },
      })
      return msg
    })
    d.log.info({ conversation: conv.id, turn: turnId, reason: o.reason }, 'assistant handed the conversation to staff')
    return { status: 'handed_off', turnId, reason: o.reason, fallbackMessageId: fallbackId }
  }

  /** The client opted out in this turn (the opt_out tool): the turn ends without a reply; the texts it took are answered. */
  const finishOptedOut = async (o: { usage: AiUsage; model: string | null; rounds: number; stop: string | null }): Promise<TurnResult> => {
    transcript.add({ kind: 'error', error: 'opted_out' })
    await transaction(d.db, async (tx) => {
      await tx.selectFrom('assistant_conversations').select('id').where('id', '=', conv.id).forUpdate().executeTakeFirstOrThrow()
      await tx
        .updateTable('assistant_turns')
        .set({
          status: 'skipped',
          error: 'opted_out',
          model: o.model,
          rounds: o.rounds,
          ...tokensOf(o.usage),
          cost_micros: costOf(o.usage),
          stop_reason: o.stop,
          latency_ms: Math.max(0, Math.round(nowMs() - began)),
          transcript: JSON.stringify(transcript.toJson()) as never,
          finished_at: d.clock.now(),
        })
        .where('id', '=', turnId)
        .execute()
      await tx.updateTable('sms_inbox').set({ assistant_turn_id: turnId }).where('assistant_conversation_id', '=', conv.id).where('assistant_turn_id', 'is', null).execute()
      await tx.updateTable('assistant_conversations').set({ pending_since: null, running_since: null, updated_at: d.clock.now() }).where('id', '=', conv.id).execute()
    })
    d.log.info({ conversation: conv.id, turn: turnId }, 'assistant turn ended: the client opted out')
    return { status: 'skipped', reason: 'opted_out', turnId }
  }

  // ---- texts too old to answer (the reply window is 15 minutes): staff take them, no fallback (it would be refused too)
  if (conv.last_inbound_at && now.getTime() - conv.last_inbound_at.getTime() > d.cfg.staleMarkerMs) return finishHandoff({ reason: 'stale', status: 'handed_off', fallback: false })

  if (cap) {
    if (GLOBAL_CAPS.has(cap)) await notifyCapOnce(d, { locationId: conv.location_id, cap, now, tz })
    return finishHandoff({ reason: `cap:${cap}`, status: 'handed_off', fallback: true })
  }
  if (await noProgress(d.db, { conversationId: conv.id, now, turns: d.cfg.noProgressTurns })) return finishHandoff({ reason: 'no_progress', status: 'handed_off', fallback: true })

  // ---- context
  const loc = conv.location_id
  const facts = await d.facts.get(loc)
  const actionsEnabled = d.cfg.actionsEnabled && (await getSetting(d.db, loc, 'assistant.actions_enabled')).value
  const refRows = await loadAppointmentRefs(d.db, { locationId: loc, customerId: identity0.customerId, now })
  const snap = await loadConversation(d.db, {
    locationId: loc,
    conversationId: conv.id,
    phone: conv.phone_e164,
    pendingSince: claim.conv.pending_since,
    now,
    tz,
    limit: d.cfg.historyLimit,
    windowMs: d.cfg.historyWindowMs,
  })
  const turnContext = await loadTurnContext(d.db, { resolved, conversationId: conv.id, refs: refRows, actionsEnabled, firstContact: snap.firstContact, now, tz })
  const contextText = renderTurnContext(turnContext)
  const tools = offeredTools(d.registry, actionsEnabled)
  const specs = toolSpecs(tools)
  const factsText = renderShopFacts(facts)
  const system: AiSystemBlock[] = [{ text: STATIC_RULES }, { text: factsText, cache: true }, { text: contextText }]
  transcript.add({ kind: 'system', promptVersion: PROMPT_VERSION, factsVersion: facts.version, tools: tools.map((t) => t.name) })
  transcript.add({ kind: 'context', text: contextText })
  const messages: AiMessage[] = [{ role: 'user', content: [{ type: 'text', text: renderConversation(snap.lines) }] }]
  transcript.add({ kind: 'message', message: messages[0]! })

  // ---- the tool context
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new TurnAbort('deadline')), d.cfg.turnDeadlineMs)
  timer.unref?.()
  const links = new Map<string, string>()
  const linkKinds = new Set<string>()
  let toolHandoff: HandoffRequest | null = null
  let balanceCents: number | null = null
  let confirmTexted = false
  const ctx: ToolContext = {
    db: d.db,
    clock: d.clock,
    now,
    newId: d.newId,
    env: d.env,
    get identity() {
      return state.identity
    },
    conversationId: conv.id,
    turnId,
    facts,
    refs: appointmentRefs(refRows),
    actionsEnabled,
    scheduling: d.schedulingFor(loc),
    actor: d.actorFor(loc),
    queue: d.queue,
    log: d.log,
    signal: deadline.signal,
    addLink(url, link) {
      const p = `{link${links.size + 1}}`
      links.set(p, url)
      linkKinds.add(link.kind)
      return p
    },
    handoff(reason, summary) {
      toolHandoff ??= { reason, summary }
    },
    async audit(tx, action, detail) {
      await audit.record(tx, {
        locationId: loc,
        action,
        entityType: detail.entityType,
        entityId: detail.entityId ?? null,
        before: detail.before,
        after: detail.after,
        ctx: { actor: { name: AI_ACTOR_NAME }, requestId: turnId },
      })
    },
    async setCustomer(customerId) {
      const owner = await d.db
        .selectFrom('customers')
        .select('id')
        .where('id', '=', customerId)
        .where('phone_e164', '=', conv.phone_e164)
        .where('merged_into', 'is', null)
        .where('deleted_at', 'is', null)
        .executeTakeFirst()
      if (!owner) throw new Error('setCustomer: that client does not own this number')
      const again = await resolveIdentity(d.db, { locationId: loc, phone: conv.phone_e164, customerId, now: d.clock.now() })
      state.identity = again.identity
      state.threadCustomerId = again.threadCustomerId
      await d.db.updateTable('assistant_conversations').set({ customer_id: customerId, updated_at: d.clock.now() }).where('id', '=', conv.id).execute()
    },
  }

  // ---- the Converse loop
  let usage = ZERO_USAGE
  let model: string | null = null
  let rounds = 0
  let seq = 0
  let stop: string | null = null
  const call = async (req: AiConverseRequest): Promise<AiConverseResponse> => {
    if (deadline.signal.aborted) throw new TurnAbort('deadline')
    const signal = AbortSignal.any([deadline.signal, AbortSignal.timeout(d.cfg.callTimeoutMs)])
    const res = await d.provider.converse(req, { signal })
    usage = addUsage(usage, res.usage)
    model = res.model
    stop = res.rawStopReason
    transcript.add({ kind: 'message', message: res.message, stopReason: res.rawStopReason, usage: { ...res.usage } })
    return res
  }
  const request = (final: boolean): AiConverseRequest => ({
    system,
    messages,
    ...(specs.length > 0 ? { tools: specs, cacheTools: true } : {}),
    toolChoice: final || specs.length === 0 ? 'none' : 'auto',
    maxTokens: d.cfg.maxTokens,
    effort: d.cfg.effort,
  })
  const failureOf = (e: unknown): string =>
    e instanceof TurnAbort ? 'timeout:turn' : e instanceof AiProviderError ? `ai:${e.kind}` : `error:${(e as Error)?.name ?? 'Error'}`

  let text: string | null = null
  let optedOut = false
  try {
    try {
      for (;;) {
        const final = rounds >= d.cfg.maxToolRounds
        const res = await call(request(final))
        messages.push(res.message)
        if (res.stopReason === 'tool_use') {
          const uses = res.message.content.filter((b): b is Extract<AiContentBlock, { type: 'toolUse' }> => b.type === 'toolUse')
          if (final || uses.length === 0) throw new TurnAbort('tool_use_after_reply_now')
          rounds += 1
          const r = await runToolRound({ db: d.db, newId: d.newId, nowMs }, { registry: d.registry, ctx, uses, round: rounds, seq, actionsEnabled })
          seq = r.seq
          if (r.balanceCents !== null) balanceCents = r.balanceCents
          if (r.confirmTexted) confirmTexted = true
          toolHandoff ??= r.handoff
          transcript.add({ kind: 'tools', round: rounds, calls: r.calls })
          // the client opted out in words (opt_out sent the confirmation): nothing more is written to that number, not even a reply
          // the queue would refuse, and no rewrite, judge or fallback runs over an empty "nothing else to say"
          if (r.calls.some((c) => c.tool === 'opt_out' && c.outcome === 'ok')) {
            optedOut = true
            break
          }
          const content: AiContentBlock[] = [...r.results]
          if (rounds >= d.cfg.maxToolRounds) content.push({ type: 'text', text: REPLY_NOW_TEXT })
          messages.push({ role: 'user', content })
          transcript.add({ kind: 'message', message: messages[messages.length - 1]! })
          continue
        }
        if (res.stopReason !== 'end_turn') throw new TurnAbort(`stop:${res.stopReason}`)
        text = textOf(res.message)
        break
      }
    } catch (e) {
      const reason = e instanceof TurnAbort ? e.reason : failureOf(e)
      transcript.add({ kind: 'error', error: reason })
      return await finishHandoff({ reason: 'fallback', status: 'failed', fallback: true, error: reason, usage, model, rounds, stop })
    }
    // the loop ends without a text only after an opt-out
    if (optedOut || text === null) return await finishOptedOut({ usage, model, rounds, stop })

    // ---- the output guard
    // what the placeholders render to (the current facts; {balance} only after get_balance; the links stay for composeReply)
    const values = placeholderValues(facts, { balanceCents, confirmTexted })
    for (const p of links.keys()) values.set(p, p)
    // server-owned literals only (the address, catalog and plan names): the digit rules skip them. Client-entered text (a vehicle on
    // file, the name) is NEVER a literal and never trusted by the judge (fix 1 of the v4 re-check: a vehicle "Free Wash 2015550123")
    const literals = factLiterals(facts)
    // the client's own first name and vehicles are skipped by the secret and promise word lists only ("Hi Buck", "your Ford Focus")
    const names = [turnContext.firstName, ...turnContext.vehicles.map((v) => v.split(',')[0]), ...(turnContext.vehicleNames ?? [])]
    // a verify / PIN / membership / payment link: the server appends the safety line, so the reply leaves room for it
    const safety = [...linkKinds].some((k) => SAFETY_LINK_KINDS.has(k))
    // the client texted a card number: the server's CARD_LINE follows the reply (the model may write nothing about cards)
    const card =
      snap.inboxIds.length > 0 && (await d.db.selectFrom('sms_inbox').select('body').where('id', 'in', snap.inboxIds).execute()).some((r) => looksLikeCardNumber(r.body))
    const maxChars = MAX_REPLY_CHARS - (safety ? SAFETY_LINE.length + 1 : 0) - (card ? CARD_LINE.length + 1 : 0)
    let rewriteUsed = false
    let shortenUsed = false
    let judgeRewriteUsed = false
    const fix = async (draft: string, problems: readonly GuardProblem[], words: readonly string[] = [], instruction?: string): Promise<string> => {
      messages.push({ role: 'user', content: [{ type: 'text', text: instruction ?? rewriteInstruction(draft, problems, words) }] })
      transcript.add({ kind: 'message', message: messages[messages.length - 1]! })
      const res = await call(request(true))
      messages.push(res.message)
      if (res.stopReason !== 'end_turn') throw new TurnAbort(`stop:${res.stopReason}`)
      return textOf(res.message)
    }
    // (3) the policy judge: the rendered reply, the server's segments trusted (the safety line too); never throws (an error fails closed)
    const judge = async (segments: readonly ReplySegment[]) => {
      const all = [
        ...segments,
        ...(safety ? [{ text: ' ', trusted: false }, { text: SAFETY_LINE, trusted: true }] : []),
        ...(card ? [{ text: ' ', trusted: false }, { text: CARD_LINE, trusted: true }] : []),
      ]
      const r = await runJudge(d.judge, all, { timeoutMs: d.cfg.judge.timeoutMs, maxTokens: d.cfg.judge.maxTokens, signal: deadline.signal, nowMs })
      judgeUsage = addUsage(judgeUsage, r.usage)
      const o = r.outcome
      const entry = { verdict: o.kind, model: r.model, latencyMs: r.latencyMs, ...(o.kind === 'error' ? { error: o.error } : { category: o.verdict.category, reason: o.verdict.reason }) }
      transcript.add({ kind: 'judge', ...entry })
      // stored for review like a tool call (redacted; the judge's message holds no phone number, id or token in the first place)
      seq += 1
      await d.db
        .insertInto('assistant_tool_calls')
        .values({
          id: d.newId(),
          turn_id: turnId,
          seq,
          round: rounds,
          tool: 'policy_judge',
          tool_use_id: null,
          input: JSON.stringify({ model: r.model ?? d.cfg.judge.modelId, message: redactText(r.message) }) as never,
          output: o.kind === 'error' ? null : (JSON.stringify(o.verdict) as never),
          outcome: o.kind === 'pass' ? 'ok' : o.kind === 'fail' ? 'denied' : 'error',
          error: o.kind === 'error' ? o.error.slice(0, 2000) : o.kind === 'fail' ? o.verdict.category : null,
          latency_ms: r.latencyMs,
        })
        .execute()
      return o
    }
    let draft = text
    let reply: string | null = null
    try {
      for (let i = 0; i < 10 && reply === null; i++) {
        const v = guardReply({
          text: draft,
          values,
          literals,
          names,
          address: facts.business.address,
          openWindow: openingWindow(facts),
          website: facts.business.website,
          shopNumbers: [facts.contact.textingNumber, facts.contact.callingNumber],
          maxChars,
        })
        transcript.add({ kind: 'guard', verdict: v.kind, ...(v.kind === 'fix' ? { problems: v.problems, ...(v.words.length > 0 ? { words: v.words } : {}) } : {}) })
        if (v.kind === 'ok') {
          if (!d.cfg.judge.enabled) {
            reply = v.rendered
            break
          }
          const j = await judge(v.segments)
          if (j.kind === 'pass') {
            reply = v.rendered
            break
          }
          // fail closed: no verdict, no reply (the turn deadline is the turn's own timeout)
          if (j.kind === 'error') {
            if (deadline.signal.aborted) throw new TurnAbort('deadline')
            return await finishHandoff({ reason: 'judge_error', status: 'handed_off', fallback: true, usage, model, rounds, stop, error: `judge:${j.error}` })
          }
          if (judgeRewriteUsed)
            return await finishHandoff({ reason: 'policy_judge', status: 'handed_off', fallback: true, usage, model, rounds, stop, error: `judge:${j.verdict.category}` })
          judgeRewriteUsed = true
          draft = await fix(v.text, [], [], judgeRewriteInstruction(v.text, JUDGE_HINTS[j.verdict.category]))
          continue
        }
        const hard = v.problems.filter((p) => HARD_PROBLEMS.has(p))
        if (hard.length > 0 || (v.problems.includes('questions') && !rewriteUsed)) {
          // the rewrite still trips a rule: the fallback and a person (promise words: "policy_words", anything else: "guard")
          if (rewriteUsed) {
            if (v.problems.includes('promise_words'))
              return await finishHandoff({ reason: 'policy_words', status: 'handed_off', fallback: true, usage, model, rounds, stop, error: `policy_words:${v.words.join(',')}` })
            return await finishHandoff({ reason: 'guard', status: 'handed_off', fallback: true, usage, model, rounds, stop, error: `guard:${hard.join(',')}` })
          }
          rewriteUsed = true
          draft = await fix(v.text, v.problems, v.words)
          continue
        }
        if (v.problems.includes('questions')) {
          draft = cutAfterFirstQuestion(v.text)
          continue
        }
        // too long only
        if (!shortenUsed) {
          shortenUsed = true
          draft = await fix(v.text, ['too_long'])
          continue
        }
        // the cut is on the raw text: leave room for what the placeholders add when rendered
        draft = cutAtSentence(v.text, maxChars - Math.max(0, v.rendered.length - v.text.length))
      }
    } catch (e) {
      const reason = e instanceof TurnAbort ? e.reason : failureOf(e)
      transcript.add({ kind: 'error', error: reason })
      return await finishHandoff({ reason: 'fallback', status: 'failed', fallback: true, error: reason, usage, model, rounds, stop })
    }
    if (reply === null) return await finishHandoff({ reason: 'guard', status: 'handed_off', fallback: true, usage, model, rounds, stop, error: 'guard:unresolved' })

    // ---- the reply
    const out = await transaction(d.db, async (tx) => {
      const c = await tx.selectFrom('assistant_conversations').select([...COLUMNS]).where('id', '=', conv.id).forUpdate().executeTakeFirstOrThrow()
      const target = ref(state.threadCustomerId)
      // staff took the thread over (or AGENT opened a handoff) while the model was thinking: their answer stands
      const paused = state.threadCustomerId
        ? await tx
            .selectFrom('message_threads')
            .select('id')
            .where('location_id', '=', loc)
            .where('customer_id', '=', state.threadCustomerId)
            .where('ai_paused_until', '>', d.clock.now())
            .executeTakeFirst()
        : undefined
      const superseded = c.handoff_state === 'open' || paused !== undefined
      const composed = composeReply({ text: reply, disclose: c.disclosed_at === null, links, safety, card })
      const queued = superseded
        ? null
        : await d.queue.enqueueFor(tx, {
            locationId: loc,
            customerId: state.threadCustomerId,
            recipient: await recipientOf(tx, target),
            appointmentId: null,
            text: composed.text,
            klass: composed.klass,
            ...(composed.secretVars ? { secretVars: composed.secretVars } : {}),
            purpose: 'assistant',
            senderKind: 'ai',
            tag: 'ai_reply',
            dedupeKey: `ai-reply:${turnId}`,
          })
      const messageId = queued?.queued ? queued.messageId : null
      const status: 'replied' | 'skipped' | 'failed' = messageId ? 'replied' : superseded || (queued && !queued.queued && queued.skipped === 'opted_out') ? 'skipped' : 'failed'
      const error = superseded ? 'superseded' : queued && !queued.queued ? `enqueue:${queued.skipped}` : null
      transcript.add({ kind: 'reply', text: composed.text, klass: composed.klass })
      // newer texts arrived while this turn ran: keep the marker (from the oldest of them) and kick again
      const newer = c.last_inbound_at && snapshotInbound && c.last_inbound_at.getTime() > snapshotInbound.getTime()
      const nextPending = newer
        ? ((
            await tx
              .selectFrom('sms_inbox')
              .select((eb) => eb.fn.min('received_at').as('at'))
              .where('assistant_conversation_id', '=', c.id)
              .where('decision', '=', 'assistant')
              .where('received_at', '>', snapshotInbound)
              .executeTakeFirst()
          )?.at ?? null)
        : null
      await tx
        .updateTable('assistant_turns')
        .set({
          status,
          error,
          model,
          rounds,
          ...tokensOf(usage),
          cost_micros: costOf(usage),
          stop_reason: stop,
          latency_ms: Math.max(0, Math.round(nowMs() - began)),
          reply_message_id: messageId,
          transcript: JSON.stringify(transcript.toJson()) as never,
          finished_at: d.clock.now(),
        })
        .where('id', '=', turnId)
        .execute()
      await tx
        .updateTable('sms_inbox')
        .set({ assistant_turn_id: turnId })
        .where('assistant_conversation_id', '=', c.id)
        .where('assistant_turn_id', 'is', null)
        .where('received_at', '<=', snapshotInbound ?? now)
        .execute()
      await tx
        .updateTable('assistant_conversations')
        .set({
          // a handoff the model asked for gives the newer texts to staff as well
          pending_since: superseded || (messageId && toolHandoff) ? null : nextPending,
          running_since: null,
          ...(messageId && c.disclosed_at === null ? { disclosed_at: d.clock.now() } : {}),
          updated_at: d.clock.now(),
        })
        .where('id', '=', c.id)
        .execute()
      if (messageId) {
        await audit.record(tx, {
          locationId: loc,
          action: 'assistant.reply',
          entityType: 'assistant_conversation',
          entityId: c.id,
          after: { turnId, messageId, klass: composed.klass, rounds, links: links.size, disclosed: c.disclosed_at === null },
          ctx: { actor: { name: AI_ACTOR_NAME }, requestId: turnId },
        })
        if (toolHandoff) await openTurnHandoff(tx, hd, target, { reason: toolHandoff.reason, summary: toolHandoff.summary })
      } else if (status === 'failed') {
        await openTurnHandoff(tx, hd, target, { reason: 'fallback', summary: HANDOFF_SUMMARIES.fallback! })
      }
      return { messageId, status, error, composed, kickAgain: !superseded && !(messageId && toolHandoff) && nextPending !== null }
    })
    if (out.kickAgain) await d.kick([conv.id]).catch((e: Error) => d.log.warn({ err: e.message.slice(0, 200) }, 'assistant re-kick failed; the sweep will start it'))
    if (out.status === 'replied') return { status: 'replied', turnId, messageId: out.messageId!, text: out.composed.text, handoff: toolHandoff !== null }
    if (out.status === 'skipped') return { status: 'skipped', reason: out.error ?? 'skipped', turnId }
    return { status: 'failed', turnId, reason: out.error ?? 'failed' }
  } finally {
    clearTimeout(timer)
  }
}

/** A shop-wide cap (or the budget) tells the managers once per business day. */
async function notifyCapOnce(d: TurnDeps, o: { locationId: string; cap: CapKind; now: Date; tz: string }): Promise<void> {
  const sourceRef = `assistant_cap:${o.cap}:${toBizDate(o.now, o.tz)}`
  await transaction(d.db, async (tx) => {
    const seen = await tx.selectFrom('notifications').select('id').where('location_id', '=', o.locationId).where('source_ref', '=', sourceRef).limit(1).executeTakeFirst()
    if (seen) return
    await notifyManagers(
      tx,
      {
        locationId: o.locationId,
        kind: 'assistant.cap',
        title: o.cap === 'global_hour' ? 'The assistant paused for this hour' : 'The assistant is off until tomorrow',
        body: `${HANDOFF_SUMMARIES[`cap:${o.cap}`] ?? ''} New texts go to the team (Messages).`.trim(),
        entityType: null,
        entityId: null,
        sourceRef,
      },
      { newId: d.newId, clock: d.clock },
    )
  })
}
