// Every pg-boss job in the system. A module adds one import and one entry; queues are created for all of them by
// both the API process (producer) and the worker (consumer, which also registers handlers and cron schedules).
import type { JobDefinition } from './jobs.js'
import { membershipCycleJob } from '../modules/memberships/jobs.js'
import { messagingJobs } from '../modules/messaging/jobs/index.js'
import { sqspJobs } from '../modules/payments-sync/jobs/index.js'
import { paymentsLagScanJob } from '../modules/payments/jobs.js'
import { settingsJobs } from '../modules/settings/jobs/index.js'
import { maintenancePurgeJob } from './maintenance.js'
import { alertsScanJob } from '../modules/scheduling/jobs.js'
import { photoFinalizeJob, photoThumbnailJob } from '../modules/scheduling/photo-jobs.js'

export const jobDefinitions: readonly JobDefinition<never>[] = [
  maintenancePurgeJob,
  ...settingsJobs,
  alertsScanJob,
  photoThumbnailJob,
  photoFinalizeJob,
  paymentsLagScanJob,
  ...messagingJobs,
  ...sqspJobs,
  membershipCycleJob,
]
