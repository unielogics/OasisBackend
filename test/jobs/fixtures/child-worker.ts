// A real worker process for the kill tests (node --import tsx test/jobs/fixtures/child-worker.ts). It registers one job
// that runs the production reminders pass and then hangs, so the parent can SIGKILL it after the effect committed and
// before pg-boss was told the job finished: the case where a retry could repeat the effect.
import { loadEnv } from '../../../src/config/env.js'
import { jobRuntime } from '../../../src/modules/messaging/jobs/index.js'
import { runReminders } from '../../../src/modules/messaging/jobs/reminders.js'
import type { JobDefinition } from '../../../src/platform/jobs.js'
import { startWorker } from '../../../src/worker.js'

export const hangingReminders: JobDefinition<never> = {
  name: 'test.reminders-then-hang',
  retryLimit: 3,
  retryDelaySeconds: 1,
  expireInSeconds: 3,
  async handler(ctx) {
    await runReminders(jobRuntime(ctx))
    console.log('EFFECT_COMMITTED')
    await new Promise<void>(() => undefined)
  },
} as JobDefinition<never>

if (process.env.CHILD_WORKER === '1') {
  await startWorker({
    env: loadEnv(),
    definitions: [hangingReminders],
    pollSeconds: 0.5,
    boss: { maintenanceIntervalSeconds: 1 },
  })
  console.log('WORKER_READY')
}
