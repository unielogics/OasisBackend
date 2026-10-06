import { afterEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { jobDefinitions } from '../../src/platform/job-registry.js'
import { createJobs, type JobDefinition, type Jobs } from '../../src/platform/jobs.js'
import { createLogger } from '../../src/platform/logging.js'
import {
  EMERGENCY_AUTO_REOPEN_JOB,
  EMERGENCY_SWEEP_JOB,
  FEDERAL_HOLIDAYS_JOB,
  emergencyAutoReopenJob,
  emergencySweepJob,
  enqueueStartupJobs,
  federalHolidaysJob,
  runEmergencyReopen,
  runFederalHolidayJob,
  settingsJobs,
} from '../../src/modules/settings/jobs/index.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { sleep } from '../helpers/sse.js'
import { bookCustomer, seedDesignDay } from './fixtures.js'
import { auditActions, events, json, useSettingsHarness } from './harness.js'

const h = useSettingsHarness()
const logger = createLogger({ level: 'silent' })

const federalRows = () =>
  h.db
    .selectFrom('closures')
    .select(['date', 'name', 'notify', 'federal_key', 'federal_year'])
    .where('source', '=', 'federal')
    .orderBy('date')
    .execute()

const runs = async (): Promise<number[]> =>
  (await h.db.selectFrom('federal_holiday_runs').select('year').orderBy('year').execute()).map((r) => r.year)

const job = () => ({ db: h.db, clock: h.clock })

describe('federal_holidays.generate', () => {
  it('adds the current and next year, records the runs, and is a no-op the second time', async () => {
    const first = await runFederalHolidayJob(job())
    expect(first).toEqual([
      { locationId: h.fx.locationId, created: 9, years: [2026, 2027], skippedDisabled: false },
    ])
    const rows = await federalRows()
    expect(rows).toHaveLength(9)
    expect(rows.every((r) => r.notify === false)).toBe(true)
    expect(rows[0]).toMatchObject({
      date: '2026-07-04',
      name: 'Independence Day',
      federal_key: 'independence_day',
      federal_year: 2026,
    })
    expect(await runs()).toEqual([2026, 2027])

    const second = await runFederalHolidayJob(job())
    expect(second[0]!.created).toBe(0)
    expect(await federalRows()).toHaveLength(9)
    // a forced re-check without catch-up mode still adds nothing: the unique key holds
    const forced = await runFederalHolidayJob(job(), { catchUp: false })
    expect(forced[0]!.created).toBe(0)
    expect(await federalRows()).toHaveLength(9)
  })

  it('does nothing while the auto toggle is off and never brings back a removed holiday', async () => {
    const s = await h.admin()
    await h.put('settings/auto-federal-holidays', s, { enabled: false })
    expect((await runFederalHolidayJob(job()))[0]).toMatchObject({ created: 0, skippedDisabled: true })
    expect(await federalRows()).toEqual([])
    expect(await runs()).toEqual([])

    await h.put('settings/auto-federal-holidays', s, { enabled: true })
    const labor = (await federalRows()).find((r) => r.name === 'Labor Day' && r.federal_year === 2026)!
    await h.db
      .updateTable('closures')
      .set({ deleted_at: h.clock.now() })
      .where('federal_key', '=', 'labor_day')
      .where('federal_year', '=', 2026)
      .execute()
    await h.db.deleteFrom('federal_holiday_runs').execute()
    const again = await runFederalHolidayJob(job())
    expect(again[0]!.created).toBe(0)
    const live = await h.db
      .selectFrom('closures')
      .select('date')
      .where('date', '=', labor.date)
      .where('deleted_at', 'is', null)
      .execute()
    expect(live).toEqual([])
  })

  it('rolls over on Jan 1: next year appears, the year that already ran is left alone', async () => {
    await runFederalHolidayJob(job())
    expect(await runs()).toEqual([2026, 2027])
    h.clock.set('2027-01-01T00:05:00-05:00')
    const r = await runFederalHolidayJob(job())
    expect(r[0]).toMatchObject({ created: 5, years: [2027, 2028] })
    expect((await federalRows()).filter((x) => x.federal_year === 2028).map((x) => x.date)).toEqual([
      '2028-05-29',
      '2028-07-04',
      '2028-09-04',
      '2028-11-23',
      '2028-12-25',
    ])
    expect(await runs()).toEqual([2026, 2027, 2028])
  })

  it('catches up after downtime: a missed year is generated at startup, skipping dates already past', async () => {
    await h.db
      .insertInto('federal_holiday_runs')
      .values({ location_id: h.fx.locationId, year: 2026 })
      .execute()
    h.clock.set('2027-06-20T09:00:00-04:00')
    const r = await runFederalHolidayJob(job())
    expect(r[0]).toMatchObject({ years: [2027, 2028], created: 4 + 5 })
    const names = (await federalRows()).filter((x) => x.federal_year === 2027).map((x) => x.name)
    expect(names).toEqual(['Independence Day', 'Labor Day', 'Thanksgiving', 'Christmas Day'])
  })

  it('does not double a closure that already exists for the holiday date or name', async () => {
    const s = await h.admin()
    await h.post('closures', s, { date: '2026-07-04', name: 'Fourth of July', notify: false })
    await h.post('closures', s, { date: '2026-12-25', name: 'christmas day', notify: false })
    const r = await runFederalHolidayJob(job())
    expect(r[0]!.created).toBe(7)
    expect((await federalRows()).map((x) => x.date)).not.toContain('2026-07-04')
    expect((await federalRows()).map((x) => x.date)).not.toContain('2026-12-25')
  })

  it('runs through its job definition', async () => {
    expect(federalHolidaysJob).toMatchObject({
      name: 'federal_holidays.generate',
      cron: '5 0 1 1 *',
      policy: 'short',
    })
    await federalHolidaysJob.handler({ db: h.db, clock: h.clock, logger }, { catchUp: true }, { id: 'j1' })
    expect(await federalRows()).toHaveLength(9)
    await federalHolidaysJob.handler({ db: h.db, clock: h.clock, logger }, undefined as never, { id: 'j2' })
    expect(await federalRows()).toHaveLength(9)
  })
})

describe('emergency.auto_reopen and emergency.sweep', () => {
  async function closeUntil(body: Record<string, unknown>) {
    await seedDesignDay(h.db, h.fx)
    const s = await h.admin()
    const r = await h.post(
      'emergency/close',
      s,
      { reason: 'Power outage', ...body },
      { 'idempotency-key': 'job-key-000001' },
    )
    expect(r.statusCode).toBe(201)
    return { s, id: json(r).emergency.id as string, endsAt: new Date(json(r).emergency.endsAt as string) }
  }
  const active = async () =>
    (await h.db.selectFrom('emergency_closures').select('id').where('active', '=', true).execute()).length

  it('reopens at the end time with a controlled clock, not before', async () => {
    const { id, endsAt } = await closeUntil({ dur: 'until', until: '2:00 PM' })
    expect(endsAt.toISOString()).toBe(new Date('2026-06-13T14:00:00-04:00').toISOString())
    expect(h.queued[0]).toMatchObject({ name: 'emergency.auto_reopen', data: { emergencyClosureId: id } })

    h.clock.set('2026-06-13T13:59:59-04:00')
    expect(await runEmergencyReopen(job(), { locationId: h.fx.locationId, emergencyClosureId: id })).toEqual(
      [],
    )
    expect(await active()).toBe(1)

    h.clock.set('2026-06-13T14:00:00-04:00')
    const done = await runEmergencyReopen(job(), { locationId: h.fx.locationId, emergencyClosureId: id })
    expect(done).toEqual([{ locationId: h.fx.locationId, emergencyClosureId: id }])
    expect(await active()).toBe(0)
    const row = await h.db
      .selectFrom('emergency_closures')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    expect(row).toMatchObject({
      auto_reopened: true,
      reopened_by: null,
      reopened_by_name: null,
      detail: 'Reopened automatically · 5 notified',
      notified_count: 5,
    })
    expect(row.reopened_at?.toISOString()).toBe(new Date('2026-06-13T14:00:00-04:00').toISOString())
    const ops = (await events(h.db, 'ops')).filter((e) => e.type === 'emergency.reopened')
    expect(ops).toEqual([expect.objectContaining({ payload: { id, auto: true } })])
    expect(await auditActions(h.db)).toContain('emergency.auto_reopen')
    // the emergency closure row is gone from the calendar
    expect(await h.db.selectFrom('closures').select('id').where('deleted_at', 'is', null).execute()).toEqual(
      [],
    )
    // idempotent: running again does nothing
    expect(await runEmergencyReopen(job(), { locationId: h.fx.locationId, emergencyClosureId: id })).toEqual(
      [],
    )
    expect(await runEmergencyReopen(job())).toEqual([])
  })

  it('ignores a job for a different emergency', async () => {
    const { id } = await closeUntil({ dur: 'until', until: '2:00 PM' })
    h.clock.set('2026-06-13T15:00:00-04:00')
    expect(
      await runEmergencyReopen(job(), {
        locationId: h.fx.locationId,
        emergencyClosureId: '00000000-0000-7000-8000-000000000009',
      }),
    ).toEqual([])
    expect(await active()).toBe(1)
    expect(
      await runEmergencyReopen(job(), { locationId: h.fx.locationId, emergencyClosureId: id }),
    ).toHaveLength(1)
  })

  it('the hourly sweep reopens an emergency whose delayed job was lost', async () => {
    const { id } = await closeUntil({ dur: 'today' })
    h.clock.set('2026-06-13T16:59:00-04:00')
    expect(await runEmergencyReopen(job())).toEqual([])
    h.clock.set('2026-06-13T17:00:00-04:00')
    await emergencySweepJob.handler({ db: h.db, clock: h.clock, logger }, {}, { id: 'sweep-1' })
    expect(await active()).toBe(0)
    expect(
      (
        await h.db
          .selectFrom('emergency_closures')
          .select('auto_reopened')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).auto_reopened,
    ).toBe(true)
    await emergencySweepJob.handler({ db: h.db, clock: h.clock, logger }, {}, { id: 'sweep-2' })
  })

  it('a multi-day closure ends at the closing time of the last day and restores planned closures', async () => {
    await bookCustomer(h.db, h.fx, { name: 'Monday Mia', date: '2026-06-15', time: '09:00' })
    const s = await h.admin()
    await h.post('closures', s, { date: '2026-06-16', name: 'Training', notify: false })
    const r = await h.post(
      'emergency/close',
      s,
      { reason: 'Other', dur: 'days', through: '2026-06-16' },
      { 'idempotency-key': 'job-key-000002' },
    )
    expect(r.statusCode).toBe(201)
    const endsAt = new Date(json(r).emergency.endsAt as string)
    // Tuesday 2026-06-16 closes at 6:00 PM, but the planned Training closure replaced that day as a closed day
    expect(endsAt.getTime()).toBeGreaterThan(new Date('2026-06-16T00:00:00-04:00').getTime())
    h.clock.set('2026-06-14T12:00:00-04:00')
    expect(await runEmergencyReopen(job())).toEqual([])
    h.clock.set(new Date(endsAt.getTime() + 1000))
    expect(await runEmergencyReopen(job())).toHaveLength(1)
    // days already over stay closed in the calendar; today and later are removed and the planned closure comes back
    const live = await h.db
      .selectFrom('closures')
      .select(['date', 'name', 'source'])
      .where('deleted_at', 'is', null)
      .orderBy('date')
      .execute()
    expect(live).toEqual([
      { date: '2026-06-13', name: 'Emergency closure', source: 'emergency' },
      { date: '2026-06-14', name: 'Emergency closure', source: 'emergency' },
      { date: '2026-06-15', name: 'Emergency closure', source: 'emergency' },
      { date: '2026-06-16', name: 'Training', source: 'manual' },
    ])
  })

  it('exposes the definitions', async () => {
    expect(emergencyAutoReopenJob).toMatchObject({ name: 'emergency.auto_reopen', policy: 'short' })
    expect(emergencySweepJob).toMatchObject({ name: 'emergency.sweep', cron: '0 * * * *' })
    expect(settingsJobs.map((j) => j.name)).toEqual([
      FEDERAL_HOLIDAYS_JOB,
      EMERGENCY_AUTO_REOPEN_JOB,
      EMERGENCY_SWEEP_JOB,
    ])
    for (const j of settingsJobs) expect(jobDefinitions).toContain(j)
  })
})

describe('startup catch-up', () => {
  it('enqueues the federal catch-up and an emergency sweep, once per restart, and survives a failing queue', async () => {
    const calls: { name: string; data: unknown; opts: unknown }[] = []
    await enqueueStartupJobs({
      enqueue: async (name, data, opts) => {
        calls.push({ name, data, opts })
        return 'id'
      },
    })
    expect(calls).toEqual([
      { name: 'federal_holidays.generate', data: { catchUp: true }, opts: { singletonKey: 'startup' } },
      { name: 'emergency.sweep', data: {}, opts: { singletonKey: 'startup' } },
    ])
    const failed: string[] = []
    await enqueueStartupJobs(
      {
        enqueue: async () => {
          throw new Error('queue down')
        },
      },
      (err, job) => failed.push(`${job}: ${err.message}`),
    )
    expect(failed).toEqual(['federal_holidays.generate: queue down', 'emergency.sweep: queue down'])
  })
})

describe('through pg-boss', () => {
  let jobs: Jobs | undefined
  const bossSchema = (): string =>
    `pgboss_settings_${h.t.env.PGBOSS_SCHEMA}_${process.env.VITEST_POOL_ID ?? '0'}`
  afterEach(async () => {
    await jobs?.stop()
    jobs = undefined
    await sql`drop schema if exists ${sql.id(bossSchema())} cascade`.execute(h.db)
  })

  it('registers the queues and cron schedules, and a delayed auto_reopen job reopens the shop', async () => {
    const { id, endsAt } = await (async () => {
      await seedDesignDay(h.db, h.fx)
      const s = await h.admin()
      const r = await h.post(
        'emergency/close',
        s,
        { reason: 'Power outage', dur: 'until', until: '2:00 PM' },
        { 'idempotency-key': 'job-key-000003' },
      )
      return { id: json(r).emergency.id as string, endsAt: new Date(json(r).emergency.endsAt as string) }
    })()
    jobs = createJobs({
      connectionString: testDatabaseUrl(),
      schema: bossSchema(),
      db: h.db,
      clock: h.clock,
      logger,
      enabled: true,
      definitions: settingsJobs as readonly JobDefinition<never>[],
      tz: 'America/New_York',
      pollSeconds: 0.5,
    })
    await jobs.start({ workers: true })
    const schedules = await sql<{
      name: string
      cron: string
      timezone: string
    }>`select name, cron, timezone from ${sql.table(`${bossSchema()}.schedule`)} order by name`.execute(h.db)
    expect(schedules.rows).toEqual([
      { name: 'emergency.sweep', cron: '0 * * * *', timezone: 'America/New_York' },
      { name: 'federal_holidays.generate', cron: '5 0 1 1 *', timezone: 'America/New_York' },
    ])

    h.clock.set(new Date(endsAt.getTime() + 60_000))
    await jobs.enqueue(
      EMERGENCY_AUTO_REOPEN_JOB,
      { locationId: h.fx.locationId, emergencyClosureId: id },
      { singletonKey: id },
    )
    const end = performance.now() + 15_000
    for (;;) {
      const open = await h.db
        .selectFrom('emergency_closures')
        .select('active')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      if (!open.active) break
      if (performance.now() > end) throw new Error('the job did not reopen the shop')
      await sleep(200)
    }
    const row = await h.db
      .selectFrom('emergency_closures')
      .select(['auto_reopened', 'detail'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ auto_reopened: true, detail: 'Reopened automatically · 5 notified' })
  })
})
