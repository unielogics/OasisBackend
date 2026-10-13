// Corrections (ADR 0174 §5, design k-design-assistant.md §5): the owner corrects a wrong answer, from a practice turn or a real
// conversation, and the client's question with the right answer becomes a knowledge entry of kind `correction`. The model reads it
// only as `Q: "…" A: "…"` in SHOP KNOWLEDGE (knowledge/render.ts); the wrong reply is loaded by the SERVER from the named turn,
// redacted, kept for the owner, and never shown to the model (the browser's copy of either text is never trusted). Same plain-text
// rules, warnings and budget as notes (an active correction counts against AI_KNOWLEDGE_MAX_CHARS; `active: false` saves a draft).
// One correction per question: the same question (case, spaces and punctuation ignored) is 409 CORRECTION_EXISTS {entryId}, unless
// `replaceEntryId` names that entry, which is then replaced in place (its id kept, its version raised).
import { createHash } from 'node:crypto'
import * as audit from '../../../platform/audit.js'
import type { Tx } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import { hasHiddenCharacters } from '../../settings/http/assistant-service.js'
import { redactText } from '../transcript.js'
import {
  assertBudget,
  CORRECTION_ANSWER_MAX,
  entryChars,
  entryWarnings,
  listEntries,
  lockKnowledge,
  publishKnowledge,
  QUESTION_MAX,
  TITLE_MAX,
  type KnowledgeContext,
  type KnowledgeEntryView,
} from './service.js'
import '../practice/schema.js'
import '../schema.js'
import './schema.js'

export interface CorrectionInput {
  clientText: string
  rightAnswer: string
  source: 'practice' | 'live'
  practiceTurnId?: string
  assistantTurnId?: string
  active?: boolean
  replaceEntryId?: string
}

export interface CorrectionContext extends KnowledgeContext {
  /** The caller may read real conversations (cli.view): needed to correct a live turn. */
  canViewClients: boolean
}

const MARKUP = /<\s*[a-z!/?][^>]*>/i
const invalid = (path: string, message: string): AppError => new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path, message }] })

function plainLine(raw: string, path: string, max: number, what: string): string {
  const t = raw.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim()
  if (t.length < 1 || t.length > max) throw invalid(path, `${what} in up to ${max} characters.`)
  if (hasHiddenCharacters(t)) throw invalid(path, 'Use plain text: this text holds hidden or control characters.')
  if (MARKUP.test(t)) throw invalid(path, 'Use plain text: no HTML tags.')
  return t
}

/** The same question: case, spaces and punctuation ignored. */
export const sameQuestionKey = (q: string): string =>
  q
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/** The reply a live turn sent, from its transcript (redacted, links as "[link]"), or null. */
export function replyOfTranscript(transcript: unknown): string | null {
  const entries = (typeof transcript === 'string' ? JSON.parse(transcript) : transcript) as Array<{ kind?: string; text?: string }> | null
  const reply = Array.isArray(entries) ? [...entries].reverse().find((e) => e?.kind === 'reply' && typeof e.text === 'string') : undefined
  return reply?.text ? maskLinks(redactText(reply.text)) : null
}

/** Links as "[link]": the placeholders of a reply and any URL. */
export const maskLinks = (t: string): string => t.replace(/\{link\d+\}/g, '[link]').replace(/\bhttps?:\/\/\S+/gi, '[link]')

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

/** A correction from the owner's question and answer; the wrong reply comes from the named turn, loaded here. */
export async function createCorrection(tx: Tx, c: CorrectionContext, input: CorrectionInput): Promise<KnowledgeEntryView> {
  const question = plainLine(input.clientText, 'clientText', QUESTION_MAX, 'Write the question')
  const answer = plainLine(input.rightAnswer, 'rightAnswer', CORRECTION_ANSWER_MAX, 'Write the right answer')
  let wrongReply: string | null = null
  let practiceTurnId: string | null = null
  let assistantTurnId: string | null = null
  if (input.practiceTurnId) {
    // a practice turn of the caller's own sessions (another user's practice is not theirs to read)
    const t = await tx
      .selectFrom('assistant_practice_turns as t')
      .innerJoin('assistant_practice_sessions as s', 's.id', 't.session_id')
      .select(['t.id', 't.reply_text'])
      .where('t.id', '=', input.practiceTurnId)
      .where('s.location_id', '=', c.locationId)
      .where('s.user_id', '=', c.userId ?? '00000000-0000-0000-0000-000000000000')
      .executeTakeFirst()
    if (!t) throw new AppError('NOT_FOUND', { detail: 'That practice text does not exist' })
    practiceTurnId = t.id
    wrongReply = t.reply_text ? maskLinks(redactText(t.reply_text)) : null
  }
  if (input.assistantTurnId) {
    // a real conversation: only for a reader of clients (the review needs cli.view too)
    if (!c.canViewClients) throw new AppError('FORBIDDEN', { meta: { required: ['cli.view'], mode: 'all' } })
    const t = await tx
      .selectFrom('assistant_turns as t')
      .innerJoin('assistant_conversations as v', 'v.id', 't.conversation_id')
      .select(['t.id', 't.transcript'])
      .where('t.id', '=', input.assistantTurnId)
      .where('v.location_id', '=', c.locationId)
      .executeTakeFirst()
    if (!t) throw new AppError('NOT_FOUND', { detail: 'That conversation turn does not exist' })
    assistantTurnId = t.id
    wrongReply = replyOfTranscript(t.transcript)
  }
  if (wrongReply) wrongReply = wrongReply.slice(0, 2000)
  await lockKnowledge(tx, c.locationId)
  const existing = await tx
    .selectFrom('assistant_knowledge')
    .select(['id', 'question', 'active', 'chars', 'version', 'title', 'body'])
    .where('location_id', '=', c.locationId)
    .where('kind', '=', 'correction')
    .forUpdate()
    .execute()
  const key = sameQuestionKey(question)
  const same = existing.find((e) => sameQuestionKey(e.question ?? '') === key)
  if (same && same.id !== input.replaceEntryId) throw new AppError('CORRECTION_EXISTS', { meta: { entryId: same.id } })
  const replace = input.replaceEntryId ? existing.find((e) => e.id === input.replaceEntryId) : undefined
  if (input.replaceEntryId && !replace) throw new AppError('NOT_FOUND', { detail: 'That correction does not exist' })
  const active = input.active ?? true
  const title = question.slice(0, TITLE_MAX)
  const chars = entryChars({ title, question, body: answer })
  const warnings = entryWarnings({ title, question, body: answer, kind: 'correction' }, { shopNumbers: c.shopNumbers })
  await assertBudget(tx, { locationId: c.locationId, maxChars: c.maxChars, before: replace?.active ? replace.chars : 0, after: active ? chars : 0 })
  const values = {
    title,
    body: answer,
    question,
    wrong_reply: wrongReply,
    source: input.source,
    assistant_turn_id: assistantTurnId,
    practice_turn_id: practiceTurnId,
    active,
    warnings: JSON.stringify(warnings),
    chars,
    updated_by: c.userId,
    updated_at: c.now,
  }
  const after = { kind: 'correction', title, active, chars, bodySha256: sha256(answer) }
  let id: string
  if (replace) {
    id = replace.id
    await tx.updateTable('assistant_knowledge').set({ ...values, version: replace.version + 1 }).where('id', '=', id).execute()
    const before = { kind: 'correction', title: replace.title, active: replace.active, chars: replace.chars, bodySha256: sha256(replace.body) }
    await audit.record(tx, { locationId: c.locationId, action: 'assistant.knowledge.update', entityType: 'assistant_knowledge', entityId: id, before, after, ctx: c.audit })
  } else {
    id = c.newId()
    await tx
      .insertInto('assistant_knowledge')
      .values({ id, location_id: c.locationId, kind: 'correction', document_id: null, reviewed_at: null, created_by: c.userId, created_at: c.now, ...values })
      .execute()
    await audit.record(tx, { locationId: c.locationId, action: 'assistant.knowledge.create', entityType: 'assistant_knowledge', entityId: id, after, ctx: c.audit })
  }
  await publishKnowledge(tx, c.locationId)
  return (await listEntries(tx, c.locationId)).find((e) => e.id === id)!
}
