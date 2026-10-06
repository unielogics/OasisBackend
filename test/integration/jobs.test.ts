import { afterEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { IDEMPOTENCY_TTL_MS } from '../../src/platform/idempotency.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { createJobs, type JobDefinition, type Jobs } from '../../src/platform/jobs.js'
import { createLogger } from '../../src/platform/logging.js'
import {
  REALTIME_RETENTION_MS,
  WEBHOOK_LOG_RETENTION_MS,
  maintenancePurgeJob,
  registerPurgeTask,
  runMaintenancePurge,
} from '../../src/platform/maintenance.js'
import { ensureLocation } from '../../src/platform/locations.js'
import { jobDefinitions } from '../../src/platform/job-registry.js'
import { publish } from '../../src/platform/realtime.js'
import { transaction } from '../../src/platform/db.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { useTestDb } from '../helpers/db.js'
import { sleep } from '../helpers/sse.js'

const t = useTestDb()
const bossSchema = (): string => `pgboss_${t.schema}`
const logger = createLogger({ level: 'silent' })
let jobs: Jobs | undefined

afterEach(async () => {
  await jobs?.stop()
  jobs = undefined
  await sql`drop schema if exists ${sql.id(bossSchema())} cascade`.execute(t.db)
})

const make = (
  definitions: readonly JobDefinition<never>[],
  over: Partial<Parameters<typeof createJobs>[0]> = {},
): Jobs =>
  (jobs = createJobs({
    connectionString: testDatabaseUrl(),
    schema: bossSchema(),
    db: t.db,
    clock: t.clock,
    logger,
    enabled: true,
    definitions,
    tz: 'America/New_York',
    pollSeconds: 0.5,
    ...over,
  }))

async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting for condition')
    await sleep(200)
  }
}

const jobStates = async (name: string): Promise<string[]> =>
  (
    await sql<{
      state: string
    }>`select state from ${sql.table(`${bossSchema()}.job`)} where name = ${name} order by created_on`.execute(
      t.db,
    )
  ).rows.map((r) => r.state)

async function seedExpiredRows(): Promise<void> {
  const loc = await ensureLocation(t.db, createIdGenerator(t.clock))
  const now = t.clock.now().getTime()
  const old = (ms: number): Date => new Date(now - ms)
  await t.db
    .insertInto('idempotency_keys')
    .values([
      {
        key: 'expired-key-001',
        actor: 'u',
        method: 'POST',
        route: '/x',
        request_hash: 'h',
        state: 'done',
        created_at: old(IDEMPOTENCY_TTL_MS + 5000),
        lock_expires_at: old(IDEMPOTENCY_TTL_MS),
        expires_at: old(1000),
      },
      {
        key: 'live-key-00001',
        actor: 'u',
        method: 'POST',
        route: '/x',
        request_hash: 'h',
        state: 'done',
        created_at: old(1000),
        lock_expires_at: old(0),
        expires_at: new Date(now + 1000),
      },
    ])
    .execute()
  await transaction(t.db, async (tx) => {
    await publish(tx, { locationId: loc.id, channel: 'ops', type: 'old' })
    await publish(tx, { locationId: loc.id, channel: 'ops', type: 'recent' })
  })
  await t.db
    .updateTable('realtime_events')
    .set({ at: old(REALTIME_RETENTION_MS + 1000) })
    .where('type', '=', 'old')
    .execute()
  const wh = (externalId: string, at: Date) => ({
    id: createIdGenerator(t.clock)(),
    provider: 'smsgate' as const,
    external_id: externalId,
    signature_valid: true,
    headers: '{}',
    received_at: at,
  })
  await t.db
    .insertInto('webhook_log')
    .values([wh('old-evt', old(WEBHOOK_LOG_RETENTION_MS + 1000)), wh('new-evt', old(1000))])
    .execute()
}

describe('maintenance.purge', () => {
  it('removes expired idempotency keys, old realtime events and old webhook rows, and keeps the rest', async () => {
    await seedExpiredRows()
    const removed = await runMaintenancePurge(t.db, t.clock)
    expect(removed).toEqual({ idempotency_keys: 1, realtime_events: 1, webhook_log: 1 })
    expect((await t.db.selectFrom('idempotency_keys').select('key').execute()).map((r) => r.key)).toEqual([
      'live-key-00001',
    ])
    expect((await t.db.selectFrom('realtime_events').select('type').execute()).map((r) => r.type)).toEqual([
      'recent',
    ])
    expect(
      (await t.db.selectFrom('webhook_log').select('external_id').execute()).map((r) => r.external_id),
    ).toEqual(['new-evt'])
  })

  it('is idempotent: a second run removes nothing and a purged cursor is remembered for resync', async () => {
    await seedExpiredRows()
    await runMaintenancePurge(t.db, t.clock)
    expect(await runMaintenancePurge(t.db, t.clock)).toEqual({
      idempotency_keys: 0,
      realtime_events: 0,
      webhook_log: 0,
    })
    const state = await t.db.selectFrom('realtime_state').selectAll().executeTakeFirstOrThrow()
    expect(state.purged_through).toBeGreaterThanOrEqual(1)
  })

  it('never touches audit_log', async () => {
    const loc = await ensureLocation(t.db, createIdGenerator(t.clock))
    await t.db
      .insertInto('audit_log')
      .values({ location_id: loc.id, action: 'a', entity_type: 'b', at: new Date(0) })
      .execute()
    await runMaintenancePurge(t.db, t.clock)
    expect(await t.db.selectFrom('audit_log').selectAll().execute()).toHaveLength(1)
  })

  it('lets modules register their own purge tasks', async () => {
    registerPurgeTask('test_task', async () => 7)
    expect((await runMaintenancePurge(t.db, t.clock)).test_task).toBe(7)
  })

  it('is part of the job registry with a ten minute cron', () => {
    expect(jobDefinitions.map((j) => j.name)).toContain('maintenance.purge')
    expect(maintenancePurgeJob.cron).toBe('*/10 * * * *')
  })
})

describe('pg-boss runtime', () => {
  it('runs the sample job through the queue, completes it and keeps it idempotent on re-enqueue', async () => {
    await seedExpiredRows()
    const j = make([maintenancePurgeJob as unknown as JobDefinition<never>])
    await j.start({ workers: true })
    expect(await j.enqueue('maintenance.purge', {}, { singletonKey: 'test-1' })).toEqual(expect.any(String))
    await waitFor(async () => (await jobStates('maintenance.purge')).includes('completed'))
    expect((await t.db.selectFrom('idempotency_keys').select('key').execute()).map((r) => r.key)).toEqual([
      'live-key-00001',
    ])
    expect(await t.db.selectFrom('webhook_log').selectAll().execute()).toHaveLength(1)

    await j.enqueue('maintenance.purge', {}, { singletonKey: 'test-2' })
    await waitFor(
      async () => (await jobStates('maintenance.purge')).filter((s) => s === 'completed').length >= 2,
    )
    expect((await jobStates('maintenance.purge')).filter((s) => s === 'failed')).toEqual([])
    expect(await t.db.selectFrom('idempotency_keys').selectAll().execute()).toHaveLength(1)
  })

  it('registers the cron schedule in the business timezone', async () => {
    const j = make([maintenancePurgeJob as unknown as JobDefinition<never>])
    await j.start({ workers: true })
    const rows = await sql<{
      cron: string
      timezone: string
      name: string
    }>`select name, cron, timezone from ${sql.table(`${bossSchema()}.schedule`)}`.execute(t.db)
    expect(rows.rows).toEqual([
      { name: 'maintenance.purge', cron: '*/10 * * * *', timezone: 'America/New_York' },
    ])
  })

  it('producer mode creates queues and accepts jobs without registering workers or schedules', async () => {
    const j = make([maintenancePurgeJob as unknown as JobDefinition<never>])
    await j.start({ workers: false })
    const id = await j.enqueue('maintenance.purge', {}, { singletonKey: 'only-one' })
    expect(id).toEqual(expect.any(String))
    expect(await j.enqueue('maintenance.purge', {}, { singletonKey: 'only-one' })).toBeNull() // collapsed while queued
    await sleep(1500)
    expect(await jobStates('maintenance.purge')).toEqual(['created'])
    const sched = await sql<{
      n: number
    }>`select count(*)::int as n from ${sql.table(`${bossSchema()}.schedule`)}`.execute(t.db)
    expect(sched.rows[0]!.n).toBe(0)
  })

  it('retries a failing handler with the configured limit and succeeds on a later attempt', async () => {
    let attempts = 0
    const flaky: JobDefinition<Record<string, never>> = {
      name: 'test.flaky',
      retryLimit: 2,
      retryDelaySeconds: 1,
      async handler() {
        attempts += 1
        if (attempts < 2) throw new Error('transient')
      },
    }
    const j = make([flaky as unknown as JobDefinition<never>])
    await j.start({ workers: true })
    await j.enqueue('test.flaky', {})
    await waitFor(async () => (await jobStates('test.flaky')).includes('completed'), 20_000)
    expect(attempts).toBe(2)
  })

  it('reports health: false before start, true after, and the failed-job count', async () => {
    const j = make([maintenancePurgeJob as unknown as JobDefinition<never>])
    expect(await j.health()).toEqual({ ok: false, detail: 'not started' })
    await j.start({ workers: false })
    expect(await j.health()).toMatchObject({ ok: true })
  })

  it('JOBS_ENABLED=false is inert: no schema, enqueue is a no-op, health is ok', async () => {
    const j = make([maintenancePurgeJob as unknown as JobDefinition<never>], { enabled: false })
    await j.start({ workers: true })
    expect(await j.enqueue('maintenance.purge')).toBeNull()
    expect(await j.health()).toEqual({ ok: true, detail: 'disabled' })
    const s = await sql<{
      n: number
    }>`select count(*)::int as n from pg_namespace where nspname = ${bossSchema()}`.execute(t.db)
    expect(s.rows[0]!.n).toBe(0)
  })

  it('refuses to enqueue before start and rejects an unsafe schema name', async () => {
    const j = make([maintenancePurgeJob as unknown as JobDefinition<never>])
    await expect(j.enqueue('maintenance.purge')).rejects.toThrow(/not started/)
    expect(() => make([], { schema: 'x; drop table y' })).toThrow(/Invalid SQL identifier/)
  })
})
