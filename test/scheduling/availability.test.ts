// The pure slot engine: sweep-line capacity, cutoff, VIP holds, windows, closures, overrides and the property that no
// available slot can exceed bay capacity.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { wallToInstant } from '../../src/platform/time.js'
import {
  candidateStarts,
  computeSlots,
  evaluateStart,
  maxConcurrency,
  MS_PER_MIN,
  type AvailabilityInput,
  type BusyInterval,
} from '../../src/modules/scheduling/availability.js'
import { dayInfo } from '../../src/modules/settings/day-info.js'
import { DEFAULT_HOURS } from '../../src/modules/settings/defaults.js'
import { DEFAULT_RULES } from '../../src/modules/settings/hours.js'

const TZ = 'America/New_York'
const at = (date: string, hhmm: string): Date => {
  const [h, m] = hhmm.split(':').map(Number)
  return wallToInstant(date, h! * 60 + m!, TZ)
}
const iv = (date: string, from: string, to: string, vip = false): BusyInterval => ({
  startMs: at(date, from).getTime(),
  endMs: at(date, to).getTime(),
  vip,
  bookedStartMs: at(date, from).getTime(),
})

/** Saturday 2026-06-13, now Thursday 10:00 unless said otherwise. */
function input(over: Partial<AvailabilityInput> & { date?: string; now?: Date } = {}): AvailabilityInput {
  const date = over.date ?? '2026-06-13'
  return {
    date,
    tz: TZ,
    now: over.now ?? at('2026-06-11', '10:00'),
    day: dayInfo({ date, hours: DEFAULT_HOURS, closures: [] }),
    rules: { ...DEFAULT_RULES },
    activeBays: 2,
    durationMin: 60,
    channel: 'desk',
    isVip: false,
    intervals: [],
    holds: [],
    releaseHours: 48,
    windowVipDays: 30,
    windowStdDays: 14,
    sameDayUsed: 0,
    sameDayLimit: 2,
    ...over,
  }
}

describe('maxConcurrency (sweep line)', () => {
  const t = (a: number, b: number) => ({ startMs: a, endMs: b })
  it('counts overlap at any instant and treats intervals as half-open', () => {
    expect(maxConcurrency([], 0, 100)).toBe(0)
    expect(maxConcurrency([t(0, 10), t(10, 20)], 0, 100)).toBe(1)
    expect(maxConcurrency([t(0, 10), t(5, 20), t(8, 9)], 0, 100)).toBe(3)
    expect(maxConcurrency([t(0, 10), t(5, 20)], 10, 100)).toBe(1)
    expect(maxConcurrency([t(0, 10), t(5, 20)], 20, 100)).toBe(0)
  })
})

describe('candidate starts', () => {
  it('last start is close minus the cutoff, on the slot grid from opening (cutoff applies to the START)', () => {
    const day = dayInfo({ date: '2026-06-13', hours: DEFAULT_HOURS, closures: [] }) // Sat 8-5
    const starts = candidateStarts(day, { ...DEFAULT_RULES, cutoffMinutes: 60, slotMinutes: 30 })
    expect(starts[0]).toBe(480)
    expect(starts.at(-1)).toBe(960) // 4:00 PM
    expect(candidateStarts(day, { ...DEFAULT_RULES, cutoffMinutes: 30, slotMinutes: 60 }).at(-1)).toBe(960)
    expect(candidateStarts(day, { ...DEFAULT_RULES, cutoffMinutes: 90, slotMinutes: 15 }).at(-1)).toBe(930)
  })

  it('a reduced day narrows the window; a closed day has no slots', () => {
    const labor = dayInfo({
      date: '2026-09-07',
      hours: DEFAULT_HOURS,
      closures: [
        {
          id: 'c',
          date: '2026-09-07',
          name: 'Labor Day',
          type: 'reduced',
          openMin: 600,
          closeMin: 840,
          source: 'federal',
          deletedAt: null,
        },
      ],
    })
    expect(candidateStarts(labor, DEFAULT_RULES)).toEqual([600, 630, 660, 690, 720, 750, 780])
    const xmas = dayInfo({
      date: '2026-12-25',
      hours: DEFAULT_HOURS,
      closures: [
        {
          id: 'c',
          date: '2026-12-25',
          name: 'Christmas Day',
          type: 'closed',
          openMin: null,
          closeMin: null,
          source: 'federal',
          deletedAt: null,
        },
      ],
    })
    const r = computeSlots(input({ date: '2026-12-25', day: xmas, now: at('2026-12-20', '10:00') }))
    expect(r).toMatchObject({ closed: true, reason: 'Christmas Day', slots: [] })
  })
})

describe('capacity', () => {
  it('a slot is available while a bay is free for the whole interval including the buffer', () => {
    // Bay A busy 9:00-10:10 (60 + buffer), bay B free
    const i = input({ intervals: [iv('2026-06-13', '09:00', '10:10')] })
    const r = computeSlots(i)
    const by = Object.fromEntries(r.slots.map((s) => [s.label, s.state]))
    expect(by['9:00 AM']).toBe('available')
    expect(r.slots.every((s) => s.state === 'available')).toBe(true)
  })

  it('is blocked when every bay overlaps the candidate, and baysFree says how many are free', () => {
    const i = input({ intervals: [iv('2026-06-13', '09:00', '10:10'), iv('2026-06-13', '09:30', '10:40')] })
    const r = computeSlots(i)
    const by = Object.fromEntries(r.slots.map((s) => [s.label, s]))
    expect(by['9:00 AM']!.state).toBe('blocked')
    expect(by['9:00 AM']!.reason).toBe('Would overbook a bay')
    expect(by['9:00 AM']!.baysFree).toBe(0)
    expect(by['10:00 AM']!.state).toBe('blocked') // [10:00, 11:10) meets both until 10:10 / 10:40
    expect(by['10:30 AM']!.state).toBe('available') // one bay frees at 10:10
    expect(by['10:30 AM']!.baysFree).toBe(1)
    expect(by['11:00 AM']!.state).toBe('available')
    expect(by['8:00 AM']!.state).toBe('available') // [8:00, 9:10) meets only the first job, until 9:10
    expect(by['8:30 AM']!.state).toBe('blocked') // [8:30, 9:40) meets both from 9:30
  })

  it('the buffer counts: back-to-back jobs on a single bay are blocked by the buffer', () => {
    const one = input({ activeBays: 1, intervals: [iv('2026-06-13', '09:00', '10:10')] })
    const by = Object.fromEntries(computeSlots(one).slots.map((s) => [s.label, s.state]))
    expect(by['10:00 AM']).toBe('blocked')
    expect(by['10:30 AM']).toBe('available')
  })

  it('no active bay means nothing is bookable; maintenance bays are not counted', () => {
    expect(computeSlots(input({ activeBays: 0 })).slots.every((s) => s.state === 'blocked')).toBe(true)
  })

  it('property: an available slot never exceeds capacity, a blocked one always would', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.constantFrom(35, 60, 75, 120),
        fc.constantFrom(0, 10, 20),
        fc.array(fc.tuple(fc.integer({ min: 480, max: 1000 }), fc.integer({ min: 20, max: 160 })), {
          maxLength: 14,
        }),
        (bays, duration, buffer, jobs) => {
          const intervals = jobs.map(([s, d]) => iv('2026-06-13', hh(s), hh(s + d + buffer)))
          const i = input({
            activeBays: bays,
            durationMin: duration,
            rules: { ...DEFAULT_RULES, bufferMinutes: buffer },
            intervals,
          })
          for (const slot of computeSlots(i).slots) {
            const from = slot.start.getTime()
            const to = from + (duration + buffer) * MS_PER_MIN
            const real = maxConcurrency(intervals, from, to)
            if (slot.state === 'available') expect(real).toBeLessThan(bays)
            if (slot.state === 'blocked') expect(real).toBeGreaterThanOrEqual(bays)
            expect(slot.baysFree).toBe(Math.max(0, bays - real))
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  it('property: booking an available slot keeps the day within capacity', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3 }),
        fc.array(fc.integer({ min: 0, max: 16 }), { maxLength: 40 }),
        (bays, picks) => {
          const intervals: BusyInterval[] = []
          for (const p of picks) {
            const start = 480 + p * 30
            const i = input({ activeBays: bays, durationMin: 60, intervals })
            const ev = evaluateStart(i, wallToInstant('2026-06-13', start, TZ))
            if (ev.state === 'available') intervals.push(iv('2026-06-13', hh(start), hh(start + 70)))
          }
          const lo = at('2026-06-13', '00:00').getTime()
          expect(maxConcurrency(intervals, lo, lo + 86_400_000)).toBeLessThanOrEqual(bays)
        },
      ),
      { numRuns: 200 },
    )
  })
})

const hh = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

describe('past slots and the online channel', () => {
  it('past starts today are past; the desk allows start >= now', () => {
    const i = input({ date: '2026-06-13', now: at('2026-06-13', '10:36') })
    const by = Object.fromEntries(computeSlots(i).slots.map((s) => [s.label, s.state]))
    expect(by['10:00 AM']).toBe('past')
    expect(by['10:30 AM']).toBe('past')
    expect(by['11:00 AM']).toBe('available')
  })

  it('online adds the lead time and the booking windows (VIP 30 days, others 14)', () => {
    const now = at('2026-06-13', '10:36')
    const online = (over: Partial<AvailabilityInput>) =>
      input({ date: '2026-06-13', now, channel: 'online', ...over })
    const by = Object.fromEntries(computeSlots(online({})).slots.map((s) => [s.label, s.state]))
    expect(by['11:00 AM']).toBe('past') // needs 30 minutes notice: earliest 11:06
    expect(by['11:30 AM']).toBe('available')
    const far = '2026-06-27' // +14 days, a Saturday
    expect(evaluateStart(online({ date: far }), at(far, '10:00')).state).toBe('available')
    const farther = '2026-07-04'
    expect(evaluateStart(online({ date: farther }), at(farther, '10:00')).state).toBe('outside_window')
    expect(evaluateStart(online({ date: farther, isVip: true }), at(farther, '10:00')).state).toBe(
      'available',
    )
    // the desk ignores windows
    expect(evaluateStart(input({ date: farther, now }), at(farther, '10:00')).state).toBe('available')
  })

  it('an emergency that pauses online booking closes the day for online only', () => {
    const day = { ...dayInfo({ date: '2026-06-13', hours: DEFAULT_HOURS, closures: [] }), onlinePaused: true }
    expect(computeSlots(input({ day, channel: 'online' })).closed).toBe(true)
    expect(computeSlots(input({ day, channel: 'desk' })).closed).toBe(false)
  })
})

describe('VIP holds', () => {
  const holds = [{ weekday: 6, timeMin: 480 }] // Saturday 8:00 AM, release 48 h
  const sat = (now: Date, isVip = false) => input({ date: '2026-06-13', now, holds, isVip })

  it('golden: a Saturday 8:00 hold with release 48 is vip_held at Thursday 7:59 and available at Thursday 8:00', () => {
    const slot = (now: Date, isVip = false) =>
      computeSlots(sat(now, isVip)).slots.find((s) => s.label === '8:00 AM')!
    const held = slot(at('2026-06-11', '07:59'))
    expect(held.state).toBe('vip_held')
    expect(held.releasesAt).toEqual(at('2026-06-11', '08:00'))
    expect(slot(at('2026-06-11', '08:00')).state).toBe('available')
    expect(slot(at('2026-06-11', '08:01')).state).toBe('available')
    expect(slot(at('2026-06-11', '07:59'), true).state).toBe('available') // VIP clients ignore holds
  })

  it('an unreleased hold takes one bay for its slot, so it also blocks a neighbour that overlaps it', () => {
    const base = { date: '2026-06-13', holds: [{ weekday: 6, timeMin: 540 }], now: at('2026-06-11', '07:00') } // Sat 9:00 AM
    const intervals = [iv('2026-06-13', '08:00', '09:10')] // one real job leaves one bay
    const non = Object.fromEntries(
      computeSlots(input({ ...base, intervals })).slots.map((s) => [s.label, s.state]),
    )
    expect(non['9:00 AM']).toBe('vip_held')
    expect(non['8:30 AM']).toBe('blocked') // real job + the hold's bay between 9:00 and 9:10
    const vip = Object.fromEntries(
      computeSlots(input({ ...base, intervals, isVip: true })).slots.map((s) => [s.label, s.state]),
    )
    expect(vip['8:30 AM']).toBe('available')
    expect(vip['9:00 AM']).toBe('available')
  })

  it('a real VIP booking at the held slot replaces the virtual hold (the real one counts)', () => {
    const i = sat(at('2026-06-11', '07:00'))
    i.intervals = [iv('2026-06-13', '08:00', '09:10', true)]
    const r = computeSlots(i)
    const eight = r.slots.find((s) => s.label === '8:00 AM')!
    expect(eight.state).toBe('available') // only the real booking: one of two bays
  })

  it('holds outside the open window are ignored', () => {
    const i = input({
      date: '2026-06-13',
      now: at('2026-06-11', '07:00'),
      holds: [{ weekday: 6, timeMin: 1200 }],
    })
    expect(computeSlots(i).slots.every((s) => s.state === 'available')).toBe(true)
  })
})

describe('overrides', () => {
  it('desk callers may override blocked, held and out-of-hours starts; past and windows cannot be overridden', () => {
    const full = input({
      intervals: [iv('2026-06-13', '09:00', '10:10'), iv('2026-06-13', '09:00', '10:10')],
    })
    expect(evaluateStart(full, at('2026-06-13', '09:00'))).toMatchObject({
      state: 'blocked',
      overrideKind: 'capacity',
    })
    expect(
      evaluateStart(
        { ...full, channel: 'online', now: at('2026-06-11', '10:00') },
        at('2026-06-13', '09:00'),
      ),
    ).toMatchObject({
      state: 'blocked',
      overrideKind: null,
    })
    const early = evaluateStart(input(), at('2026-06-13', '07:00'))
    expect(early).toMatchObject({ state: 'closed', overrideKind: 'hours', dayClosed: false })
    const late = evaluateStart(input(), at('2026-06-13', '16:30'))
    expect(late).toMatchObject({ state: 'cutoff', overrideKind: 'hours' })
    const past = evaluateStart(input({ now: at('2026-06-13', '12:00') }), at('2026-06-13', '09:00'))
    expect(past).toMatchObject({ state: 'past', overrideKind: null })
  })

  it('a VIP client booking today on a full slot is eligible for the same-day guarantee while the allowance lasts', () => {
    const base = input({
      date: '2026-06-13',
      now: at('2026-06-13', '08:00'),
      isVip: true,
      sameDayUsed: 1,
      intervals: [iv('2026-06-13', '09:00', '10:10'), iv('2026-06-13', '09:00', '10:10')],
    })
    expect(evaluateStart(base, at('2026-06-13', '09:00')).sameDayEligible).toBe(true)
    expect(evaluateStart({ ...base, sameDayUsed: 2 }, at('2026-06-13', '09:00')).sameDayEligible).toBe(false)
    expect(evaluateStart({ ...base, isVip: false }, at('2026-06-13', '09:00')).sameDayEligible).toBe(false)
    expect(
      evaluateStart(
        { ...base, date: '2026-06-14', now: at('2026-06-13', '08:00') },
        at('2026-06-14', '09:00'),
      ).sameDayEligible,
    ).toBe(false)
  })

  it('without allow_overrun a job that would run past closing is cut off', () => {
    const i = input({ rules: { ...DEFAULT_RULES, allowOverrun: false, cutoffMinutes: 30 }, durationMin: 120 })
    expect(evaluateStart(i, at('2026-06-13', '16:00')).state).toBe('cutoff')
    expect(
      evaluateStart({ ...i, rules: { ...i.rules, allowOverrun: true } }, at('2026-06-13', '16:00')).state,
    ).toBe('available')
  })
})
