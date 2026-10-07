// The job runtime (src/platform/jobs.ts + src/worker.ts) through the real pg-boss worker: logging without payloads, run
// records, retries, the dead-letter queue, singleton keys across two workers, graceful shutdown and schedule upkeep.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { createJobs, type DeadLetterInfo, type JobDefinition } from '../../src/platform/jobs.js'
import { nextCronRun } from '../../src/platform/jobs-cron.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { sleep } from '../helpers/sse.js'
import { useJobsHarness } from './harness.js'

const h = useJobsHarness()
const PHONE = '+13055550123'

const def = (
  d: Partial<JobDefinition<never>> & Pick<JobDefinition<never>, 'name' | 'handler'>,
): JobDefinition<never> => d as JobDefinition<never>

describe('a job through the real worker', () => {
  it('runs, is logged at start and finish without its payload, and is recorded in job_runs', async () => {
    const seen: unknown[] = []
    const w = await h.start({
      definitions: [def({ name: 'test.echo', handler: async (_c, data) => void seen.push(data) })],
    })
    await w.jobs.enqueue('test.echo', { phone: PHONE, note: 'secret-note' })
    await h.waitFor(async () => (await h.states(w.schema, 'test.echo')).includes('completed'))
    expect(seen).toEqual([{ phone: PHONE, note: 'secret-note' }])

    const mine = h.logs.filter((l) => l.job === 'test.echo')
    expect(mine.map((l) => l.msg)).toEqual(['job started', 'job finished'])
    expect(mine[0]).toMatchObject({ attempt: 1, retryLimit: 3 })
    expect(mine[1]).toMatchObject({ attempt: 1 })
    expect(typeof mine[1]!.durationMs).toBe('number')
    expect(typeof mine[1]!.jobId).toBe('string')
    // the payload and its phone number never reach the log
    expect(JSON.stringify(h.logs)).not.toContain('3055550123')
    expect(JSON.stringify(h.logs)).not.toContain('secret-note')

    const run = await h.t.db
      .selectFrom('job_runs')
      .selectAll()
      .where('name', '=', 'test.echo')
      .executeTakeFirstOrThrow()
    expect(run).toMatchObject({
      runs: 1,
      failures: 0,
      consecutive_failures: 0,
      last_outcome: 'completed',
      last_attempt: 1,
    })
    expect(run.last_success_at).toEqual(h.clock.now())
    expect(run.last_started_at).toEqual(h.clock.now())
  })

  it('retries a failing job, then fails it into the dead-letter queue, and reports once per failure streak', async () => {
    let attempts = 0
    const dead: DeadLetterInfo[] = []
    const w = await h.start({
      definitions: [
        def({
          name: 'test.boom',
          retryLimit: 1,
          retryDelaySeconds: 1,
          handler: async () => {
            attempts += 1
            throw new Error(`cannot text ${PHONE}`)
          },
        }),
      ],
      onDeadLetter: async (i) => void dead.push(i),
    })
    await w.jobs.enqueue('test.boom', { orderId: 'abc' })
    await h.waitFor(async () => (await h.states(w.schema, 'test.boom')).includes('failed'), 30_000)
    expect(attempts).toBe(2)

    const run = await h.t.db
      .selectFrom('job_runs')
      .selectAll()
      .where('name', '=', 'test.boom')
      .executeTakeFirstOrThrow()
    expect(run).toMatchObject({
      runs: 2,
      failures: 2,
      consecutive_failures: 2,
      last_outcome: 'failed',
      last_attempt: 2,
    })
    expect(run.last_error).toContain('cannot text')
    expect(run.last_error).not.toContain('3055550123') // masked before it is stored
    expect(dead).toHaveLength(1)
    expect(dead[0]).toMatchObject({ name: 'test.boom', attempts: 2 })

    // dead letter is visible: its own queue holds the payload, the status endpoint counts it
    const dl = await h.rows(w.schema, 'test.boom.dead')
    expect(dl).toHaveLength(1)
    expect(dl[0]!.data).toEqual({ orderId: 'abc' })
    const status = await w.jobs.status!()
    const row = status.jobs.find((j) => j.name === 'test.boom')!
    expect(row).toMatchObject({
      failed: 1,
      deadLetter: 1,
      failures: 2,
      consecutiveFailures: 2,
      lastOutcome: 'failed',
    })
    expect(status.queue).toMatchObject({ failed: 1, deadLetter: 1 })

    // a second exhausted cycle in the same streak does not notify again
    await w.jobs.enqueue('test.boom', { orderId: 'def' })
    await h.waitFor(
      async () => (await h.states(w.schema, 'test.boom')).filter((s) => s === 'failed').length === 2,
      30_000,
    )
    expect(dead).toHaveLength(1)
  })

  it('notifies the managers when a job dead-letters (the default hook)', async () => {
    const { runSeed } = await import('../../db/seeds/index.js')
    await runSeed({ db: h.t.db, clock: h.clock, profile: 'design' })
    await sql`insert into users (id, employee_id, email, password_hash)
      select gen_random_uuid(), e.id, lower(e.first) || '@example.test', 'not-a-real-hash' from employees e
      where not exists (select 1 from users u where u.employee_id = e.id)`.execute(h.t.db)
    const w = await h.start({
      definitions: [
        def({
          name: 'test.dies',
          retryLimit: 0,
          handler: async () => Promise.reject(new Error('disk full')),
        }),
      ],
    })
    await w.jobs.enqueue('test.dies', {})
    const n = await h.waitFor(async () => {
      const r = await h.t.db
        .selectFrom('notifications')
        .select(['kind', 'title', 'body', 'entity_id'])
        .where('kind', '=', 'job.failed')
        .execute()
      return r.length > 0 ? r : false
    })
    expect(n[0]).toMatchObject({ kind: 'job.failed', title: 'Background job failed', entity_id: 'test.dies' })
    expect(n[0]!.body).toContain('test.dies failed after 1 attempt(s): disk full')
    // one notification per manager, not per attempt
    const managers = new Set(
      (
        await h.t.db
          .selectFrom('notifications')
          .select('employee_id')
          .where('kind', '=', 'job.failed')
          .execute()
      ).map((r) => r.employee_id),
    )
    expect(n).toHaveLength(managers.size)
  })

  it('starts the failure streak over after a success', async () => {
    let mode: 'fail' | 'ok' = 'fail'
    const dead: DeadLetterInfo[] = []
    const w = await h.start({
      definitions: [
        def({
          name: 'test.flip',
          retryLimit: 0,
          handler: async () => {
            if (mode === 'fail') throw new Error('nope')
          },
        }),
      ],
      onDeadLetter: async (i) => void dead.push(i),
    })
    const finished = async (n: number) =>
      h.waitFor(
        async () =>
          (await h.states(w.schema, 'test.flip')).filter((s) => s === 'failed' || s === 'completed').length >=
          n,
      )
    await w.jobs.enqueue('test.flip', {})
    await finished(1)
    await w.jobs.enqueue('test.flip', {})
    await finished(2)
    expect(dead).toHaveLength(1)
    mode = 'ok'
    await w.jobs.enqueue('test.flip', {})
    await finished(3)
    mode = 'fail'
    await w.jobs.enqueue('test.flip', {})
    await finished(4)
    expect(dead).toHaveLength(2)
  })
})

describe('two workers and singleton keys', () => {
  it('runs every job exactly once when two workers share a queue', async () => {
    const schema = h.newSchema()
    const ran = new Map<string, string[]>()
    const mk = (tag: string) =>
      def({
        name: 'test.shared',
        handler: async (_c, data: { n: number }) => {
          const list = ran.get(String(data.n)) ?? []
          list.push(tag)
          ran.set(String(data.n), list)
          await sleep(100)
        },
      })
    const a = await h.start({ schema, definitions: [mk('A')] })
    await h.start({ schema, definitions: [mk('B')] })
    for (let n = 0; n < 12; n++) await a.jobs.enqueue('test.shared', { n })
    await h.waitFor(
      async () => (await h.states(schema, 'test.shared')).filter((s) => s === 'completed').length === 12,
    )
    expect([...ran.keys()].sort()).toEqual(Array.from({ length: 12 }, (_, i) => String(i)).sort())
    for (const [n, who] of ran) expect(who, `job ${n}`).toHaveLength(1)
    // both workers took part (12 jobs over two pollers; not a guarantee, so only the totals are asserted above)
    expect(new Set([...ran.values()].flat()).size).toBeGreaterThanOrEqual(1)
  })

  it('collapses a duplicate while one is queued (short policy) and never runs the same key twice at once (stately)', async () => {
    const schema = h.newSchema()
    let active = 0
    let maxActive = 0
    let runs = 0
    const slow = (tag: string) =>
      def({
        name: 'test.once',
        policy: 'stately',
        handler: async () => {
          active += 1
          maxActive = Math.max(maxActive, active)
          runs += 1
          await sleep(1200)
          active -= 1
          void tag
        },
      })
    const a = await h.start({ schema, definitions: [slow('A')] })
    await h.start({ schema, definitions: [slow('B')] })
    const first = await a.jobs.enqueue('test.once', {}, { singletonKey: 'k' })
    expect(first).toEqual(expect.any(String))
    await h.waitFor(async () => (await h.states(schema, 'test.once')).includes('active'))
    const queued = await a.jobs.enqueue('test.once', {}, { singletonKey: 'k' }) // one may wait behind the active one
    const third = await a.jobs.enqueue('test.once', {}, { singletonKey: 'k' }) // but not two
    expect(queued).toEqual(expect.any(String))
    expect(third).toBeNull()
    await h.waitFor(
      async () => (await h.states(schema, 'test.once')).filter((s) => s === 'completed').length === 2,
      30_000,
    )
    expect(runs).toBe(2)
    expect(maxActive).toBe(1)
  })

  it('a stately periodic job leaves no backlog behind while the worker is down (the singleton policy does)', async () => {
    const schema = h.newSchema()
    const noop = async (): Promise<void> => undefined
    const producer = (policy: 'singleton' | 'stately') =>
      createJobs({
        connectionString: testDatabaseUrl(),
        schema,
        db: h.t.db,
        clock: h.clock,
        logger: h.logger(),
        enabled: true,
        tz: 'America/New_York',
        definitions: [def({ name: `test.tick.${policy}`, policy, handler: noop })],
      })
    const p = producer('singleton')
    await p.start({ workers: false })
    const q = producer('stately')
    await q.start({ workers: false })
    for (let i = 0; i < 5; i++) {
      await p.enqueue('test.tick.singleton', {})
      await q.enqueue('test.tick.stately', {})
    }
    expect((await h.states(schema, 'test.tick.singleton')).length).toBe(5)
    expect((await h.states(schema, 'test.tick.stately')).length).toBe(1)
    await p.stop()
    await q.stop()
  })
})

describe('shutdown', () => {
  it('drains: stop() waits for a running handler and the job completes, it is not failed or retried', async () => {
    let finished = false
    const w = await h.start({
      shutdownTimeoutMs: 10_000,
      definitions: [
        def({
          name: 'test.drain',
          handler: async () => {
            await sleep(1500)
            finished = true
          },
        }),
      ],
    })
    await w.jobs.enqueue('test.drain', {})
    await h.waitFor(async () => (await h.states(w.schema, 'test.drain')).includes('active'))
    const began = Date.now()
    await w.stop()
    expect(finished).toBe(true)
    expect(Date.now() - began).toBeGreaterThanOrEqual(500)
    expect(await h.states(w.schema, 'test.drain')).toEqual(['completed'])
  })

  it('fails what is still running after the timeout back to the queue, and a later worker finishes it once', async () => {
    const schema = h.newSchema()
    let dying = true
    const effects: number[] = []
    const handler = async (): Promise<void> => {
      if (dying) {
        await sleep(6000)
        if (dying) return // the process that held this handler is gone: it never reports
      }
      effects.push(effects.length + 1)
    }
    const first = await h.start({
      schema,
      shutdownTimeoutMs: 1000,
      definitions: [def({ name: 'test.cut', retryLimit: 2, retryDelaySeconds: 1, handler })],
    })
    await first.jobs.enqueue('test.cut', {})
    await h.waitFor(async () => (await h.states(schema, 'test.cut')).includes('active'))
    await first.stop()
    const rows = await h.rows(schema, 'test.cut')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.state).toBe('retry')
    expect(JSON.stringify(rows[0]!.output)).toContain('shut down while active')

    dying = false
    await h.start({
      schema,
      definitions: [def({ name: 'test.cut', retryLimit: 2, retryDelaySeconds: 1, handler })],
    })
    await h.waitFor(async () => (await h.states(schema, 'test.cut')).includes('completed'), 30_000)
    expect(effects).toEqual([1])
  })
})

describe('queue and schedule upkeep', () => {
  it('registers cron schedules in the business timezone and removes the schedule of a job that lost its cron', async () => {
    const schema = h.newSchema()
    const noop = async (): Promise<void> => undefined
    const cron = (name: string, c?: string) => def({ name, ...(c ? { cron: c } : {}), handler: noop })
    const first = await h.start({
      schema,
      definitions: [cron('test.a', '*/5 * * * *'), cron('test.b', '0 4 * * *')],
    })
    const read = async () =>
      (
        await sql<{
          name: string
          cron: string
          timezone: string
        }>`select name, cron, timezone from ${sql.table(`${schema}.schedule`)} order by name`.execute(h.t.db)
      ).rows
    expect(await read()).toEqual([
      { name: 'test.a', cron: '*/5 * * * *', timezone: 'America/New_York' },
      { name: 'test.b', cron: '0 4 * * *', timezone: 'America/New_York' },
    ])
    await first.stop()
    await h.start({ schema, definitions: [cron('test.a', '*/10 * * * *'), cron('test.b')] })
    expect(await read()).toEqual([{ name: 'test.a', cron: '*/10 * * * *', timezone: 'America/New_York' }])
  })

  it('re-applies queue options on start, so a changed retry limit or policy reaches an existing queue', async () => {
    const schema = h.newSchema()
    const noop = async (): Promise<void> => undefined
    const first = await h.start({
      schema,
      definitions: [def({ name: 'test.opts', retryLimit: 1, policy: 'singleton', handler: noop })],
    })
    const read = async () =>
      (
        await sql<{
          retry_limit: number
          policy: string
          dead_letter: string | null
        }>`select retry_limit, policy, dead_letter from ${sql.table(`${schema}.queue`)} where name = 'test.opts'`.execute(
          h.t.db,
        )
      ).rows[0]
    expect(await read()).toEqual({ retry_limit: 1, policy: 'singleton', dead_letter: 'test.opts.dead' })
    await first.stop()
    await h.start({
      schema,
      definitions: [def({ name: 'test.opts', retryLimit: 5, policy: 'stately', handler: noop })],
    })
    expect(await read()).toEqual({ retry_limit: 5, policy: 'stately', dead_letter: 'test.opts.dead' })
  })

  it('fires a cron schedule by itself within a minute and a half', async () => {
    let fired = 0
    const w = await h.start({
      definitions: [def({ name: 'test.cron', cron: '* * * * *', handler: async () => void (fired += 1) })],
      boss: { maintenanceIntervalSeconds: 1, cronMonitorIntervalSeconds: 5 },
    })
    await h.waitFor(async () => (await h.states(w.schema, 'test.cron')).includes('completed'), 100_000)
    expect(fired).toBeGreaterThanOrEqual(1)
  }, 120_000)

  it('status() shows next run, queue depth, last run and failures per job', async () => {
    const schema = h.newSchema()
    const w = await h.start({
      schema,
      definitions: [
        def({ name: 'test.nightly', cron: '30 3 * * *', handler: async () => undefined }),
        def({ name: 'test.later', handler: async () => undefined }),
      ],
    })
    const sched = await w.jobs.status!()
    const nightly = sched.jobs.find((j) => j.name === 'test.nightly')!
    expect(nightly).toMatchObject({
      cron: '30 3 * * *',
      tz: 'America/New_York',
      runs: 0,
      lastOutcome: null,
      queued: 0,
    })
    expect(nightly.nextRunAt).not.toBeNull()
    expect(new Date(nightly.nextRunAt!).getTime()).toBeGreaterThan(Date.now())
    // the nominal next fire is the 03:30 New York wall time
    const next = new Date(nightly.nextRunAt!)
    expect(next.getTime()).toBe(nextCronRun('30 3 * * *', 'America/New_York', new Date()).getTime())

    // a delayed job is "scheduled", not "queued", and is the job's next run
    const at = new Date(Date.now() + 3_600_000)
    await w.jobs.enqueue('test.later', {}, { startAfter: at })
    const after = await w.jobs.status!()
    const later = after.jobs.find((j) => j.name === 'test.later')!
    expect(later).toMatchObject({ queued: 0, scheduled: 1, active: 0 })
    expect(new Date(later.nextRunAt!).getTime()).toBe(at.getTime())
    expect(after.queue.scheduled).toBe(1)
  })

  it('health() reports the queue and whether the worker has run lately', async () => {
    const w = await h.start({ definitions: [def({ name: 'test.h', handler: async () => undefined })] })
    expect(await w.jobs.health()).toMatchObject({
      ok: true,
      worker: { state: 'unknown', lastRunAt: null },
      queue: { queued: 0, failed: 0, deadLetter: 0 },
    })
    await w.jobs.enqueue('test.h', {})
    await h.waitFor(async () => (await h.states(w.schema, 'test.h')).includes('completed'))
    expect(await w.jobs.health()).toMatchObject({ ok: true, worker: { state: 'ok' } })
    h.clock.advance(11 * 60_000)
    expect(await w.jobs.health()).toMatchObject({ ok: true, worker: { state: 'stale' } })
    expect((await w.jobs.health()).detail).toContain('worker stale')
  })
})
