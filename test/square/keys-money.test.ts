import { describe, expect, it } from 'vitest'
import { SQUARE_KEY_MAX, SQUARE_KEY_PREFIXES, assertSquareKey, sqKey } from '../../src/integrations/square/keys.js'
import { SquareCurrencyError, centsOf, centsOrNull, usd } from '../../src/integrations/square/money.js'

describe('Square idempotency keys', () => {
  it('are deterministic, 35 characters, within the 45-character limit of CreatePayment, CreateCard and RefundPayment', () => {
    const uuid = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b'
    expect(sqKey('pl', uuid)).toBe('pl_0192a3b4c5d67e8f9a0b1c2d3e4f5a6b')
    expect(sqKey('pl', uuid.toUpperCase())).toBe(sqKey('pl', uuid))
    expect(sqKey('rf', 'refund-leg:42')).toBe(sqKey('rf', 'refund-leg:42'))
    expect(sqKey('rf', 'refund-leg:42')).not.toBe(sqKey('rf', 'refund-leg:43'))
    expect(sqKey('ch', 'x')).not.toBe(sqKey('cd', 'x'))
    for (const p of SQUARE_KEY_PREFIXES) {
      const k = sqKey(p, `some stable name ${'z'.repeat(300)}`)
      expect(k).toHaveLength(35)
      expect(k.length).toBeLessThanOrEqual(SQUARE_KEY_MAX)
      expect(k).toMatch(/^[a-z]{2}_[0-9a-f]{32}$/)
    }
  })

  it('refuses an unknown prefix, an empty id, an over-long or odd key', () => {
    expect(() => sqKey('zz' as never, 'x')).toThrow(/unknown Square key prefix/)
    expect(() => sqKey('pl', '')).toThrow(/stable id/)
    expect(() => assertSquareKey('x'.repeat(46))).toThrow(/1 to 45 characters/)
    expect(assertSquareKey('x'.repeat(45))).toHaveLength(45)
    expect(() => assertSquareKey('has space')).toThrow(/letters, digits/)
  })
})

describe('Square money', () => {
  it('USD integer cents only', () => {
    expect(usd(4265)).toEqual({ amount: 4265, currency: 'USD' })
    expect(usd(0)).toEqual({ amount: 0, currency: 'USD' })
    expect(() => usd(-1)).toThrow(RangeError)
    expect(() => usd(1.5)).toThrow(RangeError)
    expect(centsOf({ amount: 100, currency: 'USD' })).toBe(100)
    expect(centsOf(undefined)).toBe(0)
    expect(centsOrNull(null)).toBeNull()
    expect(() => centsOf({ amount: 100, currency: 'CAD' }, 'tip')).toThrow(SquareCurrencyError)
    expect(() => centsOf({ amount: 100, currency: 'CAD' }, 'tip')).toThrow(/tip is in CAD/)
    expect(() => centsOf({ amount: 1.25, currency: 'USD' })).toThrow(/whole number of cents/)
  })
})
