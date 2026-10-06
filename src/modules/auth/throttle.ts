// Login throttling with a progressive delay, per client IP and per account (review D9: never hard-lock a known email for
// minutes, or anyone could lock the owner out). After a few free failures each further failure lengthens the wait before
// the next attempt is even evaluated: 1 s, 2 s, 4 s ... up to a short cap, so a victim is never blocked for longer than
// the cap while an attacker is held to a few guesses a minute. Attempts made during a wait do not extend it. Counters
// decay after a quiet period and reset for an account on success. State is per process (in memory), driven by the
// injected clock.
import type { Clock } from '../../platform/clock.js'

export interface ThrottleRule {
  /** Failures allowed before any delay applies. */
  free: number
  /** Cap on the wait, seconds. */
  maxDelaySec: number
  /** A quiet period after which the counter starts over, seconds. */
  decaySec: number
}

export interface ThrottleOptions {
  ip: ThrottleRule
  account: ThrottleRule
}

export const DEFAULT_THROTTLE: ThrottleOptions = {
  ip: { free: 10, maxDelaySec: 120, decaySec: 900 },
  account: { free: 4, maxDelaySec: 30, decaySec: 900 },
}

interface Entry {
  failures: number
  lastFailureAt: number
  blockedUntil: number
}

const MAX_ENTRIES = 20_000

export class LoginThrottle {
  private readonly ips = new Map<string, Entry>()
  private readonly accounts = new Map<string, Entry>()

  constructor(
    private readonly clock: Clock,
    private readonly opts: ThrottleOptions = DEFAULT_THROTTLE,
  ) {}

  /** Seconds the caller must wait before this attempt is evaluated; 0 = go ahead. */
  retryAfterSec(ip: string, account: string): number {
    const now = this.clock.now().getTime()
    const wait = Math.max(
      this.remaining(this.ips, ip, this.opts.ip, now),
      this.remaining(this.accounts, account, this.opts.account, now),
    )
    return wait > 0 ? Math.ceil(wait / 1000) : 0
  }

  failure(ip: string, account: string): void {
    const now = this.clock.now().getTime()
    this.bump(this.ips, ip, this.opts.ip, now)
    this.bump(this.accounts, account, this.opts.account, now)
  }

  /** Clears the account's counter; the IP counter is left to decay so a valid login cannot launder guesses. */
  success(account: string): void {
    this.accounts.delete(account)
  }

  reset(): void {
    this.ips.clear()
    this.accounts.clear()
  }

  private remaining(map: Map<string, Entry>, key: string, rule: ThrottleRule, now: number): number {
    const e = map.get(key)
    if (!e) return 0
    if (now - e.lastFailureAt > rule.decaySec * 1000) {
      map.delete(key)
      return 0
    }
    return e.blockedUntil - now
  }

  private bump(map: Map<string, Entry>, key: string, rule: ThrottleRule, now: number): void {
    if (map.size >= MAX_ENTRIES) this.prune(map, rule, now)
    const prev = map.get(key)
    const live = prev && now - prev.lastFailureAt <= rule.decaySec * 1000 ? prev : undefined
    const failures = (live?.failures ?? 0) + 1
    const over = failures - rule.free
    const delayMs = over > 0 ? Math.min(2 ** (over - 1), rule.maxDelaySec) * 1000 : 0
    map.set(key, { failures, lastFailureAt: now, blockedUntil: now + delayMs })
  }

  private prune(map: Map<string, Entry>, rule: ThrottleRule, now: number): void {
    for (const [k, e] of map) if (now - e.lastFailureAt > rule.decaySec * 1000) map.delete(k)
    if (map.size >= MAX_ENTRIES) map.clear()
  }
}
