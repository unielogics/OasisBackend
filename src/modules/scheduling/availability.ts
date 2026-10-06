// The slot engine, as a pure function (docs: backend design 4.2). Inputs are plain data loaded by availability-loader.ts;
// nothing here reads the clock, the database or the settings.
//
//   day info      closed days (holiday, day off, emergency, today included) have no slots; a reduced day narrows the window
//   candidates    every slot_minutes aligned from the opening time, last start = close - cutoff (the cutoff applies to the
//                 START time; with allow_overrun the job may run past closing)
//   capacity      count based: a candidate [s, s + duration + buffer) is free when the sweep-line maximum of existing
//                 intervals inside it is at most (active bays - 1). Planned bays are advisory and never counted
//   VIP holds     a weekly (weekday, time) hold is vip_held for everyone else while now < slot start - release hours,
//                 and an unreleased hold also takes one bay for its slot length
//   windows       online only: VIP clients book up to window_vip_days ahead, others window_std_days
//   overrides     desk callers may override blocked, held, closed and out-of-hours starts with a reason (the booking
//                 service checks the permission); a VIP booking today on a blocked slot may use the same-day guarantee
import { fmtT, minutesOfDay, bizWeekday, diffDays, toBizDate, wallToInstant } from '../../platform/time.js'
import type { DayInfo } from '../settings/day-info.js'
import type { BookingRules } from '../settings/hours.js'

export type SlotState = 'available' | 'blocked' | 'vip_held' | 'closed' | 'past' | 'cutoff' | 'outside_window'
export type Channel = 'desk' | 'online'
export type OverrideNeed = 'capacity' | 'vip_hold' | 'hours' | 'closure'

export const MS_PER_MIN = 60_000

/** A booked job's claim on a bay: [startMs, endMs), the buffer already included. */
export interface BusyInterval {
  startMs: number
  endMs: number
  /** The booking belongs to a VIP client. */
  vip: boolean
  /** When the booking itself starts (for "a real VIP booking sits at the held slot"). */
  bookedStartMs: number
}

export interface VipHold {
  weekday: number
  timeMin: number
}

export interface AvailabilityInput {
  /** Business date of the starts being evaluated. */
  date: string
  tz: string
  now: Date
  day: DayInfo
  rules: BookingRules
  /** Bays that can take a car (not in maintenance, not blocked). */
  activeBays: number
  /** Package duration; add-ons add none. */
  durationMin: number
  channel: Channel
  isVip: boolean
  intervals: readonly BusyInterval[]
  holds: readonly VipHold[]
  releaseHours: number
  windowVipDays: number
  windowStdDays: number
  /** Same-day guarantees the client used this month, and the monthly allowance. */
  sameDayUsed?: number
  sameDayLimit?: number
}

export interface Evaluation {
  state: SlotState
  reason?: string
  /** Which override a desk caller needs to book it anyway; null when it cannot be overridden. */
  overrideKind: OverrideNeed | null
  /** Bays free for the whole interval, counting real bookings only. */
  baysFree: number
  releasesAt?: Date
  sameDayEligible: boolean
  /** The day itself is closed (as opposed to a start outside the open window). */
  dayClosed: boolean
}

export interface Slot extends Evaluation {
  start: Date
  startMin: number
  endsAt: Date
  /** "9:30 AM". */
  label: string
  overridable: boolean
}

export interface AvailabilityResult {
  date: string
  closed: boolean
  reason: string | null
  openMin: number | null
  closeMin: number | null
  slots: Slot[]
}

/**
 * Highest number of intervals overlapping at any instant inside [from, to). Intervals are half-open, so one ending
 * exactly where another starts does not overlap it.
 */
export function maxConcurrency(
  intervals: readonly { startMs: number; endMs: number }[],
  from: number,
  to: number,
): number {
  const events: [number, number][] = []
  for (const iv of intervals) {
    const s = Math.max(iv.startMs, from)
    const e = Math.min(iv.endMs, to)
    if (e > s) {
      events.push([s, 1], [e, -1])
    }
  }
  // At equal instants the ends (-1) come first.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let cur = 0
  let max = 0
  for (const [, d] of events) {
    cur += d
    if (cur > max) max = cur
  }
  return max
}

const sameDayAllowance = (i: AvailabilityInput): boolean =>
  i.isVip && (i.sameDayUsed ?? 0) < (i.sameDayLimit ?? 0)

/** The hold intervals that still take a bay for a non-VIP caller. */
export function virtualHoldIntervals(i: AvailabilityInput): { interval: BusyInterval; hold: VipHold; releasesAt: Date }[] {
  if (i.isVip || i.day.closed || i.day.openMin === null || i.day.closeMin === null) return []
  const weekday = bizWeekday(i.date)
  const out: { interval: BusyInterval; hold: VipHold; releasesAt: Date }[] = []
  for (const hold of i.holds) {
    if (hold.weekday !== weekday) continue
    if (hold.timeMin < i.day.openMin || hold.timeMin >= i.day.closeMin) continue
    const slotStart = wallToInstant(i.date, hold.timeMin, i.tz)
    const releasesAt = new Date(slotStart.getTime() - i.releaseHours * 3_600_000)
    if (i.now.getTime() >= releasesAt.getTime()) continue
    const realVip = i.intervals.some((iv) => iv.vip && iv.bookedStartMs === slotStart.getTime())
    if (realVip) continue
    out.push({
      hold,
      releasesAt,
      interval: {
        startMs: slotStart.getTime(),
        endMs: slotStart.getTime() + i.rules.slotMinutes * MS_PER_MIN,
        vip: false,
        bookedStartMs: slotStart.getTime(),
      },
    })
  }
  return out
}

/** The state of one start instant on `input.date`. */
export function evaluateStart(i: AvailabilityInput, start: Date): Evaluation {
  const base = { sameDayEligible: false, baysFree: 0, dayClosed: false } as const
  const desk = i.channel === 'desk'
  const overridable = (kind: OverrideNeed): OverrideNeed | null => (desk ? kind : null)

  if (i.day.closed) {
    return {
      ...base,
      dayClosed: true,
      state: 'closed',
      reason: i.day.reason ?? 'Closed',
      overrideKind: overridable('closure'),
    }
  }
  if (!desk && i.day.onlinePaused) {
    return { ...base, dayClosed: true, state: 'closed', reason: i.day.reason ?? 'Closed', overrideKind: null }
  }
  const openMin = i.day.openMin!
  const closeMin = i.day.closeMin!
  const m = minutesOfDay(start, i.tz)
  if (m < openMin) {
    return {
      ...base,
      state: 'closed',
      reason: `Opens at ${fmtT(openMin)}`,
      overrideKind: overridable('hours'),
    }
  }
  const lastStart = closeMin - i.rules.cutoffMinutes
  if (m > lastStart) {
    return {
      ...base,
      state: 'cutoff',
      reason: `The last booking is at ${fmtT(lastStart)}`,
      overrideKind: overridable('hours'),
    }
  }
  if (!i.rules.allowOverrun && m + i.durationMin > closeMin) {
    return {
      ...base,
      state: 'cutoff',
      reason: `It would run past closing at ${fmtT(closeMin)}`,
      overrideKind: overridable('hours'),
    }
  }
  const earliest = i.now.getTime() + (desk ? 0 : i.rules.onlineLeadMinutes * MS_PER_MIN)
  if (start.getTime() < earliest) {
    return {
      ...base,
      state: 'past',
      reason: desk ? 'That time has passed' : `Online booking needs ${i.rules.onlineLeadMinutes} minutes notice`,
      overrideKind: null,
    }
  }
  if (!desk) {
    const ahead = diffDays(toBizDate(i.now, i.tz), i.date)
    const limit = i.isVip ? i.windowVipDays : i.windowStdDays
    if (ahead > limit) {
      return {
        ...base,
        state: 'outside_window',
        reason: `Online booking opens ${limit} days ahead`,
        overrideKind: null,
      }
    }
  }

  const startMs = start.getTime()
  const endMs = startMs + (i.durationMin + i.rules.bufferMinutes) * MS_PER_MIN
  const real = maxConcurrency(i.intervals, startMs, endMs)
  const baysFree = Math.max(0, i.activeBays - real)
  const holds = virtualHoldIntervals(i)
  const withHolds = maxConcurrency([...i.intervals, ...holds.map((h) => h.interval)], startMs, endMs)
  const full = real >= i.activeBays
  const atHold = holds.find((h) => h.interval.startMs === startMs)

  const toDay = toBizDate(i.now, i.tz) === i.date
  if (full) {
    return {
      ...base,
      baysFree,
      state: 'blocked',
      reason: 'Would overbook a bay',
      overrideKind: overridable('capacity'),
      sameDayEligible: toDay && sameDayAllowance(i),
    }
  }
  if (atHold) {
    return {
      ...base,
      baysFree,
      state: 'vip_held',
      reason: 'Held for VIP clients',
      overrideKind: overridable('vip_hold'),
      releasesAt: atHold.releasesAt,
    }
  }
  if (withHolds >= i.activeBays) {
    return {
      ...base,
      baysFree,
      state: 'blocked',
      reason: 'Would overbook a bay',
      overrideKind: overridable('capacity'),
      sameDayEligible: toDay && sameDayAllowance(i),
    }
  }
  return { ...base, baysFree, state: 'available', overrideKind: null }
}

/** Candidate start minutes of an open day: the slot grid from opening, last start close - cutoff. */
export function candidateStarts(day: Pick<DayInfo, 'openMin' | 'closeMin'>, rules: BookingRules): number[] {
  if (day.openMin === null || day.closeMin === null) return []
  const out: number[] = []
  const last = day.closeMin - rules.cutoffMinutes
  for (let m = day.openMin; m <= last; m += rules.slotMinutes) out.push(m)
  return out
}

export function computeSlots(i: AvailabilityInput): AvailabilityResult {
  if (i.day.closed || (i.channel === 'online' && i.day.onlinePaused)) {
    return {
      date: i.date,
      closed: true,
      reason: i.day.reason ?? 'Closed',
      openMin: null,
      closeMin: null,
      slots: [],
    }
  }
  const slots = candidateStarts(i.day, i.rules).map((m): Slot => {
    const start = wallToInstant(i.date, m, i.tz)
    const ev = evaluateStart(i, start)
    return {
      ...ev,
      start,
      startMin: m,
      endsAt: new Date(start.getTime() + i.durationMin * MS_PER_MIN),
      label: fmtT(m),
      overridable: ev.overrideKind !== null,
    }
  })
  return {
    date: i.date,
    closed: false,
    reason: null,
    openMin: i.day.openMin,
    closeMin: i.day.closeMin,
    slots,
  }
}
