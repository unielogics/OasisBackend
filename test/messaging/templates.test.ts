import { describe, expect, it } from 'vitest'
import {
  emergencyUntilText,
  EMERGENCY_REASONS,
  QUICK_REPLIES,
  TEMPLATES,
  formatAppointmentTime,
  formatWhen,
  placeholdersOf,
  renderSms,
  renderTemplate,
  stripLinkSentences,
  TemplateError,
  validateTemplateBody,
} from '../../src/modules/messaging/templates/index.js'

describe('registry', () => {
  it('has every key the design calls for', () => {
    for (const key of ['booking_thanks', 'confirm_request', 'confirmed', 'welcome', 'in_progress', 'ready', 'receipt', 'reschedule', 'review', 'late_nudge', 'payment_link', 'closure_notice', 'emergency', 'staff_invite', 'addon_approval']) {
      expect(Object.keys(TEMPLATES)).toContain(key)
    }
  })

  it('has no WhatsApp wording anywhere', () => {
    for (const t of Object.values(TEMPLATES)) expect(t.body.toLowerCase()).not.toContain('whatsapp')
    for (const q of QUICK_REPLIES) expect(q.text.toLowerCase()).not.toContain('whatsapp')
  })

  it('carries the seven quick replies from cc-domain 7.9 verbatim', () => {
    expect(QUICK_REPLIES.map((q) => [q.label, q.text])).toEqual([
      ['Confirmed', 'Your appointment is confirmed. See you soon!'],
      ['We’re ready', 'We’re ready for you — come on in!'],
      ['Checked in', 'Your vehicle has been checked in.'],
      ['Being cleaned', 'Your vehicle is now being cleaned.'],
      ['Ready for pickup', 'Your vehicle is ready for pickup!'],
      ['Approve add-on?', 'We recommend an add-on — would you like to approve it?'],
      ['Payment link', 'Here is your secure payment link.'],
    ])
  })

  it('declares every placeholder a body uses, required or optional', () => {
    for (const t of Object.values(TEMPLATES)) {
      const declared = new Set<string>([...t.required, ...t.optional])
      for (const name of placeholdersOf(t.body)) expect(declared.has(name), `${t.key}.{${name}}`).toBe(true)
    }
  })

  it('uses the add-on approval wording without the YES keyword, which means confirm', () => {
    expect(TEMPLATES.addon_approval.body).not.toMatch(/\bYES\b/)
  })
})

describe('renderTemplate', () => {
  it('fills variables', () => {
    expect(renderTemplate('booking_thanks', { first: 'Liam' }).text).toBe('Hi Liam, thanks for booking with Oasis Auto Spa.')
    expect(renderTemplate('reschedule', { time: 'tomorrow at 2:30 PM' }).text).toBe('Your appointment has been moved to tomorrow at 2:30 PM. Reply if that doesn’t work.')
  })

  it('throws listing missing variables, treating blank values as missing', () => {
    expect(() => renderTemplate('late_nudge', { first: 'Liam' })).toThrowError(TemplateError)
    try {
      renderTemplate('late_nudge', { first: ' ', time: undefined })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateError)
      expect((e as TemplateError).code).toBe('missing_variables')
      expect((e as TemplateError).details).toEqual(['first', 'time'])
    }
  })

  it('rejects unknown templates', () => {
    expect(() => renderTemplate('nope')).toThrowError(/No template/)
  })

  it('shows the bay clause only when there is a bay', () => {
    expect(renderTemplate('welcome', { bay: 2 }).text).toBe('Welcome to Oasis! You’re checked in — pull into Bay 2.')
    expect(renderTemplate('welcome', {}).text).toBe('Welcome to Oasis! You’re checked in.')
    expect(renderTemplate('welcome', { bay: null }).text).toBe('Welcome to Oasis! You’re checked in.')
  })

  it('uses edited bodies from Settings', () => {
    expect(renderTemplate('ready', {}, { bodies: { ready: 'Come get it!' } }).text).toBe('Come get it!')
    expect(renderTemplate('confirmed', { time: '9 AM' }, { bodies: { confirmed: 'See you at {time}.' } }).text).toBe('See you at 9 AM.')
  })

  it('refuses an edited body that uses a variable nobody supplied', () => {
    expect(() => renderTemplate('ready', {}, { bodies: { ready: 'Come get it, {nope}' } })).toThrowError(/needs: nope/)
  })
})

describe('emergency template', () => {
  const vars = { first: 'Liam', reason: EMERGENCY_REASONS['Severe weather'], until: emergencyUntilText({ dur: 'today' }), link: 'oasis.spa/r/8KQ2' }

  it('renders the design copy with the link when links are enabled', () => {
    expect(renderTemplate('emergency', vars, { linksEnabled: true }).text).toBe(
      'Hi Liam, due to severe weather Oasis Auto Spa is closed for the rest of today. We’re sorry for the inconvenience. Pick a new time here: oasis.spa/r/8KQ2',
    )
  })

  it('strips the sentence containing {link} when links are disabled (the default)', () => {
    const text = renderTemplate('emergency', { ...vars, link: undefined }).text
    expect(text).toBe('Hi Liam, due to severe weather Oasis Auto Spa is closed for the rest of today. We’re sorry for the inconvenience.')
    expect(text).not.toContain('Pick a new time')
    expect(renderTemplate('emergency', vars).text).toBe(text)
  })

  it('requires a link when links are enabled', () => {
    expect(() => renderTemplate('emergency', { ...vars, link: undefined }, { linksEnabled: true })).toThrowError(/link/)
  })

  it('strips every sentence that has the link, wherever it sits', () => {
    expect(stripLinkSentences('A one. Go here {link}. B two! Or {link} now? C three.')).toBe('A one. B two! C three.')
    expect(stripLinkSentences('No link here.')).toBe('No link here.')
  })

  it('builds the {until} phrases from the design', () => {
    expect(emergencyUntilText({ dur: 'today' })).toBe('for the rest of today')
    expect(emergencyUntilText({ dur: 'until', until: '2:00 PM' })).toBe('until 2:00 PM today')
    expect(emergencyUntilText({ dur: 'days', through: '2026-06-15' })).toBe('through Monday, Jun 15')
    expect(EMERGENCY_REASONS['Staff shortage']).toBe('a staffing issue')
  })

  it('fits one GSM-7 segment sequence of at most two parts with the footer', () => {
    const s = renderSms('emergency', { ...vars, link: undefined }, { firstMessageToNumber: true })
    expect(s.prepared.encoding).toBe('GSM-7')
    expect(s.prepared.body).toContain('Reply STOP to opt out.')
    expect(s.prepared.body).toContain("We're sorry")
    expect(s.prepared.segments).toBeLessThanOrEqual(2)
  })
})

describe('renderSms', () => {
  it('review text loses the star and stays GSM-7', () => {
    const s = renderSms('review', {}, { firstMessageToNumber: false })
    expect(s.text).toContain('⭐')
    expect(s.prepared.body).toBe('Thanks for visiting Oasis Auto Spa! How did we do?')
    expect(s.prepared.encoding).toBe('GSM-7')
  })

  it('confirmation always carries the STOP line, a receipt only on the first message', () => {
    expect(renderSms('confirmed', { time: '2:30 PM' }, { firstMessageToNumber: false }).prepared.body).toBe('Your appointment is confirmed for 2:30 PM. Reply STOP to opt out.')
    expect(renderSms('receipt', {}, { firstMessageToNumber: false }).prepared.body).toBe('Payment received - receipt sent. Thank you!')
    expect(renderSms('receipt', {}, { firstMessageToNumber: true }).prepared.body).toBe('Payment received - receipt sent. Thank you! Reply STOP to opt out.')
  })

  it('keyword replies never get a second footer', () => {
    expect(renderSms('opt_in_confirm', {}, { firstMessageToNumber: true }).prepared.body).toBe('You\'re subscribed to Oasis Auto Spa texts again. Reply STOP to opt out.')
    expect(renderSms('help_reply', { phone: '(786) 555-0100' }, { firstMessageToNumber: true }).prepared.body).toBe(
      'Oasis Auto Spa: reply here and our team will get back to you, or call (786) 555-0100. Msg frequency varies. Reply STOP to opt out.',
    )
  })
})

describe('validateTemplateBody', () => {
  it('accepts a body that uses the template variables and rejects strangers and blanks', () => {
    expect(validateTemplateBody('confirmed', 'See you at {time}!')).toEqual([])
    expect(validateTemplateBody('confirmed', 'Hi {first}, {time}')).toEqual([{ code: 'unknown_variable', detail: '{first} is not available in "confirmed"' }])
    expect(validateTemplateBody('confirmed', '   ')).toEqual([{ code: 'empty', detail: 'Body is empty' }])
  })
})

describe('time formatting', () => {
  const now = new Date('2026-06-13T10:36:00-04:00')
  const tz = 'America/New_York'
  it('formats appointment times relative to today', () => {
    expect(formatAppointmentTime(new Date('2026-06-13T14:30:00-04:00'), now, tz)).toBe('2:30 PM')
    expect(formatAppointmentTime(new Date('2026-06-14T09:00:00-04:00'), now, tz)).toBe('tomorrow at 9:00 AM')
    expect(formatAppointmentTime(new Date('2026-06-16T09:00:00-04:00'), now, tz)).toBe('Tue, Jun 16 at 9:00 AM')
    expect(formatWhen(new Date('2026-06-13T14:30:00-04:00'), now, tz)).toBe('today')
    expect(formatWhen(new Date('2026-06-14T09:00:00-04:00'), now, tz)).toBe('tomorrow')
    expect(formatWhen(new Date('2026-06-16T09:00:00-04:00'), now, tz)).toBe('on Tue, Jun 16')
  })
})
