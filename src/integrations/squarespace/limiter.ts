import type { Clock } from '../../platform/clock.js'
import type { Sleeper } from './sleeper.js'

/**
 * Documented limit: 300 requests per minute per site, 429 with a one-minute cool down.
 * The default budget stays well below that so a nightly reconcile cannot starve staff-triggered syncs.
 */
export const DOCUMENTED_LIMIT_PER_MINUTE = 300
export const DEFAULT_BUDGET_PER_MINUTE = 240
export const DEFAULT_COOLDOWN_MS = 60_000

export interface RequestLimiter {
  /** Resolves when one more request may be sent. */
  acquire(): Promise<void>
  /** A 429 (or Retry-After) was seen: hold every caller for at least this long. */
  cooldown(ms: number): void
  readonly acquired: number
}

/** Sliding-window limiter over an injected clock and sleeper. */
export class SlidingWindowLimiter implements RequestLimiter {
  private stamps: number[] = []
  private cooldownUntil = 0
  acquired = 0

  constructor(
    private readonly clock: Clock,
    private readonly sleeper: Sleeper,
    private readonly maxPerWindow = DEFAULT_BUDGET_PER_MINUTE,
    private readonly windowMs = 60_000,
  ) {
    if (maxPerWindow < 1) throw new Error('maxPerWindow must be >= 1')
  }

  cooldown(ms: number): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, this.clock.now().getTime() + ms)
  }

  async acquire(): Promise<void> {
    for (;;) {
      const now = this.clock.now().getTime()
      if (this.cooldownUntil > now) {
        await this.sleeper.sleep(this.cooldownUntil - now)
        continue
      }
      this.stamps = this.stamps.filter((t) => t > now - this.windowMs)
      const oldest = this.stamps[0]
      if (this.stamps.length >= this.maxPerWindow && oldest !== undefined) {
        await this.sleeper.sleep(oldest + this.windowMs - now)
        continue
      }
      this.stamps.push(now)
      this.acquired++
      return
    }
  }
}

/** Parse a Retry-After header: delta-seconds or an HTTP date. Returns milliseconds, or undefined. */
export function parseRetryAfter(value: string | null | undefined, now: Date): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000)
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - now.getTime())
}
