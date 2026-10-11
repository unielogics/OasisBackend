// pg-boss jobs of the assistant (ADR 0160, design section 3), registered in src/platform/job-registry.ts:
//   ai.respond   queue-only, stately with singletonKey = the conversation (one queued + one running per conversation); enqueued by
//                the webhook's kick 8 s after a text (AI_DEBOUNCE_MS), deferred by itself while the newest text is younger than that
//                (at most 45 s after the first), then one turn (src/modules/assistant/turn.ts)
//   ai.sweep     every minute: re-kicks markers older than 30 s that no turn holds, fails leases older than 3 minutes (fallback +
//                handoff)
// Both return at once while AI_ENABLED=false, and nothing marks a conversation while the gate is closed, so with the defaults they
// are harmless.
import { loadEnv } from '../../config/env.js'
import type { JobContext, JobDefinition, Jobs } from '../../platform/jobs.js'
import { createIdGenerator } from '../../platform/ids.js'
import { jobRuntime } from '../messaging/jobs/index.js'
import { AI_RESPOND_JOB, AI_SWEEP_JOB, AssistantRuntime, wireAssistant, type Enqueue } from './runtime.js'

let enqueuer: Enqueue | undefined

/**
 * The process's pg-boss handle for the assistant's own enqueues (deferrals, re-kicks, the sweep's kicks). src/worker.ts calls it;
 * without it those are left to the next sweep.
 */
export function configureAssistantJobs(o: { jobs: Pick<Jobs, 'enqueue'> }): void {
  enqueuer = (name, data, opts) => o.jobs.enqueue(name, data, opts)
}

const runtimes = new WeakMap<object, AssistantRuntime>()

/** The assistant runtime of a job context (one per database handle), wired into that process's messaging runtime. */
export function assistantJobRuntime(ctx: JobContext): AssistantRuntime {
  let r = runtimes.get(ctx.db)
  if (!r) {
    const messaging = jobRuntime(ctx)
    r = wireAssistant({
      db: ctx.db,
      clock: ctx.clock,
      newId: createIdGenerator(ctx.clock),
      env: loadEnv(),
      messaging,
      enqueue: (name, data, opts) => (enqueuer ? enqueuer(name, data, opts) : Promise.resolve(null)),
      log: ctx.logger,
    })
    runtimes.set(ctx.db, r)
  }
  return r
}

export interface RespondData {
  conversationId: string
}

export const aiRespondJob: JobDefinition<RespondData> = {
  name: AI_RESPOND_JOB,
  policy: 'stately',
  // the sweep is the retry: a failed turn already sent the fallback and handed off
  retryLimit: 0,
  // the turn's deadline is 60 s; a job still active after this died with its worker
  expireInSeconds: 180,
  async handler(ctx, data) {
    if (!loadEnv().AI_ENABLED) return
    if (typeof data?.conversationId !== 'string') return
    const r = await assistantJobRuntime(ctx).respond(data.conversationId)
    if (r.status !== 'none' && r.status !== 'deferred') ctx.logger.info({ conversation: data.conversationId, status: r.status }, 'assistant turn')
  },
}

export const aiSweepJob: JobDefinition = {
  name: AI_SWEEP_JOB,
  cron: '* * * * *',
  policy: 'stately',
  retryLimit: 0,
  async handler(ctx) {
    if (!loadEnv().AI_ENABLED) return
    const r = await assistantJobRuntime(ctx).sweep()
    if (r.kicked || r.leasesFailed) ctx.logger.info(r, 'assistant sweep')
  },
}

export const assistantJobs: readonly JobDefinition<never>[] = [aiRespondJob as JobDefinition<never>, aiSweepJob as JobDefinition<never>]
