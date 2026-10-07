// Jobs of the standing-appointment and waitlist features (ADR 0086). Registered in src/platform/job-registry.ts. All three do
// nothing while the feature setting is off.
import { createIdGenerator } from '../../platform/ids.js'
import { transaction } from '../../platform/db.js'
import type { JobContext, JobDefinition } from '../../platform/jobs.js'
import { createGatewayFor } from '../payments/module.js'
import { dbMembershipPort } from '../memberships/port.js'
import { jobRuntime } from '../messaging/jobs/index.js'
import { locationTimezone, type SchedulingCtx } from '../scheduling/context.js'
import { noExternalAlerts, type SchedulingPorts } from '../scheduling/ports.js'
import { createDbDepositSettlement } from '../scheduling/settlement.js'
import { autoConfirmDue, materializeAll } from './series.js'
import { expireOffers } from './waitlist.js'
import { dbWaitlistPort } from './waitlist.js'

/** The real ports a job books and texts through: the payments gateway, the messaging queue, memberships and the ledger. */
export function standingPorts(ctx: JobContext): SchedulingPorts {
  const newId = createIdGenerator(ctx.clock)
  return {
    invoices: createGatewayFor({ clock: ctx.clock, newId }),
    messages: jobRuntime(ctx).queue,
    memberships: dbMembershipPort,
    externalAlerts: noExternalAlerts,
    deposits: createDbDepositSettlement({ clock: ctx.clock, newId }),
    waitlist: dbWaitlistPort,
    storage: {
      createUpload: () => Promise.reject(new Error('storage is not used by the standing jobs')),
      head: () => Promise.reject(new Error('storage is not used by the standing jobs')),
      getDownloadUrl: () => Promise.reject(new Error('storage is not used by the standing jobs')),
      delete: () => Promise.reject(new Error('storage is not used by the standing jobs')),
    },
  }
}

async function eachLocation<T>(
  ctx: JobContext,
  ports: SchedulingPorts,
  fn: (tx: Parameters<Parameters<typeof transaction<T>>[1]>[0], c: SchedulingCtx) => Promise<T>,
): Promise<T[]> {
  const newId = createIdGenerator(ctx.clock)
  const locations = await ctx.db.selectFrom('locations').select('id').orderBy('created_at').execute()
  const out: T[] = []
  for (const l of locations) {
    const tz = await locationTimezone(ctx.db, l.id)
    out.push(
      await transaction(ctx.db, (tx) => fn(tx, { clock: ctx.clock, newId, locationId: l.id, tz, ports })),
    )
  }
  return out
}

export const standingMaterializeJob: JobDefinition = {
  name: 'standing.materialize',
  cron: '0 4 * * *',
  policy: 'short',
  retryLimit: 2,
  async handler(ctx) {
    const reports = await eachLocation(ctx, standingPorts(ctx), (tx, c) => materializeAll(tx, c))
    ctx.logger.info({ reports }, 'standing.materialize done')
  },
}

export const standingAutoconfirmJob: JobDefinition = {
  name: 'standing.autoconfirm',
  cron: '0 * * * *',
  policy: 'short',
  retryLimit: 1,
  async handler(ctx) {
    const reports = await eachLocation(ctx, standingPorts(ctx), (tx, c) => autoConfirmDue(tx, c))
    ctx.logger.info({ reports }, 'standing.autoconfirm done')
  },
}

export const waitlistOfferExpiryJob: JobDefinition = {
  name: 'waitlist.offer_expiry',
  cron: '* * * * *',
  policy: 'short',
  retryLimit: 0,
  async handler(ctx) {
    const reports = await eachLocation(ctx, standingPorts(ctx), (tx, c) => expireOffers(tx, c))
    if (reports.some((r) => r.expiredOffers || r.reOffered || r.expiredEntries))
      ctx.logger.info({ reports }, 'waitlist.offer_expiry done')
  },
}

export const standingJobs: JobDefinition[] = [
  standingMaterializeJob,
  standingAutoconfirmJob,
  waitlistOfferExpiryJob,
]
