// Cron arithmetic that matches what pg-boss really does. pg-boss does not compute "the next run"; every
// cronMonitorIntervalSeconds it asks cron-parser for the PREVIOUS fire time of each schedule and sends the job when that
// moment is less than 60 seconds old (node_modules/pg-boss/src/timekeeper.js, shouldSendIt). Around a DST change prev() and
// next() disagree, so the DST tests and the catalogue use the same rule:
//   spring forward  a time inside the skipped hour never fires that day (next() would say 03:30, prev() never reports it)
//   fall back       a time inside the repeated hour fires twice (once per occurrence)
// Daily jobs therefore stay out of 01:00-02:59 local time (see dstRiskyCron), and every job is idempotent anyway.
import cronParser from 'cron-parser'

export const CRON_FIRE_WINDOW_SECONDS = 60

export function assertValidCron(cron: string, tz: string): void {
  cronParser.parseExpression(cron, { tz })
}

/** The next nominal fire time strictly after `after` (what the status endpoint shows). */
export function nextCronRun(cron: string, tz: string, after: Date): Date {
  return cronParser.parseExpression(cron, { tz, currentDate: after }).next().toDate()
}

/** pg-boss' check, for one evaluation instant. */
export function wouldFire(cron: string, tz: string, evaluatedAt: Date): boolean {
  const prev = cronParser.parseExpression(cron, { tz, currentDate: evaluatedAt }).prev().getTime()
  return (evaluatedAt.getTime() - prev) / 1000 < CRON_FIRE_WINDOW_SECONDS
}

/**
 * Every moment in [from, to) at which pg-boss would send the job. pg-boss sends when prev() reports a time less than a minute
 * old, so the fire times are exactly the times prev() can return: they are collected by walking prev() back from `to`.
 */
export function cronFires(cron: string, tz: string, from: Date, to: Date): Date[] {
  const it = cronParser.parseExpression(cron, { tz, currentDate: to })
  const out: Date[] = []
  for (;;) {
    let t: Date
    try {
      t = it.prev().toDate()
    } catch {
      break
    }
    if (t.getTime() < from.getTime()) break
    out.push(t)
  }
  return out.reverse()
}

/**
 * The same answer by brute force: evaluate pg-boss' check 5 seconds into every minute of the window. Slow (a cron-parser
 * call per minute); the tests use it on short windows to prove cronFires agrees with the literal rule.
 */
export function cronFiresExhaustive(cron: string, tz: string, from: Date, to: Date): Date[] {
  const out: Date[] = []
  const first = Math.ceil(from.getTime() / 60_000) * 60_000
  for (let t = first; t < to.getTime(); t += 60_000)
    if (wouldFire(cron, tz, new Date(t + 5_000))) out.push(new Date(t))
  return out
}

/** True when the schedule can fire at a fixed local time inside the hours a DST change skips or repeats (01:00-02:59). */
export function dstRiskyCron(cron: string): boolean {
  const [minute, hour] = cron.trim().split(/\s+/)
  if (minute === undefined || hour === undefined) return false
  if (hour === '*' || hour.startsWith('*/')) return false
  return hour
    .split(',')
    .flatMap((part) => {
      const [range, step] = part.split('/')
      const [a, b] = (range ?? '').split('-')
      if (a === undefined || a === '*') return []
      const lo = Number(a)
      const hi = b === undefined ? lo : Number(b)
      const stepN = step === undefined ? 1 : Number(step)
      const hours: number[] = []
      for (let h = lo; h <= hi; h += stepN) hours.push(h)
      return hours
    })
    .some((h) => h === 1 || h === 2)
}
