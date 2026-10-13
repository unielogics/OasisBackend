// kioskLockTime (ADR 0180, plan section A "Lock time"): closing + 2 h on an open day, the previous day's window past midnight,
// 2 hours on a closed day / after close + 2 h / more than 3 h before opening, a 20-hour cap, and real hours across DST.
import { describe, expect, it } from 'vitest'
import { kioskLockTime } from '../../src/modules/kiosk/lock-time.js'
import { dayInfo, type DayInfo } from '../../src/modules/settings/day-info.js'
import type { HoursDay } from '../../src/modules/settings/hours.js'
import { addDays, bizWeekday } from '../../src/platform/time.js'

const TZ = 'America/New_York'

/** Open every day from `open` to `close` (minutes), except the listed weekdays. */
const week = (open: number, close: number, closedWeekdays: number[] = []): HoursDay[] =>
  [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, isOpen: !closedWeekdays.includes(weekday), openMin: open, closeMin: close }))

const day = (date: string, hours: HoursDay[], closures: Parameters<typeof dayInfo>[0]['closures'] = []): DayInfo =>
  dayInfo({ date, hours, closures })

function lock(nowIso: string, hours: HoursDay[], o: { today?: DayInfo; yesterday?: DayInfo } = {}) {
  const now = new Date(nowIso)
  const date = nowIso.slice(0, 10)
  return kioskLockTime({
    now,
    tz: TZ,
    today: o.today ?? day(date, hours),
    yesterday: o.yesterday ?? day(addDays(date, -1), hours),
  })
}

const iso = (d: Date) => d.toISOString()

describe('kioskLockTime', () => {
  const hours = week(8 * 60, 18 * 60) // 8:00 AM to 6:00 PM

  it('an open day locks at closing + 2 hours', () => {
    const r = lock('2026-06-15T07:58:00-04:00', hours)
    expect(r.rule).toBe('closing')
    expect(iso(r.locksAt)).toBe(iso(new Date('2026-06-15T20:00:00-04:00')))
  })

  it('after closing but before closing + 2 hours still locks at closing + 2 hours', () => {
    const r = lock('2026-06-15T19:10:00-04:00', hours)
    expect(r.rule).toBe('closing')
    expect(iso(r.locksAt)).toBe(iso(new Date('2026-06-15T20:00:00-04:00')))
  })

  it('past closing + 2 hours unlocks for 2 hours', () => {
    const r = lock('2026-06-15T20:30:00-04:00', hours)
    expect(r.rule).toBe('two_hours')
    expect(iso(r.locksAt)).toBe(iso(new Date('2026-06-15T22:30:00-04:00')))
  })

  it('a closed day (regular day off) unlocks for 2 hours', () => {
    const closedSunday = week(480, 1080, [0])
    expect(bizWeekday('2026-06-14')).toBe(0)
    const r = lock('2026-06-14T11:00:00-04:00', closedSunday)
    expect(r.rule).toBe('two_hours')
    expect(iso(r.locksAt)).toBe(iso(new Date('2026-06-14T13:00:00-04:00')))
  })

  it('a holiday or emergency closure unlocks for 2 hours', () => {
    const today = day('2026-06-15', hours, [
      { id: 'c1', date: '2026-06-15', name: 'Storm', type: 'closed', openMin: null, closeMin: null, source: 'emergency', deletedAt: null },
    ])
    expect(today.closed).toBe(true)
    const r = lock('2026-06-15T09:00:00-04:00', hours, { today })
    expect(r.rule).toBe('two_hours')
    expect(iso(r.locksAt)).toBe(iso(new Date('2026-06-15T11:00:00-04:00')))
  })

  it('reduced hours lock at the reduced closing + 2 hours', () => {
    const today = day('2026-06-15', hours, [
      { id: 'c2', date: '2026-06-15', name: 'Half day', type: 'reduced', openMin: 480, closeMin: 720, source: 'manual', deletedAt: null },
    ])
    const r = lock('2026-06-15T09:00:00-04:00', hours, { today })
    expect(r.rule).toBe('closing')
    expect(iso(r.locksAt)).toBe(iso(new Date('2026-06-15T14:00:00-04:00')))
  })

  it('a close that runs past midnight: the previous day window still counts', () => {
    const late = week(9 * 60, 23 * 60 + 30) // closes 11:30 PM
    const r = lock('2026-06-16T00:45:00-04:00', late)
    expect(r.rule).toBe('previous_day')
    expect(iso(r.locksAt)).toBe(iso(new Date('2026-06-16T01:30:00-04:00')))
  })

  it('a closing at midnight (1440, a reduced day) rolls over to the next day', () => {
    const yesterday = day('2026-06-15', hours, [
      { id: 'c3', date: '2026-06-15', name: 'Late night', type: 'reduced', openMin: 600, closeMin: 1440, source: 'manual', deletedAt: null },
    ])
    const r = lock('2026-06-16T01:00:00-04:00', hours, { yesterday })
    expect(r.rule).toBe('previous_day')
    expect(iso(r.locksAt)).toBe(iso(new Date('2026-06-16T02:00:00-04:00')))
  })

  it('more than 3 hours before opening (the night) unlocks for 2 hours, not until tonight', () => {
    const r = lock('2026-06-15T04:30:00-04:00', hours)
    expect(r.rule).toBe('two_hours')
    expect(iso(r.locksAt)).toBe(iso(new Date('2026-06-15T06:30:00-04:00')))
  })

  it('within 3 hours of opening locks at closing + 2 hours', () => {
    const r = lock('2026-06-15T05:00:00-04:00', hours)
    expect(r.rule).toBe('closing')
    expect(iso(r.locksAt)).toBe(iso(new Date('2026-06-15T20:00:00-04:00')))
  })

  it('caps at 20 hours', () => {
    const long = week(5 * 60, 23 * 60 + 30) // opens 5:00 AM, closes 11:30 PM; night cutoff 2:00 AM
    const r = lock('2026-06-15T02:30:00-04:00', long)
    // closing + 2 h would be 01:30 the next day (23 h away): capped at now + 20 h
    expect(r.rule).toBe('closing')
    expect(iso(r.locksAt)).toBe(iso(new Date('2026-06-15T22:30:00-04:00')))
  })

  it('DST spring forward: closing + 2 hours is two real hours', () => {
    // 2026-03-08: clocks go from 2:00 AM to 3:00 AM; a late reduced day closing at 1:30 AM is impossible, so use the next night
    const late = week(9 * 60, 23 * 60 + 30)
    const r = lock('2026-03-08T00:45:00-05:00', late) // yesterday (Mar 7, EST) closed 23:30 EST
    expect(r.rule).toBe('previous_day')
    expect(iso(r.locksAt)).toBe(iso(new Date('2026-03-08T01:30:00-05:00')))
    // 23:30 EST on Mar 7 + 2 h = 01:30 EST = 06:30 UTC
    expect(iso(r.locksAt)).toBe('2026-03-08T06:30:00.000Z')
    const evening = lock('2026-03-08T10:00:00-04:00', hours)
    expect(iso(evening.locksAt)).toBe(iso(new Date('2026-03-08T20:00:00-04:00')))
  })

  it('DST fall back: the +2 hours is added to the instant, not the wall clock', () => {
    // 2026-11-01: clocks go from 2:00 AM EDT back to 1:00 AM EST. A close at 23:30 EDT on Oct 31 + 2 h = 00:30 EST... = 01:30 EDT
    // wall -> the real instant 03:30 UTC + 2 h = 05:30 UTC (01:30 EDT would be 05:30 UTC, 00:30 EST would also be 05:30 UTC)
    const late = week(9 * 60, 23 * 60 + 30)
    const r = lock('2026-11-01T01:10:00-04:00', late)
    expect(r.rule).toBe('previous_day')
    expect(iso(r.locksAt)).toBe('2026-11-01T05:30:00.000Z')
    expect(r.locksAt.getTime() - new Date('2026-10-31T23:30:00-04:00').getTime()).toBe(2 * 3600_000)
  })

  it('never locks in the past and never sooner than now', () => {
    for (let h = 0; h < 24; h++) {
      const at = `2026-06-15T${String(h).padStart(2, '0')}:17:00-04:00`
      const r = lock(at, hours)
      expect(r.locksAt.getTime()).toBeGreaterThan(new Date(at).getTime())
      expect(r.locksAt.getTime() - new Date(at).getTime()).toBeLessThanOrEqual(20 * 3600_000)
    }
  })
})
