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
// ADR 0174 §4a: the Converse loop, the output guard and the policy judge are the ENGINE (engine.ts, shared with practice); this file
// keeps what only a live turn does: the gate, the caps, the claim, the context, the live tool context and every write.
import { sql } from 'kysely'
import type { Env } from '../../config/env.js'
import { addUsage, aiCostMicros } from '../../integrations/ai/cost.js'
import type { AiMessage, AiProvider, AiUsage } from '../../integrations/ports/ai.js'
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
import { AI_ACTOR_NAME, type AssistantLog, type AssistantQueue, type ShopFactsSource, type ToolContext, type ToolOutcome, type ToolRegistry, type TurnIdentity } from './contract.js'
import type { AssistantConfig } from './config.js'
import { appointmentRefs, loadAppointmentRefs, loadConversation, loadTurnContext, resolveIdentity } from './context.js'
import { runEngine, TurnAbort, ZERO_USAGE, type ConversationRecord, type EngineResult } from './engine.js'
import { looksLikeCardNumber, toGsm7 } from './guard.js'
import { CARD_LINES, detectLanguage, isConvoLang, SAFETY_LINES, SPANISH_HANDOFF_TEXT, storeLanguage, withDisclosure, type ConvoLang } from './lang.js'
import { whenWords } from './tools/common.js'
import { liveToolEffects } from './tools/effects-live.js'
import { HANDOFF_SUMMARIES, markUnanswered, openTurnHandoff, recipientOf, sendFallback, type ConversationRef, type HandoffDeps } from './handoff.js'
import type { AssistantGate, AssistantInbox } from './ports.js'
import { loadPolicy } from './policy.js'
import { PROMPT_VERSION, renderConversation } from './prompt.js'
import { liveRecorder, NON_PROGRESS_TOOLS, recordLine } from './tool-runner.js'
import { buildTurnPrompt } from './turn-prompt.js'
import { Transcript } from './transcript.js'
import { TurnLinks } from './turn-links.js'
import './schema.js'
import '../messaging/schema.js'

// moved to engine.ts (ADR 0174 §4a); re-exported for the callers and tests that import them from here
export { LINK_NUDGE_TEXT, offersLink, RETRY_BACKOFF_MAX_MS, RETRY_BACKOFF_MIN_MS, RETRY_MIN_ROOM_MS, retryBackoffMs, withHandoffText } from './engine.js'

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
  /** ADR 0174 §3b: the owner's sign-off, appended by the server after everything else of the reply (the judge never read it). */
  signOff?: string
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
  const signOff = o.signOff ? toGsm7(o.signOff.replace(/\s+/g, ' ').trim()) : ''
  if (signOff) reply = `${reply} ${signOff}`
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
  // ADR 0174 §3b: the owner's limits and tone (the defaults are today's behaviour)
  const policy = await loadPolicy(d.db, loc, actionsEnabled)
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
  const clientLang: ConvoLang = detected ?? (isConvoLang(claim.conv.language) ? claim.conv.language : 'en')
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
  // ADR 0174 §4c: the request is assembled by the code practice uses too (turn-prompt.ts), so both send the same bytes
  const prompt = buildTurnPrompt({
    facts,
    loaded,
    policy,
    registry: d.registry,
    freshClientTexts: freshClient,
    allClientTexts: snap.lines.filter((l) => l.who === 'client').map((l) => l.text),
    clientLang,
  })
  const { lang, spanishHandoff, turnContext, contextText, knowledgeText, factsText, tools, specs, system } = prompt
  transcript.add(prompt.systemEntry)
  transcript.add({ kind: 'context', text: contextText })
  const messages: AiMessage[] = [{ role: 'user', content: [{ type: 'text', text: renderConversation(snap.lines) }] }]
  transcript.add({ kind: 'message', message: messages[0]! })

  // ---- the tool context
  const deadline = new AbortController()
  const deadlineAt = performance.now() + d.cfg.turnDeadlineMs
  const timer = setTimeout(() => deadline.abort(new TurnAbort('deadline')), d.cfg.turnDeadlineMs)
  timer.unref?.()
  const links = new TurnLinks()
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
      return links.add(url, link)
    },
    handoff(reason, summary) {
      links.handoff(reason, summary)
    },
    handoffRequested() {
      return links.requested()
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
    // ADR 0174 §4b: the tools write through the live effects, and their own words follow the language this turn answers in
    effects: liveToolEffects,
    lang,
    // ADR 0174 §3b: the owner's limits, checked again by the tools
    policy: policy.tools,
  }
  // read once the tool rounds are done (a tool of this turn may change them): a card number in the new texts, the reply numbers
  // executed since the last reply (W4b X3), the conversation's record (W4 final check L1)
  const afterTools = async () => {
    const card =
      snap.inboxIds.length > 0 &&
      (await d.db.selectFrom('sms_inbox').select('body').where('id', 'in', snap.inboxIds).execute()).some((x) => looksLikeCardNumber(x.body))
    const executed = await executedSinceLastReply(d.db, { conversationId: conv.id, turnId, now, tz })
    const earlier = await conversationRecord(d.db, { locationId: loc, conversationId: conv.id, turnId, phone: conv.phone_e164, now, tz })
    return { card, executed, earlier }
  }

  try {
    // ---- the engine (engine.ts): the Converse loop, the output guard and the policy judge; it writes nothing but the call rows
    // (ADR 0174 §3b: a Spanish text while the owner hands Spanish chats to the team gets the server's fixed line, no model call)
    const r: EngineResult = spanishHandoff
      ? await spanishHandoffReply(transcript, afterTools)
      : await runEngine(
      {
        cfg: d.cfg,
        provider: d.provider,
        judge: d.judge,
        registry: d.registry,
        log: d.log,
        recordCall: liveRecorder(d.db, d.newId, turnId),
        nowMs,
        retryBackoffMs: d.retryBackoffMs,
      },
      {
        conversationId: conv.id,
        turnId,
        tz,
        system,
        tools,
        specs,
        factsText,
        knowledgeText,
        messages,
        ctx,
        links,
        facts,
        lang,
        actionsEnabled,
        turnContext,
        lastAiText: snap.lines.filter((l) => l.who === 'ai').at(-1)?.text ?? '',
        photo: snap.photo,
        signal: deadline.signal,
        deadlineAt,
        transcript,
        afterTools,
        policy,
        freshClientTexts: freshClient,
      },
    )
    judgeUsage = r.judgeUsage
    const { usage, model, rounds, stop } = r
    if (r.kind === 'handoff') return await finishHandoff({ reason: r.reason, status: r.status, fallback: true, error: r.error, usage, model, rounds, stop })
    if (r.kind === 'opted_out') return await finishOptedOut({ usage, model, rounds, stop })
    const { reply, rendered, safety, card } = r
    const toolHandoff = r.handoff

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
        links: links.map,
        safety,
        card,
        lang,
        signOff: r.kind === 'reply' && r.handoff?.reason !== 'language' ? policy.behavior.signOff : '',
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

/**
 * ADR 0174 §3b, Spanish "handoff": the server's fixed Spanish line (the disclosure on a first text, the card line when the texts
 * held a card number) and a handoff (reason `language`), as a reply of the engine's shape. No model or judge call: no cost.
 */
async function spanishHandoffReply(transcript: Transcript, afterTools: () => Promise<{ card: boolean }>): Promise<EngineResult> {
  const { card } = await afterTools()
  transcript.add({ kind: 'guard', verdict: 'spanish_handoff' })
  return {
    kind: 'reply',
    reply: SPANISH_HANDOFF_TEXT,
    replyRaw: SPANISH_HANDOFF_TEXT,
    rendered: [],
    safety: false,
    card,
    handoff: { reason: 'language', summary: HANDOFF_SUMMARIES.language! },
    usage: ZERO_USAGE,
    judgeUsage: ZERO_USAGE,
    model: null,
    rounds: 0,
    stop: null,
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

/**
 * W4 final check L1: the conversation part of the judge's server record. `links`: what the server texted to this number in the last
 * 24 hours (client_links: kind and when, whoever sent it); `pending`: a proposal still waiting for its reply number; `lines`: what
 * earlier turns of this conversation (24 hours) saved and the open times they got (tool-runner.ts recordLine over the stored
 * results); `availabilityChecked`: check_availability answered in an earlier turn.
 */
export async function conversationRecord(
  db: Db,
  o: { locationId: string; conversationId: string; turnId: string; phone: string; now: Date; tz: string },
): Promise<ConversationRecord> {
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
