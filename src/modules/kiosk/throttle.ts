// The kiosk unlock throttle (ADR 0180 and its 2026-10-14 amendment). It departs from ADR 0008's no-lockout rule on purpose: a guess
// needs physical presence on the shop's internet connection, the PIN is the only factor, and nobody can lock the owner out of their
// own email/password sign-in with it.
//   - Per browser (the device cookie, when the browser has one), persisted in kiosk_devices: 3 free wrong PINs, then 2, 4, 8 ...
//     seconds up to 5 minutes before the next PIN is even evaluated; 20 in a row lock that browser out until a manager clears it.
//   - Per shop address (the kiosk_networks row the caller matched), persisted: every browser at the shop shares it, so it is a little
//     more lenient: 5 free, the same doubling wait, 30 in a row lock the address out until a manager clears it. A success resets both.
//   - Across every browser, in memory: more than 60 wrong PINs in an hour adds a 30 s wait for everyone and raises one alert an hour.
//   - PINs tried from an unknown network are never evaluated; their rows (the refused list) are written at most once a minute per
//     address, the tries in between counted in memory and added with the next write.
import type { Clock } from '../../platform/clock.js'

export interface KioskThrottleRule {
  free: number
  lockout: number
}

export const KIOSK_MAX_DELAY_SEC = 300
/** Per browser. */
export const KIOSK_BROWSER_RULE: KioskThrottleRule = { free: 3, lockout: 20 }
/** Per shop address. */
export const KIOSK_ADDRESS_RULE: KioskThrottleRule = { free: 5, lockout: 30 }
export const KIOSK_FREE_FAILURES = KIOSK_BROWSER_RULE.free
export const KIOSK_LOCKOUT_FAILURES = KIOSK_BROWSER_RULE.lockout
export const KIOSK_GLOBAL_FAILURES_PER_HOUR = 60
export const KIOSK_GLOBAL_DELAY_SEC = 30
/** A refused address's row is written at most this often. */
export const KIOSK_REFUSED_WRITE_MS = 60 * 1000
const REFUSED_MEMORY = 2000

/** Seconds to wait after `failures` consecutive wrong PINs before the next one is evaluated. */
export function kioskDelaySec(failures: number, rule: KioskThrottleRule = KIOSK_BROWSER_RULE): number {
  const over = failures - rule.free
  return over > 0 ? Math.min(2 ** over, KIOSK_MAX_DELAY_SEC) : 0
}

/** What is left of a counter's wait, in whole seconds (0 = evaluate the PIN). */
export function retryAfterSec(
  c: { failedAttempts: number; lastFailedAt: Date | null },
  now: Date,
  rule: KioskThrottleRule = KIOSK_BROWSER_RULE,
): number {
  if (!c.lastFailedAt) return 0
  const until = c.lastFailedAt.getTime() + kioskDelaySec(c.failedAttempts, rule) * 1000
  const left = until - now.getTime()
  return left > 0 ? Math.ceil(left / 1000) : 0
}

/** The browser's wait (the per-browser rule). */
export const deviceRetryAfterSec = (d: { failedAttempts: number; lastFailedAt: Date | null }, now: Date): number =>
  retryAfterSec(d, now, KIOSK_BROWSER_RULE)

const HOUR_MS = 60 * 60 * 1000

/** The in-memory parts: the global ceiling and the refused-list write limit. */
export class KioskUnlockGuard {
  private failures: number[] = []
  private globalUntil = 0
  private alertedAt = -Infinity
  private refused = new Map<string, { writtenAt: number; pending: number }>()

  constructor(private readonly clock: Clock) {}

  /** Seconds before any PIN is evaluated (the global wait). */
  globalRetryAfterSec(): number {
    const now = this.clock.now().getTime()
    return this.globalUntil > now ? Math.ceil((this.globalUntil - now) / 1000) : 0
  }

  /** Records a wrong PIN; `alert` is true the first time in an hour that the global ceiling is crossed. */
  failure(): { alert: boolean } {
    const now = this.clock.now().getTime()
    this.failures = this.failures.filter((t) => now - t < HOUR_MS)
    this.failures.push(now)
    if (this.failures.length <= KIOSK_GLOBAL_FAILURES_PER_HOUR) return { alert: false }
    this.globalUntil = now + KIOSK_GLOBAL_DELAY_SEC * 1000
    const alert = now - this.alertedAt >= HOUR_MS
    if (alert) this.alertedAt = now
    return { alert }
  }

  /**
   * A PIN tried from `network` (not a shop network): how many tries to add to its refused row now, or 0 to write nothing (its row was
   * written less than a minute ago; the try is counted and added with the next write).
   */
  refusedTry(network: string): number {
    const now = this.clock.now().getTime()
    const e = this.refused.get(network)
    if (e && now - e.writtenAt < KIOSK_REFUSED_WRITE_MS) {
      e.pending++
      return 0
    }
    const add = (e?.pending ?? 0) + 1
    this.refused.delete(network)
    this.refused.set(network, { writtenAt: now, pending: 0 })
    if (this.refused.size > REFUSED_MEMORY) {
      for (const [k, v] of this.refused) if (now - v.writtenAt >= KIOSK_REFUSED_WRITE_MS) this.refused.delete(k)
      // still full of fresh entries (a flood of addresses): forget the oldest; at worst a try is written again
      for (const k of this.refused.keys()) {
        if (this.refused.size <= REFUSED_MEMORY) break
        this.refused.delete(k)
      }
    }
    return add
  }

  reset(): void {
    this.failures = []
    this.globalUntil = 0
    this.alertedAt = -Infinity
    this.refused.clear()
  }
}
