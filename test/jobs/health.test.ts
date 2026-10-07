// /healthz, /readyz and GET /api/v1/system/jobs against a real pg-boss schema: the queue and database state they report, the
// permission on the jobs page, and the logger accepting both `{ err }` shapes the code base uses.
import { afterEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { buildApp } from '../../src/app.js'
import { createDenyAuthorizer } from '../../src/http/authorizer.js'
import { jobDefinitions } from '../../src/platform/job-registry.js'
import { createJobs, type Jobs } from '../../src/platform/jobs.js'
import { createDb } from '../../src/platform/db.js'
import { createLogger } from '../../src/platform/logging.js'
import { FixedClock } from '../../src/platform/clock.js'
import { loadEnv } from '../../src/config/env.js'
import { systemModule } from '../../src/modules/system/index.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { useTestDb } from '../helpers/db.js'
import { testDatabaseUrl } from '../helpers/env.js'

const t = useTestDb()
let jobs: Jobs | undefined
let app: TestApp | undefined
const schema = (): string => `pgb7_health_${t.schema}`.slice(0, 63)

afterEach(async () => {
  await app?.close()
  app = undefined
  await jobs?.stop()
  jobs = undefined
  await sql`drop schema if exists ${sql.id(schema())} cascade`.execute(t.db)
})

async function boot(): Promise<TestApp> {
  jobs = createJobs({
    connectionString: testDatabaseUrl(),
    schema: schema(),
    db: t.db,
    clock: t.clock,
    logger: createLogger({ level: 'silent' }),
    enabled: true,
    definitions: jobDefinitions,
    tz: 'America/New_York',
  })
  await jobs.start({ workers: false })
  app = await createTestApp({ testDb: t, modules: [systemModule], deps: { jobs } })
  return app
}

describe('/healthz and /readyz', () => {
  it('report the database and the queue, with every job queue created by the API', async () => {
    const { app: a } = await boot()
    const health = await a.inject({ url: '/healthz', headers: { 'x-test-anonymous': '1' } })
    expect(health.statusCode).toBe(200)
    expect(health.json()).toMatchObject({
      status: 'ok',
      checks: {
        db: { ok: true },
        jobs: {
          ok: true,
          queue: {
            queued: 0,
            scheduled: 0,
            active: 0,
            failed: 0,
            deadLetter: 0,
            oldestQueuedAgeSeconds: null,
          },
          worker: { state: 'unknown', lastRunAt: null },
        },
      },
    })
    const ready = await a.inject({ url: '/readyz' })
    expect(ready.statusCode).toBe(200)
    expect(ready.json().checks.jobs.queue).toMatchObject({ failed: 0, deadLetter: 0 })
    const queues = (
      await sql<{ name: string }>`select name from ${sql.table(`${schema()}.queue`)}`.execute(t.db)
    ).rows.map((q) => q.name)
    for (const d of jobDefinitions) {
      expect(queues, d.name).toContain(d.name)
      expect(queues, `${d.name}.dead`).toContain(`${d.name}.dead`)
    }
  })

  it('counts queued work, and a stale worker is reported without making the API unready', async () => {
    const { app: a } = await boot()
    await jobs!.enqueue('appointments.reminders', {})
    await t.db
      .insertInto('job_runs')
      .values({
        name: 'appointments.late_scan',
        last_outcome: 'completed',
        last_started_at: t.clock.now(),
        last_finished_at: new Date(t.clock.now().getTime() - 3_600_000),
      })
      .execute()
    const ready = await a.inject({ url: '/readyz' })
    expect(ready.statusCode).toBe(200)
    expect(ready.json().checks.jobs).toMatchObject({
      ok: true,
      queue: { queued: 1 },
      worker: { state: 'stale' },
    })
    expect(ready.json().checks.jobs.queue.oldestQueuedAgeSeconds).toEqual(expect.any(Number))
  })

  it('/healthz stays 200 and says degraded when the database is unreachable', async () => {
    const dead = createDb({ url: 'postgres://oasis:x@127.0.0.1:1/none', poolMax: 1 })
    try {
      const a = await buildApp({
        env: loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x' }),
        db: dead,
        clock: new FixedClock('2026-06-13T14:36:00Z'),
        authorizer: createDenyAuthorizer(),
        modules: [],
        hookModules: [],
        logStream: { write: () => undefined },
      })
      const res = await a.inject({ url: '/healthz' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({
        status: 'degraded',
        checks: { db: { ok: false }, jobs: { ok: false } },
      })
      await a.close()
    } finally {
      await dead.destroy()
    }
  })
})

describe('GET /api/v1/system/jobs', () => {
  it('lists every registered job with its schedule and counts, and needs set.billing', async () => {
    const { app: a } = await boot()
    await t.db
      .insertInto('job_runs')
      .values({
        name: 'maintenance.purge',
        runs: 3,
        failures: 1,
        last_job_id: 'x',
        last_outcome: 'completed',
        last_started_at: new Date('2026-06-13T14:30:00Z'),
        last_finished_at: new Date('2026-06-13T14:30:01Z'),
        last_success_at: new Date('2026-06-13T14:30:01Z'),
        last_error_at: new Date('2026-06-13T14:00:00Z'),
        last_error: 'boom',
        last_duration_ms: 1000,
      })
      .execute()
    const denied = await a.inject({
      url: '/api/v1/system/jobs',
      headers: { 'x-test-permissions': 'sched.view' },
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toMatchObject({ code: 'FORBIDDEN' })
    expect(
      (await a.inject({ url: '/api/v1/system/jobs', headers: { 'x-test-anonymous': '1' } })).statusCode,
    ).toBe(401)

    const res = await a.inject({
      url: '/api/v1/system/jobs',
      headers: { 'x-test-permissions': 'set.billing' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      enabled: boolean
      jobs: Array<Record<string, unknown>>
      worker: { state: string }
    }
    expect(body.enabled).toBe(true)
    expect(body.jobs.map((j) => j.name)).toEqual(jobDefinitions.map((j) => j.name).sort())
    const purge = body.jobs.find((j) => j.name === 'maintenance.purge')!
    expect(purge).toMatchObject({
      lastOutcome: 'completed',
      lastSuccessAt: '2026-06-13T14:30:01.000Z',
      lastErrorAt: '2026-06-13T14:00:00.000Z',
      lastError: 'boom',
      lastDurationMs: 1000,
      runs: 3,
      failures: 1,
    })
    expect(body.worker.state).toBe('ok') // the frozen clock is six minutes after that run finished
  })

  it('answers {enabled:false} when no queue is configured', async () => {
    app = await createTestApp({ testDb: t, modules: [systemModule] })
    const res = await app.app.inject({ url: '/api/v1/system/jobs' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ enabled: false, jobs: [], worker: { state: 'unknown' } })
  })
})

describe('the logger', () => {
  it('accepts both shapes of { err }: an Error and its message', () => {
    const lines: string[] = []
    const log = createLogger({ level: 'info' }, { write: (l: string) => void lines.push(l) })
    expect(() => log.warn({ err: 'could not text +13055550123' }, 'plain')).not.toThrow()
    expect(() => log.error({ err: new Error('failed for maria@example.com') }, 'real')).not.toThrow()
    expect(() => log.warn({ err: undefined, other: 1 }, 'none')).not.toThrow()
    const joined = lines.join('\n')
    expect(joined).toContain('plain')
    expect(joined).toContain('real')
    expect(joined).not.toContain('3055550123')
    expect(joined).not.toContain('maria@example.com')
  })
})
