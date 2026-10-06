import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js'

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
