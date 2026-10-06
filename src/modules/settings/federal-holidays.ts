// US federal holidays: a pure year -> dated holidays generator and the idempotent service that adds them as closures.
// Dates are the actual dates with no weekend "observed" shift (the design's Jul 4 stays on a Saturday). The default set
// is the five holidays in the design's seed; the other six federal holidays can be enabled by key.
import type { Tx } from '../../platform/db.js'
import * as audit from '../../platform/audit.js'
import type { NewId } from '../../platform/ids.js'
import { getSetting } from '../../platform/settings.js'
import { createClosure } from './closures.js'
import './schema.js'

export type FederalHolidayKey =
  | 'new_years_day'
  | 'mlk_day'
  | 'washingtons_birthday'
  | 'memorial_day'
  | 'juneteenth'
  | 'independence_day'
  | 'labor_day'
  | 'columbus_day'
  | 'veterans_day'
  | 'thanksgiving'
  | 'christmas'

export interface DatedHoliday {
  key: FederalHolidayKey
  name: string
  /** YYYY-MM-DD */
  date: string
}

type Rule =
  | { fixed: { month: number; day: number } }
  | { nth: { month: number; weekday: number; n: number } }
  | { last: { month: number; weekday: number } }

const HOLIDAYS: Record<FederalHolidayKey, { name: string; rule: Rule }> = {
  new_years_day: { name: "New Year's Day", rule: { fixed: { month: 1, day: 1 } } },
  mlk_day: { name: 'Martin Luther King Jr. Day', rule: { nth: { month: 1, weekday: 1, n: 3 } } },
  washingtons_birthday: { name: "Washington's Birthday", rule: { nth: { month: 2, weekday: 1, n: 3 } } },
  memorial_day: { name: 'Memorial Day', rule: { last: { month: 5, weekday: 1 } } },
  juneteenth: { name: 'Juneteenth', rule: { fixed: { month: 6, day: 19 } } },
  independence_day: { name: 'Independence Day', rule: { fixed: { month: 7, day: 4 } } },
  labor_day: { name: 'Labor Day', rule: { nth: { month: 9, weekday: 1, n: 1 } } },
  columbus_day: { name: 'Columbus Day', rule: { nth: { month: 10, weekday: 1, n: 2 } } },
  veterans_day: { name: 'Veterans Day', rule: { fixed: { month: 11, day: 11 } } },
  thanksgiving: { name: 'Thanksgiving', rule: { nth: { month: 11, weekday: 4, n: 4 } } },
  christmas: { name: 'Christmas Day', rule: { fixed: { month: 12, day: 25 } } },
}

export const ALL_FEDERAL_KEYS = Object.keys(HOLIDAYS) as FederalHolidayKey[]
/** The five holidays in the design's seed. */
export const DEFAULT_FEDERAL_KEYS: readonly FederalHolidayKey[] = [
  'memorial_day',
  'independence_day',
  'labor_day',
  'thanksgiving',
  'christmas',
]

const pad = (n: number): string => String(n).padStart(2, '0')

function dateFor(year: number, rule: Rule): string {
  if ('fixed' in rule) return `${year}-${pad(rule.fixed.month)}-${pad(rule.fixed.day)}`
  if ('nth' in rule) {
    const { month, weekday, n } = rule.nth
    const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
    const day = 1 + ((weekday - firstDow + 7) % 7) + (n - 1) * 7
    return `${year}-${pad(month)}-${pad(day)}`
  }
  const { month, weekday } = rule.last
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const lastDow = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay()
  return `${year}-${pad(month)}-${pad(lastDay - ((lastDow - weekday + 7) % 7))}`
}

export const federalHolidayName = (key: FederalHolidayKey): string => HOLIDAYS[key].name

/** Pure: the dated holidays of one year, in date order. */
export function federalHolidays(
  year: number,
  keys: readonly FederalHolidayKey[] = DEFAULT_FEDERAL_KEYS,
): DatedHoliday[] {
  if (!Number.isInteger(year) || year < 1970 || year > 2200) throw new RangeError(`Invalid year: ${year}`)
  return keys
    .map((key) => ({ key, name: HOLIDAYS[key].name, date: dateFor(year, HOLIDAYS[key].rule) }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

export interface GenerateFederalInput {
  locationId: string
  years: readonly number[]
  /** Today's business date: earlier holidays are never generated. */
  today: string
  tz: string
  newId: NewId
  keys?: readonly FederalHolidayKey[]
  /** Generated closures default to notify = false so adding the holidays never messages anyone (B24). */
  notify?: boolean
  /** Generate even when the federal_holidays.auto setting is off (the explicit "enable" action runs it right away). */
  ignoreToggle?: boolean
  /** Startup and January catch-up: leave years that already have a federal_holiday_runs row alone. */
  catchUp?: boolean
  audit?: audit.AuditContext
}

export interface GenerateFederalResult {
  skippedDisabled: boolean
  created: { year: number; key: FederalHolidayKey; date: string; closureId: string }[]
  skipped: {
    year: number
    key: FederalHolidayKey
    date: string
    reason: 'past' | 'already_generated' | 'closure_exists'
  }[]
  /** Years left alone because catch-up mode found a recorded run. */
  skippedYears: number[]
}

/**
 * Inserts the missing holidays of the given years as closed days (source federal) and records the run. Skips past dates,
 * a holiday whose federal key was ever generated for that year (even if the closure was removed), and a holiday that
 * already has a live closure that year, by date or by name (so the design's hand-entered closures are not doubled).
 */
export async function generateFederalHolidays(
  tx: Tx,
  input: GenerateFederalInput,
): Promise<GenerateFederalResult> {
  const result: GenerateFederalResult = { skippedDisabled: false, created: [], skipped: [], skippedYears: [] }
  if (!input.ignoreToggle && !(await getSetting(tx, input.locationId, 'federal_holidays.auto')).value) {
    result.skippedDisabled = true
    return result
  }
  const ran = input.catchUp ? new Set(await federalRunYears(tx, input.locationId)) : new Set<number>()
  for (const year of [...new Set(input.years)].sort((a, b) => a - b)) {
    if (ran.has(year)) {
      result.skippedYears.push(year)
      continue
    }
    for (const h of federalHolidays(year, input.keys)) {
      const skip = (reason: GenerateFederalResult['skipped'][number]['reason']) =>
        result.skipped.push({ year, key: h.key, date: h.date, reason })
      if (h.date < input.today) {
        skip('past')
        continue
      }
      const keyed = await tx
        .selectFrom('closures')
        .select('id')
        .where('location_id', '=', input.locationId)
        .where('federal_key', '=', h.key)
        .where('federal_year', '=', year)
        .executeTakeFirst()
      if (keyed) {
        skip('already_generated')
        continue
      }
      const clash = await tx
        .selectFrom('closures')
        .select('id')
        .where('location_id', '=', input.locationId)
        .where('deleted_at', 'is', null)
        .where((eb) =>
          eb.or([
            eb('date', '=', h.date),
            eb.and([
              eb('date', '>=', `${year}-01-01`),
              eb('date', '<=', `${year}-12-31`),
              eb(eb.fn('lower', ['name']), '=', h.name.toLowerCase()),
            ]),
          ]),
        )
        .executeTakeFirst()
      if (clash) {
        skip('closure_exists')
        continue
      }
      const { closure } = await createClosure(tx, {
        locationId: input.locationId,
        date: h.date,
        name: h.name,
        type: 'closed',
        notify: input.notify ?? false,
        source: 'federal',
        federalKey: h.key,
        federalYear: year,
        tz: input.tz,
        newId: input.newId,
        audit: input.audit,
      })
      result.created.push({ year, key: h.key, date: h.date, closureId: closure.id })
    }
    await tx
      .insertInto('federal_holiday_runs')
      .values({ location_id: input.locationId, year })
      .onConflict((oc) =>
        oc.columns(['location_id', 'year']).doUpdateSet((eb) => ({ ran_at: eb.fn('app_now', []) })),
      )
      .execute()
  }
  return result
}

export async function federalRunYears(tx: Tx, locationId: string): Promise<number[]> {
  const rows = await tx
    .selectFrom('federal_holiday_runs')
    .select('year')
    .where('location_id', '=', locationId)
    .orderBy('year')
    .execute()
  return rows.map((r) => r.year)
}
