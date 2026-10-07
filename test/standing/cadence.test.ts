import { describe, expect, it } from 'vitest'
import {
  nthWeekdayOfMonth,
  occurrenceDates,
  ordinalOf,
  weekdayOf,
} from '../../src/modules/standing/cadence.js'

describe('standing cadence dates', () => {
  it('weekday and ordinal of a date', () => {
    expect(weekdayOf('2026-06-13')).toBe(6) // Saturday
    expect(weekdayOf('2026-06-14')).toBe(0) // Sunday
    expect(ordinalOf('2026-06-13')).toBe(2)
    expect(ordinalOf('2026-06-29')).toBe(5)
  })

  it('weekly, every 2 weeks and every 3 weeks step from the start date, inclusive of the window ends', () => {
    const base = { startDate: '2026-06-13', endDate: null }
    expect(occurrenceDates({ ...base, cadence: 'weekly' }, '2026-06-13', '2026-07-04')).toEqual([
      '2026-06-13',
      '2026-06-20',
      '2026-06-27',
      '2026-07-04',
    ])
    expect(occurrenceDates({ ...base, cadence: 'biweekly' }, '2026-06-14', '2026-08-01')).toEqual([
      '2026-06-27',
      '2026-07-11',
      '2026-07-25',
    ])
    expect(occurrenceDates({ ...base, cadence: 'triweekly' }, '2026-06-01', '2026-08-31')).toEqual([
      '2026-06-13',
      '2026-07-04',
      '2026-07-25',
      '2026-08-15',
    ])
  })

  it('never goes before the start date and stops at the end date', () => {
    const s = { cadence: 'weekly' as const, startDate: '2026-06-13', endDate: '2026-06-27' }
    expect(occurrenceDates(s, '2026-01-01', '2026-12-31')).toEqual(['2026-06-13', '2026-06-20', '2026-06-27'])
    expect(occurrenceDates({ ...s, endDate: '2026-06-12' }, '2026-01-01', '2026-12-31')).toEqual([])
  })

  it('monthly keeps the same weekday and the same occurrence in the month (2nd Saturday)', () => {
    const s = { cadence: 'monthly' as const, startDate: '2026-06-13', endDate: null }
    expect(occurrenceDates(s, '2026-06-01', '2026-10-31')).toEqual([
      '2026-06-13',
      '2026-07-11',
      '2026-08-08',
      '2026-09-12',
      '2026-10-10',
    ])
  })

  it('a fifth weekday becomes the last one of a month that has no fifth', () => {
    const s = { cadence: 'monthly' as const, startDate: '2026-05-30', endDate: null } // the 5th Saturday of May 2026
    expect(occurrenceDates(s, '2026-05-01', '2026-08-31')).toEqual([
      '2026-05-30',
      '2026-06-27',
      '2026-07-25',
      '2026-08-29',
    ])
    expect(nthWeekdayOfMonth(2026, 2, 6, 5)).toBe('2026-02-28')
  })

  it('a monthly series starting mid-window does not emit the start month occurrence before the start date', () => {
    const s = { cadence: 'monthly' as const, startDate: '2026-06-20', endDate: null } // the 3rd Saturday
    expect(occurrenceDates(s, '2026-06-01', '2026-07-31')).toEqual(['2026-06-20', '2026-07-18'])
  })
})
