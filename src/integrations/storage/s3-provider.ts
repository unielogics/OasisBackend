import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3'
import { createPresignedPost } from '@aws-sdk/s3-presigned-post'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { UploadSlot } from '../ports/storage.js'
import { assertSafeKey, normalizePrefix } from './keys.js'
import {
  MAX_UPLOAD_BYTES,
  PHOTO_TYPES,
  StorageError,
  assertAllowedContentType,
  assertTtl,
  assertUploadRequest,
  type ObjectStorage,
  type UploadRequest,
} from './types.js'

export interface S3StorageOptions {
  client: S3Client
  bucket: string
  /** Prepended to every key inside the bucket ("prod/", "staging/"); callers only ever see the logical key. */
  keyPrefix?: string
  /** Server-side encryption requested per object. Leave unset when the bucket default encryption (SSE-S3) is enough. */
  sse?: { mode: 'AES256' } | { mode: 'aws:kms'; kmsKeyId?: string }
  allowedContentTypes?: Readonly<Record<string, string>>
}

const NOT_FOUND = new Set(['NotFound', 'NoSuchKey', 'NoSuchBucket'])

function wrap(op: string, err: unknown): StorageError {
  if (err instanceof StorageError) return err
  const e = err as { name?: string; message?: string }
  return new StorageError(
    'PROVIDER_ERROR',
    `S3 ${op} failed (${e.name ?? 'Error'}: ${e.message ?? 'unknown'})`,
    { cause: err },
  )
}

/**
 * S3 adapter. Presigning uses the real wall clock on purpose: S3 validates request dates against its own clock,
 * so an injected/frozen Clock would produce URLs S3 rejects.
 */
export class S3Storage implements ObjectStorage {
  private readonly client: S3Client
  private readonly bucket: string
  private readonly prefix: string
  private readonly sse: S3StorageOptions['sse']
  private readonly allowed: Readonly<Record<string, string>>

  constructor(opts: S3StorageOptions) {
    if (!opts.bucket) throw new StorageError('INVALID_ARGUMENT', 'S3 bucket name is required')
    this.client = opts.client
    this.bucket = opts.bucket
    this.prefix = normalizePrefix(opts.keyPrefix ?? '')
    this.sse = opts.sse
    this.allowed = opts.allowedContentTypes ?? PHOTO_TYPES
  }

  private k(key: string): string {
    return this.prefix + assertSafeKey(key)
  }

  async createUpload(p: UploadRequest): Promise<UploadSlot> {
    const contentType = assertUploadRequest(p, this.allowed)
    const fullKey = this.k(p.key)
    const fields: Record<string, string> = { 'Content-Type': contentType }
    const conditions: Array<['content-length-range', number, number] | ['eq', string, string]> = [
      ['content-length-range', 1, p.maxBytes],
      ['eq', '$Content-Type', contentType],
    ]
    if (this.sse) {
      fields['x-amz-server-side-encryption'] = this.sse.mode
      conditions.push(['eq', '$x-amz-server-side-encryption', this.sse.mode])
      if (this.sse.mode === 'aws:kms' && this.sse.kmsKeyId) {
        fields['x-amz-server-side-encryption-aws-kms-key-id'] = this.sse.kmsKeyId
        conditions.push(['eq', '$x-amz-server-side-encryption-aws-kms-key-id', this.sse.kmsKeyId])
      }
    }
    let post
    try {
      post = await createPresignedPost(this.client, {
        Bucket: this.bucket,
        Key: fullKey,
        Expires: p.ttlSec,
        Conditions: conditions,
        Fields: fields,
      })
    } catch (err) {
      throw wrap('createPresignedPost', err)
    }
    // Report the expiry the signed policy actually enforces (it is computed from the real clock inside the SDK).
    const policy = JSON.parse(Buffer.from(post.fields.Policy ?? '', 'base64').toString('utf8')) as {
      expiration: string
    }
    return { key: p.key, url: post.url, fields: post.fields, expiresAt: new Date(policy.expiration) }
  }

  async head(key: string): Promise<{ bytes: number; contentType: string } | null> {
    const Key = this.k(key)
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key }))
      return { bytes: out.ContentLength ?? 0, contentType: out.ContentType ?? 'application/octet-stream' }
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
      if (NOT_FOUND.has(e.name ?? '') || e.$metadata?.httpStatusCode === 404) return null
      throw wrap('HeadObject', err)
    }
  }

  async getDownloadUrl(key: string, ttlSec: number): Promise<string> {
    assertTtl(ttlSec)
    const Key = this.k(key)
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.bucket,
          Key,
          ResponseContentDisposition: 'inline',
          ResponseCacheControl: `private, max-age=${ttlSec}`,
        }),
        { expiresIn: ttlSec },
      )
    } catch (err) {
      throw wrap('presign GetObject', err)
    }
  }

  async delete(key: string): Promise<void> {
    const Key = this.k(key)
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key }))
    } catch (err) {
      throw wrap('DeleteObject', err)
    }
  }

  async get(key: string): Promise<Buffer> {
    const Key = this.k(key)
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key }))
      if ((out.ContentLength ?? 0) > MAX_UPLOAD_BYTES)
        throw new StorageError('TOO_LARGE', 'object exceeds the 15 MB limit')
      if (!out.Body) throw new StorageError('NOT_FOUND', 'object has no body')
      return Buffer.from(await out.Body.transformToByteArray())
    } catch (err) {
      if (err instanceof StorageError) throw err
      const e = err as { name?: string }
      if (NOT_FOUND.has(e.name ?? ''))
        throw new StorageError('NOT_FOUND', 'object does not exist', { cause: err })
      throw wrap('GetObject', err)
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const ct = assertAllowedContentType(contentType, this.allowed)
    if (body.length > MAX_UPLOAD_BYTES) throw new StorageError('TOO_LARGE', 'object exceeds the 15 MB limit')
    const Key = this.k(key)
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key,
          Body: body,
          ContentType: ct,
          ContentLength: body.length,
          ...(this.sse
            ? {
                ServerSideEncryption: this.sse.mode,
                ...(this.sse.mode === 'aws:kms' && this.sse.kmsKeyId
                  ? { SSEKMSKeyId: this.sse.kmsKeyId }
                  : {}),
              }
            : {}),
        }),
      )
    } catch (err) {
      throw wrap('PutObject', err)
    }
  }
}
