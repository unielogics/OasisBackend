// pg-boss jobs of the messaging module (registered in src/platform/job-registry.ts). The worker process runs them; each
// builds its own runtime from the environment, so nothing here depends on the API process.
//   sms.dispatch            every minute; the handler holds the leader lock and ticks every SMS_TICK_INTERVAL_MS for ~55 s
//                           (a stopping worker ends it after the current tick)
//   sms.reconcile           every 2 minutes: ask the device about texts it accepted but never confirmed; housekeeping
//   sms.device.healthcheck  every minute: poll each device, feed the health state machine
//   sms.webhooks.register   hourly (and once at boot from src/server.ts): converge the oasis-* webhooks on each device
//   email.send              every minute: send due emails through the EmailProvider
import { performance } from 'node:perf_hooks'
import { loadEnv } from '../../../config/env.js'
import { createIdGenerator } from '../../../platform/ids.js'
import type { JobContext, JobDefinition } from '../../../platform/jobs.js'
import { MessagingRuntime, runtimeFor } from '../runtime.js'

const TICK_WINDOW_MS = 55_000

/** One runtime per job context (db handle); env is read once from the process environment. */
export function jobRuntime(ctx: JobContext): MessagingRuntime {
  return runtimeFor({ db: ctx.db, clock: ctx.clock, newId: createIdGenerator(ctx.clock), env: loadEnv(), logger: ctx.logger }, ctx.db)
}

/** Resolves after ms, or as soon as the signal aborts. */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const t = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })

/**
 * Ticks the dispatcher under the leader lock for the window. When the signal aborts (the worker is stopping) it returns after the
 * current tick, so a deploy completes the run within one tick instead of killing it mid-window: the next worker's run takes over.
 */
export async function runDispatchWindow(
  rt: MessagingRuntime,
  o: { windowMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<{ ticks: number; leader: boolean }> {
  const windowMs = o.windowMs ?? TICK_WINDOW_MS
  const intervalMs = o.intervalMs ?? rt.config.tickIntervalMs
  if (o.signal?.aborted) return { ticks: 0, leader: false }
  const r = await rt.withLeader('sms.dispatch', async () => {
    const started = performance.now()
    let ticks = 0
    do {
      await rt.tickAll()
      ticks += 1
      if (o.signal?.aborted || performance.now() - started + intervalMs >= windowMs) break
      await sleep(intervalMs, o.signal)
    } while (!o.signal?.aborted && performance.now() - started < windowMs)
    return ticks
  })
  return { ticks: r ?? 0, leader: r !== null }
}

export const smsDispatchJob: JobDefinition = {
  name: 'sms.dispatch',
  cron: '* * * * *',
  policy: 'stately',
  retryLimit: 0,
  expireInSeconds: 180,
  async handler(ctx) {
    const rt = jobRuntime(ctx)
    if (rt.deps.env.SMS_DISPATCH_MODE !== 'jobs') return
    await runDispatchWindow(rt, { signal: ctx.signal })
  },
}

export const smsReconcileJob: JobDefinition = {
  name: 'sms.reconcile',
  cron: '*/2 * * * *',
  policy: 'short',
  retryLimit: 0,
  async handler(ctx) {
    const rt = jobRuntime(ctx)
    if (rt.deps.env.SMS_DISPATCH_MODE !== 'jobs') return
    await rt.withLeader('sms.reconcile', () => rt.reconcileAll())
  },
}

export const smsHealthJob: JobDefinition = {
  name: 'sms.device.healthcheck',
  cron: '* * * * *',
  policy: 'short',
  retryLimit: 0,
  async handler(ctx) {
    const rt = jobRuntime(ctx)
    if (rt.deps.env.SMS_DISPATCH_MODE !== 'jobs') return
    await rt.withLeader('sms.device.healthcheck', () => rt.pollHealthAll())
  },
}

export const smsRegisterWebhooksJob: JobDefinition = {
  name: 'sms.webhooks.register',
  cron: '7 * * * *',
  policy: 'short',
  retryLimit: 0,
  async handler(ctx) {
    const rt = jobRuntime(ctx)
    if (rt.deps.env.SMS_DISPATCH_MODE === 'off') return
    await rt.registerAll()
  },
}

export const emailSendJob: JobDefinition = {
  name: 'email.send',
  cron: '* * * * *',
  policy: 'short',
  retryLimit: 0,
  async handler(ctx) {
    const rt = jobRuntime(ctx)
    const r = await rt.emailSender.sendDue()
    if (r.sent || r.failed || r.suppressed) ctx.logger.info(r, 'emails sent')
  },
}

export const messagingJobs: readonly JobDefinition[] = [smsDispatchJob, smsReconcileJob, smsHealthJob, smsRegisterWebhooksJob, emailSendJob]
