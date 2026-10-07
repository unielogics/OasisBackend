// pg-boss bootstrap (Postgres-backed queue, schema "pgboss"). Jobs are idempotent and named <area>.<action>.
//
// What this layer adds on top of pg-boss:
//   - every queue gets a dead-letter queue "<name>.dead": a job whose retries are exhausted is copied there (visible in
//     GET /api/v1/system/jobs) besides staying in its own queue as state=failed;
//   - queue options are re-applied on every start (pg-boss createQueue is "insert if missing"), and schedules that no
//     longer belong to a definition are removed;
//   - every run is logged at start and finish (job name, job id, attempt, duration: never the payload) and recorded in
//     job_runs, which is what "last run / last success / last error" are read from;
//   - the final failure of a job (retries exhausted) is reported through onDeadLetter, once per failure streak;
//   - stop() drains: running handlers get shutdownTimeoutMs to finish, the rest are failed back to the queue for retry.
import { performance } from 'node:perf_hooks'
import PgBoss from 'pg-boss'
import { sql } from 'kysely'
import { systemClock, type Clock } from './clock.js'
import { assertIdentifier, type Db } from './db.js'
import { assertValidCron, nextCronRun } from './jobs-cron.js'
import './jobs-schema.js'
import { maskText, type Logger } from './logging.js'

export interface JobContext {
  db: Db
  clock: Clock
  logger: Logger
}

export interface JobDefinition<Data extends object = Record<string, never>> {
  name: string
  /** Five-field cron in the business tz; omit for queue-only jobs enqueued by code. */
  cron?: string
  tz?: string
  /**
   * Queue policy: 'short' keeps at most one queued job per singletonKey, 'singleton' one active job per key, 'stately' one
   * queued and one active job per key (the right choice for a periodic job: no overlap and no backlog after downtime).
   * The default 'standard' never collapses jobs.
   */
  policy?: 'standard' | 'short' | 'singleton' | 'stately'
  retryLimit?: number
  retryDelaySeconds?: number
  /** A job still active after this long is failed by pg-boss and retried (a crashed worker is detected this way). */
  expireInSeconds?: number
  handler(ctx: JobContext, data: Data, job: { id: string }): Promise<void>
}

export interface EnqueueOptions {
  /** Collapses duplicates when the queue policy is short, singleton or stately (see JobDefinition.policy). */
  singletonKey?: string
  startAfter?: Date | number
}

export interface QueueSummary {
  /** Waiting to run: created or waiting for a retry, due now. */
  queued: number
  /** Created with a start time in the future (delayed jobs, retries backing off). */
  scheduled: number
  active: number
  /** Failed rows pg-boss still retains for the queues (retries exhausted). */
  failed: number
  /** Rows in the dead-letter queues. */
  deadLetter: number
  oldestQueuedAgeSeconds: number | null
}

export interface WorkerLiveness {
  /** ok: a job finished within the last 10 minutes; stale: jobs have run but none recently; unknown: none ever ran. */
  state: 'ok' | 'stale' | 'unknown'
  lastRunAt: string | null
}

export interface JobsHealth {
  ok: boolean
  detail: string
  queue?: QueueSummary
  worker?: WorkerLiveness
}

export interface JobStatusRow {
  name: string
  cron: string | null
  tz: string | null
  policy: string
  retryLimit: number
  retryDelaySeconds: number
  expireInSeconds: number | null
  /** The next scheduled fire (cron) or the earliest delayed job; null when nothing is pending. */
  nextRunAt: string | null
  lastStartedAt: string | null
  lastFinishedAt: string | null
  lastSuccessAt: string | null
  lastErrorAt: string | null
  lastError: string | null
  lastDurationMs: number | null
  lastOutcome: 'running' | 'completed' | 'failed' | null
  runs: number
  failures: number
  consecutiveFailures: number
  queued: number
  scheduled: number
  active: number
  failed: number
  deadLetter: number
}

export interface JobsStatus {
  enabled: boolean
  generatedAt: string
  queue: QueueSummary
  worker: WorkerLiveness
  jobs: JobStatusRow[]
}

export interface Jobs {
  /** Starts the queue; with workers=true also registers handlers and cron schedules (the worker process). */
  start(opts: { workers: boolean }): Promise<void>
  enqueue(name: string, data?: object, opts?: EnqueueOptions): Promise<string | null>
  health(): Promise<JobsHealth>
  /** Per-job state for GET /api/v1/system/jobs. */
  status?(): Promise<JobsStatus>
  stop(): Promise<void>
}

export interface DeadLetterInfo {
  name: string
  jobId: string
  attempts: number
  error: string
}

export interface JobsConfig {
  connectionString: string
  schema?: string
  db: Db
  clock: Clock
  logger: Logger
  enabled: boolean
  definitions: readonly JobDefinition<never>[]
  tz: string
  pollSeconds?: number
  /** How long stop() lets running handlers finish before failing them back to the queue. Default 30 s. */
  shutdownTimeoutMs?: number
  /** Extra pg-boss constructor options (tests shorten the maintenance interval); merged over the defaults. */
  boss?: Partial<PgBoss.ConstructorOptions>
  /** Called once per failure streak when a job exhausts its retries. Errors thrown here are logged and ignored. */
  onDeadLetter?: (info: DeadLetterInfo) => Promise<void>
}

export const deadLetterQueueOf = (name: string): string => `${name}.dead`

/** Dead-letter rows are kept for 30 days. */
const DEAD_LETTER_RETENTION_MINUTES = 30 * 24 * 60
const WORKER_STALE_MS = 10 * 60_000
const MAX_ERROR_LENGTH = 500

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null)

export function createJobs(cfg: JobsConfig): Jobs {
  if (!cfg.enabled) {
    return {
      start: async () => undefined,
      enqueue: async (name) => {
        cfg.logger.debug({ job: name }, 'JOBS_ENABLED=false: job not enqueued')
        return null
      },
      health: async () => ({ ok: true, detail: 'disabled' }),
      status: async () => ({
        enabled: false,
        generatedAt: cfg.clock.now().toISOString(),
        queue: emptyQueue(),
        worker: { state: 'unknown', lastRunAt: null },
        jobs: [],
      }),
      stop: async () => undefined,
    }
  }

  const schema = assertIdentifier(cfg.schema ?? 'pgboss')
  const boss = new PgBoss({
    connectionString: cfg.connectionString,
    schema,
    application_name: 'oasis-jobs',
    max: 4,
    // a crashed worker is noticed when the maintenance pass fails its expired active jobs
    maintenanceIntervalSeconds: 60,
    ...cfg.boss,
  })
  boss.on('error', (err: Error) => cfg.logger.error({ err: err.message }, 'pg-boss error'))
  let started = false
  const ctx: JobContext = { db: cfg.db, clock: cfg.clock, logger: cfg.logger }
  const defs = cfg.definitions as readonly JobDefinition<object>[]
  const tbl = (name: string) => sql.table(`${schema}.${name}`)

  async function recordStart(name: string, jobId: string, attempt: number, at: Date): Promise<void> {
    await cfg.db
      .insertInto('job_runs')
      .values({
        name,
        runs: 1,
        last_job_id: jobId,
        last_attempt: attempt,
        last_outcome: 'running',
        last_started_at: at,
        updated_at: at,
      })
      .onConflict((oc) =>
        oc.column('name').doUpdateSet((eb) => ({
          runs: eb('job_runs.runs', '+', 1),
          last_job_id: jobId,
          last_attempt: attempt,
          last_outcome: 'running',
          last_started_at: at,
          updated_at: at,
        })),
      )
      .execute()
  }

  /** Returns the failure streak length after this attempt (0 after a success). */
  async function recordFinish(
    name: string,
    at: Date,
    durationMs: number,
    failure: string | null,
  ): Promise<number> {
    const r = await cfg.db
      .updateTable('job_runs')
      .set((eb) =>
        failure === null
          ? {
              last_outcome: 'completed' as const,
              last_finished_at: at,
              last_success_at: at,
              last_duration_ms: durationMs,
              consecutive_failures: 0,
              updated_at: at,
            }
          : {
              last_outcome: 'failed' as const,
              last_finished_at: at,
              last_error_at: at,
              last_error: failure,
              last_duration_ms: durationMs,
              failures: eb('failures', '+', 1),
              consecutive_failures: eb('consecutive_failures', '+', 1),
              updated_at: at,
            },
      )
      .where('name', '=', name)
      .returning('consecutive_failures')
      .executeTakeFirst()
    return r?.consecutive_failures ?? 0
  }

  async function runOne(def: JobDefinition<object>, job: PgBoss.JobWithMetadata<object>): Promise<void> {
    const log = cfg.logger.child({ job: def.name, jobId: job.id })
    const attempt = job.retryCount + 1
    const began = performance.now()
    log.info({ attempt, retryLimit: job.retryLimit }, 'job started')
    await recordStart(def.name, job.id, attempt, cfg.clock.now()).catch((err: Error) =>
      log.warn({ err: err.message }, 'job_runs: start not recorded'),
    )
    try {
      await def.handler({ ...ctx, logger: log }, job.data as never, { id: job.id })
    } catch (err) {
      const durationMs = Math.round(performance.now() - began)
      const message = maskText((err as Error).message ?? String(err)).slice(0, MAX_ERROR_LENGTH)
      const final = job.retryCount >= job.retryLimit
      log.error({ attempt, durationMs, final, err: message }, 'job failed')
      const streak = await recordFinish(def.name, cfg.clock.now(), durationMs, message).catch((e: Error) => {
        log.warn({ err: e.message }, 'job_runs: failure not recorded')
        return 0
      })
      // once per failure streak: the attempt that ends the first exhausted retry cycle after a success
      if (final && cfg.onDeadLetter && streak === job.retryLimit + 1)
        await cfg
          .onDeadLetter({ name: def.name, jobId: job.id, attempts: attempt, error: message })
          .catch((e: Error) => log.warn({ err: e.message }, 'dead-letter notification failed'))
      throw err
    }
    const durationMs = Math.round(performance.now() - began)
    log.info({ attempt, durationMs }, 'job finished')
    await recordFinish(def.name, cfg.clock.now(), durationMs, null).catch((e: Error) =>
      log.warn({ err: e.message }, 'job_runs: finish not recorded'),
    )
  }

  async function queueCounts(): Promise<
    Map<
      string,
      {
        queued: number
        scheduled: number
        active: number
        failed: number
        oldest: Date | null
        nextAt: Date | null
      }
    >
  > {
    const wall = systemClock.now()
    const r = await sql<{
      name: string
      queued: number
      scheduled: number
      active: number
      failed: number
      oldest: Date | null
      next_at: Date | null
    }>`
      select name,
        count(*) filter (where state in ('created', 'retry') and start_after <= ${wall})::int as queued,
        count(*) filter (where state in ('created', 'retry') and start_after > ${wall})::int as scheduled,
        count(*) filter (where state = 'active')::int as active,
        count(*) filter (where state = 'failed')::int as failed,
        min(created_on) filter (where state in ('created', 'retry') and start_after <= ${wall}) as oldest,
        min(start_after) filter (where state in ('created', 'retry') and start_after > ${wall}) as next_at
      from ${tbl('job')} group by name`.execute(cfg.db)
    return new Map(
      r.rows.map((x) => [
        x.name,
        {
          queued: x.queued,
          scheduled: x.scheduled,
          active: x.active,
          failed: x.failed,
          oldest: x.oldest,
          nextAt: x.next_at,
        },
      ]),
    )
  }

  async function workerLiveness(): Promise<WorkerLiveness> {
    const r = await cfg.db
      .selectFrom('job_runs')
      .select((eb) => eb.fn.max('last_finished_at').as('last'))
      .executeTakeFirst()
    const last = r?.last ?? null
    if (!last) return { state: 'unknown', lastRunAt: null }
    const fresh = cfg.clock.now().getTime() - new Date(last).getTime() <= WORKER_STALE_MS
    return { state: fresh ? 'ok' : 'stale', lastRunAt: new Date(last).toISOString() }
  }

  function summarize(counts: Awaited<ReturnType<typeof queueCounts>>): QueueSummary {
    const own = defs.map((d) => counts.get(d.name))
    const dead = defs.map((d) => counts.get(deadLetterQueueOf(d.name)))
    const wall = systemClock.now().getTime()
    const oldest = own.reduce<number | null>((acc, c) => {
      if (!c?.oldest) return acc
      const t = new Date(c.oldest).getTime()
      return acc === null || t < acc ? t : acc
    }, null)
    const sum = (f: (c: NonNullable<(typeof own)[number]>) => number): number =>
      own.reduce((n, c) => n + (c ? f(c) : 0), 0)
    return {
      queued: sum((c) => c.queued),
      scheduled: sum((c) => c.scheduled),
      active: sum((c) => c.active),
      failed: sum((c) => c.failed),
      deadLetter: dead.reduce((n, c) => n + (c ? c.queued + c.scheduled + c.active + c.failed : 0), 0),
      oldestQueuedAgeSeconds: oldest === null ? null : Math.max(0, Math.round((wall - oldest) / 1000)),
    }
  }

  return {
    async start({ workers }) {
      await boss.start()
      started = true
      for (const def of defs) {
        const dead = deadLetterQueueOf(def.name)
        await boss.createQueue(dead, {
          name: dead,
          policy: 'standard',
          retryLimit: 0,
          retentionMinutes: DEAD_LETTER_RETENTION_MINUTES,
        })
        const options = {
          name: def.name,
          policy: def.policy ?? 'standard',
          retryLimit: def.retryLimit ?? 3,
          retryDelay: def.retryDelaySeconds ?? 30,
          retryBackoff: true,
          deadLetter: dead,
          ...(def.expireInSeconds ? { expireInSeconds: def.expireInSeconds } : {}),
        } as const
        await boss.createQueue(def.name, options)
        // createQueue only inserts when missing: re-apply so a changed definition reaches an existing deployment
        await boss.updateQueue(def.name, options)
      }
      if (!workers) return
      const wanted = new Set<string>()
      for (const def of defs) {
        await boss.work(
          def.name,
          { pollingIntervalSeconds: cfg.pollSeconds ?? 2, includeMetadata: true },
          async (jobs: PgBoss.JobWithMetadata<object>[]) => {
            for (const job of jobs) await runOne(def, job)
          },
        )
        if (def.cron) {
          assertValidCron(def.cron, def.tz ?? cfg.tz)
          wanted.add(def.name)
          await boss.schedule(def.name, def.cron, {}, { tz: def.tz ?? cfg.tz })
        }
      }
      for (const s of await boss.getSchedules()) if (!wanted.has(s.name)) await boss.unschedule(s.name)
    },
    async enqueue(name, data = {}, opts = {}) {
      if (!started) throw new Error('jobs are not started')
      return boss.send(name, data, {
        ...(opts.singletonKey ? { singletonKey: opts.singletonKey } : {}),
        ...(opts.startAfter ? { startAfter: opts.startAfter } : {}),
      })
    },
    async health() {
      if (!started) return { ok: false, detail: 'not started' }
      try {
        const queue = summarize(await queueCounts())
        const worker = await workerLiveness()
        return {
          ok: true,
          detail: `${queue.queued} queued, ${queue.active} active, ${queue.failed} failed, ${queue.deadLetter} dead-lettered; worker ${worker.state}`,
          queue,
          worker,
        }
      } catch (e) {
        return { ok: false, detail: (e as Error).message }
      }
    },
    async status() {
      if (!started) throw new Error('jobs are not started')
      const wall = systemClock.now()
      const counts = await queueCounts()
      const runs = new Map(
        (await cfg.db.selectFrom('job_runs').selectAll().execute()).map((r) => [r.name, r]),
      )
      const schedules = new Map(
        ((await boss.getSchedules()) as Array<PgBoss.Schedule & { timezone: string }>).map((s) => [
          s.name,
          s,
        ]),
      )
      const queues = new Map((await boss.getQueues()).map((q) => [q.name, q]))
      const rows: JobStatusRow[] = defs
        .map((def) => {
          const c = counts.get(def.name)
          const d = counts.get(deadLetterQueueOf(def.name))
          const run = runs.get(def.name)
          const q = queues.get(def.name)
          const sched = schedules.get(def.name)
          const cronNext = sched ? nextCronRun(sched.cron, sched.timezone, wall) : null
          const delayed = c?.nextAt ? new Date(c.nextAt) : null
          const next = [cronNext, delayed]
            .filter((x): x is Date => x !== null)
            .sort((a, b) => a.getTime() - b.getTime())[0]
          return {
            name: def.name,
            cron: sched?.cron ?? def.cron ?? null,
            tz: sched?.timezone ?? (def.cron ? (def.tz ?? cfg.tz) : null),
            policy: q?.policy ?? def.policy ?? 'standard',
            retryLimit: q?.retryLimit ?? def.retryLimit ?? 3,
            retryDelaySeconds: q?.retryDelay ?? def.retryDelaySeconds ?? 30,
            expireInSeconds: q?.expireInSeconds ?? def.expireInSeconds ?? null,
            nextRunAt: iso(next),
            lastStartedAt: iso(run?.last_started_at),
            lastFinishedAt: iso(run?.last_finished_at),
            lastSuccessAt: iso(run?.last_success_at),
            lastErrorAt: iso(run?.last_error_at),
            lastError: run?.last_error ?? null,
            lastDurationMs: run?.last_duration_ms ?? null,
            lastOutcome: run?.last_outcome ?? null,
            runs: run?.runs ?? 0,
            failures: run?.failures ?? 0,
            consecutiveFailures: run?.consecutive_failures ?? 0,
            queued: c?.queued ?? 0,
            scheduled: c?.scheduled ?? 0,
            active: c?.active ?? 0,
            failed: c?.failed ?? 0,
            deadLetter: d ? d.queued + d.scheduled + d.active + d.failed : 0,
          }
        })
        .sort((a, b) => a.name.localeCompare(b.name))
      return {
        enabled: true,
        generatedAt: cfg.clock.now().toISOString(),
        queue: summarize(counts),
        worker: await workerLiveness(),
        jobs: rows,
      }
    },
    async stop() {
      if (started) await boss.stop({ graceful: true, timeout: cfg.shutdownTimeoutMs ?? 30_000, close: true })
      started = false
    },
  }
}

function emptyQueue(): QueueSummary {
  return { queued: 0, scheduled: 0, active: 0, failed: 0, deadLetter: 0, oldestQueuedAgeSeconds: null }
}
