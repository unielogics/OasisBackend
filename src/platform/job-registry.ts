// Every pg-boss job in the system. A module adds one import and one entry; queues are created for all of them by
// both the API process (producer) and the worker (consumer, which also registers handlers and cron schedules).
import type { JobDefinition } from './jobs.js'
import { maintenancePurgeJob } from './maintenance.js'

export const jobDefinitions: readonly JobDefinition<never>[] = [maintenancePurgeJob]
