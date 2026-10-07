// The two listeners and the real HTTP simulator: the hook is served only on the tailnet-facing listener, the public app
// answers 404, and a full loop runs over real HTTP in both directions (SmsGateProvider -> SimServer -> signed webhooks).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { apiModules } from '../../src/http/modules.js'
import { SIM_DEVICE_KEY, SIM_WEBHOOK_SECRET } from '../../db/seeds/messaging.js'
import { messagingRuntimeFor } from '../../src/composition.js'
import { SimServer } from '../../src/integrations/smsgate/sim-server.js'
import { buildHooksApp, type HooksApp } from '../../src/modules/messaging/http/hooks-app.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { useWorld } from './world.js'

const w = useWorld()

async function until<T>(fn: () => Promise<T | undefined | false>, ms = 8000): Promise<T> {
  const t0 = performance.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (performance.now() - t0 > ms) throw new Error('timed out waiting for the condition')
    await new Promise((r) => setTimeout(r, 40))
  }
}

// A listener per test, built on that test's runtime (the world makes a fresh runtime before every test).
const listeners: HooksApp[] = []
async function listener(): Promise<{ hooks: HooksApp; base: string }> {
  const hooks = await buildHooksApp(w.rt, { host: '127.0.0.1', port: 0 })
  listeners.push(hooks)
  return { hooks, base: await hooks.listen() }
}
afterEach(async () => {
  await Promise.all(listeners.splice(0).map((h) => h.close()))
})

describe('hooks listener', () => {

  it('accepts a signed delivery with 2xx and applies it after answering', async () => {
    const { base } = await listener()
    await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    const ev = w.signed('sms:received', { messageId: 'http-1', sender: w.customer('Maria Delgado').phone, recipient: '+15555550100', simNumber: 1, message: 'Hi from HTTP', receivedAt: w.clock.now().toISOString() })
    const res = await fetch(`${base}/hooks/smsgate/${SIM_DEVICE_KEY}`, { method: 'POST', headers: ev.headers, body: ev.body })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, status: 'accepted' })
    await until(async () => (await w.messagesOf('Maria Delgado')).length > 0)
    expect((await w.messagesOf('Maria Delgado'))[0]).toMatchObject({ direction: 'in', body: 'Hi from HTTP' })
  })

  it('answers 401 for a bad signature and 404 for an unknown device key or path', async () => {
    const { base } = await listener()
    const bad = w.signed('system:ping', { status: 'pass' }, { secret: 'wrong-key-wrong-key' })
    expect((await fetch(`${base}/hooks/smsgate/${SIM_DEVICE_KEY}`, { method: 'POST', headers: bad.headers, body: bad.body })).status).toBe(401)
    const good = w.signed('system:ping', { status: 'pass' })
    expect((await fetch(`${base}/hooks/smsgate/not-a-device`, { method: 'POST', headers: good.headers, body: good.body })).status).toBe(404)
    expect((await fetch(`${base}/api/v1/ops/snapshot`)).status).toBe(404)
    expect((await fetch(`${base}/hooks/squarespace`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(404)
  })

  it('handles a body the device sends as text/plain too, byte for byte (emoji and quotes survive the signature)', async () => {
    const { base } = await listener()
    await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    const ev = w.signed('sms:received', { messageId: 'http-emoji', sender: w.customer('Maria Delgado').phone, recipient: '+15555550100', simNumber: 1, message: 'Thanks \u{1F44D} "great" — see you', receivedAt: w.clock.now().toISOString() })
    const res = await fetch(`${base}/hooks/smsgate/${SIM_DEVICE_KEY}`, { method: 'POST', headers: { ...ev.headers, 'content-type': 'text/plain' }, body: ev.body })
    expect(res.status).toBe(200)
    await until(async () => (await w.messagesOf('Maria Delgado')).find((m) => m.body.includes('great')))
  })
})

describe('the public listener has no SMS Gate hook', () => {
  let app: TestApp
  beforeAll(async () => {
    app = await createTestApp({ testDb: w.t, modules: apiModules, env: { SMS_ALLOWLIST: '+13055550102' } })
  })
  afterAll(async () => {
    await app.close()
  })

  it('answers 404 for /hooks/smsgate/* with a correctly signed delivery', async () => {
    const ev = w.signed('system:ping', { status: 'pass' })
    for (const url of [`/hooks/smsgate/${SIM_DEVICE_KEY}`, '/hooks/smsgate/anything', '/hooks/smsgate', `/api/v1/hooks/smsgate/${SIM_DEVICE_KEY}`]) {
      const res = await app.app.inject({ method: 'POST', url, headers: { ...ev.headers, 'content-type': 'application/json' }, payload: ev.body })
      expect(res.statusCode, url).toBe(404)
    }
    expect(await w.t.db.selectFrom('webhook_log').select('id').execute()).toEqual([])
  })

  it('registers no route for it in the route registry', () => {
    expect(app.app.routeRegistry.filter((r) => r.url.includes('/hooks/smsgate'))).toEqual([])
    expect(app.app.routeRegistry.some((r) => r.access.kind === 'webhook' && r.url.includes('smsgate'))).toBe(false)
  })

  it('shares one messaging runtime with the process (keyed by the Env object)', () => {
    expect(messagingRuntimeFor({ db: w.t.db, clock: w.clock, env: app.env })).toBe(messagingRuntimeFor({ db: w.t.db, clock: w.clock, env: app.env }))
  })
})

describe('over real HTTP with the SMS Gate simulator server', () => {
  let sim: SimServer
  beforeAll(async () => {
    sim = new SimServer({ clock: w.clock, signingKey: 'e2e-signing-key-1', autoProgress: 'instant', retryDelaysMs: [50, 100, 200] })
    await sim.start()
  })
  afterAll(async () => {
    await sim.stop()
  })

  const addDevice = async (url: string, secret: string) => {
    const { base } = await listener()
    w.rt.config.webhookPublicUrl = `${base}/hooks/smsgate`
    await w.t.db.updateTable('sms_devices').set({ enabled: false }).where('device_key', '=', SIM_DEVICE_KEY).execute()
    return (await w.rt.store.create(w.locationId, { label: 'Simulator over HTTP', provider: 'smsgate', baseUrl: url, username: 'sim', password: 'sim', webhookSecret: secret })).device
  }

  it('registers webhooks, sends, receives the receipts and an inbound STOP over HTTP', async () => {
    const device = await addDevice(sim.url, 'e2e-signing-key-1')
    const reg = await w.rt.registerWebhooks(device)
    expect(reg).toMatchObject({ registered: true, url: `${w.rt.config.webhookPublicUrl}/${device.device_key}` })
    expect(sim.device.listWebhooks().map((h) => h.event).sort()).toEqual(['app:started', 'sms:cancelled', 'sms:delivered', 'sms:failed', 'sms:received', 'sms:sent', 'system:ping'])
    await w.rt.pollHealth(device)
    expect((await w.rt.store.get(device.id))!.status).toBe('online')

    const q = await w.tx((tx) => w.rt.queue.enqueue(tx, { customerId: w.customer('Maria Delgado').id, appointmentId: null, templateKey: 'booking_thanks', vars: { first: 'Maria' }, purpose: 'booking' }))
    await w.tick()
    expect(sim.device.message(q.messageId!)).toBeDefined()
    await until(async () => (await w.messagesOf('Maria Delgado')).find((m) => m.id === q.messageId && m.status === 'delivered'))
    expect(await w.t.db.selectFrom('sms_devices').select(['sent_count', 'delivered_count']).where('id', '=', device.id).executeTakeFirstOrThrow()).toEqual({ sent_count: 1, delivered_count: 1 })

    sim.device.injectInbound(w.customer('Maria Delgado').phone, 'STOP')
    await until(async () => (await w.t.db.selectFrom('sms_opt_outs').select('id').execute()).length > 0)
    await until(async () => (await w.messagesOf('Maria Delgado')).find((m) => m.template_key === 'opt_out_confirm'))
    await until(async () => sim.deliveries.every((d) => d.state === 'delivered'))
  })

  it('deliveries signed with the wrong key are refused with 401 on every retry and never applied', async () => {
    const wrong = new SimServer({ clock: w.clock, signingKey: 'not-the-key-we-have', autoProgress: 'instant', retryDelaysMs: [30, 60] })
    await wrong.start()
    try {
      const device = await addDevice(wrong.url, 'the-key-oasis-holds')
      await w.rt.registerWebhooks(device)
      const q = await w.tx((tx) => w.rt.queue.enqueue(tx, { customerId: w.customer('Maria Delgado').id, appointmentId: null, templateKey: 'booking_thanks', vars: { first: 'Maria' }, purpose: 'booking' }))
      await w.rt.pollHealth(device)
      await w.tick()
      await until(async () => wrong.deliveries.length > 0 && wrong.deliveries.every((d) => d.state === 'failed'))
      expect(wrong.deliveries.flatMap((d) => d.attempts.map((a) => a.status))).toContain(401)
      expect(await w.t.db.selectFrom('webhook_log').select('id').execute()).toEqual([])
      expect((await w.messagesOf('Maria Delgado'))[0]).toMatchObject({ id: q.messageId, status: 'sent' }) // accepted by the device, no receipt applied
    } finally {
      await wrong.stop()
    }
  })
})
