// sms.dispatch through the real worker: the production handler holds the leader lock and ticks for its 55 second window,
// sends what is queued exactly once, and a second run (queued while no new text exists) sends nothing. A worker stopped
// mid-window (a deploy) ends the run after its current tick, so the run completes instead of dead-lettering.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { jobRuntime, runDispatchWindow, smsDispatchJob } from '../../src/modules/messaging/jobs/index.js'
import type { JobDefinition } from '../../src/platform/jobs.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { useWorld } from '../messaging-db/world.js'
import { useJobsHarness } from './harness.js'

const w = useWorld({ start: '2026-06-12T12:00:00-04:00' })
const h = useJobsHarness({ testDb: () => w.t })

const saved: Record<string, string | undefined> = {}
beforeAll(() => {
  for (const [k, v] of Object.entries({
    DATABASE_URL: testDatabaseUrl(),
    DB_SEARCH_PATH: `${w.t.schema},public`,
    SMS_ALLOWLIST: w.env.SMS_ALLOWLIST,
    SMSGATE_MIN_INTERVAL_MS: '0',
    SMS_DISPATCH_MODE: 'jobs',
    SMS_TICK_INTERVAL_MS: '500',
    EMAIL_CONSOLE_DIR: w.env.EMAIL_CONSOLE_DIR,
  })) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
})

const outbox = () => w.t.db.selectFrom('sms_outbox').select(['state', 'attempts']).execute()
const usage = async (): Promise<number> =>
  Number((await sql<{ n: number }>`select count(*)::int as n from sms_usage`.execute(w.t.db)).rows[0]!.n)

describe('sms.dispatch', () => {
  it('sends a queued text once in its window; the next run sends nothing more', async () => {
    await w.rt.pollHealthAll() // a heartbeat, so the silence rules leave the device alone
    await w.tx((tx) =>
      w.rt.queue.enqueue(tx, {
        customerId: w.customer('Maria Delgado').id,
        appointmentId: null,
        purpose: 'matrix',
        templateKey: 'booking_thanks',
        vars: { first: 'Maria' },
      }),
    )
    expect(await outbox()).toEqual([{ state: 'pending', attempts: 0 }])

    // run 1: the production definition, its full window
    const schema = h.newSchema()
    const first = await h.start({ schema, definitions: [smsDispatchJob] as never })
    await first.jobs.enqueue('sms.dispatch', {})
    await h.waitFor(async () => (await h.states(schema, 'sms.dispatch')).includes('completed'), 150_000)
    const sent = await outbox()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.state).not.toBe('pending')
    expect(sent[0]!.attempts).toBe(1)
    expect(await usage()).toBe(1)
    await first.stop()

    // run 2: the same handler with a shorter window (the only difference), through a new worker on the same queue
    const shortWindow: JobDefinition<never> = {
      ...smsDispatchJob,
      handler: async (ctx) =>
        void (await runDispatchWindow(jobRuntime(ctx), { windowMs: 1500, intervalMs: 300 })),
    } as JobDefinition<never>
    const second = await h.start({ schema, definitions: [shortWindow] as never })
    await second.jobs.enqueue('sms.dispatch', {})
    await h.waitFor(
      async () => (await h.states(schema, 'sms.dispatch')).filter((s) => s === 'completed').length === 2,
    )
    expect(await outbox()).toEqual(sent)
    expect(await usage()).toBe(1)
  }, 240_000)

  it('a worker stopped mid-window (a deploy) ends the run after its tick: completed, no dead letter, no staff notice', async () => {
    await w.rt.pollHealthAll()
    await w.tx((tx) =>
      w.rt.queue.enqueue(tx, {
        customerId: w.customer('Maria Delgado').id,
        appointmentId: null,
        purpose: 'matrix',
        templateKey: 'booking_thanks',
        vars: { first: 'Maria' },
      }),
    )
    // the production definition (retryLimit 0, 55 s window), the worker's own drain budget and its default dead-letter hook,
    // which notifies the managers this world has
    const schema = h.newSchema()
    const worker = await h.start({ schema, definitions: [smsDispatchJob] as never })
    await worker.jobs.enqueue('sms.dispatch', {})
    // mid-window: the run is active and has already sent the queued text
    await h.waitFor(
      async () =>
        (await outbox()).every((r) => r.state !== 'pending') &&
        (await h.states(schema, 'sms.dispatch')).includes('active'),
      30_000,
    )

    const began = Date.now()
    await worker.stop()
    // one tick (500 ms here), not the rest of the 55 s window: systemd kills the worker 45 s after SIGTERM
    expect(Date.now() - began).toBeLessThan(5_000)
    expect(await h.states(schema, 'sms.dispatch')).toEqual(['completed'])
    expect(await h.rows(schema, 'sms.dispatch.dead')).toEqual([])
    expect(
      await w.t.db.selectFrom('notifications').select('id').where('kind', '=', 'job.failed').execute(),
    ).toEqual([])
    expect(
      await w.t.db
        .selectFrom('job_runs')
        .select(['last_outcome', 'failures'])
        .where('name', '=', 'sms.dispatch')
        .executeTakeFirstOrThrow(),
    ).toEqual({ last_outcome: 'completed', failures: 0 })
    expect(h.logs.some((l) => String(l.msg).includes('handed back'))).toBe(false)

    // the next worker's run starts at once (a run left active would hold the stately queue until it expired, minutes later)
    const next = await h.start({ schema, definitions: [smsDispatchJob] as never })
    await next.jobs.enqueue('sms.dispatch', {})
    await h.waitFor(async () => (await h.states(schema, 'sms.dispatch')).includes('active'), 10_000)
    await next.stop()
    expect(await h.states(schema, 'sms.dispatch')).toEqual(['completed', 'completed'])
    expect(await h.rows(schema, 'sms.dispatch.dead')).toEqual([])
  }, 120_000)
})
