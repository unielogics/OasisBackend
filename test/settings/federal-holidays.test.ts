import { describe, expect, it } from 'vitest'
import { transaction } from '../../src/platform/db.js'
import {
  ALL_FEDERAL_KEYS,
  DEFAULT_FEDERAL_KEYS,
  federalHolidayName,
  federalHolidays,
  federalRunYears,
  generateFederalHolidays,
} from '../../src/modules/settings/federal-holidays.js'
import { updateSetting } from '../../src/platform/settings.js'
import { useTestDb } from '../helpers/db.js'
import { setupLocation } from '../domain-schema/helpers.js'

const t = useTestDb()

// Computed independently (Python calendar), not with the generator under test.
const GOLDEN: Record<number, [string, string][]> = {
  2026: [
    ['Memorial Day', '2026-05-25'],
    ['Independence Day', '2026-07-04'],
    ['Labor Day', '2026-09-07'],
    ['Thanksgiving', '2026-11-26'],
    ['Christmas Day', '2026-12-25'],
  ],
  2027: [
    ['Memorial Day', '2027-05-31'],
    ['Independence Day', '2027-07-04'],
    ['Labor Day', '2027-09-06'],
    ['Thanksgiving', '2027-11-25'],
    ['Christmas Day', '2027-12-25'],
  ],
  2028: [
    ['Memorial Day', '2028-05-29'],
    ['Independence Day', '2028-07-04'],
    ['Labor Day', '2028-09-04'],
    ['Thanksgiving', '2028-11-23'],
    ['Christmas Day', '2028-12-25'],
  ],
}

describe('federalHolidays (pure)', () => {
  for (const year of [2026, 2027, 2028]) {
    it(`generates the five default holidays for ${year} on their actual dates`, () => {
      expect(federalHolidays(year).map((h) => [h.name, h.date])).toEqual(GOLDEN[year])
    })
  }

  it('does not shift weekend holidays to an observed date (Jul 4, 2026 is a Saturday, 2027 a Sunday)', () => {
    expect(federalHolidays(2026).find((h) => h.key === 'independence_day')!.date).toBe('2026-07-04')
    expect(federalHolidays(2027).find((h) => h.key === 'independence_day')!.date).toBe('2027-07-04')
    expect(federalHolidays(2027).find((h) => h.key === 'christmas')!.date).toBe('2027-12-25')
  })

  it('computes the six other federal holidays when asked for them', () => {
    const all = federalHolidays(2026, ALL_FEDERAL_KEYS)
    expect(all.map((h) => [h.key, h.date])).toEqual([
      ['new_years_day', '2026-01-01'],
      ['mlk_day', '2026-01-19'],
      ['washingtons_birthday', '2026-02-16'],
      ['memorial_day', '2026-05-25'],
      ['juneteenth', '2026-06-19'],
      ['independence_day', '2026-07-04'],
      ['labor_day', '2026-09-07'],
      ['columbus_day', '2026-10-12'],
      ['veterans_day', '2026-11-11'],
      ['thanksgiving', '2026-11-26'],
      ['christmas', '2026-12-25'],
    ])
    expect(
      federalHolidays(2028, ['mlk_day', 'washingtons_birthday', 'columbus_day']).map((h) => h.date),
    ).toEqual(['2028-01-17', '2028-02-21', '2028-10-09'])
  })

  it('returns holidays in date order whatever the key order, and the default set is the design five', () => {
    expect(federalHolidays(2026, ['christmas', 'memorial_day']).map((h) => h.key)).toEqual([
      'memorial_day',
      'christmas',
    ])
    expect([...DEFAULT_FEDERAL_KEYS]).toEqual([
      'memorial_day',
      'independence_day',
      'labor_day',
      'thanksgiving',
      'christmas',
    ])
    expect(federalHolidayName('thanksgiving')).toBe('Thanksgiving')
  })

  it('rejects a nonsensical year', () => {
    expect(() => federalHolidays(1800)).toThrow(RangeError)
    expect(() => federalHolidays(2026.5)).toThrow(RangeError)
  })
})

describe('generateFederalHolidays', () => {
  const run = (
    f: Awaited<ReturnType<typeof setupLocation>>,
    o: Partial<Parameters<typeof generateFederalHolidays>[1]> = {},
  ) =>
    transaction(t.db, (tx) =>
      generateFederalHolidays(tx, {
        locationId: f.locationId,
        years: [2026],
        today: '2026-01-02',
        tz: 'America/New_York',
        newId: f.newId,
        ...o,
      }),
    )

  it('adds the five holidays as closed days that do not notify, and records the run', async () => {
    const f = await setupLocation(t)
    const r = await run(f, { years: [2026, 2027] })
    expect(r.created).toHaveLength(10)
    const rows = await t.db
      .selectFrom('closures')
      .selectAll()
      .where('location_id', '=', f.locationId)
      .orderBy('date')
      .execute()
    expect(rows.map((x) => [x.date, x.name])).toEqual(
      [...GOLDEN[2026]!, ...GOLDEN[2027]!].map(([n, d]) => [d, n]),
    )
    expect(rows.every((x) => x.type === 'closed' && x.notify === false && x.source === 'federal')).toBe(true)
    expect(rows.slice(0, 2).map((x) => [x.federal_key, x.federal_year])).toEqual([
      ['memorial_day', 2026],
      ['independence_day', 2026],
    ])
    expect(await transaction(t.db, (tx) => federalRunYears(tx, f.locationId))).toEqual([2026, 2027])
  })

  it('skips holidays whose date has passed', async () => {
    const f = await setupLocation(t)
    const r = await run(f, { today: '2026-07-04' })
    expect(r.created.map((c) => c.key)).toEqual([
      'independence_day',
      'labor_day',
      'thanksgiving',
      'christmas',
    ])
    expect(r.skipped).toEqual([{ year: 2026, key: 'memorial_day', date: '2026-05-25', reason: 'past' }])
  })

  it('is idempotent: a second run creates nothing', async () => {
    const f = await setupLocation(t)
    await run(f)
    const again = await run(f)
    expect(again.created).toEqual([])
    expect(again.skipped.map((s) => s.reason)).toEqual(Array(5).fill('already_generated'))
    expect(await t.db.selectFrom('closures').select('id').execute()).toHaveLength(5)
  })

  it('does not regenerate a holiday that was removed', async () => {
    const f = await setupLocation(t)
    await run(f)
    await t.db
      .updateTable('closures')
      .set({ deleted_at: new Date('2026-06-01T00:00:00Z') })
      .where('federal_key', '=', 'labor_day')
      .execute()
    const again = await run(f)
    expect(again.created).toEqual([])
    expect(
      await t.db.selectFrom('closures').select('id').where('deleted_at', 'is', null).execute(),
    ).toHaveLength(4)
  })

  it('skips a holiday that already has a closure that year, by date or by name', async () => {
    const f = await setupLocation(t)
    const manual = (date: string, name: string) =>
      t.db
        .insertInto('closures')
        .values({
          id: f.newId(),
          location_id: f.locationId,
          date,
          name,
          type: 'closed',
          open_min: null,
          close_min: null,
          federal_key: null,
          federal_year: null,
          emergency_closure_id: null,
          created_by: null,
          deleted_at: null,
        })
        .execute()
    await manual('2026-05-25', 'Memorial Day')
    await manual('2026-12-24', 'christmas day')
    await manual('2026-07-04', 'Fireworks closure')
    const r = await run(f)
    expect(r.created.map((c) => c.key)).toEqual(['labor_day', 'thanksgiving'])
    expect(r.skipped.filter((s) => s.reason === 'closure_exists').map((s) => s.key)).toEqual([
      'memorial_day',
      'independence_day',
      'christmas',
    ])
  })

  it('keeps a reduced-hours Labor Day edit and does not double it', async () => {
    const f = await setupLocation(t)
    await run(f)
    await t.db
      .updateTable('closures')
      .set({ type: 'reduced', open_min: 600, close_min: 840 })
      .where('federal_key', '=', 'labor_day')
      .execute()
    await run(f)
    const labor = await t.db
      .selectFrom('closures')
      .select(['type', 'open_min'])
      .where('date', '=', '2026-09-07')
      .execute()
    expect(labor).toEqual([{ type: 'reduced', open_min: 600 }])
  })

  it('leaves years that already ran alone in catch-up mode, and fills new years', async () => {
    const f = await setupLocation(t)
    await t.db.insertInto('federal_holiday_runs').values({ location_id: f.locationId, year: 2026 }).execute()
    const r = await run(f, { years: [2026, 2027], catchUp: true })
    expect(r.skippedYears).toEqual([2026])
    expect(r.created.every((c) => c.year === 2027)).toBe(true)
    expect(r.created).toHaveLength(5)
  })

  it('does nothing while the federal_holidays.auto setting is off, unless forced', async () => {
    const f = await setupLocation(t)
    await transaction(t.db, (tx) =>
      updateSetting(tx, { locationId: f.locationId, key: 'federal_holidays.auto', value: false }),
    )
    const off = await run(f)
    expect(off).toMatchObject({ skippedDisabled: true, created: [] })
    expect(await t.db.selectFrom('closures').select('id').execute()).toHaveLength(0)
    const forced = await run(f, { ignoreToggle: true })
    expect(forced.created).toHaveLength(5)
  })

  it('can add the other federal holidays on request and can be told to notify', async () => {
    const f = await setupLocation(t)
    const r = await run(f, { keys: ['juneteenth', 'veterans_day'], notify: true })
    expect(r.created.map((c) => c.date)).toEqual(['2026-06-19', '2026-11-11'])
    const rows = await t.db.selectFrom('closures').select('notify').execute()
    expect(rows.every((x) => x.notify)).toBe(true)
  })
})
