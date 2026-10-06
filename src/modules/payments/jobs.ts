// Background jobs of the Payments module. Registered in src/platform/job-registry.ts.
import { sql } from 'kysely'
import { transaction } from '../../platform/db.js'
import type { Clock } from '../../platform/clock.js'
import type { Db } from '../../platform/db.js'
import type { JobDefinition } from '../../platform/jobs.js'
import * as realtime from '../../platform/realtime.js'
import { AWAITING_ALERT_MINUTES } from './reports.js'

export interface LagScanResult {
  locations: number
  alerts: Array<{ locationId: string; count: number; cents: number; oldestMinutes: number }>
}

/**
 * Card money recorded in Oasis that Squarespace has not confirmed within 2 hours (review B8): publishes a
 * `reconciliation.stale` event on the payments channel for every location that has any, so the dashboard can raise the
 * alert. Read-only otherwise and idempotent: running it twice only repeats the (advisory) event.
 */
export async function scanProcessorLag(db: Db, clock: Clock): Promise<LagScanResult> {
  const now = clock.now()
  const cutoff = new Date(now.getTime() - AWAITING_ALERT_MINUTES * 60_000)
  const r = await sql<{ location_id: string; n: number; cents: number; oldest: Date }>`
    select location_id, count(*)::int as n, sum(amount_cents)::bigint as cents, min(occurred_at) as oldest
    from ledger_events where processor_state = 'awaiting_processor' and occurred_at <= ${cutoff}
    group by location_id`.execute(db)
  const alerts = r.rows.map((x) => ({
    locationId: x.location_id,
    count: x.n,
    cents: x.cents,
    oldestMinutes: Math.floor((now.getTime() - x.oldest.getTime()) / 60_000),
  }))
  if (alerts.length > 0) {
    await transaction(db, async (tx) => {
      for (const a of alerts) {
        await realtime.publish(tx, {
          locationId: a.locationId,
          channel: 'payments',
          type: 'reconciliation.stale',
          payload: { count: a.count, cents: a.cents, oldestMinutes: a.oldestMinutes },
        })
      }
    })
  }
  return { locations: alerts.length, alerts }
}

export const paymentsLagScanJob: JobDefinition<Record<string, never>> = {
  name: 'payments.lag-scan',
  policy: 'short',
  cron: '*/15 * * * *',
  async handler(ctx) {
    const res = await scanProcessorLag(ctx.db, ctx.clock)
    ctx.logger.info({ alerts: res.alerts.length }, 'payments.lag-scan done')
  },
}
