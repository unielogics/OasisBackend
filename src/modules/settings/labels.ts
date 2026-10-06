// Vocabulary shared by the Settings services: day names, emergency reasons and the design's exact copy.
import { DateTime } from 'luxon'
import { fmtT } from '../../platform/time.js'
import type { EmergencyDurationKind, EmergencyReason } from './schema.js'

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
export const DAY_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
/** Display order in the hours and schedule lists (Monday first). */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const

export const REGULAR_DAY_OFF = 'Regular day off'

export interface EmergencyReasonInfo {
  /** The chip label in the design. */
  label: string
  /** The {reason} text inside the customer message. */
  phrase: string
  /** Name given to the closure rows an emergency creates. */
  closureName: string
}

export const EMERGENCY_REASONS: Record<EmergencyReason, EmergencyReasonInfo> = {
  severe_weather: { label: 'Severe weather', phrase: 'severe weather', closureName: 'Weather closure' },
  power_outage: { label: 'Power outage', phrase: 'a power outage', closureName: 'Power outage closure' },
  equipment_failure: {
    label: 'Equipment failure',
    phrase: 'an equipment failure',
    closureName: 'Equipment closure',
  },
  staff_shortage: { label: 'Staff shortage', phrase: 'a staffing issue', closureName: 'Staffing closure' },
  other: { label: 'Other', phrase: 'unforeseen circumstances', closureName: 'Emergency closure' },
}

export const EMERGENCY_REASON_KEYS = Object.keys(EMERGENCY_REASONS) as EmergencyReason[]
export const EMERGENCY_DURATION_KINDS: readonly EmergencyDurationKind[] = ['today', 'until', 'days']

/** Customer-facing copy of the design (the apostrophe in "We're" is U+2019 there; the message is editable text). */
export const DEFAULT_EMERGENCY_MESSAGE =
  'Hi {first}, due to {reason} Oasis Auto Spa is closed {until}. We’re sorry for the inconvenience. Pick a new time here: {link}'

/** "65 hrs", "10.5 hrs": minutes shown the way the Hours card does. */
export const hoursLabel = (minutes: number): string => `${Math.round((minutes / 60) * 100) / 100} hrs`

/** "Monday, Jun 15" (the design's toLocaleDateString weekday/month/day). */
export function weekdayMonthDay(bizDate: string): string {
  return DateTime.fromISO(bizDate, { zone: 'utc' }).setLocale('en-US').toFormat('cccc, LLL d')
}

/** "Jun 3, 2026". */
export function mediumDate(bizDate: string): string {
  return DateTime.fromISO(bizDate, { zone: 'utc' }).setLocale('en-US').toFormat('LLL d, yyyy')
}

export function reducedWindowLabel(openMin: number, closeMin: number): string {
  return `${fmtT(openMin)} – ${fmtT(closeMin)}`
}
