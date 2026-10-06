import type { JobDefinition, Jobs } from '../../../platform/jobs.js'
import { emergencyAutoReopenJob, emergencySweepJob } from './emergency.job.js'
import { federalHolidaysJob } from './federal-holidays.job.js'
import { EMERGENCY_SWEEP_JOB, FEDERAL_HOLIDAYS_JOB } from './names.js'

export * from './emergency.job.js'
export * from './federal-holidays.job.js'
export * from './names.js'

export const settingsJobs: readonly JobDefinition<never>[] = [
  federalHolidaysJob,
  emergencyAutoReopenJob,
  emergencySweepJob,
]

/**
 * Catch-up after downtime, enqueued when the API starts: federal holidays for the current and next year, and a sweep for any
 * emergency whose end time passed while the process was down. `singletonKey` keeps a restart loop from queueing duplicates.
 * A failure to enqueue is reported to `onError` and never stops the server.
 */
export async function enqueueStartupJobs(
  jobs: Pick<Jobs, 'enqueue'>,
  onError: (err: Error, job: string) => void = () => undefined,
): Promise<void> {
  const startup: [string, object][] = [
    [FEDERAL_HOLIDAYS_JOB, { catchUp: true }],
    [EMERGENCY_SWEEP_JOB, {}],
  ]
  for (const [name, data] of startup)
    await jobs
      .enqueue(name, data, { singletonKey: 'startup' })
      .catch((err: unknown) => onError(err as Error, name))
}
