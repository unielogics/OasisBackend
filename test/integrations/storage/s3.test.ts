import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import { beforeEach, describe, expect, it } from 'vitest'
import { S3Storage } from '../../../src/integrations/storage/s3-provider.js'
import { createStorageProvider } from '../../../src/integrations/storage/config.js'
import { FsStorage } from '../../../src/integrations/storage/fs-provider.js'
import {
  DOWNLOAD_TTL_SEC,
  MAX_UPLOAD_BYTES,
  UPLOAD_TTL_SEC,
} from '../../../src/integrations/storage/types.js'

const KEY = 'loc/l1/appt/a1/before/p1.jpg'
// Static dummy credentials: the default provider chain (and therefore any metadata-service lookup) is never used.
const client = () =>
  new S3Client({
    region: 'us-east-1',
    credentials: { accessKeyId: 'AKIATESTTESTTEST', secretAccessKey: 'secret' },
  })
// Minimal stand-in for the SDK's streaming blob body.
const body = (b: Buffer) => ({ transformToByteArray: async () => new Uint8Array(b) }) as never
const s3 = mockClient(S3Client)
beforeEach(() => s3.reset())

type Cond =
  ['content-length-range', number, number] | ['eq' | 'starts-with', string, string] | Record<string, string>
const decodePolicy = (fields: Record<string, string>) =>
  JSON.parse(Buffer.from(fields.Policy!, 'base64').toString('utf8')) as {
    expiration: string
    conditions: Cond[]
  }

/** What S3 does with a POST: every submitted field (except file/policy/signature) needs a matching condition, and all must hold. */
function s3Accepts(
  fields: Record<string, string>,
  fileBytes: number,
  now = new Date(),
): { ok: boolean; why?: string } {
  const policy = decodePolicy(fields)
  if (now >= new Date(policy.expiration)) return { ok: false, why: 'expired' }
  const matched = new Set<string>()
  const lower = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k.toLowerCase(), v]))
  for (const c of policy.conditions) {
    if (Array.isArray(c)) {
      if (c[0] === 'content-length-range') {
        if (fileBytes < c[1] || fileBytes > c[2]) return { ok: false, why: 'size' }
      } else {
        const name = c[1].replace(/^\$/, '').toLowerCase()
        const v = lower[name]
        if (v === undefined) return { ok: false, why: `missing ${name}` }
        if (c[0] === 'eq' ? v !== c[2] : !v.startsWith(c[2])) return { ok: false, why: `mismatch ${name}` }
        matched.add(name)
      }
    } else {
      for (const [k, val] of Object.entries(c)) {
        if (lower[k.toLowerCase()] !== val) return { ok: false, why: `mismatch ${k}` }
        matched.add(k.toLowerCase())
      }
    }
  }
  for (const name of Object.keys(lower)) {
    if (['policy', 'x-amz-signature', 'file'].includes(name)) continue
    if (!matched.has(name)) return { ok: false, why: `no condition for ${name}` }
  }
  return { ok: true }
}

describe('S3Storage.createUpload (presigned POST)', () => {
  const make = (extra: Partial<ConstructorParameters<typeof S3Storage>[0]> = {}) =>
    new S3Storage({ client: client(), bucket: 'oasis-photos', ...extra })

  it('signs a policy with size range, exact content type, bucket and key', async () => {
    const slot = await make().createUpload({
      key: KEY,
      contentType: 'image/jpeg',
      maxBytes: 2_000_000,
      ttlSec: UPLOAD_TTL_SEC,
    })
    expect(slot.key).toBe(KEY)
    expect(slot.url).toMatch(
      /^https:\/\/(oasis-photos\.s3\.us-east-1\.amazonaws\.com|s3\.us-east-1\.amazonaws\.com\/oasis-photos)\/?$/,
    )
    expect(slot.fields).toMatchObject({
      key: KEY,
      'Content-Type': 'image/jpeg',
      bucket: 'oasis-photos',
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    })
    expect(slot.fields['X-Amz-Credential']).toMatch(/^AKIATESTTESTTEST\/\d{8}\/us-east-1\/s3\/aws4_request$/)
    expect(slot.fields['X-Amz-Signature']).toMatch(/^[0-9a-f]{64}$/)

    const policy = decodePolicy(slot.fields)
    expect(policy.conditions).toContainEqual(['content-length-range', 1, 2_000_000])
    expect(policy.conditions).toContainEqual(['eq', '$Content-Type', 'image/jpeg'])
    expect(policy.conditions).toContainEqual({ key: KEY })
    expect(policy.conditions).toContainEqual({ bucket: 'oasis-photos' })
  })

  it('expires five minutes out and reports the enforced expiry', async () => {
    const before = Date.now()
    const slot = await make().createUpload({
      key: KEY,
      contentType: 'image/png',
      maxBytes: 1000,
      ttlSec: UPLOAD_TTL_SEC,
    })
    expect(slot.expiresAt.toISOString().replace('.000Z', 'Z')).toBe(decodePolicy(slot.fields).expiration)
    const delta = slot.expiresAt.getTime() - before
    expect(delta).toBeGreaterThan(299_000 - 1000)
    expect(delta).toBeLessThanOrEqual(300_000 + 1000)
  })

  it('produces a policy S3 would accept for a conforming upload and reject otherwise', async () => {
    const slot = await make().createUpload({
      key: KEY,
      contentType: 'image/jpeg',
      maxBytes: 5000,
      ttlSec: 300,
    })
    expect(s3Accepts(slot.fields, 4000)).toEqual({ ok: true })
    expect(s3Accepts(slot.fields, 5001)).toMatchObject({ ok: false, why: 'size' })
    expect(s3Accepts(slot.fields, 0)).toMatchObject({ ok: false, why: 'size' })
    expect(s3Accepts({ ...slot.fields, 'Content-Type': 'image/png' }, 100)).toMatchObject({ ok: false })
    expect(s3Accepts({ ...slot.fields, key: 'loc/l1/appt/a1/before/other.jpg' }, 100)).toMatchObject({
      ok: false,
    })
    expect(s3Accepts(slot.fields, 100, new Date(Date.now() + 301_000))).toMatchObject({
      ok: false,
      why: 'expired',
    })
  })

  it('applies the key prefix to the signed key only', async () => {
    const slot = await make({ keyPrefix: '/prod/' }).createUpload({
      key: KEY,
      contentType: 'image/webp',
      maxBytes: 1000,
      ttlSec: 300,
    })
    expect(slot.key).toBe(KEY)
    expect(slot.fields.key).toBe(`prod/${KEY}`)
    expect(decodePolicy(slot.fields).conditions).toContainEqual({ key: `prod/${KEY}` })
  })

  it('adds SSE fields and matching conditions when configured', async () => {
    const slot = await make({
      sse: { mode: 'aws:kms', kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/abc' },
    }).createUpload({ key: KEY, contentType: 'image/jpeg', maxBytes: 1000, ttlSec: 300 })
    expect(slot.fields['x-amz-server-side-encryption']).toBe('aws:kms')
    expect(slot.fields['x-amz-server-side-encryption-aws-kms-key-id']).toContain(':key/abc')
    expect(s3Accepts(slot.fields, 10)).toEqual({ ok: true })
    const aes = await make({ sse: { mode: 'AES256' } }).createUpload({
      key: KEY,
      contentType: 'image/jpeg',
      maxBytes: 1000,
      ttlSec: 300,
    })
    expect(aes.fields['x-amz-server-side-encryption']).toBe('AES256')
    expect(s3Accepts(aes.fields, 10)).toEqual({ ok: true })
  })

  it('rejects HEIC, other types, oversize, bad ttl and unsafe keys without presigning', async () => {
    const p = make()
    const base = { key: KEY, contentType: 'image/jpeg', maxBytes: 1000, ttlSec: 300 }
    await expect(p.createUpload({ ...base, contentType: 'image/heic' })).rejects.toMatchObject({
      code: 'HEIC_NOT_SUPPORTED',
    })
    await expect(p.createUpload({ ...base, contentType: 'image/gif' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_TYPE',
    })
    await expect(p.createUpload({ ...base, maxBytes: MAX_UPLOAD_BYTES + 1 })).rejects.toMatchObject({
      code: 'TOO_LARGE',
    })
    await expect(p.createUpload({ ...base, ttlSec: -5 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(p.createUpload({ ...base, key: 'a/../b' })).rejects.toMatchObject({ code: 'INVALID_KEY' })
    await expect(p.createUpload({ ...base, maxBytes: MAX_UPLOAD_BYTES })).resolves.toBeDefined()
  })

  it('surfaces credential problems as PROVIDER_ERROR', async () => {
    const noCreds = new S3Client({
      region: 'us-east-1',
      credentials: async () => {
        throw new Error('Could not load credentials')
      },
    })
    await expect(
      new S3Storage({ client: noCreds, bucket: 'b' }).createUpload({
        key: KEY,
        contentType: 'image/jpeg',
        maxBytes: 10,
        ttlSec: 60,
      }),
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
  })
})

describe('S3Storage head / download / delete / get / put', () => {
  const make = (extra: Partial<ConstructorParameters<typeof S3Storage>[0]> = {}) =>
    new S3Storage({ client: client(), bucket: 'oasis-photos', ...extra })

  it('head returns size and type from HeadObject', async () => {
    s3.on(HeadObjectCommand).resolves({ ContentLength: 12345, ContentType: 'image/jpeg' })
    expect(await make({ keyPrefix: 'prod' }).head(KEY)).toEqual({ bytes: 12345, contentType: 'image/jpeg' })
    expect(s3.commandCalls(HeadObjectCommand)[0]!.args[0].input).toEqual({
      Bucket: 'oasis-photos',
      Key: `prod/${KEY}`,
    })
  })
  it('head returns null on 404 and throws on other failures', async () => {
    s3.on(HeadObjectCommand).rejects(
      Object.assign(new Error('x'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }),
    )
    expect(await make().head(KEY)).toBeNull()
    s3.reset()
    s3.on(HeadObjectCommand).rejects(
      Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }),
    )
    await expect(make().head(KEY)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      message: expect.stringContaining('AccessDenied'),
    })
  })

  it('presigns a private GET valid for ten minutes', async () => {
    const url = new URL(await make({ keyPrefix: 'prod/' }).getDownloadUrl(KEY, DOWNLOAD_TTL_SEC))
    expect(url.protocol).toBe('https:')
    expect(decodeURIComponent(url.pathname)).toContain(`prod/${KEY}`)
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600')
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    expect(url.searchParams.get('response-content-disposition')).toBe('inline')
    expect(url.searchParams.get('response-cache-control')).toBe('private, max-age=600')
  })
  it('rejects bad download ttl and unsafe keys', async () => {
    await expect(make().getDownloadUrl(KEY, 0)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(make().getDownloadUrl(KEY, 7 * 86400)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(make().getDownloadUrl('../x', 60)).rejects.toMatchObject({ code: 'INVALID_KEY' })
  })

  it('delete sends DeleteObject for the prefixed key', async () => {
    s3.on(DeleteObjectCommand).resolves({})
    await make({ keyPrefix: 'prod' }).delete(KEY)
    expect(s3.commandCalls(DeleteObjectCommand)[0]!.args[0].input).toEqual({
      Bucket: 'oasis-photos',
      Key: `prod/${KEY}`,
    })
    s3.reset()
    s3.on(DeleteObjectCommand).rejects(Object.assign(new Error('x'), { name: 'AccessDenied' }))
    await expect(make().delete(KEY)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
  })

  it('get reads the body, enforces the size cap and maps NoSuchKey', async () => {
    s3.on(GetObjectCommand).resolves({ Body: body(Buffer.from('abc')), ContentLength: 3 })
    expect((await make().get(KEY)).toString()).toBe('abc')
    s3.reset()
    s3.on(GetObjectCommand).resolves({ Body: body(Buffer.from('x')), ContentLength: MAX_UPLOAD_BYTES + 1 })
    await expect(make().get(KEY)).rejects.toMatchObject({ code: 'TOO_LARGE' })
    s3.reset()
    s3.on(GetObjectCommand).rejects(Object.assign(new Error('x'), { name: 'NoSuchKey' }))
    await expect(make().get(KEY)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('put validates and sends type, length and encryption', async () => {
    s3.on(PutObjectCommand).resolves({})
    await make({ sse: { mode: 'AES256' } }).put(
      'loc/l1/appt/a1/before/p1.thumb.webp',
      Buffer.from('xyz'),
      'image/webp',
    )
    expect(s3.commandCalls(PutObjectCommand)[0]!.args[0].input).toMatchObject({
      Bucket: 'oasis-photos',
      Key: 'loc/l1/appt/a1/before/p1.thumb.webp',
      ContentType: 'image/webp',
      ContentLength: 3,
      ServerSideEncryption: 'AES256',
    })
    await expect(make().put(KEY, Buffer.from('x'), 'image/heic')).rejects.toMatchObject({
      code: 'HEIC_NOT_SUPPORTED',
    })
    await expect(make().put(KEY, Buffer.alloc(MAX_UPLOAD_BYTES + 1), 'image/jpeg')).rejects.toMatchObject({
      code: 'TOO_LARGE',
    })
  })

  it('requires a bucket', () => {
    expect(() => new S3Storage({ client: client(), bucket: '' })).toThrow(/bucket/)
  })
})

describe('createStorageProvider', () => {
  const base = {
    AWS_REGION: 'us-east-1',
    PUBLIC_API_URL: 'http://localhost:4000',
    NODE_ENV: 'test',
    SESSION_SECRET: undefined,
    STORAGE_FS_ROOT: './.data/files-test',
  } as const

  it('STORAGE_PROVIDER=fs builds the filesystem driver with dev-url base from PUBLIC_API_URL', async () => {
    const p = createStorageProvider({ ...base, STORAGE_PROVIDER: 'fs', S3_BUCKET: undefined })
    expect(p).toBeInstanceOf(FsStorage)
    const slot = await p.createUpload({ key: KEY, contentType: 'image/jpeg', maxBytes: 100, ttlSec: 60 })
    expect(slot.url).toBe('http://localhost:4000/dev-storage/upload')
  })
  it('fs in production needs a signing secret', () => {
    expect(() =>
      createStorageProvider({
        ...base,
        NODE_ENV: 'production',
        STORAGE_PROVIDER: 'fs',
        S3_BUCKET: undefined,
      }),
    ).toThrow(/STORAGE_SIGNING_SECRET/)
    expect(
      createStorageProvider({
        ...base,
        NODE_ENV: 'production',
        STORAGE_PROVIDER: 'fs',
        S3_BUCKET: undefined,
        STORAGE_SIGNING_SECRET: 'x'.repeat(32),
      }),
    ).toBeInstanceOf(FsStorage)
  })
  it('STORAGE_PROVIDER=s3 builds the S3 driver honouring prefix and encryption env', async () => {
    const p = createStorageProvider(
      {
        ...base,
        STORAGE_PROVIDER: 's3',
        S3_BUCKET: 'oasis-photos',
        S3_KEY_PREFIX: 'staging',
        S3_SSE: 'AES256',
      },
      { s3Client: client() },
    )
    expect(p).toBeInstanceOf(S3Storage)
    const slot = await p.createUpload({ key: KEY, contentType: 'image/jpeg', maxBytes: 100, ttlSec: 60 })
    expect(slot.fields.key).toBe(`staging/${KEY}`)
    expect(slot.fields['x-amz-server-side-encryption']).toBe('AES256')
  })
  it('s3 without a bucket fails fast', () => {
    expect(() => createStorageProvider({ ...base, STORAGE_PROVIDER: 's3', S3_BUCKET: undefined })).toThrow(
      /S3_BUCKET/,
    )
  })
})
