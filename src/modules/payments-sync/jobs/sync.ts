// The orchestration shared by the pg-boss handlers and the "Sync now" endpoint: one poll cycle (orders, then transactions), the
// match runner, and, when orders changed, the membership inference pass. Safe to run twice: every step is idempotent.
import type { Env } from '../../../config/env.js'
import type { Clock } from '../../../platform/clock.js'
import type { Db } from '../../../platform/db.js'
import { runMembershipPass } from '../../memberships/jobs.js'
import { createSqspRuntime } from '../db/runtime-config.js'
import type { SyncCycleResult, SyncOptions } from '../db/runtime.js'

export interface SyncJobResult extends SyncCycleResult {
  membership?: Awaited<ReturnType<typeof runMembershipPass>>
}

export async function runSyncJob(
  db: Db,
  clock: Clock,
  locationId: string,
  opts: SyncOptions & { env?: Env } = {},
): Promise<SyncJobResult> {
  const rt = createSqspRuntime({ db, clock, env: opts.env })
  const out = await rt.syncCycle(locationId, opts)
  if (out.status === 'not_configured') return out
  const membership =
    out.ordersChanged || opts.rematch || opts.resume
      ? await runMembershipPass(db, clock, locationId, rt.d.env)
      : undefined
  return { ...out, membership }
}
