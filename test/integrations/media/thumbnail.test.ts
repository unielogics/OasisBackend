import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { FixedClock } from '../../../src/platform/clock.js'
import { MediaError } from '../../../src/integrations/media/errors.js'
import { validateImageInput } from '../../../src/integrations/media/image-info.js'
import { generateAndStoreThumbnail } from '../../../src/integrations/media/thumbnail-job.js'
import { ThumbnailService, loadSharp, planThumbnail } from '../../../src/integrations/media/thumbnail.js'
import { FsStorage } from '../../../src/integrations/storage/fs-provider.js'
import { HEIC, JPEG } from '../storage/helpers/multipart.js'
import { makePng } from './png.js'

const codeOf = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(MediaError)
    return (e as MediaError).code
  }
  throw new Error('expected throw')
}

describe('planThumbnail (pure)', () => {
  it('fits inside a square box, webp, oriented, never enlarging', () => {
    const p = planThumbnail({ width: 4000, height: 3000 })
    expect(p).toMatchObject({
      box: { width: 480, height: 480 },
      fit: 'inside',
      withoutEnlargement: true,
      format: 'webp',
      quality: 78,
      autoOrient: true,
    })
    expect(p.expected).toEqual({ width: 480, height: 360 })
  })
  it('keeps small images at their own size', () => {
    expect(planThumbnail({ width: 100, height: 50 }).expected).toEqual({ width: 100, height: 50 })
  })
  it('handles extreme aspect ratios without a zero edge', () => {
    expect(planThumbnail({ width: 10000, height: 1 }).expected).toEqual({ width: 480, height: 1 })
  })
  it('validates options', () => {
    expect(codeOf(() => planThumbnail({ width: 1, height: 1 }, { maxEdge: 8 }))).toBe('INVALID_OPTIONS')
    expect(codeOf(() => planThumbnail({ width: 1, height: 1 }, { maxEdge: 5000 }))).toBe('INVALID_OPTIONS')
    expect(codeOf(() => planThumbnail({ width: 1, height: 1 }, { quality: 0 }))).toBe('INVALID_OPTIONS')
    expect(codeOf(() => planThumbnail({ width: 1, height: 1 }, { quality: 70.5 }))).toBe('INVALID_OPTIONS')
    expect(planThumbnail({ width: 1000, height: 1000 }, { maxEdge: 200, quality: 60 })).toMatchObject({
      box: { width: 200 },
      quality: 60,
    })
  })
})

describe('validateImageInput (pure)', () => {
  it('reads PNG dimensions from the header', () => {
    expect(validateImageInput(makePng(7, 5))).toMatchObject({ type: 'image/png', width: 7, height: 5 })
  })
  it('accepts a matching declared type, rejects a mismatch', () => {
    expect(validateImageInput(makePng(2, 2), { declaredType: 'image/png; charset=binary' }).type).toBe(
      'image/png',
    )
    expect(codeOf(() => validateImageInput(makePng(2, 2), { declaredType: 'image/jpeg' }))).toBe(
      'TYPE_MISMATCH',
    )
  })
  it('rejects HEIC with the clear message', () => {
    try {
      validateImageInput(HEIC)
    } catch (e) {
      expect((e as MediaError).code).toBe('HEIC_NOT_SUPPORTED')
      expect((e as MediaError).message).toMatch(/Convert the photo to JPEG/)
      return
    }
    throw new Error('expected throw')
  })
  it('rejects empty, unknown, oversize and corrupt input', () => {
    expect(codeOf(() => validateImageInput(Buffer.alloc(0)))).toBe('EMPTY')
    expect(codeOf(() => validateImageInput(Buffer.from('GIF89a....')))).toBe('UNSUPPORTED_TYPE')
    expect(codeOf(() => validateImageInput(makePng(2, 2), { maxBytes: 10 }))).toBe('TOO_LARGE')
    expect(codeOf(() => validateImageInput(makePng(2, 2).subarray(0, 20)))).toBe('CORRUPT')
    expect(codeOf(() => validateImageInput(JPEG))).toBe('CORRUPT') // magic bytes only, no frame header
  })
  it('rejects a decompression bomb by declared pixel count without decoding', () => {
    const bomb = makePng(2, 2)
    bomb.writeUInt32BE(30000, 16)
    bomb.writeUInt32BE(30000, 20)
    expect(codeOf(() => validateImageInput(bomb))).toBe('TOO_MANY_PIXELS')
    expect(validateImageInput(bomb, { maxPixels: 1e9 }).width).toBe(30000)
  })
})

describe('ThumbnailService fallback (sharp unavailable)', () => {
  const none = () => new ThumbnailService({ loader: async () => null })
  it('reports unavailable and returns no thumbnail for valid input', async () => {
    const s = none()
    expect(await s.available()).toBe(false)
    expect(await s.create(makePng(10, 10), 'image/png')).toBeNull()
  })
  it('still rejects invalid input', async () => {
    await expect(none().create(HEIC)).rejects.toMatchObject({ code: 'HEIC_NOT_SUPPORTED' })
    await expect(none().create(Buffer.alloc(0))).rejects.toMatchObject({ code: 'EMPTY' })
  })
  it('treats a loader that throws as unavailable', async () => {
    const s = new ThumbnailService({
      loader: async () => {
        throw new Error('Could not load the "sharp" module')
      },
    })
    expect(await s.available()).toBe(false)
    expect(await s.create(makePng(4, 4))).toBeNull()
  })
  it('job skips with sharp-unavailable and writes nothing', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'oasis-thumb-'))
    try {
      const fs = new FsStorage({
        root,
        clock: new FixedClock(0),
        secret: 'x'.repeat(20),
        baseUrl: 'http://x/dev-storage',
      })
      const key = 'loc/l/appt/a/before/p1.png'
      await fs.put(key, makePng(40, 30), 'image/png')
      expect(await generateAndStoreThumbnail(fs, none(), key)).toEqual({
        status: 'skipped',
        reason: 'sharp-unavailable',
      })
      expect(await fs.head('loc/l/appt/a/before/p1.thumb.webp')).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('ThumbnailService with sharp', () => {
  let haveSharp = false
  beforeAll(async () => {
    haveSharp = (await loadSharp()) !== null
    if (!haveSharp) console.warn('sharp is not loadable on this platform; real-thumbnail tests are skipped')
  })

  it('creates a webp thumbnail from a tiny generated PNG, downscaling and preserving aspect', async ({
    skip,
  }) => {
    if (!haveSharp) skip()
    const svc = new ThumbnailService({ maxEdge: 64 })
    expect(await svc.available()).toBe(true)
    const t = await svc.create(makePng(200, 100), 'image/png')
    expect(t).not.toBeNull()
    expect(t!.contentType).toBe('image/webp')
    expect([t!.width, t!.height]).toEqual([64, 32])
    expect(t!.data.subarray(0, 4).toString()).toBe('RIFF')
    expect(t!.data.subarray(8, 12).toString()).toBe('WEBP')
    expect(validateImageInput(t!.data)).toMatchObject({ type: 'image/webp', width: 64, height: 32 })
  })

  it('does not enlarge small images', async ({ skip }) => {
    if (!haveSharp) skip()
    const t = await new ThumbnailService().create(makePng(30, 20))
    expect([t!.width, t!.height]).toEqual([30, 20])
  })

  it('reads JPEG and WebP dimensions the same way sharp encodes them', async ({ skip }) => {
    if (!haveSharp) skip()
    const sharp = (await loadSharp())! as unknown as (i: unknown) => {
      jpeg(): { toBuffer(): Promise<Buffer> }
      webp(o?: object): { toBuffer(): Promise<Buffer> }
    }
    const raw = {
      create: { width: 37, height: 23, channels: 4, background: { r: 10, g: 120, b: 200, alpha: 0.5 } },
    }
    const jpg = await sharp(raw).jpeg().toBuffer()
    expect(validateImageInput(jpg)).toMatchObject({ type: 'image/jpeg', width: 37, height: 23 })
    for (const opts of [{}, { lossless: true }, { quality: 50, alphaQuality: 80 }]) {
      const w = await sharp(raw).webp(opts).toBuffer()
      expect(validateImageInput(w)).toMatchObject({ type: 'image/webp', width: 37, height: 23 })
    }
    const t = await new ThumbnailService({ maxEdge: 16 }).create(jpg, 'image/jpeg')
    expect([t!.width, t!.height]).toEqual([16, 10])
  })

  it('applies EXIF orientation and strips metadata', async ({ skip }) => {
    if (!haveSharp) skip()
    const sharp = (await loadSharp())! as unknown as (i: unknown) => {
      withMetadata(m: object): { withExif(e: object): { jpeg(): { toBuffer(): Promise<Buffer> } } }
      withExif(e: object): { jpeg(): { toBuffer(): Promise<Buffer> } }
      jpeg(): { toBuffer(): Promise<Buffer> }
    }
    const raw = { create: { width: 80, height: 40, channels: 3, background: '#336699' } }
    const rotated = await sharp(raw)
      .withMetadata({ orientation: 6 })
      .withExif({ IFD0: { Copyright: 'secret-gps-marker' } })
      .jpeg()
      .toBuffer()
    expect(rotated.includes(Buffer.from('secret-gps-marker'))).toBe(true)
    const t = await new ThumbnailService({ maxEdge: 64 }).create(rotated, 'image/jpeg')
    expect([t!.width, t!.height]).toEqual([32, 64]) // orientation 6 turns the 80x40 landscape upright
    expect(t!.data.includes(Buffer.from('secret-gps-marker'))).toBe(false)
  })

  it('returns null for pixel data the decoder rejects instead of throwing', async ({ skip }) => {
    if (!haveSharp) skip()
    const png = makePng(50, 50)
    const broken = Buffer.concat([png.subarray(0, 60), Buffer.alloc(30, 7), png.subarray(png.length - 12)])
    expect(await new ThumbnailService().create(broken, 'image/png')).toBeNull()
  })

  it('job stores the thumbnail next to the original', async ({ skip }) => {
    if (!haveSharp) skip()
    const root = mkdtempSync(path.join(tmpdir(), 'oasis-thumb-'))
    try {
      const fs = new FsStorage({
        root,
        clock: new FixedClock(0),
        secret: 'x'.repeat(20),
        baseUrl: 'http://x/dev-storage',
      })
      const key = 'loc/l/appt/a/before/p1.png'
      await fs.put(key, makePng(300, 200), 'image/png')
      const r = await generateAndStoreThumbnail(fs, new ThumbnailService({ maxEdge: 100 }), key)
      expect(r).toMatchObject({
        status: 'created',
        thumbKey: 'loc/l/appt/a/before/p1.thumb.webp',
        width: 100,
        height: 67,
      })
      expect(await fs.head('loc/l/appt/a/before/p1.thumb.webp')).toMatchObject({ contentType: 'image/webp' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('job reports invalid and missing objects without throwing', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'oasis-thumb-'))
    try {
      const fs = new FsStorage({
        root,
        clock: new FixedClock(0),
        secret: 'x'.repeat(20),
        baseUrl: 'http://x/dev-storage',
      })
      const svc = new ThumbnailService({ loader: async () => null })
      expect(await generateAndStoreThumbnail(fs, svc, 'loc/l/appt/a/before/none.jpg')).toEqual({
        status: 'missing',
      })
      await fs.put(
        'loc/l/appt/a/before/bad.jpg',
        Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(8)]),
        'image/jpeg',
      )
      expect(await generateAndStoreThumbnail(fs, svc, 'loc/l/appt/a/before/bad.jpg')).toMatchObject({
        status: 'invalid',
        code: 'CORRUPT',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
