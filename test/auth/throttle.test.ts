import { describe, expect, it } from 'vitest'
import { LoginThrottle } from '../../src/modules/auth/throttle.js'
import { FixedClock } from '../../src/platform/clock.js'

const setup = () => {
  const clock = new FixedClock('2026-06-13T10:36:00-04:00')
  return { clock, t: new LoginThrottle(clock) }
}

describe('LoginThrottle', () => {
  it('allows a few free failures per account, then doubles the wait up to the cap', () => {
    const { clock, t } = setup()
    const waits: number[] = []
    for (let i = 0; i < 12; i++) {
      clock.advance(60_000) // a new IP each time keeps the IP rule out of the way
      t.failure(`ip${i}`, 'a@x')
      waits.push(t.retryAfterSec(`other${i}`, 'a@x'))
    }
    expect(waits).toEqual([0, 0, 0, 0, 1, 2, 4, 8, 16, 30, 30, 30])
  })

  it('does not extend the wait for attempts made during it (nobody can pin an account down)', () => {
    const { clock, t } = setup()
    for (let i = 0; i < 5; i++) t.failure('ip', 'a@x')
    expect(t.retryAfterSec('ip2', 'a@x')).toBe(1)
    for (let i = 0; i < 20; i++) expect(t.retryAfterSec('ip2', 'a@x')).toBe(1) // checking is free
    clock.advance(1000)
    expect(t.retryAfterSec('ip2', 'a@x')).toBe(0)
  })

  it('counts per IP across accounts, free for 10, capped at 2 minutes', () => {
    const { t } = setup()
    for (let i = 0; i < 10; i++) t.failure('1.2.3.4', `u${i}@x`)
    expect(t.retryAfterSec('1.2.3.4', 'fresh@x')).toBe(0)
    t.failure('1.2.3.4', 'u11@x')
    expect(t.retryAfterSec('1.2.3.4', 'fresh@x')).toBe(1)
    for (let i = 0; i < 20; i++) t.failure('1.2.3.4', 'u@x')
    expect(t.retryAfterSec('1.2.3.4', 'fresh@x')).toBe(120)
    expect(t.retryAfterSec('5.6.7.8', 'fresh@x')).toBe(0)
  })

  it('resets an account on success but leaves the IP counter, and forgets after a quiet period', () => {
    const { clock, t } = setup()
    for (let i = 0; i < 11; i++) t.failure('ip', 'a@x')
    expect(t.retryAfterSec('ip', 'zzz@x')).toBe(1)
    t.success('a@x')
    expect(t.retryAfterSec('other', 'a@x')).toBe(0)
    expect(t.retryAfterSec('ip', 'zzz@x')).toBe(1)
    clock.advance(15 * 60_000 + 1)
    expect(t.retryAfterSec('ip', 'zzz@x')).toBe(0)
    t.failure('ip', 'a@x')
    expect(t.retryAfterSec('ip', 'zzz@x')).toBe(0) // the old count decayed
  })
})
