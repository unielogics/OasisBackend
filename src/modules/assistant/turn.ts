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
import { randomInt } from 'node:crypto'
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
import { bizDayBounds, bizWeekday, clockLabel, toBizDate } from '../../platform/time.js'
import { DAY_ABBR } from '../settings/labels.js'
import { renderTemplate } from '../messaging/templates/render.js'
import { hasActiveOptOut } from '../messaging/db/recipients.js'
import { notifyManagers } from '../messaging/notify.js'
import type { Actor, SchedulingCtx } from '../scheduling/context.js'
import { AI_ACTOR_NAME, type AssistantLog, type AssistantQueue, type HandoffRequest, type ShopFactsSource, type ToolContext, type ToolOutcome, type ToolRegistry, type TurnIdentity } from './contract.js'
import type { AssistantConfig } from './config.js'
import { appointmentRefs, loadAppointmentRefs, loadConversation, loadTurnContext, resolveIdentity } from './context.js'
import { CONFIRM_PLACEHOLDER, factLiterals, openingWindow, placeholderValues, renderShopFacts } from './facts.js'
import {
  cutAfterFirstQuestion,
  cutAtSentence,
  sentencesOf,
  guardReply,
  HARD_PROBLEMS,
  isolatePlaceholders,
  looksLikeCardNumber,
  MAX_REPLY_CHARS,
  SAFETY_LINK_KINDS,
  withoutQuestions,
  type GuardProblem,
  type ReplySegment,
} from './guard.js'
import {
  CARD_LINES,
  detectLanguage,
  FALLBACK_TEXTS,
  isConvoLang,
  SAFETY_LINES,
  storeLanguage,
  withDisclosure,
  type ConvoLang,
} from './lang.js'
import { whenWords } from './tools/common.js'
import { JUDGE_HINTS, runJudge } from './judge.js'
import { HANDOFF_SUMMARIES, markUnanswered, openTurnHandoff, recipientOf, sendFallback, type ConversationRef, type HandoffDeps } from './handoff.js'
import type { AssistantGate, AssistantInbox } from './ports.js'
import { asksForFree, declinesPlans, judgeRewriteInstruction, PROMPT_VERSION, REPLY_NOW_TEXT, STATIC_RULES, renderConversation, renderTurnContext, rewriteInstruction } from './prompt.js'
import { NON_PROGRESS_TOOLS, offeredTools, recordLine, runToolRound, toolSpecs } from './tool-runner.js'
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
  /** The wait before the one retry of a throttled or timed-out call (default retryBackoffMs: 800-1500 ms; tests shorten it). */
  retryBackoffMs?: () => number
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

const COLUMNS = [
  'id',
  'location_id',
  'phone_e164',
  'customer_id',
  'pending_since',
  'last_inbound_at',
  'running_since',
  'handoff_state',
  'disclosed_at',
  'language',
] as const

const ZERO_USAGE: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

/**
 * W4a fix F3: a model call or a judge call that the account's quota throttled (ThrottlingException, 429), that timed out, or that
 * met an outage (5xx: the SDK retry this replaces covered those) is retried ONCE, after RETRY_BACKOFF_MIN_MS-RETRY_BACKOFF_MAX_MS
 * (jitter), and only while the turn deadline leaves the wait plus RETRY_MIN_ROOM_MS; each retry is a transcript entry (kind
 * "retry") and a log line, and a retried judge call's row and transcript entry carry attempts: 2. A second failure fails closed as
 * before (the fallback and a handoff). The Bedrock client itself no longer retries (createBedrockClient: one attempt), so this is
 * the only retry.
 */
export const RETRY_BACKOFF_MIN_MS = 800
export const RETRY_BACKOFF_MAX_MS = 1500
export const RETRY_MIN_ROOM_MS = 3000
export const retryBackoffMs = (): number => randomInt(RETRY_BACKOFF_MIN_MS, RETRY_BACKOFF_MAX_MS + 1)
/** The judge's errors a retry can help (runJudge: its own 8-second timeout, the provider's timeout, the quota, an outage). */
const RETRYABLE_JUDGE_ERRORS: ReadonlySet<string> = new Set(['timeout', 'ai:timeout', 'ai:throttled', 'ai:unavailable'])

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
export function composeReply(o: {
  text: string
  disclose: boolean
  links: ReadonlyMap<string, string>
  safety?: boolean
  card?: boolean
  lang?: ConvoLang
}): {
  text: string
  klass: 'ai_reply' | 'personal_link'
  secretVars?: Record<string, string>
} {
  const lang = o.lang ?? 'en'
  let reply = o.text
  // a registered link the reply left out is appended (the contract: the model may forget the placeholder)
  for (const p of o.links.keys()) if (!reply.includes(p)) reply = `${reply} ${p}`
  if (o.safety) reply = `${reply} ${SAFETY_LINES[lang]}`
  if (o.card) reply = `${reply} ${CARD_LINES[lang]}`
  // the first AI text of the conversation: the disclosure and the STOP footer, in the conversation's language (W4b X5)
  const text =
    lang === 'en'
      ? renderTemplate('ai_reply', { reply, ...(o.disclose ? { disclosure: 'yes' } : {}) }).text
      : o.disclose
        ? withDisclosure(reply, lang)
        : reply.trim()
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

  const finishHandoff = async (o: { reason: string; status: 'handed_off' | 'failed'; fallback: boolean; notify?: boolean; error?: string; summary?: string; usage?: AiUsage; model?: string | null; rounds?: number; stop?: string | null }): Promise<TurnResult> => {
    transcript.add({ kind: 'handoff', reason: o.reason })
    const usage = o.usage ?? ZERO_USAGE
    const fallbackId = await transaction(d.db, async (tx) => {
      await tx.selectFrom('assistant_conversations').select('id').where('id', '=', conv.id).forUpdate().executeTakeFirstOrThrow()
      const c = ref(state.threadCustomerId)
      const msg = o.fallback ? await sendFallback(tx, hd, c, { turnId, everyMs: d.cfg.fallbackEveryMs }) : null
      await openTurnHandoff(tx, hd, c, { reason: o.reason, summary: o.summary ?? HANDOFF_SUMMARIES[o.reason] ?? HANDOFF_SUMMARIES.fallback!, notify: o.notify !== false })
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
    // a shop-wide cap (or the budget) tells the managers once per cap window, and the conversations it stops get no fallback text and
    // no notice of their own: a flood of (spoofed) numbers must not turn into a flood of texts and notifications (W4c fixes)
    const global = GLOBAL_CAPS.has(cap)
    if (global) await notifyCapOnce(d, { locationId: conv.location_id, cap, now, tz })
    return finishHandoff({ reason: `cap:${cap}`, status: 'handed_off', fallback: !global, notify: !global })
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
  // the client's language (W4b X5): what their new texts are written in, else what the conversation was in (English by default)
  const freshClient = snap.lines.filter((l) => l.fresh && l.who === 'client').map((l) => l.text)
  const detected = detectLanguage(freshClient)
  const lang: ConvoLang = detected ?? (isConvoLang(claim.conv.language) ? claim.conv.language : 'en')
  if (detected) await storeLanguage(d.db, conv.id, detected)
  const loaded = await loadTurnContext(d.db, {
    resolved,
    conversationId: conv.id,
    refs: refRows,
    actionsEnabled,
    firstContact: snap.firstContact,
    now,
    tz,
  })
  // W4 final check L7: "no just book it" (any client text in the window) skips the memberships step and says not to pitch them
  const declinedPlans = loaded.membership === null && declinesPlans(snap.lines.filter((l) => l.who === 'client').map((l) => l.text))
  const turnContext = {
    ...loaded,
    // ... and so does a shop that sells no plan online (facts-v4: a tier without a price is not sold)
    ...((declinedPlans || facts.plans.length === 0) && loaded.intake === 'memberships' ? { intake: loaded.vehicles.length > 0 ? null : ('vehicle' as const) } : {}),
    language: lang,
    ...(asksForFree(freshClient) ? { asksFree: true } : {}),
    ...(declinedPlans ? { declinedPlans: true } : {}),
  }
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
  const deadlineAt = performance.now() + d.cfg.turnDeadlineMs
  const timer = setTimeout(() => deadline.abort(new TurnAbort('deadline')), d.cfg.turnDeadlineMs)
  timer.unref?.()
  // F3: one retry per call of a throttled or timed-out model or judge call, when the deadline leaves room (false: fail closed)
  let retries = 0
  const retryOnce = async (call: 'model' | 'judge', error: string): Promise<boolean> => {
    if (deadline.signal.aborted) return false
    const waitMs = Math.max(0, Math.round((d.retryBackoffMs ?? retryBackoffMs)()))
    if (deadlineAt - performance.now() < waitMs + RETRY_MIN_ROOM_MS) {
      transcript.add({ kind: 'retry', call, error, skipped: 'deadline' })
      d.log.warn({ conversation: conv.id, turn: turnId, call, error }, 'assistant call failed; no room left before the turn deadline to retry it')
      return false
    }
    retries += 1
    transcript.add({ kind: 'retry', call, error, waitMs })
    d.log.warn({ conversation: conv.id, turn: turnId, call, error, waitMs, retries }, 'assistant retries a throttled or timed-out call once')
    await new Promise<void>((resolve) => {
      const t = setTimeout(done, waitMs)
      function done(): void {
        clearTimeout(t)
        deadline.signal.removeEventListener('abort', done)
        resolve()
      }
      deadline.signal.addEventListener('abort', done, { once: true })
    })
    if (deadline.signal.aborted) throw new TurnAbort('deadline')
    return true
  }
  const links = new Map<string, string>()
  const linkKinds = new Set<string>()
  let toolHandoff: HandoffRequest | null = null
  let balanceCents: number | null = null
  let confirmTexted = false
  /** What the server did and returned in this turn's tool rounds, for the judge's server record (tool-runner.ts recordLine). */
  const toolRecord: string[] = []
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
    handoffRequested() {
      return toolHandoff !== null
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
    let res: AiConverseResponse
    for (let attempt = 0; ; attempt++) {
      if (deadline.signal.aborted) throw new TurnAbort('deadline')
      const callTimeout = AbortSignal.timeout(d.cfg.callTimeoutMs)
      const signal = AbortSignal.any([deadline.signal, callTimeout])
      try {
        res = await d.provider.converse(req, { signal })
        break
      } catch (e) {
        // the quota (throttled), a timeout (the provider's or this call's own; never the turn deadline) or an outage: retried once (F3)
        const kind = deadline.signal.aborted
          ? null
          : callTimeout.aborted
            ? 'timeout'
            : e instanceof AiProviderError && (e.kind === 'throttled' || e.kind === 'timeout' || e.kind === 'unavailable')
              ? e.kind
              : null
        if (kind === null || attempt > 0 || !(await retryOnce('model', `ai:${kind}`))) throw e
      }
    }
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
  // a link offered as a question ("Want me to text you a link to join?") is asked once; offered again in the next text it is sent
  const lastAiOffered = offersLink(snap.lines.filter((l) => l.who === 'ai').at(-1)?.text ?? '')
  /** W4 final check L7: text the model wrote in the same round as handoff_to_staff ("I can't confirm a free wash, but ..."). */
  let handoffText: string | null = null
  let linkNudged = false
  try {
    try {
      for (;;) {
        const final = rounds >= d.cfg.maxToolRounds
        const res = await call(request(final))
        messages.push(res.message)
        if (res.stopReason === 'tool_use') {
          const uses = res.message.content.filter((b): b is Extract<AiContentBlock, { type: 'toolUse' }> => b.type === 'toolUse')
          if (final || uses.length === 0) throw new TurnAbort('tool_use_after_reply_now')
          if (uses.some((u) => u.name === 'handoff_to_staff')) {
            const said = textOf(res.message).trim()
            if (said) handoffText = said
          }
          rounds += 1
          const r = await runToolRound({ db: d.db, newId: d.newId, nowMs }, { registry: d.registry, ctx, uses, round: rounds, seq, actionsEnabled })
          seq = r.seq
          if (r.balanceCents !== null) balanceCents = r.balanceCents
          if (r.confirmTexted) confirmTexted = true
          toolRecord.push(...r.record)
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
        // W4 final check L7 (pin-fishing offered a reset link twice and never sent it): a reply that offers a link no tool sent in
        // this turn goes back to the model ONCE, tools on: send it now or reply without offering it
        if (!final && !linkNudged && links.size === 0 && tools.some((t) => t.name === 'send_link') && (offersLink(text, { statement: true }) || (offersLink(text) && lastAiOffered))) {
          linkNudged = true
          messages.push({ role: 'user', content: [{ type: 'text', text: LINK_NUDGE_TEXT }] })
          transcript.add({ kind: 'message', message: messages[messages.length - 1]! })
          text = null
          continue
        }
        break
      }
    } catch (e) {
      const reason = e instanceof TurnAbort ? e.reason : failureOf(e)
      transcript.add({ kind: 'error', error: reason })
      return await finishHandoff({ reason: 'fallback', status: 'failed', fallback: true, error: reason, usage, model, rounds, stop })
    }
    // the loop ends without a text only after an opt-out
    if (optedOut || text === null) return await finishOptedOut({ usage, model, rounds, stop })
    if (handoffText) text = withHandoffText(handoffText, text)

    // ---- the output guard
    // what the placeholders render to (the current facts; {balance} only after get_balance; the links stay for composeReply)
    const values = placeholderValues(facts, { balanceCents, confirmTexted, lang })
    for (const p of links.keys()) values.set(p, p)
    // server-owned literals only (the address, catalog and plan names): the digit rules skip them. Client-entered text (a vehicle on
    // file, the name) is NEVER a literal and never trusted by the judge (fix 1 of the v4 re-check: a vehicle "Free Wash 2015550123")
    const literals = factLiterals(facts)
    // the client's own first name and vehicles are skipped by the secret request check only ("Thanks, Clave", "your Ford Focus")
    const names = [turnContext.firstName, ...turnContext.vehicles.map((v) => v.split(',')[0]), ...(turnContext.vehicleNames ?? [])]
    // a verify / PIN / membership / payment link: the server appends the safety line, so the reply leaves room for it
    const safety = [...linkKinds].some((k) => SAFETY_LINK_KINDS.has(k))
    // the client texted a card number: the server's CARD_LINE follows the reply (the model may write nothing about cards)
    const card =
      snap.inboxIds.length > 0 &&
      (await d.db.selectFrom('sms_inbox').select('body').where('id', 'in', snap.inboxIds).execute()).some(
        (r) => looksLikeCardNumber(r.body),
      )
    const safetyLine = SAFETY_LINES[lang]
    const cardLine = CARD_LINES[lang]
    const maxChars = MAX_REPLY_CHARS - (safety ? safetyLine.length + 1 : 0) - (card ? cardLine.length + 1 : 0)
    // W4b X3: what the server did since the assistant's last text (a reply number executed a booking, a move, a cancel): only then
    // may the reply say it is booked, moved, cancelled or "all set"; the judge reads the same record and the client's visits
    const executed = await executedSinceLastReply(d.db, { conversationId: conv.id, turnId, now, tz })
    const actionDone = executed.length > 0
    // W4 final check L1: the record covers the conversation, not only this turn (links texted earlier, a proposal still waiting,
    // what earlier turns saved and returned, the verification): "use the link I sent earlier" is true when one was sent
    const earlier = await conversationRecord(d.db, { locationId: loc, conversationId: conv.id, turnId, phone: conv.phone_e164, now, tz })
    const verified = state.identity.trust === 'trusted'
    // a phone the server gives no times in the chat (check_availability returns the booking link instead)
    const noTimes = !(verified && actionsEnabled)
    const timesReturned = [...toolRecord, ...earlier.lines].some((l) => /open times for [^:]*: (?!none)/.test(l))
    const dayChecked = toolRecord.some((l) => l.startsWith('open times for ')) || earlier.availabilityChecked
    const judgeRecord = [
      `Done by the server since the assistant's last text: ${actionDone ? executed.join('; ') : 'nothing (nothing was booked, moved or cancelled)'}.`,
      ...(confirmTexted
        ? [
            'In this turn the server texted the client a proposal to confirm with its reply number: nothing is done until they confirm it.',
          ]
        : []),
      // guard polish after W4b-fix: the tool results of this turn (a saved vehicle is no false claim; open times only as returned)
      `What the server did and returned in this turn: ${toolRecord.length > 0 ? toolRecord.join('; ') : 'nothing'}.`,
      `Earlier in this conversation (last 24 hours): ${earlier.lines.length > 0 ? earlier.lines.join('; ') : 'nothing'}.`,
      `Links the server texted to this number in the last 24 hours: ${earlier.links.length > 0 ? earlier.links.join('; ') : 'none'}.`,
      `A proposal waiting for the client's reply number: ${earlier.pending ?? 'none'}.`,
      ...(timesReturned
        ? []
        : [
            noTimes
              ? 'Open times the server returned: none (this phone is given no times in the chat: no time may be named as open or available; a day or a part of a day only as this record says).'
              : 'Open times the server returned: none (no time may be named as open or available; a day only as this record says).',
          ]),
      verified
        ? `Verified phone: yes${state.identity.trustUntil ? `, until ${toBizDate(state.identity.trustUntil, tz)}` : ''}.`
        : 'Verified phone: no (the client has not verified this phone: never say they are verified).',
      `The client's name on file: ${turnContext.firstName ?? 'none'}.`,
      `Vehicles on file: ${turnContext.vehicles.length > 0 ? turnContext.vehicles.join('; ') : 'none'}.`,
      `The client's visits on file: ${turnContext.appointments.length > 0 ? turnContext.appointments.map((a) => a.label).join('; ') : 'none'}.`,
      // the membership the model reads in its turn context ("Gold, active, 2 washes left this cycle"): a count from it is no invented fact
      `The client's membership: ${turnContext.membership ?? 'none'}.`,
    ].join('\n')
    let rewriteUsed = false
    let shortenUsed = false
    let judgeRewriteUsed = false
    let isolateUsed = false
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
        ...(safety
          ? [
              { text: ' ', trusted: false },
              { text: safetyLine, trusted: true },
            ]
          : []),
        ...(card
          ? [
              { text: ' ', trusted: false },
              { text: cardLine, trusted: true },
            ]
          : []),
      ]
      const run = () =>
        runJudge(d.judge, all, {
          timeoutMs: d.cfg.judge.timeoutMs,
          maxTokens: d.cfg.judge.maxTokens,
          signal: deadline.signal,
          nowMs,
          facts: factsText,
          record: judgeRecord,
        })
      let r = await run()
      judgeUsage = addUsage(judgeUsage, r.usage)
      let attempts = 1
      // throttled or timed out: one retry when the deadline leaves room (F3); a second error fails closed below
      if (r.outcome.kind === 'error' && RETRYABLE_JUDGE_ERRORS.has(r.outcome.error) && (await retryOnce('judge', r.outcome.error))) {
        attempts = 2
        r = await run()
        judgeUsage = addUsage(judgeUsage, r.usage)
      }
      const o = r.outcome
      const entry = {
        verdict: o.kind,
        model: r.model,
        latencyMs: r.latencyMs,
        ...(attempts > 1 ? { attempts } : {}),
        ...(r.shortened ? { shortened: true } : {}),
        ...(o.kind === 'error' ? { error: o.error } : { category: o.verdict.category, reason: o.verdict.reason }),
      }
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
          input: JSON.stringify({ model: r.model ?? d.cfg.judge.modelId, message: redactText(r.message), ...(attempts > 1 ? { attempts } : {}) }) as never,
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
    // the proposal's reply number went out in this turn but the model's words still fail: the client gets the server's own confirm
    // line alone (no model words left to check), never "a team member will text you back" after a good proposal (Bedrock: "{confirm}.
    // You're all set" and "{confirm}. See you Saturday at 9" both failed the judge, so the fallback followed the reply number)
    let confirmOnly = false
    const toConfirmOnly = (why: string): boolean => {
      if (!confirmTexted || confirmOnly) return false
      confirmOnly = true
      draft = `${CONFIRM_PLACEHOLDER}.`
      transcript.add({ kind: 'guard', verdict: 'confirm_only', problems: [why] })
      return true
    }
    // the reply as the model wrote it (placeholders in): the server's renderings it used are recorded with the reply (W4b X9)
    let replyRaw = ''
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
          // one rewrite for a claim that something was done when nothing was (a claim left after it is the judge's)
          checkActionClaims: !actionDone && !rewriteUsed,
          // W4 final check L6: an unverified phone's open times and "you're verified" (one rewrite; then the judge's)
          checkAvailabilityClaims: noTimes && !rewriteUsed ? { dayChecked } : null,
          ...(!verified && !rewriteUsed ? { phoneVerified: false } : {}),
        })
        transcript.add({ kind: 'guard', verdict: v.kind, ...(v.kind === 'fix' ? { problems: v.problems, ...(v.words.length > 0 ? { words: v.words } : {}) } : {}) })
        if (v.kind === 'ok') {
          if (!d.cfg.judge.enabled || confirmOnly) {
            reply = v.rendered
            replyRaw = v.text
            break
          }
          const j = await judge(v.segments)
          if (j.kind === 'pass') {
            reply = v.rendered
            replyRaw = v.text
            break
          }
          // fail closed: no verdict, no reply (the turn deadline is the turn's own timeout)
          if (j.kind === 'error') {
            if (deadline.signal.aborted) throw new TurnAbort('deadline')
            if (toConfirmOnly(`judge_error:${j.error}`)) continue
            return await finishHandoff({ reason: 'judge_error', status: 'handed_off', fallback: true, usage, model, rounds, stop, error: `judge:${j.error}` })
          }
          if (judgeRewriteUsed && toConfirmOnly(`judge:${j.verdict.category}`)) continue
          if (judgeRewriteUsed)
            return await finishHandoff({ reason: 'policy_judge', status: 'handed_off', fallback: true, usage, model, rounds, stop, error: `judge:${j.verdict.category}` })
          judgeRewriteUsed = true
          draft = await fix(v.text, [], [], judgeRewriteInstruction(v.text, JUDGE_HINTS[j.verdict.category]))
          continue
        }
        const hard = v.problems.filter((p) => HARD_PROBLEMS.has(p))
        if (
          hard.length > 0 ||
          ((v.problems.includes('questions') || v.problems.includes('action_claim') || v.problems.includes('unverified_claim')) && !rewriteUsed)
        ) {
          // the rewrite still trips only the placement rule: the server isolates the placeholders itself, once (each its own sentence)
          if (rewriteUsed && !isolateUsed && hard.length === 1 && hard[0] === 'placement') {
            isolateUsed = true
            draft = isolatePlaceholders(v.text, values)
            continue
          }
          // the rewrite still trips a rule: the fallback and a person ("guard"; promises are the judge's: "policy_judge")
          if (rewriteUsed && toConfirmOnly(`guard:${hard.join(',')}`)) continue
          if (rewriteUsed) {
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
    if (reply === null)
      return await finishHandoff({
        reason: 'guard',
        status: 'handed_off',
        fallback: true,
        usage,
        model,
        rounds,
        stop,
        error: 'guard:unresolved',
      })
    // W4b X8: the client texted a photo and the reply says the team will review it: a person is asked to (the AI cannot see it)
    if (snap.photo && TEAM_REVIEW.test(reply))
      toolHandoff ??= {
        reason: 'photo_quote',
        summary:
          'The client texted a photo; the assistant told them the team will review it. Look at the photo in Messages and reply.',
      }
    // guard polish after W4b-fix (P5): a text that hands the chat to the team never ends with a question; the assistant goes silent
    // after it, so a question would never be answered ("Someone will text you back shortly! What's your first name?")
    if (toolHandoff && reply.includes('?')) {
      const kept = withoutQuestions(reply)
      transcript.add({ kind: 'guard', verdict: 'handoff_no_question', problems: ['questions'] })
      reply = kept ?? FALLBACK_TEXTS[lang]
    }
    const rendered = [...values.entries()]
      .filter(([k]) => !k.startsWith('{link') && replyRaw.includes(k))
      .map(([, v]) => v)

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
      const composed = composeReply({
        text: reply,
        disclose: c.disclosed_at === null,
        links,
        safety,
        card,
        lang,
      })
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
      transcript.add({
        kind: 'reply',
        text: composed.text,
        klass: composed.klass,
        ...(rendered.length > 0 ? { rendered } : {}),
      })
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

/** A shop-wide cap (or the budget) tells the managers once per cap window: the hourly cap once an hour, the others once a business day. */
async function notifyCapOnce(d: TurnDeps, o: { locationId: string; cap: CapKind; now: Date; tz: string }): Promise<void> {
  const window = o.cap === 'global_hour' ? new Date(Math.floor(o.now.getTime() / 3600_000) * 3600_000).toISOString() : toBizDate(o.now, o.tz)
  const sourceRef = `assistant_cap:${o.cap}:${window}`
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

/** A reply that tells the client the team will look at what they sent (W4b X8: a photo then opens a handoff). */
const TEAM_REVIEW =
  /\b(?:team|staff|someone|a person|technician|we(?:'ll| will))\b[^.!?]{0,60}\b(?:review|look|check|see|get back|text you|quote|estimate)|\b(?:equipo|alguien)\b[^.!?]{0,60}\b(?:revis|mira|cotiz|te escrib|te contact)/i

/**
 * W4b X3: the in-chat actions the server executed for this conversation since the assistant's last reply (a reply number booked,
 * moved or cancelled a visit), in words: "booked: Signature Hand Wash, Mon Jun 15 at 10:00 AM". Before the first reply: the last day.
 */
export async function executedSinceLastReply(
  db: Db,
  o: { conversationId: string; turnId: string; now: Date; tz: string },
): Promise<string[]> {
  const last = await db
    .selectFrom('assistant_turns')
    .select((eb) => eb.fn.max('finished_at').as('at'))
    .where('conversation_id', '=', o.conversationId)
    .where('status', '=', 'replied')
    .where('id', '!=', o.turnId)
    .executeTakeFirst()
  const since = last?.at ?? new Date(o.now.getTime() - 86_400_000)
  const rows = await db
    .selectFrom('assistant_pending_actions')
    .select(['kind', 'payload'])
    .where('conversation_id', '=', o.conversationId)
    .where('state', '=', 'executed')
    .where('resolved_at', '>', since)
    .orderBy('resolved_at')
    .execute()
  const today = toBizDate(o.now, o.tz)
  return rows.map((r) => {
    const p = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as {
      serviceName?: string
      date?: string
      startMin?: number
    }
    const when = p.date && typeof p.startMin === 'number' ? `, ${whenWords(p.date, p.startMin, today)}` : ''
    const what = r.kind === 'book' ? 'booked' : r.kind === 'reschedule' ? 'moved' : 'cancelled'
    return `${what}: ${p.serviceName ?? 'a visit'}${when}`
  })
}

/** W4 final check L7: what the model is told when its reply offers a link that no tool sent in this turn. */
export const LINK_NUDGE_TEXT =
  'Your reply offers a link but none was sent in this turn. If the link helps, call send_link now (kind pin for a PIN reset, calendar to book, verify to book by text) and write your reply with its placeholder; otherwise write the reply again without offering a link.'

/** A reply that offers to send a link ("I can send you a link to set a new one", "Want me to text you the booking link?"). */
const OFFERS_LINK =
  /\b(?:i\s+can|i\s+could|i'?ll|i\s+will|i\s+would|want\s+me\s+to|shall\s+i|should\s+i|would\s+you\s+like(?:\s+me\s+to)?|let\s+me|happy\s+to|glad\s+to)\s+(?:send|text|get)\b[^.!?]{0,40}\blinks?\b|\b(?:would\s+you\s+like|do\s+you\s+want|want)\s+(?:a|the|another|your)\s+(?:\w+\s+){0,2}links?\b|\b(?:te\s+)?(?:puedo|quieres\s+que\s+te)\s+(?:enviar|mandar|envie|mande)\b[^.!?]{0,30}\benlace\b/i

/**
 * Whether the text offers to send a link; `statement`: only an offer that is not a question ("I can send you a link to set a new
 * one", not "Want me to text you a link to join?", which may wait for the client's yes once).
 */
export function offersLink(text: string, o: { statement?: boolean } = {}): boolean {
  const t = text.normalize('NFD').replace(/\p{M}/gu, '').replace(/[’‘]/g, "'")
  if (!o.statement) return OFFERS_LINK.test(t)
  return sentencesOf(t).some((s) => !s.trim().endsWith('?') && OFFERS_LINK.test(s))
}

/**
 * W4 final check L7 (inject-you-are-now): the text written in the same round as handoff_to_staff ("I can't confirm a free wash, but
 * a team member will text you back shortly.") goes out ahead of the final round's text; a sentence of the final text it already holds,
 * or a second "a team member will text you back", is dropped.
 */
export function withHandoffText(before: string, after: string): string {
  const norm = (x: string): string => x.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim()
  const b = norm(before)
  // "a team member will text you back / reach out / give you a call", "someone will be in touch", "el equipo te escribirá"
  const TEAM =
    /\b(?:team\s+member|someone|somebody|staff|a\s+person|the\s+team|our\s+team|equipo|alguien)\b[^.!?]{0,40}\b(?:will|'ll|is\s+going\s+to|te\s+(?:escribir|contactar|llamar|respond))|\b(?:text\s+you\s+back|will\s+text\s+you|reach\s+out|get\s+back\s+to\s+you|give\s+you\s+a\s+call|call\s+you\s+(?:back|shortly|soon)|be\s+in\s+touch|te\s+escribir|te\s+contactar|te\s+llamar)/i
  const kept = sentencesOf(after.trim()).filter((x) => {
    const n = norm(x)
    return n !== '' && !b.includes(n) && !(TEAM.test(x) && TEAM.test(before))
  })
  return [before.trim(), ...kept].join(' ').trim()
}

/**
 * W4 final check L1: the conversation part of the judge's server record. `links`: what the server texted to this number in the last
 * 24 hours (client_links: kind and when, whoever sent it); `pending`: a proposal still waiting for its reply number; `lines`: what
 * earlier turns of this conversation (24 hours) saved and the open times they got (tool-runner.ts recordLine over the stored
 * results); `availabilityChecked`: check_availability answered in an earlier turn.
 */
export async function conversationRecord(
  db: Db,
  o: { locationId: string; conversationId: string; turnId: string; phone: string; now: Date; tz: string },
): Promise<{ links: string[]; pending: string | null; lines: string[]; availabilityChecked: boolean }> {
  const since = new Date(o.now.getTime() - 86_400_000)
  const when = (at: Date): string => `${DAY_ABBR[bizWeekday(toBizDate(at, o.tz))]} ${clockLabel(at, o.tz)}`
  const linkRows = await db
    .selectFrom('client_links')
    .select(['kind', 'created_at'])
    .where('location_id', '=', o.locationId)
    .where('phone_e164', '=', o.phone)
    .where('created_at', '>', since)
    .where('created_at', '<=', o.now)
    .orderBy('created_at')
    .execute()
  const links = linkRows.map((l) => `a ${l.kind === 'book_again' ? 'book-again' : l.kind} link (${when(l.created_at)})`)
  const pendingRow = await db
    .selectFrom('assistant_pending_actions')
    .select(['kind', 'payload'])
    .where('conversation_id', '=', o.conversationId)
    .where('state', '=', 'pending')
    .where('expires_at', '>', o.now)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  let pending: string | null = null
  if (pendingRow) {
    const p = (typeof pendingRow.payload === 'string' ? JSON.parse(pendingRow.payload) : pendingRow.payload) as { serviceName?: string; date?: string; startMin?: number }
    const at = p.date && typeof p.startMin === 'number' ? `, ${whenWords(p.date, p.startMin, toBizDate(o.now, o.tz))}` : ''
    pending = `${pendingRow.kind === 'book' ? 'book' : pendingRow.kind === 'reschedule' ? 'move' : 'cancel'}: ${p.serviceName ?? 'a visit'}${at}`
  }
  const calls = await db
    .selectFrom('assistant_tool_calls as c')
    .innerJoin('assistant_turns as t', 't.id', 'c.turn_id')
    .select(['c.tool', 'c.output', 't.started_at'])
    .where('t.conversation_id', '=', o.conversationId)
    .where('t.id', '!=', o.turnId)
    .where('t.started_at', '>', since)
    .where('c.outcome', '=', 'ok')
    .where('c.tool', 'in', ['set_my_name', 'set_my_vehicle', 'check_availability'])
    .orderBy('t.started_at')
    .orderBy('c.seq')
    .execute()
  const lines: string[] = []
  let availabilityChecked = false
  for (const c of calls) {
    const out = (typeof c.output === 'string' ? JSON.parse(c.output) : c.output) as Record<string, unknown> | null
    if (!out || out.ok !== true) continue
    const data = Object.fromEntries(Object.entries(out).filter(([k]) => k !== 'ok'))
    const line = recordLine(c.tool, { ok: true, data } as ToolOutcome)
    if (!line) continue
    if (c.tool === 'check_availability') availabilityChecked = true
    const entry = `${line} (${when(c.started_at)})`
    if (!lines.includes(entry)) lines.push(entry)
  }
  return { links, pending, lines: lines.slice(-8), availabilityChecked }
}
