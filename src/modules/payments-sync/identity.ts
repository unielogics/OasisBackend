/** Email/phone normalisation and the customer-identity strength used by the matcher and membership linking. */

export function normalizeEmail(email: string | null | undefined): string | undefined {
  const e = email?.trim().toLowerCase()
  return e && e.includes('@') ? e : undefined
}

/**
 * North American numbers to E.164 (+1XXXXXXXXXX). Anything else with 8 to 15 digits becomes +digits. Returns undefined
 * for values too short to identify anyone (extensions, "n/a", "0").
 */
export function normalizePhone(phone: string | null | undefined): string | undefined {
  if (!phone) return undefined
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`
  return undefined
}

export interface IdentityRef {
  /** Oasis customer id when known. */
  customerId?: string
  emails: string[]
  phones: string[]
  /** Squarespace customer/contact ids already linked to this customer. */
  sqspCustomerIds?: string[]
}

export interface Contactable {
  email?: string | null
  phone?: string | null
  sqspCustomerId?: string | null
}

export type IdentityVia = 'sqsp_customer_id' | 'email' | 'phone' | 'email+phone' | 'none'

export interface IdentityMatch {
  via: IdentityVia
  /** 0 to 0.5: how much of a match score the identity alone may contribute. */
  score: number
}

export const IDENTITY_SCORE = { sqspCustomerId: 0.5, email: 0.45, phone: 0.4, both: 0.5 } as const

export function identityMatch(subject: Contactable, candidate: IdentityRef): IdentityMatch {
  if (subject.sqspCustomerId && candidate.sqspCustomerIds?.includes(subject.sqspCustomerId)) {
    return { via: 'sqsp_customer_id', score: IDENTITY_SCORE.sqspCustomerId }
  }
  const e = normalizeEmail(subject.email)
  const p = normalizePhone(subject.phone)
  const emailHit = e !== undefined && candidate.emails.some((x) => normalizeEmail(x) === e)
  const phoneHit = p !== undefined && candidate.phones.some((x) => normalizePhone(x) === p)
  if (emailHit && phoneHit) return { via: 'email+phone', score: IDENTITY_SCORE.both }
  if (emailHit) return { via: 'email', score: IDENTITY_SCORE.email }
  if (phoneHit) return { via: 'phone', score: IDENTITY_SCORE.phone }
  return { via: 'none', score: 0 }
}
