import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { FixedClock } from '../../src/platform/clock.js'
import { SmsWebhookError } from '../../src/integrations/sms/errors.js'
import { smsGateConfig } from '../../src/integrations/smsgate/config.js'
import { SmsGateProvider } from '../../src/integrations/smsgate/provider.js'
import { SimServer } from '../../src/integrations/smsgate/sim-server.js'
import {
  defaultDispatcherConfig,
  DeviceHealthMonitor,
  Dispatcher,
  InMemoryDeviceRepository,
  InMemoryOutboxRepository,
  InMemoryProcessedEvents,
  SmsEventIngestor,
} from '../../src/modules/messaging/dispatch/index.js'
import { InboundService, InMemoryCustomerDirectory, InMemoryInboxRepository, type InboundEffects } from '../../src/modules/messaging/inbound/index.js'
import { InMemoryOptOutRepository } from '../../src/modules/messaging/policy/optouts.js'
import { renderTemplate, TEMPLATES } from '../../src/modules/messaging/templates/index.js'
import { recipient } from './helpers.js'

// Full path with nothing mocked but the radio: dispatcher -> SmsGateProvider -> HTTP simulator -> signed webhooks over
// HTTP -> webhook handler (verify, dedupe, ingest) -> outbox, health, inbound router and opt-outs.

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of closers.splice(0)) await c()
})

async function system() {
  const clock = new FixedClock('2026-06-13T12:00:00-04:00')
  const sim = new SimServer({ clock, username: 'u', password: 'p', signingKey: 'e2e-key', autoProgress: 'instant', retryDelaysMs: [5, 5, 5, 5] })
  const deviceUrl = await sim.start()
  closers.push(() => sim.stop())

  const provider = new SmsGateProvider(smsGateConfig({ baseUrl: deviceUrl, username: 'u', password: 'p', webhookSecret: 'e2e-key', timeoutMs: 500, resendDelayMs: 0 }), { clock, sleep: async () => {} })
  const outbox = new InMemoryOutboxRepository()
  const monitor = new DeviceHealthMonitor(new InMemoryDeviceRepository(), clock)
  const dispatcher = new Dispatcher(provider, outbox, monitor, clock, defaultDispatcherConfig({ deviceId: sim.device.deviceId, minIntervalMs: 0 }))

  const optouts = new InMemoryOptOutRepository()
  const directory = new InMemoryCustomerDirectory()
  directory.add('+17865550151', { id: 'c1', firstName: 'Liam' }, [{ id: 'A1', status: 'booked', start: new Date('2026-06-13T15:00:00-04:00') }])
  const effects = { replies: [] as string[], confirmed: [] as string[], alerts: [] as string[], stored: [] as string[] }
  const inboundEffects: InboundEffects = {
    async sendReply(to, template, vars) {
      effects.replies.push(`${template}:${to}`)
      const text = renderTemplate(template, vars).text
      await dispatcher.enqueue({ messageId: `reply-${effects.replies.length}`, klass: TEMPLATES[template as keyof typeof TEMPLATES].klass, text, recipient: recipient(1, { phone: to, smsOptIn: false, activeOptOut: (await optouts.findActive(to)) !== null }) })
    },
    async confirmAppointment(id) {
      effects.confirmed.push(id)
    },
    async storeMessage(m) {
      effects.stored.push(m.body)
    },
    async staffAlert(a) {
      effects.alerts.push(a.kind)
    },
  }
  const inbound = new InboundService(new InMemoryInboxRepository(), optouts, directory, inboundEffects, clock, { timeZone: 'America/New_York' })
  const ingestor = new SmsEventIngestor(new InMemoryProcessedEvents(), dispatcher, clock, async (e) => {
    await inbound.handleReceived(e)
  })

  // Our webhook endpoint: verify, then ingest. 401 on a bad signature, 200 otherwise.
  const hook: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', async () => {
      try {
        const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]))
        const parsed = provider.parseWebhook(headers, Buffer.concat(chunks).toString('utf8'))
        await ingestor.ingest(parsed.event, parsed.extras)
        res.writeHead(200).end()
      } catch (err) {
        res.writeHead(err instanceof SmsWebhookError ? 401 : 500).end()
      }
    })
  })
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r))
  closers.push(() => new Promise<void>((r) => { hook.closeAllConnections(); hook.close(() => r()) }))
  const hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hooks/smsgate/tablet-1`
  // The real device insists on https; the simulator is told to accept the loopback http URL, so register directly.
  for (const event of ['sms:received', 'sms:sent', 'sms:delivered', 'sms:failed', 'sms:cancelled', 'system:ping', 'app:started']) {
    await fetch(`${deviceUrl}/webhooks`, { method: 'POST', headers: { authorization: `Basic ${Buffer.from('u:p').toString('base64')}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: `oasis-${event.replace(':', '-')}`, url: hookUrl, event }) })
  }
  const control = (path: string, body: unknown = {}) => fetch(`${deviceUrl}/__sim/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { clock, sim, provider, outbox, monitor, dispatcher, optouts, effects, control, deviceUrl }
}

describe('end to end against the HTTP simulator', () => {
  it('a ready-for-pickup text goes out, is confirmed sent and delivered by signed webhooks, and the device is marked online', async () => {
    const s = await system()
    const text = renderTemplate('ready').text
    expect((await s.dispatcher.enqueue({ messageId: 'm1', klass: 'ready', text, recipient: recipient(151, { phone: '+17865550151' }) })).status).toBe('queued')
    const report = await s.dispatcher.tick()
    expect(report.sent).toEqual(['m1'])
    await s.sim.settled()
    const item = await s.outbox.get('m1')
    expect(item).toMatchObject({ state: 'delivered', body: 'Your vehicle is ready for pickup! Reply STOP to opt out.' })
    expect(s.sim.device.message('m1')?.text).toBe('Your vehicle is ready for pickup! Reply STOP to opt out.')
    expect((await s.dispatcher.status()).device).toBe('online')
  })

  it('STOP over the air opts the number out and the next text is suppressed without touching the device', async () => {
    const s = await system()
    await s.control('inbound', { from: '(786) 555-0151', message: 'Stop.' })
    await s.sim.settled()
    expect(await s.optouts.findActive('+17865550151')).toMatchObject({ keyword: 'STOP' })
    expect(s.effects.replies).toEqual(['opt_out_confirm:+17865550151'])

    // the confirmation reply itself is allowed through to an opted-out number; everything else is not
    await s.dispatcher.tick()
    await s.sim.settled()
    expect(s.sim.device.listMessages().map((m) => m.text)).toEqual(["You're unsubscribed from Oasis Auto Spa texts and won't get any more. Reply START to subscribe again."])
    const later = await s.dispatcher.enqueue({ messageId: 'm2', klass: 'ready', text: 'Ready', recipient: recipient(151, { phone: '+17865550151', activeOptOut: true }) })
    expect(later).toEqual({ status: 'suppressed', reason: 'opted_out' })
  })

  it('C over the air confirms the next unconfirmed booking and replies with its time', async () => {
    const s = await system()
    await s.control('inbound', { from: '+17865550151', message: 'c' })
    await s.sim.settled()
    expect(s.effects.confirmed).toEqual(['A1'])
    await s.dispatcher.tick()
    await s.sim.settled()
    expect(s.sim.device.listMessages().map((m) => m.text)).toEqual(['Thanks! Your appointment is confirmed for 3:00 PM. See you then.'])
  })

  it('a stranger is quarantined and nothing is sent', async () => {
    const s = await system()
    await s.control('inbound', { from: '+13055559999', message: 'Hey is this the car wash?' })
    await s.sim.settled()
    expect(s.effects.stored).toEqual([])
    expect(s.effects.alerts).toEqual([])
    expect(s.sim.device.listMessages()).toHaveLength(0)
  })

  it('duplicate and out-of-order webhooks leave the outbox correct', async () => {
    const s = await system()
    await s.dispatcher.enqueue({ messageId: 'm1', klass: 'ready', text: 'Ready', recipient: recipient(151, { phone: '+17865550151' }) })
    await s.control('hold')
    await s.control('duplicate', { count: 2 })
    await s.dispatcher.tick()
    expect(await s.outbox.get('m1')).toMatchObject({ state: 'accepted' })
    await s.control('flush') // delivered arrives before sent, each twice
    await s.sim.settled()
    const item = await s.outbox.get('m1')
    expect(item).toMatchObject({ state: 'delivered' })
    expect(item?.sentAt).not.toBeNull()
    expect(item?.deliveredAt).not.toBeNull()
  })

  it('a duplicated inbound webhook is processed once', async () => {
    const s = await system()
    await s.control('duplicate', { count: 1 })
    await s.control('inbound', { from: '+17865550151', message: 'Running late' })
    await s.sim.settled()
    expect(s.effects.stored).toEqual(['Running late'])
    expect(s.effects.alerts).toEqual(['inbound_message'])
  })

  it('a tablet outage: sends fail and back off, the queue holds, and everything flushes after recovery', async () => {
    const s = await system()
    await s.control('outage', { mode: 'down' })
    for (let i = 0; i < 4; i++) await s.dispatcher.enqueue({ messageId: `q${i}`, klass: 'ready', text: 'Ready', recipient: recipient(200 + i) })
    for (let i = 0; i < 3; i++) {
      await s.dispatcher.tick()
      s.clock.advance(5 * 60_000)
    }
    expect((await s.dispatcher.status()).device).toBe('offline')
    expect(s.sim.device.listMessages()).toHaveLength(0)

    await s.control('outage', { mode: 'off' })
    await s.provider.health().then((h) => s.monitor.record(s.sim.device.deviceId, { kind: 'poll_ok', at: s.clock.now(), healthStatus: h.ok ? 'pass' : 'fail' }))
    const flush = await s.dispatcher.tick()
    expect(flush.sent.length).toBeGreaterThan(0)
    for (let i = 0; i < 5; i++) {
      s.clock.advance(60_000)
      await s.monitor.record(s.sim.device.deviceId, { kind: 'poll_ok', at: s.clock.now() })
      await s.dispatcher.tick()
    }
    await s.sim.settled()
    expect(s.sim.device.listMessages().map((m) => m.id).sort()).toEqual(['q0', 'q1', 'q2', 'q3'])
    expect((await s.outbox.get('q3'))?.state).toBe('delivered')
  })
})
