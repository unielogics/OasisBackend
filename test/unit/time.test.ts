import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  addDays,
  atLabel,
  bizDayBounds,
  bizWeekday,
  clockLabel,
  dateLabel,
  dayLengthMinutes,
  diffDays,
  fmtT,
  isValidBizDate,
  isValidTimeZone,
  isoInTz,
  minutesOfDay,
  nowInfo,
  parseT,
  toBizDate,
  tryParseT,
  wallToInstant,
} from '../../src/platform/time.js'

const NOW = new Date('2026-06-13T14:36:00Z') // Saturday 10:36 AM Eastern

describe('fmtT / parseT', () => {
  it.each([
    [0, '12:00 AM'],
    [300, '5:00 AM'],
    [570, '9:30 AM'],
    [636, '10:36 AM'],
    [720, '12:00 PM'],
    [735, '12:15 PM'],
    [1410, '11:30 PM'],
  ])('fmtT(%i) = %s and parses back', (min, label) => {
    expect(fmtT(min)).toBe(label)
    expect(parseT(label)).toBe(min)
  })

  it('wraps past midnight and below zero (an ETA after closing shows the next day clock time)', () => {
    expect(fmtT(1440)).toBe('12:00 AM')
    expect(fmtT(1500)).toBe('1:00 AM')
    expect(fmtT(-30)).toBe('11:30 PM')
  })

  it('parseT accepts case, padding and spacing variants and rejects garbage', () => {
    expect(parseT('9:00 am')).toBe(540)
    expect(parseT('09:00AM')).toBe(540)
    expect(parseT('  12:00 AM ')).toBe(0)
    expect(tryParseT('13:00 PM')).toBeNull()
    expect(tryParseT('0:30 AM')).toBeNull()
    expect(tryParseT('9:60 AM')).toBeNull()
    expect(tryParseT('noon')).toBeNull()
    expect(() => parseT('9am')).toThrow(RangeError)
  })

  it('round-trips every minute of the day', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 1439 }), (m) => parseT(fmtT(m)) === m))
  })
})

describe('business-date helpers', () => {
  it('computes business date, weekday and minutes in the business tz, not UTC', () => {
    const lateNight = new Date('2026-06-14T03:30:00Z') // 11:30 PM Saturday Eastern, already Sunday in UTC
    expect(toBizDate(lateNight)).toBe('2026-06-13')
    expect(bizWeekday('2026-06-13')).toBe(6)
    expect(bizWeekday('2026-06-14')).toBe(0)
    expect(minutesOfDay(lateNight)).toBe(23 * 60 + 30)
  })

  it('adds days and diffs across month ends and DST changes', () => {
    expect(addDays('2026-06-30', 1)).toBe('2026-07-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(diffDays('2026-03-07', '2026-03-09')).toBe(2)
    expect(diffDays('2026-11-01', '2026-10-31')).toBe(-1)
  })

  it('validates business dates and time zones', () => {
    expect(isValidBizDate('2026-02-29')).toBe(false)
    expect(isValidBizDate('2028-02-29')).toBe(true)
    expect(isValidBizDate('6/13/2026')).toBe(false)
    expect(isValidTimeZone('America/New_York')).toBe(true)
    expect(isValidTimeZone('Mars/Olympus')).toBe(false)
    expect(() => addDays('nope', 1)).toThrow(RangeError)
  })
})

describe('DST safety', () => {
  it('day length is 23h on spring-forward, 25h on fall-back, 24h otherwise', () => {
    expect(dayLengthMinutes('2026-03-08')).toBe(23 * 60)
    expect(dayLengthMinutes('2026-11-01')).toBe(25 * 60)
    expect(dayLengthMinutes('2026-06-13')).toBe(24 * 60)
  })

  it('bizDayBounds is [local midnight, next local midnight) in UTC', () => {
    expect(bizDayBounds('2026-06-13')).toEqual({
      start: new Date('2026-06-13T04:00:00Z'),
      end: new Date('2026-06-14T04:00:00Z'),
    })
    expect(bizDayBounds('2026-11-01')).toEqual({
      start: new Date('2026-11-01T04:00:00Z'),
      end: new Date('2026-11-02T05:00:00Z'),
    })
  })

  it('wallToInstant maps wall clock to the right instant on normal and DST days', () => {
    expect(wallToInstant('2026-06-13', 9 * 60).toISOString()).toBe('2026-06-13T13:00:00.000Z')
    expect(wallToInstant('2026-01-15', 9 * 60).toISOString()).toBe('2026-01-15T14:00:00.000Z')
    // 2:30 AM does not exist on spring-forward: lands after the gap (3:30 EDT)
    expect(wallToInstant('2026-03-08', 150).toISOString()).toBe('2026-03-08T07:30:00.000Z')
    // 1:30 AM happens twice on fall-back: the first occurrence (EDT)
    expect(wallToInstant('2026-11-01', 90).toISOString()).toBe('2026-11-01T05:30:00.000Z')
    expect(() => wallToInstant('2026-06-13', 1440)).toThrow(RangeError)
  })

  it('wall-clock minutes of an instant survive the DST boundary', () => {
    expect(minutesOfDay(new Date('2026-03-08T06:59:00Z'))).toBe(1 * 60 + 59) // 1:59 EST
    expect(minutesOfDay(new Date('2026-03-08T07:00:00Z'))).toBe(3 * 60) // jumps to 3:00 EDT
  })

  it('a UTC instant for any wall time in business hours converts back to the same minutes (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 364 }),
        fc.integer({ min: 300, max: 1410 }),
        (dayOfYear, minutes) => {
          const date = addDays('2026-01-01', dayOfYear)
          const instant = wallToInstant(date, minutes)
          const back = minutesOfDay(instant)
          // only the spring-forward gap (2:00-2:59 on 2026-03-08) may shift
          if (!(date === '2026-03-08' && minutes >= 120 && minutes < 180)) expect(back).toBe(minutes)
          expect(toBizDate(instant)).toBe(date)
        },
      ),
    )
  })
})

describe('labels', () => {
  it('clockLabel and dateLabel', () => {
    expect(clockLabel(NOW)).toBe('10:36 AM')
    expect(dateLabel(NOW)).toBe('Saturday, June 13')
  })

  it('atLabel: Today / Yesterday / Mon D', () => {
    expect(atLabel(new Date('2026-06-13T19:07:00Z'), NOW)).toBe('Today 3:07 PM')
    expect(atLabel(new Date('2026-06-12T20:40:00Z'), NOW)).toBe('Yesterday 4:40 PM')
    expect(atLabel(new Date('2026-06-11T13:12:00Z'), NOW)).toBe('Jun 11 · 9:12 AM')
    expect(atLabel(new Date('2026-05-30T15:45:00Z'), NOW)).toBe('May 30 · 11:45 AM')
  })

  it('atLabel uses the business day, not the UTC day', () => {
    // 01:00 UTC on Jun 13 is 9 PM Jun 12 Eastern: Yesterday
    expect(atLabel(new Date('2026-06-13T01:00:00Z'), NOW)).toBe('Yesterday 9:00 PM')
    // 03:30 UTC Jun 14 is 11:30 PM Jun 13 Eastern: still Today
    expect(atLabel(new Date('2026-06-14T03:30:00Z'), NOW)).toBe('Today 11:30 PM')
  })

  it('atLabel adds the year for other years', () => {
    expect(atLabel(new Date('2025-12-30T14:12:00Z'), NOW)).toBe('Dec 30, 2025 · 9:12 AM')
  })

  it('nowInfo matches the /meta/now contract', () => {
    expect(nowInfo(NOW)).toEqual({
      now: '2026-06-13T14:36:00.000Z',
      tz: 'America/New_York',
      bizDate: '2026-06-13',
      weekday: 6,
      minutes: 636,
      dateLabel: 'Saturday, June 13',
    })
  })

  it('isoInTz renders the business offset', () => {
    expect(isoInTz(NOW)).toBe('2026-06-13T10:36:00-04:00')
    expect(isoInTz(new Date('2026-01-15T15:00:00Z'))).toBe('2026-01-15T10:00:00-05:00')
  })

  it('other time zones work (single-location today, multi-location later)', () => {
    expect(toBizDate(NOW, 'America/Los_Angeles')).toBe('2026-06-13')
    expect(minutesOfDay(NOW, 'America/Los_Angeles')).toBe(7 * 60 + 36)
  })
})
