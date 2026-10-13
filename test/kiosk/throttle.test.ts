// The kiosk unlock throttle (ADR 0180): per device (persisted) 3 free failures, then 2, 4, 8 ... seconds up to 5 minutes, and a
// lockout at 20; per address 10 free failures up to 120 seconds; across every device more than 60 failures an hour slows everyone.
import { describe, expect, it } from 'vitest'
import {
  deviceRetryAfterSec,
  KIOSK_LOCKOUT_FAILURES,
  kioskDelaySec,
  KioskUnlockGuard,
} from '../../src/modules/kiosk/throttle.js'
import { FixedClock } from '../../src/platform/clock.js'

describe('per-device delay', () => {
  it('3 free failures, then doubling from 2 s, capped at 300 s', () => {
    expect([0, 1, 2, 3].map(kioskDelaySec)).toEqual([0, 0, 0, 0])
    expect([4, 5, 6, 7, 8, 9, 10, 11, 12, 19].map(kioskDelaySec)).toEqual([2, 4, 8, 16, 32, 64, 128, 256, 300, 300])
    expect(KIOSK_LOCKOUT_FAILURES).toBe(20)
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

describe('KioskUnlockGuard', () => {
  it('slows an address after 10 failures, up to 120 s, and decays', () => {
    const clock = new FixedClock('2026-06-15T12:00:00Z')
    const g = new KioskUnlockGuard(clock)
    for (let i = 0; i < 10; i++) g.failure('10.0.0.1')
    expect(g.retryAfterSec('10.0.0.1')).toBe(0)
    g.failure('10.0.0.1')
    expect(g.retryAfterSec('10.0.0.1')).toBe(1)
    expect(g.retryAfterSec('10.0.0.2')).toBe(0)
    for (let i = 0; i < 20; i++) g.failure('10.0.0.1')
    expect(g.retryAfterSec('10.0.0.1')).toBe(120)
    clock.advance(16 * 60_000)
    expect(g.retryAfterSec('10.0.0.1')).toBe(0)
  })

  it('more than 60 failures an hour across devices adds a 30 s delay for everyone and alerts once', () => {
    const clock = new FixedClock('2026-06-15T12:00:00Z')
    const g = new KioskUnlockGuard(clock)
    const alerts: boolean[] = []
    for (let i = 0; i < 60; i++) {
      alerts.push(g.failure(`10.9.${i}.1`).alert)
      clock.advance(1000)
    }
    expect(alerts.some(Boolean)).toBe(false)
    expect(g.retryAfterSec('10.1.1.1')).toBe(0)
    expect(g.failure('10.9.200.1').alert).toBe(true)
    expect(g.retryAfterSec('10.1.1.1')).toBe(30)
    expect(g.failure('10.9.201.1').alert).toBe(false)
    clock.advance(61 * 60_000)
    expect(g.retryAfterSec('10.1.1.1')).toBe(0)
  })
})
