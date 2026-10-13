// Jobs of the Square item library sync (ADR 0172), registered in src/platform/job-registry.ts and described in
// src/platform/jobs-catalog.ts:
//   square.items.sync    every 5 minutes at 2, 7, 12 ... (offset from square.catalog.sync: one catalog writer at a time per account):
//                        the read-back since the watermark and what the library needs (sync.ts)
//   square.items.drift   nightly 04:40 (04:20 is square.catalog.drift and square.cards.nightly): everything linked read back, every
//                        item searched for Oasis's marker; Square-side edits to Oasis's fields put back, the managers told once
//                        (it waits up to 5 minutes for a 5-minute run still going; the 5-minute run skips while another holds the lock)
// With the defaults both skip without reading Square (SQUARE_WRITES_ENABLED and SQUARE_ITEMS_SYNC_ENABLED are false).
import { createIdGenerator } from '../../../platform/ids.js'
import type { JobContext, JobDefinition } from '../../../platform/jobs.js'
import { getDefaultLocation } from '../../../platform/locations.js'
import { squareApi, squareEnv } from '../../square/runtime.js'
import { runItemSync, type ItemSyncDeps } from './sync.js'

async function depsOf(ctx: JobContext): Promise<{ deps: ItemSyncDeps; locationId: string } | null> {
  const location = await getDefaultLocation(ctx.db)
  if (!location) return null
  const env = squareEnv()
  return { deps: { db: ctx.db, clock: ctx.clock, newId: createIdGenerator(ctx.clock), env, api: squareApi(env), logger: ctx.logger }, locationId: location.id }
}

export const squareItemsSyncJob: JobDefinition = {
  name: 'square.items.sync',
  policy: 'stately',
  cron: '2-59/5 * * * *',
  retryLimit: 0,
  expireInSeconds: 4 * 60,
  async handler(ctx) {
    const x = await depsOf(ctx)
    if (!x) return
    const r = await runItemSync(x.deps, x.locationId)
    if (r.status === 'skipped') ctx.logger.debug({ reason: r.reason }, 'square.items.sync skipped')
    else if (r.status === 'blocked') ctx.logger.warn({ reason: r.reason }, 'square.items.sync blocked by the tax check')
    else if (r.created + r.updated + r.archived + r.recreated + r.restored + r.failed > 0)
      ctx.logger.info({ square: { ...r, tax: r.tax?.status } }, 'square.items.sync done')
  },
}

export const squareItemsDriftJob: JobDefinition = {
  name: 'square.items.drift',
  policy: 'stately',
  cron: '40 4 * * *',
  retryLimit: 1,
  expireInSeconds: 20 * 60,
  async handler(ctx) {
    const x = await depsOf(ctx)
    if (!x) return
    // a 5-minute run going: wait for it (the nightly run is not skipped for it)
    const r = await runItemSync(x.deps, x.locationId, { drift: true, waitForLockMs: 5 * 60_000 })
    if (r.status === 'skipped') ctx.logger.debug({ reason: r.reason }, 'square.items.drift skipped')
    else ctx.logger.info({ square: { ...r, tax: r.tax?.status } }, 'square.items.drift done')
  },
}

export const squareItemsJobs: readonly JobDefinition[] = [squareItemsSyncJob, squareItemsDriftJob]
