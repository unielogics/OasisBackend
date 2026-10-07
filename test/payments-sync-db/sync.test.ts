import { describe, expect, it } from 'vitest'
import { createPermissiveAuthorizer } from '../../src/http/authorizer.js'
import { apiModules } from '../../src/http/modules.js'
import { createTestApp } from '../helpers/app.js'
import { makeUser } from '../helpers/factories.js'
import { replaceProductRows } from '../../src/modules/payments-sync/db/product-map.js'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { transaction } from '../../src/platform/db.js'
import { SquarespaceClient } from '../../src/integrations/squarespace/client.js'
import { configureSqspRuntime, createSqspRuntime } from '../../src/modules/payments-sync/db/runtime-config.js'
import { simFetch } from '../integrations/squarespace/helpers.js'
import { D, H, SECRETS_KEY, SIM_KEY, useRig } from './harness.js'

describe('polling: watermark, overlap, chunks, failures', () => {
  const rig = useRig({ pageSize: 50 })
  const line = { productId: 'p-det', sku: 'DET-SEDAN', name: 'Full Detail', unitCents: 18900 }

  async function mapDetailSku() {
    const r = rig()
    await ensurePlans(r.db, { locationId: r.locationId, clock: r.clock, newId: r.newId })
    await transaction(r.db, (tx) =>
      replaceProductRows(tx, { locationId: r.locationId, clock: r.clock, newId: r.newId }, [
        { sku: 'DET-SEDAN', kind: 'service' },
      ]),
    )
  }

  const orderWindows = (r: ReturnType<typeof rig>) =>
    r.api.log
      .filter((l) => l.path.startsWith('/1.0/commerce/orders') && !l.path.includes('cursor='))
      .map((l) => {
        const q = new URLSearchParams(l.path.split('?')[1])
        return { after: new Date(q.get('modifiedAfter')!), before: new Date(q.get('modifiedBefore')!) }
      })

  it('the first run looks back 45 days and the next window starts 5 minutes before the watermark', async () => {
    const r = rig()
    await mapDetailSku()
    r.store.createOrder({
      email: 'a@example.com',
      name: 'A',
      lineItems: [line],
      createdOn: new Date(r.clock.now().getTime() - 40 * D),
    })
    const t0 = r.clock.now()
    const first = await r.rt.syncCycle(r.locationId)
    expect(first.orders?.inserted).toBe(1)
    const w1 = orderWindows(r)
    // 45 days in 7-day chunks: 7 windows, the first starting 45 days (+ the 5 minute overlap) back
    expect(w1.length).toBe(Math.ceil((45 * D + 5 * 60_000) / (7 * D)))
    expect(w1[0]!.after.getTime()).toBe(t0.getTime() - 45 * D - 5 * 60_000)
    for (const w of w1) expect(w.before.getTime() - w.after.getTime()).toBeLessThanOrEqual(7 * D)
    const state = await r.db
      .selectFrom('sqsp_sync_state')
      .select(['watermark', 'status', 'last_success_at'])
      .where('resource', '=', 'orders')
      .executeTakeFirstOrThrow()
    expect(state.watermark?.toISOString()).toBe(t0.toISOString())
    expect(state.status).toBe('ok')
    r.api.log.length = 0
    r.advance(120_000)
    const second = await r.rt.syncCycle(r.locationId)
    expect(second.orders).toMatchObject({ inserted: 0, updated: 0, seen: 0 })
    const w2 = orderWindows(r)
    expect(w2).toHaveLength(1)
    expect(w2[0]!.after.getTime()).toBe(t0.getTime() - 5 * 60_000)
    expect(w2[0]!.before.getTime()).toBe(t0.getTime() + 120_000)
  })

  it('a 20-day outage is read back in 7-day chunks, saving progress, with no gap between windows', async () => {
    const r = rig()
    await mapDetailSku()
    await r.rt.syncCycle(r.locationId)
    r.api.log.length = 0
    r.advance(20 * D)
    const o = r.store.createOrder({
      email: 'b@example.com',
      name: 'B',
      lineItems: [line],
      createdOn: new Date(r.clock.now().getTime() - 10 * D),
    })
    void o
    const res = await r.rt.syncCycle(r.locationId)
    expect(res.status).toBe('ok')
    const w = orderWindows(r)
    expect(w.length).toBe(3)
    for (let i = 1; i < w.length; i++)
      expect(w[i]!.after.getTime()).toBeLessThanOrEqual(w[i - 1]!.before.getTime())
    expect(w[w.length - 1]!.before.getTime()).toBe(r.clock.now().getTime())
    expect(res.orders?.inserted).toBe(1)
  })

  it('stops after 5 failed runs (dead letter), alerts, skips polling, and resumes on request', async () => {
    const r = rig()
    await mapDetailSku()
    await r.rt.syncCycle(r.locationId)
    // each run spends 5 attempts on orders and 5 on transactions: 5 runs use up exactly these 50 failures
    r.api.injectFailure({ status: 500, times: 50 })
    for (let i = 1; i <= 5; i++) {
      r.advance(120_000)
      const res = await r.rt.syncCycle(r.locationId)
      expect(res.status).toBe('error')
      expect(res.orders?.status).toBe(i < 5 ? 'error' : 'dead_letter')
    }
    const st = await r.db
      .selectFrom('sqsp_sync_state')
      .select(['resource', 'status', 'consecutive_failures'])
      .where('resource', 'in', ['orders', 'transactions'])
      .orderBy('resource')
      .execute()
    expect(st).toEqual([
      { resource: 'orders', status: 'dead_letter', consecutive_failures: 5 },
      { resource: 'transactions', status: 'dead_letter', consecutive_failures: 5 },
    ])
    const codes = (
      await r.db.selectFrom('sqsp_alerts').select('code').where('resolved_at', 'is', null).execute()
    ).map((a) => a.code)
    expect(codes).toContain('sync_dead_letter')
    expect(codes).toContain('sync_failing')
    // dead-lettered: the next run does not even call Squarespace
    r.api.log.length = 0
    const skipped = await r.rt.syncCycle(r.locationId)
    expect(skipped.orders?.status).toBe('skipped')
    expect(r.api.log).toHaveLength(0)
    // resume after the cause is fixed (the injected failures are used up)
    r.store.createOrder({ email: 'c@example.com', name: 'C', lineItems: [line] })
    r.advance(120_000)
    const resumed = await r.rt.syncCycle(r.locationId, { resume: true })
    expect(resumed.status).toBe('ok')
    expect(resumed.orders?.inserted).toBe(1)
    const open = (
      await r.db.selectFrom('sqsp_alerts').select('code').where('resolved_at', 'is', null).execute()
    ).map((a) => a.code)
    expect(open).not.toContain('sync_dead_letter')
    expect(open).not.toContain('sync_failing')
  })

  it('an order that cannot be stored is dead-lettered after 5 tries without wedging the watermark', async () => {
    const r = rig()
    await mapDetailSku()
    await r.rt.syncCycle(r.locationId)
    // 30,000,000.00 dollars does not fit the integer-cents column: a persist failure that repeats
    r.store.createOrder({
      email: 'big@example.com',
      name: 'Big',
      lineItems: [{ ...line, unitCents: 3_000_000_000 }],
      pay: false,
    })
    const good = r.store.createOrder({ email: 'ok@example.com', name: 'Ok', lineItems: [line] })
    void good
    const results = []
    for (let i = 1; i <= 5; i++) {
      r.advance(120_000)
      results.push(await r.rt.syncCycle(r.locationId))
    }
    expect(results.slice(0, 4).every((x) => x.orders?.status === 'error')).toBe(true)
    expect(results[4]!.orders?.status).toBe('ok')
    expect(results[4]!.orders?.deadLettered).toBe(1)
    const errs = await r.db.selectFrom('sqsp_sync_errors').selectAll().execute()
    expect(errs).toHaveLength(1)
    expect(errs[0]).toMatchObject({ resource: 'orders', kind: 'persist', attempts: 5 })
    expect(errs[0]!.dead_lettered_at).not.toBeNull()
    const state = await r.db
      .selectFrom('sqsp_sync_state')
      .select(['watermark'])
      .where('resource', '=', 'orders')
      .executeTakeFirstOrThrow()
    expect(state.watermark!.getTime()).toBe(r.clock.now().getTime())
    // the good order was stored all along
    expect((await r.db.selectFrom('sqsp_orders').select('id').execute()).length).toBe(1)
  })

  it('the nightly reconcile re-reads 45 days, picks up what the poll missed (a late commit), matches it, and is quiet the second time', async () => {
    const r = rig()
    await mapDetailSku()
    await r.rt.syncCycle(r.locationId)
    r.advance(2 * H)
    // committed late with an old modification time: outside every poll window after the watermark
    const late = r.store.createOrder({
      email: 'late@example.com',
      name: 'Late',
      lineItems: [line],
      taxCents: 1323,
      createdOn: new Date(r.clock.now().getTime() - 3 * D),
    })
    r.advance(120_000)
    const poll = await r.rt.syncCycle(r.locationId)
    expect(poll.orders?.inserted).toBe(0)
    expect(await r.db.selectFrom('sqsp_orders').select('id').execute()).toHaveLength(0)
    const logger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      child: () => logger,
    } as never
    const { sqspReconcileJob } = await import('../../src/modules/payments-sync/jobs/index.js')
    await sqspReconcileJob.handler({ db: r.db, clock: r.clock, logger }, {} as never, { id: 'j' })
    const row = await r.db
      .selectFrom('sqsp_orders')
      .select(['sqsp_order_id', 'match_state'])
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ sqsp_order_id: late.orderId, match_state: 'manual' })
    const state = await r.db
      .selectFrom('sqsp_sync_state')
      .select(['status', 'watermark'])
      .where('resource', '=', 'reconcile')
      .executeTakeFirstOrThrow()
    expect(state.status).toBe('ok')
    // the reconcile does not touch the poll watermarks
    const orders = await r.db
      .selectFrom('sqsp_sync_state')
      .select('watermark')
      .where('resource', '=', 'orders')
      .executeTakeFirstOrThrow()
    expect(orders.watermark!.getTime()).toBe(r.clock.now().getTime())
    r.advance(H)
    const writes = await r.db.selectFrom('sqsp_orders').select('synced_at').executeTakeFirstOrThrow()
    await sqspReconcileJob.handler({ db: r.db, clock: r.clock, logger }, {} as never, { id: 'j2' })
    expect(
      (
        await r.db.selectFrom('sqsp_orders').select('synced_at').executeTakeFirstOrThrow()
      ).synced_at.getTime(),
    ).toBe(writes.synced_at.getTime())
  })

  it('a rejected key is recorded on the connection and raises sync_failing on the third run', async () => {
    const r = rig()
    await mapDetailSku()
    // a stored key Squarespace does not know: the client built from it is answered 401
    configureSqspRuntime({
      env: r.env,
      sleeper: r.sleeper,
      sourceFactory: ({ apiKey }) =>
        new SquarespaceClient({
          auth: { kind: 'api_key', apiKey },
          clock: r.clock,
          sleeper: r.sleeper,
          fetch: simFetch(r.api),
          userAgent: 'OasisTest/1.0',
        }),
    })
    const rt = createSqspRuntime({ db: r.db, clock: r.clock, newId: r.newId, env: r.env })
    await rt.connection(r.locationId).save('revoked-key-123', { verified: false })
    for (let i = 1; i <= 3; i++) {
      r.advance(120_000)
      const res = await rt.syncCycle(r.locationId)
      expect(res.status).toBe('error')
      expect(res.orders?.error).toMatch(/401/)
    }
    const conn = await r.db
      .selectFrom('sqsp_connections')
      .select(['status', 'last_error'])
      .executeTakeFirstOrThrow()
    expect(conn.status).toBe('error')
    expect(conn.last_error).toMatch(/401/)
    expect(conn.last_error).not.toContain('revoked-key-123')
    const alerts = await r.db
      .selectFrom('sqsp_alerts')
      .select(['code', 'message'])
      .where('resolved_at', 'is', null)
      .execute()
    expect(alerts.map((a) => a.code)).toContain('sync_failing')
    expect(JSON.stringify(alerts)).not.toContain('revoked-key-123')
  })
})

describe('the product map and test-mode orders', () => {
  const rig = useRig({ pageSize: 50 })
  const line = { productId: 'p-det', sku: 'DET-SEDAN', name: 'Full Detail', unitCents: 18900 }

  it('an empty product map raises product_map_empty and ignores every order; mapping a product reopens them', async () => {
    const r = rig()
    const user = await makeUser(r.db, r.newId)
    r.store.createOrder({ email: 'a@example.com', name: 'A', lineItems: [line], taxCents: 1323 })
    r.advance(120_000)
    const res = await r.rt.syncCycle(r.locationId)
    expect(res.match?.ignored).toBe(1)
    expect(res.match?.alerts).toBeGreaterThanOrEqual(1)
    const open = await r.db
      .selectFrom('sqsp_alerts')
      .select(['code', 'message'])
      .where('resolved_at', 'is', null)
      .execute()
    expect(open.map((a) => a.code)).toEqual(['product_map_empty'])
    expect(open[0]!.message).toMatch(/SQSP_PRODUCT_MAP/)
    const order = await r.db
      .selectFrom('sqsp_orders')
      .select(['match_state', 'ignore_reason'])
      .executeTakeFirstOrThrow()
    expect(order).toEqual({ match_state: 'ignored', ignore_reason: 'unmapped_sku' })

    const app = await createTestApp({
      testDb: r.t,
      modules: apiModules,
      env: { SQSP_PROVIDER: 'live', SQSP_API_KEY: SIM_KEY, SECRETS_KEY },
      authorizer: (l) =>
        createPermissiveAuthorizer({ locationId: l.id, userId: user.userId, employeeId: user.employeeId }),
    })
    const put = await app.app.inject({
      method: 'PUT',
      url: '/api/v1/integrations/squarespace/product-map',
      payload: { entries: [{ sku: 'DET-SEDAN', kind: 'service', name: 'Full Detail' }] },
    })
    expect(put.statusCode, put.body).toBe(200)
    expect((put.json() as { reopenedOrders: number }).reopenedOrders).toBe(1)
    expect(
      await r.db.selectFrom('sqsp_alerts').select('id').where('resolved_at', 'is', null).execute(),
    ).toHaveLength(0)
    const reopened = await r.db.selectFrom('sqsp_orders').select('match_state').executeTakeFirstOrThrow()
    expect(reopened.match_state).toBe('unmatched')
    r.advance(120_000)
    const next = await r.rt.syncCycle(r.locationId)
    // mapped now, but nobody recorded a payment for it: the manual queue, not the ignore pile
    expect(next.match?.manual).toBe(1)
    await app.close()
  })

  it('test-mode orders are ignored unless SQSP_INCLUDE_TEST_ORDERS is set', async () => {
    const r = rig()
    r.store.createOrder({
      email: 't@example.com',
      name: 'T',
      lineItems: [line],
      taxCents: 1323,
      testMode: true,
    })
    r.advance(120_000)
    await r.rt.syncCycle(r.locationId)
    const o = await r.db
      .selectFrom('sqsp_orders')
      .select(['match_state', 'ignore_reason', 'test_mode'])
      .executeTakeFirstOrThrow()
    expect(o).toEqual({ match_state: 'ignored', ignore_reason: 'test_mode', test_mode: true })
    const t = await r.db
      .selectFrom('sqsp_transactions')
      .select(['state', 'ignore_reason'])
      .executeTakeFirstOrThrow()
    expect(t).toEqual({ state: 'ignored', ignore_reason: 'test_mode' })
  })
})

describe('test-mode orders with the flag on', () => {
  const rig = useRig({
    pageSize: 50,
    env: {
      SQSP_INCLUDE_TEST_ORDERS: 'true',
      SQSP_PRODUCT_MAP: JSON.stringify([{ sku: 'DET-SEDAN', kind: 'service' }]),
    },
  })
  it('are processed like real ones', async () => {
    const r = rig()
    r.store.createOrder({
      email: 't@example.com',
      name: 'T',
      lineItems: [{ productId: 'p', sku: 'DET-SEDAN', name: 'Full Detail', unitCents: 18900 }],
      taxCents: 1323,
      testMode: true,
    })
    r.advance(120_000)
    const res = await r.rt.syncCycle(r.locationId)
    expect(res.match?.manual).toBe(1)
    expect(
      (await r.db.selectFrom('sqsp_orders').select('match_state').executeTakeFirstOrThrow()).match_state,
    ).toBe('manual')
  })
})
