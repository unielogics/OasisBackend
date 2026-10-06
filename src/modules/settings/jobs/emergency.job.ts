// emergency.auto_reopen is scheduled for the emergency's end time when the shop closes; emergency.sweep runs hourly (and
// at startup) as the backstop for a missed or lost delayed job. Both reopen only an emergency whose end time has passed.
import type { Clock } from '../../../platform/clock.js'
import type { Db } from '../../../platform/db.js'
import { isAppError } from '../../../platform/errors.js'
import type { JobDefinition } from '../../../platform/jobs.js'
import { reopenIfDue } from '../http/emergency-commands.js'
import { listLocations } from './locations.js'
import { EMERGENCY_AUTO_REOPEN_JOB, EMERGENCY_SWEEP_JOB, type AutoReopenData } from './names.js'

export interface ReopenedByJob {
  locationId: string
  emergencyClosureId: string
}

/** Reopens every location's active emergency that has ended (or only the given one). Safe to run any number of times. */
export async function runEmergencyReopen(
  d: { db: Db; clock: Clock },
  o: { locationId?: string; emergencyClosureId?: string } = {},
): Promise<ReopenedByJob[]> {
  const out: ReopenedByJob[] = []
  for (const loc of await listLocations(d.db, o.locationId)) {
    try {
      const r = await d.db
        .transaction()
        .execute((tx) =>
          reopenIfDue(
            tx,
            { clock: d.clock, tz: loc.timezone },
            { locationId: loc.id, emergencyClosureId: o.emergencyClosureId },
          ),
        )
      if (r) out.push({ locationId: loc.id, emergencyClosureId: r.emergency.id })
    } catch (e) {
      // Someone reopened it between the check and the lock: nothing left to do.
      if (!(isAppError(e) && e.code === 'EMERGENCY_NOT_ACTIVE')) throw e
    }
  }
  return out
}

export const emergencyAutoReopenJob: JobDefinition<AutoReopenData> = {
  name: EMERGENCY_AUTO_REOPEN_JOB,
  policy: 'short',
  async handler(ctx, data) {
    const reopened = await runEmergencyReopen(ctx, data)
    ctx.logger.info({ reopened }, 'emergency.auto_reopen done')
  },
}

export const emergencySweepJob: JobDefinition<Record<string, never>> = {
  name: EMERGENCY_SWEEP_JOB,
  cron: '0 * * * *',
  policy: 'short',
  async handler(ctx) {
    const reopened = await runEmergencyReopen(ctx)
    if (reopened.length > 0)
      ctx.logger.warn({ reopened }, 'emergency.sweep reopened an emergency the delayed job missed')
  },
}
