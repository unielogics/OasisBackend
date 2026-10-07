// Squarespace read-side jobs, registered in src/platform/job-registry.ts. Time comes from the injected Clock, waiting from the
// Sleeper, HTTP from the configured source: under a frozen clock and the simulator the whole read side is deterministic.
//   sqsp.sync            every SQSP_POLL_INTERVAL_SECONDS: orders then transactions (watermark, overlap, 7-day chunks), then the
//                        match runner, then the membership pass when orders changed
//   sqsp.contacts        hourly: contacts (no modified filter: full read) and the customer links
//   sqsp.reconcile       nightly 03:30 (not 02:30: that hour is skipped on spring-forward day, ADR 0090): re-read the last 45 days and match whatever the poll missed
//   sqsp.webhook.process queue only: fetch the order a verified notification names and match
// A run that Squarespace rejects or that cannot persist is recorded in sqsp_sync_state (and dead-lettered after 5 consecutive
// failures: polling stops until "Sync now" with resume), it does not throw, so pg-boss does not pile retries on top of it.
import type { JobDefinition } from '../../../platform/jobs.js'
import { DbNotificationDedupe } from '../db/webhook.js'
import { createIdGenerator } from '../../../platform/ids.js'
import { runMembershipPass } from '../../memberships/jobs.js'
import { createSqspRuntime } from '../db/runtime-config.js'
import { runSyncJob } from './sync.js'

export { runSyncJob } from './sync.js'

/** A five-field cron (minute granularity) for a poll interval in seconds: every N whole minutes, at least every minute. */
export function pollCron(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes >= 60) return `0 */${Math.min(12, Math.round(minutes / 60))} * * *`
  return minutes === 1 ? '* * * * *' : `*/${minutes} * * * *`
}

const pollSeconds = Number(process.env.SQSP_POLL_INTERVAL_SECONDS) || 120

async function locationIds(db: Parameters<JobDefinition['handler']>[0]['db']): Promise<string[]> {
  return (await db.selectFrom('locations').select('id').orderBy('created_at').execute()).map((l) => l.id)
}

export interface SyncJobData {
  resume?: boolean
  rematch?: boolean
}

export const sqspSyncJob: JobDefinition<SyncJobData> = {
  name: 'sqsp.sync',
  policy: 'stately',
  cron: pollCron(pollSeconds),
  retryLimit: 0,
  expireInSeconds: 15 * 60,
  async handler(ctx, data) {
    for (const id of await locationIds(ctx.db)) {
      const r = await runSyncJob(ctx.db, ctx.clock, id, { resume: data?.resume, rematch: data?.rematch })
      if (r.status === 'not_configured') {
        ctx.logger.debug({ location: id }, 'sqsp.sync skipped: no Squarespace key')
        continue
      }
      ctx.logger.info(
        {
          location: id,
          status: r.status,
          orders: r.orders && { status: r.orders.status, seen: r.orders.seen, requests: r.orders.requests },
          transactions: r.transactions && { status: r.transactions.status, seen: r.transactions.seen },
          match: r.match && {
            processed: r.match.ordersProcessed,
            confirmed: r.match.confirmedAwaiting,
            recorded: r.match.paymentsRecorded,
            manual: r.match.manual,
            errors: r.match.errors.length,
          },
        },
        'sqsp.sync done',
      )
    }
  },
}

export const sqspContactsJob: JobDefinition = {
  name: 'sqsp.contacts',
  policy: 'stately',
  cron: '17 * * * *',
  retryLimit: 0,
  expireInSeconds: 15 * 60,
  async handler(ctx) {
    const rt = createSqspRuntime({ db: ctx.db, clock: ctx.clock })
    for (const id of await locationIds(ctx.db)) {
      const r = await rt.syncContacts(id)
      if (!r) continue
      if (r.links.linked > 0) await runMembershipPass(ctx.db, ctx.clock, id, rt.d.env)
      ctx.logger.info(
        { location: id, status: r.run.status, seen: r.run.seen, ...r.links },
        'sqsp.contacts done',
      )
    }
  },
}

export const sqspReconcileJob: JobDefinition = {
  name: 'sqsp.reconcile',
  policy: 'stately',
  cron: '30 3 * * *',
  retryLimit: 1,
  expireInSeconds: 30 * 60,
  async handler(ctx) {
    const rt = createSqspRuntime({ db: ctx.db, clock: ctx.clock })
    for (const id of await locationIds(ctx.db)) {
      const parts = await rt.partsFor(id)
      if (!parts) continue
      const report = await parts.engine.reconcile()
      const match = await parts.runner.run()
      if (report.missingRemoteOrderIds?.length)
        ctx.logger.warn(
          { location: id, orders: report.missingRemoteOrderIds },
          'sqsp.reconcile: stored orders Squarespace no longer returns',
        )
      ctx.logger.info(
        {
          location: id,
          status: report.status,
          complete: report.complete,
          requests: report.requests,
          orders: report.orders,
          transactions: report.transactions,
          matched: match.ordersProcessed,
        },
        'sqsp.reconcile done',
      )
    }
  },
}

export interface WebhookJobData {
  orderId: string
  notificationId: string
  locationId: string
}

export const sqspWebhookJob: JobDefinition<WebhookJobData> = {
  name: 'sqsp.webhook.process',
  policy: 'standard',
  retryLimit: 5,
  retryDelaySeconds: 30,
  async handler(ctx, data) {
    const rt = createSqspRuntime({ db: ctx.db, clock: ctx.clock })
    const log = new DbNotificationDedupe(ctx.db, createIdGenerator(ctx.clock))
    try {
      const r = await rt.ingestOrder(data.locationId, data.orderId)
      await log.finish(
        data.notificationId,
        r ? 'processed' : 'ignored',
        ctx.clock.now(),
        r ? undefined : 'no Squarespace key',
      )
      ctx.logger.info(
        { orderId: data.orderId, matched: r?.match.ordersProcessed },
        'sqsp.webhook.process done',
      )
    } catch (e) {
      await log.finish(
        data.notificationId,
        'failed',
        ctx.clock.now(),
        e instanceof Error ? e.message : String(e),
      )
      throw e
    }
  },
}

export const sqspJobs = [sqspSyncJob, sqspContactsJob, sqspReconcileJob, sqspWebhookJob] as const
