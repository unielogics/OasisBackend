import type { FixedClock } from '../../platform/clock.js'

/** Waiting is injected so tests (and the budget limiter) never really sleep. */
export interface Sleeper {
  sleep(ms: number): Promise<void>
}

export const systemSleeper: Sleeper = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
}

/** Records requested sleeps and advances a FixedClock instead of waiting. */
export class FakeSleeper implements Sleeper {
  readonly sleeps: number[] = []
  constructor(private readonly clock: FixedClock) {}
  async sleep(ms: number): Promise<void> {
    const wait = Math.max(0, ms)
    this.sleeps.push(wait)
    this.clock.advance(wait)
  }
  get totalSleptMs(): number {
    return this.sleeps.reduce((a, b) => a + b, 0)
  }
}
