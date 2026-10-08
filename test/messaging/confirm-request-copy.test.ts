// The confirmation request goes to a customer whose booking is not confirmed yet. It used to read "Your appointment at Oasis Auto
// Spa is confirmed for 2:30 PM. Reply C to confirm." (the design's seeded history text), which tells the customer two opposite
// things. The design's wording is kept everywhere it does not contradict itself.
import { describe, expect, it } from 'vitest'
import { TEMPLATES, renderSms } from '../../src/modules/messaging/templates/index.js'

describe('confirm_request copy', () => {
  it('asks for the confirmation without claiming the booking is already confirmed', () => {
    const body = renderSms('confirm_request', { time: '2:30 PM' }, { firstMessageToNumber: false }).prepared.body
    expect(body).not.toMatch(/is confirmed/i)
    expect(body).toMatch(/^Your appointment at Oasis Auto Spa is booked for 2:30 PM\. Reply C to confirm\./)
  })

  it('keeps the confirmed text for an appointment that is confirmed', () => {
    expect(TEMPLATES.confirmed.body).toBe('Your appointment is confirmed for {time}.')
  })
})
