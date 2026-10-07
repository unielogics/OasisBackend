// POST /hooks/squarespace: signature, replay and duplicate handling, out-of-order updates, queueing.
import { describe, expect, it } from 'vitest'
import { hookModules } from '../../src/http/modules.js'
import { buildSignedNotification } from '../../src/integrations/squarespace/webhook.js'
import { createSecretBox } from '../../src/modules/payments-sync/db/secrets.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { H, SECRETS_KEY, useRig } from './harness.js'

const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
const SUB_SECRET = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'

describe('POST /hooks/squarespace', () => {
  const rig = useRig({ pageSize: 50 })

  async function appWith(extra: Record<string, unknown> = {}): Promise<TestApp> {
    const r = rig()
    return createTestApp({
      testDb: r.t,
      modules: [],
      hookModules,
      env: { SQSP_PROVIDER: 'live', SQSP_API_KEY: 'sim-api-key', SECRETS_KEY, SQSP_WEBHOOK_SECRET: SECRET },
      ...extra,
    })
  }

  const notification = (r: ReturnType<typeof rig>, o: { id: string; topic?: string; orderId?: string; update?: string; secret?: string; createdOn?: Date; sub?: string }) =>
    buildSignedNotification({
      secretHex: o.secret ?? SECRET,
      id: o.id,
      websiteId: 'w-1',
      subscriptionId: o.sub ?? 'sub-1',
      topic: o.topic ?? 'order.create',
      createdOn: o.createdOn ?? r.clock.now(),
      data: { orderId: o.orderId ?? 'missing', ...(o.update ? { update: o.update } : {}) },
    })

  const post = (app: TestApp, n: { rawBody: string; headers: Record<string, string> }) =>
    app.app.inject({ method: 'POST', url: '/hooks/squarespace', headers: n.headers, payload: n.rawBody })

  const line = { productId: 'p', sku: 'X', name: 'Thing', unitCents: 1000 }

  it('stores the order named by a verified notification and logs it; the same notification again is a no-op', async () => {
    const r = rig()
    const app = await appWith()
    const { orderId } = r.store.createOrder({ email: 'w@example.com', name: 'W', lineItems: [line] })
    const n = notification(r, { id: 'n-1', orderId })
    const res = await post(app, n)
    expect(res.statusCode, res.body).toBe(202)
    expect(res.json()).toEqual({ status: 'accepted' })
    expect((await r.db.selectFrom('sqsp_orders').select('sqsp_order_id').execute()).map((o) => o.sqsp_order_id)).toEqual([orderId])
    const log = await r.db.selectFrom('webhook_log').selectAll().executeTakeFirstOrThrow()
    expect(log).toMatchObject({ provider: 'squarespace', external_id: 'n-1', status: 'processed', signature_valid: true })
    expect(log.body).toBe(n.rawBody)
    expect(JSON.stringify(log.headers)).not.toMatch(/signature/i)
    const dup = await post(app, n)
    expect(dup.statusCode).toBe(200)
    expect(dup.json()).toEqual({ status: 'duplicate' })
    expect(await r.db.selectFrom('webhook_log').select('id').execute()).toHaveLength(1)
    await app.close()
  })

  it('distinct notifications for one order are all processed (the dedupe key is the notification id)', async () => {
    const r = rig()
    const app = await appWith()
    const { orderId } = r.store.createOrder({ email: 'w@example.com', name: 'W', lineItems: [line] })
    expect((await post(app, notification(r, { id: 'n-1', orderId }))).statusCode).toBe(202)
    r.advance(60_000)
    r.store.refund(orderId, { amountCents: 100 })
    const upd = await post(app, notification(r, { id: 'n-2', topic: 'order.update', orderId, update: 'REFUNDED' }))
    expect(upd.statusCode).toBe(202)
    const o = await r.db.selectFrom('sqsp_orders').select(['payment_state', 'refunded_total_cents']).executeTakeFirstOrThrow()
    expect(o).toEqual({ payment_state: 'REFUNDED', refunded_total_cents: 100 })
    expect(await r.db.selectFrom('webhook_log').select('id').execute()).toHaveLength(2)
    await app.close()
  })

  it('rejects a bad signature without storing or logging anything, and reads the raw bytes', async () => {
    const r = rig()
    const app = await appWith()
    const { orderId } = r.store.createOrder({ email: 'w@example.com', name: 'W', lineItems: [line] })
    const bad = await post(app, notification(r, { id: 'n-bad', orderId, secret: SUB_SECRET }))
    expect(bad.statusCode).toBe(401)
    expect((bad.json() as { code: string }).code).toBe('WEBHOOK_SIGNATURE_INVALID')
    const none = await app.app.inject({ method: 'POST', url: '/hooks/squarespace', headers: { 'content-type': 'application/json' }, payload: '{}' })
    expect(none.statusCode).toBe(401)
    expect(await r.db.selectFrom('sqsp_orders').select('id').execute()).toHaveLength(0)
    expect(await r.db.selectFrom('webhook_log').select('id').execute()).toHaveLength(0)
    // a body re-serialised with different whitespace no longer matches its signature
    const n = notification(r, { id: 'n-ws', orderId })
    const spaced = JSON.stringify(JSON.parse(n.rawBody), null, 2)
    expect((await post(app, { rawBody: spaced, headers: n.headers })).statusCode).toBe(401)
    await app.close()
  })

  it('acknowledges stale and unsupported-topic notifications and rejects a malformed body', async () => {
    const r = rig()
    const app = await appWith()
    const stale = await post(app, notification(r, { id: 'n-old', createdOn: new Date(r.clock.now().getTime() - 8 * 24 * H) }))
    expect(stale.statusCode).toBe(200)
    expect(stale.json()).toEqual({ status: 'stale' })
    const ignored = await post(app, notification(r, { id: 'n-ext', topic: 'extension.uninstall' }))
    expect(ignored.statusCode).toBe(200)
    expect(ignored.json()).toEqual({ status: 'ignored' })
    const bad = await app.app.inject({ method: 'POST', url: '/hooks/squarespace', headers: { 'content-type': 'application/json' }, payload: 'not json' })
    expect(bad.statusCode).toBe(400)
    await app.close()
  })

  it('verifies with a stored (encrypted) subscription secret and records the delivery', async () => {
    const r = rig()
    await r.db
      .insertInto('sqsp_webhook_subscriptions')
      .values({
        id: r.newId(),
        location_id: r.locationId,
        sqsp_subscription_id: 'sub-9',
        topic: 'order.create',
        endpoint_url: 'https://oasis.example/hooks/squarespace',
        secret_enc: createSecretBox([SECRETS_KEY]).encrypt(SUB_SECRET),
      })
      .execute()
    const app = await appWith()
    const { orderId } = r.store.createOrder({ email: 'w@example.com', name: 'W', lineItems: [line] })
    const res = await post(app, notification(r, { id: 'n-sub', orderId, secret: SUB_SECRET, sub: 'sub-9' }))
    expect(res.statusCode, res.body).toBe(202)
    const sub = await r.db.selectFrom('sqsp_webhook_subscriptions').select('last_delivery_at').executeTakeFirstOrThrow()
    expect(sub.last_delivery_at?.toISOString()).toBe(r.clock.now().toISOString())
    // the stored secret does not verify a notification that names another subscription
    const other = await post(app, notification(r, { id: 'n-x', orderId, secret: SUB_SECRET, sub: 'sub-other' }))
    expect(other.statusCode).toBe(401)
    await app.close()
  })

  it('queues sqsp.webhook.process when there is a queue, and gives the notification back when queueing fails', async () => {
    const r = rig()
    const enqueued: { name: string; data: unknown }[] = []
    let fail = true
    const jobs = {
      start: async () => undefined,
      stop: async () => undefined,
      health: async () => ({ ok: true, detail: '' }),
      enqueue: async (name: string, data?: object) => {
        if (fail) throw new Error('queue down')
        enqueued.push({ name, data })
        return 'job-1'
      },
    }
    const app = await appWith({ deps: { jobs } })
    const { orderId } = r.store.createOrder({ email: 'w@example.com', name: 'W', lineItems: [line] })
    const n = notification(r, { id: 'n-q', orderId })
    const down = await post(app, n)
    expect(down.statusCode).toBe(503)
    expect(await r.db.selectFrom('webhook_log').select('id').execute()).toHaveLength(0)
    fail = false
    const up = await post(app, n)
    expect(up.statusCode).toBe(202)
    expect(enqueued).toEqual([{ name: 'sqsp.webhook.process', data: { orderId, notificationId: 'n-q', locationId: r.locationId } }])
    // the job is what stores the order: nothing yet
    expect(await r.db.selectFrom('sqsp_orders').select('id').execute()).toHaveLength(0)
    const { sqspWebhookJob } = await import('../../src/modules/payments-sync/jobs/index.js')
    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined, child: () => logger } as never
    await sqspWebhookJob.handler({ db: r.db, clock: r.clock, logger }, { orderId, notificationId: 'n-q', locationId: r.locationId }, { id: 'job-1' })
    expect(await r.db.selectFrom('sqsp_orders').select('id').execute()).toHaveLength(1)
    expect((await r.db.selectFrom('webhook_log').select('status').executeTakeFirstOrThrow()).status).toBe('processed')
    await app.close()
  })
})
