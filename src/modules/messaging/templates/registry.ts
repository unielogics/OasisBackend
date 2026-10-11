import type { SmsClass } from '../policy/classes.js'

// The SMS template registry. Keys and wording come from the Operations and Settings designs with "WhatsApp" changed to
// SMS; where the design had two copy sets (seeded history vs live advance) they are unified here.
//
// Syntax: {name} is a variable. {#name}...{/name} is shown only when the variable is present. Bodies keep the designs'
// typography (curly quotes, em dash, a star in the review text); the SMS builder normalises to GSM-7 when sending.

export interface SmsTemplate {
  key: string
  label: string
  klass: SmsClass
  body: string
  /** Variables the caller must supply. */
  required: readonly string[]
  /** Variables the body may use but the caller may leave out (they sit inside {#x} blocks). */
  optional: readonly string[]
  /** Sentences containing {link} are removed from the body when links are disabled (RESCHEDULE_LINK_ENABLED=false). */
  linkOptional?: boolean
  /** Editable in Settings. */
  editable: boolean
  /** Where the copy comes from, for traceability. */
  source: string
}

const t = (tpl: SmsTemplate): SmsTemplate => tpl

export const TEMPLATES = {
  booking_thanks: t({
    key: 'booking_thanks',
    label: 'Booking thanks',
    klass: 'booking_thanks',
    body: 'Hi {first}, thanks for booking with Oasis Auto Spa.',
    required: ['first'],
    optional: [],
    editable: true,
    source: 'cc-domain 7.6 first message',
  }),
  confirm_request: t({
    key: 'confirm_request',
    label: 'Confirmation request',
    klass: 'confirm_request',
    // the design's seeded text said "is confirmed for {time}. Reply C to confirm.", asking to confirm what it called confirmed;
    // the request goes to a booking that is not confirmed yet, so it says "booked" and keeps the rest of the design's words
    body: 'Your appointment at Oasis Auto Spa is booked for {time}.{#prep} {prep}{/prep} Reply C to confirm.',
    required: ['time'],
    // the preparation line of the visit's categories (Settings → Reminders, reminders.category_prep; ADR 0160)
    optional: ['prep'],
    editable: true,
    source: 'cc-domain 7.6 confirmed message ("is confirmed" -> "is booked")',
  }),
  confirmed: t({
    key: 'confirmed',
    label: 'Confirmed',
    klass: 'confirmed',
    body: 'Your appointment is confirmed for {time}.',
    required: ['time'],
    optional: [],
    editable: true,
    source: 'cc-domain 2.1 advance to confirmed',
  }),
  reminder: t({
    key: 'reminder',
    label: 'Reminder',
    klass: 'reminder',
    body: 'Reminder: your Oasis Auto Spa appointment is {when} at {time}.{#prep} {prep}{/prep}',
    required: ['when', 'time'],
    // the preparation line of the visit's categories (Settings → Reminders, reminders.category_prep; ADR 0160)
    optional: ['prep'],
    editable: true,
    source: 'backend design 7.2 / reminders 24 h and 2 h',
  }),
  welcome: t({
    key: 'welcome',
    label: 'Welcome',
    klass: 'welcome',
    body: 'Welcome to Oasis! You’re checked in{#bay} — pull into Bay {bay}{/bay}.',
    required: [],
    optional: ['bay'],
    editable: true,
    source: 'cc-domain 3.10 simArrive',
  }),
  in_progress: t({
    key: 'in_progress',
    label: 'In progress',
    klass: 'in_progress',
    body: 'Good news — your vehicle is now being cleaned.',
    required: [],
    optional: [],
    editable: true,
    source: 'cc-domain 7.6 cleaning',
  }),
  ready: t({
    key: 'ready',
    label: 'Ready for pickup',
    klass: 'ready',
    body: 'Your vehicle is ready for pickup!',
    required: [],
    optional: [],
    editable: true,
    source: 'cc-domain 2.1 advance to completed',
  }),
  receipt: t({
    key: 'receipt',
    label: 'Receipt',
    klass: 'receipt',
    body: 'Payment received — receipt sent. Thank you!',
    required: [],
    optional: [],
    editable: true,
    source: 'cc-domain 2.1 pay',
  }),
  reschedule: t({
    key: 'reschedule',
    label: 'Reschedule',
    klass: 'reschedule',
    body: 'Your appointment has been moved to {time}. Reply if that doesn’t work.',
    required: ['time'],
    optional: [],
    editable: true,
    source: 'cc-domain 4 reschedule',
  }),
  review: t({
    key: 'review',
    label: 'Review request',
    klass: 'review',
    body: 'Thanks for visiting Oasis Auto Spa! How did we do? ⭐',
    required: [],
    optional: [],
    editable: true,
    source: 'cc-domain 7.6 completed (the star is stripped on send)',
  }),
  late_nudge: t({
    key: 'late_nudge',
    label: 'Late nudge',
    klass: 'late_nudge',
    body: 'Hi {first}, we’re holding your {time} appointment at Oasis Auto Spa. Running late? Reply and let us know.',
    required: ['first', 'time'],
    optional: [],
    editable: true,
    source: 'new: cc-domain alert "Message customer" had no copy',
  }),
  payment_link: t({
    key: 'payment_link',
    label: 'Payment link',
    klass: 'payment_link',
    body: 'Here is your secure payment link: {link}',
    required: ['link'],
    optional: [],
    editable: true,
    source: 'cc-domain 7.9 quick reply + link',
  }),
  closure_notice: t({
    key: 'closure_notice',
    label: 'Closure notice',
    klass: 'closure_notice',
    body: 'Hi {first}, Oasis Auto Spa will be closed {until}. We’re sorry for the inconvenience.{#link} Pick a new time here: {link}{/link}',
    required: ['first', 'until'],
    optional: ['link'],
    editable: true,
    source: 'set-domain 1.3 closures notify',
  }),
  emergency: t({
    key: 'emergency',
    label: 'Emergency closing',
    klass: 'emergency',
    body: 'Hi {first}, due to {reason} Oasis Auto Spa is closed {until}. We’re sorry for the inconvenience. Pick a new time here: {link}',
    required: ['first', 'reason', 'until', 'link'],
    optional: [],
    linkOptional: true,
    editable: true,
    source: 'set-domain 1.4 msg',
  }),
  staff_invite: t({
    key: 'staff_invite',
    label: 'Staff invite',
    klass: 'staff_invite',
    body: 'Hi {first}, you’re invited to the Oasis Auto Spa team. Set up your login here: {link}',
    required: ['first', 'link'],
    optional: [],
    editable: true,
    source: 'set-domain employee invite',
  }),
  password_reset: t({
    key: 'password_reset',
    label: 'Password reset',
    klass: 'password_reset',
    body: 'Hi {first}, here is your Oasis Auto Spa password reset link: {link} It works once and expires soon. If you did not ask for it, ignore this text.',
    required: ['first', 'link'],
    optional: [],
    editable: false,
    source: 'new: admin-triggered password reset by SMS (people module)',
  }),
  // the public website (ADR 0150)
  otp_code: t({
    key: 'otp_code',
    label: 'Website sign-in code',
    klass: 'otp_code',
    body: 'Your Oasis Auto Spa code is {code}. It expires in 10 minutes. If you didn’t ask for it, ignore this text.',
    required: ['code'],
    optional: [],
    editable: false,
    source: 'new: website member identification by phone + one-time code (ADR 0150)',
  }),
  booking_confirmed_web: t({
    key: 'booking_confirmed_web',
    label: 'Website booking confirmed',
    klass: 'booking_confirmed_web',
    // the site design's SMS demo: "Booked: Signature Hand Wash, today at 1:00 PM. Members never pay a booking fee. Reply C to change."
    // The member sentence stays for members; a guest gets the fee sentence instead. "Reply C to change" is "Reply here to change it":
    // a C reply means confirm in this system.
    body: 'Booked: {service}, {when} at {time}.{#fee} {fee} booking fee due {how}.{/fee}{#member} Members never pay a booking fee.{/member} Reply here to change it.',
    required: ['service', 'when', 'time'],
    optional: ['fee', 'how', 'member'],
    editable: true,
    source: 'Oasis Site v2 SMS demo (design logic SMS()), adapted for the C keyword',
  }),
  membership_welcome_web: t({
    key: 'membership_welcome_web',
    label: 'Website join welcome',
    klass: 'membership_welcome_web',
    body: 'Hi {first}, thanks for joining Oasis Auto Spa {tier}. We’ll text your secure checkout link shortly; your membership starts once it’s paid.',
    required: ['first', 'tier'],
    optional: [],
    editable: true,
    source: 'new: website join (no card capture online, Squarespace checkout by link; ADR 0150)',
  }),
  addon_approval: t({
    key: 'addon_approval',
    label: 'Add-on approval',
    klass: 'addon_approval',
    body: 'We recommend {addon} ({price}) for your vehicle. Would you like to approve it? Reply here and we’ll add it.',
    required: ['addon', 'price'],
    optional: [],
    editable: true,
    source: 'cc-domain 7.9 "Approve add-on?" with the add-on named',
  }),

  // The AI assistant, personal links and status texts (ADR 0160, design section 2). The link and the reply number are queued as
  // secretVars: the message row shows them masked, only the outbox carries them.
  ai_fallback: t({
    key: 'ai_fallback',
    label: 'Assistant fallback',
    klass: 'ai_fallback',
    body: 'Thanks — a team member will text you back shortly.',
    required: [],
    optional: [],
    editable: false,
    source: 'new: AI assistant failure or handoff (owner decision 2026-10-10)',
  }),
  // A digits-only text with no in-chat action waiting for it, while the assistant serves the number: the digits are filed as
  // "[code]" (never readable, never shown to the model) and this line answers (design section 3). An answer, so ai_reply's rules.
  code_on_link_page: t({
    key: 'code_on_link_page',
    label: 'Codes go on the link page',
    klass: 'ai_reply',
    body: 'For your security, codes are only entered on your secure link page, never by text. Reply here if you need a new link.',
    required: [],
    optional: [],
    editable: false,
    source: 'new: digits-only inbound text while the assistant answers (ADR 0160)',
  }),
  action_confirm: t({
    key: 'action_confirm',
    label: 'In-chat action confirmation',
    klass: 'action_confirm',
    body: '{summary}. Reply {code} to confirm.',
    required: ['summary', 'code'],
    optional: [],
    editable: false,
    source: 'new: the server reply number of an in-chat booking, reschedule or cancel (owner decision 2026-10-10)',
  }),
  personal_link_calendar: t({
    key: 'personal_link_calendar',
    label: 'Personal booking link',
    klass: 'personal_link',
    body: 'Here is your personal Oasis Auto Spa booking link{#first}, {first}{/first}: {link} It is just for you, please don’t share it.',
    required: ['link'],
    optional: ['first'],
    editable: false,
    source: 'new: personal calendar link (ADR 0160)',
  }),
  personal_link_verify: t({
    key: 'personal_link_verify',
    label: 'Verify link',
    klass: 'personal_link',
    body: 'To confirm it’s you, open this secure Oasis Auto Spa link: {link} It expires in 15 minutes.',
    required: ['link'],
    optional: ['first'],
    editable: false,
    source: 'new: phone verification link (PIN or code entered on the page only; ADR 0160)',
  }),
  personal_link_pin: t({
    key: 'personal_link_pin',
    label: 'PIN link',
    klass: 'personal_link',
    body: 'Set or change your Oasis Auto Spa PIN on this secure page: {link} It expires in 15 minutes. We will never ask for your PIN by text.',
    required: ['link'],
    optional: ['first'],
    editable: false,
    source: 'new: website PIN link (ADR 0160)',
  }),
  personal_link_membership: t({
    key: 'personal_link_membership',
    label: 'Membership link',
    klass: 'personal_link',
    body: 'Start your Oasis Auto Spa{#plan} {plan}{/plan} membership on this secure page: {link} It expires in 24 hours.',
    required: ['link'],
    optional: ['first', 'plan'],
    editable: false,
    source: 'new: membership link, fresh PIN or code on the page (ADR 0160)',
  }),
  personal_link_pay: t({
    key: 'personal_link_pay',
    label: 'Payment link (personal)',
    klass: 'personal_link',
    body: 'Review and pay your Oasis Auto Spa invoice on this secure page: {link}',
    required: ['link'],
    optional: ['first'],
    editable: false,
    source: 'new: invoice payment link, fresh PIN or code on the page (ADR 0160)',
  }),
  personal_link_book_again: t({
    key: 'personal_link_book_again',
    label: 'Book-again link',
    klass: 'personal_link',
    body: 'Book your next visit at Oasis Auto Spa here: {link}',
    required: ['link'],
    optional: ['first'],
    editable: false,
    source: 'new: book-again link (ADR 0160)',
  }),
  // The picked-up thank-you (status texts, wave W3d). {receipt} is "Paid in full: $54.00." when nothing is owed and no receipt text
  // went in the last 2 hours. The variant with the book-again link is picked_up_link: a personal link is a secret (only its hash is
  // stored), so it rides in the personal_link class, whose message row keeps the link masked and whose outbox body is wiped.
  picked_up: t({
    key: 'picked_up',
    label: 'Picked up',
    klass: 'picked_up',
    body: 'Thanks for visiting Oasis Auto Spa{#first}, {first}{/first}!{#receipt} {receipt}{/receipt}',
    required: [],
    optional: ['first', 'receipt'],
    editable: true,
    source: 'new: status text "picked up" (owner decision 2026-10-10)',
  }),
  picked_up_link: t({
    key: 'picked_up_link',
    label: 'Picked up (book-again link)',
    klass: 'personal_link',
    body: 'Thanks for visiting Oasis Auto Spa{#first}, {first}{/first}!{#receipt} {receipt}{/receipt} Book your next visit: {link}',
    required: ['link'],
    optional: ['first', 'receipt'],
    editable: false,
    source: 'new: status text "picked up" with the book-again link (only with marketing-grade consent; owner decision 2026-10-10)',
  }),
  job_delay: t({
    key: 'job_delay',
    label: 'Running late',
    klass: 'job_delay',
    body: 'We’re running a little behind on your vehicle. New estimate: {eta}. Sorry for the wait!',
    required: ['eta'],
    optional: [],
    editable: true,
    source: 'new: status text "running late" (owner decision 2026-10-10)',
  }),
  lead_follow_up: t({
    key: 'lead_follow_up',
    label: 'Lead follow-up',
    klass: 'lead_follow_up',
    body: 'Hi{#first} {first}{/first}, thanks for reaching out to Oasis Auto Spa{#interest} about {interest}{/interest}. Reply here and we’ll save you a spot.{#link} Or pick a time: {link}{/link}',
    required: [],
    optional: ['first', 'interest', 'link'],
    editable: true,
    source: 'new: the one automatic lead follow-up (owner decision 2026-10-10)',
  }),

  // replies the inbound router asks for
  opt_out_confirm: t({
    key: 'opt_out_confirm',
    label: 'Opt-out confirmation',
    klass: 'opt_out_confirm',
    body: 'You’re unsubscribed from Oasis Auto Spa texts and won’t get any more. Reply START to subscribe again.',
    required: [],
    optional: [],
    editable: false,
    source: 'new: inbound STOP reply',
  }),
  opt_in_confirm: t({
    key: 'opt_in_confirm',
    label: 'Opt-in confirmation',
    klass: 'opt_in_confirm',
    body: 'You’re subscribed to Oasis Auto Spa texts again. Reply STOP to opt out.',
    required: [],
    optional: [],
    editable: false,
    source: 'new: inbound START reply',
  }),
  help_reply: t({
    key: 'help_reply',
    label: 'Help reply',
    klass: 'help_reply',
    body: 'Oasis Auto Spa: reply here and our team will get back to you{#phone}, or call {phone}{/phone}. Msg frequency varies. Reply STOP to opt out.',
    required: [],
    optional: ['phone'],
    editable: false,
    source: 'new: inbound HELP reply',
  }),
  confirm_ack: t({
    key: 'confirm_ack',
    label: 'Confirmation acknowledged',
    klass: 'confirm_ack',
    body: 'Thanks! Your appointment is confirmed for {time}. See you then.',
    required: ['time'],
    optional: [],
    editable: false,
    source: 'new: inbound C reply',
  }),
  confirm_none: t({
    key: 'confirm_none',
    label: 'Nothing to confirm',
    klass: 'confirm_none',
    body: 'We don’t have an appointment waiting for confirmation. Reply here if you need a hand.',
    required: [],
    optional: [],
    editable: false,
    source: 'new: inbound C reply with nothing to confirm',
  }),
} as const satisfies Record<string, SmsTemplate>

export type TemplateKey = keyof typeof TEMPLATES

export interface QuickReply {
  key: string
  label: string
  text: string
  /** The class a staff-sent quick reply is queued under. */
  klass: SmsClass
}

/** The seven quick replies from cc-domain 7.9, verbatim. */
export const QUICK_REPLIES: readonly QuickReply[] = [
  { key: 'qr_confirmed', label: 'Confirmed', text: 'Your appointment is confirmed. See you soon!', klass: 'quick_reply' },
  { key: 'qr_ready_for_you', label: 'We’re ready', text: 'We’re ready for you — come on in!', klass: 'quick_reply' },
  { key: 'qr_checked_in', label: 'Checked in', text: 'Your vehicle has been checked in.', klass: 'quick_reply' },
  { key: 'qr_being_cleaned', label: 'Being cleaned', text: 'Your vehicle is now being cleaned.', klass: 'quick_reply' },
  { key: 'qr_ready_pickup', label: 'Ready for pickup', text: 'Your vehicle is ready for pickup!', klass: 'quick_reply' },
  { key: 'qr_approve_addon', label: 'Approve add-on?', text: 'We recommend an add-on — would you like to approve it?', klass: 'quick_reply' },
  { key: 'qr_payment_link', label: 'Payment link', text: 'Here is your secure payment link.', klass: 'quick_reply' },
]

export function isTemplateKey(value: string): value is TemplateKey {
  return Object.prototype.hasOwnProperty.call(TEMPLATES, value)
}

/** The five emergency reasons and the phrase each contributes to {reason}. */
export const EMERGENCY_REASONS = {
  'Severe weather': 'severe weather',
  'Power outage': 'a power outage',
  'Equipment failure': 'an equipment failure',
  'Staff shortage': 'a staffing issue',
  Other: 'unforeseen circumstances',
} as const

export type EmergencyReason = keyof typeof EMERGENCY_REASONS

/** The {until} phrase for an emergency closure ("for the rest of today", "until 2:00 PM today", "through Monday, Jun 15"). */
export function emergencyUntilText(spec: { dur: 'today' | 'until' | 'days'; until?: string; through?: string }): string {
  if (spec.dur === 'today') return 'for the rest of today'
  if (spec.dur === 'until') return `until ${spec.until ?? ''} today`.replace('  ', ' ')
  const date = new Date(`${spec.through ?? ''}T12:00:00Z`)
  const text = Number.isNaN(date.getTime())
    ? (spec.through ?? '')
    : date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })
  return `through ${text}`
}
