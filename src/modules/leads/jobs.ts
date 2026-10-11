// The leads' jobs (ADR 0160, plan J; registered in src/platform/job-registry.ts):
//   leads.follow_up              every 5 minutes: the one automatic follow-up text of a lead who did not book (follow-up.ts); no text
//                                while AI_ENABLED, assistant.enabled or leads.follow_up_enabled is off (booked leads still close)
//   leads.provisional_archive    nightly: archives the welcome flow's provisional clients that never gave a name nor booked, 30 days
//                                after their last text (soft delete + archived_at; reversible; the thread is kept); only rows the
//                                assistant created match, so with the assistant never on it finds nothing
// Both are safe to repeat (see the job catalogue). createLeadJobs builds them over given deps (tests, W3a's wiring); leadJobs builds
// the deps from the job context like the messaging jobs do (the worker's own runtime and environment).
import { loadEnv } from '../../config/env.js'
import { createIdGenerator } from '../../platform/ids.js'
import type { JobContext, JobDefinition } from '../../platform/jobs.js'
import type { CreateLeadJobs } from '../assistant/contract.js'
import { archiveStaleProvisionalClients } from '../assistant/welcome/provisional.js'
import { jobRuntime } from '../messaging/jobs/index.js'
import { runLeadFollowUps, type LeadJobDeps } from './follow-up.js'

export const LEAD_FOLLOW_UP_JOB = 'leads.follow_up'
export const PROVISIONAL_ARCHIVE_JOB = 'leads.provisional_archive'

function leadJobDefs(depsOf: (ctx: JobContext) => LeadJobDeps): JobDefinition[] {
  return [
    {
      name: LEAD_FOLLOW_UP_JOB,
      cron: '*/5 * * * *',
      policy: 'stately',
      retryLimit: 1,
      retryDelaySeconds: 60,
      expireInSeconds: 240,
      async handler(ctx) {
        const d = depsOf(ctx)
        const r = await runLeadFollowUps(d)
        if (r.sent > 0 || r.considered > 0) ctx.logger.info({ ...r }, 'lead follow-ups')
      },
    },
    {
      name: PROVISIONAL_ARCHIVE_JOB,
      cron: '40 4 * * *',
      policy: 'stately',
      retryLimit: 2,
      retryDelaySeconds: 300,
      expireInSeconds: 900,
      async handler(ctx) {
        const d = depsOf(ctx)
        const r = await archiveStaleProvisionalClients(d.db, { now: d.clock.now() })
        if (r.archived > 0) ctx.logger.info({ ...r }, 'provisional clients archived')
      },
    },
  ]
}

/** The deps of the worker's jobs: its database and clock, the process environment and the messaging runtime's queue. */
export function leadJobDepsOf(ctx: JobContext): LeadJobDeps {
  const rt = jobRuntime(ctx)
  return { db: ctx.db, clock: ctx.clock, newId: createIdGenerator(ctx.clock), env: loadEnv(), queue: rt.queue, log: ctx.logger }
}

/** The jobs as registered (job-registry.ts). */
export const leadJobs: readonly JobDefinition[] = leadJobDefs(leadJobDepsOf)

/** The W3 contract's factory: the same jobs over the given deps (W3a must not register these a second time). */
export const createLeadJobs: CreateLeadJobs = (deps) => leadJobDefs(() => deps) as JobDefinition<never>[]
