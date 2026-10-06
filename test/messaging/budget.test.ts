import { describe, expect, it } from 'vitest'
import { canSpend, DEFAULT_BUDGET, laneLimit, nextFit, snapshot, usedInWindow, type UsagePoint } from '../../src/modules/messaging/dispatch/budget.js'
import { dispatcherConfigFromEnv, parseQuietHours } from '../../src/modules/messaging/dispatch/config.js'
import { backoffMs, DEFAULT_RETRY, isTransientReason, nextRetryProviderId, retryProviderId } from '../../src/modules/messaging/dispatch/retry.js'

const T0 = new Date('2026-06-13T12:00:00-04:00')
const at = (min: number): Date => new Date(T0.getTime() + min * 60_000)
const pts = (...mins: number[]): UsagePoint[] => mins.map((m) => ({ at: at(m), segments: 1 }))

describe('sliding window budget', () => {
  it('counts only entries inside the window, the boundary entry has left', () => {
    const u = pts(0, 10, 29, 30)
    expect(usedInWindow(u, at(30), DEFAULT_BUDGET.windowMs)).toBe(3)
    expect(usedInWindow(u, at(30.5), DEFAULT_BUDGET.windowMs)).toBe(3)
    expect(usedInWindow(u, at(40.5), DEFAULT_BUDGET.windowMs)).toBe(2)
    expect(usedInWindow(u, at(61), DEFAULT_BUDGET.windowMs)).toBe(0)
  })

  it('lane 0 may use the whole window, other lanes lose the reserve', () => {
    expect(laneLimit(0, DEFAULT_BUDGET)).toBe(30)
    expect(laneLimit(1, DEFAULT_BUDGET)).toBe(24)
    expect(laneLimit(3, DEFAULT_BUDGET)).toBe(24)
    expect(laneLimit(0, { ...DEFAULT_BUDGET, safetyMargin: 2 })).toBe(28)
    expect(laneLimit(2, { ...DEFAULT_BUDGET, reservedForP0: 99 })).toBe(0)
  })

  it('canSpend respects the lane and the cost', () => {
    const used24 = Array.from({ length: 24 }, () => ({ at: at(-1), segments: 1 }))
    expect(canSpend(used24, T0, 1, 3, DEFAULT_BUDGET)).toBe(false)
    expect(canSpend(used24, T0, 1, 0, DEFAULT_BUDGET)).toBe(true)
    expect(canSpend(used24, T0, 7, 0, DEFAULT_BUDGET)).toBe(false)
  })

  it('nextFit finds when room appears, or never for an oversize message', () => {
    const full = Array.from({ length: 30 }, (_, i) => ({ at: at(i), segments: 1 }))
    expect(nextFit(full, at(30), 1, 0, DEFAULT_BUDGET)?.getTime()).toBe(at(30).getTime())
    expect(nextFit(full, at(5), 1, 0, DEFAULT_BUDGET)?.getTime()).toBe(at(30).getTime())
    expect(nextFit(full, at(5), 3, 0, DEFAULT_BUDGET)?.getTime()).toBe(at(32).getTime())
    expect(nextFit([], at(0), 31, 0, DEFAULT_BUDGET)).toBeNull()
    expect(nextFit([], at(0), 25, 1, DEFAULT_BUDGET)).toBeNull()
    expect(nextFit([], at(0), 5, 1, DEFAULT_BUDGET)?.getTime()).toBe(at(0).getTime())
  })

  it('snapshot reports what each lane has left', () => {
    expect(snapshot(pts(0, 1, 2), at(3), DEFAULT_BUDGET)).toEqual({ used: 3, max: 30, reservedForP0: 6, remainingP0: 27, remainingOthers: 21, windowMs: 30 * 60_000 })
  })
})

describe('retry helpers', () => {
  it('backs off exponentially with a cap', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 10].map((n) => backoffMs(n))).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000])
    expect(DEFAULT_RETRY.maxAttempts).toBe(6)
  })

  it('classifies device failure reasons', () => {
    for (const r of ['Network error', 'Radio off', 'No service', 'Generic failure', 'timeout', 'Service unavailable']) expect(isTransientReason(r), r).toBe(true)
    for (const r of ['Invalid destination address', 'Null PDU', 'blocked', undefined, '']) expect(isTransientReason(r), String(r)).toBe(false)
  })

  it('retry ids stay within the device limit and never collide', () => {
    const uuid = '0198f2c4-7b1e-7c3a-9d4e-5a6b7c8d9e0f'
    const r1 = retryProviderId(uuid, 1)
    expect(r1).toBe('0198f2c47b1e7c3a9d4e5a6b7c8d9e0fr1')
    expect(r1.length).toBeLessThanOrEqual(36)
    expect(nextRetryProviderId(uuid, null)).toBe(r1)
    expect(nextRetryProviderId(uuid, uuid)).toBe(r1)
    expect(nextRetryProviderId(uuid, r1)).toBe('0198f2c47b1e7c3a9d4e5a6b7c8d9e0fr2')
    expect(retryProviderId('x'.repeat(40), 12).length).toBe(36)
  })
})

describe('dispatcherConfigFromEnv', () => {
  it('defaults to 30 per 30 minutes with 6 reserved for lane 0 and 21:00-08:00 Eastern quiet hours', () => {
    const { dispatcher, health } = dispatcherConfigFromEnv('dev-1', {})
    expect(dispatcher.budget).toEqual({ maxPerWindow: 30, windowMs: 1_800_000, reservedForP0: 6, safetyMargin: 0 })
    expect(dispatcher.quietHours).toEqual({ enabled: true, startMinute: 1260, endMinute: 480, timeZone: 'America/New_York' })
    expect(dispatcher.environment).toBe('development')
    expect(dispatcher.allowlist).toEqual([])
    expect(health).toMatchObject({ offlineAfterMs: 600_000, onlineWithinMs: 180_000 })
  })

  it('reads the budget, allowlist, quiet hours and heartbeat settings', () => {
    const { dispatcher, health } = dispatcherConfigFromEnv('dev-1', {
      NODE_ENV: 'production',
      SMSGATE_MAX_PER_WINDOW: '30',
      SMSGATE_WINDOW_MINUTES: '1',
      SMSGATE_RESERVED_P0: '4',
      SMS_ALLOWLIST: '+17865550151, +13055550100 ,',
      SMS_QUIET_HOURS: '22:30-07:15',
      BUSINESS_TZ: 'America/Chicago',
      SMSGATE_HEARTBEAT_STALE_SECONDS: '900',
      SMSGATE_SIM_NUMBER: '2',
    })
    expect(dispatcher.budget).toMatchObject({ windowMs: 60_000, reservedForP0: 4 })
    expect(dispatcher.allowlist).toEqual(['+17865550151', '+13055550100'])
    expect(dispatcher.quietHours).toEqual({ enabled: true, startMinute: 1350, endMinute: 435, timeZone: 'America/Chicago' })
    expect(dispatcher.simSlot).toBe(2)
    expect(health.offlineAfterMs).toBe(900_000)
  })

  it('quiet hours can be switched off and bad values are refused', () => {
    expect(parseQuietHours('off', 'America/New_York').enabled).toBe(false)
    expect(() => parseQuietHours('9pm-8am', 'America/New_York')).toThrow(/SMS_QUIET_HOURS/)
    expect(() => dispatcherConfigFromEnv('d', { SMSGATE_MAX_PER_WINDOW: '0' })).toThrow()
  })

  it('never reserves the whole window', () => {
    expect(dispatcherConfigFromEnv('d', { SMSGATE_MAX_PER_WINDOW: '3', SMSGATE_RESERVED_P0: '9' }).dispatcher.budget.reservedForP0).toBe(2)
  })
})
