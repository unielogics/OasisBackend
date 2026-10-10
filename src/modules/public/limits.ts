// Durable fixed-window counters for the public routes (ADR 0150): per phone number and per client address, shared by every API
// process through the public_rate_limits table (the in-memory per-route limit of src/http/rate-limit.ts is only the first ring
// and forgets on restart). One upsert per request; the window is `windowSec` wide and starts on a multiple of it, so two
// processes and two requests always agree on which row a request belongs to.
import { sql } from 'kysely'
import type { Clock } from '../../platform/clock.js'
import type { Executor } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import './problems.js'
import './schema.js'

export interface LimitRule {
  /** Requests allowed inside one window. */
  max: number
  windowSec: number
}

/**
 * The limits of each public action: per client address, per number from one address, and per number in all. The rules are
 * charged in that order and stop at the first refusal (enforceLimits), so an address over its limit never counts against the
 * numbers it names; and the per-number-per-address rule is smaller than the per-number rule over the same window, so no single
 * address can use up a number's allowance and lock its owner out (review 2026-10-10).
 */
export const PUBLIC_LIMITS = {
  otpRequest: { ip: { max: 10, windowSec: 600 }, phoneIp: { max: 3, windowSec: 600 }, phone: { max: 5, windowSec: 600 } },
  otpVerify: { ip: { max: 30, windowSec: 600 } },
  booking: { ip: { max: 10, windowSec: 3600 }, phoneIp: { max: 3, windowSec: 3600 }, phone: { max: 5, windowSec: 3600 } },
  membership: { ip: { max: 10, windowSec: 3600 }, phoneIp: { max: 2, windowSec: 86_400 }, phone: { max: 3, windowSec: 86_400 } },
} as const

export type PhoneLimitedAction = 'otpRequest' | 'booking' | 'membership'

const KEY_PREFIX: Record<PhoneLimitedAction, string> = { otpRequest: 'otp', booking: 'booking', membership: 'membership' }

/** The three checks of an action that names a number, in the order they are charged: the address, the number from it, the number. */
export function publicLimitChecks(action: PhoneLimitedAction, ip: string, phone: string): { key: string; rule: LimitRule }[] {
  const rules = PUBLIC_LIMITS[action]
  const p = KEY_PREFIX[action]
  return [
    { key: `${p}:ip:${ip}`, rule: rules.ip },
    { key: `${p}:phone_ip:${phone}:${ip}`, rule: rules.phoneIp },
    { key: `${p}:phone:${phone}`, rule: rules.phone },
  ]
}

export interface LimitOutcome {
  allowed: boolean
  count: number
  /** Seconds until the window turns over; meaningful when not allowed. */
  retryAfterSec: number
}

export const windowStart = (now: Date, windowSec: number): Date =>
  new Date(Math.floor(now.getTime() / (windowSec * 1000)) * windowSec * 1000)

/** Counts one request against `key` and says whether it fits the rule. */
export async function consume(db: Executor, clock: Clock, key: string, rule: LimitRule): Promise<LimitOutcome> {
  const now = clock.now()
  const start = windowStart(now, rule.windowSec)
  const r = await sql<{ count: number }>`
    insert into public_rate_limits (key, window_start, count) values (${key}, ${start}, 1)
    on conflict (key, window_start) do update set count = public_rate_limits.count + 1
    returning count`.execute(db)
  const count = Number(r.rows[0]?.count ?? 1)
  const retryAfterSec = Math.max(1, Math.ceil((start.getTime() + rule.windowSec * 1000 - now.getTime()) / 1000))
  return { allowed: count <= rule.max, count, retryAfterSec }
}

/**
 * Charges the keys in order and stops at the first one over its rule, throwing 429 PUBLIC_RATE_LIMITED with that rule's
 * Retry-After: the keys after it are not charged, so a request refused for its address costs the numbers it names nothing.
 */
export async function enforceLimits(
  db: Executor,
  clock: Clock,
  checks: readonly { key: string; rule: LimitRule }[],
): Promise<void> {
  for (const c of checks) {
    const r = await consume(db, clock, c.key, c.rule)
    if (r.allowed) continue
    throw new AppError('PUBLIC_RATE_LIMITED', {
      params: { minutes: Math.max(1, Math.ceil(r.retryAfterSec / 60)) },
      headers: { 'Retry-After': String(r.retryAfterSec) },
    })
  }
}

/** Windows that ended more than a day ago are of no use to any rule (the longest window is a day). */
export async function purgeRateLimits(db: Executor, clock: Clock): Promise<number> {
  const cutoff = new Date(clock.now().getTime() - 2 * 86_400_000)
  const r = await db.deleteFrom('public_rate_limits').where('window_start', '<', cutoff).executeTakeFirst()
  return Number(r.numDeletedRows)
}
