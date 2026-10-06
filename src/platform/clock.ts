// All "now" reads go through a Clock so tests, the parity backend and seeds can freeze or move time.
// The SQL twin is app_now() (reads a GUC); bare now()/Date.now() are banned by lint.
export interface Clock {
  now(): Date
}

export const systemClock: Clock = { now: () => new Date() }

export class FixedClock implements Clock {
  private t: number
  constructor(at: Date | string | number) {
    this.t = new Date(at).getTime()
  }
  now(): Date {
    return new Date(this.t)
  }
  advance(ms: number): void {
    this.t += ms
  }
  set(at: Date | string | number): void {
    this.t = new Date(at).getTime()
  }
}

/** Frozen clock for the design-parity environment: 2026-06-13 10:36 Eastern (-04:00). */
export const PARITY_NOW = '2026-06-13T10:36:00-04:00'
