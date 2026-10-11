// The words and moments of the status texts (ADR 0160, design section 6), as pure functions. The port, the jobs and the Settings
// preview (POST /settings/reminders/preview) all compose through here, so the preview is exactly what goes out.
//   checked in     welcome template without the bay ("Welcome to Oasis! You're checked in."), queued checked_in_delay_min after a
//                  manual arrival, dropped once the wash starts (then the existing "wash started" text goes)
//   running late   job_delay: the wash ran past its promised end + late_grace_min; new estimate = now + 15 min, rounded up to 5
//   picked up      picked_up: the thank-you, "Paid in full: $54.00." when nothing is owed and no receipt text went in the last 2 h,
//                  and the book-again link (template picked_up_link, class personal_link) only when the caller decided it may go
import { formatUsd } from '../../platform/money.js'
import { fmtT, minutesOfDay } from '../../platform/time.js'
import type { TemplateVars } from '../messaging/templates/render.js'

const MIN = 60_000

/** The new estimate of a running-late text: this far ahead of now... */
export const LATE_ETA_AHEAD_MIN = 15
/** ...rounded up to this step. */
export const LATE_ETA_STEP_MIN = 5
/**
 * A running-late text is sent only this long after its moment. The job runs every 2 minutes, so a text is never missed while it
 * runs; a visit left in "cleaning" long after the car went home (or a worker that was down) gets no stale "running behind" text.
 */
export const LATE_SEND_WINDOW_MS = 30 * MIN
/** A checked-in text this late (the welcome class's 15-minute life) is dropped instead of sent. */
export const CHECKIN_SEND_WINDOW_MS = 15 * MIN
/** No receipt line in the picked-up text when a receipt text went to the client this recently. */
export const RECEIPT_TEXT_WINDOW_MS = 2 * 60 * MIN

export interface StatusMessage {
  templateKey: 'welcome' | 'job_delay' | 'picked_up' | 'picked_up_link'
  vars: TemplateVars
  /** The personal link (picked_up_link): sent in the outbox only, masked in the message row. */
  secretVars?: Record<string, string>
}

/**
 * The checked-in text: the existing welcome template without the bay. The geofence welcome names the planned bay because the
 * client is driving in; after a manual check-in the car is already with the team, and the planned bay may change.
 */
export function checkedInMessage(): StatusMessage {
  return { templateKey: 'welcome', vars: {} }
}

/** now + 15 minutes, rounded up to the next 5 minutes (whole-hour time zones keep 5-minute steps on the local clock). */
export function lateEta(now: Date): Date {
  const step = LATE_ETA_STEP_MIN * MIN
  return new Date(Math.ceil((now.getTime() + LATE_ETA_AHEAD_MIN * MIN) / step) * step)
}

export function lateMessage(eta: Date, tz: string): StatusMessage {
  return { templateKey: 'job_delay', vars: { eta: fmtT(minutesOfDay(eta, tz)) } }
}

/**
 * When the visit was promised to be done: the booked end, or, when the wash began late (the client came late, the line was long),
 * the start of cleaning plus the service's duration, whichever is later.
 */
export function promisedEnd(a: { scheduledEnd: Date; cleaningStartedAt: Date | null; durationMin: number }): Date {
  const fromStart = a.cleaningStartedAt ? a.cleaningStartedAt.getTime() + a.durationMin * MIN : 0
  return new Date(Math.max(a.scheduledEnd.getTime(), fromStart))
}

/** The moment the next running-late text is due: the promised end + grace, then the last estimate given + grace. */
export function lateDueAt(o: { promisedEnd: Date; lastEta: Date | null; graceMin: number }): Date {
  return new Date((o.lastEta ?? o.promisedEnd).getTime() + o.graceMin * MIN)
}

export type LateDecision = { send: true; seq: number; dueAt: Date } | { send: false; reason: 'max_reached' | 'not_yet' | 'too_late' }

/** Whether a visit still cleaning gets a running-late text now (`sent` = the texts it already has, `max` = status_texts.late_max). */
export function lateDecision(o: {
  now: Date
  promisedEnd: Date
  lastEta: Date | null
  sent: number
  max: number
  graceMin: number
}): LateDecision {
  if (o.sent >= o.max) return { send: false, reason: 'max_reached' }
  const dueAt = lateDueAt(o)
  if (o.now.getTime() < dueAt.getTime()) return { send: false, reason: 'not_yet' }
  if (o.now.getTime() > dueAt.getTime() + LATE_SEND_WINDOW_MS) return { send: false, reason: 'too_late' }
  return { send: true, seq: o.sent + 1, dueAt }
}

/**
 * The receipt line of the picked-up text: "Paid in full: $54.00." when the visit's invoice owes nothing and was not free, and no
 * receipt text went to the client in the last 2 hours (the payment's own receipt already said it). Otherwise none.
 */
export function receiptLine(invoice: { totalCents: number; balanceCents: number } | null, receiptTextedRecently: boolean): string | null {
  if (!invoice || receiptTextedRecently) return null
  if (invoice.balanceCents > 0 || invoice.totalCents <= 0) return null
  return `Paid in full: ${formatUsd(invoice.totalCents)}.`
}

/** The picked-up text; with a link it is the picked_up_link template and the link is a secret variable. */
export function pickedUpMessage(o: { firstName: string | null; receipt: string | null; link: string | null }): StatusMessage {
  const vars: TemplateVars = { first: o.firstName, receipt: o.receipt }
  return o.link ? { templateKey: 'picked_up_link', vars, secretVars: { link: o.link } } : { templateKey: 'picked_up', vars }
}
