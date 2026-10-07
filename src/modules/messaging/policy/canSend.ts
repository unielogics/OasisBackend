import { isE164 } from '../../../integrations/sms/phone.js'
import { classSpec, isTransactional, type SmsClass } from './classes.js'
import { DEFAULT_QUIET_HOURS, isQuietHour, quietHoursEnd, type QuietHoursConfig } from './quietHours.js'

// canSendSms: the single gate every outbound SMS passes. Order matters: a hard "no" (invalid number, opt-out, synthetic,
// allowlist, consent) always beats a "hold" (quiet hours), so held messages are only ever ones that are allowed to go.

export type ConsentSource = 'web_form' | 'staff_attested' | 'inbound_reply' | 'import' | 'unknown'

export interface SmsRecipient {
  kind: 'customer' | 'employee'
  id?: string
  /** E.164, or null when we hold no usable number. */
  phone: string | null
  /** Customer-level flag mirroring "SMS opted-in" in the dashboard. Employees do not need it. */
  smsOptIn: boolean
  /** True when sms_opt_outs holds an active row for the number (loaded by the caller; see OptOutRepository). */
  activeOptOut: boolean
  /** Seed and demo data: the number is fake and must never be texted. */
  synthetic: boolean
  consentSource?: ConsentSource | null
}

export interface SmsPurpose {
  klass: SmsClass
}

export interface SmsPolicyContext {
  now: Date
  /** NODE_ENV. Outside production, only allowlisted numbers may be texted. */
  environment: 'production' | 'development' | 'test'
  /** SMS_ALLOWLIST, E.164. Empty means unrestricted in production and nothing allowed elsewhere. */
  allowlist: readonly string[]
  quietHours?: QuietHoursConfig
}

export type SmsDenyReason =
  | 'no_valid_phone'
  | 'opted_out'
  | 'synthetic_number'
  | 'not_allowlisted'
  | 'not_opted_in'
  | 'consent_source_insufficient'
  | 'recipient_kind_mismatch'

export type SmsDecision =
  | { verdict: 'allow'; allowed: true; reason: null; warnings: string[] }
  | { verdict: 'hold'; allowed: true; reason: 'quiet_hours'; holdUntil: Date; warnings: string[] }
  | { verdict: 'deny'; allowed: false; reason: SmsDenyReason; warnings: string[] }

/** Consent sources that count as explicit opt-in for marketing-category messages. */
const MARKETING_CONSENT: ReadonlySet<ConsentSource> = new Set(['web_form', 'inbound_reply'])

export function canSendSms(recipient: SmsRecipient, purpose: SmsPurpose, ctx: SmsPolicyContext): SmsDecision {
  const spec = classSpec(purpose.klass)
  const warnings: string[] = []
  const deny = (reason: SmsDenyReason): SmsDecision => ({ verdict: 'deny', allowed: false, reason, warnings })

  const expected = spec.recipient ?? 'customer'
  if (recipient.kind !== expected) return deny('recipient_kind_mismatch')

  if (!recipient.phone || !isE164(recipient.phone)) return deny('no_valid_phone')

  // A STOP is honoured for every class, emergencies included. The only exceptions are the replies to keywords themselves.
  if (recipient.activeOptOut && !spec.ignoresOptOut) return deny('opted_out')

  const phone = recipient.phone
  const allowlisted = ctx.allowlist.includes(phone)
  const production = ctx.environment === 'production'
  if (recipient.synthetic && (production || !allowlisted)) return deny('synthetic_number')
  if (!production && !allowlisted) return deny('not_allowlisted')
  if (production && ctx.allowlist.length > 0 && !allowlisted) return deny('not_allowlisted')

  if (recipient.kind === 'customer' && !spec.consentExempt) {
    if (!recipient.smsOptIn) return deny('not_opted_in')
    if (
      spec.category === 'marketing' &&
      !(recipient.consentSource && MARKETING_CONSENT.has(recipient.consentSource))
    ) {
      return deny('consent_source_insufficient')
    }
    if (!recipient.consentSource) warnings.push('consent_source_missing')
  }

  const quiet = ctx.quietHours ?? DEFAULT_QUIET_HOURS
  if (!isTransactional(purpose.klass) && isQuietHour(ctx.now, quiet)) {
    return {
      verdict: 'hold',
      allowed: true,
      reason: 'quiet_hours',
      holdUntil: quietHoursEnd(ctx.now, quiet),
      warnings,
    }
  }
  return { verdict: 'allow', allowed: true, reason: null, warnings }
}
