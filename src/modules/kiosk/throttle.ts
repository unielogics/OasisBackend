// The kiosk unlock throttle (ADR 0180). It departs from ADR 0008's no-lockout rule on purpose: a guess needs physical presence at a
// registered tablet (its HttpOnly device cookie), the code is the only factor, and nobody can lock the owner out of their own
// email/password sign-in with it.
//   - Per device, persisted in kiosk_devices (survives a restart): 3 free failures, then 2, 4, 8 ... seconds up to 5 minutes before the
//     next code is even evaluated; 20 consecutive failures lock the device out until a manager clears it. A success resets it.
//   - Per client address, in memory: the sign-in throttle's rule (10 free failures, up to 120 s), so one address cannot spray devices.
//   - Across every device, in memory: more than 60 failures in an hour adds a 30 s wait for everyone and raises one alert an hour.
import type { Clock } from '../../platform/clock.js'
import { LoginThrottle } from '../auth/throttle.js'

export const KIOSK_FREE_FAILURES = 3
export const KIOSK_MAX_DELAY_SEC = 300
export const KIOSK_LOCKOUT_FAILURES = 20
export const KIOSK_GLOBAL_FAILURES_PER_HOUR = 60
export const KIOSK_GLOBAL_DELAY_SEC = 30

/** Seconds to wait after `failures` consecutive wrong codes before the next one is evaluated. */
export function kioskDelaySec(failures: number): number {
  const over = failures - KIOSK_FREE_FAILURES
  return over > 0 ? Math.min(2 ** over, KIOSK_MAX_DELAY_SEC) : 0
}

/** What is left of the device's wait, in whole seconds (0 = evaluate the code). */
export function deviceRetryAfterSec(d: { failedAttempts: number; lastFailedAt: Date | null }, now: Date): number {
  if (!d.lastFailedAt) return 0
  const until = d.lastFailedAt.getTime() + kioskDelaySec(d.failedAttempts) * 1000
  const left = until - now.getTime()
  return left > 0 ? Math.ceil(left / 1000) : 0
}

const HOUR_MS = 60 * 60 * 1000

/** The in-memory per-address and global parts. */
export class KioskUnlockGuard {
  private readonly ips: LoginThrottle
  private failures: number[] = []
  private globalUntil = 0
  private alertedAt = -Infinity

  constructor(private readonly clock: Clock) {
    this.ips = new LoginThrottle(clock, {
      ip: { free: 10, maxDelaySec: 120, decaySec: 900 },
      // the device part is persisted (above); this side of the sign-in throttle is never used
      account: { free: Number.MAX_SAFE_INTEGER, maxDelaySec: 0, decaySec: 1 },
    })
  }

  /** Seconds before an attempt from `ip` is evaluated: the address's wait or the global one. */
  retryAfterSec(ip: string): number {
    const now = this.clock.now().getTime()
    const global = this.globalUntil > now ? Math.ceil((this.globalUntil - now) / 1000) : 0
    return Math.max(this.ips.retryAfterSec(ip, 'kiosk'), global)
  }

  /** Records a wrong code; `alert` is true the first time in an hour that the global ceiling is crossed. */
  failure(ip: string): { alert: boolean } {
    const now = this.clock.now().getTime()
    this.ips.failure(ip, 'kiosk')
    this.failures = this.failures.filter((t) => now - t < HOUR_MS)
    this.failures.push(now)
    if (this.failures.length <= KIOSK_GLOBAL_FAILURES_PER_HOUR) return { alert: false }
    this.globalUntil = now + KIOSK_GLOBAL_DELAY_SEC * 1000
    const alert = now - this.alertedAt >= HOUR_MS
    if (alert) this.alertedAt = now
    return { alert }
  }

  reset(): void {
    this.ips.reset()
    this.failures = []
    this.globalUntil = 0
    this.alertedAt = -Infinity
  }
}
