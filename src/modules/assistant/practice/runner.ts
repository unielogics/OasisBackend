// One practice turn (ADR 0174 §4c, design k-design-assistant.md §4c): the real pipeline minus its side effects. The same engine
// (engine.ts), the same request assembly as the live turn (turn-prompt.ts: rules, owner block, SHOP KNOWLEDGE, SHOP FACTS, the turn
// context, the tools the owner's limits offer), the same guard, and the policy judge FORCED ON (AI_GUARD_JUDGE ?? true: the live
// judge defaults to AI_ENABLED, off in production, and practice must show only answers the live assistant would send). It works
// whatever AI_ENABLED says. Isolation, in layers:
//   - the tools' writes go through the practice effects (practice/effects.ts): only the session's state changes;
//   - the tools read through a READ-ONLY database pool (platform/db.ts readOnly): a write the effects missed fails in Postgres and
//     the runner turns it into an `unavailable` tool result;
//   - the tool context's queue and setCustomer throw, its audit does nothing, its scheduling ports refuse;
//   - nothing of the live turn's gate, caps, claim, welcome flow or reply runs.
// Personas: a synthetic new texter (an id and a fictional 555-01xx number that are not in the database: every read returns what a
// brand-new provisional client has, the session state overlays what the effects saved) or a real client on file, read-only (needs
// cli.view at the route), verified or not as the owner picks. The history is the session's own turns, never the client's texts.
import type { Env } from '../../../config/env.js'
import { addUsage, aiCostMicros } from '../../../integrations/ai/cost.js'
import type { AiMessage, AiProvider, AiUsage } from '../../../integrations/ports/ai.js'
import type { Clock } from '../../../platform/clock.js'
import { transaction, type Db } from '../../../platform/db.js'
import type { NewId } from '../../../platform/ids.js'
import * as realtime from '../../../platform/realtime.js'
import { getSetting } from '../../../platform/settings.js'
import { dateLabel, toBizDate } from '../../../platform/time.js'
import { renderTemplate } from '../../messaging/templates/render.js'
import { assistantConfig, type AssistantConfig } from '../config.js'
import {
  appointmentRefs,
  historyWhen,
  loadAppointmentRefs,
  loadTurnContext,
  maskForModel,
  nowLabelOf,
  PROVISIONAL_NAME,
  vehicleLine,
  vehicleLiterals,
  type AppointmentRefRow,
} from '../context.js'
import type { AssistantLog, ShopFacts, ShopFactsSource, ToolContext, ToolRegistry, TurnIdentity } from '../contract.js'
import { runEngine, TurnAbort, ZERO_USAGE, type EngineResult } from '../engine.js'
import { looksLikeCardNumber } from '../guard.js'
import { HANDOFF_SUMMARIES } from '../handoff.js'
import { knowledgeOrder, type ShopKnowledgeEntry } from '../knowledge/render.js'
import { detectLanguage, FALLBACK_TEXTS, serverTextEs, SPANISH_HANDOFF_TEXT, type ConvoLang } from '../lang.js'
import { loadPolicy } from '../policy.js'
import { nextIntakeStep, renderConversation, type HistoryLine, type IntakeStep, type TurnContextData } from '../prompt.js'
import { assistantActor } from '../runtime.js'
import { recordLine, type ToolCallRecord } from '../tool-runner.js'
import { redactJson, redactText, Transcript } from '../transcript.js'
import { composeReply } from '../turn.js'
import { TurnLinks } from '../turn-links.js'
import { buildTurnPrompt } from '../turn-prompt.js'
import { parsePracticeState, practiceEffects, type PracticeSink, type PracticeState } from './effects.js'
import type { PracticeTurnStatus } from './schema.js'
import '../schema.js'
import '../knowledge/schema.js'
import './schema.js'

export const AI_PRACTICE_JOB = 'ai.practice'

export interface PracticeDeps {
  /** The pool: the practice tables, the settings, the facts. */
  db: Db
  /** READ-ONLY pool: everything the tools read (platform/db.ts readOnly). */
  readDb: Db
  clock: Clock
  newId: NewId
  env: Env
  /** The assistant's numbers with the judge forced on (practiceConfig). */
  cfg: AssistantConfig
  provider: AiProvider
  judge: AiProvider
  registry: ToolRegistry
  facts: ShopFactsSource
  log: AssistantLog
  nowMs?: () => number
  retryBackoffMs?: () => number
}

/** The assistant's config for practice: the policy judge always on unless AI_GUARD_JUDGE says otherwise. */
export function practiceConfig(env: Env, base: AssistantConfig = assistantConfig(env)): AssistantConfig {
  return { ...base, judge: { ...base.judge, enabled: env.AI_GUARD_JUDGE ?? true } }
}

export interface PracticeBadge {
  kind: 'rewritten' | 'shortened' | 'policy_rewrite' | 'handed_off' | 'fallback' | 'link' | 'proposal' | 'opted_out' | 'looked_up'
  label: string
}

const HANDOFF_WORDS: Record<string, string> = {
  client_asked: 'asked for a person',
  upset: 'the client is upset',
  cannot_help: 'Oasis AI could not help',
  policy: 'a topic for the team',
  late_cancel: 'a late cancellation',
  no_payment_link: 'no payment link yet',
  photo_quote: 'a photo to look at',
  language: 'a Spanish chat (your setting)',
  fallback: 'Oasis AI could not answer',
  guard: 'the answer did not pass the safety checks',
  policy_judge: 'the answer did not pass the policy check',
  judge_error: 'the policy check did not respond',
}

const LOOKED_UP: Record<string, string> = {
  check_availability: 'Looked up: open times',
  list_services: 'Looked up: services',
  get_balance: 'Looked up: balance',
  list_my_appointments: 'Looked up: visits',
  get_membership_info: 'Looked up: memberships',
  get_business_info: 'Looked up: shop info',
}

const LINK_BADGES: Record<string, string> = {
  calendar: 'Booking link',
  verify: 'Verify link',
  pin: 'PIN link',
  membership: 'Membership link',
  pay: 'Payment link',
}

/** A refusing stand-in: practice must never reach it (the queue, the scheduling ports). */
function refusing<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      if (prop === 'then') return undefined
      return () => {
        throw new Error(`practice: ${what} is not available`)
      }
    },
  })
}

interface TurnRow {
  id: string
  session_id: string
  seq: number
  rerun_of: string | null
  client_text: string
  status: PracticeTurnStatus
  reply_text: string | null
  extra_texts: unknown
  state_before: unknown
  started_at: Date
  finished_at: Date | null
}

/**
 * Answers one running practice turn (job ai.practice). Never throws for the model's failures (they show as the fallback); a broken
 * turn is stored as failed. Returns the turn's status, or null when there was nothing to run.
 */
export async function runPracticeTurn(d: PracticeDeps, turnId: string): Promise<PracticeTurnStatus | null> {
  const turn = (await d.db
    .selectFrom('assistant_practice_turns')
    .select(['id', 'session_id', 'seq', 'rerun_of', 'client_text', 'status', 'reply_text', 'extra_texts', 'state_before', 'started_at', 'finished_at'])
    .where('id', '=', turnId)
    .executeTakeFirst()) as TurnRow | undefined
  if (!turn || turn.status !== 'running') return null
  try {
    return await answer(d, turn)
  } catch (e) {
    d.log.error({ turn: turnId, err: (e as Error)?.name ?? 'Error' }, 'practice turn failed')
    await finish(d, turn, { status: 'failed', error: `error:${(e as Error)?.name ?? 'Error'}`.slice(0, 200) })
    return 'failed'
  }
}

async function answer(d: PracticeDeps, turn: TurnRow): Promise<PracticeTurnStatus> {
  const nowMs = d.nowMs ?? (() => performance.now())
  const began = nowMs()
  const session = await d.db.selectFrom('assistant_practice_sessions').selectAll().where('id', '=', turn.session_id).executeTakeFirstOrThrow()
  const loc = session.location_id
  const tz = d.env.BUSINESS_TZ
  const now = d.clock.now()
  const state = parsePracticeState(turn.state_before)
  const earlier = (await d.db
    .selectFrom('assistant_practice_turns')
    .select(['id', 'session_id', 'seq', 'rerun_of', 'client_text', 'status', 'reply_text', 'extra_texts', 'state_before', 'started_at', 'finished_at'])
    .where('session_id', '=', session.id)
    .where('rerun_of', 'is', null)
    .where('seq', '<', turn.seq)
    .where('status', '!=', 'running')
    .orderBy('seq')
    .execute()) as TurnRow[]

  // ---- who is texting
  const verified = session.verified
  const trustUntil = verified ? new Date(now.getTime() + 30 * 86_400_000) : null
  let identity: TurnIdentity
  let refRows: AppointmentRefRow[] = []
  let vehiclesOnFile = 0
  let namedOnFile = false
  let fullName: string | null = null
  if (session.persona === 'client' && session.customer_id) {
    const c = await d.readDb.selectFrom('customers').select(['id', 'full_name', 'phone_e164', 'needs_details']).where('id', '=', session.customer_id).executeTakeFirst()
    if (!c) return finish(d, turn, { status: 'failed', error: 'client_gone' })
    const provisional = c.needs_details && PROVISIONAL_NAME.test(c.full_name)
    identity = {
      locationId: loc,
      phone: c.phone_e164 ?? state.persona?.phone ?? '+12015550100',
      customerId: c.id,
      provisional,
      trust: verified ? 'trusted' : 'caller',
      trustUntil,
    }
    fullName = provisional ? null : c.full_name
    namedOnFile = !provisional
    refRows = await loadAppointmentRefs(d.readDb, { locationId: loc, customerId: c.id, now })
    vehiclesOnFile = (await d.readDb.selectFrom('vehicles').select('id').where('customer_id', '=', c.id).where('deleted_at', 'is', null).execute()).length
  } else {
    const persona = state.persona!
    identity = { locationId: loc, phone: persona.phone, customerId: persona.customerId, provisional: true, trust: verified ? 'trusted' : 'caller', trustUntil }
  }

  // ---- the settings practice mirrors: the in-chat actions (AI_ACTIONS_ENABLED and the setting), the owner's limits and tone
  const actionsEnabled = d.cfg.actionsEnabled && (await getSetting(d.db, loc, 'assistant.actions_enabled')).value
  const policy = await loadPolicy(d.db, loc, actionsEnabled)
  const facts = await withDrafts(d, await d.facts.get(loc), loc, session.include_entry_ids)

  // ---- the client's language: their new text, else what the session's texts showed, else the session's
  const fresh = [turn.client_text]
  const detected = detectLanguage(fresh)
  if (detected) state.lang = detected
  const clientLang: ConvoLang = detected ?? state.lang ?? session.language

  // ---- the turn context
  const firstName = state.name ? (state.name.trim().split(/\s+/)[0] ?? null) : null
  const savedVehicles = state.vehicles.map((v) => vehicleLine({ year: v.year, make: v.make, model: v.model, color: v.color, vehicle_class: v.size }))
  const savedNames = state.vehicles.flatMap((v) => vehicleLiterals(v))
  let loaded: TurnContextData
  if (session.persona === 'client') {
    const base = await loadTurnContext(d.readDb, {
      resolved: { identity, threadCustomerId: identity.customerId, fullName },
      conversationId: session.id,
      refs: refRows,
      actionsEnabled,
      firstContact: false,
      now,
      tz,
    })
    const vehicles = [...base.vehicles, ...savedVehicles].slice(0, 3)
    loaded = {
      ...base,
      ...(firstName && !base.firstName ? { firstName } : {}),
      vehicles,
      vehicleNames: [...(base.vehicleNames ?? []), ...savedNames],
      intake: overlayIntake(base.intake, { nameKnown: (firstName ?? base.firstName) !== null, state, vehicleKnown: vehicles.length > 0 }),
    }
  } else {
    loaded = {
      nowLabel: nowLabelOf(now, tz),
      firstName,
      unknownNumber: false,
      firstContact: earlier.length === 0,
      trusted: verified,
      trustUntilLabel: trustUntil ? dateLabel(trustUntil, tz) : null,
      actionsEnabled,
      membership: null,
      vehicles: savedVehicles.slice(0, 3),
      vehicleNames: savedNames,
      appointments: [],
      intake: nextIntakeStep({
        newClient: true,
        nameKnown: firstName !== null,
        intentKnown: state.interests.length > 0,
        membershipsPresented: state.membershipsShown,
        vehicleKnown: state.vehicles.length > 0,
      }),
    }
  }
  const prompt = buildTurnPrompt({
    facts,
    loaded,
    policy,
    registry: d.registry,
    freshClientTexts: fresh,
    allClientTexts: [...earlier.map((t) => t.client_text), turn.client_text],
    clientLang,
  })
  const lang = prompt.lang

  // ---- the conversation: the session's own earlier turns (the texts the client got), then this text
  const lines: HistoryLine[] = []
  for (const t of earlier) {
    lines.push({ at: t.started_at, when: historyWhen(t.started_at, tz), who: 'client', text: maskForModel(t.client_text), fresh: false })
    const at = t.finished_at ?? t.started_at
    for (const x of jsonList(t.extra_texts)) lines.push({ at, when: historyWhen(at, tz), who: 'ai', text: maskForModel(x.replace(/####/g, '[code]')), fresh: false })
    if (t.reply_text) lines.push({ at, when: historyWhen(at, tz), who: 'ai', text: maskForModel(t.reply_text), fresh: false })
  }
  const history = [
    ...lines.slice(-(d.cfg.historyLimit - 1)),
    { at: turn.started_at, when: historyWhen(turn.started_at, tz), who: 'client' as const, text: maskForModel(turn.client_text), fresh: true },
  ]
  const transcript = new Transcript()
  transcript.add(prompt.systemEntry)
  transcript.add({ kind: 'context', text: prompt.contextText })
  const messages: AiMessage[] = [{ role: 'user', content: [{ type: 'text', text: renderConversation(history) }] }]
  transcript.add({ kind: 'message', message: messages[0]! })

  // ---- the tool context: practice effects, the read-only pool, nothing that sends or writes
  const links = new TurnLinks()
  const sink: PracticeSink = { state, extraTexts: [], seq: turn.seq, vehiclesOnFile, namedOnFile }
  const deadline = new AbortController()
  const deadlineAt = performance.now() + d.cfg.turnDeadlineMs
  const timer = setTimeout(() => deadline.abort(new TurnAbort('deadline')), d.cfg.turnDeadlineMs)
  timer.unref?.()
  const ctx: ToolContext = {
    db: d.readDb,
    clock: d.clock,
    now,
    newId: d.newId,
    env: d.env,
    identity,
    conversationId: session.id,
    turnId: turn.id,
    facts,
    refs: appointmentRefs(refRows),
    actionsEnabled,
    scheduling: { clock: d.clock, newId: d.newId, locationId: loc, tz, ports: refusing('the scheduling ports') },
    actor: assistantActor(loc),
    queue: refusing('the message queue'),
    log: d.log,
    signal: deadline.signal,
    addLink: (url, link) => links.add(url, link),
    handoff: (reason, summary) => links.handoff(reason, summary),
    handoffRequested: () => links.requested(),
    audit: async () => undefined,
    setCustomer: async () => {
      throw new Error('practice: setCustomer is not available')
    },
    effects: practiceEffects(sink),
    lang,
    policy: policy.tools,
  }
  const calls: ToolCallRecord[] = []
  let r: EngineResult
  try {
    r = prompt.spanishHandoff
      ? spanishHandoff(transcript, turn.client_text)
      : await runEngine(
          {
            cfg: d.cfg,
            provider: d.provider,
            judge: d.judge,
            registry: d.registry,
            log: d.log,
            recordCall: async (row) => void calls.push(row),
            nowMs,
            ...(d.retryBackoffMs ? { retryBackoffMs: d.retryBackoffMs } : {}),
          },
          {
            conversationId: session.id,
            turnId: turn.id,
            tz,
            system: prompt.system,
            tools: prompt.tools,
            specs: prompt.specs,
            factsText: prompt.factsText,
            knowledgeText: prompt.knowledgeText,
            messages,
            ctx,
            links,
            facts,
            lang,
            actionsEnabled,
            turnContext: prompt.turnContext,
            lastAiText: [...lines].reverse().find((l) => l.who === 'ai')?.text ?? '',
            photo: false,
            signal: deadline.signal,
            deadlineAt,
            transcript,
            afterTools: async () => ({ card: looksLikeCardNumber(turn.client_text), executed: [], earlier: practiceRecord(state, now, tz, turn.seq) }),
            policy,
            freshClientTexts: fresh,
          },
        )
  } finally {
    clearTimeout(timer)
  }

  // ---- what earlier turns' record will read: what this one saved and the open times it got
  for (const c of calls) {
    if (c.outcome !== 'ok') continue
    if (c.tool === 'get_membership_info') state.membershipsShown = true
    if (!['set_my_name', 'set_my_vehicle', 'check_availability'].includes(c.tool)) continue
    const out = (c.output ? JSON.parse(c.output) : null) as Record<string, unknown> | null
    if (!out || out.ok !== true) continue
    const line = recordLine(c.tool, { ok: true, data: Object.fromEntries(Object.entries(out).filter(([k]) => k !== 'ok')) } as never)
    if (!line) continue
    if (c.tool === 'check_availability') state.availabilityChecked = true
    const entry = `${line} (${historyWhen(now, tz).slice(1, -1)})`
    if (!state.lines.includes(entry)) state.lines.push(entry)
  }
  state.lines = state.lines.slice(-8)

  // the live chat ends a proposal waiting for its reply number whenever a handoff opens (inbox.openHandoff): practice mirrors it
  if (r.kind === 'handoff' || (r.kind === 'reply' && r.handoff !== null)) state.pending = null

  // ---- the preview: what the client would get
  const badges = badgesOf(transcript, calls, links, sink, r)
  let status: PracticeTurnStatus
  let replyText: string | null = null
  const extraTexts = [...sink.extraTexts]
  if (r.kind === 'reply') {
    const composed = composeReply({
      text: r.reply,
      disclose: !state.disclosed,
      links: links.map,
      safety: r.safety,
      card: r.card,
      lang,
      signOff: r.handoff?.reason === 'language' ? '' : policy.behavior.signOff,
    })
    replyText = Object.entries(composed.secretVars ?? {}).reduce((t, [k, label]) => t.split(`{${k}}`).join(label), composed.text)
    state.disclosed = true
    status = 'replied'
  } else if (r.kind === 'handoff') {
    replyText = FALLBACK_TEXTS[lang]
    state.disclosed = true
    status = 'handed_off'
  } else {
    extraTexts.push(lang === 'es' ? (serverTextEs('opt_out_confirm') ?? renderTemplate('opt_out_confirm', {}).text) : renderTemplate('opt_out_confirm', {}).text)
    state.optedOut = true
    status = 'opted_out'
  }
  const usage = r.usage
  const cost = aiCostMicros(usage, d.cfg.prices) + aiCostMicros(r.judgeUsage, d.cfg.judge.prices)
  const all = addUsage(usage, r.judgeUsage)
  return finish(d, turn, {
    status,
    replyText,
    extraTexts,
    badges,
    error: r.kind === 'handoff' ? r.error : null,
    model: r.model,
    factsVersion: facts.version,
    usage: all,
    costMicros: cost,
    latencyMs: Math.max(0, Math.round(nowMs() - began)),
    transcript,
    calls,
    // a re-run is an alternate answer: the session's own state stays the main line's
    state: turn.rerun_of ? null : state,
  })
}

/** The facts with the session's drafts read as if they were on ("Try this draft"); the cached facts otherwise. */
async function withDrafts(d: PracticeDeps, facts: ShopFacts, locationId: string, ids: readonly string[]): Promise<ShopFacts> {
  if (ids.length === 0) return facts
  const rows = await d.db
    .selectFrom('assistant_knowledge')
    .select(['id', 'kind', 'title', 'body', 'question', 'sort', 'created_at'])
    .where('location_id', '=', locationId)
    .where('id', 'in', [...ids])
    .where('active', '=', false)
    .execute()
  if (rows.length === 0) return facts
  const drafts: ShopKnowledgeEntry[] = rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, question: r.question, sort: r.sort, createdAt: r.created_at.toISOString() }))
  return { ...facts, knowledge: { entries: [...(facts.knowledge?.entries ?? []), ...drafts].sort(knowledgeOrder) } }
}

const STEPS: readonly Exclude<IntakeStep, null>[] = ['name', 'intent', 'memberships', 'vehicle']

/** A client's intake step with what the session saved on top of what is on file. */
function overlayIntake(step: IntakeStep, o: { nameKnown: boolean; state: PracticeState; vehicleKnown: boolean }): IntakeStep {
  if (step === null) return null
  const at = STEPS.indexOf(step)
  return nextIntakeStep({
    newClient: true,
    nameKnown: o.nameKnown,
    intentKnown: o.state.interests.length > 0 || at > STEPS.indexOf('intent'),
    membershipsPresented: o.state.membershipsShown || at > STEPS.indexOf('memberships'),
    vehicleKnown: o.vehicleKnown,
  })
}

/** The conversation part of the judge's record (turn.ts conversationRecord) from the session's state. */
function practiceRecord(state: PracticeState, now: Date, tz: string, seq: number) {
  const since = now.getTime() - 86_400_000
  const links = state.links
    .filter((l) => Date.parse(l.at) > since && l.seq <= seq)
    .map((l) => `a ${l.kind} link (${historyWhen(new Date(l.at), tz).slice(1, -1)})`)
  const pending = state.pending ? `${state.pending.kind === 'book' ? 'book' : state.pending.kind === 'reschedule' ? 'move' : 'cancel'}: ${state.pending.summary}` : null
  return { links, pending, lines: state.lines.slice(-8), availabilityChecked: state.availabilityChecked }
}

/** Spanish "handoff" (ADR 0174 §3b): the server's fixed line and a handoff, no model call. */
function spanishHandoff(transcript: Transcript, text: string): EngineResult {
  transcript.add({ kind: 'guard', verdict: 'spanish_handoff' })
  return {
    kind: 'reply',
    reply: SPANISH_HANDOFF_TEXT,
    replyRaw: SPANISH_HANDOFF_TEXT,
    rendered: [],
    safety: false,
    card: looksLikeCardNumber(text),
    handoff: { reason: 'language', summary: HANDOFF_SUMMARIES.language! },
    usage: ZERO_USAGE,
    judgeUsage: ZERO_USAGE,
    model: null,
    rounds: 0,
    stop: null,
  }
}

/** The badges of a turn in plain words (what the guard, the judge and the tools did). */
function badgesOf(transcript: Transcript, calls: readonly ToolCallRecord[], links: TurnLinks, sink: PracticeSink, r: EngineResult): PracticeBadge[] {
  const out: PracticeBadge[] = []
  const add = (b: PracticeBadge): void => {
    if (!out.some((x) => x.kind === b.kind && x.label === b.label)) out.push(b)
  }
  for (const e of transcript.toJson() as Array<{ kind?: string; verdict?: string; problems?: string[] }>) {
    if (e.kind === 'guard' && e.verdict === 'fix' && (e.problems ?? []).some((p) => p !== 'too_long')) add({ kind: 'rewritten', label: 'Rewritten by the safety check' })
    if (e.kind === 'guard' && e.verdict === 'fix' && (e.problems ?? []).includes('too_long')) add({ kind: 'shortened', label: 'Shortened' })
    if (e.kind === 'guard' && (e.verdict === 'avoid_word_cut' || e.verdict === 'handoff_topic')) add({ kind: 'rewritten', label: e.verdict === 'handoff_topic' ? 'Your handoff topic: the team line was sent' : 'A word you avoid was taken out' })
    if (e.kind === 'judge' && e.verdict === 'fail') add({ kind: 'policy_rewrite', label: 'Rewritten after the policy check' })
  }
  for (const c of calls) if (c.outcome === 'ok' && LOOKED_UP[c.tool]) add({ kind: 'looked_up', label: LOOKED_UP[c.tool]! })
  for (const k of links.kindList()) add({ kind: 'link', label: LINK_BADGES[k] ?? 'Link' })
  if (sink.extraTexts.length > 0) add({ kind: 'proposal', label: 'Would text a confirmation number' })
  if (r.kind === 'handoff') {
    add({ kind: 'fallback', label: 'The fallback text: a team member will text back' })
    add({ kind: 'handed_off', label: `Handed to staff: ${HANDOFF_WORDS[r.reason] ?? r.reason}` })
  }
  if (r.kind === 'reply' && r.handoff) add({ kind: 'handed_off', label: `Handed to staff: ${HANDOFF_WORDS[r.handoff.reason] ?? r.handoff.reason}` })
  if (r.kind === 'opted_out') add({ kind: 'opted_out', label: 'Opted out: nothing more would be sent' })
  return out
}

const jsonList = (v: unknown): string[] => {
  const x = typeof v === 'string' ? (JSON.parse(v) as unknown) : v
  return Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []
}

interface Finish {
  status: PracticeTurnStatus
  replyText?: string | null
  extraTexts?: string[]
  badges?: PracticeBadge[]
  error?: string | null
  model?: string | null
  factsVersion?: string
  usage?: AiUsage
  costMicros?: number
  latencyMs?: number
  transcript?: Transcript
  calls?: ToolCallRecord[]
  state?: PracticeState | null
}

/** Stores the turn's outcome (and the session's state and cost) and tells its creator (assistant.practice.turn). */
async function finish(d: PracticeDeps, turn: TurnRow, f: Finish): Promise<PracticeTurnStatus> {
  const usage = f.usage ?? ZERO_USAGE
  await transaction(d.db, async (tx) => {
    const done = await tx
      .updateTable('assistant_practice_turns')
      .set({
        status: f.status,
        reply_text: f.replyText ? redactText(f.replyText).slice(0, 2000) : null,
        extra_texts: JSON.stringify((f.extraTexts ?? []).map((t) => redactText(t))),
        badges: JSON.stringify(f.badges ?? []),
        error: f.error ? f.error.slice(0, 2000) : null,
        model: f.model ?? null,
        prompt_version: f.transcript ? promptVersionOf(f.transcript) : null,
        facts_version: f.factsVersion ?? null,
        tokens_in: usage.inputTokens,
        tokens_out: usage.outputTokens,
        tokens_cache_read: usage.cacheReadTokens,
        tokens_cache_write: usage.cacheWriteTokens,
        cost_micros: f.costMicros ?? 0,
        latency_ms: f.latencyMs ?? null,
        transcript: f.transcript ? JSON.stringify(f.transcript.toJson()) : null,
        tool_calls: JSON.stringify((f.calls ?? []).map((c) => redactJson(c))),
        finished_at: d.clock.now(),
      })
      .where('id', '=', turn.id)
      .where('status', '=', 'running')
      .returning('session_id')
      .executeTakeFirst()
    if (!done) return
    const session = await tx
      .updateTable('assistant_practice_sessions')
      .set((eb) => ({
        ...(f.state ? { state: JSON.stringify(f.state) } : {}),
        cost_micros: eb('cost_micros', '+', f.costMicros ?? 0),
        updated_at: d.clock.now(),
      }))
      .where('id', '=', turn.session_id)
      .returning(['location_id', 'user_id'])
      .executeTakeFirstOrThrow()
    await realtime.publish(tx, {
      locationId: session.location_id,
      channel: 'notifications',
      type: 'assistant.practice.turn',
      payload: { sessionId: turn.session_id, turnId: turn.id },
      targetUserId: session.user_id,
    })
  })
  return f.status
}

/** The prompt version the transcript's system entry recorded. */
function promptVersionOf(t: Transcript): string | null {
  const s = (t.toJson() as Array<{ kind?: string; promptVersion?: string }>).find((e) => e.kind === 'system')
  return s?.promptVersion ?? null
}

/** The practice day's business date (the budget counts a business day). */
export const practiceDay = (now: Date, tz: string): string => toBizDate(now, tz)

