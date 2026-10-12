// Pure rules of the memberships billed by Square (ADR 0171 wave Q3b, design 5.4 and 5.5, plan decision 7):
//   - a paid invoice's period, in shop-local midnights, from its due date and the subscription's charged_through_date;
//   - Square's subscription status as the membership's status;
//   - what Square has scheduled for the next billing date (cancel, pause, a plan swap: they take effect then, sandbox 2026-10-12);
//   - the failure timeline: day 0 grace (perks on, card link texted), day 7 past due (perks off), day 21 canceled; any payment
//     restores (the setting memberships.billing_policy holds the 7 and the 21);
//   - the email Square bills to must look deliverable: Square deactivates a subscription whose customer email it cannot deliver to
//     (an example.com address did, within seconds, in the sandbox), so reserved and test domains are refused up front.
import { DateTime } from 'luxon'
import type { WireSubscription, WireSubscriptionAction } from '../../../integrations/square/wire.js'
import type { MembershipStatus } from '../schema.js'

/** The shop-local midnight that starts a date (yyyy-mm-dd). */
export function shopMidnight(date: string, tz: string): Date {
  const d = DateTime.fromISO(date, { zone: tz }).startOf('day')
  if (!d.isValid) throw new RangeError(`not a date: ${date}`)
  return d.toJSDate()
}

/** The shop-local calendar date of an instant (yyyy-mm-dd). */
export function shopDate(at: Date, tz: string): string {
  return DateTime.fromJSDate(at, { zone: tz }).toFormat('yyyy-MM-dd')
}

/** Whole shop-local calendar days from one instant's date to another's (0 on the same day). */
export function shopDaysBetween(from: Date, to: Date, tz: string): number {
  const a = DateTime.fromJSDate(from, { zone: tz }).startOf('day')
  const b = DateTime.fromJSDate(to, { zone: tz }).startOf('day')
  return Math.round(b.diff(a, 'days').days)
}

/**
 * The cycle a paid invoice pays for: from the shop-local midnight of its due date (the previous charged-through date, or the
 * subscription's start date for the first one) to the midnight of the subscription's charged_through_date when that is the next
 * billing date (after the start, at most a month and four days later: a month-end anchor moves by up to three days); else one
 * calendar month later (every variation Oasis makes is MONTHLY).
 */
export function paidPeriod(o: { dueDate: string | null; startDate: string | null; chargedThrough: string | null }, tz: string): { start: Date; end: Date } {
  const from = o.dueDate ?? o.startDate
  if (!from) throw new RangeError('a paid invoice needs its due date or the subscription start date')
  const start = DateTime.fromISO(from, { zone: tz }).startOf('day')
  const fallback = start.plus({ months: 1 })
  if (o.chargedThrough) {
    const ct = DateTime.fromISO(o.chargedThrough, { zone: tz }).startOf('day')
    if (ct.isValid && ct > start && ct <= fallback.plus({ days: 4 })) return { start: start.toJSDate(), end: ct.toJSDate() }
  }
  return { start: start.toJSDate(), end: fallback.toJSDate() }
}

/**
 * What a Square subscription status means for the membership: PAUSED is paused, CANCELED and DEACTIVATED are canceled, ACTIVE keeps
 * the membership as the billing made it (active, or past due during a failed renewal; a pending one waits for its first invoice to
 * be paid), PENDING (a start date in the future) changes nothing.
 */
export function statusFromSquare(square: string, current: MembershipStatus): MembershipStatus {
  switch (square) {
    case 'PAUSED':
      return current === 'canceled' ? current : 'paused'
    case 'CANCELED':
    case 'DEACTIVATED':
      return 'canceled'
    case 'ACTIVE':
      return current === 'paused' ? 'active' : current
    default:
      return current
  }
}

export interface ScheduledAtSquare {
  /** The shop-local date the subscription ends (Square's canceled_date or a CANCEL action). */
  cancelAt: string | null
  pauseAt: string | null
  /** A SWAP_PLAN action: the variation it moves to and when. */
  swap: { actionId: string; variationId: string; date: string | null } | null
}

/** Square's scheduled actions (RetrieveSubscription with include=actions) as dates. */
export function scheduledAtSquare(sub: Pick<WireSubscription, 'canceled_date' | 'status'> & { actions?: WireSubscriptionAction[] | null }): ScheduledAtSquare {
  const actions = sub.actions ?? []
  const cancel = actions.find((a) => a.type === 'CANCEL')
  const pause = actions.find((a) => a.type === 'PAUSE')
  const swap = actions.find((a) => a.type === 'SWAP_PLAN' && a.new_plan_variation_id)
  const live = sub.status === 'ACTIVE' || sub.status === 'PENDING' || sub.status === 'PAUSED'
  return {
    cancelAt: live ? (cancel?.effective_date ?? sub.canceled_date ?? null) : null,
    pauseAt: live && sub.status !== 'PAUSED' ? (pause?.effective_date ?? null) : null,
    swap: live && swap ? { actionId: swap.id, variationId: swap.new_plan_variation_id!, date: swap.effective_date ?? null } : null,
  }
}

export interface BillingPolicy {
  /** Days after a failed renewal when perks pause (past due). */
  graceDays: number
  /** Days after a failed renewal when the membership is canceled. */
  cancelDays: number
}

export const DEFAULT_BILLING_POLICY: BillingPolicy = { graceDays: 7, cancelDays: 21 }

export type FailureStage = 'grace' | 'past_due' | 'cancel'

/** Where a failed renewal stands on the shop's calendar: day 0 to graceDays-1 grace, from graceDays past due, from cancelDays canceled. */
export function failureStage(failedAt: Date, now: Date, tz: string, policy: BillingPolicy = DEFAULT_BILLING_POLICY): FailureStage {
  const day = shopDaysBetween(failedAt, now, tz)
  if (day >= policy.cancelDays) return 'cancel'
  if (day >= policy.graceDays) return 'past_due'
  return 'grace'
}

/** Domains reserved for examples and tests (RFC 2606, RFC 6761): Square cannot deliver to them, so the subscription would end. */
const RESERVED = /(^|\.)(example\.(com|net|org)|example|test|invalid|localhost|local)$/i
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

/** An email Square can bill to: a well-formed address on a real-looking domain (with a dot and a letter TLD), not a reserved one. */
export function deliverableEmail(raw: string): { ok: true; email: string } | { ok: false; message: string } {
  const email = raw.trim()
  if (email.length > 254 || !EMAIL.test(email) || email.includes('..')) return { ok: false, message: 'Enter a valid email.' }
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase()
  const tld = domain.slice(domain.lastIndexOf('.') + 1)
  if (!/^[a-z]{2,24}$/.test(tld) || RESERVED.test(domain))
    return { ok: false, message: 'Use an email you check: Square sends your membership receipts there.' }
  return { ok: true, email }
}
