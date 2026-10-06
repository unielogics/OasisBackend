import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FixedClock } from '../../../src/platform/clock.js'
import {
  createFsStorageHandler,
  MAX_BODY_BYTES,
  type DevStorageResponse,
} from '../../../src/integrations/storage/fs-handler.js'
import { FsStorage } from '../../../src/integrations/storage/fs-provider.js'
import {
  DOWNLOAD_TTL_SEC,
  MAX_UPLOAD_BYTES,
  StorageError,
  UPLOAD_TTL_SEC,
} from '../../../src/integrations/storage/types.js'
import { HEIC, JPEG, PNG, multipartBody } from './helpers/multipart.js'

const KEY = 'loc/l1/appt/a1/before/p1.jpg'
const origin = 'http://localhost:3000'

async function drain(r: DevStorageResponse): Promise<Buffer> {
  if (!r.body) return Buffer.alloc(0)
  if (typeof r.body === 'string' || Buffer.isBuffer(r.body)) return Buffer.from(r.body)
  const chunks: Buffer[] = []
  for await (const c of r.body as Readable) chunks.push(Buffer.from(c))
  return Buffer.concat(chunks)
}

describe('FsStorage + dev handler', () => {
  let root: string
  let clock: FixedClock
  let fs: FsStorage
  let handle: ReturnType<typeof createFsStorageHandler>
  const opened: Readable[] = []

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'oasis-fs-'))
    clock = new FixedClock('2026-06-13T10:36:00-04:00')
    fs = new FsStorage({
      root,
      clock,
      secret: 'test-secret-0123456789',
      baseUrl: 'http://localhost:4000/dev-storage',
    })
    const inner = createFsStorageHandler(fs, { allowOrigin: origin })
    handle = async (req) => {
      const r = await inner(req)
      if (r.body && typeof r.body !== 'string' && !Buffer.isBuffer(r.body)) opened.push(r.body)
      return r
    }
  })
  afterEach(() => {
    for (const s of opened.splice(0)) s.destroy()
    rmSync(root, { recursive: true, force: true })
  })

  const slot = (over: Partial<Parameters<FsStorage['createUpload']>[0]> = {}) =>
    fs.createUpload({ key: KEY, contentType: 'image/jpeg', maxBytes: 1024, ttlSec: UPLOAD_TTL_SEC, ...over })

  const upload = async (
    s: Awaited<ReturnType<typeof slot>>,
    file: Buffer | null,
    fields: Record<string, string> = s.fields,
  ) => {
    const { body, contentType } = multipartBody(fields, file && { data: file, contentType: 'image/jpeg' })
    return handle({
      method: 'POST',
      url: new URL(s.url).pathname,
      headers: { 'content-type': contentType },
      body,
    })
  }

  describe('createUpload', () => {
    it('returns an S3-shaped slot with a five-minute expiry', async () => {
      const s = await slot()
      expect(s.key).toBe(KEY)
      expect(s.url).toBe('http://localhost:4000/dev-storage/upload')
      expect(s.expiresAt.toISOString()).toBe('2026-06-13T14:41:00.000Z')
      expect(s.fields).toMatchObject({ key: KEY, 'Content-Type': 'image/jpeg', 'x-oasis-max-bytes': '1024' })
      expect(s.fields['x-oasis-signature']).toMatch(/^[A-Za-z0-9_-]{43}$/)
    })
    it('rejects HEIC, other types, oversize and bad ttl', async () => {
      await expect(slot({ contentType: 'image/heic' })).rejects.toMatchObject({ code: 'HEIC_NOT_SUPPORTED' })
      await expect(slot({ contentType: 'application/pdf' })).rejects.toMatchObject({
        code: 'UNSUPPORTED_TYPE',
      })
      await expect(slot({ maxBytes: MAX_UPLOAD_BYTES + 1 })).rejects.toMatchObject({ code: 'TOO_LARGE' })
      await expect(slot({ maxBytes: 0 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      await expect(slot({ ttlSec: 0 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      await expect(slot({ key: '../etc/passwd' })).rejects.toMatchObject({ code: 'INVALID_KEY' })
    })
    it('accepts exactly 15 MB', async () => {
      await expect(slot({ maxBytes: MAX_UPLOAD_BYTES })).resolves.toBeDefined()
    })
  })

  describe('upload handler', () => {
    it('stores the file, then head/get/download work', async () => {
      const s = await slot()
      const r = await upload(s, JPEG)
      expect(r.status).toBe(204)
      expect(r.headers['Access-Control-Allow-Origin']).toBe(origin)
      expect(await fs.head(KEY)).toEqual({ bytes: JPEG.length, contentType: 'image/jpeg' })
      expect((await fs.get(KEY)).equals(JPEG)).toBe(true)
      expect(readFileSync(fs.absolutePath(KEY)).equals(JPEG)).toBe(true)

      const url = await fs.getDownloadUrl(KEY, DOWNLOAD_TTL_SEC)
      const d = await handle({ method: 'GET', url, headers: {} })
      expect(d.status).toBe(200)
      expect(d.headers['Content-Type']).toBe('image/jpeg')
      expect(d.headers['X-Content-Type-Options']).toBe('nosniff')
      expect((await drain(d)).equals(JPEG)).toBe(true)
    })

    it('expires after the TTL (FixedClock)', async () => {
      const s = await slot()
      clock.advance(UPLOAD_TTL_SEC * 1000 - 1000)
      expect((await upload(s, JPEG)).status).toBe(204)
      const s2 = await slot({ key: 'loc/l1/appt/a1/after/p2.jpg' })
      clock.advance(UPLOAD_TTL_SEC * 1000)
      const late = await upload(s2, JPEG)
      expect(late.status).toBe(403)
      expect(JSON.parse(late.body as string).error.code).toBe('EXPIRED')
      expect(await fs.head('loc/l1/appt/a1/after/p2.jpg')).toBeNull()
    })

    it('rejects tampered fields (key, content type, size limit, expiry) and missing signature', async () => {
      const s = await slot()
      const tamper = async (k: string, v: string) => (await upload(s, JPEG, { ...s.fields, [k]: v })).status
      expect(await tamper('key', 'loc/l1/appt/a1/before/other.jpg')).toBe(403)
      expect(await tamper('Content-Type', 'image/png')).toBe(403)
      expect(await tamper('x-oasis-max-bytes', '999999')).toBe(403)
      expect(await tamper('x-oasis-expires', String(Number(s.fields['x-oasis-expires']) + 3600))).toBe(403)
      const noSig = { ...s.fields }
      delete noSig['x-oasis-signature']
      expect((await upload(s, JPEG, noSig)).status).toBe(400)
    })

    it('rejects a signature minted with another secret', async () => {
      const other = new FsStorage({
        root,
        clock,
        secret: 'another-secret-0123456789',
        baseUrl: 'http://x/dev-storage',
      })
      const s = await other.createUpload({ key: KEY, contentType: 'image/jpeg', maxBytes: 1024, ttlSec: 300 })
      expect((await upload(s, JPEG)).status).toBe(403)
    })

    it('enforces content-length-range', async () => {
      const s = await slot({ maxBytes: 100 })
      const tooBig = await upload(s, Buffer.concat([JPEG, Buffer.alloc(100)]))
      expect(tooBig.status).toBe(413)
      const empty = await upload(s, Buffer.alloc(0))
      expect(empty.status).toBe(400)
      expect(JSON.parse(empty.body as string).error.code).toBe('TOO_SMALL')
      expect(await fs.head(KEY)).toBeNull()
    })

    it('rejects HEIC bytes with the clear message even when declared as jpeg', async () => {
      const s = await slot()
      const r = await upload(s, HEIC)
      expect(r.status).toBe(415)
      const err = JSON.parse(r.body as string).error
      expect(err.code).toBe('HEIC_NOT_SUPPORTED')
      expect(err.message).toMatch(/Convert the photo to JPEG/)
    })

    it('rejects content that does not match the declared type', async () => {
      const s = await slot()
      const r = await upload(s, PNG)
      expect(r.status).toBe(415)
      expect(JSON.parse(r.body as string).error.code).toBe('CONTENT_MISMATCH')
      expect(await fs.head(KEY)).toBeNull()
    })

    it('rejects a missing file part, a bad body and oversized requests', async () => {
      const s = await slot()
      expect((await upload(s, null)).status).toBe(400)
      expect(
        (
          await handle({
            method: 'POST',
            url: '/dev-storage/upload',
            headers: { 'content-type': 'text/plain' },
            body: Buffer.from('x'),
          })
        ).status,
      ).toBe(400)
      expect(
        (
          await handle({
            method: 'POST',
            url: '/dev-storage/upload',
            headers: { 'content-type': 'multipart/form-data; boundary=b' },
            body: Buffer.alloc(MAX_BODY_BYTES + 1),
          })
        ).status,
      ).toBe(413)
      expect((await handle({ method: 'POST', url: '/dev-storage/upload', headers: {} })).status).toBe(400)
    })

    it('answers CORS preflight for the dashboard origin', async () => {
      const r = await handle({ method: 'OPTIONS', url: '/dev-storage/upload', headers: {} })
      expect(r.status).toBe(204)
      expect(r.headers['Access-Control-Allow-Origin']).toBe(origin)
      expect(r.headers['Access-Control-Allow-Methods']).toContain('POST')
    })
  })

  describe('signed download URLs', () => {
    beforeEach(async () => {
      await fs.put(KEY, JPEG, 'image/jpeg')
    })

    it('is valid for ten minutes and not a second longer', async () => {
      const url = await fs.getDownloadUrl(KEY, DOWNLOAD_TTL_SEC)
      expect(url).toContain('exp=')
      clock.advance(DOWNLOAD_TTL_SEC * 1000 - 1000)
      expect((await handle({ method: 'GET', url, headers: {} })).status).toBe(200)
      clock.advance(1000)
      const r = await handle({ method: 'GET', url, headers: {} })
      expect(r.status).toBe(403)
      expect(JSON.parse(r.body as string).error.code).toBe('EXPIRED')
    })

    it('rejects a tampered signature, expiry or key', async () => {
      const url = new URL(await fs.getDownloadUrl(KEY, 60))
      const bad = (mut: (u: URL) => void) => {
        const u = new URL(url)
        mut(u)
        return handle({ method: 'GET', url: u.pathname + u.search, headers: {} }).then((r) => r.status)
      }
      expect(await bad((u) => u.searchParams.set('sig', 'A'.repeat(43)))).toBe(403)
      expect(
        await bad((u) => u.searchParams.set('exp', String(Number(u.searchParams.get('exp')) + 600))),
      ).toBe(403)
      expect(await bad((u) => u.searchParams.delete('sig'))).toBe(403)
      expect(await bad((u) => (u.pathname = u.pathname.replace('p1.jpg', 'p2.jpg')))).toBe(403)
    })

    it('an upload signature cannot be replayed as a download signature', async () => {
      const s = await slot()
      const exp = s.fields['x-oasis-expires']
      const r = await handle({
        method: 'GET',
        url: `/dev-storage/files/${KEY}?exp=${exp}&sig=${s.fields['x-oasis-signature']}`,
        headers: {},
      })
      expect(r.status).toBe(403)
    })

    it('supports HEAD and 404s a missing object behind a valid signature', async () => {
      const url = await fs.getDownloadUrl(KEY, 60)
      const h = await handle({ method: 'HEAD', url, headers: {} })
      expect(h.status).toBe(200)
      expect(h.headers['Content-Length']).toBe(String(JPEG.length))
      expect(h.body).toBeUndefined()
      await fs.delete(KEY)
      expect((await handle({ method: 'GET', url, headers: {} })).status).toBe(404)
    })

    it('refuses traversal keys at URL level', async () => {
      const r = await handle({
        method: 'GET',
        url: '/dev-storage/files/..%2F..%2Fetc%2Fpasswd?exp=1&sig=x',
        headers: {},
      })
      expect(r.status).toBe(400)
      expect((await handle({ method: 'GET', url: '/elsewhere', headers: {} })).status).toBe(404)
    })
  })

  describe('provider operations', () => {
    it('head returns null for a missing object; delete is idempotent and removes metadata', async () => {
      expect(await fs.head(KEY)).toBeNull()
      await fs.put(KEY, PNG, 'image/png')
      expect(await fs.head(KEY)).toEqual({ bytes: PNG.length, contentType: 'image/png' })
      await fs.delete(KEY)
      await fs.delete(KEY)
      expect(await fs.head(KEY)).toBeNull()
      expect(existsSync(path.join(root, 'meta', `${KEY}.json`))).toBe(false)
    })
    it('get on a missing key is NOT_FOUND', async () => {
      await expect(fs.get(KEY)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })
    it('never touches paths outside the root', async () => {
      for (const k of ['../outside', 'a/../../outside', '/etc/passwd']) {
        await expect(fs.put(k, JPEG, 'image/jpeg')).rejects.toBeInstanceOf(StorageError)
        await expect(fs.head(k)).rejects.toBeInstanceOf(StorageError)
        await expect(fs.delete(k)).rejects.toBeInstanceOf(StorageError)
      }
    })
    it('validates download ttl', async () => {
      await expect(fs.getDownloadUrl(KEY, 0)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
      await expect(fs.getDownloadUrl(KEY, 86400)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    })
    it('requires a real secret', () => {
      expect(() => new FsStorage({ root, clock, secret: 'short', baseUrl: 'http://x' })).toThrow(/secret/)
    })
  })
})
