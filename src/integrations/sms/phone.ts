// Phone number helpers. The shop is a single US location, so bare 10-digit numbers default to +1.

const E164 = /^\+[1-9]\d{7,14}$/

export function isE164(value: string): boolean {
  return E164.test(value)
}

/**
 * Normalises a phone number as reported by the device or typed by staff into E.164, or returns null when the value is not
 * a dialable number (alphanumeric sender ids such as "AMAZON", 5-6 digit short codes, junk).
 */
export function normalizeE164(raw: string | null | undefined, defaultCountryCode = '1'): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (/[a-z]/i.test(trimmed)) return null
  const hasPlus = trimmed.startsWith('+') || trimmed.startsWith('00')
  let digits = trimmed.replace(/\D/g, '')
  if (trimmed.startsWith('00')) digits = digits.slice(2)
  if (digits.length === 0) return null

  if (hasPlus) {
    const candidate = `+${digits}`
    return isE164(candidate) ? candidate : null
  }
  if (defaultCountryCode === '1') {
    if (digits.length === 10 && /^[2-9]/.test(digits)) return `+1${digits}`
    if (digits.length === 11 && digits.startsWith('1') && /^[2-9]/.test(digits.slice(1))) return `+${digits}`
  }
  if (digits.length >= 11 && digits.length <= 15) {
    const candidate = `+${digits}`
    return isE164(candidate) ? candidate : null
  }
  return null
}

/** Last four digits for logs, never the whole number. */
export function maskPhone(e164: string): string {
  return `***${e164.slice(-4)}`
}
