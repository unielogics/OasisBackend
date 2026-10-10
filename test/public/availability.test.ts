// The website's open-times board as a pure projection of the slot engine (ADR 0150): the four states from the engine's bay counts
// and VIP holds, the now + 30 rule for today, Sunday closed, a planned closure, an emergency, the "bays open now" pill, the day
// labels, the service keys and the limit windows.
import { describe, expect, it } from 'vitest'
import { wallToInstant } from '../../src/platform/time.js'
import { DEFAULT_RULES } from '../../src/modules/settings/hours.js'
import { dayInfo, type EmergencySnapshot } from '../../src/modules/settings/day-info.js'
import { DEFAULT_HOURS } from '../../src/modules/settings/defaults.js'
import { computeSlots, MS_PER_MIN, type AvailabilityInput, type BusyInterval } from '../../src/modules/scheduling/availability.js'
import { boardDay, boardNow, boardSlot, dayLabel } from '../../src/modules/public/availability.js'
import { keyServices, slugOf } from '../../src/modules/public/keys.js'
import { windowStart } from '../../src/modules/public/limits.js'
import type { CatalogService } from '../../src/modules/catalog/service.js'

const TZ = 'America/New_York'
const NOW = new Date('2026-06-13T10:36:00-04:00') // Saturday
const TODAY = '2026-06-13'
// the design's week except Sunday, which is closed (owner decision)
const HOURS = DEFAULT_HOURS.map((h) => (h.weekday === 0 ? { ...h, isOpen: false } : h))

const busy = (date: string, fromMin: number, durationMin: number, vip = false): BusyInterval => {
  const s = wallToInstant(date, fromMin, TZ).getTime()
  return { startMs: s, endMs: s + (durationMin + DEFAULT_RULES.bufferMinutes) * MS_PER_MIN, vip, bookedStartMs: s }
}

const input = (date: string, o: Partial<AvailabilityInput> & { closures?: Parameters<typeof dayInfo>[0]['closures']; emergency?: EmergencySnapshot | null } = {}): AvailabilityInput => ({
  date,
  tz: TZ,
  now: o.now ?? NOW,
  day: dayInfo({ date, hours: HOURS, closures: o.closures ?? [], emergency: o.emergency ?? null }),
  rules: DEFAULT_RULES,
  activeBays: o.activeBays ?? 2,
  durationMin: o.durationMin ?? 45,
  channel: 'online',
  isVip: false,
  intervals: o.intervals ?? [],
  holds: o.holds ?? [],
  releaseHours: 48,
  windowVipDays: 30,
  windowStdDays: 14,
})

const day = (date: string, o: Parameters<typeof input>[1] = {}) => {
  const i = input(date, o)
  return boardDay({ result: computeSlots(i), reason: i.day.reason, reduced: i.day.reduced, today: TODAY })
}

describe('boardSlot: the engine state to the board state', () => {
  it('maps available by free bays (open, last), vip_held to vip, blocked to booked, and drops the rest', () => {
    const base = { startMin: 630, reason: undefined, overrideKind: null, sameDayEligible: false, dayClosed: false }
    expect(boardSlot({ ...base, state: 'available', baysFree: 2 })).toEqual({ startMin: 630, start: '10:30 AM', state: 'open', bays: 2 })
    expect(boardSlot({ ...base, state: 'available', baysFree: 1 })).toEqual({ startMin: 630, start: '10:30 AM', state: 'last', bays: 1 })
    expect(boardSlot({ ...base, state: 'vip_held', baysFree: 2 })).toEqual({ startMin: 630, start: '10:30 AM', state: 'vip', bays: 2 })
    expect(boardSlot({ ...base, state: 'blocked', baysFree: 0 })).toEqual({ startMin: 630, start: '10:30 AM', state: 'booked', bays: 0 })
    for (const state of ['past', 'cutoff', 'closed', 'outside_window'] as const)
      expect(boardSlot({ ...base, state, baysFree: 2 }), state).toBeNull()
  })
})

describe('boardDay: a day of the board', () => {
  it('today starts at now + the online lead time (30 min) and ends at the last start the cutoff allows', () => {
    const d = day(TODAY)
    expect(d).toMatchObject({ date: TODAY, label: 'Today', dateLabel: 'Saturday, Jun 13', weekday: 6, closed: false, reason: null })
    // 10:36 + 30 = 11:06: the 11:00 start is gone, 11:30 is the first; Saturday closes at 5:00 PM, cutoff 60 min: last start 4:00 PM
    expect(d.slots[0]).toMatchObject({ startMin: 690, start: '11:30 AM', state: 'open', bays: 2 })
    expect(d.slots.at(-1)).toMatchObject({ startMin: 960, start: '4:00 PM' })
    expect(d.slots.map((s) => s.startMin)).toEqual([690, 720, 750, 780, 810, 840, 870, 900, 930, 960])
    expect(d.openCount).toBe(10)
  })

  it('counts the bays the engine says are free: one job makes a slot "last", two make it "booked"', () => {
    const one = day(TODAY, { intervals: [busy(TODAY, 720, 45)] })
    expect(one.slots.find((s) => s.startMin === 720)).toMatchObject({ state: 'last', bays: 1 })
    // the buffer (10 min) keeps the 11:30 start busy too: a 45 min job from 11:30 ends 12:25 with buffer, overlapping 12:00's job
    expect(one.slots.find((s) => s.startMin === 690)).toMatchObject({ state: 'last', bays: 1 })
    const two = day(TODAY, { intervals: [busy(TODAY, 720, 45), busy(TODAY, 720, 45)] })
    // both bays busy 12:00 to 12:55: the 11:30, 12:00 and 12:30 starts all overlap that, the 1:00 PM start does not
    for (const m of [690, 720, 750]) expect(two.slots.find((s) => s.startMin === m), String(m)).toMatchObject({ state: 'booked', bays: 0 })
    expect(two.openCount).toBe(one.openCount - 3)
    expect(two.slots.find((s) => s.startMin === 780)).toMatchObject({ state: 'open', bays: 2 })
  })

  it('shows a VIP hold inside its release window as "vip" with the free bays, and as open once released', () => {
    const friday = '2026-06-19'
    const held = day(friday, { holds: [{ weekday: 5, timeMin: 960 }] })
    expect(held.label).toBe('Fri')
    expect(held.slots.find((s) => s.startMin === 960)).toMatchObject({ state: 'vip', bays: 2 })
    // the hold takes one bay for the overlapping starts, which still leaves the other: open, two real bays free
    expect(held.slots.find((s) => s.startMin === 930)).toMatchObject({ state: 'open', bays: 2 })
    expect(held.openCount).toBe(held.slots.length - 1)
    // with one bay, a start overlapping the hold would overbook: booked for everyone but a VIP client
    const oneBay = day(friday, { holds: [{ weekday: 5, timeMin: 960 }], activeBays: 1 })
    expect(oneBay.slots.find((s) => s.startMin === 930)).toMatchObject({ state: 'booked', bays: 0 })
    expect(oneBay.slots.find((s) => s.startMin === 960)).toMatchObject({ state: 'vip', bays: 1 })
    // this morning's Saturday holds (8, 9, 10 AM) released 48 h ago and are past anyway
    const today = day(TODAY, { holds: [{ weekday: 6, timeMin: 600 }] })
    expect(today.slots.some((s) => s.state === 'vip')).toBe(false)
  })

  it('a Sunday is closed with "Regular day off" and no slots; a planned closure and an emergency close a day by name', () => {
    expect(day('2026-06-14')).toMatchObject({ label: 'Tomorrow', closed: true, reason: 'Regular day off', openCount: 0, slots: [] })
    const closure = {
      id: 'c1',
      date: '2026-06-19',
      name: 'Juneteenth',
      type: 'closed' as const,
      openMin: null,
      closeMin: null,
      source: 'federal' as const,
      deletedAt: null,
    }
    expect(day('2026-06-19', { closures: [closure] })).toMatchObject({ closed: true, reason: 'Juneteenth', slots: [] })
    const reduced = { ...closure, date: '2026-06-18', name: 'Inventory', type: 'reduced' as const, openMin: 780, closeMin: 1080 }
    const r = day('2026-06-18', { closures: [reduced] })
    expect(r).toMatchObject({ closed: false, reason: 'Inventory' })
    expect(r.slots[0]).toMatchObject({ startMin: 780 })
    const emergency: EmergencySnapshot = {
      active: true,
      reason: 'severe_weather',
      durationKind: 'days',
      untilMin: null,
      startDate: TODAY,
      throughDate: '2026-06-15',
      pause: false,
    }
    const e = day('2026-06-15', { emergency })
    expect(e.closed).toBe(true)
    expect(e.reason).toMatch(/Severe weather|closure/i)
    expect(e.slots).toEqual([])
  })

  it('an emergency that pauses online booking hides the day even when the shop is open', () => {
    const emergency: EmergencySnapshot = {
      active: true,
      reason: 'power_outage',
      durationKind: 'until',
      untilMin: 900,
      startDate: TODAY,
      throughDate: TODAY,
      pause: true,
    }
    expect(day(TODAY, { emergency }).closed).toBe(true)
  })
})

describe('boardNow: the "N of 3 bays open now" pill', () => {
  it('counts active bays minus the jobs occupying one at this instant, and is closed when the shop is', () => {
    expect(boardNow({ openNow: true, activeBays: 3, intervals: [], now: NOW })).toEqual({ open: true, baysFree: 3, baysTotal: 3 })
    expect(boardNow({ openNow: true, activeBays: 3, intervals: [busy(TODAY, 600, 45)], now: NOW })).toEqual({ open: true, baysFree: 2, baysTotal: 3 })
    expect(boardNow({ openNow: true, activeBays: 2, intervals: [busy(TODAY, 600, 45), busy(TODAY, 630, 45), busy(TODAY, 540, 30)], now: NOW })).toEqual({ open: true, baysFree: 0, baysTotal: 2 })
    expect(boardNow({ openNow: false, activeBays: 3, intervals: [], now: NOW })).toEqual({ open: false, baysFree: 0, baysTotal: 3 })
  })
})

describe('labels, keys and windows', () => {
  it('labels Today, Tomorrow, then the short weekday', () => {
    expect(dayLabel(TODAY, TODAY)).toBe('Today')
    expect(dayLabel('2026-06-14', TODAY)).toBe('Tomorrow')
    expect(dayLabel('2026-06-15', TODAY)).toBe('Mon')
  })

  it('keys services by the slug of their name, unique within the list', () => {
    expect(slugOf('Signature Hand Wash')).toBe('signature-hand-wash')
    expect(slugOf('Premium Hand Wash + Interior')).toBe('premium-hand-wash-plus-interior')
    expect(slugOf('Wax & Seal / Gloss')).toBe('wax-and-seal-gloss')
    const svc = (id: string, name: string): CatalogService =>
      ({ id, name, kind: 'package', locationId: 'l', shortNameOverride: null, shortName: name, priceCents: 1, durationMin: 1, tags: [], bookableDesk: true, sort: 0, active: true, sqspSku: null, version: 1, tasks: [] }) as CatalogService
    const keyed = keyServices([svc('0190abcd-0000-7000-8000-000000000001', 'Wax'), svc('0190ef01-0000-7000-8000-000000000002', 'Wax')])
    expect(keyed.map((k) => k.key)).toEqual(['wax', 'wax-0190ef'])
  })

  it('fixed limit windows start on a multiple of their width', () => {
    expect(windowStart(new Date('2026-06-13T14:36:17Z'), 600).toISOString()).toBe('2026-06-13T14:30:00.000Z')
    expect(windowStart(new Date('2026-06-13T14:36:17Z'), 3600).toISOString()).toBe('2026-06-13T14:00:00.000Z')
  })
})
