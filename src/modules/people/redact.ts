// Contact redaction for read models of other modules (customers, appointments, messages): callers without cli.contact
// see masked phone/email, and must not be able to search by them either.
import { hasPermission, type AuthContext } from '../../http/authorizer.js'
import { maskEmail, maskPhone } from '../../platform/phone.js'

export const canSeeContact = (ctx: AuthContext): boolean => hasPermission(ctx, 'cli.contact')

/** Returns the values unchanged for callers with cli.contact, otherwise masked ("+1******0142", "f***@host"). */
export function maskContact<T extends { phone?: string | null; email?: string | null }>(
  ctx: AuthContext,
  value: T,
): T {
  if (canSeeContact(ctx)) return value
  return {
    ...value,
    ...(value.phone != null ? { phone: maskPhone(value.phone) } : {}),
    ...(value.email != null ? { email: maskEmail(value.email) } : {}),
  }
}

/**
 * Whether a free-text search may match phone numbers and emails. Without cli.contact it must not, or the result set
 * would reveal the hidden values.
 */
export const searchMayMatchContact = canSeeContact
