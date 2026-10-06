// Photo metadata and the presign flow (backend design 7.4). The bytes never touch the API: presign returns a presigned
// POST with a size policy (HEIC is rejected; the dashboard converts on the device), the client uploads straight to the
// bucket, then `complete` verifies the object with a HEAD and marks it ready. Thumbnails are produced by a job.
import type { Executor, Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { isUuid } from '../../platform/ids.js'
import type { StorageProvider, UploadSlot } from '../../integrations/ports/storage.js'
import { buildPhotoKey } from '../../integrations/storage/keys.js'
import {
  DOWNLOAD_TTL_SEC,
  MAX_UPLOAD_BYTES,
  PHOTO_CATEGORIES,
  StorageError,
  UPLOAD_TTL_SEC,
  assertAllowedContentType,
  normalizeContentType,
  type PhotoCategory,
} from '../../integrations/storage/types.js'
import '../customers/schema.js'
import { invalidTransition, lockAppointment, logActivity, publishOps } from './appointments.js'
import { audit } from './audit-helper.js'
import type { Actor, SchedulingCtx } from './context.js'

export type { PhotoCategory }
export const photoCategories = PHOTO_CATEGORIES

export interface PhotoView {
  id: string
  category: PhotoCategory
  note: string | null
  bytes: number | null
  takenAt: string
  /** Presigned GET of the thumbnail (the original while no thumbnail exists yet); null for a note. */
  thumbUrl: string | null
  url: string | null
}

export interface PhotoCategorySummary {
  /** Photos (and for issues, notes) in the category. */
  count: number
  items: PhotoView[]
}

export type PhotoSummary = Record<PhotoCategory, PhotoCategorySummary>

const invalid = (path: string, message: string): AppError =>
  new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path, message }] })

function mapStorageError(e: unknown, path: string): never {
  if (e instanceof StorageError) throw invalid(path, e.message)
  throw e
}

async function guardPhotoEdit(tx: Tx, c: SchedulingCtx, appointmentId: string): Promise<void> {
  const a = await lockAppointment(tx, c.locationId, appointmentId)
  if (a.status === 'canceled' || a.status === 'no_show') throw invalidTransition(a)
}

export interface PresignInput {
  category: PhotoCategory
  contentType: string
  bytes: number
  note?: string | null
}

export async function presignPhoto(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  appointmentId: string,
  input: PresignInput,
): Promise<{ photoId: string; upload: UploadSlot }> {
  if (!PHOTO_CATEGORIES.includes(input.category)) throw invalid('category', 'Pick arrival, before, after or issue.')
  if (!Number.isInteger(input.bytes) || input.bytes < 1 || input.bytes > MAX_UPLOAD_BYTES)
    throw invalid('bytes', `Photos can be up to ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`)
  let contentType: string
  try {
    contentType = assertAllowedContentType(input.contentType)
  } catch (e) {
    mapStorageError(e, 'contentType')
  }
  await guardPhotoEdit(tx, c, appointmentId)
  const photoId = c.newId()
  const key = buildPhotoKey({
    locationId: c.locationId,
    apptId: appointmentId,
    category: input.category,
    photoId,
    contentType,
  })
  await tx
    .insertInto('appointment_photos')
    .values({
      id: photoId,
      appointment_id: appointmentId,
      category: input.category,
      s3_key: key,
      thumb_key: null,
      content_type: contentType,
      bytes: input.bytes,
      note: input.note?.trim() ? input.note.trim() : null,
      status: 'pending_upload',
      taken_at: c.clock.now(),
      uploaded_by: actor.auth.userId,
    })
    .execute()
  let upload: UploadSlot
  try {
    upload = await c.ports.storage.createUpload({
      key,
      contentType,
      maxBytes: MAX_UPLOAD_BYTES,
      ttlSec: UPLOAD_TTL_SEC,
    })
  } catch (e) {
    mapStorageError(e, 'contentType')
  }
  return { photoId, upload }
}

/** Verifies the uploaded object (size and type) and marks the photo ready. */
export async function completePhoto(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  appointmentId: string,
  photoId: string,
): Promise<{ photo: { id: string; category: PhotoCategory; key: string; bytes: number } }> {
  await guardPhotoEdit(tx, c, appointmentId)
  const row = isUuid(photoId)
    ? await tx
        .selectFrom('appointment_photos')
        .select(['id', 'category', 's3_key', 'content_type', 'status'])
        .where('id', '=', photoId)
        .where('appointment_id', '=', appointmentId)
        .forUpdate()
        .executeTakeFirst()
    : undefined
  if (!row || row.status === 'deleted' || !row.s3_key) throw new AppError('NOT_FOUND', { detail: 'That photo does not exist' })
  const head = await c.ports.storage.head(row.s3_key)
  if (!head) throw invalid('photoId', 'The file has not been uploaded yet.')
  if (head.bytes > MAX_UPLOAD_BYTES || head.bytes < 1)
    throw invalid('photoId', `Photos can be up to ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`)
  if (row.content_type && normalizeContentType(head.contentType) !== normalizeContentType(row.content_type))
    throw invalid('photoId', 'The uploaded file is not the type that was announced.')
  if (row.status !== 'ready') {
    await tx
      .updateTable('appointment_photos')
      .set({ status: 'ready', bytes: head.bytes })
      .where('id', '=', row.id)
      .execute()
    await logActivity(tx, c, {
      appointmentId,
      text: `Photo added · ${row.category}`,
      channels: ['internal'],
      actor,
    })
    await audit(tx, c, actor, 'photo.add', appointmentId, null, { photoId: row.id, category: row.category })
    const a = await tx.selectFrom('appointments').select(['version', 'status']).where('id', '=', appointmentId).executeTakeFirstOrThrow()
    await publishOps(tx, c.locationId, {
      kpi: false,
      appointment: { id: appointmentId, version: a.version, status: a.status, change: 'photo' },
    })
  }
  return { photo: { id: row.id, category: row.category, key: row.s3_key, bytes: head.bytes } }
}

/** A written issue note with no file ("N notes" in the design). */
export async function addIssueNote(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  appointmentId: string,
  note: string,
): Promise<{ photoId: string }> {
  const text = note.trim()
  if (text === '') throw invalid('note', 'Write what you found.')
  await guardPhotoEdit(tx, c, appointmentId)
  const photoId = c.newId()
  await tx
    .insertInto('appointment_photos')
    .values({
      id: photoId,
      appointment_id: appointmentId,
      category: 'issue',
      s3_key: null,
      thumb_key: null,
      content_type: null,
      bytes: null,
      note: text,
      status: 'ready',
      taken_at: c.clock.now(),
      uploaded_by: actor.auth.userId,
    })
    .execute()
  await logActivity(tx, c, { appointmentId, text: 'Issue noted', channels: ['internal'], actor, meta: { photoId } })
  await audit(tx, c, actor, 'photo.note', appointmentId, null, { photoId })
  return { photoId }
}

/** Soft delete; the caller removes the objects after the transaction commits. */
export async function deletePhoto(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  appointmentId: string,
  photoId: string,
): Promise<{ keys: string[] }> {
  await guardPhotoEdit(tx, c, appointmentId)
  const row = isUuid(photoId)
    ? await tx
        .selectFrom('appointment_photos')
        .select(['id', 'category', 's3_key', 'thumb_key', 'status'])
        .where('id', '=', photoId)
        .where('appointment_id', '=', appointmentId)
        .forUpdate()
        .executeTakeFirst()
    : undefined
  if (!row || row.status === 'deleted') throw new AppError('NOT_FOUND', { detail: 'That photo does not exist' })
  await tx.updateTable('appointment_photos').set({ status: 'deleted' }).where('id', '=', row.id).execute()
  await logActivity(tx, c, { appointmentId, text: `Photo removed · ${row.category}`, channels: ['internal'], actor })
  await audit(tx, c, actor, 'photo.delete', appointmentId, { photoId: row.id }, null)
  return { keys: [row.s3_key, row.thumb_key].filter((k): k is string => k !== null) }
}

/** Counts and presigned thumbnails per category for the appointment file. */
export async function photoSummary(
  db: Executor,
  storage: StorageProvider,
  appointmentId: string,
): Promise<PhotoSummary> {
  const rows = await db
    .selectFrom('appointment_photos')
    .select(['id', 'category', 's3_key', 'thumb_key', 'note', 'bytes', 'taken_at'])
    .where('appointment_id', '=', appointmentId)
    .where('status', '=', 'ready')
    .orderBy('taken_at')
    .orderBy('id')
    .execute()
  const out: PhotoSummary = {
    arrival: { count: 0, items: [] },
    before: { count: 0, items: [] },
    after: { count: 0, items: [] },
    issue: { count: 0, items: [] },
  }
  for (const r of rows) {
    const key = r.thumb_key ?? r.s3_key
    out[r.category].count += 1
    out[r.category].items.push({
      id: r.id,
      category: r.category,
      note: r.note,
      bytes: r.bytes,
      takenAt: r.taken_at.toISOString(),
      thumbUrl: key ? await storage.getDownloadUrl(key, DOWNLOAD_TTL_SEC) : null,
      url: r.s3_key ? await storage.getDownloadUrl(r.s3_key, DOWNLOAD_TTL_SEC) : null,
    })
  }
  return out
}

/** Photo counts per category (cards only need to know whether before/after exist). */
export async function photoCounts(
  db: Executor,
  appointmentIds: string[],
): Promise<Map<string, Record<PhotoCategory, number>>> {
  const out = new Map<string, Record<PhotoCategory, number>>()
  if (appointmentIds.length === 0) return out
  const rows = await db
    .selectFrom('appointment_photos')
    .select(['appointment_id', 'category'])
    .where('appointment_id', 'in', appointmentIds)
    .where('status', '=', 'ready')
    .execute()
  for (const r of rows) {
    const cur = out.get(r.appointment_id) ?? { arrival: 0, before: 0, after: 0, issue: 0 }
    cur[r.category] += 1
    out.set(r.appointment_id, cur)
  }
  return out
}
