export interface RetryConfig {
  baseMs: number
  factor: number
  maxMs: number
  /** Failed send attempts (network/5xx) before the message is marked failed. */
  maxAttempts: number
}

export const DEFAULT_RETRY: RetryConfig = { baseMs: 15_000, factor: 2, maxMs: 15 * 60_000, maxAttempts: 6 }

/** Delay before attempt number `attemptsSoFar + 1` (15 s, 30 s, 60 s, ... capped). */
export function backoffMs(attemptsSoFar: number, cfg: RetryConfig = DEFAULT_RETRY): number {
  return Math.min(cfg.maxMs, cfg.baseMs * cfg.factor ** Math.max(0, attemptsSoFar - 1))
}

/**
 * Device-reported failures that are worth one retry. Reasons are free text from the Android telephony stack
 * ("Generic failure", "Radio off", "No service", "Network error", "Timeout"), so this is a configurable pattern list.
 * Anything not matched (invalid number, null PDU, blocked) is permanent.
 */
export const DEFAULT_TRANSIENT_REASONS: readonly RegExp[] = [
  /network/i,
  /time ?out/i,
  /radio/i,
  /no service/i,
  /service (is )?(not|un)available/i,
  /generic failure/i,
  /unavailable/i,
  /try again/i,
  /busy/i,
]

export function isTransientReason(
  reason: string | undefined,
  patterns: readonly RegExp[] = DEFAULT_TRANSIENT_REASONS,
): boolean {
  return reason !== undefined && patterns.some((p) => p.test(reason))
}

/**
 * Id for a resend after the device reported a failure. The device keeps the failed message under its original id and
 * answers 409 to a repeat, so the retry needs its own id. The device caps ids at 36 characters, so a UUID loses its
 * hyphens (32 chars) and gains a short suffix.
 */
export function retryProviderId(originalId: string, retryNumber: number): string {
  const suffix = `r${retryNumber}`
  const stem = originalId.replace(/-/g, '')
  return `${stem.slice(0, 36 - suffix.length)}${suffix}`
}

/** The id for the next retry: r1 after the original, r2 after r1, so a repeat never collides with an earlier attempt. */
export function nextRetryProviderId(originalId: string, currentProviderId: string | null): string {
  const m = currentProviderId && currentProviderId !== originalId ? /r(\d+)$/.exec(currentProviderId) : null
  return retryProviderId(originalId, m ? Number(m[1]) + 1 : 1)
}
