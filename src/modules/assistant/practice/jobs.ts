// The practice chat's jobs (ADR 0174 §4c), registered in src/platform/job-registry.ts:
//   ai.practice                    queue-only: answers one practice turn (runner.ts) with the assistant runtime's model, judge, tool
//                                  registry and facts cache, the judge forced on and a read-only database pool for the tools. A
//                                  practice turn is a job because a turn can take longer than nginx's 60 s request limit. Works
//                                  whatever AI_ENABLED says; while AI_PRACTICE_ENABLED is off a queued turn fails (`practice_off`).
//   assistant.practice.retention   daily: deletes sessions older than 30 days (their turns with them) and fails turns stuck running.
import type { Env } from '../../../config/env.js'
import { loadEnv } from '../../../config/env.js'
import { createDb, type Db } from '../../../platform/db.js'
import { createIdGenerator } from '../../../platform/ids.js'
import type { JobContext, JobDefinition } from '../../../platform/jobs.js'
import { assistantJobRuntime } from '../jobs.js'
import { AI_PRACTICE_JOB, practiceConfig, runPracticeTurn, type PracticeDeps } from './runner.js'
import { failTurn, purgePractice } from './service.js'

export const PRACTICE_RETENTION_JOB = 'assistant.practice.retention'

export interface PracticeJobData {
  turnId: string
}

const readPools = new WeakMap<object, Db>()

/** The read-only pool of the process (two connections, every transaction READ ONLY), opened on first use. */
function readOnlyDb(ctx: JobContext, env: Env): Db {
  let db = readPools.get(ctx.db)
  if (!db) {
    db = createDb({
      url: env.DATABASE_URL,
      searchPath: env.DB_SEARCH_PATH,
      statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
      connectTimeoutMs: env.DB_CONNECT_TIMEOUT_MS,
      clock: ctx.clock,
      poolMax: 2,
      readOnly: true,
      applicationName: 'oasis-practice',
    })
    readPools.set(ctx.db, db)
  }
  return db
}

/** The practice deps of a job context: the assistant runtime's model, judge, registry and facts, the judge forced on. */
export function practiceJobDeps(ctx: JobContext, env: Env): PracticeDeps {
  const art = assistantJobRuntime(ctx)
  return {
    db: ctx.db,
    readDb: readOnlyDb(ctx, env),
    clock: ctx.clock,
    newId: createIdGenerator(ctx.clock),
    env,
    cfg: practiceConfig(env, art.cfg),
    provider: art.turnDeps.provider,
    judge: art.turnDeps.judge,
    registry: art.registry(),
    facts: art.deps.facts,
    log: ctx.logger,
  }
}

/** ai.practice's work (the deps are injectable for the tests). */
export async function handlePracticeJob(ctx: JobContext, data: Partial<PracticeJobData> | undefined, o: { env: Env; deps?: PracticeDeps }): Promise<void> {
  if (typeof data?.turnId !== 'string') return
  if (!o.env.AI_PRACTICE_ENABLED) {
    await failTurn(ctx.db, data.turnId, ctx.clock.now(), 'practice_off')
    return
  }
  const status = await runPracticeTurn(o.deps ?? practiceJobDeps(ctx, o.env), data.turnId)
  if (status) ctx.logger.info({ turn: data.turnId, status }, 'practice turn')
}

export const aiPracticeJob: JobDefinition<PracticeJobData> = {
  name: AI_PRACTICE_JOB,
  // every text is its own turn: never collapsed
  policy: 'standard',
  // a failed turn shows as failed; the owner texts again or presses "Try again"
  retryLimit: 0,
  // the turn's deadline is AI_TURN_DEADLINE_MS (60 s); a job still active after this died with its worker
  expireInSeconds: 180,
  handler: (ctx, data) => handlePracticeJob(ctx, data, { env: loadEnv() }),
}

export const practiceRetentionJob: JobDefinition = {
  name: PRACTICE_RETENTION_JOB,
  cron: '35 3 * * *',
  policy: 'stately',
  retryLimit: 1,
  async handler(ctx) {
    const r = await purgePractice(ctx.db, ctx.clock.now())
    if (r.sessions || r.stuck) ctx.logger.info(r, 'practice retention')
  },
}

export const practiceJobs: readonly JobDefinition<never>[] = [aiPracticeJob as JobDefinition<never>, practiceRetentionJob as JobDefinition<never>]
