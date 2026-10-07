import { prepareSmsBody, type NormalizeOptions, type PreparedSms } from '../../../integrations/sms/gsm.js'
import { classSpec, type SmsClass } from './classes.js'

export const STOP_FOOTER = 'Reply STOP to opt out.'

/** True when the text already tells the reader how to opt out ("Reply STOP"): a customer's name that happens to be "stop" does not count. */
export function hasStopNotice(body: string): boolean {
  return /\b(reply|text|send)\s+stop\b/i.test(body)
}

/**
 * First message to a number and every confirmation or reminder carry the opt-out line. Classes marked footer:'never'
 * (keyword replies, staff invites) are exempt, and a body that already mentions STOP is left alone.
 */
export function needsStopFooter(klass: SmsClass, firstMessageToNumber: boolean): boolean {
  const rule = classSpec(klass).footer
  if (rule === 'never') return false
  return rule === 'always' || firstMessageToNumber
}

export function applyStopFooter(body: string, klass: SmsClass, firstMessageToNumber: boolean): string {
  if (!needsStopFooter(klass, firstMessageToNumber) || hasStopNotice(body)) return body
  return `${body.trimEnd()} ${STOP_FOOTER}`
}

export interface PreparedOutbound extends PreparedSms {
  footerApplied: boolean
}

/** Normalise to GSM-7, add the footer if required, and count segments of exactly what goes on the wire. */
export function prepareOutboundBody(
  text: string,
  klass: SmsClass,
  opts: { firstMessageToNumber: boolean; normalize?: NormalizeOptions },
): PreparedOutbound {
  const normalised = prepareSmsBody(text, opts.normalize).body
  const withFooter = applyStopFooter(normalised, klass, opts.firstMessageToNumber)
  const prepared = prepareSmsBody(withFooter, opts.normalize)
  return { ...prepared, changed: prepared.body !== text, footerApplied: withFooter !== normalised }
}

/**
 * Moment after which the message is no longer worth sending. The clock starts when the message may first go out, so a
 * reminder queued at 10 PM and held to 8 AM still gets its full window.
 */
export function expiryFor(klass: SmsClass, queuedAt: Date, holdUntil?: Date | null, ttlOverrideSec?: number): Date {
  const start = holdUntil && holdUntil.getTime() > queuedAt.getTime() ? holdUntil : queuedAt
  return new Date(start.getTime() + (ttlOverrideSec ?? classSpec(klass).ttlSec) * 1000)
}
