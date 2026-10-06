// Housekeeping that keeps platform tables bounded. Every task is idempotent: running it twice in a row removes nothing
// the second time. Verticals register their own tasks (sessions, webhook payloads, ...) with registerPurgeTask.
import type { Clock } from './clock.js'
import type { Db } from './db.js'
import { purgeExpiredKeys } from './idempotency.js'
import type { JobDefinition } from './jobs.js'
import { purgeRealtimeEvents } from './realtime.js'

export const REALTIME_RETENTION_MS = 10 * 60 * 1000
export const WEBHOOK_LOG_RETENTION_MS = 90 * 24 * 3600 * 1000

export type PurgeTask = (db: Db, clock: Clock) => Promise<number>

const tasks = new Map<string, PurgeTask>()

export function registerPurgeTask(name: string, task: PurgeTask): void {
  tasks.set(name, task)
}

registerPurgeTask('idempotency_keys', (db, clock) => purgeExpiredKeys(db, clock))
registerPurgeTask('realtime_events', (db, clock) =>
  purgeRealtimeEvents(db, new Date(clock.now().getTime() - REALTIME_RETENTION_MS)),
)
registerPurgeTask('webhook_log', async (db, clock) => {
  const cutoff = new Date(clock.now().getTime() - WEBHOOK_LOG_RETENTION_MS)
  const r = await db.deleteFrom('webhook_log').where('received_at', '<', cutoff).executeTakeFirst()
  return Number(r.numDeletedRows)
})

export async function runMaintenancePurge(db: Db, clock: Clock): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const [name, task] of tasks) out[name] = await task(db, clock)
  return out
}

/** Runs every 10 minutes; the realtime retention window is 10 minutes. audit_log is never purged. */
export const maintenancePurgeJob: JobDefinition<Record<string, never>> = {
  name: 'maintenance.purge',
  policy: 'short',
  cron: '*/10 * * * *',
  async handler(ctx) {
    const removed = await runMaintenancePurge(ctx.db, ctx.clock)
    ctx.logger.info({ removed }, 'maintenance.purge done')
  },
}
