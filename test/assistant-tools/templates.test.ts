// The reply-number handler's texts (ADR 0160, wave W3b) in the template registry: answers to the client's reply (class ai_reply),
// not editable, never sendable from the staff composer, one or two GSM-7 segments with the footer.
import { describe, expect, it } from 'vitest'
import { STAFF_SENDABLE } from '../../src/modules/messaging/http/thread-routes.js'
import { renderSms, renderTemplate, TEMPLATES } from '../../src/modules/messaging/templates/index.js'

const KEYS = ['action_booked', 'action_code_wrong', 'action_code_locked', 'action_code_expired', 'action_needs_verify', 'action_failed', 'action_unavailable'] as const
const VARS = { service: 'Signature Hand Wash + Tire Shine', when: 'Sat Jun 20', time: '10:00 AM', fee: '$25.00', how: 'at the shop', reason: 'That time was just taken.' }

describe('W3b templates', () => {
  it('are ai_reply answers, not editable, not staff-sendable, short GSM-7', () => {
    for (const key of KEYS) {
      const t = TEMPLATES[key]
      expect(t.klass, key).toBe('ai_reply')
      expect(t.editable, key).toBe(false)
      expect((STAFF_SENDABLE as readonly string[]).includes(key), key).toBe(false)
      const s = renderSms(key, VARS, { firstMessageToNumber: true })
      expect(s.prepared.encoding, key).toBe('GSM-7')
      expect(s.prepared.segments, key).toBeLessThanOrEqual(2)
    }
  })

  it('the booking confirmation states the fee for a guest and the member line for a member, never both', () => {
    expect(renderTemplate('action_booked', { service: 'Express Hand Wash', when: 'today', time: '3:00 PM', fee: '$25.00', how: 'at the shop' }).text).toBe(
      'You’re booked: Express Hand Wash, today at 3:00 PM. $25.00 booking fee due at the shop. See you then!',
    )
    expect(renderTemplate('action_booked', { service: 'Express Hand Wash', when: 'tomorrow', time: '9:00 AM', member: 'yes' }).text).toBe(
      'You’re booked: Express Hand Wash, tomorrow at 9:00 AM. Members never pay a booking fee. See you then!',
    )
    expect(renderTemplate('action_failed', { reason: 'That time was just taken.' }).text).toBe('Sorry, we couldn’t finish that: That time was just taken. Reply here and we’ll sort it out.')
  })
})
