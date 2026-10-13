// The owner's knowledge entries (ADR 0174 §1): notes written in Settings → Oasis AI → Knowledge, the reviewed text of an uploaded
// PDF (one entry per document, created by the extraction as an inactive draft) and corrections (the next wave creates them).
//
//   Budget   the ACTIVE entries and the Settings Q&A share AI_KNOWLEDGE_MAX_CHARS (default 20,000 characters, about 5k tokens).
//            Every save that can add characters to the prompt (turning an entry on, editing an active one, a Q&A that grows) runs
//            under one per-location advisory lock (`assistant.knowledge:<location>`, also taken by the Q&A save) and is refused with
//            422 KNOWLEDGE_BUDGET {usedChars, maxChars, needed} when it would go over; the entry stays a draft and nothing is cut.
//            A save that removes characters always passes, so a shop over budget (the cap lowered) is never stuck.
//   Review   a document entry goes live only after the owner read it: `reviewed: true` (or an earlier review of the same text), and
//            `confirmInstructions: true` when its text holds instruction-like lines; otherwise 422 KNOWLEDGE_NEEDS_REVIEW.
//   Limits   title 1..120; note 4,000 characters; a document stores up to 60,000 and needs 20,000 or fewer to go live; plain text
//            (no hidden character, no HTML tag), like the Q&A.
//   Audit    assistant.knowledge.{create,update,activate,deactivate,delete}: kind, title, active, chars and the SHA-256 of the body,
//            NEVER the body (audit_log is never purged and a document can hold personal data).
//   Realtime settings.changed {section: 'assistant_knowledge'} on the settings channel (the section name only).
import { createHash } from 'node:crypto'
import { sql } from 'kysely'
import * as audit from '../../../platform/audit.js'
import type { Executor, Tx } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import type { NewId } from '../../../platform/ids.js'
import * as realtime from '../../../platform/realtime.js'
import { getSetting } from '../../../platform/settings.js'
import { hasHiddenCharacters } from '../../settings/http/assistant-service.js'
import { hasInstructionWarning, knowledgeWarnings } from './sanitize.js'
import type { KnowledgeKind, KnowledgeSource, KnowledgeWarning } from './schema.js'
import './schema.js'
import './problems.js'

export const TITLE_MAX = 120
export const NOTE_MAX = 4000
export const DOCUMENT_STORE_MAX = 60_000
export const DOCUMENT_ACTIVE_MAX = 20_000
export const CORRECTION_ANSWER_MAX = 500
export const QUESTION_MAX = 300

const MARKUP = /<\s*[a-z!/?][^>]*>/i

export interface KnowledgeContext {
  locationId: string
  /** The users row to store in created_by / updated_by, or null. */
  userId: string | null
  audit: audit.AuditContext
  newId: NewId
  now: Date
  /** AI_KNOWLEDGE_MAX_CHARS. */
  maxChars: number
  /** The shop's own numbers (kept as they are; any other number is a warning and hidden from the model). */
  shopNumbers: readonly (string | null | undefined)[]
}

export interface KnowledgeBudget {
  /** Active entries + the Settings Q&A, in characters. */
  usedChars: number
  maxChars: number
  parts: { faq: number; notes: number; documents: number; corrections: number }
}

export interface KnowledgeEntryView {
  id: string
  kind: KnowledgeKind
  title: string
  body: string
  question: string | null
  /** correction: what Oasis AI said (redacted); never shown to the model. */
  wrongReply: string | null
  source: KnowledgeSource
  active: boolean
  documentId: string | null
  reviewedAt: string | null
  warnings: KnowledgeWarning[]
  chars: number
  sort: number
  version: number
  createdAt: string
  updatedAt: string
}

/** What one entry counts against the budget: its title, question and body. */
export const entryChars = (e: { title: string; question?: string | null; body: string }): number =>
  e.title.length + (e.question?.length ?? 0) + e.body.length

/** What the Settings Q&A counts against the budget: every question and answer. */
export const faqChars = (faq: readonly { q: string; a: string }[]): number => faq.reduce((n, x) => n + x.q.length + x.a.length, 0)

/** The per-location knowledge lock (budget checks and every write that can change them), shared with the Q&A save. */
export async function lockKnowledge(tx: Tx, locationId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`assistant.knowledge:${locationId}`}, 0))`.execute(tx)
}

export async function knowledgeBudget(db: Executor, locationId: string, maxChars: number): Promise<KnowledgeBudget> {
  const rows = await db
    .selectFrom('assistant_knowledge')
    .select(['kind', (eb) => eb.fn.sum<string>('chars').as('n')])
    .where('location_id', '=', locationId)
    .where('active', '=', true)
    .groupBy('kind')
    .execute()
  const of = (k: KnowledgeKind): number => Number(rows.find((r) => r.kind === k)?.n ?? 0)
  const faq = faqChars((await getSetting(db, locationId, 'assistant.faq')).value)
  const parts = { faq, notes: of('note'), documents: of('document'), corrections: of('correction') }
  return { usedChars: parts.faq + parts.notes + parts.documents + parts.corrections, maxChars, parts }
}

/**
 * Refuses a save that would take the budget past the cap: `before` / `after` are what the save takes out of and puts into the
 * prompt (0 for a draft). A save that does not grow the prompt always passes. Call it under lockKnowledge.
 */
export async function assertBudget(db: Executor, o: { locationId: string; maxChars: number; before: number; after: number }): Promise<void> {
  if (o.after <= o.before) return
  const b = await knowledgeBudget(db, o.locationId, o.maxChars)
  const next = b.usedChars - o.before + o.after
  if (next > o.maxChars)
    throw new AppError('KNOWLEDGE_BUDGET', {
      meta: { usedChars: b.usedChars, maxChars: o.maxChars, needed: next - o.maxChars },
    })
}

const invalid = (path: string, message: string): AppError => new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path, message }] })

function plain(text: string, path: string): void {
  if (hasHiddenCharacters(text)) throw invalid(path, 'Use plain text: this text holds hidden or control characters.')
  if (MARKUP.test(text)) throw invalid(path, 'Use plain text: no HTML tags.')
}

function checkTitle(title: string): string {
  const t = title.replace(/\s+/g, ' ').trim()
  if (t.length < 1 || t.length > TITLE_MAX) throw invalid('title', `Give it a name of up to ${TITLE_MAX} characters.`)
  plain(t, 'title')
  return t
}

/** The body as stored: line breaks kept (\r\n folded), trailing spaces and blank runs trimmed. */
export function cleanBody(body: string): string {
  return body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function checkBody(kind: KnowledgeKind, body: string): string {
  const b = cleanBody(body)
  const max = kind === 'note' ? NOTE_MAX : kind === 'correction' ? CORRECTION_ANSWER_MAX : DOCUMENT_STORE_MAX
  if (b.length < 1) throw invalid('body', 'Write something for Oasis AI to know.')
  if (b.length > max) throw invalid('body', `Keep it to ${max.toLocaleString('en-US')} characters or fewer.`)
  plain(b, 'body')
  return b
}

/** The warnings of an entry: its title and question (line 0) and its body (by line); a document's removed characters and length. */
export function entryWarnings(
  e: { title: string; question?: string | null; body: string; kind: KnowledgeKind },
  o: { shopNumbers: readonly (string | null | undefined)[]; removedChars?: number },
): KnowledgeWarning[] {
  const head = [e.title, e.question ?? ''].flatMap((t) => knowledgeWarnings(t.replace(/\n/g, ' '), o).map((w) => ({ ...w, line: 0 })))
  const extra: KnowledgeWarning[] = []
  if (o.removedChars && o.removedChars > 0) extra.push({ kind: 'hidden', sample: `${o.removedChars} hidden characters removed`, line: 0 })
  if (e.kind === 'document' && e.body.length > DOCUMENT_ACTIVE_MAX)
    extra.push({ kind: 'long', sample: `${e.body.length} characters`, line: 0 })
  return [...extra, ...head, ...knowledgeWarnings(e.body, o)].slice(0, 50)
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

type EntryRow = {
  id: string
  location_id: string
  kind: KnowledgeKind
  title: string
  body: string
  question: string | null
  wrong_reply: string | null
  source: KnowledgeSource
  active: boolean
  document_id: string | null
  reviewed_at: Date | null
  warnings: unknown
  chars: number
  sort: number
  version: number
  created_at: Date
  updated_at: Date
}

const ENTRY_COLUMNS = [
  'id',
  'location_id',
  'kind',
  'title',
  'body',
  'question',
  'wrong_reply',
  'source',
  'active',
  'document_id',
  'reviewed_at',
  'warnings',
  'chars',
  'sort',
  'version',
  'created_at',
  'updated_at',
] as const

const parseWarnings = (w: unknown): KnowledgeWarning[] => (typeof w === 'string' ? (JSON.parse(w) as KnowledgeWarning[]) : ((w as KnowledgeWarning[]) ?? []))

export function entryView(r: EntryRow): KnowledgeEntryView {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    question: r.question,
    wrongReply: r.wrong_reply,
    source: r.source,
    active: r.active,
    documentId: r.document_id,
    reviewedAt: r.reviewed_at ? r.reviewed_at.toISOString() : null,
    warnings: parseWarnings(r.warnings),
    chars: r.chars,
    sort: r.sort,
    version: r.version,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }
}

export async function listEntries(db: Executor, locationId: string): Promise<KnowledgeEntryView[]> {
  const rows = await db
    .selectFrom('assistant_knowledge')
    .select([...ENTRY_COLUMNS])
    .where('location_id', '=', locationId)
    .orderBy('kind')
    .orderBy('sort')
    .orderBy('created_at')
    .orderBy('id')
    .execute()
  return rows.map((r) => entryView(r as EntryRow))
}

async function lockedEntry(tx: Tx, locationId: string, id: string): Promise<EntryRow> {
  const r = await tx.selectFrom('assistant_knowledge').select([...ENTRY_COLUMNS]).where('id', '=', id).where('location_id', '=', locationId).forUpdate().executeTakeFirst()
  if (!r) throw new AppError('NOT_FOUND', { detail: 'That knowledge entry does not exist' })
  return r as EntryRow
}

const auditAfter = (e: { kind: KnowledgeKind; title: string; active: boolean; chars: number; body: string }) => ({
  kind: e.kind,
  title: e.title,
  active: e.active,
  chars: e.chars,
  bodySha256: sha256(e.body),
})

export async function publishKnowledge(tx: Tx, locationId: string): Promise<void> {
  await realtime.publish(tx, { locationId, channel: 'settings', type: 'settings.changed', payload: { section: 'assistant_knowledge' } })
}

async function record(tx: Tx, c: KnowledgeContext, action: string, id: string, after: unknown, before?: unknown): Promise<void> {
  await audit.record(tx, { locationId: c.locationId, action, entityType: 'assistant_knowledge', entityId: id, before, after, ctx: c.audit })
}

/** A new note (draft unless `active`: then the budget applies). */
export async function createNote(tx: Tx, c: KnowledgeContext, input: { title: string; body: string; active?: boolean }): Promise<KnowledgeEntryView> {
  const title = checkTitle(input.title)
  const body = checkBody('note', input.body)
  const chars = entryChars({ title, body })
  const active = input.active === true
  await lockKnowledge(tx, c.locationId)
  if (active) await assertBudget(tx, { locationId: c.locationId, maxChars: c.maxChars, before: 0, after: chars })
  const id = c.newId()
  const warnings = entryWarnings({ title, body, kind: 'note' }, { shopNumbers: c.shopNumbers })
  const row = await tx
    .insertInto('assistant_knowledge')
    .values({
      id,
      location_id: c.locationId,
      kind: 'note',
      title,
      body,
      question: null,
      wrong_reply: null,
      source: 'manual',
      assistant_turn_id: null,
      practice_turn_id: null,
      document_id: null,
      active,
      reviewed_at: null,
      warnings: JSON.stringify(warnings),
      chars,
      created_by: c.userId,
      updated_by: c.userId,
      created_at: c.now,
      updated_at: c.now,
    })
    .returning([...ENTRY_COLUMNS])
    .executeTakeFirstOrThrow()
  await record(tx, c, 'assistant.knowledge.create', id, auditAfter({ kind: 'note', title, active, chars, body }))
  await publishKnowledge(tx, c.locationId)
  return entryView(row as EntryRow)
}

export interface EntryPatch {
  title?: string
  body?: string
  /** correction: the client's words. */
  question?: string
  active?: boolean
  /** document: the owner read the text (needed to turn it on). */
  reviewed?: boolean
  /** document: the owner confirms the instruction-like lines the editor flagged. */
  confirmInstructions?: boolean
  version: number
}

/**
 * Edits an entry (title, body, the question of a correction), turns it on or off, records the review of a document. 412 on a stale
 * version; 422 KNOWLEDGE_BUDGET / KNOWLEDGE_NEEDS_REVIEW; an edit of a document's text needs a new review before it goes live.
 */
export async function updateEntry(tx: Tx, c: KnowledgeContext, id: string, patch: EntryPatch): Promise<KnowledgeEntryView> {
  await lockKnowledge(tx, c.locationId)
  const cur = await lockedEntry(tx, c.locationId, id)
  if (cur.version !== patch.version) throw new AppError('VERSION_CONFLICT', { meta: { currentVersion: cur.version } })
  const title = patch.title !== undefined ? checkTitle(patch.title) : cur.title
  const body = patch.body !== undefined ? checkBody(cur.kind, patch.body) : cur.body
  let question = cur.question
  if (patch.question !== undefined) {
    if (cur.kind !== 'correction') throw invalid('question', 'Only a correction has a question.')
    question = patch.question.replace(/\s+/g, ' ').trim()
    if (question.length < 1 || question.length > QUESTION_MAX) throw invalid('question', `Write the question in up to ${QUESTION_MAX} characters.`)
    plain(question, 'question')
  }
  const active = patch.active ?? cur.active
  const textChanged = title !== cur.title || body !== cur.body || question !== cur.question
  const chars = entryChars({ title, question, body })
  let removedChars = 0
  if (cur.kind === 'document' && cur.document_id) {
    const doc = await tx.selectFrom('assistant_knowledge_documents').select('removed_chars').where('id', '=', cur.document_id).executeTakeFirst()
    removedChars = doc?.removed_chars ?? 0
  }
  const warnings = textChanged ? entryWarnings({ title, question, body, kind: cur.kind }, { shopNumbers: c.shopNumbers, removedChars }) : parseWarnings(cur.warnings)
  // a document's text is reviewed before it goes live: a review in this save, or an earlier one of the same body
  let reviewedAt = cur.reviewed_at
  if (cur.kind === 'document') {
    if (patch.reviewed === true) reviewedAt = c.now
    else if (body !== cur.body) reviewedAt = null
    if (active && !cur.active) {
      const needs: string[] = []
      if (!reviewedAt) needs.push('reviewed')
      if (hasInstructionWarning(warnings) && patch.confirmInstructions !== true) needs.push('confirmInstructions')
      if (needs.length > 0) throw new AppError('KNOWLEDGE_NEEDS_REVIEW', { meta: { needs } })
    }
    if (active && body.length > DOCUMENT_ACTIVE_MAX)
      throw invalid('body', `Shorten this document to ${DOCUMENT_ACTIVE_MAX.toLocaleString('en-US')} characters or fewer before turning it on.`)
    // an active document whose text changed is read again before it stays live
    if (active && cur.active && body !== cur.body && !reviewedAt) throw new AppError('KNOWLEDGE_NEEDS_REVIEW', { meta: { needs: ['reviewed'] } })
  }
  await assertBudget(tx, { locationId: c.locationId, maxChars: c.maxChars, before: cur.active ? cur.chars : 0, after: active ? chars : 0 })
  const changed = textChanged || active !== cur.active || reviewedAt?.getTime() !== cur.reviewed_at?.getTime()
  if (!changed) return entryView(cur)
  const row = await tx
    .updateTable('assistant_knowledge')
    .set({
      title,
      body,
      question,
      active,
      reviewed_at: reviewedAt,
      warnings: JSON.stringify(warnings),
      chars,
      version: cur.version + 1,
      updated_by: c.userId,
      updated_at: c.now,
    })
    .where('id', '=', id)
    .returning([...ENTRY_COLUMNS])
    .executeTakeFirstOrThrow()
  const before = auditAfter({ kind: cur.kind, title: cur.title, active: cur.active, chars: cur.chars, body: cur.body })
  const after = auditAfter({ kind: cur.kind, title, active, chars, body })
  if (textChanged || reviewedAt?.getTime() !== cur.reviewed_at?.getTime()) await record(tx, c, 'assistant.knowledge.update', id, after, before)
  if (active !== cur.active) await record(tx, c, active ? 'assistant.knowledge.activate' : 'assistant.knowledge.deactivate', id, after, before)
  await publishKnowledge(tx, c.locationId)
  return entryView(row as EntryRow)
}

/**
 * Deletes an entry. A document entry deletes its document too (status deleted, its text cleared): the caller removes the stored
 * object after the commit (`objectKey`), and assistant.knowledge.cleanup retries it.
 */
export async function deleteEntry(tx: Tx, c: KnowledgeContext, id: string, o: { version?: number } = {}): Promise<{ objectKey: string | null; documentId: string | null }> {
  await lockKnowledge(tx, c.locationId)
  const cur = await lockedEntry(tx, c.locationId, id)
  if (o.version !== undefined && cur.version !== o.version) throw new AppError('VERSION_CONFLICT', { meta: { currentVersion: cur.version } })
  await tx.deleteFrom('assistant_knowledge').where('id', '=', id).execute()
  await record(tx, c, 'assistant.knowledge.delete', id, null, auditAfter(cur))
  let objectKey: string | null = null
  if (cur.document_id) objectKey = await markDocumentDeleted(tx, c, cur.document_id)
  await publishKnowledge(tx, c.locationId)
  return { objectKey, documentId: cur.document_id }
}

/** A document row deleted: its text cleared, its entry gone; returns the object key to delete (null: already gone). */
export async function markDocumentDeleted(tx: Tx, c: Pick<KnowledgeContext, 'locationId' | 'audit' | 'now'>, documentId: string): Promise<string | null> {
  const doc = await tx
    .selectFrom('assistant_knowledge_documents')
    .select(['id', 'status', 's3_key', 'filename', 'sha256', 'object_deleted_at'])
    .where('id', '=', documentId)
    .where('location_id', '=', c.locationId)
    .forUpdate()
    .executeTakeFirst()
  if (!doc || doc.status === 'deleted') return null
  await tx.deleteFrom('assistant_knowledge').where('document_id', '=', documentId).execute()
  await tx
    .updateTable('assistant_knowledge_documents')
    .set({ status: 'deleted', error_code: null, extracted_text: null, deleted_at: c.now, updated_at: c.now })
    .where('id', '=', documentId)
    .execute()
  await audit.record(tx, {
    locationId: c.locationId,
    action: 'assistant.document.delete',
    entityType: 'assistant_knowledge_document',
    entityId: documentId,
    before: { filename: doc.filename, status: doc.status, sha256: doc.sha256 },
    ctx: c.audit,
  })
  return doc.object_deleted_at ? null : doc.s3_key
}
