import { describe, expect, it } from 'vitest'
import {
  assertSafeKey,
  buildPhotoKey,
  normalizePrefix,
  parsePhotoKey,
  thumbKeyFor,
} from '../../../src/integrations/storage/keys.js'
import { StorageError, assertAllowedContentType } from '../../../src/integrations/storage/types.js'

const parts = {
  locationId: 'loc1',
  apptId: '0192f1c4-7a2b-7c33-9d1e-aaaaaaaaaaaa',
  category: 'before',
  photoId: 'ph_01',
  contentType: 'image/jpeg',
} as const

describe('photo keys', () => {
  it('builds loc/{locationId}/appt/{apptId}/{category}/{photoId}.{ext}', () => {
    expect(buildPhotoKey(parts)).toBe('loc/loc1/appt/0192f1c4-7a2b-7c33-9d1e-aaaaaaaaaaaa/before/ph_01.jpg')
    expect(buildPhotoKey({ ...parts, contentType: 'image/png' })).toMatch(/\.png$/)
    expect(buildPhotoKey({ ...parts, contentType: 'IMAGE/WEBP; charset=x' })).toMatch(/\.webp$/)
  })
  it('round-trips through parsePhotoKey', () => {
    expect(parsePhotoKey(buildPhotoKey(parts))).toEqual({
      locationId: 'loc1',
      apptId: parts.apptId,
      category: 'before',
      photoId: 'ph_01',
      ext: 'jpg',
    })
    expect(parsePhotoKey('loc/a/appt/b/other/c.jpg')).toBeNull()
    expect(parsePhotoKey('x/loc/a/appt/b/before/c.jpg')).toBeNull()
  })
  it('rejects unsafe segments and unknown categories', () => {
    for (const bad of ['', '../x', 'a/b', 'a b', '.hidden', 'x'.repeat(65), 'a\nb']) {
      expect(() => buildPhotoKey({ ...parts, apptId: bad })).toThrow(StorageError)
    }
    expect(() => buildPhotoKey({ ...parts, category: 'selfie' as never })).toThrow(/category/)
  })
  it('thumbnail key sits next to the original', () => {
    expect(thumbKeyFor('loc/l/appt/a/after/p1.png')).toBe('loc/l/appt/a/after/p1.thumb.webp')
  })
})

describe('content types', () => {
  it('accepts jpeg, png, webp', () => {
    for (const t of ['image/jpeg', 'image/png', 'image/webp', 'Image/JPEG'])
      expect(() => assertAllowedContentType(t)).not.toThrow()
  })
  it.each(['image/heic', 'image/heif', 'IMAGE/HEIC', 'image/heic-sequence'])(
    'rejects %s with the clear HEIC message',
    (t) => {
      try {
        assertAllowedContentType(t)
        throw new Error('should have thrown')
      } catch (e) {
        expect((e as StorageError).code).toBe('HEIC_NOT_SUPPORTED')
        expect((e as StorageError).message).toMatch(/Convert the photo to JPEG/)
      }
    },
  )
  it.each(['image/gif', 'application/pdf', 'text/html', 'image/svg+xml', '', 'image/jpg'])(
    'rejects %j',
    (t) => {
      expect(() => assertAllowedContentType(t)).toThrow(/not allowed/)
    },
  )
})

describe('assertSafeKey and prefixes', () => {
  it.each(['loc/a/b.jpg', 'a', 'a/b/c.d-e_f'])('accepts %s', (k) => expect(assertSafeKey(k)).toBe(k))
  it.each(['', '/abs', 'a//b', 'a/../b', '../a', 'a/./b', 'a/', 'a b', 'a\\b', 'a%2e%2e/b', 'a/b\0'])(
    'rejects %j',
    (k) => {
      expect(() => assertSafeKey(k)).toThrow(StorageError)
    },
  )
  it('normalizes prefixes', () => {
    expect(normalizePrefix('')).toBe('')
    expect(normalizePrefix('prod')).toBe('prod/')
    expect(normalizePrefix('/prod/eu/')).toBe('prod/eu/')
    expect(() => normalizePrefix('../x')).toThrow(StorageError)
  })
})
