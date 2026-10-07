// Shared harness of the background-job suites. Every test boots the REAL worker (src/worker.ts startWorker) against an
// isolated pg-boss schema (pgb7_<test schema>_<n>, dropped afterwards) and the frozen test clock; nothing here calls a
// handler directly unless a test says so.
import { afterEach, beforeEach } from 'vitest'
import { sql } from 'kysely'
import { loadEnv, type Env } from '../../src/config/env.js'
import type { FixedClock } from '../../src/platform/clock.js'
import type { JobDefinition } from '../../src/platform/jobs.js'
import { createLogger, type Logger } from '../../src/platform/logging.js'
import { startWorker, type RunningWorker, type WorkerOptions } from '../../src/worker.js'
import { useTestDb, type TestDb } from '../helpers/db.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { sleep } from '../helpers/sse.js'

export type Defs = readonly JobDefinition<never>[]

export interface JobsHarness {
  readonly t: TestDb
  readonly clock: FixedClock
  /** Captured log lines (info and above) of every worker started through the harness. */
  readonly logs: Array<Record<string, unknown>>
  /** A fresh pg-boss schema name for this test; dropped in afterEach. */
  newSchema(): string
  env(over?: Record<string, string>): Env
  /** Starts the real worker. Defaults: the given definitions, fast polling, a 1 s maintenance pass, the test clock. */
  start(
    o: { schema?: string; definitions: Defs } & Partial<Omit<WorkerOptions, 'env' | 'definitions'>> & {
        envOver?: Record<string, string>
      },
  ): Promise<RunningWorker & { schema: string }>
  /** pg-boss job states of a queue, oldest first. */
  states(schema: string, name: string): Promise<string[]>
  rows(
    schema: string,
    name: string,
  ): Promise<Array<{ id: string; state: string; retry_count: number; output: unknown; data: unknown }>>
  waitFor<T>(fn: () => Promise<T | undefined | false | null>, ms?: number): Promise<T>
  logger(): Logger
}

export function useJobsHarness(o: { testDb?: () => TestDb } = {}): JobsHarness {
  const own = o.testDb ? null : useTestDb()
  const tdb = (): TestDb => (o.testDb ? o.testDb() : own!)
  const logs: Array<Record<string, unknown>> = []
  const workers: RunningWorker[] = []
  const schemas: string[] = []
  let seq = 0

  beforeEach(() => {
    logs.length = 0
  })

  afterEach(async () => {
    for (const w of workers.splice(0)) await w.stop().catch(() => undefined)
    for (const s of schemas.splice(0)) await sql`drop schema if exists ${sql.id(s)} cascade`.execute(tdb().db)
  })

  const h: JobsHarness = {
    get t() {
      return tdb()
    },
    get clock() {
      return tdb().clock as FixedClock
    },
    logs,
    newSchema() {
      const s = `pgb7_${tdb().schema}_${++seq}`.slice(0, 63)
      schemas.push(s)
      return s
    },
    env(over = {}) {
      return loadEnv({
        NODE_ENV: 'test',
        DATABASE_URL: testDatabaseUrl(),
        LOG_LEVEL: 'info',
        ...over,
      })
    },
    logger() {
      return createLogger(
        { level: 'info' },
        { write: (line: string) => void logs.push(JSON.parse(line) as Record<string, unknown>) },
      )
    },
    async start(o) {
      const schema = o.schema ?? h.newSchema()
      if (!schemas.includes(schema)) schemas.push(schema)
      const { envOver, ...rest } = o
      delete (rest as { schema?: string }).schema
      const w = await startWorker({
        env: h.env({ PGBOSS_SCHEMA: schema, ...envOver }),
        db: tdb().db,
        clock: h.clock,
        logger: h.logger(),
        pollSeconds: 0.5,
        boss: { maintenanceIntervalSeconds: 1 },
        ...rest,
      })
      workers.push(w)
      return Object.assign(w, { schema })
    },
    async states(schema, name) {
      return (
        await sql<{
          state: string
        }>`select state from ${sql.table(`${schema}.job`)} where name = ${name} order by created_on, id`.execute(
          tdb().db,
        )
      ).rows.map((r) => r.state)
    },
    async rows(schema, name) {
      return (
        await sql<{ id: string; state: string; retry_count: number; output: unknown; data: unknown }>`
          select id, state, retry_count, output, data from ${sql.table(`${schema}.job`)} where name = ${name} order by created_on, id`.execute(
          tdb().db,
        )
      ).rows
    },
    async waitFor(fn, ms = 20_000) {
      const end = Date.now() + ms
      for (;;) {
        const v = await fn()
        if (v) return v
        if (Date.now() > end) {
          const errors = logs.filter((l) => l.level === 50 || l.level === 40).slice(-5)
          throw new Error(`timed out waiting for condition; recent errors: ${JSON.stringify(errors)}`)
        }
        await sleep(150)
      }
    },
  }
  return h
}
