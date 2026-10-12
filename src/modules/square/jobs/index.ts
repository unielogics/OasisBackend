// Square jobs (ADR 0171), registered in src/platform/job-registry.ts and described in src/platform/jobs-catalog.ts:
//   square.event.process   queue only (POST /hooks/square, singleton per event id): re-fetch the event's object and dispatch it
//   square.events.catchup  every 10 minutes: SearchEvents from the watermark minus 10 minutes, same webhook_log claim, inline processing
//   square.reconcile       nightly 03:45: payments and refunds of the last 72 hours, counted, and what was missed decided
//   square.payments.match  every minute: counter payments past SQUARE_MATCH_DELAY_SECONDS through the matcher (wave Q2b)
//   square.links.sweep     every minute: Square links that no longer match what is owed canceled and deleted at Square (wave Q2b)
//   square.deposit-link    every minute: a booking's deposit request becomes a texted quick-pay link (wave Q2b)
//   square.refunds.submit  every minute: card refunds through the Square API, the refund row being the outbox (wave Q2b)
// With the defaults nothing happens: the catch-up and the reconcile need SQUARE_PROVIDER=live; nothing reaches the matcher without
// them; links, deposits and refunds need PAYMENT_PROCESSOR=square and SQUARE_WRITES_ENABLED=true (none exist before).
import type { JobContext, JobDefinition } from '../../../platform/jobs.js'
import { createIdGenerator } from '../../../platform/ids.js'
import { getDefaultLocation } from '../../../platform/locations.js'
import { runSquareCatchup } from '../catchup.js'
import { runDepositLinks } from '../deposits.js'
import { processLoggedEvent, type SquareEventDeps } from '../events.js'
import { sweepSquareLinks } from '../links.js'
import { runSquareMatching } from '../match-runner.js'
import { runSquareReconcile } from '../reconcile.js'
import { runSquareRefunds } from '../refunds.js'
import { squareApi, squareEnv, squareIngest } from '../runtime.js'

function deps(ctx: JobContext): SquareEventDeps {
  const env = squareEnv()
  return { db: ctx.db, clock: ctx.clock, logger: ctx.logger, env, api: squareApi(env), ingest: squareIngest(), newId: createIdGenerator(ctx.clock) }
}

/** The deps plus the location (every per-location job); null before the seed made one. */
async function located(ctx: JobContext) {
  const location = await getDefaultLocation(ctx.db)
  return location ? { ...deps(ctx), locationId: location.id } : null
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

export const squareMatchJob: JobDefinition = {
  name: 'square.payments.match',
  policy: 'stately',
  cron: '* * * * *',
  retryLimit: 0,
  expireInSeconds: 5 * 60,
  async handler(ctx) {
    const d = await located(ctx)
    if (!d) return
    const r = await runSquareMatching(d)
    if (r.considered > 0) ctx.logger.info({ square: r }, 'square.payments.match done')
  },
}

export const squareLinksSweepJob: JobDefinition = {
  name: 'square.links.sweep',
  policy: 'stately',
  cron: '* * * * *',
  retryLimit: 0,
  expireInSeconds: 5 * 60,
  async handler(ctx) {
    const d = await located(ctx)
    if (!d) return
    const r = await sweepSquareLinks(d)
    if (r.canceled + r.deleted + r.failed > 0) ctx.logger.info({ square: r }, 'square.links.sweep done')
  },
}

export const squareDepositLinkJob: JobDefinition = {
  name: 'square.deposit-link',
  policy: 'stately',
  cron: '* * * * *',
  retryLimit: 0,
  expireInSeconds: 5 * 60,
  async handler(ctx) {
    const d = await located(ctx)
    if (!d) return
    const r = await runDepositLinks(d)
    if (r.status === 'skipped') ctx.logger.debug({ reason: r.reason }, 'square.deposit-link skipped')
    else if (r.created + r.dropped + r.failed > 0) ctx.logger.info({ square: r }, 'square.deposit-link done')
  },
}

export const squareRefundsJob: JobDefinition = {
  name: 'square.refunds.submit',
  policy: 'stately',
  cron: '* * * * *',
  retryLimit: 0,
  expireInSeconds: 5 * 60,
  async handler(ctx) {
    const d = await located(ctx)
    if (!d) return
    const r = await runSquareRefunds(d)
    if (r.status === 'skipped') ctx.logger.debug({ reason: r.reason }, 'square.refunds.submit skipped')
    else if (r.planned + r.submitted + r.failed + r.uncovered > 0) ctx.logger.info({ square: r }, 'square.refunds.submit done')
  },
}

export const squareJobs = [
  squareEventJob,
  squareCatchupJob,
  squareReconcileJob,
  squareMatchJob,
  squareLinksSweepJob,
  squareDepositLinkJob,
  squareRefundsJob,
] as const
