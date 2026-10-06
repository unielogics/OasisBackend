import {
  PHOTO_CATEGORIES,
  PHOTO_TYPES,
  StorageError,
  assertAllowedContentType,
  type PhotoCategory,
} from './types.js'

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

function segment(name: string, v: string): string {
  if (!SEGMENT.test(v))
    throw new StorageError('INVALID_KEY', `${name} must match ${SEGMENT} (got "${v.slice(0, 40)}")`)
  return v
}

export interface PhotoKeyParts {
  locationId: string
  apptId: string
  category: PhotoCategory
  photoId: string
  contentType: string
}

/** loc/{locationId}/appt/{apptId}/{category}/{photoId}.{ext}; the extension comes from the validated content type. */
export function buildPhotoKey(p: PhotoKeyParts): string {
  if (!(PHOTO_CATEGORIES as readonly string[]).includes(p.category)) {
    throw new StorageError('INVALID_KEY', `category must be one of ${PHOTO_CATEGORIES.join(', ')}`)
  }
  const ext = PHOTO_TYPES[assertAllowedContentType(p.contentType)]
  return `loc/${segment('locationId', p.locationId)}/appt/${segment('apptId', p.apptId)}/${p.category}/${segment('photoId', p.photoId)}.${ext}`
}

/** The thumbnail sits next to the original: .../{photoId}.thumb.webp */
export function thumbKeyFor(photoKey: string): string {
  assertSafeKey(photoKey)
  const i = photoKey.lastIndexOf('.')
  if (i <= photoKey.lastIndexOf('/')) throw new StorageError('INVALID_KEY', 'key has no extension')
  return `${photoKey.slice(0, i)}.thumb.webp`
}

const PHOTO_KEY =
  /^loc\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/appt\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/(arrival|before|after|issue)\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.(jpg|png|webp)$/

export function parsePhotoKey(
  key: string,
): { locationId: string; apptId: string; category: PhotoCategory; photoId: string; ext: string } | null {
  const m = PHOTO_KEY.exec(key)
  return m
    ? { locationId: m[1]!, apptId: m[2]!, category: m[3] as PhotoCategory, photoId: m[4]!, ext: m[5]! }
    : null
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,511}$/

/** Defence in depth for every provider call: no traversal, no empty or dot segments, bounded charset. */
export function assertSafeKey(key: string): string {
  if (
    !SAFE_KEY.test(key) ||
    key.includes('//') ||
    key.split('/').some((s) => s === '' || s === '.' || s === '..')
  ) {
    throw new StorageError('INVALID_KEY', 'storage key is not valid')
  }
  return key
}

/** Prefix control: normalises an environment prefix to "" or "name/" and validates it. */
export function normalizePrefix(prefix: string): string {
  const p = prefix.trim().replace(/^\/+|\/+$/g, '')
  if (!p) return ''
  assertSafeKey(`${p}/x`)
  return `${p}/`
}
