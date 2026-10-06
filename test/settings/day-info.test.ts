import { describe, expect, it } from 'vitest'
import { dayInfo, type DayInfoInput, type EmergencySnapshot } from '../../src/modules/settings/day-info.js'
import { DEFAULT_HOURS } from '../../src/modules/settings/defaults.js'

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

const day = (date: string, closures: Closure[] = [], em?: EmergencySnapshot | null, hours = DEFAULT_HOURS) =>
  dayInfo({ date, hours, closures, emergency: em })

const LABOR = closure({ date: '2026-09-07', name: 'Labor Day', type: 'reduced', openMin: 600, closeMin: 840 })
const JULY4 = closure({ date: '2026-07-04', name: 'Independence Day' })
const sundayOff = DEFAULT_HOURS.map((h) => (h.weekday === 0 ? { ...h, isOpen: false } : h))

describe('dayInfo: weekly hours and closures', () => {
  it('uses the weekly hours on an ordinary day', () => {
    expect(day('2026-06-15')).toMatchObject({
      weekday: 1,
      closed: false,
      source: 'weekly_hours',
      openMin: 480,
      closeMin: 1080,
      h0: 8,
      h1: 18,
      note: '',
      reduced: false,
      reason: null,
      onlinePaused: false,
      emergency: false,
    })
    expect(day('2026-06-14')).toMatchObject({ weekday: 0, openMin: 540, closeMin: 900, h0: 9, h1: 15 })
    expect(day('2026-06-13')).toMatchObject({ weekday: 6, openMin: 480, closeMin: 1020 })
  })

  it('is closed with the closure name on a closed closure', () => {
    expect(day('2026-07-04', [JULY4])).toMatchObject({
      closed: true,
      reason: 'Independence Day',
      source: 'closure',
      closureId: 'c-2026-07-04',
      openMin: null,
      closeMin: null,
      h0: null,
    })
  })

  it('shows the reduced window with the "<name> · reduced hours" note', () => {
    expect(day('2026-09-07', [LABOR])).toMatchObject({
      closed: false,
      reduced: true,
      openMin: 600,
      closeMin: 840,
      h0: 10,
      h1: 14,
      note: 'Labor Day · reduced hours',
      reason: 'Labor Day',
      source: 'closure',
    })
  })

  it('rounds the grid rows out: floor of the opening hour, ceil of the closing hour', () => {
    const odd = closure({
      date: '2026-06-15',
      name: 'Short day',
      type: 'reduced',
      openMin: 630,
      closeMin: 810,
    })
    expect(day('2026-06-15', [odd])).toMatchObject({ h0: 10, h1: 14 })
  })

  it('says "Regular day off" when the weekday is closed, and that beats a reduced closure', () => {
    expect(day('2026-06-14', [], null, sundayOff)).toMatchObject({
      closed: true,
      reason: 'Regular day off',
      source: 'regular_day_off',
      closureId: null,
    })
    const reduced = closure({
      date: '2026-06-14',
      name: 'Event',
      type: 'reduced',
      openMin: 600,
      closeMin: 720,
    })
    expect(day('2026-06-14', [reduced], null, sundayOff)).toMatchObject({
      closed: true,
      reason: 'Regular day off',
    })
  })

  it('names the closure when a closed closure lands on a regular day off', () => {
    expect(
      day('2026-06-14', [closure({ date: '2026-06-14', name: 'Training' })], null, sundayOff).reason,
    ).toBe('Training')
  })

  it('ignores soft-deleted closures and closures on other dates', () => {
    expect(day('2026-07-04', [{ ...JULY4, deletedAt: new Date('2026-06-01T00:00:00Z') }]).closed).toBe(false)
    expect(day('2026-07-05', [JULY4]).closed).toBe(false)
  })

  it('does not depend on the row order of the hours', () => {
    expect(day('2026-06-15', [], null, [...DEFAULT_HOURS].reverse()).openMin).toBe(480)
  })
})

describe('dayInfo: today is not special-cased', () => {
  it('closes the 13th like any other date when a closure is on it', () => {
    expect(day('2026-06-13', [closure({ date: '2026-06-13', name: 'Water main break' })])).toMatchObject({
      closed: true,
      reason: 'Water main break',
    })
  })

  it('closes today for an active full-day emergency even without closure rows', () => {
    expect(day('2026-06-13', [], emergency())).toMatchObject({
      closed: true,
      source: 'emergency',
      reason: 'Weather closure',
      emergency: true,
      onlinePaused: true,
    })
  })

  it('treats the emergency start date, a middle date and the last date identically, and stops after it', () => {
    const em = emergency({ durationKind: 'days', throughDate: '2026-06-16' })
    for (const d of ['2026-06-13', '2026-06-14', '2026-06-15', '2026-06-16'])
      expect(day(d, [], em), d).toMatchObject({ closed: true, emergency: true, onlinePaused: true })
    expect(day('2026-06-17', [], em)).toMatchObject({ closed: false, emergency: false, onlinePaused: false })
    expect(day('2026-06-12', [], em)).toMatchObject({ closed: false, onlinePaused: false })
  })

  it('keeps a Regular day off a day off during a multi-day emergency', () => {
    const em = emergency({ durationKind: 'days', throughDate: '2026-06-16' })
    expect(day('2026-06-14', [], em, sundayOff).reason).toBe('Regular day off')
  })

  it('reopens at the "until" time: a reduced window from then to closing', () => {
    const em = emergency({ durationKind: 'until', untilMin: 840 })
    expect(day('2026-06-13', [], em)).toMatchObject({
      closed: false,
      reduced: true,
      openMin: 840,
      closeMin: 1020,
      source: 'emergency',
      emergency: true,
    })
  })

  it('is closed for the day when "until" is at or after closing', () => {
    expect(day('2026-06-13', [], emergency({ durationKind: 'until', untilMin: 1020 })).closed).toBe(true)
  })

  it('prefers the emergency closure rows (the precise window) over the fallback', () => {
    const rows = closure({
      date: '2026-06-13',
      name: 'Weather closure',
      type: 'reduced',
      openMin: 480,
      closeMin: 636,
      source: 'emergency',
    })
    expect(day('2026-06-13', [rows], emergency())).toMatchObject({
      closed: false,
      reduced: true,
      openMin: 480,
      closeMin: 636,
      emergency: true,
      onlinePaused: true,
    })
  })

  it('lets an active emergency override a planned reduced closure on a covered date', () => {
    const em = emergency({ durationKind: 'days', throughDate: '2026-09-08', startDate: '2026-09-07' })
    expect(day('2026-09-07', [LABOR], em)).toMatchObject({ closed: true, emergency: true })
  })

  it('pauses online booking only while the emergency is active and the pause switch is on', () => {
    expect(day('2026-06-13', [], emergency({ pause: false }))).toMatchObject({
      closed: true,
      onlinePaused: false,
    })
    expect(day('2026-06-13', [], emergency({ active: false }))).toMatchObject({
      closed: false,
      onlinePaused: false,
    })
    expect(day('2026-06-13', [], null)).toMatchObject({ closed: false, onlinePaused: false })
    const withRows = closure({ date: '2026-06-13', name: 'Weather closure', source: 'emergency' })
    expect(day('2026-06-13', [withRows], emergency({ pause: false })).onlinePaused).toBe(false)
  })

  it('pauses online booking on covered dates that have open hours not otherwise closed', () => {
    const em = emergency({ durationKind: 'until', untilMin: 840 })
    expect(day('2026-06-13', [], em).onlinePaused).toBe(true)
  })
})
