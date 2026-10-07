// SMS_DISPATCH_MODE=inline: the API process runs the dispatch loop itself (single-process deployments, the live-stack
// harness). Same operations as the pg-boss jobs, guarded by the same leader lock, so inline and worker never overlap.
import { connectDedicated, type DbOptions } from '../../../platform/db.js'
import type { MessagingRuntime } from '../runtime.js'

export interface InlineRunner {
  stop(): Promise<void>
}

export async function startInlineRunner(rt: MessagingRuntime, connection: DbOptions): Promise<InlineRunner> {
  const log = rt.log
  const timers: NodeJS.Timeout[] = []
  let stopped = false
  let leader = false
  let lock: Awaited<ReturnType<typeof connectDedicated>> | undefined

  const acquire = async (): Promise<void> => {
    if (stopped || leader) return
    const client = await connectDedicated(connection)
    const r = await client.query<{ ok: boolean }>(
      'select pg_try_advisory_lock(hashtext($1 || current_schema())) as ok',
      ['sms.dispatch'],
    )
    if (!r.rows[0]?.ok) {
      await client.end().catch(() => undefined)
      return
    }
    const lose = (): void => {
      if (lock === client) {
        leader = false
        lock = undefined
        log.warn({}, 'inline sms runner lost its leader lock')
      }
    }
    client.on('error', lose)
    client.on('end', lose)
    lock = client
    leader = true
    log.info({}, 'inline sms runner is the leader')
    await rt.registerAll()
  }

  const every = (ms: number, name: string, fn: () => Promise<unknown>): void => {
    let busy = false
    const t = setInterval(() => {
      if (stopped || busy) return
      busy = true
      void (async () => {
        try {
          if (!leader) await acquire()
          if (leader) await fn()
        } catch (err) {
          log.error({ err: (err as Error).message, task: name }, 'inline sms runner task failed')
        } finally {
          busy = false
        }
      })()
    }, ms)
    t.unref()
    timers.push(t)
  }

  every(rt.config.tickIntervalMs, 'tick', () => rt.tickAll())
  every(60_000, 'health', () => rt.pollHealthAll())
  every(120_000, 'reconcile', () => rt.reconcileAll())
  every(3_600_000, 'register', () => rt.registerAll())
  every(30_000, 'email', () => rt.emailSender.sendDue())
  await acquire().catch((err: unknown) =>
    log.error({ err: (err as Error).message }, 'inline sms runner could not start'),
  )

  return {
    async stop() {
      stopped = true
      for (const t of timers) clearInterval(t)
      leader = false
      const c = lock
      lock = undefined
      await c?.end().catch(() => undefined)
    },
  }
}
