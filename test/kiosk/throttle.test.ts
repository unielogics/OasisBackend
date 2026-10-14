// The kiosk unlock throttle (ADR 0180 and its amendment): per browser (persisted) 3 free wrong PINs, then 2, 4, 8 ... seconds up to 5
// minutes, and a lockout at 20; per shop address (persisted) 5 free and a lockout at 30; across every browser more than 60 wrong PINs
// an hour slows everyone; the refused list is written at most once a minute per address.
import { describe, expect, it } from 'vitest'
import {
  deviceRetryAfterSec,
  KIOSK_ADDRESS_RULE,
  KIOSK_BROWSER_RULE,
  KIOSK_LOCKOUT_FAILURES,
  kioskDelaySec,
  KioskUnlockGuard,
  retryAfterSec,
} from '../../src/modules/kiosk/throttle.js'
import { FixedClock } from '../../src/platform/clock.js'

describe('per-browser delay', () => {
  it('3 free failures, then doubling from 2 s, capped at 300 s', () => {
    expect([0, 1, 2, 3].map((n) => kioskDelaySec(n))).toEqual([0, 0, 0, 0])
    expect([4, 5, 6, 7, 8, 9, 10, 11, 12, 19].map((n) => kioskDelaySec(n))).toEqual([2, 4, 8, 16, 32, 64, 128, 256, 300, 300])
    expect(KIOSK_LOCKOUT_FAILURES).toBe(20)
    expect(KIOSK_BROWSER_RULE).toEqual({ free: 3, lockout: 20 })
  })

  it('counts the wait from the last failure', () => {
    const last = new Date('2026-06-15T12:00:00Z')
    expect(deviceRetryAfterSec({ failedAttempts: 3, lastFailedAt: last }, new Date('2026-06-15T12:00:00Z'))).toBe(0)
    expect(deviceRetryAfterSec({ failedAttempts: 5, lastFailedAt: last }, new Date('2026-06-15T12:00:01Z'))).toBe(3)
    expect(deviceRetryAfterSec({ failedAttempts: 5, lastFailedAt: last }, new Date('2026-06-15T12:00:04Z'))).toBe(0)
    expect(deviceRetryAfterSec({ failedAttempts: 9, lastFailedAt: null }, new Date())).toBe(0)
  })

  it('20 failures take most of an hour of enforced waiting', () => {
    let total = 0
    for (let n = 1; n < KIOSK_LOCKOUT_FAILURES; n++) total += kioskDelaySec(n)
    expect(total).toBeGreaterThan(45 * 60)
  })
})

describe('per-address delay', () => {
  it('5 free failures (every browser at the shop shares the address), then the same doubling; a lockout at 30', () => {
    expect(KIOSK_ADDRESS_RULE).toEqual({ free: 5, lockout: 30 })
    expect([0, 5, 6, 7, 8, 29].map((n) => kioskDelaySec(n, KIOSK_ADDRESS_RULE))).toEqual([0, 0, 2, 4, 8, 300])
    const last = new Date('2026-06-15T12:00:00Z')
    expect(retryAfterSec({ failedAttempts: 6, lastFailedAt: last }, new Date('2026-06-15T12:00:01Z'), KIOSK_ADDRESS_RULE)).toBe(1)
    expect(retryAfterSec({ failedAttempts: 5, lastFailedAt: last }, last, KIOSK_ADDRESS_RULE)).toBe(0)
  })
})

describe('KioskUnlockGuard', () => {
  it('more than 60 failures an hour adds a 30 s delay for everyone and alerts once', () => {
    const clock = new FixedClock('2026-06-15T12:00:00Z')
    const g = new KioskUnlockGuard(clock)
    const alerts: boolean[] = []
    for (let i = 0; i < 60; i++) {
      alerts.push(g.failure().alert)
      clock.advance(1000)
    }
    expect(alerts.some(Boolean)).toBe(false)
    expect(g.globalRetryAfterSec()).toBe(0)
    expect(g.failure().alert).toBe(true)
    expect(g.globalRetryAfterSec()).toBe(30)
    expect(g.failure().alert).toBe(false)
    clock.advance(61 * 60_000)
    expect(g.globalRetryAfterSec()).toBe(0)
  })

  it('writes a refused address at most once a minute, adding the tries in between', () => {
    const clock = new FixedClock('2026-06-15T12:00:00Z')
    const g = new KioskUnlockGuard(clock)
    expect(g.refusedTry('203.0.113.9/32')).toBe(1)
    expect(g.refusedTry('203.0.113.9/32')).toBe(0)
    expect(g.refusedTry('203.0.113.9/32')).toBe(0)
    expect(g.refusedTry('198.51.100.4/32')).toBe(1) // another address has its own minute
    clock.advance(59_000)
    expect(g.refusedTry('203.0.113.9/32')).toBe(0)
    clock.advance(1000)
    expect(g.refusedTry('203.0.113.9/32')).toBe(4) // the three held back and this one
    g.reset()
    expect(g.refusedTry('203.0.113.9/32')).toBe(1)
  })

  it('forgets old addresses instead of growing without end', () => {
    const clock = new FixedClock('2026-06-15T12:00:00Z')
    const g = new KioskUnlockGuard(clock)
    for (let i = 0; i < 2500; i++) expect(g.refusedTry(`10.${i >> 8}.${i & 255}.1/32`)).toBe(1)
    expect((g as unknown as { refused: Map<string, unknown> }).refused.size).toBeLessThanOrEqual(2000)
  })
})
