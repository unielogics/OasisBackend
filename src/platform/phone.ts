import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js'
// the full metadata knows number types (mobile, premium rate, toll free); the default bundle cannot tell them apart
import { parsePhoneNumberFromString as parseWithTypes } from 'libphonenumber-js/max'

export const DEFAULT_COUNTRY: CountryCode = 'US'

/** Normalises free text to E.164 ("+13055550142"), or null when it is not a valid number. */
export function normalizePhone(raw: string, defaultCountry: CountryCode = DEFAULT_COUNTRY): string | null {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const p = parsePhoneNumberFromString(text, defaultCountry)
  return p?.isValid() ? p.number : null
}

export const isValidPhone = (raw: string, defaultCountry: CountryCode = DEFAULT_COUNTRY): boolean =>
  normalizePhone(raw, defaultCountry) !== null

/** Area codes a public text never goes to: premium-rate (900, 976) and the toll-free codes in use or reserved. */
const NEVER_TEXTED_NPA = new Set(['900', '976', '800', '822', '833', '844', '855', '866', '877', '880', '881', '882', '883', '884', '885', '886', '887', '888', '889'])
const TEXTABLE_TYPES = new Set(['MOBILE', 'FIXED_LINE_OR_MOBILE'])

export type TextableNumber = { ok: true; e164: string } | { ok: false; reason: 'invalid' | 'not_textable' }

/**
 * A number the public website may text (codes, confirmations, the join welcome): a valid +1 number of the United States or Canada
 * (not another country of the +1 plan, such as Jamaica) whose type can take a text, and never a premium-rate or toll-free one.
 * `invalid` is not a number at all; `not_textable` is a real number the shop does not text from its website (review 2026-10-10:
 * toll fraud and texts the shop's SIM pays international rates for).
 */
export function normalizeTextableNanp(raw: string): TextableNumber {
  const text = String(raw ?? '').trim()
  const p = text ? parseWithTypes(text, DEFAULT_COUNTRY) : undefined
  if (!p?.isValid()) return { ok: false, reason: 'invalid' }
  if (p.countryCallingCode !== '1' || (p.country !== 'US' && p.country !== 'CA')) return { ok: false, reason: 'not_textable' }
  if (NEVER_TEXTED_NPA.has(p.nationalNumber.slice(0, 3))) return { ok: false, reason: 'not_textable' }
  const type = p.getType()
  if (!type || !TEXTABLE_TYPES.has(type)) return { ok: false, reason: 'not_textable' }
  return { ok: true, e164: p.number }
}

/** "(305) 555-0142" for US/CA numbers, international format otherwise. */
export function formatPhoneDisplay(e164: string): string {
  const p = parsePhoneNumberFromString(e164)
  if (!p) return e164
  return p.countryCallingCode === '1' ? p.formatNational() : p.formatInternational()
}

/** Log-safe form that keeps only the last four digits: "+1******0142". */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '')
  if (digits.length <= 4) return '*'.repeat(value.length)
  const plus = value.trim().startsWith('+') ? '+' : ''
  const cc = plus && digits.length > 10 ? digits.slice(0, digits.length - 10) : ''
  return `${plus}${cc}${'*'.repeat(digits.length - cc.length - 4)}${digits.slice(-4)}`
}

/** "f***@unielogics.com". */
export function maskEmail(value: string): string {
  const at = value.lastIndexOf('@')
  if (at < 1) return '***'
  return `${value[0]}***${value.slice(at)}`
}
