import { describe, expect, it } from 'vitest'
import {
  formatPhoneDisplay,
  isValidPhone,
  maskEmail,
  maskPhone,
  normalizePhone,
  normalizeTextableNanp,
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

describe('normalizeTextableNanp (public texts: US and Canadian numbers that can take a text, nothing premium or toll-free)', () => {
  it.each([
    ['(201) 555-0101', '+12015550101'],
    ['+1 862 388 5827', '+18623885827'],
    ['416 555 0123', '+14165550123'], // Toronto
    ['+1 613 555 0123', '+16135550123'], // Ottawa
  ])('accepts %s as %s', (raw, e164) => {
    expect(normalizeTextableNanp(raw)).toEqual({ ok: true, e164 })
  })

  it.each([
    ['12', 'invalid'],
    ['not a number', 'invalid'],
    ['+44 7911 123456', 'not_textable'], // the United Kingdom
    ['+234 803 123 4567', 'not_textable'], // Nigeria
    ['+86 138 0013 8000', 'not_textable'], // China
    ['+1 876 234 5678', 'not_textable'], // Jamaica: +1, but not the US or Canada
    ['+1 809 234 5678', 'not_textable'], // the Dominican Republic
    ['+1 900 555 1234', 'not_textable'], // premium rate
    ['1-976-555-1234', 'invalid'], // 976 is no area code today (it stays on the refused list should it ever become one)
    ['+1 800 555 1234', 'not_textable'], // toll free
    ['+1 888 555 1234', 'not_textable'],
    ['+1 833 555 1234', 'not_textable'],
    ['+1 500 555 0006', 'not_textable'], // personal communication service
  ])('refuses %s (%s)', (raw, reason) => {
    expect(normalizeTextableNanp(raw)).toEqual({ ok: false, reason })
  })
})
