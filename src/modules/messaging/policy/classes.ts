import type { SmsPriority } from '../../../integrations/ports/sms.js'

// Every outbound SMS belongs to exactly one class. The class decides its lane, whether quiet hours may hold it, how long it
// stays worth sending, and whether it carries the "Reply STOP" footer.

export type SmsCategory = 'transactional' | 'automated' | 'marketing' | 'conversation' | 'system'

export type FooterRule = 'always' | 'first_only' | 'never'

export interface SmsClassSpec {
  /** Lane: 0 transactional/urgent (reserved capacity), 1 confirmations/receipts/replies, 2 reminders/reviews, 3 bulk. */
  priority: SmsPriority
  category: SmsCategory
  /**
   * Transactional classes are never held by quiet hours. The list is explicit on purpose: a booking made at 9:30 PM must
   * still get its confirmation, and a closure notice must not wait for morning.
   */
  transactional: boolean
  /** How long the message stays worth sending once it is allowed to go out. */
  ttlSec: number
  footer: FooterRule
  /** Reply to a message the customer just sent (or a keyword response): no marketing opt-in flag needed. */
  consentExempt?: boolean
  /** STOP confirmation and HELP reply are sent even to a number that has opted out. */
  ignoresOptOut?: boolean
  /** Sent to staff, not customers. */
  recipient?: 'customer' | 'employee'
}

const MIN = 60
const HOUR = 3600

export const SMS_CLASSES = {
  // transactional
  booking_thanks: {
    priority: 1,
    category: 'transactional',
    transactional: true,
    ttlSec: 6 * HOUR,
    footer: 'first_only',
  },
  confirmed: {
    priority: 1,
    category: 'transactional',
    transactional: true,
    ttlSec: 6 * HOUR,
    footer: 'always',
  },
  welcome: {
    priority: 0,
    category: 'transactional',
    transactional: true,
    ttlSec: 15 * MIN,
    footer: 'first_only',
  },
  in_progress: {
    priority: 1,
    category: 'transactional',
    transactional: true,
    ttlSec: 30 * MIN,
    footer: 'first_only',
  },
  ready: {
    priority: 0,
    category: 'transactional',
    transactional: true,
    ttlSec: 4 * HOUR,
    footer: 'first_only',
  },
  receipt: {
    priority: 1,
    category: 'transactional',
    transactional: true,
    ttlSec: 24 * HOUR,
    footer: 'first_only',
  },
  reschedule: {
    priority: 1,
    category: 'transactional',
    transactional: true,
    ttlSec: 6 * HOUR,
    footer: 'first_only',
  },
  payment_link: {
    priority: 1,
    category: 'transactional',
    transactional: true,
    ttlSec: 6 * HOUR,
    footer: 'first_only',
  },
  addon_approval: {
    priority: 0,
    category: 'transactional',
    transactional: true,
    ttlSec: 30 * MIN,
    footer: 'first_only',
  },
  emergency: {
    priority: 3,
    category: 'transactional',
    transactional: true,
    ttlSec: 6 * HOUR,
    footer: 'first_only',
  },
  staff_invite: {
    priority: 0,
    category: 'transactional',
    transactional: true,
    ttlSec: 24 * HOUR,
    footer: 'never',
    recipient: 'employee',
  },
  password_reset: {
    priority: 0,
    category: 'transactional',
    transactional: true,
    ttlSec: 30 * MIN,
    footer: 'never',
    recipient: 'employee',
  },
  // staff typing in the conversation, quick replies
  staff_message: {
    priority: 1,
    category: 'conversation',
    transactional: true,
    ttlSec: 1 * HOUR,
    footer: 'first_only',
  },
  quick_reply: {
    priority: 1,
    category: 'conversation',
    transactional: true,
    ttlSec: 1 * HOUR,
    footer: 'first_only',
  },
  // automated, held overnight
  confirm_request: {
    priority: 2,
    category: 'automated',
    transactional: false,
    ttlSec: 12 * HOUR,
    footer: 'always',
  },
  reminder: { priority: 2, category: 'automated', transactional: false, ttlSec: 2 * HOUR, footer: 'always' },
  review: {
    priority: 2,
    category: 'automated',
    transactional: false,
    ttlSec: 48 * HOUR,
    footer: 'first_only',
  },
  late_nudge: {
    priority: 2,
    category: 'automated',
    transactional: false,
    ttlSec: 30 * MIN,
    footer: 'first_only',
  },
  closure_notice: {
    priority: 3,
    category: 'automated',
    transactional: false,
    ttlSec: 12 * HOUR,
    footer: 'first_only',
  },
  broadcast: {
    priority: 3,
    category: 'marketing',
    transactional: false,
    ttlSec: 12 * HOUR,
    footer: 'always',
  },
  // replies to inbound keywords and messages (answered immediately)
  opt_out_confirm: {
    priority: 0,
    category: 'system',
    transactional: true,
    ttlSec: 1 * HOUR,
    footer: 'never',
    consentExempt: true,
    ignoresOptOut: true,
  },
  opt_in_confirm: {
    priority: 0,
    category: 'system',
    transactional: true,
    ttlSec: 1 * HOUR,
    footer: 'never',
    consentExempt: true,
    ignoresOptOut: true,
  },
  help_reply: {
    priority: 0,
    category: 'system',
    transactional: true,
    ttlSec: 1 * HOUR,
    footer: 'never',
    consentExempt: true,
    ignoresOptOut: true,
  },
  confirm_ack: {
    priority: 0,
    category: 'conversation',
    transactional: true,
    ttlSec: 1 * HOUR,
    footer: 'never',
    consentExempt: true,
  },
  confirm_none: {
    priority: 0,
    category: 'conversation',
    transactional: true,
    ttlSec: 1 * HOUR,
    footer: 'never',
    consentExempt: true,
  },
} as const satisfies Record<string, SmsClassSpec>

export type SmsClass = keyof typeof SMS_CLASSES

export function classSpec(klass: SmsClass): SmsClassSpec {
  return SMS_CLASSES[klass]
}

export function isTransactional(klass: SmsClass): boolean {
  return SMS_CLASSES[klass].transactional
}

/** The classes quiet hours never hold, listed for docs and tests. */
export const TRANSACTIONAL_CLASSES = (Object.keys(SMS_CLASSES) as SmsClass[]).filter(isTransactional)

/** The classes quiet hours hold. */
export const QUIET_HOURS_HELD_CLASSES = (Object.keys(SMS_CLASSES) as SmsClass[]).filter(
  (k) => !isTransactional(k),
)

export function isSmsClass(value: string): value is SmsClass {
  return Object.prototype.hasOwnProperty.call(SMS_CLASSES, value)
}
