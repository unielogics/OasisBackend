import { describe, expect, it } from 'vitest'
import {
  formatPhoneDisplay,
  isValidPhone,
  maskEmail,
  maskPhone,
  normalizePhone,
} from '../../src/platform/phone.js'

describe('normalizePhone', () => {
  it.each([
    ['(305) 555-0142', '+13055550142'],
    ['305.555.0142', '+13055550142'],
    ['+1 305 555 0142', '+13055550142'],
    ['1-305-555-0142', '+13055550142'],
    ['  305 555 0142  ', '+13055550142'],
    ['+44 20 7946 0958', '+442079460958'],
  ])('%s -> %s', (raw, e164) => {
    expect(normalizePhone(raw)).toBe(e164)
  })

  it('returns null for invalid input', () => {
    expect(normalizePhone('')).toBeNull()
    expect(normalizePhone('555')).toBeNull()
    expect(normalizePhone('not a phone')).toBeNull()
    expect(isValidPhone('(305) 555-014')).toBe(false)
  })

  it('honours the default country', () => {
    expect(normalizePhone('020 7946 0958', 'GB')).toBe('+442079460958')
  })
})

describe('display and masking', () => {
  it('formats US numbers nationally', () => {
    expect(formatPhoneDisplay('+13055550142')).toBe('(305) 555-0142')
  })
  it('masks all but the last four digits', () => {
    expect(maskPhone('+13055550142')).toBe('+1******0142')
    expect(maskPhone('3055550142')).toBe('******0142')
    expect(maskPhone('123')).toBe('***')
  })
  it('masks the local part of an email', () => {
    expect(maskEmail('franco@unielogics.com')).toBe('f***@unielogics.com')
    expect(maskEmail('nope')).toBe('***')
  })
})
