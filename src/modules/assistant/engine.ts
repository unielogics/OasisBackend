// The assistant's turn ENGINE (ADR 0174, design §4a; extracted from turn.ts with zero behaviour change, ADR 0160 design sections 3,
// 3b and 3c): the Converse loop (at most cfg.maxToolRounds tool rounds, then one "reply now without tools" call; one retry of a
// throttled or timed-out call), the link nudge, the text written next to handoff_to_staff, the output guard v4 (the deterministic
// layer, one rewrite, one shorten, the server's placeholder isolation or a sentence cut), the policy judge (one rewrite after a fail,
// the confirm-only line after a good proposal, an error fails closed) and the reply's last checks (a photo the team reviews, a handoff
// never ends with a question). It reads and writes NO table itself: what it needs from outside comes through its inputs and deps,
//   recordCall    a tool call or the judge's row (live: assistant_tool_calls; practice: its own turn record),
//   ctx           the tools' context (live effects or practice effects, ADR 0174 §4b),
//   afterTools    the server record the judge reads once the tool rounds are done (live: the reply numbers executed since the last
//                 reply, the conversation's earlier record, a card number in the new texts),
// and it returns what happened: a reply to send, a handoff (always with the fallback), or an opt-out. The live turn (turn.ts) keeps
// the gate, the caps, the claim, the context and every write; practice (the next wave) reuses this engine with the same prompt
// bytes, tool specs, guard and judge, so a practice answer is the answer the live assistant would give.
import { randomInt } from 'node:crypto'
import { addUsage } from '../../integrations/ai/cost.js'
import {
  AiProviderError,
  textOf,
  type AiContentBlock,
  type AiConverseRequest,
  type AiConverseResponse,
  type AiMessage,
  type AiProvider,
  type AiSystemBlock,
  type AiToolSpec,
  type AiUsage,
} from '../../integrations/ports/ai.js'
import { toBizDate } from '../../platform/time.js'
import type { AnyAssistantTool, AssistantLog, HandoffRequest, ShopFacts, ToolContext, ToolRegistry } from './contract.js'
import type { AssistantConfig } from './config.js'
import { CONFIRM_PLACEHOLDER, factLiterals, oneLine, openingWindow, placeholderValues } from './facts.js'
import { allLinkKinds, handoffTopicIn, phrasesIn, type AssistantPolicy, type ToolPolicy } from './policy.js'
import {
  cutAfterFirstQuestion,
  cutAtSentence,
  guardReply,
  HARD_PROBLEMS,
  isolatePlaceholders,
  MAX_REPLY_CHARS,
  SAFETY_LINK_KINDS,
  sentencesOf,
  withoutQuestions,
  type GuardProblem,
  type ReplySegment,
} from './guard.js'
import { CARD_LINES, FALLBACK_TEXTS, SAFETY_LINES, TOPIC_HANDOFF_TEXTS, type ConvoLang } from './lang.js'
import { JUDGE_HINTS, runJudge } from './judge.js'
import { judgeRewriteInstruction, REPLY_NOW_TEXT, rewriteInstruction, type TurnContextData } from './prompt.js'
import { runToolRound, type RecordCall } from './tool-runner.js'
import { redactText, type Transcript } from './transcript.js'
import type { TurnLinks } from './turn-links.js'

export const ZERO_USAGE: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

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

/** The turn's own abort: the deadline, a stop the loop cannot use; its reason is the turn's error. */
export class TurnAbort extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

/** The conversation part of the judge's server record (turn.ts conversationRecord for the live turn). */
export interface ConversationRecord {
  links: string[]
  pending: string | null
  lines: string[]
  availabilityChecked: boolean
}

/** What the judge's server record reads once the tool rounds are done (read at that moment: a tool of this turn may change it). */
export interface AfterTools {
  /** The client texted a card number in the texts this turn answers: the server's card line follows the reply. */
  card: boolean
  /** The in-chat actions the server executed since the assistant's last reply, in words ("booked: ..."). */
  executed: string[]
  earlier: ConversationRecord
}

export interface EngineDeps {
  cfg: AssistantConfig
  provider: AiProvider
  /** The output guard's policy judge; called only while cfg.judge.enabled. */
  judge: AiProvider
  registry: ToolRegistry
  log: AssistantLog
  /** Records a tool call or the judge's verdict row (live: assistant_tool_calls). */
  recordCall: RecordCall
  /** Monotonic milliseconds for latencies (tests may replace it). */
  nowMs?: () => number
  /** The wait before the one retry of a throttled or timed-out call (default retryBackoffMs: 800-1500 ms; tests shorten it). */
  retryBackoffMs?: () => number
}

export interface EngineInput {
  conversationId: string
  turnId: string
  tz: string
  /** The system blocks (prompt.ts buildSystem) and the tools offered, in the registry's order, with their specs. */
  system: AiSystemBlock[]
  tools: AnyAssistantTool[]
  specs: AiToolSpec[]
  /** The rendered SHOP FACTS the judge's rule (f) reads. */
  factsText: string
  /** ADR 0174: the SHOP KNOWLEDGE block of the prompt ('' without active knowledge), read by the judge's rule (f) too. */
  knowledgeText: string
  /** The conversation so far (the first user message); the engine appends to it. */
  messages: AiMessage[]
  ctx: ToolContext
  links: TurnLinks
  facts: ShopFacts
  lang: ConvoLang
  actionsEnabled: boolean
  turnContext: TurnContextData
  /** The assistant's last text in the conversation ('' when none): a link it offered as a question is sent when offered again. */
  lastAiText: string
  /** The client texted a photo in the texts this turn answers. */
  photo: boolean
  /** The turn's deadline (AI_TURN_DEADLINE_MS): its signal and its performance.now() instant. */
  signal: AbortSignal
  deadlineAt: number
  transcript: Transcript
  afterTools(): Promise<AfterTools>
  /**
   * ADR 0174 §3b: the owner's limits and tone (the runner refuses what they switch off, the guard checks the words to avoid, the
   * handoff topics have their server backstop, the sign-off's room is kept). Absent: the defaults (today's behaviour).
   */
  policy?: AssistantPolicy
  /** The client's texts this turn answers (the handoff-topic backstop reads them). */
  freshClientTexts?: readonly string[]
}

interface EngineMeter {
  usage: AiUsage
  /** The judge's calls: their own model and prices, counted in the turn's tokens and cost. */
  judgeUsage: AiUsage
  model: string | null
  rounds: number
  stop: string | null
}

export type EngineResult =
  | (EngineMeter & {
      kind: 'reply'
      /** The reply as rendered (the placeholders filled), before composeReply adds the links, the safety and card lines, the disclosure. */
      reply: string
      /** The reply as the model wrote it (placeholders in). */
      replyRaw: string
      /** The server's renderings the reply used (W4b X9). */
      rendered: string[]
      /** A verify, PIN, membership or payment link went out: the server's safety line follows. */
      safety: boolean
      card: boolean
      /** The handoff a tool asked for (or the photo review): opened once the reply is queued. */
      handoff: HandoffRequest | null
    })
  | (EngineMeter & { kind: 'handoff'; reason: string; status: 'handed_off' | 'failed'; error: string })
  | (EngineMeter & { kind: 'opted_out' })

/** One answer of the assistant over the prepared request. Never throws for the model's failures (they become a handoff). */
export async function runEngine(d: EngineDeps, i: EngineInput): Promise<EngineResult> {
  const nowMs = d.nowMs ?? (() => performance.now())
  const { transcript, links, ctx, facts, lang, turnContext, system, messages, specs, tools } = i
  const deadline = { signal: i.signal }
  const deadlineAt = i.deadlineAt
  const factsText = i.factsText
  const actionsEnabled = i.actionsEnabled
  const tz = i.tz
  const turnId = i.turnId
  const conv = { id: i.conversationId }
  let judgeUsage = ZERO_USAGE
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
  let balanceCents: number | null = null
  let confirmTexted = false
  /** What the server did and returned in this turn's tool rounds, for the judge's server record (tool-runner.ts recordLine). */
  const toolRecord: string[] = []

  // ---- the Converse loop
  let usage = ZERO_USAGE
  let model: string | null = null
  let rounds = 0
  let seq = 0
  let stop: string | null = null
  const meter = (): EngineMeter => ({ usage, judgeUsage, model, rounds, stop })
  const handoff = (o: { reason: string; status: 'handed_off' | 'failed'; error: string }): EngineResult => ({ kind: 'handoff', ...o, ...meter() })
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
  const lastAiOffered = offersLink(i.lastAiText)
  /** W4 final check L7: text the model wrote in the same round as handoff_to_staff ("I can't confirm a free wash, but ..."). */
  let handoffText: string | null = null
  let linkNudged = false
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
        const r = await runToolRound(
          { nowMs, record: d.recordCall },
          { registry: d.registry, ctx, uses, round: rounds, seq, actionsEnabled, ...(i.policy ? { policy: i.policy.tools } : {}) },
        )
        seq = r.seq
        if (r.balanceCents !== null) balanceCents = r.balanceCents
        if (r.confirmTexted) confirmTexted = true
        toolRecord.push(...r.record)
        links.requestHandoff(r.handoff)
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
        messages.push({ role: 'user', content: [{ type: 'text', text: linkNudgeText(i.policy?.tools) }] })
        transcript.add({ kind: 'message', message: messages[messages.length - 1]! })
        text = null
        continue
      }
      break
    }
  } catch (e) {
    const reason = e instanceof TurnAbort ? e.reason : failureOf(e)
    transcript.add({ kind: 'error', error: reason })
    return handoff({ reason: 'fallback', status: 'failed', error: reason })
  }
  // the loop ends without a text only after an opt-out
  if (optedOut || text === null) return { kind: 'opted_out', ...meter() }
  if (handoffText) text = withHandoffText(handoffText, text)

  // ---- the output guard
  // what the placeholders render to (the current facts; {balance} only after get_balance; the links stay for composeReply)
  const values = placeholderValues(facts, { balanceCents, confirmTexted, lang })
  for (const p of links.placeholders()) values.set(p, p)
  // server-owned literals only (the address, catalog and plan names): the digit rules skip them. Client-entered text (a vehicle on
  // file, the name) is NEVER a literal and never trusted by the judge (fix 1 of the v4 re-check: a vehicle "Free Wash 2015550123")
  const literals = factLiterals(facts)
  // the client's own first name and vehicles are skipped by the secret request check only ("Thanks, Clave", "your Ford Focus")
  const names = [turnContext.firstName, ...turnContext.vehicles.map((v) => v.split(',')[0]), ...(turnContext.vehicleNames ?? [])]
  // a verify / PIN / membership / payment link: the server appends the safety line, so the reply leaves room for it
  const safety = links.kindList().some((k) => SAFETY_LINK_KINDS.has(k))
  // the client texted a card number: the server's CARD_LINE follows the reply (the model may write nothing about cards); W4b X3:
  // what the server did since the assistant's last text; W4 final check L1: the conversation's record (all read now, after the tools)
  const after = await i.afterTools()
  const card = after.card
  const safetyLine = SAFETY_LINES[lang]
  const cardLine = CARD_LINES[lang]
  // ADR 0174 §3b: the owner's sign-off is appended by the server after the judge (composeReply): its room is kept
  const signOff = i.policy?.behavior.signOff.trim() ?? ''
  const avoidWords = i.policy?.behavior.avoidWords ?? []
  const maxChars = MAX_REPLY_CHARS - (safety ? safetyLine.length + 1 : 0) - (card ? cardLine.length + 1 : 0) - (signOff ? signOff.length + 1 : 0)
  // W4b X3: only after an executed action may the reply say it is booked, moved, cancelled or "all set"; the judge reads the same
  // record and the client's visits
  const executed = after.executed
  const actionDone = executed.length > 0
  // W4 final check L1: the record covers the conversation, not only this turn (links texted earlier, a proposal still waiting,
  // what earlier turns saved and returned, the verification): "use the link I sent earlier" is true when one was sent
  const earlier = after.earlier
  const identity = ctx.identity
  const verified = identity.trust === 'trusted'
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
      ? `Verified phone: yes${identity.trustUntil ? `, until ${toBizDate(identity.trustUntil, tz)}` : ''}.`
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
        ...(i.knowledgeText ? { knowledge: i.knowledgeText } : {}),
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
    await d.recordCall({
      seq,
      round: rounds,
      tool: 'policy_judge',
      tool_use_id: null,
      input: JSON.stringify({ model: r.model ?? d.cfg.judge.modelId, message: redactText(r.message), ...(attempts > 1 ? { attempts } : {}) }),
      output: o.kind === 'error' ? null : JSON.stringify(o.verdict),
      outcome: o.kind === 'pass' ? 'ok' : o.kind === 'fail' ? 'denied' : 'error',
      error: o.kind === 'error' ? o.error.slice(0, 2000) : o.kind === 'fail' ? o.verdict.category : null,
      latency_ms: r.latencyMs,
    })
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
    for (let n = 0; n < 10 && reply === null; n++) {
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
        ...(avoidWords.length > 0 ? { avoidWords } : {}),
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
          return handoff({ reason: 'judge_error', status: 'handed_off', error: `judge:${j.error}` })
        }
        if (judgeRewriteUsed && toConfirmOnly(`judge:${j.verdict.category}`)) continue
        if (judgeRewriteUsed) return handoff({ reason: 'policy_judge', status: 'handed_off', error: `judge:${j.verdict.category}` })
        judgeRewriteUsed = true
        draft = await fix(v.text, [], [], judgeRewriteInstruction(v.text, JUDGE_HINTS[j.verdict.category]))
        continue
      }
      const hard = v.problems.filter((p) => HARD_PROBLEMS.has(p))
      if (
        hard.length > 0 ||
        ((v.problems.includes('questions') ||
          v.problems.includes('action_claim') ||
          v.problems.includes('unverified_claim') ||
          v.problems.includes('avoid_word')) &&
          !rewriteUsed)
      ) {
        // the rewrite still trips only the placement rule: the server isolates the placeholders itself, once (each its own sentence)
        if (rewriteUsed && !isolateUsed && hard.length === 1 && hard[0] === 'placement') {
          isolateUsed = true
          draft = isolatePlaceholders(v.text, values)
          continue
        }
        // the rewrite still trips a rule: the fallback and a person ("guard"; promises are the judge's: "policy_judge")
        if (rewriteUsed && toConfirmOnly(`guard:${hard.join(',')}`)) continue
        if (rewriteUsed) return handoff({ reason: 'guard', status: 'handed_off', error: `guard:${hard.join(',')}` })
        rewriteUsed = true
        draft = await fix(v.text, v.problems, v.words)
        continue
      }
      // ADR 0174 §3b: a word to avoid that survived the rewrite: the sentences holding it go, if anything is left; else the fallback
      if (v.problems.includes('avoid_word')) {
        const kept = sentencesOf(v.text).filter((x) => phrasesIn(x, avoidWords).length === 0).join(' ').trim()
        transcript.add({ kind: 'guard', verdict: 'avoid_word_cut', problems: ['avoid_word'] })
        if (kept !== '' && kept !== v.text.trim()) {
          draft = kept
          continue
        }
        if (toConfirmOnly('guard:avoid_word')) continue
        return handoff({ reason: 'guard', status: 'handed_off', error: 'guard:avoid_word' })
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
    return handoff({ reason: 'fallback', status: 'failed', error: reason })
  }
  if (reply === null) return handoff({ reason: 'guard', status: 'handed_off', error: 'guard:unresolved' })
  // ADR 0174 §3b: the handoff topics' server backstop. The client's new texts name a topic the owner always hands to the team and
  // the model did not hand off: the fixed handoff line replaces its reply (no link, no rendering), and the handoff opens.
  const topic = links.requested() ? null : handoffTopicIn(i.freshClientTexts ?? [], i.policy?.behavior.handoffTopics ?? [])
  if (topic !== null) {
    links.drop()
    links.handoff('policy', `The client asked about "${oneLine(topic, 80)}" (Settings → Oasis AI: always hand to the team).`)
    transcript.add({ kind: 'guard', verdict: 'handoff_topic', problems: ['handoff_topic'] })
    const line = TOPIC_HANDOFF_TEXTS[lang]
    return { kind: 'reply', reply: line, replyRaw: line, rendered: [], safety: false, card, handoff: links.handoffRequest, ...meter() }
  }
  // W4b X8: the client texted a photo and the reply says the team will review it: a person is asked to (the AI cannot see it)
  if (i.photo && TEAM_REVIEW.test(reply))
    links.requestHandoff({
      reason: 'photo_quote',
      summary: 'The client texted a photo; the assistant told them the team will review it. Look at the photo in Messages and reply.',
    })
  // guard polish after W4b-fix (P5): a text that hands the chat to the team never ends with a question; the assistant goes silent
  // after it, so a question would never be answered ("Someone will text you back shortly! What's your first name?")
  if (links.handoffRequest && reply.includes('?')) {
    const kept = withoutQuestions(reply)
    transcript.add({ kind: 'guard', verdict: 'handoff_no_question', problems: ['questions'] })
    reply = kept ?? FALLBACK_TEXTS[lang]
  }
  const rendered = [...values.entries()]
    .filter(([k]) => !k.startsWith('{link') && replyRaw.includes(k))
    .map(([, v]) => v)
  return { kind: 'reply', reply, replyRaw, rendered, safety, card, handoff: links.handoffRequest, ...meter() }
}

/** A reply that tells the client the team will look at what they sent (W4b X8: a photo then opens a handoff). */
export const TEAM_REVIEW =
  /\b(?:team|staff|someone|a person|technician|we(?:'ll| will))\b[^.!?]{0,60}\b(?:review|look|check|see|get back|text you|quote|estimate)|\b(?:equipo|alguien)\b[^.!?]{0,60}\b(?:revis|mira|cotiz|te escrib|te contact)/i

/**
 * The link nudge under the owner's limits (ADR 0174 §3b): every link kind offered, LINK_NUDGE_TEXT itself; otherwise a version that
 * names no kind (the model must not be pushed toward a kind that is switched off).
 */
export function linkNudgeText(p?: ToolPolicy): string {
  if (!p || allLinkKinds(p)) return LINK_NUDGE_TEXT
  return 'Your reply offers a link but none was sent in this turn. If a link of a kind send_link offers helps, call send_link now and write your reply with its placeholder; otherwise write the reply again without offering a link.'
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
