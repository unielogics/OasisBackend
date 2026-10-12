// Square jobs (ADR 0171), registered in src/platform/job-registry.ts and described in src/platform/jobs-catalog.ts:
//   square.event.process   queue only (POST /hooks/square, singleton per event id): re-fetch the event's object and dispatch it
//   square.events.catchup  every 10 minutes: SearchEvents from the watermark minus 10 minutes, same webhook_log claim, inline processing
//   square.reconcile       nightly 03:45: payments and refunds of the last 72 hours, counted into square_state
// The catch-up and the reconcile do nothing unless SQUARE_PROVIDER=live with a token and a location (the defaults keep them idle).
import type { JobDefinition } from '../../../platform/jobs.js'
import { createIdGenerator } from '../../../platform/ids.js'
import { runSquareCatchup } from '../catchup.js'
import { processLoggedEvent, type SquareEventDeps } from '../events.js'
import { runSquareReconcile } from '../reconcile.js'
import { squareApi, squareEnv, squareIngest } from '../runtime.js'

function deps(ctx: Parameters<JobDefinition['handler']>[0]): SquareEventDeps {
  const env = squareEnv()
  return { db: ctx.db, clock: ctx.clock, logger: ctx.logger, env, api: squareApi(env), ingest: squareIngest(), newId: createIdGenerator(ctx.clock) }
}

export interface SquareEventJobData {
  eventId: string
}

export const squareEventJob: JobDefinition<SquareEventJobData> = {
  name: 'square.event.process',
  policy: 'standard',
  retryLimit: 5,
  retryDelaySeconds: 30,
  expireInSeconds: 5 * 60,
  async handler(ctx, data) {
    const r = await processLoggedEvent(deps(ctx), data.eventId)
    ctx.logger.info({ square: { event: data.eventId, result: r } }, 'square.event.process done')
  },
}

export const squareCatchupJob: JobDefinition = {
  name: 'square.events.catchup',
  policy: 'stately',
  cron: '*/10 * * * *',
  retryLimit: 0,
  expireInSeconds: 9 * 60,
  async handler(ctx) {
    const r = await runSquareCatchup(deps(ctx))
    if (r.status === 'skipped') ctx.logger.debug({ reason: r.reason }, 'square.events.catchup skipped')
    else ctx.logger.info({ square: r }, 'square.events.catchup done')
  },
}

export const squareReconcileJob: JobDefinition = {
  name: 'square.reconcile',
  policy: 'stately',
  cron: '45 3 * * *',
  retryLimit: 1,
  expireInSeconds: 30 * 60,
  async handler(ctx) {
    const r = await runSquareReconcile(deps(ctx))
    if (r.status === 'skipped') ctx.logger.debug({ reason: r.reason }, 'square.reconcile skipped')
  },
}

export const squareJobs = [squareEventJob, squareCatchupJob, squareReconcileJob] as const
