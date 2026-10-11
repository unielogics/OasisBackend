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
  /**
   * Only as an answer: refused (no_recent_inbound) unless that number texted the shop within this many seconds. enqueueFor loads
   * the number's last inbound text for these classes (SmsRecipient.lastInboundAt).
   */
  replyWindowSec?: number
  /**
   * Consent-exempt only as an answer: when that number texted the shop within this many seconds the text needs no opt-in; outside
   * it normal consent applies (never refused for the window alone). enqueueFor loads the last inbound text for these classes too.
   */
  replyConsentSec?: number
}

const MIN = 60
const HOUR = 3600

export const SMS_CLASSES = {
  // transactional
  booking_thanks: { priority: 1, category: 'transactional', transactional: true, ttlSec: 6 * HOUR, footer: 'first_only' },
  confirmed: { priority: 1, category: 'transactional', transactional: true, ttlSec: 6 * HOUR, footer: 'always' },
  welcome: { priority: 0, category: 'transactional', transactional: true, ttlSec: 15 * MIN, footer: 'first_only' },
  in_progress: { priority: 1, category: 'transactional', transactional: true, ttlSec: 30 * MIN, footer: 'first_only' },
  ready: { priority: 0, category: 'transactional', transactional: true, ttlSec: 4 * HOUR, footer: 'first_only' },
  receipt: { priority: 1, category: 'transactional', transactional: true, ttlSec: 24 * HOUR, footer: 'first_only' },
  reschedule: { priority: 1, category: 'transactional', transactional: true, ttlSec: 6 * HOUR, footer: 'first_only' },
  payment_link: { priority: 1, category: 'transactional', transactional: true, ttlSec: 6 * HOUR, footer: 'first_only' },
  addon_approval: { priority: 0, category: 'transactional', transactional: true, ttlSec: 30 * MIN, footer: 'first_only' },
  emergency: { priority: 3, category: 'transactional', transactional: true, ttlSec: 6 * HOUR, footer: 'first_only' },
  staff_invite: { priority: 0, category: 'transactional', transactional: true, ttlSec: 24 * HOUR, footer: 'never', recipient: 'employee' },
  password_reset: { priority: 0, category: 'transactional', transactional: true, ttlSec: 30 * MIN, footer: 'never', recipient: 'employee' },
  // the public website (ADR 0150): a one-time code the person just asked for (consent-exempt, sent even to a number that opted out,
  // like the keyword replies: the person is at the keyboard asking for it), the booking confirmation and the join welcome. The code
  // is lane 1, beside the confirmations and payment links, never lane 0: a stranger asking for codes must not spend the window's
  // reserve that ready-for-pickup texts rely on (review 2026-10-10); the website's hourly ceiling bounds how many there are.
  otp_code: { priority: 1, category: 'transactional', transactional: true, ttlSec: 10 * MIN, footer: 'never', consentExempt: true, ignoresOptOut: true },
  booking_confirmed_web: { priority: 1, category: 'transactional', transactional: true, ttlSec: 6 * HOUR, footer: 'first_only' },
  membership_welcome_web: { priority: 1, category: 'transactional', transactional: true, ttlSec: 6 * HOUR, footer: 'first_only' },
  // staff typing in the conversation, quick replies
  staff_message: { priority: 1, category: 'conversation', transactional: true, ttlSec: 1 * HOUR, footer: 'first_only' },
  quick_reply: { priority: 1, category: 'conversation', transactional: true, ttlSec: 1 * HOUR, footer: 'first_only' },
  // automated, held overnight
  confirm_request: { priority: 2, category: 'automated', transactional: false, ttlSec: 12 * HOUR, footer: 'always' },
  reminder: { priority: 2, category: 'automated', transactional: false, ttlSec: 2 * HOUR, footer: 'always' },
  review: { priority: 2, category: 'automated', transactional: false, ttlSec: 48 * HOUR, footer: 'first_only' },
  late_nudge: { priority: 2, category: 'automated', transactional: false, ttlSec: 30 * MIN, footer: 'first_only' },
  closure_notice: { priority: 3, category: 'automated', transactional: false, ttlSec: 12 * HOUR, footer: 'first_only' },
  broadcast: { priority: 3, category: 'marketing', transactional: false, ttlSec: 12 * HOUR, footer: 'always' },
  // replies to inbound keywords and messages (answered immediately)
  opt_out_confirm: { priority: 0, category: 'system', transactional: true, ttlSec: 1 * HOUR, footer: 'never', consentExempt: true, ignoresOptOut: true },
  opt_in_confirm: { priority: 0, category: 'system', transactional: true, ttlSec: 1 * HOUR, footer: 'never', consentExempt: true, ignoresOptOut: true },
  help_reply: { priority: 0, category: 'system', transactional: true, ttlSec: 1 * HOUR, footer: 'never', consentExempt: true, ignoresOptOut: true },
  confirm_ack: { priority: 0, category: 'conversation', transactional: true, ttlSec: 1 * HOUR, footer: 'never', consentExempt: true },
  confirm_none: { priority: 0, category: 'conversation', transactional: true, ttlSec: 1 * HOUR, footer: 'never', consentExempt: true },
  // The AI text assistant (ADR 0160, design section 2). Its answers go 24/7 but only as answers: consent-exempt like the keyword
  // replies, yet refused unless that number texted in the last 15 minutes, and never to a number that opted out. Lane 1, under the
  // shop's lane-0 texts; the dispatcher gives them a sub-cap (AI_SMS_SEGMENTS_PER_30MIN). ai_fallback is the fixed "a team member
  // will text you back" line.
  ai_reply: { priority: 1, category: 'conversation', transactional: true, ttlSec: 15 * MIN, footer: 'first_only', consentExempt: true, replyWindowSec: 15 * MIN },
  ai_fallback: { priority: 1, category: 'conversation', transactional: true, ttlSec: 15 * MIN, footer: 'first_only', consentExempt: true, replyWindowSec: 15 * MIN },
  // A personal link (calendar, verify, PIN, membership, payment, book again): the message row keeps the masked text, the outbox the
  // real one (secretVars). Consent-exempt only as a reply within 15 minutes of that number's last text (the assistant answering);
  // otherwise normal consent (a client the assistant created has the transactional kind). Never to an opted-out number.
  personal_link: { priority: 1, category: 'transactional', transactional: true, ttlSec: 30 * MIN, footer: 'first_only', replyConsentSec: 15 * MIN },
  // "<summary>. Reply 4821 to confirm.": the server's reply number for an in-chat action, masked in the message row. It answers the
  // request it confirms: only within 15 minutes of that number's last text (same rule as ai_reply), consent-exempt as that reply,
  // never to an opted-out number.
  action_confirm: { priority: 1, category: 'transactional', transactional: true, ttlSec: 15 * MIN, footer: 'first_only', consentExempt: true, replyWindowSec: 15 * MIN },
  // The one automatic follow-up of a lead: held by quiet hours, only within 24 hours of their last text (that is its consent: a
  // follow-up to their own question), never to an opted-out number.
  lead_follow_up: { priority: 2, category: 'automated', transactional: false, ttlSec: 2 * HOUR, footer: 'always', consentExempt: true, replyWindowSec: 24 * HOUR },
  // Status texts (design section 6): picked up (thank-you, receipt line) and running late (a new estimate). Checked in reuses welcome.
  picked_up: { priority: 1, category: 'transactional', transactional: true, ttlSec: 2 * HOUR, footer: 'first_only' },
  job_delay: { priority: 1, category: 'transactional', transactional: true, ttlSec: 20 * MIN, footer: 'first_only' },
} as const satisfies Record<string, SmsClassSpec>

export type SmsClass = keyof typeof SMS_CLASSES

export function classSpec(klass: SmsClass): SmsClassSpec {
  return SMS_CLASSES[klass]
}

/**
 * How far back a class looks at the number's last inbound text (its reply window or its reply consent), or null when it does not.
 * enqueueFor reads the last inbound text and the opt-out itself for these classes, never trusting the caller.
 */
export function replyContextOf(klass: SmsClass): number | null {
  const spec = classSpec(klass)
  const w = Math.max(spec.replyWindowSec ?? 0, spec.replyConsentSec ?? 0)
  return w > 0 ? w : null
}

export function isTransactional(klass: SmsClass): boolean {
  return SMS_CLASSES[klass].transactional
}

/** The classes quiet hours never hold, listed for docs and tests. */
export const TRANSACTIONAL_CLASSES = (Object.keys(SMS_CLASSES) as SmsClass[]).filter(isTransactional)

/** The classes quiet hours hold. */
export const QUIET_HOURS_HELD_CLASSES = (Object.keys(SMS_CLASSES) as SmsClass[]).filter((k) => !isTransactional(k))

export function isSmsClass(value: string): value is SmsClass {
  return Object.prototype.hasOwnProperty.call(SMS_CLASSES, value)
}
