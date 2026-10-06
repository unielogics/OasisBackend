import { FixedClock } from '../../../src/platform/clock.js'
import { SimulatorProvider } from '../../../src/integrations/sms/simulator.js'
import { smsGateConfig } from '../../../src/integrations/smsgate/config.js'
import { SmsGateProvider } from '../../../src/integrations/smsgate/provider.js'
import { SimServer } from '../../../src/integrations/smsgate/sim-server.js'
import type { SimDelivery } from '../../../src/integrations/smsgate/sim-device.js'
import type { ContractHarness, WebhookDelivery } from './contract.js'
import { FixtureDeviceServer } from './fixture-server.js'
import { FIXTURE_NOW, FIXTURE_SECRET, webhookFixture } from './fixtures.js'

const WEBHOOK_URL = 'https://oasis-api.example.ts.net/hooks/smsgate/tablet-1'
const SIM_NOW = '2026-06-13T12:00:00-04:00'

const toDelivery = (d: SimDelivery): WebhookDelivery => ({ headers: d.headers, body: d.body })

/** The in-process SimulatorProvider. */
export async function inProcessHarness(): Promise<ContractHarness> {
  const clock = new FixedClock(SIM_NOW)
  const sim = new SimulatorProvider({ clock, autoProgress: 'manual', signingKey: 'sim-key' })
  const take = (event: string): WebhookDelivery => {
    const hit = sim.takeDeliveries().filter((d) => d.event === event)
    const last = hit.at(-1)
    if (!last) throw new Error(`device emitted no ${event}`)
    return toDelivery(last)
  }
  return {
    provider: sim,
    webhookUrl: WEBHOOK_URL,
    secret: 'sim-key',
    ids: { accepted: 'sim-accepted-1', failing: 'sim-failing-1', cancelled: 'sim-cancelled-1', unknown: 'sim-unknown-1', second: 'sim-second-1' },
    async emit(kind, id) {
      sim.takeDeliveries()
      if (kind === 'sent') sim.markSent(id)
      else if (kind === 'delivered') sim.deliver(id)
      else if (kind === 'failed') sim.fail(id, 'Radio off')
      else sim.device.cancelMessage(id)
      return take(`sms:${kind}`)
    },
    async inbound(from, body) {
      sim.takeDeliveries()
      sim.injectInbound(from, body)
      return take('sms:received')
    },
    async ping() {
      sim.takeDeliveries()
      sim.ping()
      return take('system:ping')
    },
    async appStarted() {
      sim.takeDeliveries()
      sim.appStarted()
      return take('app:started')
    },
    deviceMessageCount: () => sim.messageCount(),
    registeredWebhookCount: () => sim.device.listWebhooks().length,
    breakDevice: () => sim.setOutage('error5xx'),
    repairDevice: () => sim.setOutage('off'),
    advanceClock: (ms) => clock.advance(ms),
    supportsLostResponse: true,
    loseNextResponse: () => sim.setOutage('hang_after_accept', { once: true }),
    close: async () => {},
  }
}

/** SmsGateProvider over real HTTP to the simulator server (webhook transport is captured; it has its own tests). */
export async function httpSimHarness(): Promise<ContractHarness> {
  const clock = new FixedClock(SIM_NOW)
  const server = new SimServer({ clock, autoProgress: 'manual', signingKey: 'sim-key', username: 'u', password: 'p' })
  const url = await server.start()
  const captured: SimDelivery[] = []
  server.device.onDelivery((d) => captured.push(d))
  const provider = new SmsGateProvider(smsGateConfig({ baseUrl: url, username: 'u', password: 'p', webhookSecret: 'sim-key', timeoutMs: 500, resendDelayMs: 0 }), { clock, sleep: async () => {} })
  const control = async (path: string, body: unknown = {}): Promise<void> => {
    const res = await fetch(`${url}/__sim/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) throw new Error(`control ${path}: ${res.status}`)
  }
  const take = (event: string): WebhookDelivery => {
    const last = captured.filter((d) => d.event === event).at(-1)
    if (!last) throw new Error(`device emitted no ${event}`)
    return toDelivery(last)
  }
  return {
    provider,
    webhookUrl: WEBHOOK_URL,
    secret: 'sim-key',
    ids: { accepted: 'http-accepted-1', failing: 'http-failing-1', cancelled: 'http-cancelled-1', unknown: 'http-unknown-1', second: 'http-second-1' },
    async emit(kind, id) {
      captured.length = 0
      if (kind === 'cancelled') {
        const res = await fetch(`${url}/messages/${id}`, { method: 'DELETE', headers: { authorization: `Basic ${Buffer.from('u:p').toString('base64')}` } })
        if (!res.ok) throw new Error(`cancel: ${res.status}`)
      } else {
        await control(`${kind}/${id}`, kind === 'failed' ? { reason: 'Radio off' } : {})
      }
      return take(`sms:${kind}`)
    },
    async inbound(from, body) {
      captured.length = 0
      await control('inbound', { from, message: body })
      return take('sms:received')
    },
    async ping() {
      captured.length = 0
      await control('ping')
      return take('system:ping')
    },
    async appStarted() {
      captured.length = 0
      await control('app-started')
      return take('app:started')
    },
    deviceMessageCount: () => server.device.listMessages().length,
    registeredWebhookCount: () => server.device.listWebhooks().length,
    breakDevice: () => {
      server.outage = 'error5xx'
    },
    repairDevice: () => {
      server.outage = 'off'
    },
    advanceClock: (ms) => clock.advance(ms),
    supportsLostResponse: true,
    loseNextResponse: () => {
      server.outage = 'hang_after_accept'
    },
    close: () => server.stop(),
  }
}

/** SmsGateProvider replaying the recorded exchanges and pre-signed webhooks from test/fixtures/smsgate. */
export async function fixtureHarness(): Promise<ContractHarness> {
  const clock = new FixedClock(FIXTURE_NOW)
  const device = new FixtureDeviceServer()
  const url = await device.start()
  const provider = new SmsGateProvider(smsGateConfig({ baseUrl: url, username: 'u', password: 'p', webhookSecret: FIXTURE_SECRET, timeoutMs: 500, resendDelayMs: 0 }), { clock, sleep: async () => {} })
  const fx = (name: string): WebhookDelivery => {
    const f = webhookFixture(name)
    return { headers: f.headers, body: f.body }
  }
  const byKind = { sent: 'sms-sent', delivered: 'sms-delivered', failed: 'sms-failed', cancelled: 'sms-cancelled' } as const
  return {
    provider,
    webhookUrl: WEBHOOK_URL,
    secret: FIXTURE_SECRET,
    // The recorded webhooks concern these ids.
    ids: { accepted: 'fx-msg-0001', failing: 'fx-msg-0002', cancelled: 'fx-msg-0003', unknown: 'fx-unknown-0000', second: 'fx-msg-0009' },
    async emit(kind, id) {
      const d = fx(byKind[kind])
      if (!d.body.includes(`"messageId":"${id}"`)) throw new Error(`fixture ${byKind[kind]} is not about ${id}`)
      return d
    },
    inbound: async () => fx('sms-received-confirm'),
    ping: async () => fx('system-ping-pass'),
    appStarted: async () => fx('app-started'),
    deviceMessageCount: () => device.accepted.size,
    registeredWebhookCount: () => device.webhooks.size,
    breakDevice: () => {
      device.failing = 503
    },
    repairDevice: () => {
      device.failing = null
    },
    advanceClock: (ms) => clock.advance(ms),
    supportsLostResponse: false,
    close: () => device.stop(),
  }
}
