// All "now" reads go through a Clock so tests, the parity backend and seeds can freeze or move time.
// The SQL twin is app_now() (reads the oasis.now GUC); bare now()/Date.now() are banned by lint.
export interface Clock {
  now(): Date
  /** True when the clock is not the wall clock; the database layer then mirrors it into the oasis.now GUC. */
  readonly synthetic?: boolean
}

export const systemClock: Clock = { now: () => new Date() }

export class FixedClock implements Clock {
  readonly synthetic = true
  private t: number
  constructor(at: Date | string | number) {
    this.t = FixedClock.parse(at)
  }
  private static parse(at: Date | string | number): number {
    const t = new Date(at).getTime()
    if (Number.isNaN(t)) throw new Error(`Invalid clock instant: ${String(at)}`)
    return t
  }
  now(): Date {
    return new Date(this.t)
  }
  advance(ms: number): void {
    this.t += ms
  }
  set(at: Date | string | number): void {
    this.t = FixedClock.parse(at)
  }
}

/** Frozen clock for the design-parity environment: 2026-06-13 10:36 Eastern (-04:00). */
export const PARITY_NOW = '2026-06-13T10:36:00-04:00'

/** CLOCK_FREEZE_AT (already refused in production by the env schema) selects a frozen clock; otherwise the wall clock. */
export function createClock(freezeAt?: string | null): Clock {
  return freezeAt ? new FixedClock(freezeAt) : systemClock
}
