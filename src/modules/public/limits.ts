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

/** The limits of each public action, per phone (where one is known) and per client address. */
export const PUBLIC_LIMITS = {
  otpRequest: { phone: { max: 3, windowSec: 600 }, ip: { max: 10, windowSec: 600 } },
  otpVerify: { ip: { max: 30, windowSec: 600 } },
  booking: { phone: { max: 5, windowSec: 3600 }, ip: { max: 10, windowSec: 3600 } },
  membership: { phone: { max: 3, windowSec: 86_400 }, ip: { max: 10, windowSec: 3600 } },
} as const

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

/** Charges every given key; throws 429 PUBLIC_RATE_LIMITED (with Retry-After) when any of them is over its rule. */
export async function enforceLimits(
  db: Executor,
  clock: Clock,
  checks: readonly { key: string; rule: LimitRule }[],
): Promise<void> {
  let worst: LimitOutcome | null = null
  for (const c of checks) {
    const r = await consume(db, clock, c.key, c.rule)
    if (!r.allowed && (!worst || r.retryAfterSec > worst.retryAfterSec)) worst = r
  }
  if (worst) {
    const retry = String(worst.retryAfterSec)
    throw new AppError('PUBLIC_RATE_LIMITED', {
      params: { minutes: Math.max(1, Math.ceil(worst.retryAfterSec / 60)) },
      headers: { 'Retry-After': retry },
    })
  }
}

/** Windows that ended more than a day ago are of no use to any rule (the longest window is a day). */
export async function purgeRateLimits(db: Executor, clock: Clock): Promise<number> {
  const cutoff = new Date(clock.now().getTime() - 2 * 86_400_000)
  const r = await db.deleteFrom('public_rate_limits').where('window_start', '<', cutoff).executeTakeFirst()
  return Number(r.numDeletedRows)
}
