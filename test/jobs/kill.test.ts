// A worker process killed with SIGKILL in the middle of a job: pg-boss notices the abandoned job when it expires, retries it
// on another worker, and the retry produces no second effect because the job is idempotent.
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { jobRuntime } from '../../src/modules/messaging/jobs/index.js'
import { runReminders } from '../../src/modules/messaging/jobs/reminders.js'
import { jobDefinitions } from '../../src/platform/job-registry.js'
import { createJobs, type JobDefinition } from '../../src/platform/jobs.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { useWorld } from '../messaging-db/world.js'
import { useJobsHarness } from './harness.js'

const w = useWorld({ start: '2026-06-12T14:00:00-04:00' })
const h = useJobsHarness({ testDb: () => w.t })
const children: ChildProcess[] = []

afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL')
})

const saved: Record<string, string | undefined> = {}
beforeAll(() => {
  for (const [k, v] of Object.entries({
    DATABASE_URL: testDatabaseUrl(),
    DB_SEARCH_PATH: `${w.t.schema},public`,
    SMS_ALLOWLIST: w.env.SMS_ALLOWLIST,
    SMSGATE_MIN_INTERVAL_MS: '0',
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

function spawnWorker(schema: string): {
  child: ChildProcess
  output: () => string
  saw: (text: string, ms?: number) => Promise<void>
} {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.resolve('test/jobs/fixtures/child-worker.ts')],
    {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        CHILD_WORKER: '1',
        DATABASE_URL: testDatabaseUrl(),
        DB_SEARCH_PATH: `${w.t.schema},public`,
        PGBOSS_SCHEMA: schema,
        CLOCK_FREEZE_AT: w.clock.now().toISOString(),
        LOG_LEVEL: 'warn',
        JOBS_ENABLED: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(child)
  let out = ''
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()))
  child.stderr!.on('data', (d: Buffer) => (out += d.toString()))
  return {
    child,
    output: () => out,
    saw: (text, ms = 60_000) =>
      h
        .waitFor(
          async () =>
            out.includes(text)
              ? true
              : child.exitCode !== null
                ? Promise.reject(new Error(`worker exited: ${out}`))
                : false,
          ms,
        )
        .then(() => undefined),
  }
}

describe('a worker killed mid-job', () => {
  it('kill -9 after the effect committed: the retry on another worker queues no second message', async () => {
    const id = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    const schema = h.newSchema()
    const doomed = spawnWorker(schema)
    await doomed.saw('WORKER_READY')

    const hanging = { name: 'test.reminders-then-hang' } as JobDefinition<never>
    const producer = createJobs({
      connectionString: testDatabaseUrl(),
      schema,
      db: w.t.db,
      clock: w.clock,
      logger: h.logger(),
      enabled: true,
      tz: 'America/New_York',
      definitions: [{ ...hanging, handler: async () => undefined } as JobDefinition<never>],
    })
    await producer.start({ workers: false })
    await producer.enqueue('test.reminders-then-hang', {})
    await doomed.saw('EFFECT_COMMITTED')
    doomed.child.kill('SIGKILL')
    await new Promise((r) => doomed.child.once('exit', r))

    const count = async () =>
      (await w.t.db.selectFrom('messages').select('id').where('appointment_id', '=', id).execute()).length
    expect(await count()).toBe(1) // the effect of the first attempt is there
    expect(await h.states(schema, 'test.reminders-then-hang')).toEqual(['active']) // and pg-boss never heard back

    // a surviving worker: the same job, finishing normally. pg-boss fails the abandoned job when it expires (3 s) and retries it.
    const retried: JobDefinition<never> = {
      name: 'test.reminders-then-hang',
      retryLimit: 3,
      retryDelaySeconds: 1,
      expireInSeconds: 3,
      handler: async (ctx: never) => void (await runReminders(jobRuntime(ctx as never))),
    } as JobDefinition<never>
    await producer.stop()
    await h.start({ schema, definitions: [retried] })
    const rows = await h.waitFor(async () => {
      const r = await h.rows(schema, 'test.reminders-then-hang')
      return r.length === 1 && r[0]!.state === 'completed' ? r : false
    }, 60_000)
    expect(rows[0]!.retry_count).toBe(1) // the second attempt did the job
    expect(await count()).toBe(1) // and queued nothing new
    expect(
      (await w.t.db.selectFrom('activity_log').select('text').where('appointment_id', '=', id).execute())
        .length,
    ).toBe(1)
  }, 120_000)

  it('the worker program (src/worker.ts) starts, runs a queued job, and exits 0 on SIGTERM after draining', async () => {
    const schema = h.newSchema()
    const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('src/worker.ts')], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: testDatabaseUrl(),
        DB_SEARCH_PATH: `${w.t.schema},public`,
        PGBOSS_SCHEMA: schema,
        CLOCK_FREEZE_AT: w.clock.now().toISOString(),
        LOG_LEVEL: 'info',
        JOBS_ENABLED: 'true',
        SMS_DISPATCH_MODE: 'off',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let out = ''
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr!.on('data', (d: Buffer) => (out += d.toString()))
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
    await h.waitFor(
      async () =>
        out.includes('worker started')
          ? true
          : child.exitCode !== null
            ? Promise.reject(new Error(out))
            : false,
      60_000,
    )

    const producer = createJobs({
      connectionString: testDatabaseUrl(),
      schema,
      db: w.t.db,
      clock: w.clock,
      logger: h.logger(),
      enabled: true,
      tz: 'America/New_York',
      definitions: jobDefinitions,
    })
    await producer.start({ workers: false })
    await producer.enqueue('maintenance.purge', {})
    await h.waitFor(async () => (await h.states(schema, 'maintenance.purge')).includes('completed'), 60_000)
    await producer.stop()

    child.kill('SIGTERM')
    expect(await exited).toBe(0)
    expect(out).toContain('worker stopping')
    expect(out).toContain('worker stopped')
    expect(out).not.toMatch(/\+1305\d{7}/)
  }, 150_000)
})
