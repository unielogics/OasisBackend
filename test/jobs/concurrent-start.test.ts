// The API and the worker both run jobs.start(), and a deploy restarts them back to back. Creating the same NEW queue in two
// processes at once deadlocked inside pg-boss and crashed the worker during a deploy (2026-10-11); start() now sets queues up
// under one advisory lock per pg-boss schema and retries a deadlock.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { createJobs, retryOnDeadlock, withSetupLock, type JobDefinition } from '../../src/platform/jobs.js'
import { createLogger } from '../../src/platform/logging.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { useJobsHarness } from './harness.js'

const h = useJobsHarness()
const quiet = () => createLogger({ level: 'silent' })

const defsFor = (round: number): JobDefinition<never>[] =>
  Array.from({ length: 6 }, (_, i) => ({
    name: `test.concurrent_${round}_${i}`,
    handler: async () => undefined,
  })) as unknown as JobDefinition<never>[]

const jobsOn = (schema: string, definitions: JobDefinition<never>[]) =>
  createJobs({
    connectionString: testDatabaseUrl(),
    schema,
    db: h.t.db,
    clock: h.clock,
    logger: quiet(),
    enabled: true,
    definitions,
    tz: 'America/New_York',
  })

describe('jobs.start in two processes at once', () => {
  it('creates the same new queues from two runtimes started together, round after round, without a deadlock', async () => {
    const schema = h.newSchema()
    for (let round = 1; round <= 3; round++) {
      const defs = defsFor(round)
      const a = jobsOn(schema, defs)
      const b = jobsOn(schema, defs)
      try {
        const results = await Promise.allSettled([a.start({ workers: false }), b.start({ workers: false })])
        expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled'])
        const names = await sql<{ name: string }>`select name from ${sql.table(`${schema}.queue`)}`.execute(h.t.db)
        const have = new Set(names.rows.map((r) => r.name))
        for (const d of defs) {
          expect(have.has(d.name)).toBe(true)
          expect(have.has(`${d.name}.dead`)).toBe(true)
        }
      } finally {
        await Promise.all([a.stop(), b.stop()])
      }
    }
  })
})

describe('withSetupLock', () => {
  it('runs one setup at a time per pg-boss schema, and another schema is not held up', async () => {
    const order: string[] = []
    const slow = (tag: string) => async () => {
      order.push(`${tag}:in`)
      await new Promise((r) => setTimeout(r, 150))
      order.push(`${tag}:out`)
    }
    await Promise.all([
      withSetupLock(h.t.db, 'pgb_lock_test', quiet(), slow('a')),
      withSetupLock(h.t.db, 'pgb_lock_test', quiet(), slow('b')),
    ])
    expect([order.slice(0, 2), order.slice(2)]).toEqual(
      order[0] === 'a:in' ? [['a:in', 'a:out'], ['b:in', 'b:out']] : [['b:in', 'b:out'], ['a:in', 'a:out']],
    )
    const other: string[] = []
    await Promise.all([
      withSetupLock(h.t.db, 'pgb_lock_x', quiet(), async () => {
        other.push('x:in')
        await new Promise((r) => setTimeout(r, 150))
        other.push('x:out')
      }),
      withSetupLock(h.t.db, 'pgb_lock_y', quiet(), async () => {
        other.push('y:in')
        await new Promise((r) => setTimeout(r, 150))
        other.push('y:out')
      }),
    ])
    expect(other.slice(0, 2).sort()).toEqual(['x:in', 'y:in'])
  })

  it('releases the lock when the setup throws, and goes ahead without it after the wait', async () => {
    await expect(
      withSetupLock(h.t.db, 'pgb_lock_err', quiet(), async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    let ran = false
    await withSetupLock(h.t.db, 'pgb_lock_err', quiet(), async () => {
      ran = true
    })
    expect(ran).toBe(true)

    // another session holds the lock: the setup still runs after the (shortened) wait
    await h.t.db.connection().execute(async (holder) => {
      await sql`select pg_advisory_lock(hashtext(${'oasis-jobs-setup:pgb_lock_held'}))`.execute(holder)
      try {
        let went = false
        await withSetupLock(h.t.db, 'pgb_lock_held', quiet(), async () => {
          went = true
        }, 300)
        expect(went).toBe(true)
      } finally {
        await sql`select pg_advisory_unlock(hashtext(${'oasis-jobs-setup:pgb_lock_held'}))`.execute(holder)
      }
    })
  })
})

describe('retryOnDeadlock', () => {
  const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' })

  it('retries a deadlock and returns the eventual result', async () => {
    let n = 0
    await expect(
      retryOnDeadlock(async () => {
        if (++n < 3) throw deadlock()
        return 'ok'
      }),
    ).resolves.toBe('ok')
    expect(n).toBe(3)
  })

  it('rethrows any other error at once, and a deadlock after the last attempt', async () => {
    let n = 0
    await expect(
      retryOnDeadlock(async () => {
        n++
        throw Object.assign(new Error('unique violation'), { code: '23505' })
      }),
    ).rejects.toThrow('unique violation')
    expect(n).toBe(1)
    n = 0
    await expect(
      retryOnDeadlock(async () => {
        n++
        throw deadlock()
      }, 3),
    ).rejects.toThrow('deadlock detected')
    expect(n).toBe(3)
  })
})
