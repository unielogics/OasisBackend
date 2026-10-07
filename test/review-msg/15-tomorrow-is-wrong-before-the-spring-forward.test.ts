// Review finding 15: "tomorrow" in the {when} and {time} template variables is worked out as now + 24 hours. On the day
// before the spring-forward change (a 23-hour day) that lands on the day AFTER tomorrow, so a Monday appointment is announced
// as "tomorrow" on Saturday evening.
import { describe, expect, it } from 'vitest'
import { formatAppointmentTime, formatWhen } from '../../src/modules/messaging/templates/format.js'

const TZ = 'America/New_York'

describe('"tomorrow" around the spring-forward change', () => {
  const saturdayLate = new Date('2026-03-07T23:30:00-05:00') // the clocks jump on Sunday 2026-03-08
  const sunday = new Date('2026-03-08T14:00:00-04:00')
  const monday = new Date('2026-03-09T09:00:00-04:00')

  it('is Sunday, not Monday', () => {
    expect(formatWhen(sunday, saturdayLate, TZ)).toBe('tomorrow')
    expect(formatWhen(monday, saturdayLate, TZ)).not.toBe('tomorrow')
    expect(formatAppointmentTime(monday, saturdayLate, TZ)).not.toMatch(/^tomorrow/)
  })
})
