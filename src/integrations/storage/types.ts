import type { StorageProvider } from '../ports/storage.js'

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024
export const UPLOAD_TTL_SEC = 5 * 60
export const DOWNLOAD_TTL_SEC = 10 * 60
/** Hard ceiling for any presigned URL this module will mint. */
export const MAX_TTL_SEC = 60 * 60

export const PHOTO_CATEGORIES = ['arrival', 'before', 'after', 'issue'] as const
export type PhotoCategory = (typeof PHOTO_CATEGORIES)[number]

/** Content types accepted for photos, mapped to the key extension. HEIC/HEIF are deliberately absent. */
export const PHOTO_TYPES: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

const HEIC_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'])

export type StorageErrorCode =
  | 'HEIC_NOT_SUPPORTED'
  | 'UNSUPPORTED_TYPE'
  | 'TOO_LARGE'
  | 'TOO_SMALL'
  | 'INVALID_KEY'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'BAD_SIGNATURE'
  | 'CONTENT_MISMATCH'
  | 'PROVIDER_ERROR'

export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    opts: { cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause })
    this.name = 'StorageError'
  }
}

export const HEIC_MESSAGE =
  'HEIC/HEIF photos are not accepted by the server. Convert the photo to JPEG on the device before uploading ' +
  '(the dashboard does this in the browser), or set the camera format to "Most Compatible".'

/** Lowercased media type without parameters. */
export function normalizeContentType(ct: string): string {
  return (ct.split(';')[0] ?? '').trim().toLowerCase()
}

export function assertAllowedContentType(
  contentType: string,
  allowed: Readonly<Record<string, string>> = PHOTO_TYPES,
): string {
  const ct = normalizeContentType(contentType)
  if (HEIC_TYPES.has(ct)) throw new StorageError('HEIC_NOT_SUPPORTED', HEIC_MESSAGE)
  if (!Object.hasOwn(allowed, ct)) {
    throw new StorageError(
      'UNSUPPORTED_TYPE',
      `Content type "${ct || contentType}" is not allowed. Allowed: ${Object.keys(allowed).join(', ')}.`,
    )
  }
  return ct
}

export interface UploadRequest {
  key: string
  contentType: string
  maxBytes: number
  ttlSec: number
}

export function assertTtl(ttlSec: number, what = 'ttlSec'): void {
  if (!Number.isInteger(ttlSec) || ttlSec < 1 || ttlSec > MAX_TTL_SEC) {
    throw new StorageError('INVALID_ARGUMENT', `${what} must be an integer between 1 and ${MAX_TTL_SEC}`)
  }
}

export function assertUploadRequest(p: UploadRequest, allowed = PHOTO_TYPES): string {
  const ct = assertAllowedContentType(p.contentType, allowed)
  if (!Number.isInteger(p.maxBytes) || p.maxBytes < 1) {
    throw new StorageError('INVALID_ARGUMENT', 'maxBytes must be a positive integer')
  }
  if (p.maxBytes > MAX_UPLOAD_BYTES) {
    throw new StorageError('TOO_LARGE', `maxBytes may not exceed ${MAX_UPLOAD_BYTES} (15 MB)`)
  }
  assertTtl(p.ttlSec)
  return ct
}

/** Port plus the byte-level access the thumbnail job needs (the base port only deals in URLs). */
export interface ObjectStorage extends StorageProvider {
  get(key: string): Promise<Buffer>
  put(key: string, body: Buffer, contentType: string): Promise<void>
}
