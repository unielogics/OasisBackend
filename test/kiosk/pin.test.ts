// Employee PIN rules and lookup (ADR 0180 amendment): exactly 8 digits, never starting with 0218 (the manager sign-in), no repeats,
// runs, repeating patterns, dates or common PINs; the stored lookup is a hex HMAC(key from SESSION_SECRET, "<location>:<pin>").
import { describe, expect, it } from 'vitest'
import { generatePin, kioskKey, KIOSK_REVEAL_PREFIX, pinLookup, pinProblem } from '../../src/modules/kiosk/pin.js'

const LOC_A = '00000000-0000-7000-8000-00000000000a'
const LOC_B = '00000000-0000-7000-8000-00000000000b'

describe('pinProblem', () => {
  it('accepts an ordinary PIN', () => {
    expect(pinProblem('47390218')).toBeNull() // 0218 anywhere but the start is fine
    expect(pinProblem('58203917')).toBeNull()
    expect(pinProblem('10218345')).toBeNull()
  })

  it('needs exactly 8 digits', () => {
    for (const c of ['', '1234567', '123456789', '1234567a', ' 5820391', '5820-391', '５８２０３９１７'])
      expect(pinProblem(c), c).toMatch(/8 digits/)
  })

  it('never starts with 0218', () => {
    expect(KIOSK_REVEAL_PREFIX).toBe('0218')
    expect(pinProblem('02185739')).toMatch(/0218/)
    expect(pinProblem('02180000')).not.toBeNull()
  })

  it('refuses one digit repeated', () => {
    for (const d of '0123456789') expect(pinProblem(d.repeat(8))).not.toBeNull()
  })

  it('refuses runs up and down, with wrap', () => {
    for (const c of ['12345678', '23456789', '34567890', '90123456', '87654321', '98765432', '10987654', '01234567'])
      expect(pinProblem(c), c).toMatch(/in a row/)
  })

  it('refuses repeating patterns of period 1 to 4 and doubled pairs', () => {
    for (const c of ['12121212', '12312312', '12341234', '90909090', '58205820', '11223344', '99887766', '55001122'])
      expect(pinProblem(c), c).toMatch(/pattern/)
  })

  it('refuses dates YYYYMMDD and MMDDYYYY from 1900 to 2099', () => {
    for (const c of ['19840521', '20261013', '20990101', '19000228', '05211984', '10132026', '12312099'])
      expect(pinProblem(c), c).toMatch(/date/)
    // not real dates
    expect(pinProblem('19841321')).toBeNull()
    expect(pinProblem('20260230')).toBeNull()
    expect(pinProblem('18991231')).toBeNull()
    expect(pinProblem('13012026')).toBeNull()
  })

  it('refuses common PINs', () => {
    for (const c of ['12344321', '13572468', '14725836']) expect(pinProblem(c), c).toMatch(/common/)
  })
})

describe('generatePin', () => {
  it('always passes the rules', () => {
    for (let i = 0; i < 500; i++) {
      const c = generatePin()
      expect(pinProblem(c), c).toBeNull()
    }
  })

  it('retries until a PIN passes', () => {
    const digits = ['0218', '0000', '1111', '1111', '5820', '3917']
    let n = 0
    // each call of the source gives 4 digits: 02180000 (refused), 11111111 (refused), 58203917
    const c = generatePin(() => digits[n++]!)
    expect(c).toBe('58203917')
  })
})

describe('pinLookup', () => {
  const key = kioskKey({ NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40) })

  it('is a hex HMAC per location, the same for the same PIN, never the PIN', () => {
    const a = pinLookup(key, LOC_A, '58203917')
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toContain('58203917')
    expect(pinLookup(key, LOC_A, '58203917')).toBe(a)
    expect(pinLookup(key, LOC_A, '58203918')).not.toBe(a)
    expect(pinLookup(key, LOC_B, '58203917')).not.toBe(a)
  })

  it('a different SESSION_SECRET gives a different lookup (every PIN stops working)', () => {
    const other = kioskKey({ NODE_ENV: 'test', SESSION_SECRET: 'y'.repeat(40) })
    expect(pinLookup(other, LOC_A, '58203917')).not.toBe(pinLookup(key, LOC_A, '58203917'))
    expect(() => pinLookup(Buffer.alloc(16), LOC_A, '58203917')).toThrow(/32 bytes/)
  })

  it('derives the key from SESSION_SECRET, with a fixed development value outside production', () => {
    const a = kioskKey({ NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40) })
    expect(a).toHaveLength(32)
    expect(a.equals(kioskKey({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40) }))).toBe(true)
    expect(kioskKey({ NODE_ENV: 'test' }).equals(kioskKey({ NODE_ENV: 'development' }))).toBe(true)
    expect(() => kioskKey({ NODE_ENV: 'production' })).toThrow(/SESSION_SECRET/)
  })
})
