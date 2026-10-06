import type { JobDefinition } from '../../../platform/jobs.js'
import { emergencyAutoReopenJob, emergencySweepJob } from './emergency.job.js'
import { federalHolidaysJob } from './federal-holidays.job.js'

export * from './emergency.job.js'
export * from './federal-holidays.job.js'
export * from './names.js'

export const settingsJobs: readonly JobDefinition<never>[] = [
  federalHolidaysJob,
  emergencyAutoReopenJob,
  emergencySweepJob,
]
