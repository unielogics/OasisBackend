// When an unlocked kiosk locks itself (ADR 0180, plan section A "Lock time"). Pure: the caller loads today's and yesterday's dayInfo
// (hours, closures, the emergency) in the business time zone. Computed once, at unlock; later changes to the hours or an emergency
// do not move it ("Lock all kiosks" covers those).
//
//   1. previous_day: a shift that ran past midnight still counts. If yesterday was open and its closing + 2 h is still ahead, lock then.
//   2. closing:      today is open and its closing + 2 h is still ahead: lock then. Unless it is the night (more than 3 h before
//                    opening): a 00:30 unlock must not stay open until tonight's closing.
//   3. two_hours:    otherwise (a closed day, an emergency closure, after closing + 2 h, the night): lock 2 hours from now.
//   A cap of 20 hours applies to all three. The 2 hours are added to the instant, never to the wall clock: a real two hours across a
//   daylight-saving change, and no wallToInstant error for minutes >= 1440.
import { addDays, wallToInstant } from '../../platform/time.js'
import type { DayInfo } from '../settings/day-info.js'
import type { KioskLockRule } from './schema.js'

export const KIOSK_AFTER_CLOSE_MS = 2 * 60 * 60 * 1000
export const KIOSK_SHORT_UNLOCK_MS = 2 * 60 * 60 * 1000
export const KIOSK_LOCK_CAP_MS = 20 * 60 * 60 * 1000
/** Before opening minus this many minutes it is the night: rule 3. */
export const KIOSK_NIGHT_CUTOFF_MIN = 180

export interface KioskLockInput {
  now: Date
  tz: string
  today: DayInfo
  yesterday: DayInfo
  nightCutoffMin?: number
}

export interface KioskLock {
  locksAt: Date
  rule: KioskLockRule
}

/** The instant of `minutes` on `date`; 1440 (a reduced day closing at midnight) is the next day's 00:00. */
function instantOf(date: string, minutes: number, tz: string): Date {
  const days = Math.floor(minutes / 1440)
  return wallToInstant(days ? addDays(date, days) : date, minutes - days * 1440, tz)
}

export function kioskLockTime(i: KioskLockInput): KioskLock {
  const now = i.now.getTime()
  const cutoff = i.nightCutoffMin ?? KIOSK_NIGHT_CUTOFF_MIN
  const cap = (at: number, rule: KioskLockRule): KioskLock => ({
    locksAt: new Date(Math.min(at, now + KIOSK_LOCK_CAP_MS)),
    rule,
  })

  const y = i.yesterday
  if (!y.closed && y.closeMin !== null) {
    const until = instantOf(y.date, y.closeMin, i.tz).getTime() + KIOSK_AFTER_CLOSE_MS
    if (now < until) return cap(until, 'previous_day')
  }

  const t = i.today
  if (!t.closed && t.openMin !== null && t.closeMin !== null) {
    const until = instantOf(t.date, t.closeMin, i.tz).getTime() + KIOSK_AFTER_CLOSE_MS
    const night = instantOf(t.date, t.openMin, i.tz).getTime() - cutoff * 60_000
    if (now < until && now >= night) return cap(until, 'closing')
  }

  return cap(now + KIOSK_SHORT_UNLOCK_MS, 'two_hours')
}
