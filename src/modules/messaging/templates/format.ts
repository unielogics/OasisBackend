// Formatting for the {time} and {when} template variables, in the business time zone.

function parts(at: Date, timeZone: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, ...opts }).format(at)
}

function localDate(at: Date, timeZone: string): string {
  return parts(at, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' })
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
  const tomorrow = new Date(now.getTime() + 24 * 3600_000)
  if (localDate(start, timeZone) === localDate(tomorrow, timeZone)) return `tomorrow at ${clock}`
  return `${parts(start, timeZone, { weekday: 'short', month: 'short', day: 'numeric' })} at ${clock}`
}

/** "today", "tomorrow" or "on Sat, Jun 13" for the {when} variable of the reminder. */
export function formatWhen(start: Date, now: Date, timeZone: string): string {
  if (localDate(start, timeZone) === localDate(now, timeZone)) return 'today'
  const tomorrow = new Date(now.getTime() + 24 * 3600_000)
  if (localDate(start, timeZone) === localDate(tomorrow, timeZone)) return 'tomorrow'
  return `on ${parts(start, timeZone, { weekday: 'short', month: 'short', day: 'numeric' })}`
}
