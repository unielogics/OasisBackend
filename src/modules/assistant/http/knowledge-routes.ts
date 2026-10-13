// Settings → Oasis AI → Knowledge (ADR 0174 §1, §2 and §6; api-spec 15.6c and 15.6d), all behind set.assistant:
//   GET    /assistant/knowledge                              entries, documents, the budget meter and the limits
//   POST   /assistant/knowledge                              a new note {title, body, active?}             201; 422 KNOWLEDGE_BUDGET
//   PUT    /assistant/knowledge/:id                          {title?, body?, question?, active?, reviewed?, confirmInstructions?,
//                                                            version}                                        412; 422 KNOWLEDGE_BUDGET /
//                                                                                                            KNOWLEDGE_NEEDS_REVIEW
//   DELETE /assistant/knowledge/:id                          (a document entry deletes its document)       204
//   POST   /assistant/knowledge/documents/presign            {filename, bytes, sha256}                      201; 409 DUPLICATE_DOCUMENT
//   POST   /assistant/knowledge/documents/:id/complete       verify the upload, start reading it            202 {status}
//   POST   /assistant/knowledge/documents/:id/extract        read a failed document again                   202 {status}
//   DELETE /assistant/knowledge/documents/:id                a document that never became an entry          204
//   GET    /assistant/knowledge/documents/:id/file           a 10-minute download link (attachment)
// Nothing here reaches a client: knowledge changes what Oasis AI reads (the SHOP KNOWLEDGE block of its prompt) once an entry is
// on, and only while AI_ENABLED (or, later, in the practice chat).
import type { FastifyRequest } from 'fastify'
import { access } from '../../../http/access.js'
import { auditContextOf } from '../../../http/authorizer.js'
import type { AppInstance } from '../../../http/types.js'
import { z } from '../../../http/zod.js'
import { AppError } from '../../../platform/errors.js'
import type { ObjectStorage } from '../../../integrations/storage/types.js'
import { expectedVersion, inTx, storedUserId } from '../../settings/http/runtime.js'
import {
  completeDocument,
  deleteDocument,
  DOCUMENT_ERROR_TEXT,
  documentFileUrl,
  EXTRACT_JOB,
  listDocuments,
  presignDocument,
  removeObject,
  retryDocument,
} from '../knowledge/documents.js'
import {
  CORRECTION_ANSWER_MAX,
  createNote,
  deleteEntry,
  DOCUMENT_ACTIVE_MAX,
  DOCUMENT_STORE_MAX,
  knowledgeBudget,
  listEntries,
  NOTE_MAX,
  QUESTION_MAX,
  TITLE_MAX,
  updateEntry,
  type KnowledgeContext,
} from '../knowledge/service.js'

const TAGS = ['assistant']
const Uuid = z.string().uuid()
const IdParams = z.object({ id: Uuid })

const Warning = z.object({
  kind: z.enum(['amount', 'link', 'phone', 'email', 'instruction', 'promise', 'hidden', 'markup', 'long']),
  sample: z.string().describe('The words found (at most 40 characters)'),
  line: z.number().int().describe('The body line (1-based); 0: the title, the question or the entry as a whole'),
})

export const KnowledgeEntryDto = z.object({
  id: z.string(),
  kind: z.enum(['note', 'document', 'correction']),
  title: z.string(),
  body: z.string().describe('note: the text; document: the reviewed text of the PDF; correction: the right answer'),
  question: z.string().nullable().describe('correction: the client’s words'),
  wrongReply: z.string().nullable().describe('correction: what Oasis AI said (redacted); never shown to the model'),
  source: z.enum(['manual', 'practice', 'live']),
  active: z.boolean().describe('Oasis AI reads it (counts against the budget)'),
  documentId: z.string().nullable(),
  reviewedAt: z.string().nullable().describe('document: when the owner confirmed the text (needed before it can be on)'),
  warnings: z.array(Warning).describe('What the editor shows: amounts, links, phone numbers and e-mails are hidden from Oasis AI; instruction-like lines need confirmInstructions'),
  chars: z.number().int().describe('Title + question + body: what it counts against the budget'),
  sort: z.number().int(),
  version: z.number().int().describe('Send it back with PUT (412 when stale)'),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const KnowledgeDocumentDto = z.object({
  id: z.string(),
  filename: z.string(),
  bytes: z.number().int(),
  status: z.enum(['pending_upload', 'extracting', 'ready', 'failed']),
  errorCode: z.enum(['no_text', 'encrypted', 'corrupt', 'too_many_pages', 'timeout', 'not_pdf', 'too_large']).nullable(),
  error: z.string().nullable().describe('Why it could not be read, in plain words'),
  pageCount: z.number().int().nullable(),
  removedChars: z.number().int().describe('Hidden or control characters removed from the text'),
  entryId: z.string().nullable().describe('The knowledge entry made from it (status ready)'),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const KnowledgeBudgetDto = z.object({
  usedChars: z.number().int().describe('Active entries + the Settings Q&A'),
  maxChars: z.number().int().describe('AI_KNOWLEDGE_MAX_CHARS'),
  parts: z.object({ faq: z.number().int(), notes: z.number().int(), documents: z.number().int(), corrections: z.number().int() }),
})

const KnowledgeView = z.object({
  entries: z.array(KnowledgeEntryDto),
  documents: z.array(KnowledgeDocumentDto).describe('Uploaded PDFs that are not deleted, oldest first'),
  budget: KnowledgeBudgetDto,
  limits: z.object({
    titleMax: z.number().int(),
    noteMax: z.number().int(),
    documentStoreMax: z.number().int(),
    documentActiveMax: z.number().int().describe('A document needs this many characters or fewer to be turned on'),
    correctionAnswerMax: z.number().int(),
    questionMax: z.number().int(),
    documentMaxBytes: z.number().int(),
    documentMaxPages: z.number().int(),
  }),
})

const UploadDto = z.object({ key: z.string(), url: z.string(), fields: z.record(z.string(), z.string()), expiresAt: z.string() })

export interface KnowledgeRoutesOptions {
  /** The object store (default: the environment's, STORAGE_PROVIDER). */
  storage?: () => ObjectStorage
}

export function registerKnowledgeRoutes(app: AppInstance, storage: () => ObjectStorage): void {
  const context = async (req: FastifyRequest): Promise<KnowledgeContext> => {
    const a = req.auth!
    return {
      locationId: a.locationId,
      userId: await storedUserId(app.db, a.realUserId ?? a.userId),
      audit: auditContextOf(req),
      newId: app.newId,
      now: app.clock.now(),
      maxChars: app.env.AI_KNOWLEDGE_MAX_CHARS,
      shopNumbers: [app.env.BUSINESS_TEXT_NUMBER, app.env.BUSINESS_PHONE],
    }
  }
  const budgetOf = (locationId: string) => knowledgeBudget(app.db, locationId, app.env.AI_KNOWLEDGE_MAX_CHARS)
  const kick = (documentId: string): Promise<unknown> =>
    app.jobs?.enqueue(EXTRACT_JOB, { documentId }, { singletonKey: documentId }).catch(() => null) ?? Promise.resolve(null)

  app.get(
    '/assistant/knowledge',
    {
      config: { access: access.perm('set.assistant') },
      schema: {
        tags: TAGS,
        operationId: 'getAssistantKnowledge',
        summary: 'Oasis AI knowledge: the entries, the uploaded PDFs, the budget meter and the limits',
        response: { 200: KnowledgeView },
      },
    },
    async (req) => {
      const loc = req.auth!.locationId
      const [entries, documents, budget] = await Promise.all([listEntries(app.db, loc), listDocuments(app.db, loc), budgetOf(loc)])
      return {
        entries,
        documents,
        budget,
        limits: {
          titleMax: TITLE_MAX,
          noteMax: NOTE_MAX,
          documentStoreMax: DOCUMENT_STORE_MAX,
          documentActiveMax: DOCUMENT_ACTIVE_MAX,
          correctionAnswerMax: CORRECTION_ANSWER_MAX,
          questionMax: QUESTION_MAX,
          documentMaxBytes: 10 * 1024 * 1024,
          documentMaxPages: 60,
        },
      }
    },
  )

  app.post(
    '/assistant/knowledge',
    {
      config: { access: access.perm('set.assistant') },
      schema: {
        tags: TAGS,
        operationId: 'createAssistantKnowledgeNote',
        summary: 'A new note for Oasis AI',
        description:
          'Plain text (no hidden character, no HTML tag): a title of 1 to 120 characters, a body of up to 4,000. A draft unless `active` is true; turning it on counts its characters against the budget (AI_KNOWLEDGE_MAX_CHARS, shared with the Settings Q&A): 422 `KNOWLEDGE_BUDGET {usedChars, maxChars, needed}` and nothing is saved. Amounts, links, e-mails and phone numbers other than the shop’s are kept for the owner but hidden from Oasis AI (see `warnings`). Audited (`assistant.knowledge.create`, a SHA-256 of the body, never the body) and published as `settings.changed {section: assistant_knowledge}`.',
        body: z.object({ title: z.string(), body: z.string(), active: z.boolean().optional() }).strict(),
        response: { 201: z.object({ entry: KnowledgeEntryDto, budget: KnowledgeBudgetDto }) },
      },
    },
    async (req, reply) => {
      const c = await context(req)
      const entry = await inTx(app.db, (tx) => createNote(tx, c, req.body))
      return reply.status(201).send({ entry, budget: await budgetOf(c.locationId) })
    },
  )

  app.put(
    '/assistant/knowledge/:id',
    {
      config: { access: access.perm('set.assistant') },
      schema: {
        tags: TAGS,
        operationId: 'putAssistantKnowledge',
        summary: 'Edit a knowledge entry, turn it on or off, or confirm the text of a PDF',
        description:
          '`version` (or If-Match) is required: 412 VERSION_CONFLICT when stale, 428 without. Turning an entry on, or growing an active one, checks the budget (422 `KNOWLEDGE_BUDGET {usedChars, maxChars, needed}`); a save that shrinks it always passes. A document goes on only once reviewed: `reviewed: true` in this save (or an earlier review of the same text) and, when its text has instruction-like lines, `confirmInstructions: true`; else 422 `KNOWLEDGE_NEEDS_REVIEW {needs: [reviewed|confirmInstructions]}`. Editing a document’s text clears its review: a live document passes the same gate again when its text changes, or when a new title brings an instruction-like line. A document needs 20,000 characters or fewer to be on. `question` is a correction’s only. Audited (`assistant.knowledge.update` / `.activate` / `.deactivate`).',
        params: IdParams,
        body: z
          .object({
            title: z.string().optional(),
            body: z.string().optional(),
            question: z.string().optional(),
            active: z.boolean().optional(),
            reviewed: z.boolean().optional(),
            confirmInstructions: z.boolean().optional(),
            version: z.number().int().min(1).optional(),
          })
          .strict(),
        response: { 200: z.object({ entry: KnowledgeEntryDto, budget: KnowledgeBudgetDto }) },
      },
    },
    async (req) => {
      const version = expectedVersion(req, req.body.version)
      if (version === undefined) throw new AppError('PRECONDITION_REQUIRED')
      const c = await context(req)
      const { title, body, question, active, reviewed, confirmInstructions } = req.body
      const patch = { title, body, question, active, reviewed, confirmInstructions, version }
      const entry = await inTx(app.db, (tx) => updateEntry(tx, c, req.params.id, patch))
      return { entry, budget: await budgetOf(c.locationId) }
    },
  )

  app.delete(
    '/assistant/knowledge/:id',
    {
      config: { access: access.perm('set.assistant') },
      schema: {
        tags: TAGS,
        operationId: 'deleteAssistantKnowledge',
        summary: 'Delete a knowledge entry (a document entry deletes its PDF and text too)',
        description: 'If-Match is optional (412 when stale). Audited (`assistant.knowledge.delete`; a document also `assistant.document.delete`).',
        params: IdParams,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const c = await context(req)
      const version = expectedVersion(req, undefined)
      const r = await inTx(app.db, (tx) => deleteEntry(tx, c, req.params.id, version !== undefined ? { version } : {}))
      if (r.objectKey && r.documentId) await removeObject(app.db, storage(), { documentId: r.documentId, key: r.objectKey, now: app.clock.now() })
      return reply.status(204).send(null)
    },
  )

  app.post(
    '/assistant/knowledge/documents/presign',
    {
      config: { access: access.perm('set.assistant') },
      schema: {
        tags: TAGS,
        operationId: 'presignAssistantKnowledgeDocument',
        summary: 'Start a PDF upload: a presigned POST for exactly one PDF of up to 10 MB',
        description:
          '`sha256` is the browser’s SHA-256 of the file (WebCrypto): a file already in the knowledge is refused before uploading (409 `DUPLICATE_DOCUMENT {documentId, entryId}`). Upload the file to `upload.url` with `upload.fields` (content type application/pdf, 1 byte to 10 MB, 5 minutes), then call complete.',
        body: z.object({ filename: z.string().min(1).max(500), bytes: z.number().int(), sha256: z.string() }).strict(),
        response: { 201: z.object({ documentId: z.string(), upload: UploadDto }) },
      },
    },
    async (req, reply) => {
      const c = await context(req)
      const r = await inTx(app.db, (tx) => presignDocument(tx, { ...c, storage: storage() }, req.body))
      return reply.status(201).send({ documentId: r.documentId, upload: { ...r.upload, expiresAt: r.upload.expiresAt.toISOString() } })
    },
  )

  app.post(
    '/assistant/knowledge/documents/:id/complete',
    {
      config: { access: access.perm('set.assistant') },
      schema: {
        tags: TAGS,
        operationId: 'completeAssistantKnowledgeDocument',
        summary: 'Verify the uploaded PDF and start reading it',
        description:
          'Checks the object (size, type, the %PDF- start) and its SHA-256 (the server’s own: a copy of a PDF already in the knowledge is deleted and 409 `DUPLICATE_DOCUMENT` answered), then reads it in the background (job assistant.knowledge.extract): 202 `{status: extracting}`, or 200 `{status: failed, errorCode: not_pdf}`. Poll GET /assistant/knowledge or listen for `settings.changed {section: assistant_knowledge}`. Audited (`assistant.document.upload`).',
        params: IdParams,
        response: {
          200: z.object({ status: z.literal('failed'), errorCode: z.string(), error: z.string() }),
          202: z.object({ status: z.literal('extracting') }),
        },
      },
    },
    async (req, reply) => {
      const c = await context(req)
      const r = await inTx(app.db, (tx) => completeDocument(tx, { ...c, storage: storage() }, req.params.id))
      if (r.status === 'duplicate') {
        await removeObject(app.db, storage(), { documentId: req.params.id, key: r.objectKey, now: app.clock.now() })
        throw new AppError('DUPLICATE_DOCUMENT', { meta: { documentId: r.documentId, entryId: r.entryId } })
      }
      if (r.status === 'failed') return reply.status(200).send({ status: 'failed', errorCode: r.errorCode, error: DOCUMENT_ERROR_TEXT[r.errorCode] })
      await kick(req.params.id)
      return reply.status(202).send({ status: 'extracting' })
    },
  )

  app.post(
    '/assistant/knowledge/documents/:id/extract',
    {
      config: { access: access.perm('set.assistant') },
      schema: {
        tags: TAGS,
        operationId: 'retryAssistantKnowledgeDocument',
        summary: 'Read a PDF that failed again',
        description: 'Only a failed document (not one that is not a PDF), at most 5 reads in all: 409 `DOCUMENT_NOT_READY` otherwise.',
        params: IdParams,
        response: { 202: z.object({ status: z.literal('extracting') }) },
      },
    },
    async (req, reply) => {
      const c = await context(req)
      await inTx(app.db, (tx) => retryDocument(tx, c, req.params.id))
      await kick(req.params.id)
      return reply.status(202).send({ status: 'extracting' as const })
    },
  )

  app.delete(
    '/assistant/knowledge/documents/:id',
    {
      config: { access: access.perm('set.assistant') },
      schema: {
        tags: TAGS,
        operationId: 'deleteAssistantKnowledgeDocument',
        summary: 'Delete an uploaded PDF (and its entry, its text and the stored file)',
        params: IdParams,
        response: { 204: z.null() },
      },
    },
    async (req, reply) => {
      const c = await context(req)
      const r = await inTx(app.db, (tx) => deleteDocument(tx, c, req.params.id))
      if (r.objectKey) await removeObject(app.db, storage(), { documentId: req.params.id, key: r.objectKey, now: app.clock.now() })
      return reply.status(204).send(null)
    },
  )

  app.get(
    '/assistant/knowledge/documents/:id/file',
    {
      config: { access: access.perm('set.assistant') },
      schema: {
        tags: TAGS,
        operationId: 'getAssistantKnowledgeDocumentFile',
        summary: 'A 10-minute download link of the PDF (saved as a file, never shown inline)',
        params: IdParams,
        response: { 200: z.object({ url: z.string(), expiresInSeconds: z.number().int() }) },
      },
    },
    async (req, reply) => {
      void reply.header('Cache-Control', 'no-store')
      return documentFileUrl(app.db, storage(), { locationId: req.auth!.locationId, id: req.params.id })
    },
  )
}
