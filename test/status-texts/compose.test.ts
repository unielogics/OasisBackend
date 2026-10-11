// The status texts' words and moments (ADR 0160, design section 6) as pure functions: the estimate of a running-late text (now + 15
// minutes, rounded up to 5), the promised end, when the next late text is due and when it is too late to send, the picked-up text's
// receipt line and its book-again variant. The port, the jobs and the Settings preview all compose through these.
import { describe, expect, it } from 'vitest'
import { renderSms, renderTemplate } from '../../src/modules/messaging/templates/render.js'
import { TEMPLATES } from '../../src/modules/messaging/templates/registry.js'
import {
  checkedInMessage,
  lateDecision,
  lateDueAt,
  lateEta,
  lateMessage,
  LATE_SEND_WINDOW_MS,
  pickedUpMessage,
  promisedEnd,
  receiptLine,
} from '../../src/modules/status-texts/compose.js'

const TZ = 'America/New_York'
const at = (hhmmss: string): Date => new Date(`2026-06-12T${hhmmss}-04:00`)

describe('lateEta: now + 15 minutes, rounded up to the next 5', () => {
  it.each([
    ['10:46:00', '11:05'],
    ['10:50:00', '11:05'],
    ['10:50:01', '11:10'],
    ['10:44:59', '11:00'],
    ['23:50:00', '00:05'],
  ])('%s -> %s', (now, eta) => {
    const e = lateEta(at(now))
    const local = e.toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
    expect(local).toBe(eta)
    expect(e.getUTCSeconds()).toBe(0)
  })

  it('reads as h:mm AM/PM in the shop time zone', () => {
    expect(lateMessage(lateEta(at('10:46:00')), TZ)).toEqual({ templateKey: 'job_delay', vars: { eta: '11:05 AM' } })
    expect(renderTemplate('job_delay', lateMessage(at('13:30:00'), TZ).vars).text).toBe(
      'We’re running a little behind on your vehicle. New estimate: 1:30 PM. Sorry for the wait!',
    )
  })
})

describe('promisedEnd and the late moments', () => {
  const end = at('10:35:00')
  it('is the booked end, or the start of cleaning + duration when the wash began late', () => {
    expect(promisedEnd({ scheduledEnd: end, cleaningStartedAt: at('10:00:00'), durationMin: 35 })).toEqual(end)
    expect(promisedEnd({ scheduledEnd: end, cleaningStartedAt: at('10:30:00'), durationMin: 35 })).toEqual(at('11:05:00'))
    expect(promisedEnd({ scheduledEnd: end, cleaningStartedAt: null, durationMin: 35 })).toEqual(end)
  })

  it('the first text is due at the promised end + grace, the next at the last estimate + grace', () => {
    expect(lateDueAt({ promisedEnd: end, lastEta: null, graceMin: 10 })).toEqual(at('10:45:00'))
    expect(lateDueAt({ promisedEnd: end, lastEta: at('11:05:00'), graceMin: 10 })).toEqual(at('11:15:00'))
  })

  it('sends only between the moment and 30 minutes after it, and never more than the maximum', () => {
    const base = { promisedEnd: end, lastEta: null, sent: 0, max: 2, graceMin: 10 }
    expect(lateDecision({ ...base, now: at('10:44:59') })).toEqual({ send: false, reason: 'not_yet' })
    expect(lateDecision({ ...base, now: at('10:45:00') })).toEqual({ send: true, seq: 1, dueAt: at('10:45:00') })
    expect(lateDecision({ ...base, now: new Date(at('10:45:00').getTime() + LATE_SEND_WINDOW_MS) })).toMatchObject({ send: true })
    expect(lateDecision({ ...base, now: new Date(at('10:45:00').getTime() + LATE_SEND_WINDOW_MS + 1) })).toEqual({ send: false, reason: 'too_late' })
    expect(lateDecision({ ...base, now: at('11:16:00'), lastEta: at('11:05:00'), sent: 1 })).toEqual({ send: true, seq: 2, dueAt: at('11:15:00') })
    expect(lateDecision({ ...base, now: at('11:50:00'), lastEta: at('11:35:00'), sent: 2 })).toEqual({ send: false, reason: 'max_reached' })
    expect(lateDecision({ ...base, max: 0, now: at('10:50:00') })).toEqual({ send: false, reason: 'max_reached' })
  })
})

describe('the picked-up text', () => {
  it('has a receipt line only when nothing is owed, something was paid and no receipt text went lately', () => {
    expect(receiptLine({ totalCents: 5400, balanceCents: 0 }, false)).toBe('Paid in full: $54.00.')
    expect(receiptLine({ totalCents: 5400, balanceCents: 0 }, true)).toBeNull()
    expect(receiptLine({ totalCents: 5400, balanceCents: 100 }, false)).toBeNull()
    expect(receiptLine({ totalCents: 0, balanceCents: 0 }, false)).toBeNull()
    expect(receiptLine(null, false)).toBeNull()
  })

  it('is the thank-you, with the first name and the receipt line when given', () => {
    const m = pickedUpMessage({ firstName: 'Maria', receipt: 'Paid in full: $54.00.', link: null })
    expect(m).toEqual({ templateKey: 'picked_up', vars: { first: 'Maria', receipt: 'Paid in full: $54.00.' } })
    expect(renderTemplate(m.templateKey, m.vars).text).toBe('Thanks for visiting Oasis Auto Spa, Maria! Paid in full: $54.00.')
    expect(renderTemplate('picked_up', { first: null, receipt: null }).text).toBe('Thanks for visiting Oasis Auto Spa!')
  })

  it('with a book-again link is the personal-link variant: the link is a secret variable, never a plain one', () => {
    const m = pickedUpMessage({ firstName: 'Maria', receipt: null, link: 'https://oasisautospanj.com/#/c/T' })
    expect(m).toEqual({ templateKey: 'picked_up_link', vars: { first: 'Maria', receipt: null }, secretVars: { link: 'https://oasisautospanj.com/#/c/T' } })
    expect(TEMPLATES.picked_up_link.klass).toBe('personal_link')
    expect(renderTemplate(m.templateKey, { ...m.vars, ...m.secretVars }).text).toBe(
      'Thanks for visiting Oasis Auto Spa, Maria! Book your next visit: https://oasisautospanj.com/#/c/T',
    )
    // the plain picked-up template has no link at all, so a link can never sit readable in its class
    expect(TEMPLATES.picked_up.body).not.toContain('{link}')
    expect([...TEMPLATES.picked_up.required, ...TEMPLATES.picked_up.optional]).not.toContain('link')
  })

  it('fits two segments of plain SMS characters with a real-length link and a receipt line', () => {
    const link = `https://oasisautospanj.com/#/c/${'x'.repeat(43)}`
    const m = pickedUpMessage({ firstName: 'Maria', receipt: 'Paid in full: $154.00.', link })
    const r = renderSms(m.templateKey, { ...m.vars, ...m.secretVars }, { firstMessageToNumber: false })
    expect(r.prepared.encoding).toBe('GSM-7')
    expect(r.prepared.segments).toBeLessThanOrEqual(2)
  })
})

describe('the checked-in text', () => {
  it('is the welcome template without the bay', () => {
    const m = checkedInMessage()
    expect(m).toEqual({ templateKey: 'welcome', vars: {} })
    expect(renderTemplate(m.templateKey, m.vars).text).toBe('Welcome to Oasis! You’re checked in.')
  })
})
