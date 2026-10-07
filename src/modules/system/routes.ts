// GET /api/v1/system/jobs: what the background-job machinery is doing, per job. Read-only and bounded (one row per
// registered job); it never returns job payloads, only counts, times and the masked last error message.
import { access } from '../../http/access.js'
import type { AppInstance } from '../../http/types.js'
import { z } from '../../http/zod.js'

const iso = z.iso.datetime({ offset: true })

const QueueSummary = z.object({
  queued: z.number().int(),
  scheduled: z.number().int(),
  active: z.number().int(),
  failed: z.number().int(),
  deadLetter: z.number().int(),
  oldestQueuedAgeSeconds: z.number().int().nullable(),
})

const Worker = z.object({ state: z.enum(['ok', 'stale', 'unknown']), lastRunAt: iso.nullable() })

const JobRow = z.object({
  name: z.string(),
  cron: z.string().nullable(),
  tz: z.string().nullable(),
  policy: z.string(),
  retryLimit: z.number().int(),
  retryDelaySeconds: z.number().int(),
  expireInSeconds: z.number().int().nullable(),
  nextRunAt: iso.nullable(),
  lastStartedAt: iso.nullable(),
  lastFinishedAt: iso.nullable(),
  lastSuccessAt: iso.nullable(),
  lastErrorAt: iso.nullable(),
  lastError: z.string().nullable(),
  lastDurationMs: z.number().int().nullable(),
  lastOutcome: z.enum(['running', 'completed', 'failed']).nullable(),
  runs: z.number().int(),
  failures: z.number().int(),
  consecutiveFailures: z.number().int(),
  queued: z.number().int(),
  scheduled: z.number().int(),
  active: z.number().int(),
  failed: z.number().int(),
  deadLetter: z.number().int(),
})

export const JobsStatusResponse = z.object({
  enabled: z.boolean(),
  generatedAt: iso,
  queue: QueueSummary,
  worker: Worker,
  jobs: z.array(JobRow),
})

export function registerSystemRoutes(app: AppInstance): void {
  app.get(
    '/system/jobs',
    {
      // Super Admin holds every key; Accounting-style roles may be given set.billing to see the same page
      config: { access: access.perm('set.billing') },
      schema: {
        tags: ['system'],
        summary: 'Background jobs: last run, last success, last error, next run, queue depth and failures',
        description:
          "One row per registered job, sorted by name. `queued` is waiting and due, `scheduled` is delayed (including retries backing off), `failed` is retained rows whose retries are exhausted, `deadLetter` is rows in the job's dead-letter queue. `worker.state` is `stale` when no job finished in the last 10 minutes. With JOBS_ENABLED=false the answer is `{ enabled: false, jobs: [] }`.",
        response: { 200: JobsStatusResponse },
      },
    },
    async () => {
      const status = await app.jobs?.status?.()
      if (status) return status
      return {
        enabled: false,
        generatedAt: app.clock.now().toISOString(),
        queue: { queued: 0, scheduled: 0, active: 0, failed: 0, deadLetter: 0, oldestQueuedAgeSeconds: null },
        worker: { state: 'unknown' as const, lastRunAt: null },
        jobs: [],
      }
    },
  )
}
