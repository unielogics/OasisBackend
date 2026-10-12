// Jobs of the memberships billed by Square (ADR 0171 wave Q3b), registered in src/platform/job-registry.ts and described in
// src/platform/jobs-catalog.ts:
//   square.catalog.sync        every 5 minutes: tier prices a save left pending become Square plan variations (catalog-sync.ts)
//   square.catalog.drift       nightly: the same, plus Square's catalog read back and compared (drift reported, never overwritten)
//   square.enrollments.resume  every 5 minutes: membership page attempts taken on with the same keys, abandoned after an hour and
//                              cleaned up at Square, stale pending memberships closed, a newer saved card put on the subscription
//   membership.billing         daily 09:30: the failure policy (day 7 past due, day 21 canceled at Square; a client not yet told)
//   square.plans.swap          daily 10:15: "Move members" whose notice has run get their SwapPlan
// With the defaults nothing happens: the Square-writing jobs skip while SQUARE_WRITES_ENABLED is false, and the billing policy finds
// no membership billed by Square (none exists before PAYMENT_PROCESSOR=square and personal links are open).
import { createIdGenerator } from '../../../platform/ids.js'
import type { JobContext, JobDefinition } from '../../../platform/jobs.js'
import { getDefaultLocation } from '../../../platform/locations.js'
import { squareApi, squareEnv } from '../../square/runtime.js'
import { runCatalogSync } from './catalog-sync.js'
import { runEnrollmentJobs } from './enroll.js'
import { runPlanSwaps } from './moves.js'
import type { SquareSteps } from './steps.js'
import { runBillingPolicy } from './timeline.js'

/** The steps' deps from the job context (the Square runtime's environment and API); null before the seed made a location. */
export async function stepsOf(ctx: JobContext): Promise<SquareSteps | null> {
  const location = await getDefaultLocation(ctx.db)
  if (!location) return null
  const env = squareEnv()
  return { db: ctx.db, clock: ctx.clock, newId: createIdGenerator(ctx.clock), env, api: squareApi(env), locationId: location.id, logger: ctx.logger }
}

export const squareCatalogSyncJob: JobDefinition = {
  name: 'square.catalog.sync',
  policy: 'stately',
  cron: '*/5 * * * *',
  retryLimit: 0,
  expireInSeconds: 4 * 60,
  async handler(ctx) {
    const x = await stepsOf(ctx)
    if (!x) return
    const r = await runCatalogSync(x, x.locationId)
    if (r.status === 'skipped') ctx.logger.debug({ reason: r.reason }, 'square.catalog.sync skipped')
    else if (r.plansCreated + r.variationsCreated + r.retired + r.failed > 0) ctx.logger.info({ square: r }, 'square.catalog.sync done')
  },
}

export const squareCatalogDriftJob: JobDefinition = {
  name: 'square.catalog.drift',
  policy: 'stately',
  cron: '20 4 * * *',
  retryLimit: 1,
  expireInSeconds: 20 * 60,
  async handler(ctx) {
    const x = await stepsOf(ctx)
    if (!x) return
    const r = await runCatalogSync(x, x.locationId, { drift: true })
    if (r.status === 'skipped') ctx.logger.debug({ reason: r.reason }, 'square.catalog.drift skipped')
    else ctx.logger.info({ square: r }, 'square.catalog.drift done')
  },
}

export const squareEnrollmentsJob: JobDefinition = {
  name: 'square.enrollments.resume',
  policy: 'stately',
  cron: '*/5 * * * *',
  retryLimit: 0,
  expireInSeconds: 4 * 60,
  async handler(ctx) {
    const x = await stepsOf(ctx)
    if (!x) return
    const r = await runEnrollmentJobs(x)
    if (r.status === 'skipped') ctx.logger.debug({ reason: r.reason }, 'square.enrollments.resume skipped')
    else if (r.subscribed + r.polled + r.abandoned + r.cleaned + r.closed + r.cardsMoved > 0) ctx.logger.info({ square: r }, 'square.enrollments.resume done')
  },
}

export const membershipBillingJob: JobDefinition = {
  name: 'membership.billing',
  policy: 'short',
  cron: '30 9 * * *',
  retryLimit: 2,
  retryDelaySeconds: 300,
  expireInSeconds: 30 * 60,
  async handler(ctx) {
    const x = await stepsOf(ctx)
    if (!x) return
    const r = await runBillingPolicy(x)
    if (r.considered > 0) ctx.logger.info({ ...r }, 'membership.billing done')
  },
}

export const squarePlanSwapJob: JobDefinition = {
  name: 'square.plans.swap',
  policy: 'stately',
  cron: '15 10 * * *',
  retryLimit: 1,
  expireInSeconds: 20 * 60,
  async handler(ctx) {
    const x = await stepsOf(ctx)
    if (!x) return
    const r = await runPlanSwaps(x)
    if (r.status === 'skipped') ctx.logger.debug({ reason: r.reason }, 'square.plans.swap skipped')
    else if (r.sent + r.failed > 0) ctx.logger.info({ square: r }, 'square.plans.swap done')
  },
}

export const squareMembershipJobs: readonly JobDefinition[] = [
  squareCatalogSyncJob,
  squareCatalogDriftJob,
  squareEnrollmentsJob,
  membershipBillingJob,
  squarePlanSwapJob,
]
