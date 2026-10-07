// Formatting for the {time} and {when} template variables, in the business time zone.
import { DateTime } from 'luxon'

function parts(at: Date, timeZone: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, ...opts }).format(at)
}

function localDate(at: Date, timeZone: string): string {
  return parts(at, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' })
}

/** Local calendar date of the day after `now`, in the format of localDate. Calendar arithmetic: a day is not always 24 hours. */
function localTomorrow(now: Date, timeZone: string): string {
  return DateTime.fromJSDate(now, { zone: timeZone }).plus({ days: 1 }).toFormat('MM/dd/yyyy')
}

/** "2:30 PM" */
export function formatClock(at: Date, timeZone: string): string {
  return parts(at, timeZone, { hour: 'numeric', minute: '2-digit', hour12: true })
}

/**
 * Appointment time as customers read it: "2:30 PM" on the same local day, "tomorrow at 2:30 PM" the next day, otherwise
 * "Sat, Jun 13 at 2:30 PM".
 */
export function formatAppointmentTime(start: Date, now: Date, timeZone: string): string {
  const clock = formatClock(start, timeZone)
  const sameDay = localDate(start, timeZone) === localDate(now, timeZone)
  if (sameDay) return clock
  if (localDate(start, timeZone) === localTomorrow(now, timeZone)) return `tomorrow at ${clock}`
  return `${parts(start, timeZone, { weekday: 'short', month: 'short', day: 'numeric' })} at ${clock}`
}

/** "today", "tomorrow" or "on Sat, Jun 13" for the {when} variable of the reminder. */
export function formatWhen(start: Date, now: Date, timeZone: string): string {
  if (localDate(start, timeZone) === localDate(now, timeZone)) return 'today'
  if (localDate(start, timeZone) === localTomorrow(now, timeZone)) return 'tomorrow'
  return `on ${parts(start, timeZone, { weekday: 'short', month: 'short', day: 'numeric' })}`
}
