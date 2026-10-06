import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import path from 'node:path'
import type { UploadSlot } from '../ports/storage.js'
import type { Clock } from '../../platform/clock.js'
import { signDownload, signUpload, tagsEqual as sameTag } from './fs-signing.js'
import { assertSafeKey } from './keys.js'
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

export const DEV_STORAGE_PREFIX = '/dev-storage'

export interface FsStorageOptions {
  root: string
  clock: Clock
  /** HMAC key for dev URLs. Production should use a dedicated random value. */
  secret: string
  /** Public base of the mounted handler, e.g. http://localhost:4000/dev-storage */
  baseUrl: string
  allowedContentTypes?: Readonly<Record<string, string>>
}

interface Meta {
  contentType: string
}

/** Dev/simulator object store on the local disk. Mirrors the S3 contract: signed upload form, signed GET, HEAD, delete. */
export class FsStorage implements ObjectStorage {
  readonly root: string
  readonly clock: Clock
  private readonly secret: string
  private readonly baseUrl: string
  readonly allowed: Readonly<Record<string, string>>

  constructor(opts: FsStorageOptions) {
    this.root = path.resolve(opts.root)
    this.clock = opts.clock
    this.secret = opts.secret
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.allowed = opts.allowedContentTypes ?? PHOTO_TYPES
    if (opts.secret.length < 16)
      throw new StorageError('INVALID_ARGUMENT', 'filesystem storage secret must be at least 16 characters')
  }

  private objectPath(key: string): string {
    const p = path.join(this.root, 'objects', assertSafeKey(key))
    if (!p.startsWith(path.join(this.root, 'objects') + path.sep))
      throw new StorageError('INVALID_KEY', 'storage key is not valid')
    return p
  }
  private metaPath(key: string): string {
    return path.join(this.root, 'meta', `${assertSafeKey(key)}.json`)
  }

  async createUpload(p: UploadRequest): Promise<UploadSlot> {
    const contentType = assertUploadRequest(p, this.allowed)
    assertSafeKey(p.key)
    const expiresAt = new Date(this.clock.now().getTime() + p.ttlSec * 1000)
    const exp = Math.floor(expiresAt.getTime() / 1000)
    return {
      key: p.key,
      url: `${this.baseUrl}/upload`,
      fields: {
        key: p.key,
        'Content-Type': contentType,
        'x-oasis-expires': String(exp),
        'x-oasis-max-bytes': String(p.maxBytes),
        'x-oasis-signature': signUpload(this.secret, { key: p.key, contentType, maxBytes: p.maxBytes, exp }),
      },
      expiresAt: new Date(exp * 1000),
    }
  }

  /** Verifies the fields of a dev upload form. Throws StorageError(BAD_SIGNATURE | EXPIRED | INVALID_ARGUMENT). */
  verifyUploadFields(f: Record<string, string>): { key: string; contentType: string; maxBytes: number } {
    const key = f.key
    const contentType = f['Content-Type']
    const exp = Number(f['x-oasis-expires'])
    const maxBytes = Number(f['x-oasis-max-bytes'])
    const sig = f['x-oasis-signature']
    if (!key || !contentType || !sig || !Number.isInteger(exp) || !Number.isInteger(maxBytes)) {
      throw new StorageError('INVALID_ARGUMENT', 'upload form is missing required fields')
    }
    assertSafeKey(key)
    if (!sameTag(signUpload(this.secret, { key, contentType, maxBytes, exp }), sig)) {
      throw new StorageError('BAD_SIGNATURE', 'upload signature is invalid')
    }
    if (this.clock.now().getTime() >= exp * 1000) throw new StorageError('EXPIRED', 'upload URL has expired')
    return { key, contentType, maxBytes }
  }

  async getDownloadUrl(key: string, ttlSec: number): Promise<string> {
    assertSafeKey(key)
    assertTtl(ttlSec)
    const exp = Math.floor(this.clock.now().getTime() / 1000) + ttlSec
    const sig = signDownload(this.secret, { key, exp })
    return `${this.baseUrl}/files/${key.split('/').map(encodeURIComponent).join('/')}?exp=${exp}&sig=${sig}`
  }

  verifyDownload(key: string, exp: string | null, sig: string | null): void {
    assertSafeKey(key)
    const e = Number(exp)
    if (!sig || !exp || !Number.isInteger(e) || !sameTag(signDownload(this.secret, { key, exp: e }), sig)) {
      throw new StorageError('BAD_SIGNATURE', 'download signature is invalid')
    }
    if (this.clock.now().getTime() >= e * 1000) throw new StorageError('EXPIRED', 'download URL has expired')
  }

  async head(key: string): Promise<{ bytes: number; contentType: string } | null> {
    const file = this.objectPath(key)
    let st
    try {
      st = await stat(file)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new StorageError('PROVIDER_ERROR', 'could not stat object', { cause: e })
    }
    return {
      bytes: st.size,
      contentType: (await this.readMeta(key))?.contentType ?? 'application/octet-stream',
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.objectPath(key))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        throw new StorageError('NOT_FOUND', 'object does not exist')
      throw e
    }
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const ct = assertAllowedContentType(contentType, this.allowed)
    if (body.length > MAX_UPLOAD_BYTES) throw new StorageError('TOO_LARGE', 'object exceeds the 15 MB limit')
    const file = this.objectPath(key)
    const meta = this.metaPath(key)
    await mkdir(path.dirname(file), { recursive: true })
    await mkdir(path.dirname(meta), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, body)
    await rename(tmp, file)
    await writeFile(meta, JSON.stringify({ contentType: ct } satisfies Meta))
  }

  async delete(key: string): Promise<void> {
    await rm(this.objectPath(key), { force: true })
    await rm(this.metaPath(key), { force: true })
  }

  async readMeta(key: string): Promise<Meta | null> {
    try {
      return JSON.parse(await readFile(this.metaPath(key), 'utf8')) as Meta
    } catch {
      return null
    }
  }

  /** Opens the object before returning so a 200 response never fails to start streaming. */
  async openRead(key: string): Promise<Readable> {
    try {
      const fh = await open(this.objectPath(key), 'r')
      return fh.createReadStream({ autoClose: true })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        throw new StorageError('NOT_FOUND', 'object does not exist')
      throw e
    }
  }

  absolutePath(key: string): string {
    return this.objectPath(key)
  }
}
