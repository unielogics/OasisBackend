// dayInfo(date): the one pure answer to "is the shop open that day and when?", shared by the calendar, the slot engine and
// the emergency strip. Today is not special-cased: an emergency or a holiday closes it like any other date.
import { bizWeekday } from '../../platform/time.js'
import type { ClosureRecord } from './closures.js'
import type { HoursDay } from './hours.js'
import { EMERGENCY_REASONS, REGULAR_DAY_OFF } from './labels.js'
import type { EmergencyDurationKind, EmergencyReason } from './schema.js'

/** The slice of the active emergency row that affects day answers. */
export interface EmergencySnapshot {
  active: boolean
  reason: EmergencyReason
  durationKind: EmergencyDurationKind
  untilMin: number | null
  /** Business date the emergency started. */
  startDate: string
  /** Last closed business date (equals startDate for today and until). */
  throughDate: string
  pause: boolean
}

export type DayInfoSource = 'closure' | 'emergency' | 'regular_day_off' | 'weekly_hours'

export interface DayInfo {
  date: string
  weekday: number
  closed: boolean
  /** Closure name, "Regular day off" or the emergency closure name; null on an ordinary open day. */
  reason: string | null
  source: DayInfoSource
  closureId: string | null
  reduced: boolean
  /** Effective open window in minutes from midnight (null when closed). */
  openMin: number | null
  closeMin: number | null
  /** Calendar grid rows: floor(open / 60) and ceil(close / 60). */
  h0: number | null
  h1: number | null
  /** "<name> · reduced hours" on a reduced day, else "". */
  note: string
  /** The day is covered by an active emergency with "pause online booking" on. */
  onlinePaused: boolean
  emergency: boolean
}

export interface DayInfoInput {
  date: string
  /** Seven rows, any order; only the date's weekday is read. */
  hours: readonly HoursDay[]
  /** Closures to consider; soft-deleted ones and other dates are ignored. */
  closures: readonly Pick<
    ClosureRecord,
    'id' | 'date' | 'name' | 'type' | 'openMin' | 'closeMin' | 'source' | 'deletedAt'
  >[]
  emergency?: EmergencySnapshot | null
}

const closedInfo = (
  base: Pick<DayInfo, 'date' | 'weekday' | 'onlinePaused'>,
  source: DayInfoSource,
  reason: string,
  closureId: string | null,
  emergency: boolean,
): DayInfo => ({
  ...base,
  closed: true,
  reason,
  source,
  closureId,
  reduced: false,
  openMin: null,
  closeMin: null,
  h0: null,
  h1: null,
  note: '',
  emergency,
})

const openInfo = (
  base: Pick<DayInfo, 'date' | 'weekday' | 'onlinePaused'>,
  source: DayInfoSource,
  openMin: number,
  closeMin: number,
  reduced: boolean,
  name: string | null,
  closureId: string | null,
  emergency: boolean,
): DayInfo => ({
  ...base,
  closed: false,
  reason: reduced ? name : null,
  source,
  closureId,
  reduced,
  openMin,
  closeMin,
  h0: Math.floor(openMin / 60),
  h1: Math.ceil(closeMin / 60),
  note: reduced && name ? `${name} · reduced hours` : '',
  emergency,
})

/**
 * Order: an emergency-created closure row; a planned `closed` closure; the weekly "Regular day off"; an active emergency
 * covering the date (when no emergency row exists); a planned `reduced` closure; the weekly hours. A weekly day off wins
 * over a reduced closure, as in the design.
 */
export function dayInfo(input: DayInfoInput): DayInfo {
  const weekday = bizWeekday(input.date)
  const em = input.emergency?.active ? input.emergency : null
  const covered = em !== null && input.date >= em.startDate && input.date <= em.throughDate
  const base = { date: input.date, weekday, onlinePaused: covered && em.pause }
  const week = input.hours.find((h) => h.weekday === weekday)
  const live = input.closures.filter((c) => c.date === input.date && c.deletedAt === null)
  const emergencyRow = live.find((c) => c.source === 'emergency')
  const planned = live.find((c) => c.source !== 'emergency')

  if (emergencyRow) {
    if (emergencyRow.type === 'closed')
      return closedInfo(base, 'closure', emergencyRow.name, emergencyRow.id, true)
    return openInfo(
      base,
      'closure',
      emergencyRow.openMin!,
      emergencyRow.closeMin!,
      true,
      emergencyRow.name,
      emergencyRow.id,
      true,
    )
  }
  if (planned?.type === 'closed') return closedInfo(base, 'closure', planned.name, planned.id, false)
  if (!week || !week.isOpen) return closedInfo(base, 'regular_day_off', REGULAR_DAY_OFF, null, false)
  if (covered) {
    const name = EMERGENCY_REASONS[em.reason].closureName
    if (
      em.durationKind === 'until' &&
      em.untilMin !== null &&
      em.untilMin < week.closeMin &&
      input.date === em.startDate
    )
      return openInfo(
        base,
        'emergency',
        Math.max(em.untilMin, week.openMin),
        week.closeMin,
        true,
        name,
        null,
        true,
      )
    return closedInfo(base, 'emergency', name, null, true)
  }
  if (planned?.type === 'reduced')
    return openInfo(
      base,
      'closure',
      planned.openMin!,
      planned.closeMin!,
      true,
      planned.name,
      planned.id,
      false,
    )
  return openInfo(base, 'weekly_hours', week.openMin, week.closeMin, false, null, null, false)
}
