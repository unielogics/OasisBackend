// photos.retention: object-storage clean-up for appointment photos, daily.
//   - a photo that was deleted (or abandoned before the upload completed) has its original and thumbnail removed from
//     storage and its row deleted (a photo row cannot exist without its key);
//   - a photo older than 24 months is removed from storage and its row deleted.
// Storage first, row second: a crash between the two repeats a delete of an object that is already gone, which both
// storage providers treat as success, so a rerun finishes the work and never loses a row whose object still exists.
import { loadEnv } from '../../config/env.js'
import { createStorageProvider } from '../../integrations/storage/config.js'
import type { StorageProvider } from '../../integrations/ports/storage.js'
import type { Clock } from '../../platform/clock.js'
import type { Db } from '../../platform/db.js'
import type { JobDefinition } from '../../platform/jobs.js'
import { monthsBefore } from '../../platform/maintenance.js'
import '../customers/schema.js'

export const PHOTO_RETENTION_JOB = 'photos.retention'
export const PHOTO_RETENTION_MONTHS = 24
const BATCH = 200
const MAX_BATCHES = 25

export interface PhotoRetentionResult {
  deletedRemoved: number
  expiredRemoved: number
  objectsDeleted: number
  failures: number
  /** The first storage or database error of the run, for the log (never a key or a customer detail). */
  firstError?: string
}

type Photo = { id: string; s3_key: string | null; thumb_key: string | null }

async function removeObjects(storage: Pick<StorageProvider, 'delete'>, p: Photo): Promise<number> {
  let n = 0
  for (const key of [p.s3_key, p.thumb_key]) {
    if (!key) continue
    await storage.delete(key)
    n += 1
  }
  return n
}

export async function runPhotoRetention(
  db: Db,
  clock: Clock,
  storage: Pick<StorageProvider, 'delete'>,
): Promise<PhotoRetentionResult> {
  const out: PhotoRetentionResult = {
    deletedRemoved: 0,
    expiredRemoved: 0,
    objectsDeleted: 0,
    failures: 0,
  }
  const cutoff = monthsBefore(clock.now(), PHOTO_RETENTION_MONTHS)

  for (let i = 0; i < MAX_BATCHES; i++) {
    const rows = await db
      .selectFrom('appointment_photos')
      .select(['id', 's3_key', 'thumb_key'])
      .where('status', '=', 'deleted')
      .where((eb) => eb.or([eb('s3_key', 'is not', null), eb('thumb_key', 'is not', null)]))
      .orderBy('created_at')
      .orderBy('id')
      .limit(BATCH)
      .execute()
    let progressed = 0
    for (const p of rows) {
      try {
        out.objectsDeleted += await removeObjects(storage, p)
        await db.deleteFrom('appointment_photos').where('id', '=', p.id).execute()
        out.deletedRemoved += 1
        progressed += 1
      } catch (e) {
        out.failures += 1
        out.firstError ??= (e as Error).message
      }
    }
    if (rows.length < BATCH || progressed === 0) break
  }

  for (let i = 0; i < MAX_BATCHES; i++) {
    const rows = await db
      .selectFrom('appointment_photos')
      .select(['id', 's3_key', 'thumb_key'])
      .where('created_at', '<', cutoff)
      .orderBy('created_at')
      .orderBy('id')
      .limit(BATCH)
      .execute()
    let progressed = 0
    for (const p of rows) {
      try {
        out.objectsDeleted += await removeObjects(storage, p)
        await db.deleteFrom('appointment_photos').where('id', '=', p.id).execute()
        out.expiredRemoved += 1
        progressed += 1
      } catch (e) {
        out.failures += 1
        out.firstError ??= (e as Error).message
      }
    }
    if (rows.length < BATCH || progressed === 0) break
  }
  return out
}

export const photoRetentionJob: JobDefinition = {
  name: PHOTO_RETENTION_JOB,
  cron: '20 4 * * *',
  policy: 'short',
  retryLimit: 2,
  retryDelaySeconds: 300,
  expireInSeconds: 30 * 60,
  async handler(ctx) {
    const storage = createStorageProvider(loadEnv(), { clock: ctx.clock })
    const r = await runPhotoRetention(ctx.db, ctx.clock, storage)
    ctx.logger.info(r, 'photos.retention done')
    // done is only reported when nothing was left behind, so a storage outage retries and then dead-letters
    if (r.failures > 0)
      throw new Error(
        `${r.failures} photo(s) could not be removed from storage: ${r.firstError ?? 'unknown error'}`,
      )
  },
}
