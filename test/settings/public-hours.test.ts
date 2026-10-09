import { describe, expect, it } from 'vitest'
import type { DayInfoInput, EmergencySnapshot } from '../../src/modules/settings/day-info.js'
import { DEFAULT_HOURS } from '../../src/modules/settings/defaults.js'
import { PUBLIC_HOURS_DAYS, publicHoursView } from '../../src/modules/settings/public-hours.js'

const TZ = 'America/New_York'
type Closure = DayInfoInput['closures'][number]
const closure = (o: Partial<Closure> & Pick<Closure, 'date' | 'name'>): Closure => ({
  id: `c-${o.date}`,
  type: 'closed',
  openMin: null,
  closeMin: null,
  source: 'manual',
  deletedAt: null,
  ...o,
})
const emergency = (o: Partial<EmergencySnapshot> = {}): EmergencySnapshot => ({
  active: true,
  reason: 'severe_weather',
  durationKind: 'today',
  untilMin: null,
  startDate: '2026-06-13',
  throughDate: '2026-06-13',
  pause: true,
  ...o,
})
// the shop is closed on Sundays (the production setting)
const sundayOff = DEFAULT_HOURS.map((h) => (h.weekday === 0 ? { ...h, isOpen: false } : h))

const at = (
  iso: string,
  o: { hours?: typeof DEFAULT_HOURS; closures?: Closure[]; emergency?: EmergencySnapshot } = {},
) =>
  publicHoursView({
    now: new Date(iso),
    tz: TZ,
    hours: o.hours ?? sundayOff,
    closures: o.closures ?? [],
    emergency: o.emergency ?? null,
  })

describe('publicHoursView: today', () => {
  it('is open now on a Saturday morning (8:00 AM - 5:00 PM)', () => {
    const v = at('2026-06-13T10:36:00-04:00')
    expect(v.tz).toBe(TZ)
    expect(v.generatedAt).toBe('2026-06-13T14:36:00.000Z')
    expect(v.today).toEqual({
      date: '2026-06-13',
      weekday: 6,
      day: 'Saturday',
      closed: false,
      openNow: true,
      state: 'open',
      openMin: 480,
      closeMin: 1020,
      opensAt: '8:00 AM',
      closesAt: '5:00 PM',
      reason: null,
      reduced: false,
      emergency: false,
    })
  })

  it('opens later before the opening time, and is closed (with the day still an open day) after closing', () => {
    const early = at('2026-06-13T07:15:00-04:00')
    expect(early.today).toMatchObject({
      state: 'opens_later',
      openNow: false,
      closed: false,
      opensAt: '8:00 AM',
    })
    const late = at('2026-06-13T18:00:00-04:00')
    expect(late.today).toMatchObject({ state: 'closed', openNow: false, closed: false, closesAt: '5:00 PM' })
    // the first and last minute: open at 8:00, closed at 5:00
    expect(at('2026-06-13T08:00:00-04:00').today.state).toBe('open')
    expect(at('2026-06-13T16:59:00-04:00').today.state).toBe('open')
    expect(at('2026-06-13T17:00:00-04:00').today.state).toBe('closed')
  })

  it('a Sunday is closed as the regular day off, and the week shows Sunday closed without times', () => {
    const v = at('2026-06-14T12:00:00-04:00')
    expect(v.today).toMatchObject({
      date: '2026-06-14',
      weekday: 0,
      day: 'Sunday',
      closed: true,
      openNow: false,
      state: 'closed',
      openMin: null,
      closeMin: null,
      opensAt: null,
      closesAt: null,
      reason: 'Regular day off',
      reduced: false,
      emergency: false,
    })
    expect(v.week).toHaveLength(7)
    expect(v.week[0]).toEqual({
      weekday: 0,
      day: 'Sunday',
      open: false,
      from: null,
      to: null,
      fromMin: null,
      toMin: null,
    })
    expect(v.week[1]).toEqual({
      weekday: 1,
      day: 'Monday',
      open: true,
      from: '8:00 AM',
      to: '6:00 PM',
      fromMin: 480,
      toMin: 1080,
    })
    expect(v.week[6]).toMatchObject({ day: 'Saturday', open: true, from: '8:00 AM', to: '5:00 PM' })
    // a regular day off is part of the week, not a closure
    expect(v.closures).toEqual([])
  })

  it('a week where Sunday is open shows it open (the week follows the stored hours, not an assumption)', () => {
    const v = at('2026-06-14T12:00:00-04:00', { hours: DEFAULT_HOURS })
    expect(v.today).toMatchObject({ closed: false, state: 'open', opensAt: '9:00 AM', closesAt: '3:00 PM' })
    expect(v.week[0]).toMatchObject({ open: true, from: '9:00 AM', to: '3:00 PM' })
  })
})

describe('publicHoursView: the next open day', () => {
  it('after closing on Saturday the next open day is Monday: Sunday (closed) is skipped across the week boundary', () => {
    const v = at('2026-06-13T18:00:00-04:00')
    expect(v.next).toEqual({
      date: '2026-06-15',
      weekday: 1,
      day: 'Monday',
      closed: false,
      openMin: 480,
      closeMin: 1080,
      opensAt: '8:00 AM',
      closesAt: '6:00 PM',
      reason: null,
      reduced: false,
      emergency: false,
    })
  })

  it('is the day after today while the shop is open today (the site uses today first)', () => {
    expect(at('2026-06-12T10:00:00-04:00').next?.date).toBe('2026-06-13') // Friday -> Saturday
    expect(at('2026-06-13T10:00:00-04:00').next?.date).toBe('2026-06-15') // Saturday -> Monday
  })

  it('skips planned closed days and lands on a reduced day with its window', () => {
    const v = at('2026-06-13T18:00:00-04:00', {
      closures: [
        closure({ date: '2026-06-15', name: 'Inventory' }),
        closure({ date: '2026-06-16', name: 'Late start', type: 'reduced', openMin: 600, closeMin: 1080 }),
      ],
    })
    expect(v.next).toMatchObject({
      date: '2026-06-16',
      day: 'Tuesday',
      opensAt: '10:00 AM',
      closesAt: '6:00 PM',
      reduced: true,
      reason: 'Late start',
    })
  })

  it('is null when nothing opens within the horizon', () => {
    const closed = DEFAULT_HOURS.map((h) => ({ ...h, isOpen: false }))
    const v = at('2026-06-13T10:00:00-04:00', { hours: closed })
    expect(v.next).toBeNull()
    expect(v.today).toMatchObject({ closed: true, reason: 'Regular day off' })
    expect(v.week.every((d) => !d.open)).toBe(true)
  })
})

describe('publicHoursView: closures', () => {
  it('lists planned closed and reduced days of the next two weeks with the design labels, never ids', () => {
    const v = at('2026-06-13T10:36:00-04:00', {
      closures: [
        closure({ date: '2026-06-19', name: 'Juneteenth' }),
        closure({ date: '2026-06-16', name: 'Late start', type: 'reduced', openMin: 600, closeMin: 1080 }),
        closure({ date: '2026-06-27', name: 'Beyond the horizon' }), // day 14: outside
        closure({ date: '2026-06-20', name: 'Removed', deletedAt: new Date('2026-06-01T00:00:00Z') }),
      ],
    })
    expect(v.closures).toEqual([
      {
        date: '2026-06-16',
        dateLabel: 'Tuesday, Jun 16',
        name: 'Late start',
        type: 'reduced',
        from: '10:00 AM',
        to: '6:00 PM',
      },
      { date: '2026-06-19', dateLabel: 'Friday, Jun 19', name: 'Juneteenth', type: 'closed' },
    ])
    expect(PUBLIC_HOURS_DAYS).toBe(14)
    expect(
      at('2026-06-13T10:36:00-04:00', { closures: [closure({ date: '2026-06-26', name: 'Day 13' })] })
        .closures,
    ).toHaveLength(1)
  })

  it('a planned closure on the regular day off is reported with its own name (dayInfo ranks it first)', () => {
    const v = at('2026-06-13T10:36:00-04:00', {
      closures: [closure({ date: '2026-06-14', name: 'Sunday anyway' })],
    })
    expect(v.closures).toEqual([
      { date: '2026-06-14', dateLabel: 'Sunday, Jun 14', name: 'Sunday anyway', type: 'closed' },
    ])
  })
})

describe('publicHoursView: emergency', () => {
  it('an emergency closure for the rest of today closes today with the closure name and flags it', () => {
    const v = at('2026-06-13T10:36:00-04:00', { emergency: emergency() })
    expect(v.today).toMatchObject({
      closed: true,
      openNow: false,
      state: 'closed',
      reason: 'Weather closure',
      emergency: true,
      opensAt: null,
    })
    expect(v.closures[0]).toEqual({
      date: '2026-06-13',
      dateLabel: 'Saturday, Jun 13',
      name: 'Weather closure',
      type: 'closed',
    })
    expect(v.next?.date).toBe('2026-06-15')
  })

  it('an emergency "until 2:00 PM" makes today reduced: it opens later, from 2:00 PM', () => {
    const v = at('2026-06-13T10:36:00-04:00', {
      emergency: emergency({ durationKind: 'until', untilMin: 840, reason: 'power_outage' }),
    })
    expect(v.today).toMatchObject({
      closed: false,
      state: 'opens_later',
      openNow: false,
      opensAt: '2:00 PM',
      closesAt: '5:00 PM',
      reduced: true,
      reason: 'Power outage closure',
      emergency: true,
    })
    expect(v.closures[0]).toMatchObject({
      type: 'reduced',
      from: '2:00 PM',
      to: '5:00 PM',
      name: 'Power outage closure',
    })
  })

  it('a multi-day emergency closes every day through the last one, and the next open day follows it', () => {
    const v = at('2026-06-13T10:36:00-04:00', {
      emergency: emergency({ durationKind: 'days', throughDate: '2026-06-16', reason: 'staff_shortage' }),
    })
    expect(v.closures.map((c) => c.date)).toEqual(['2026-06-13', '2026-06-15', '2026-06-16']) // Sunday is a regular day off
    expect(v.closures.every((c) => c.name === 'Staffing closure' && c.type === 'closed')).toBe(true)
    expect(v.next?.date).toBe('2026-06-17')
  })

  it('carries nothing but hours: no ids, counts, people or message text', () => {
    const v = at('2026-06-13T10:36:00-04:00', {
      closures: [closure({ date: '2026-06-19', name: 'Juneteenth' })],
      emergency: emergency(),
    })
    const keys = new Set<string>()
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) x.forEach(walk)
      else if (x && typeof x === 'object')
        for (const [k, val] of Object.entries(x as Record<string, unknown>)) {
          keys.add(k)
          walk(val)
        }
    }
    walk(v)
    for (const k of keys) {
      if (k === 'name') continue // a closure's own name, the one customers are told
      expect(k).not.toMatch(/id$|^id$|message|started|count|appointment|vehicle|history|name/i)
    }
  })
})
