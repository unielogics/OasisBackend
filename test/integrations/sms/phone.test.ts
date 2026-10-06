import { describe, expect, it } from 'vitest'
import { isE164, maskPhone, normalizeE164 } from '../../../src/integrations/sms/phone.js'

describe('normalizeE164', () => {
  it.each([
    ['(786) 555-0151', '+17865550151'],
    ['786-555-0151', '+17865550151'],
    ['7865550151', '+17865550151'],
    ['17865550151', '+17865550151'],
    ['+1 786 555 0151', '+17865550151'],
    ['+447911123456', '+447911123456'],
    ['00447911123456', '+447911123456'],
    ['  +17865550151  ', '+17865550151'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeE164(raw)).toBe(expected)
  })

  it.each(['AMAZON', 'Bank-Alert', '32665', '555-0151', '', '   ', '+0123456789', '123', '+1'])('rejects %j', (raw) => {
    expect(normalizeE164(raw)).toBeNull()
  })

  it('handles null and undefined', () => {
    expect(normalizeE164(null)).toBeNull()
    expect(normalizeE164(undefined)).toBeNull()
  })

  it('isE164 and maskPhone', () => {
    expect(isE164('+17865550151')).toBe(true)
    expect(isE164('7865550151')).toBe(false)
    expect(maskPhone('+17865550151')).toBe('***0151')
  })
})
