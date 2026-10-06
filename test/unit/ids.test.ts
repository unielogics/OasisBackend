import { describe, expect, it } from 'vitest'
import { FixedClock } from '../../src/platform/clock.js'
import { createIdGenerator, isUuid, shortCode } from '../../src/platform/ids.js'

describe('createIdGenerator', () => {
  it('produces version-7 UUIDs', () => {
    const id = createIdGenerator(new FixedClock('2026-06-13T14:36:00Z'))()
    expect(isUuid(id)).toBe(true)
    expect(id[14]).toBe('7')
    expect('89ab').toContain(id[19])
  })

  it('encodes the injected clock in the leading 48 bits', () => {
    const at = new Date('2026-06-13T14:36:00Z')
    const id = createIdGenerator(new FixedClock(at))()
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(at.getTime())
  })

  it('is strictly increasing under a frozen clock and across clock advances', () => {
    const clock = new FixedClock('2026-06-13T14:36:00Z')
    const next = createIdGenerator(clock)
    const ids: string[] = []
    for (let i = 0; i < 2000; i++) {
      ids.push(next())
      if (i % 500 === 499) clock.advance(1000)
    }
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('shortCode', () => {
  it('uses the unambiguous Crockford alphabet and the requested length', () => {
    const c = shortCode(12)
    expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/)
    expect(shortCode(20)).toHaveLength(20)
    expect(new Set(Array.from({ length: 200 }, () => shortCode(12))).size).toBe(200)
  })
  it('rejects bad lengths', () => {
    expect(() => shortCode(0)).toThrow(RangeError)
  })
})
