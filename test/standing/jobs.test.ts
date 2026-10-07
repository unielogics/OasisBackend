// The standing and waitlist jobs are in the job registry and, run through their real handlers (real messaging queue), do the work.
import { afterAll, describe, expect, it } from 'vitest'
import { DESIGN_CUSTOMERS } from '../../db/seeds/domain.js'
import { jobDefinitions } from '../../src/platform/job-registry.js'
import { createLogger } from '../../src/platform/logging.js'
import {
  standingAutoconfirmJob,
  standingMaterializeJob,
  waitlistOfferExpiryJob,
} from '../../src/modules/standing/jobs.js'
import { appointmentsOf, setFeature, useRig, type Rig } from './support.js'

const jobCtx = (m: Rig) => ({
  db: m.h.t.db,
  clock: m.h.clock,
  logger: createLogger({ level: 'silent', pretty: false }),
})

describe('standing jobs', () => {
  const m = useRig()
  const allowlist = process.env.SMS_ALLOWLIST
  afterAll(() => {
    if (allowlist === undefined) delete process.env.SMS_ALLOWLIST
    else process.env.SMS_ALLOWLIST = allowlist
  })

  it('are registered with their schedules', () => {
    const by = new Map(jobDefinitions.map((j) => [j.name, j]))
    expect(by.get('standing.materialize')?.cron).toBe('0 4 * * *')
    expect(by.get('standing.autoconfirm')?.cron).toBe('0 * * * *')
    expect(by.get('waitlist.offer_expiry')?.cron).toBe('* * * * *')
    expect(new Set(jobDefinitions.map((j) => j.name)).size).toBe(jobDefinitions.length)
  })

  it('do nothing while the feature is off, then materialize, confirm (with a real text) and expire through their handlers', async () => {
    const series = await m.h.t.db
      .insertInto('standing_series')
      .values({
        id: m.h.t.app.newId(),
        location_id: m.locationId(),
        customer_id: await m.customer('Liam Chen'),
        service_id: (
          await m.h.t.db
            .selectFrom('services')
            .select('id')
            .where('name', '=', 'Express Hand Wash')
            .executeTakeFirstOrThrow()
        ).id,
        cadence: 'weekly',
        weekday: 6,
        time_min: 540,
        start_date: '2026-06-20',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    // the job builds its own messaging runtime from the process environment: allow the seeded numbers like the API rig does
    process.env.SMS_ALLOWLIST = DESIGN_CUSTOMERS.map((c) => c.phoneE164).join(',')
    const ctx = jobCtx(m)
    const run = { id: 'job-1' }
    await standingMaterializeJob.handler(ctx, {} as never, run)
    expect(await appointmentsOf(m, series.id)).toEqual([])

    await setFeature(m, true)
    await standingMaterializeJob.handler(ctx, {} as never, run)
    const appts = await appointmentsOf(m, series.id)
    expect(appts.map((a) => a.start.toISOString().slice(0, 10))).toEqual([
      '2026-06-20',
      '2026-06-27',
      '2026-07-11',
    ])

    m.h.clock.set('2026-06-18T09:30:00-04:00')
    await standingAutoconfirmJob.handler(ctx, {} as never, run)
    expect((await appointmentsOf(m, series.id))[0]!.status).toBe('confirmed')
    const texts = await m.h.t.db
      .selectFrom('messages')
      .select('body')
      .where('direction', '=', 'out')
      .execute()
    expect(texts.map((t) => t.body)).toEqual([expect.stringContaining('confirmed')])
    await waitlistOfferExpiryJob.handler(ctx, {} as never, run)
  })
})
