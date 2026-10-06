// Quiet hours: a daily local-time window during which non-transactional SMS are held and released when it ends.

export interface QuietHoursConfig {
  enabled: boolean
  /** Minutes after local midnight. Default 21:00. */
  startMinute: number
  /** Minutes after local midnight. Default 08:00. */
  endMinute: number
  timeZone: string
}

export const DEFAULT_QUIET_HOURS: QuietHoursConfig = {
  enabled: true,
  startMinute: 21 * 60,
  endMinute: 8 * 60,
  timeZone: 'America/New_York',
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
    formatters.set(timeZone, f)
  }
  return f
}

/** Minutes after local midnight in the given zone. */
export function localMinuteOfDay(at: Date, timeZone: string): number {
  const parts = formatter(timeZone).formatToParts(at)
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
  return h * 60 + m
}

export function isQuietHour(at: Date, cfg: QuietHoursConfig): boolean {
  if (!cfg.enabled || cfg.startMinute === cfg.endMinute) return false
  const m = localMinuteOfDay(at, cfg.timeZone)
  return cfg.startMinute < cfg.endMinute ? m >= cfg.startMinute && m < cfg.endMinute : m >= cfg.startMinute || m < cfg.endMinute
}

/** The first instant at or after `at` that is outside quiet hours; `at` itself when it already is. */
export function quietHoursEnd(at: Date, cfg: QuietHoursConfig): Date {
  if (!isQuietHour(at, cfg)) return at
  const m = localMinuteOfDay(at, cfg.timeZone)
  const delta = (cfg.endMinute - m + 1440) % 1440
  const minuteStart = Math.floor(at.getTime() / 60_000) * 60_000
  let candidate = new Date(minuteStart + delta * 60_000)
  // Across a DST change the local clock moves by an hour; walk to the first minute that is no longer quiet.
  for (let i = 0; i < 4 && isQuietHour(candidate, cfg); i++) candidate = new Date(candidate.getTime() + 30 * 60_000)
  for (let i = 0; i < 120; i++) {
    const earlier = new Date(candidate.getTime() - 60_000)
    if (isQuietHour(earlier, cfg)) break
    candidate = earlier
  }
  return candidate
}
