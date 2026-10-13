// The review of real Oasis AI conversations for training (ADR 0174 §5, design k-design-assistant.md §5; api-spec 15.6f): a list of the
// location's AI conversations of the last days (at most 90) with flags, and one conversation turn by turn, what the client texted
// and what was sent (both loaded on the server and redacted: phone numbers, codes and card numbers masked, links as "[link]"), what
// the output guard and the policy check did in plain words, the tools used, and the correction made from it. Staff follow live
// chats in Messages; this is the owner's training view (set.assistant + cli.view at the route). Read-only.
import { sql } from 'kysely'
import type { Executor } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { maskLinks } from './knowledge/corrections.js'
import { redactText } from './transcript.js'
import './schema.js'
import './knowledge/schema.js'
import '../customers/schema.js'
import '../messaging/schema.js'

export const REVIEW_MAX_DAYS = 90
export type ReviewFilter = 'all' | 'handed_off' | 'fallback' | 'judge' | 'corrected'
type Flag = Exclude<ReviewFilter, 'all'>

export interface ReviewConversation {
  id: string
  client: { firstName: string | null; phoneLast4: string }
  lastTurnAt: string
  turns: number
  handoff: { open: boolean; reason: string | null } | null
  flags: Flag[]
}

export interface ReviewTurn {
  id: string
  startedAt: string
  status: string
  clientTexts: string[]
  reply: string | null
  handoffReason: string | null
  guard: string[]
  judge: { verdict: 'pass' | 'fail' | 'error'; category: string | null; words: string } | null
  tools: string[]
  model: string | null
  promptVersion: string | null
  correctionEntryId: string | null
}

interface Row {
  id: string
  phone_e164: string
  handoff_state: string | null
  handoff_reason: string | null
  full_name: string | null
  last_at: Date
  n: number
  handed: boolean
  fallback: boolean
  judge: boolean
  corrected: boolean
}

const firstNameOf = (full: string | null): string | null => (!full || /^New texter\b/.test(full) ? null : (full.trim().split(/\s+/)[0] ?? null))

const view = (r: Row): ReviewConversation => ({
  id: r.id,
  client: { firstName: firstNameOf(r.full_name), phoneLast4: `•••${r.phone_e164.replace(/\D/g, '').slice(-4)}` },
  lastTurnAt: r.last_at.toISOString(),
  turns: Number(r.n),
  handoff: r.handoff_state ? { open: r.handoff_state === 'open', reason: r.handoff_reason } : null,
  flags: (
    [
      ['handed_off', r.handed || r.handoff_reason !== null],
      ['fallback', r.fallback],
      ['judge', r.judge],
      ['corrected', r.corrected],
    ] as const
  )
    .filter(([, on]) => on)
    .map(([f]) => f),
})

const FLAG_SQL: Record<Flag, ReturnType<typeof sql>> = {
  handed_off: sql`(x.handed or c.handoff_reason is not null)`,
  fallback: sql`x.fallback`,
  judge: sql`x.judge`,
  corrected: sql`x.corrected`,
}

function conversationsQuery(o: { locationId: string; since: Date; id?: string; filter?: ReviewFilter; cursor?: { at: Date; id: string } | null; limit?: number }) {
  return sql<Row>`
    select c.id, c.phone_e164, c.handoff_state, c.handoff_reason, cu.full_name,
      x.last_at, x.n, x.handed, x.fallback, x.judge, x.corrected
    from assistant_conversations c
    cross join lateral (
      select max(t.started_at) as last_at, count(*)::int as n,
        coalesce(bool_or(t.status = 'handed_off'), false) as handed,
        coalesce(bool_or(t.status = 'failed' or (t.status = 'handed_off' and t.reply_message_id is not null)), false) as fallback,
        coalesce(bool_or(exists (select 1 from assistant_tool_calls k where k.turn_id = t.id and k.tool = 'policy_judge' and k.outcome in ('denied', 'error'))), false) as judge,
        coalesce(bool_or(exists (select 1 from assistant_knowledge q where q.assistant_turn_id = t.id)), false) as corrected
      from assistant_turns t
      where t.conversation_id = c.id and t.started_at > ${o.since} and t.status <> 'running'
    ) x
    left join customers cu on cu.id = c.customer_id
    where c.location_id = ${o.locationId} and x.n > 0
      ${o.id ? sql`and c.id = ${o.id}` : sql``}
      ${o.filter && o.filter !== 'all' ? sql`and ${FLAG_SQL[o.filter]}` : sql``}
      ${o.cursor ? sql`and (x.last_at, c.id) < (${o.cursor.at}, ${o.cursor.id})` : sql``}
    order by x.last_at desc, c.id desc
    ${o.limit ? sql`limit ${o.limit}` : sql``}`
}

const encodeCursor = (r: Row): string => Buffer.from(`${r.last_at.toISOString()}|${r.id}`).toString('base64url')
function decodeCursor(c: string | undefined): { at: Date; id: string } | null {
  if (!c) return null
  const [at, id] = Buffer.from(c, 'base64url').toString('utf8').split('|')
  const date = at ? new Date(at) : null
  if (!date || Number.isNaN(date.getTime()) || !id || !/^[0-9a-f-]{36}$/i.test(id)) throw new AppError('VALIDATION_FAILED', { detail: 'That page cursor is not valid', errors: [{ path: 'cursor', message: 'That page cursor is not valid.' }] })
  return { at: date, id }
}

export async function listConversations(
  db: Executor,
  o: { locationId: string; now: Date; days: number; filter: ReviewFilter; cursor?: string; limit: number },
): Promise<{ conversations: ReviewConversation[]; nextCursor: string | null }> {
  const days = Math.min(REVIEW_MAX_DAYS, Math.max(1, o.days))
  const since = new Date(o.now.getTime() - days * 86_400_000)
  const rows = (await conversationsQuery({ locationId: o.locationId, since, filter: o.filter, cursor: decodeCursor(o.cursor), limit: o.limit + 1 }).execute(db)).rows
  const page = rows.slice(0, o.limit)
  return { conversations: page.map(view), nextCursor: rows.length > o.limit ? encodeCursor(page.at(-1)!) : null }
}

// ---- one conversation, turn by turn

const PROBLEM_WORDS: Record<string, string> = {
  empty: 'an empty answer',
  unknown_placeholder: 'an unknown placeholder',
  placement: 'a price written the wrong way',
  money: 'an amount in its own words',
  digits: 'a code or phone number',
  secret: 'a request for a code or card',
  url: 'a web address',
  questions: 'more than one question',
  too_long: 'too long',
  action_claim: 'said something was done',
  meta: 'a note about its own instructions',
  unverified_claim: 'named an open time or a verification it could not know',
  avoid_word: 'a word you asked it to avoid',
}

const GUARD_VERDICTS: Record<string, string> = {
  confirm_only: 'Sent only the confirmation line (the proposal had gone out)',
  handoff_no_question: 'Took the question out of a text that hands the chat to the team',
  avoid_word_cut: 'Took out a sentence with a word you asked it to avoid',
  handoff_topic: 'Your handoff topic: the team line was sent instead',
  spanish_handoff: 'A Spanish chat handed to the team (your setting)',
}

const JUDGE_WORDS: Record<string, string> = {
  none: 'passed',
  price: 'a price, total or discount in its own words',
  promise: 'a promise (free, discount, refund, guarantee, ready time)',
  secret: 'text about codes, PINs or cards',
  link_or_phone: 'a web address or phone number',
  other: 'a legal or insurance statement',
  facts: 'a claim about the shop its documents do not state',
  action: 'said something was done or open without the server doing it',
  meta: 'a note about its own instructions',
}

type Entry = { kind?: string; verdict?: string; problems?: string[]; category?: string; error?: string; reason?: string; text?: string; promptVersion?: string }

/** One conversation of the location with its turns of the last 90 days (another location's, or none in 90 days: 404). */
export async function getConversation(db: Executor, o: { locationId: string; now: Date; id: string }): Promise<{ conversation: ReviewConversation; turns: ReviewTurn[] }> {
  const since = new Date(o.now.getTime() - REVIEW_MAX_DAYS * 86_400_000)
  const row = (await conversationsQuery({ locationId: o.locationId, since, id: o.id }).execute(db)).rows[0]
  if (!row) throw new AppError('NOT_FOUND', { detail: 'That conversation does not exist' })
  const turns = await db
    .selectFrom('assistant_turns')
    .select(['id', 'started_at', 'status', 'error', 'model', 'prompt_version', 'transcript', 'reply_message_id'])
    .where('conversation_id', '=', o.id)
    .where('started_at', '>', since)
    .where('status', '!=', 'running')
    .orderBy('started_at')
    .orderBy('id')
    .execute()
  const ids = turns.map((t) => t.id)
  const none = ['00000000-0000-0000-0000-000000000000']
  const inbox = await db.selectFrom('sms_inbox').select(['assistant_turn_id', 'body']).where('assistant_turn_id', 'in', ids.length ? ids : none).orderBy('received_at').orderBy('id').execute()
  const calls = await db.selectFrom('assistant_tool_calls').select(['turn_id', 'tool', 'outcome', 'input']).where('turn_id', 'in', ids.length ? ids : none).orderBy('seq').execute()
  const sentIds = turns.map((t) => t.reply_message_id).filter((x): x is string => x !== null)
  const sent = await db.selectFrom('messages').select(['id', 'body']).where('id', 'in', sentIds.length ? sentIds : none).execute()
  const corrections = await db
    .selectFrom('assistant_knowledge')
    .select(['id', 'assistant_turn_id'])
    .where('location_id', '=', o.locationId)
    .where('assistant_turn_id', 'in', ids.length ? ids : none)
    .execute()
  return {
    conversation: view(row),
    turns: turns.map((t) => {
      const entries = ((typeof t.transcript === 'string' ? JSON.parse(t.transcript) : t.transcript) ?? []) as Entry[]
      const mine = calls.filter((c) => c.turn_id === t.id)
      const message = sent.find((m) => m.id === t.reply_message_id)?.body ?? null
      const reply = message !== null ? maskLinks(redactText(message)) : (entries.filter((e) => e.kind === 'reply').at(-1)?.text ?? null)
      const handoffTool = mine.find((c) => c.tool === 'handoff_to_staff' && c.outcome === 'ok')
      const toolReason = handoffTool ? ((typeof handoffTool.input === 'string' ? JSON.parse(handoffTool.input) : handoffTool.input) as { reason?: string } | null)?.reason ?? null : null
      const judge = entries.filter((e) => e.kind === 'judge').at(-1)
      return {
        id: t.id,
        startedAt: t.started_at.toISOString(),
        status: t.status,
        clientTexts: inbox.filter((x) => x.assistant_turn_id === t.id).map((x) => maskLinks(redactText(x.body))),
        reply: reply === null ? null : maskLinks(redactText(reply)),
        handoffReason: entries.filter((e) => e.kind === 'handoff').at(-1)?.reason ?? toolReason,
        guard: guardWords(entries),
        judge: judge
          ? {
              verdict: (judge.verdict as 'pass' | 'fail' | 'error') ?? 'error',
              category: judge.category ?? null,
              words: judge.verdict === 'error' ? 'the policy check did not answer' : (JUDGE_WORDS[judge.category ?? 'none'] ?? judge.category ?? 'passed'),
            }
          : null,
        tools: [...new Set(mine.filter((c) => c.tool !== 'policy_judge').map((c) => c.tool))],
        model: t.model,
        promptVersion: t.prompt_version,
        correctionEntryId: corrections.find((c) => c.assistant_turn_id === t.id)?.id ?? null,
      }
    }),
  }
}

/** What the output guard changed in a turn, in plain words. */
function guardWords(entries: readonly Entry[]): string[] {
  const out: string[] = []
  for (const e of entries) {
    if (e.kind !== 'guard') continue
    if (e.verdict === 'fix') {
      const words = (e.problems ?? []).map((p) => PROBLEM_WORDS[p] ?? p)
      if (words.length > 0) out.push(`The safety check caught: ${words.join(', ')}`)
    } else if (e.verdict && GUARD_VERDICTS[e.verdict]) out.push(GUARD_VERDICTS[e.verdict]!)
  }
  return [...new Set(out)]
}
