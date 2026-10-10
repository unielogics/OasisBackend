// The open-times board of the website (ADR 0150), as a pure projection of the slot engine's answers: the same computeSlots() the
// dashboard's availability uses, evaluated for an online, non-VIP caller, reduced to the four states the design's board knows
// (open, last, vip, booked) with the number of free bays and nothing else. No names, no ids, no appointment data.
//
//   engine state       board state   bays
//   available          open / last   bays free for the whole interval ("last" when exactly one)
//   vip_held           vip           bays free (the hold takes one of them for everyone but VIP clients)
//   blocked            booked        0
//   past               (dropped)     today's starts before now + the online lead time (30 min)
//   cutoff / closed    (dropped)     starts after the shop's last booking or outside the open window
//   outside_window     (dropped)     beyond the standard online window
import { addDays, bizWeekday, fmtT } from '../../platform/time.js'
import { maxConcurrency, type AvailabilityResult, type BusyInterval, type Slot } from '../scheduling/availability.js'
import { DAY_NAMES, weekdayMonthDay } from '../settings/labels.js'

export type BoardState = 'open' | 'last' | 'vip' | 'booked'

export interface BoardSlot {
  startMin: number
  /** "8:30 AM" */
  start: string
  state: BoardState
  /** Free bays for the whole slot (0 when booked). */
  bays: number
}

export interface BoardDay {
  date: string
  /** "Today", "Tomorrow", then the short weekday ("Sat"). */
  label: string
  /** "Saturday, Jun 13" */
  dateLabel: string
  weekday: number
  closed: boolean
  /** The closure's name or "Regular day off" on a closed day, the reduced-hours name on a reduced one; null otherwise. */
  reason: string | null
  openCount: number
  slots: BoardSlot[]
}

export interface BoardNow {
  open: boolean
  baysFree: number
  baysTotal: number
}

export interface BoardView {
  tz: string
  generatedAt: string
  serviceKey: string
  durationMin: number
  now: BoardNow
  days: BoardDay[]
}

const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

export function dayLabel(date: string, today: string): string {
  if (date === today) return 'Today'
  if (date === addDays(today, 1)) return 'Tomorrow'
  return SHORT_DAYS[bizWeekday(date)]!
}

/** One engine slot as the board shows it, or null when the board does not list it. */
export function boardSlot(s: Pick<Slot, 'state' | 'baysFree' | 'startMin'>): BoardSlot | null {
  switch (s.state) {
    case 'available':
      return {
        startMin: s.startMin,
        start: fmtT(s.startMin),
        state: s.baysFree === 1 ? 'last' : 'open',
        bays: s.baysFree,
      }
    case 'vip_held':
      return { startMin: s.startMin, start: fmtT(s.startMin), state: 'vip', bays: Math.max(1, s.baysFree) }
    case 'blocked':
      return { startMin: s.startMin, start: fmtT(s.startMin), state: 'booked', bays: 0 }
    default:
      return null
  }
}

export interface BoardDayInput {
  /** The engine's answer for the date, evaluated for channel 'online', isVip false. */
  result: AvailabilityResult
  /** "Regular day off", the closure's or the emergency's name; null on an ordinary open day. */
  reason: string | null
  reduced: boolean
  today: string
}

export function boardDay(i: BoardDayInput): BoardDay {
  const { result } = i
  const slots = result.closed ? [] : result.slots.map(boardSlot).filter((s): s is BoardSlot => s !== null)
  return {
    date: result.date,
    label: dayLabel(result.date, i.today),
    dateLabel: weekdayMonthDay(result.date),
    weekday: bizWeekday(result.date),
    closed: result.closed,
    reason: result.closed ? (result.reason ?? i.reason ?? 'Closed') : i.reduced ? i.reason : null,
    openCount: slots.filter((s) => s.state === 'open' || s.state === 'last').length,
    slots,
  }
}

/** The "N of 3 bays open now" pill: active bays minus the ones a job occupies at this instant; closed when the shop is. */
export function boardNow(o: {
  openNow: boolean
  activeBays: number
  intervals: readonly BusyInterval[]
  now: Date
}): BoardNow {
  if (!o.openNow) return { open: false, baysFree: 0, baysTotal: o.activeBays }
  const t = o.now.getTime()
  const busy = maxConcurrency(o.intervals, t, t + 1)
  return { open: true, baysFree: Math.max(0, o.activeBays - busy), baysTotal: o.activeBays }
}

/** Sunday-first weekday name, for the engine's day labels elsewhere. */
export const weekdayName = (weekday: number): string => DAY_NAMES[weekday] ?? ''
