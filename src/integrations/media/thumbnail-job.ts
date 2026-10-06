import { thumbKeyFor } from '../storage/keys.js'
import { MAX_UPLOAD_BYTES, type ObjectStorage } from '../storage/types.js'
import { MediaError } from './errors.js'
import type { ThumbnailService } from './thumbnail.js'

export type ThumbnailResult =
  | { status: 'created'; thumbKey: string; width: number; height: number; bytes: number }
  | { status: 'skipped'; reason: 'sharp-unavailable' | 'decode-failed' }
  | { status: 'invalid'; code: MediaError['code']; message: string }
  | { status: 'missing' }

/**
 * Body of the `photos.thumbnail` job: read the original, write `{photoId}.thumb.webp` beside it.
 * Invalid images are reported, not thrown, so the queue does not retry a file that can never succeed.
 */
export async function generateAndStoreThumbnail(
  storage: ObjectStorage,
  service: ThumbnailService,
  key: string,
): Promise<ThumbnailResult> {
  const head = await storage.head(key)
  if (!head) return { status: 'missing' }
  if (head.bytes > MAX_UPLOAD_BYTES)
    return { status: 'invalid', code: 'TOO_LARGE', message: 'object exceeds the 15 MB limit' }
  const original = await storage.get(key)
  let thumb
  try {
    thumb = await service.create(original, head.contentType)
  } catch (e) {
    if (e instanceof MediaError) return { status: 'invalid', code: e.code, message: e.message }
    throw e
  }
  if (!thumb)
    return { status: 'skipped', reason: (await service.available()) ? 'decode-failed' : 'sharp-unavailable' }
  const thumbKey = thumbKeyFor(key)
  await storage.put(thumbKey, thumb.data, thumb.contentType)
  return { status: 'created', thumbKey, width: thumb.width, height: thumb.height, bytes: thumb.data.length }
}
