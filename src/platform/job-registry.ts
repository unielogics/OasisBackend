// Every pg-boss job in the system. A module adds one import and one entry; queues are created for all of them by
// both the API process (producer) and the worker (consumer, which also registers handlers and cron schedules).
import type { JobDefinition } from './jobs.js'
import { membershipCycleJob } from '../modules/memberships/jobs.js'
import { messagingJobs } from '../modules/messaging/jobs/index.js'
import { remindersJob, reviewRequestJob } from '../modules/messaging/jobs/reminders.js'
import { sqspJobs } from '../modules/payments-sync/jobs/index.js'
import { paymentsLagScanJob } from '../modules/payments/jobs.js'
import { creditExpireJob } from '../modules/payments/jobs-credit.js'
import { settingsJobs } from '../modules/settings/jobs/index.js'
import { maintenancePurgeJob, maintenanceRetentionJob } from './maintenance.js'
import { alertsScanJob } from '../modules/scheduling/jobs.js'
import { vipHoldReleaseJob } from '../modules/scheduling/jobs-vip.js'
import { photoRetentionJob } from '../modules/scheduling/jobs-retention.js'
import { photoFinalizeJob, photoThumbnailJob } from '../modules/scheduling/photo-jobs.js'

export const jobDefinitions: readonly JobDefinition<never>[] = [
  maintenancePurgeJob,
  maintenanceRetentionJob,
  ...settingsJobs,
  alertsScanJob,
  photoThumbnailJob,
  photoFinalizeJob,
  photoRetentionJob,
  paymentsLagScanJob,
  creditExpireJob,
  ...messagingJobs,
  remindersJob,
  reviewRequestJob,
  vipHoldReleaseJob,
  ...sqspJobs,
  membershipCycleJob,
]
