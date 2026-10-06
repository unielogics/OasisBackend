// Photo housekeeping jobs: thumbnails for uploaded photos and removal of uploads that were never completed.
import { sql } from 'kysely'
import { loadEnv } from '../../config/env.js'
import { createStorageProvider } from '../../integrations/storage/config.js'
import { ThumbnailService } from '../../integrations/media/thumbnail.js'
import { generateAndStoreThumbnail } from '../../integrations/media/thumbnail-job.js'
import type { JobDefinition } from '../../platform/jobs.js'
import '../customers/schema.js'

export const thumbnailJobName = 'photos.thumbnail'
export const finalizeJobName = 'photos.finalize'

/** An upload that is still pending after this long was abandoned. */
export const PENDING_UPLOAD_TTL_MS = 15 * 60_000

export const photoThumbnailJob: JobDefinition<{ photoId: string }> = {
  name: thumbnailJobName,
  policy: 'short',
  retryLimit: 3,
  async handler(ctx, data) {
    const row = await ctx.db
      .selectFrom('appointment_photos')
      .select(['id', 's3_key', 'status'])
      .where('id', '=', data.photoId)
      .executeTakeFirst()
    if (!row || row.status !== 'ready' || !row.s3_key) return
    const storage = createStorageProvider(loadEnv(), { clock: ctx.clock })
    const r = await generateAndStoreThumbnail(storage, new ThumbnailService(), row.s3_key)
    if (r.status === 'created')
      await ctx.db
        .updateTable('appointment_photos')
        .set({ thumb_key: r.thumbKey })
        .where('id', '=', row.id)
        .execute()
    else ctx.logger.warn({ photoId: row.id, result: r.status }, 'photo thumbnail not created')
  },
}

export async function finalizePendingUploads(
  db: Parameters<JobDefinition['handler']>[0]['db'],
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - PENDING_UPLOAD_TTL_MS)
  const r = await db
    .updateTable('appointment_photos')
    .set({ status: 'deleted' })
    .where('status', '=', 'pending_upload')
    .where('created_at', '<', cutoff)
    .returning(sql<string>`id`.as('id'))
    .execute()
  return r.length
}

export const photoFinalizeJob: JobDefinition = {
  name: finalizeJobName,
  policy: 'short',
  cron: '*/15 * * * *',
  async handler(ctx) {
    const n = await finalizePendingUploads(ctx.db, ctx.clock.now())
    if (n > 0) ctx.logger.info({ removed: n }, 'abandoned photo uploads removed')
  },
}
