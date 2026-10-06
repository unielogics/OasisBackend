// federal_holidays.generate: adds the federal holidays of the current and next year as closed days.
// Runs on Jan 1, at startup (catch-up) and whenever it is enqueued; the enable action in the API generates inline in its
// own transaction. Idempotent: the unique (location, federal key, year) row means a holiday is never added twice, and a
// removed one is never added back; a year with a federal_holiday_runs row is skipped in catch-up mode.
import type { Clock } from '../../../platform/clock.js'
import type { Db } from '../../../platform/db.js'
import { createIdGenerator, type NewId } from '../../../platform/ids.js'
import type { JobDefinition } from '../../../platform/jobs.js'
import { toBizDate } from '../../../platform/time.js'
import { generateFederalHolidays, type GenerateFederalResult } from '../federal-holidays.js'
import { listLocations } from './locations.js'
import { FEDERAL_HOLIDAYS_JOB } from './names.js'

export interface FederalJobData {
  /** One location; all locations when omitted. */
  locationId?: string
  /** Years to generate; the current and the next business year when omitted. */
  years?: number[]
  /** Leave years that already ran alone (default true; false re-checks them, still without duplicating anything). */
  catchUp?: boolean
}

export interface FederalJobResult {
  locationId: string
  created: number
  years: number[]
  skippedDisabled: boolean
}

export async function runFederalHolidayJob(
  d: { db: Db; clock: Clock; newId?: NewId },
  data: FederalJobData = {},
): Promise<FederalJobResult[]> {
  const newId = d.newId ?? createIdGenerator(d.clock)
  const out: FederalJobResult[] = []
  for (const loc of await listLocations(d.db, data.locationId)) {
    const today = toBizDate(d.clock.now(), loc.timezone)
    const year = Number(today.slice(0, 4))
    const years = data.years ?? [year, year + 1]
    const r: GenerateFederalResult = await d.db.transaction().execute((tx) =>
      generateFederalHolidays(tx, {
        locationId: loc.id,
        years,
        today,
        tz: loc.timezone,
        newId,
        catchUp: data.catchUp ?? true,
      }),
    )
    out.push({ locationId: loc.id, created: r.created.length, years, skippedDisabled: r.skippedDisabled })
  }
  return out
}

export const federalHolidaysJob: JobDefinition<FederalJobData> = {
  name: FEDERAL_HOLIDAYS_JOB,
  cron: '5 0 1 1 *',
  policy: 'short',
  async handler(ctx, data) {
    const results = await runFederalHolidayJob(ctx, data ?? {})
    ctx.logger.info({ results }, 'federal_holidays.generate done')
  },
}
