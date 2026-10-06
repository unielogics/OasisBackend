import { describe, expect, it } from 'vitest'
import { canSpend, DEFAULT_BUDGET, laneLimit, nextFit, snapshot, usedInWindow, type UsagePoint } from '../../src/modules/messaging/dispatch/budget.js'
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
