// The PIN's pure rules (ADR 0160, design section 5): 4 to 6 digits; the blocklist (common PINs, one digit repeated, runs, years
// 1940-2015, the end of the client's own number); the lockout schedule; the hash is scrypt over HMAC(pepper, customerId:pin), bound
// to the pepper and the client; and a client without a PIN costs exactly the same work as a wrong PIN.
import { describe, expect, it, vi } from 'vitest'
import { PasswordHasher } from '../../src/modules/auth/password.js'
import { COMMON_PINS, pinHasherFromEnv, pinProblem, PinHasher } from '../../src/modules/identity/pin.js'
import { lockLevelFor, PIN_LOCK_SCHEDULE } from '../../src/modules/identity/pin-service.js'
import { CHEAP_SCRYPT } from './world.js'

const PHONE = '+12015550142'

describe('pinProblem (the blocklist)', () => {
  it('takes 4 to 6 digits and nothing else', () => {
    for (const ok of ['4831', '48317', '483172']) expect(pinProblem(ok, PHONE), ok).toBeNull()
    for (const bad of ['483', '4831725', '48a1', ' 4831', '４８３１', '', '48.1'])
      expect(pinProblem(bad, PHONE), bad).toMatch(/4 to 6 digits/)
  })

  it('refuses the most common PINs (at least the top 100)', () => {
    expect(COMMON_PINS.size).toBeGreaterThanOrEqual(100)
    for (const p of ['1234', '1111', '0000', '1212', '7777', '1004', '2000', '6969', '2580', '1122', '1313'])
      expect(pinProblem(p, PHONE), p).not.toBeNull()
  })

  it('refuses one digit repeated and runs in either direction, at every length (wrapping 9 to 0)', () => {
    for (const p of ['2222', '55555', '999999', '3456', '45678', '123456', '6543', '98765', '7890', '0987', '890123'])
      expect(pinProblem(p, PHONE), p).not.toBeNull()
    expect(pinProblem('1357', null)).not.toBeNull() // common
    expect(pinProblem('3579', null)).toBeNull() // a step of two is not a run
  })

  it('refuses the years 1940 to 2015 and accepts the ones around them', () => {
    for (const y of ['1940', '1953', '1967', '2015']) expect(pinProblem(y, PHONE), y).toMatch(/year/)
    expect(pinProblem('1939', PHONE)).toBeNull()
    expect(pinProblem('2016', PHONE)).toBeNull()
  })

  it('refuses the last 4, 5 or 6 digits of the client’s own number', () => {
    expect(pinProblem('0142', PHONE)).toMatch(/phone number/)
    expect(pinProblem('50142', PHONE)).toMatch(/phone number/)
    expect(pinProblem('550142', PHONE)).toMatch(/phone number/)
    expect(pinProblem('0142', '+12015559999')).toBeNull()
  })
})

describe('the lockout schedule', () => {
  it('locks 15 minutes after 5 wrong PINs, 1 hour after 3 more, and disables after 3 more', () => {
    expect(PIN_LOCK_SCHEDULE.map((s) => [s.afterFailures, s.lockMs])).toEqual([
      [5, 15 * 60_000],
      [8, 60 * 60_000],
      [11, null],
    ])
    expect([0, 4, 5, 7, 8, 10, 11, 30].map(lockLevelFor)).toEqual([0, 0, 1, 1, 2, 2, 3, 3])
  })
})

describe('PinHasher', () => {
  const pepper = Buffer.alloc(32, 7)
  const h = new PinHasher(pepper, CHEAP_SCRYPT)

  it('stores scrypt of a peppered HMAC: never the PIN, bound to the client and to the pepper', async () => {
    const stored = await h.hash('cust-a', '4831')
    expect(stored).toMatch(/^\$scrypt\$ln=6,r=8,p=1\$/)
    expect(stored).not.toContain('4831')
    expect(await h.verify('cust-a', '4831', stored)).toBe(true)
    expect(await h.verify('cust-a', '4832', stored)).toBe(false)
    expect(await h.verify('cust-b', '4831', stored)).toBe(false)
    expect(await new PinHasher(Buffer.alloc(32, 8), CHEAP_SCRYPT).verify('cust-a', '4831', stored)).toBe(false)
    // a plain scrypt of the PIN (no pepper) does not match either
    expect(await new PasswordHasher(CHEAP_SCRYPT).verify('4831', stored)).toBe(false)
  })

  it('does the same scrypt work, at the same cost, when the client has no PIN', async () => {
    const stored = await h.hash('cust-a', '4831')
    const spy = vi.spyOn(PasswordHasher.prototype, 'verify')
    await h.verify('cust-a', '9999', stored)
    await h.verifyNone('cust-a', '9999')
    expect(spy).toHaveBeenCalledTimes(2)
    const [withPin, without] = spy.mock.calls.map((c) => c[1].split('$')[2])
    expect(without).toBe(withPin) // ln, r, p of the dummy hash equal the real one's
    spy.mockRestore()
  })

  it('takes the environment’s pepper (base64, base64url or hex, 32 bytes) and refuses to run without one', async () => {
    const hex = pepper.toString('hex')
    const a = pinHasherFromEnv({ PIN_PEPPER: hex }, CHEAP_SCRYPT)
    const b = pinHasherFromEnv({ PIN_PEPPER: pepper.toString('base64') }, CHEAP_SCRYPT)
    expect(await b.verify('c', '4831', await a.hash('c', '4831'))).toBe(true)
    expect(() => pinHasherFromEnv({ PIN_PEPPER: undefined })).toThrow(/PIN_PEPPER/)
    expect(() => pinHasherFromEnv({ PIN_PEPPER: 'short' })).toThrow(/PIN_PEPPER/)
    expect(() => new PinHasher(Buffer.alloc(16))).toThrow(/32 bytes/)
  })
})
