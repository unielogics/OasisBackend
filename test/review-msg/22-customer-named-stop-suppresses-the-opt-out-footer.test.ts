// Review finding 22: the STOP footer is skipped when the body "already mentions STOP" (any word "stop"). The first name comes
// from the customer, so a customer called "Stop" (or whose first word is "stop") never gets the opt-out line on a first text.
import { describe, expect, it } from 'vitest'
import { renderSms } from '../../src/modules/messaging/templates/render.js'

describe('the first text to a customer whose first name is a word like "stop"', () => {
  it('still carries the opt-out line', () => {
    const r = renderSms('booking_thanks', { first: 'Stop' }, { firstMessageToNumber: true })
    expect(r.prepared.body).toMatch(/Reply STOP to opt out\.$/)
  })
})
