// The read side on real pg-boss: the queues exist, the cron schedules are registered, and a queued sync, webhook and
// membership pass run end to end against the simulator.
import { afterEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { membershipCycleJob } from '../../src/modules/memberships/jobs.js'
import { sqspJobs } from '../../src/modules/payments-sync/jobs/index.js'
import { replaceProductRows } from '../../src/modules/payments-sync/db/product-map.js'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { jobDefinitions } from '../../src/platform/job-registry.js'
import { createJobs, type Jobs } from '../../src/platform/jobs.js'
import { createLogger } from '../../src/platform/logging.js'
import { transaction } from '../../src/platform/db.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { sleep } from '../helpers/sse.js'
import { useRig } from './harness.js'

describe('pg-boss jobs against the simulator', () => {
  const rig = useRig({ pageSize: 50 })
  let jobs: Jobs | undefined
  const boss = (): string => `pgboss_${rig().t.schema}`

  afterEach(async () => {
    await jobs?.stop()
    jobs = undefined
    await sql`drop schema if exists ${sql.id(boss())} cascade`.execute(rig().db)
  })

  async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> {
    const end = Date.now() + ms
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() > end) throw new Error('timed out waiting for condition')
      await sleep(200)
    }
  }

  const start = async () => {
    const r = rig()
    jobs = createJobs({
      connectionString: testDatabaseUrl(),
      schema: boss(),
      db: r.db,
      clock: r.clock,
      logger: createLogger({ level: 'silent' }),
      enabled: true,
      definitions: [...sqspJobs, membershipCycleJob] as never,
      tz: 'America/New_York',
      pollSeconds: 0.5,
    })
    await jobs.start({ workers: true })
    return jobs
  }

  const states = async (name: string) =>
    (await sql<{ state: string }>`select state from ${sql.table(`${boss()}.job`)} where name = ${name} order by created_on`.execute(rig().db)).rows.map((x) => x.state)

  it('registers every job in the registry with a queue, and schedules the cron ones in the business timezone', async () => {
    const names = jobDefinitions.map((j) => j.name)
    expect(new Set(names).size).toBe(names.length)
    for (const n of ['sqsp.sync', 'sqsp.contacts', 'sqsp.reconcile', 'sqsp.webhook.process', 'membership.cycle']) expect(names).toContain(n)
    await start()
    const queues = (await sql<{ name: string }>`select name from ${sql.table(`${boss()}.queue`)}`.execute(rig().db)).rows.map((x) => x.name)
    for (const n of ['sqsp.sync', 'sqsp.contacts', 'sqsp.reconcile', 'sqsp.webhook.process', 'membership.cycle']) expect(queues).toContain(n)
    const sched = (await sql<{ name: string; cron: string; timezone: string }>`select name, cron, timezone from ${sql.table(`${boss()}.schedule`)}`.execute(rig().db)).rows
    const by = Object.fromEntries(sched.map((s) => [s.name, s]))
    expect(by['sqsp.sync']?.cron).toBe('*/2 * * * *')
    expect(by['sqsp.contacts']?.cron).toBe('17 * * * *')
    expect(by['sqsp.reconcile']?.cron).toBe('30 2 * * *')
    expect(by['membership.cycle']?.cron).toBe('0 3 * * *')
    expect(by['sqsp.webhook.process']).toBeUndefined() // queue only
    for (const n of ['sqsp.sync', 'sqsp.reconcile', 'membership.cycle']) expect(by[n]?.timezone).toBe('America/New_York')
  })

  it('a queued sqsp.sync polls the simulator, matches, runs the membership pass and finishes', async () => {
    const r = rig()
    await ensurePlans(r.db, { locationId: r.locationId, clock: r.clock, newId: r.newId })
    await transaction(r.db, (tx) =>
      replaceProductRows(tx, { locationId: r.locationId, clock: r.clock, newId: r.newId }, [
        { sku: 'DET-SEDAN', kind: 'service' },
        { sku: 'MEM-ESS', kind: 'membership', plan: 'essential' },
      ]),
    )
    const cust = await r.db.insertInto('customers').values({ id: r.newId(), full_name: 'Maria Alvarez', email: 'maria@example.com', source: 'import' }).returning('id').executeTakeFirstOrThrow()
    r.store.createOrder({ email: 'maria@example.com', name: 'Maria Alvarez', lineItems: [{ productId: 'p', sku: 'MEM-ESS', name: 'Essential', unitCents: 9900 }] })
    r.store.createOrder({ email: 'x@example.com', name: 'X', lineItems: [{ productId: 'q', sku: 'DET-SEDAN', name: 'Detail', unitCents: 18900 }], taxCents: 1323 })
    r.advance(60_000)
    const j = await start()
    expect(await j.enqueue('sqsp.sync', {}, { singletonKey: 'test' })).toBeTruthy()
    await waitFor(async () => (await states('sqsp.sync')).includes('completed'))
    expect(await r.db.selectFrom('sqsp_orders').select('id').execute()).toHaveLength(2)
    const orders = await r.db.selectFrom('sqsp_orders').select(['match_state']).orderBy('match_state').execute()
    expect(orders.map((o) => o.match_state)).toEqual(['manual', 'membership'])
    const m = await r.db.selectFrom('memberships').select(['status', 'customer_id']).executeTakeFirstOrThrow()
    expect(m).toEqual({ status: 'active', customer_id: cust.id })
    expect((await r.db.selectFrom('sqsp_sync_state').select('status').where('resource', '=', 'orders').executeTakeFirstOrThrow()).status).toBe('ok')
  })

  it('a queued sqsp.webhook.process stores the order and the daily membership.cycle job completes', async () => {
    const r = rig()
    const { orderId } = r.store.createOrder({ email: 'w@example.com', name: 'W', lineItems: [{ productId: 'p', sku: 'ANY', name: 'Thing', unitCents: 1000 }] })
    const id = r.newId()
    await r.db.insertInto('webhook_log').values({ id, provider: 'squarespace', external_id: 'n-1', headers: '{}', signature_valid: true }).execute()
    const j = await start()
    await j.enqueue('sqsp.webhook.process', { orderId, notificationId: 'n-1', locationId: r.locationId })
    await j.enqueue('membership.cycle', {})
    await waitFor(async () => (await states('sqsp.webhook.process')).includes('completed'))
    await waitFor(async () => (await states('membership.cycle')).includes('completed'))
    expect((await r.db.selectFrom('sqsp_orders').select('sqsp_order_id').executeTakeFirstOrThrow()).sqsp_order_id).toBe(orderId)
    expect((await r.db.selectFrom('webhook_log').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status).toBe('processed')
    expect((await r.db.selectFrom('membership_plans').select('id').execute()).length).toBe(4)
  })

  it('a failing sync run does not throw into pg-boss (the state records it) and is not retried', async () => {
    const r = rig()
    r.api.injectFailure({ status: 500, times: 100 })
    r.advance(60_000)
    const j = await start()
    await j.enqueue('sqsp.sync', {})
    await waitFor(async () => (await states('sqsp.sync')).some((s) => s === 'completed' || s === 'failed'))
    expect(await states('sqsp.sync')).toEqual(['completed'])
    const st = await r.db.selectFrom('sqsp_sync_state').select(['status', 'consecutive_failures']).where('resource', '=', 'orders').executeTakeFirstOrThrow()
    expect(st).toEqual({ status: 'error', consecutive_failures: 1 })
  })
})
