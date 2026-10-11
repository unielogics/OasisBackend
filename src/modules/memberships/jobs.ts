// Background jobs of the Memberships module. Registered in src/platform/job-registry.ts.
import type { JobDefinition } from '../../platform/jobs.js'
import { createIdGenerator } from '../../platform/ids.js'
import { sqspEnv } from '../payments-sync/db/runtime-config.js'
import { paymentsSyncConfigFromEnv } from '../payments-sync/config.js'
import { buildProductMap } from '../payments-sync/db/product-map.js'
import type { Clock } from '../../platform/clock.js'
import type { Db } from '../../platform/db.js'
import type { SquarespaceEnv } from '../../integrations/squarespace/config.js'
import type { Env } from '../../config/env.js'
import { sweepCheckouts } from './checkouts.js'
import {
  runMembershipCycle,
  syncMemberships,
  type CycleReport,
  type MembershipSyncReport,
} from './service.js'

/** The membership config the environment selects (grace days, lagged-cancel days, test orders). 0 lapse days never infers a cancel. */
export function membershipConfigFromEnv(env: Env) {
  const cfg = paymentsSyncConfigFromEnv({
    ...(env as unknown as SquarespaceEnv),
    SQSP_PRODUCT_MAP: undefined,
  })
  return {
    ...cfg.membership,
    lapseCancelDays: env.SQSP_LAPSE_CANCEL_DAYS === 0 ? null : env.SQSP_LAPSE_CANCEL_DAYS,
  }
}

export interface MembershipPassResult {
  cycle: CycleReport
  sync: MembershipSyncReport
}

/** The daily pass for one location: roll manual cycles and grant credits, then run the subscription inference. */
export async function runMembershipPass(
  db: Db,
  clock: Clock,
  locationId: string,
  env: Env,
): Promise<MembershipPassResult> {
  const newId = createIdGenerator(clock)
  const cycle = await runMembershipCycle(db, { locationId, clock, newId })
  const productMap = await buildProductMap(db, locationId, env.SQSP_PRODUCT_MAP)
  const sync = await syncMemberships(db, {
    locationId,
    clock,
    newId,
    productMap,
    config: membershipConfigFromEnv(env),
  })
  return { cycle, sync }
}

export const membershipCycleJob: JobDefinition = {
  name: 'membership.cycle',
  policy: 'short',
  cron: '0 3 * * *',
  retryLimit: 2,
  async handler(ctx) {
    const env = sqspEnv()
    const locations = await ctx.db.selectFrom('locations').select('id').orderBy('created_at').execute()
    for (const l of locations) {
      const r = await runMembershipPass(ctx.db, ctx.clock, l.id, env)
      ctx.logger.info({ location: l.id, ...r.cycle, ...r.sync }, 'membership.cycle done')
    }
  },
}

/**
 * Every 15 minutes (ADR 0160): open checkout intents past their 72-hour window expire, and a pending membership the website or a
 * personal link started, that staff never edited and that saw no paid order in the 7 days after its last checkout attempt, is
 * closed (canceled, cancel_reason checkout_abandoned). With no checkouts and no pending web memberships it changes nothing.
 */
export const membershipCheckoutsJob: JobDefinition = {
  name: 'membership.checkouts',
  policy: 'short',
  cron: '*/15 * * * *',
  retryLimit: 2,
  retryDelaySeconds: 60,
  expireInSeconds: 10 * 60,
  async handler(ctx) {
    const newId = createIdGenerator(ctx.clock)
    const locations = await ctx.db.selectFrom('locations').select('id').orderBy('created_at').execute()
    for (const l of locations) {
      const r = await sweepCheckouts(ctx.db, { locationId: l.id, clock: ctx.clock, newId })
      if (r.expired + r.abandoned > 0) ctx.logger.info({ location: l.id, ...r }, 'membership.checkouts done')
    }
  },
}

export const membershipJobs: readonly JobDefinition[] = [membershipCycleJob, membershipCheckoutsJob]
