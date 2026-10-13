// PDF documents of the assistant's knowledge (ADR 0174 §2), modelled on the photo flow (scheduling/photos.ts): the bytes never pass
// through the API on the way up.
//   presign   {filename, bytes, sha256}: the browser hashed the file first, so a copy already uploaded is caught before uploading
//             (409 DUPLICATE_DOCUMENT {documentId, entryId}); the row starts as pending_upload under kb/{location}/{id}.pdf and a
//             presigned POST pinned to that key, application/pdf and 1 byte to 10 MB (5 minutes) is returned.
//   complete  HEAD (size and type), GET, the %PDF- magic bytes (else failed: not_pdf), the server's own SHA-256 (the authoritative
//             duplicate check: the copy is deleted and 409 answered), then `extracting`; the caller enqueues
//             assistant.knowledge.extract after the commit.
//   extract   (the job) reads the PDF in a worker thread (extract/extract.ts) and either fails it with a plain reason or stores the
//             cleaned text and creates the document's knowledge entry as an inactive draft, its warnings computed, waiting for review.
//   retry     a failed document goes back to extracting (at most MAX_ATTEMPTS reads).
//   delete    the document and its entry: text cleared, the object removed after the commit (the cleanup job retries).
//   file      a 10-minute presigned GET as an attachment, for set.assistant only.
//   cleanup   (the job, every 15 minutes) abandoned uploads (pending over 15 minutes) and their objects removed, extractions stuck
//             over 10 minutes failed as timeout (the owner can retry), objects of deleted documents removed again.
import { createHash } from 'node:crypto'
import { sql } from 'kysely'
import * as audit from '../../../platform/audit.js'
import type { Db, Executor, Tx } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import type { StorageProvider, UploadSlot } from '../../../integrations/ports/storage.js'
import { buildKnowledgeKey } from '../../../integrations/storage/keys.js'
import { sniffPdf } from '../../../integrations/storage/sniff.js'
import { DOWNLOAD_TTL_SEC, KNOWLEDGE_TYPES, MAX_KNOWLEDGE_BYTES, normalizeContentType, UPLOAD_TTL_SEC } from '../../../integrations/storage/types.js'
import type { ObjectStorage } from '../../../integrations/storage/types.js'
import { extractPdf, type PdfLimits } from './extract/extract.js'
import type { DocumentError, DocumentStatus } from './schema.js'
import { DOCUMENT_STORE_MAX, entryChars, entryWarnings, lockKnowledge, markDocumentDeleted, publishKnowledge, type KnowledgeContext } from './service.js'
import './schema.js'

export const EXTRACT_JOB = 'assistant.knowledge.extract'
export const CLEANUP_JOB = 'assistant.knowledge.cleanup'
/** Reads of one document (the first and the retries). */
export const MAX_ATTEMPTS = 5
/** An upload still pending after this long was abandoned. */
export const PENDING_UPLOAD_TTL_MS = 15 * 60_000
/** An extraction still running after this long died with its worker (the job expires after 2 minutes). */
export const STUCK_EXTRACTION_MS = 10 * 60_000

/** What the owner reads about a document that could not be read (plain words). */
export const DOCUMENT_ERROR_TEXT: Record<DocumentError, string> = {
  no_text:
    'This PDF is a scan (pictures of pages), so Oasis AI can’t read it. Upload the original file, or type the important parts as a note.',
  encrypted: 'This PDF is protected with a password. Save a copy without the password and upload that.',
  corrupt: 'This PDF could not be read. Save it again (Print → Save as PDF) and upload the new copy.',
  too_many_pages: 'This PDF has more than 60 pages. Upload the pages Oasis AI needs, or type them as a note.',
  timeout: 'Reading this PDF took too long. Try again, or upload a smaller file.',
  not_pdf: 'This file is not a PDF.',
  too_large: 'This PDF is too large to read. Upload a smaller file (at most 10 MB).',
}

export interface DocumentView {
  id: string
  filename: string
  bytes: number
  status: Exclude<DocumentStatus, 'deleted'>
  errorCode: DocumentError | null
  /** The plain reason when it failed. */
  error: string | null
  pageCount: number | null
  /** Hidden or control characters removed from the text. */
  removedChars: number
  /** The knowledge entry made from it (ready documents). */
  entryId: string | null
  createdAt: string
  updatedAt: string
}

const invalid = (path: string, message: string): AppError => new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path, message }] })

export async function listDocuments(db: Executor, locationId: string): Promise<DocumentView[]> {
  const rows = await db
    .selectFrom('assistant_knowledge_documents as d')
    .leftJoin('assistant_knowledge as k', 'k.document_id', 'd.id')
    .select(['d.id', 'd.filename', 'd.bytes', 'd.status', 'd.error_code', 'd.page_count', 'd.removed_chars', 'd.created_at', 'd.updated_at', 'k.id as entry_id'])
    .where('d.location_id', '=', locationId)
    .where('d.status', '!=', 'deleted')
    .orderBy('d.created_at')
    .orderBy('d.id')
    .execute()
  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    bytes: r.bytes,
    status: r.status as DocumentView['status'],
    errorCode: r.error_code,
    error: r.error_code ? DOCUMENT_ERROR_TEXT[r.error_code] : null,
    pageCount: r.page_count,
    removedChars: r.removed_chars,
    entryId: r.entry_id ?? null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }))
}

/** The file name as stored: its last path part, one line, at most 120 characters (the .pdf ending kept). */
export function cleanFilename(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '').normalize('NFKC').replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim()
  if (base.length <= 120) return base
  const ext = /\.pdf$/i.test(base) ? base.slice(-4) : ''
  return `${base.slice(0, 120 - ext.length).trimEnd()}${ext}`
}

async function liveCopy(db: Executor, locationId: string, sha256: string, exceptId?: string) {
  let q = db
    .selectFrom('assistant_knowledge_documents as d')
    .leftJoin('assistant_knowledge as k', 'k.document_id', 'd.id')
    .select(['d.id', 'k.id as entry_id'])
    .where('d.location_id', '=', locationId)
    .where('d.sha256', '=', sha256)
    .where('d.status', '!=', 'deleted')
  if (exceptId) q = q.where('d.id', '!=', exceptId)
  return q.executeTakeFirst()
}

const duplicate = (copy: { id: string; entry_id: string | null }): AppError =>
  new AppError('DUPLICATE_DOCUMENT', { meta: { documentId: copy.id, entryId: copy.entry_id ?? null } })

/** Starts an upload: the row (pending_upload) and a presigned POST for exactly that key, type and size range. */
export async function presignDocument(
  tx: Tx,
  c: KnowledgeContext & { storage: StorageProvider },
  input: { filename: string; bytes: number; sha256: string },
): Promise<{ documentId: string; upload: UploadSlot }> {
  const filename = cleanFilename(input.filename)
  if (filename.length < 1) throw invalid('filename', 'Name the file.')
  if (!Number.isInteger(input.bytes) || input.bytes < 1 || input.bytes > MAX_KNOWLEDGE_BYTES) throw invalid('bytes', 'PDFs can be up to 10 MB.')
  const sha256 = input.sha256.toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw invalid('sha256', 'The file’s SHA-256 must be 64 hexadecimal characters.')
  await lockKnowledge(tx, c.locationId)
  const copy = await liveCopy(tx, c.locationId, sha256)
  if (copy) throw duplicate(copy)
  const id = c.newId()
  const key = buildKnowledgeKey({ locationId: c.locationId, documentId: id })
  await tx
    .insertInto('assistant_knowledge_documents')
    .values({
      id,
      location_id: c.locationId,
      filename,
      content_type: 'application/pdf',
      bytes: input.bytes,
      sha256,
      s3_key: key,
      status: 'pending_upload',
      uploaded_by: c.userId,
      created_at: c.now,
      updated_at: c.now,
    })
    .execute()
  const upload = await c.storage.createUpload({
    key,
    contentType: 'application/pdf',
    maxBytes: MAX_KNOWLEDGE_BYTES,
    ttlSec: UPLOAD_TTL_SEC,
    allowedTypes: KNOWLEDGE_TYPES,
  })
  return { documentId: id, upload }
}

async function lockedDocument(tx: Tx, locationId: string, id: string) {
  const d = await tx
    .selectFrom('assistant_knowledge_documents')
    .selectAll()
    .where('id', '=', id)
    .where('location_id', '=', locationId)
    .forUpdate()
    .executeTakeFirst()
  if (!d || d.status === 'deleted') throw new AppError('NOT_FOUND', { detail: 'That document does not exist' })
  return d
}

export type CompleteResult =
  | { status: 'extracting' }
  | { status: 'failed'; errorCode: DocumentError }
  /** The same file is already in the knowledge: this copy was deleted; the caller answers 409 after the commit. */
  | { status: 'duplicate'; documentId: string; entryId: string | null; objectKey: string }

/** Verifies the uploaded object and starts the extraction (the caller enqueues EXTRACT_JOB after the commit). */
export async function completeDocument(tx: Tx, c: KnowledgeContext & { storage: ObjectStorage }, id: string): Promise<CompleteResult> {
  await lockKnowledge(tx, c.locationId)
  const d = await lockedDocument(tx, c.locationId, id)
  if (d.status === 'extracting') return { status: 'extracting' }
  if (d.status !== 'pending_upload') throw new AppError('DOCUMENT_NOT_READY')
  const head = await c.storage.head(d.s3_key)
  if (!head) throw invalid('documentId', 'The file has not been uploaded yet.')
  if (head.bytes < 1 || head.bytes > MAX_KNOWLEDGE_BYTES) throw invalid('documentId', 'PDFs can be up to 10 MB.')
  if (normalizeContentType(head.contentType) !== 'application/pdf') throw invalid('documentId', 'The uploaded file is not the type that was announced.')
  const bytes = await c.storage.get(d.s3_key)
  const fail = async (errorCode: DocumentError): Promise<CompleteResult> => {
    await tx
      .updateTable('assistant_knowledge_documents')
      .set({ status: 'failed', error_code: errorCode, bytes: head.bytes, updated_at: c.now })
      .where('id', '=', d.id)
      .execute()
    await publishKnowledge(tx, c.locationId)
    return { status: 'failed', errorCode }
  }
  if (!sniffPdf(bytes)) return fail('not_pdf')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const copy = await liveCopy(tx, c.locationId, sha256, d.id)
  if (copy) {
    await tx
      .updateTable('assistant_knowledge_documents')
      .set({ status: 'deleted', deleted_at: c.now, updated_at: c.now })
      .where('id', '=', d.id)
      .execute()
    return { status: 'duplicate', documentId: copy.id, entryId: copy.entry_id ?? null, objectKey: d.s3_key }
  }
  await tx
    .updateTable('assistant_knowledge_documents')
    .set({ status: 'extracting', sha256, bytes: head.bytes, attempts: sql`attempts + 1`, updated_at: c.now })
    .where('id', '=', d.id)
    .execute()
  await audit.record(tx, {
    locationId: c.locationId,
    action: 'assistant.document.upload',
    entityType: 'assistant_knowledge_document',
    entityId: d.id,
    after: { filename: d.filename, bytes: head.bytes, sha256 },
    ctx: c.audit,
  })
  await publishKnowledge(tx, c.locationId)
  return { status: 'extracting' }
}

/** A failed document read again (at most MAX_ATTEMPTS reads in all); the caller enqueues EXTRACT_JOB after the commit. */
export async function retryDocument(tx: Tx, c: KnowledgeContext, id: string): Promise<{ status: 'extracting' }> {
  const d = await lockedDocument(tx, c.locationId, id)
  if (d.status !== 'failed' || d.error_code === 'not_pdf') throw new AppError('DOCUMENT_NOT_READY')
  if (d.attempts >= MAX_ATTEMPTS) throw new AppError('DOCUMENT_NOT_READY', { detail: 'This PDF was read too many times. Upload it again.' })
  await tx
    .updateTable('assistant_knowledge_documents')
    .set({ status: 'extracting', error_code: null, attempts: sql`attempts + 1`, updated_at: c.now })
    .where('id', '=', d.id)
    .execute()
  await publishKnowledge(tx, c.locationId)
  return { status: 'extracting' }
}

/** Deletes a document (and its entry); returns the object key the caller removes after the commit. */
export async function deleteDocument(tx: Tx, c: KnowledgeContext, id: string): Promise<{ objectKey: string | null }> {
  await lockKnowledge(tx, c.locationId)
  await lockedDocument(tx, c.locationId, id)
  const objectKey = await markDocumentDeleted(tx, c, id)
  await publishKnowledge(tx, c.locationId)
  return { objectKey }
}

/** Removes a deleted document's object (best effort: the cleanup job retries) and records that it is gone. */
export async function removeObject(db: Db, storage: StorageProvider, o: { documentId: string; key: string; now: Date }): Promise<boolean> {
  try {
    await storage.delete(o.key)
  } catch {
    return false
  }
  await db.updateTable('assistant_knowledge_documents').set({ object_deleted_at: o.now }).where('id', '=', o.documentId).where('status', '=', 'deleted').execute()
  return true
}

/** A presigned GET of the PDF as an attachment (10 minutes). */
export async function documentFileUrl(db: Executor, storage: StorageProvider, o: { locationId: string; id: string }): Promise<{ url: string; expiresInSeconds: number }> {
  const d = await db
    .selectFrom('assistant_knowledge_documents')
    .select(['s3_key', 'filename', 'status'])
    .where('id', '=', o.id)
    .where('location_id', '=', o.locationId)
    .executeTakeFirst()
  if (!d || d.status === 'deleted') throw new AppError('NOT_FOUND', { detail: 'That document does not exist' })
  if (d.status === 'pending_upload') throw new AppError('DOCUMENT_NOT_READY')
  return { url: await storage.getDownloadUrl(d.s3_key, DOWNLOAD_TTL_SEC, { attachment: d.filename }), expiresInSeconds: DOWNLOAD_TTL_SEC }
}

export interface ExtractDeps {
  db: Db
  storage: ObjectStorage
  newId: () => string
  now: () => Date
  /** The shop's own numbers (kept in the warnings). */
  shopNumbers: readonly (string | null | undefined)[]
  limits?: Partial<PdfLimits>
}

/**
 * The extraction job's work: reads the PDF and either fails it with a plain reason or stores the cleaned text and creates its
 * knowledge entry (inactive, not reviewed, warnings computed). Only a document still `extracting` is read; a second run finds it
 * ready or failed and does nothing.
 */
export async function extractDocument(d: ExtractDeps, id: string): Promise<'ready' | DocumentError | 'skipped'> {
  const doc = await d.db.selectFrom('assistant_knowledge_documents').selectAll().where('id', '=', id).executeTakeFirst()
  if (!doc || doc.status !== 'extracting') return 'skipped'
  let bytes: Buffer
  try {
    bytes = await d.storage.get(doc.s3_key)
  } catch {
    return finishFailed(d, doc, 'corrupt')
  }
  const r = await extractPdf(bytes, d.limits)
  if (!r.ok) return finishFailed(d, doc, r.error, r.pageCount)
  return d.db.transaction().execute(async (tx) => {
    const cur = await tx.selectFrom('assistant_knowledge_documents').select('status').where('id', '=', id).forUpdate().executeTakeFirst()
    if (cur?.status !== 'extracting') return 'skipped' as const
    const now = d.now()
    await tx
      .updateTable('assistant_knowledge_documents')
      .set({ status: 'ready', error_code: null, page_count: r.pageCount, extracted_text: r.text, removed_chars: r.removedChars, updated_at: now })
      .where('id', '=', id)
      .execute()
    const title = doc.filename.slice(0, 120)
    const body = r.text.length > DOCUMENT_STORE_MAX ? r.text.slice(0, DOCUMENT_STORE_MAX) : r.text
    const warnings = entryWarnings({ title, body, kind: 'document' }, { shopNumbers: d.shopNumbers, removedChars: r.removedChars })
    if (r.removedTags > 0) warnings.unshift({ kind: 'markup', sample: `${r.removedTags} HTML-like tags removed`, line: 0 })
    const existing = await tx.selectFrom('assistant_knowledge').select('id').where('document_id', '=', id).executeTakeFirst()
    if (!existing)
      await tx
        .insertInto('assistant_knowledge')
        .values({
          id: d.newId(),
          location_id: doc.location_id,
          kind: 'document',
          title,
          body,
          question: null,
          wrong_reply: null,
          source: 'manual',
          assistant_turn_id: null,
          practice_turn_id: null,
          document_id: id,
          active: false,
          reviewed_at: null,
          warnings: JSON.stringify(warnings.slice(0, 50)),
          chars: entryChars({ title, body }),
          created_by: doc.uploaded_by,
          updated_by: doc.uploaded_by,
          created_at: now,
          updated_at: now,
        })
        .execute()
    await audit.record(tx, {
      locationId: doc.location_id,
      action: 'assistant.document.extract',
      entityType: 'assistant_knowledge_document',
      entityId: id,
      after: { status: 'ready', pageCount: r.pageCount, chars: r.text.length, removedChars: r.removedChars, cut: r.cut || r.text.length > DOCUMENT_STORE_MAX },
      ctx: { actor: { name: 'Oasis AI (knowledge)' } },
    })
    await publishKnowledge(tx, doc.location_id)
    return 'ready' as const
  })
}

async function finishFailed(
  d: Pick<ExtractDeps, 'db' | 'now'>,
  doc: { id: string; location_id: string },
  error: DocumentError,
  pageCount?: number,
): Promise<DocumentError | 'skipped'> {
  return d.db.transaction().execute(async (tx) => {
    const n = await tx
      .updateTable('assistant_knowledge_documents')
      .set({ status: 'failed', error_code: error, ...(pageCount !== undefined ? { page_count: pageCount } : {}), updated_at: d.now() })
      .where('id', '=', doc.id)
      .where('status', '=', 'extracting')
      .returning('id')
      .execute()
    if (n.length === 0) return 'skipped' as const
    await audit.record(tx, {
      locationId: doc.location_id,
      action: 'assistant.document.extract',
      entityType: 'assistant_knowledge_document',
      entityId: doc.id,
      after: { status: 'failed', error },
      ctx: { actor: { name: 'Oasis AI (knowledge)' } },
    })
    await publishKnowledge(tx, doc.location_id)
    return error
  })
}

/** The cleanup job's work (every 15 minutes). */
export async function cleanupDocuments(db: Db, storage: StorageProvider, now: Date): Promise<{ abandoned: number; stuck: number; objects: number }> {
  let abandoned = 0
  let objects = 0
  const pending = await db
    .selectFrom('assistant_knowledge_documents')
    .select(['id', 's3_key'])
    .where('status', '=', 'pending_upload')
    .where('updated_at', '<', new Date(now.getTime() - PENDING_UPLOAD_TTL_MS))
    .limit(200)
    .execute()
  for (const p of pending) {
    try {
      await storage.delete(p.s3_key)
    } catch {
      continue
    }
    const r = await db.deleteFrom('assistant_knowledge_documents').where('id', '=', p.id).where('status', '=', 'pending_upload').returning('id').execute()
    abandoned += r.length
  }
  const stuck = await db
    .updateTable('assistant_knowledge_documents')
    .set({ status: 'failed', error_code: 'timeout', updated_at: now })
    .where('status', '=', 'extracting')
    .where('updated_at', '<', new Date(now.getTime() - STUCK_EXTRACTION_MS))
    .returning('id')
    .execute()
  const gone = await db
    .selectFrom('assistant_knowledge_documents')
    .select(['id', 's3_key'])
    .where('status', '=', 'deleted')
    .where('object_deleted_at', 'is', null)
    .limit(200)
    .execute()
  for (const g of gone) if (await removeObject(db, storage, { documentId: g.id, key: g.s3_key, now })) objects += 1
  return { abandoned, stuck: stuck.length, objects }
}
