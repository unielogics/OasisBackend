import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { FixedClock } from '../../../src/platform/clock.js'
import { smsGateConfig } from '../../../src/integrations/smsgate/config.js'
import { SmsGateProvider } from '../../../src/integrations/smsgate/provider.js'
import { signWebhook } from '../../../src/integrations/smsgate/signature.js'
import { SimServer } from '../../../src/integrations/smsgate/sim-server.js'
import { InMemoryProcessedEvents } from '../../../src/modules/messaging/dispatch/memory.js'

const AUTH = `Basic ${Buffer.from('u:p').toString('base64')}`
const NOW = '2026-06-13T12:00:00-04:00'
const HOOK_URL = 'https://oasis-api.example.ts.net/hooks/smsgate/tablet-1'

interface Received {
  headers: Record<string, string | string[] | undefined>
  body: string
}

class Receiver {
  readonly received: Received[] = []
  /** Status per attempt, last one repeats. */
  statuses: number[] = [200]
  private server?: Server
  url = ''

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        this.received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
        const i = Math.min(this.received.length - 1, this.statuses.length - 1)
        res.writeHead(this.statuses[i] ?? 200)
        res.end()
      })
    })
    await new Promise<void>((r) => this.server?.listen(0, '127.0.0.1', r))
    this.url = `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}/hook`
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections()
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()))
  }
}

let servers: SimServer[] = []
let receivers: Receiver[] = []

afterEach(async () => {
  await Promise.all([...servers.map((s) => s.stop()), ...receivers.map((r) => r.stop())])
  servers = []
  receivers = []
})

async function boot(over: ConstructorParameters<typeof SimServer>[0] = {}) {
  const clock = new FixedClock(NOW)
  const server = new SimServer({ clock, username: 'u', password: 'p', signingKey: 'sim-key', autoProgress: 'manual', retryDelaysMs: [5, 5, 5], ...over })
  servers.push(server)
  const url = await server.start()
  const receiver = new Receiver()
  await receiver.start()
  receivers.push(receiver)
  const call = (method: string, path: string, body?: unknown, auth: string | null = AUTH) =>
    fetch(`${url}${path}`, {
      method,
      headers: { ...(auth ? { authorization: auth } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const control = (path: string, body: unknown = {}) => call('POST', `/__sim/${path}`, body, null)
  const register = async (event: string, target = receiver.url) => {
    const res = await call('POST', '/webhooks', { id: `h-${event}`, url: target, event })
    expect(res.status).toBe(201)
  }
  return { clock, server, url, receiver, call, control, register }
}

describe('device API emulation', () => {
  it('requires Basic auth everywhere except /health', async () => {
    const { call } = await boot()
    expect((await call('GET', '/health', undefined, null)).status).toBe(200)
    expect((await call('GET', '/messages/x', undefined, null)).status).toBe(401)
    expect((await call('POST', '/messages', {}, `Basic ${Buffer.from('u:wrong').toString('base64')}`)).status).toBe(401)
    expect((await call('GET', '/messages/x')).status).toBe(404)
  })

  it('serves both the /message and /messages route families, and /webhook as well as /webhooks', async () => {
    const { call } = await boot()
    const body = { id: 'a1', textMessage: { text: 'hi' }, phoneNumbers: ['+17865550151'] }
    expect((await call('POST', '/message', body)).status).toBe(202)
    expect((await call('GET', '/messages/a1')).status).toBe(200)
    expect((await call('GET', '/message/a1')).status).toBe(200)
    expect((await call('GET', '/webhook')).status).toBe(200)
  })

  it('validates a send like the app: one content type, recipients, ttl rules, duplicate ids', async () => {
    const { call } = await boot()
    const ok = { id: 'a1', textMessage: { text: 'hi' }, phoneNumbers: ['+17865550151'] }
    const accepted = await call('POST', '/messages', ok)
    expect(accepted.status).toBe(202)
    expect(accepted.headers.get('location')).toBe('/messages/a1')
    expect(await accepted.json()).toMatchObject({ id: 'a1', state: 'Pending', recipients: [{ phoneNumber: '+17865550151', state: 'Pending' }] })
    expect((await call('POST', '/messages', ok)).status).toBe(409)
    expect((await call('POST', '/messages', { ...ok, id: 'b', message: 'also' })).status).toBe(400)
    expect((await call('POST', '/messages', { id: 'c', phoneNumbers: ['+1'] })).status).toBe(400)
    expect((await call('POST', '/messages', { ...ok, id: 'd', phoneNumbers: [] })).status).toBe(400)
    expect((await call('POST', '/messages', { ...ok, id: 'e', ttl: 60, validUntil: '2030-01-01T00:00:00Z' })).status).toBe(400)
    expect((await call('POST', '/messages', { ...ok, id: 'f', ttl: 1 })).status).toBe(400)
    expect((await call('POST', '/messages', { ...ok, id: 'g', textMessage: { text: '' } })).status).toBe(400)
    expect((await call('POST', '/messages', { ...ok, id: 'h', simNumber: 0 })).status).toBe(400)
    expect((await call('POST', '/messages', { ...ok, id: 'i', phoneNumbers: ['+1', '+1'] })).status).toBe(400)
  })

  it('generates an id when none is given, and lists messages with a total count', async () => {
    const { call } = await boot()
    const res = await call('POST', '/messages', { textMessage: { text: 'hi' }, phoneNumbers: ['+17865550151'] })
    const doc = (await res.json()) as { id: string }
    expect(doc.id).toHaveLength(21)
    const list = await call('GET', '/messages')
    expect(list.headers.get('x-total-count')).toBe('1')
  })

  it('walks the lifecycle through the control endpoints and cancels only pending messages', async () => {
    const { call, control } = await boot()
    for (const id of ['a', 'b']) await call('POST', '/messages', { id, textMessage: { text: 'hi' }, phoneNumbers: ['+17865550151'] })
    await control('processed/a')
    await control('sent/a')
    expect(((await (await call('GET', '/messages/a')).json()) as { state: string }).state).toBe('Sent')
    await control('delivered/a')
    expect(((await (await call('GET', '/messages/a')).json()) as { state: string }).state).toBe('Delivered')
    expect((await call('DELETE', '/messages/a')).status).toBe(400)
    expect((await call('DELETE', '/messages/b')).status).toBe(200)
    expect(((await (await call('GET', '/messages/b')).json()) as { state: string }).state).toBe('Cancelled')
    expect((await call('DELETE', '/messages/zzz')).status).toBe(404)
    await control('failed/b', { reason: 'x' }) // already cancelled: no change
    expect(((await (await call('GET', '/messages/b')).json()) as { state: string }).state).toBe('Cancelled')
  })

  it('auto-progresses to Delivered in instant mode', async () => {
    const { call } = await boot({ autoProgress: 'instant' })
    await call('POST', '/messages', { id: 'a', textMessage: { text: 'hi' }, phoneNumbers: ['+17865550151'] })
    expect(((await (await call('GET', '/messages/a')).json()) as { state: string }).state).toBe('Delivered')
  })

  it('health reports the fail status as HTTP 500 and a low battery', async () => {
    const { call, control } = await boot()
    await control('health', { status: 'fail', battery: 5 })
    const res = await call('GET', '/health', undefined, null)
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ status: 'fail', checks: { 'battery:level': { observedValue: 5 } } })
  })

  it('validates webhook registration: https or loopback only when strict, supported events, same id replaces', async () => {
    const { call } = await boot({ strictWebhookUrls: true })
    expect((await call('POST', '/webhooks', { id: 'x', url: 'http://lan.example/h', event: 'sms:received' })).status).toBe(400)
    expect((await call('POST', '/webhooks', { id: 'x', url: HOOK_URL, event: 'sms:exploded' })).status).toBe(400)
    expect((await call('POST', '/webhooks', { id: 'x', url: 'http://127.0.0.1:9/h', event: 'sms:received' })).status).toBe(201)
    expect((await call('POST', '/webhooks', { id: 'x', url: HOOK_URL, event: 'sms:received' })).status).toBe(201)
    const list = (await (await call('GET', '/webhooks')).json()) as Array<{ id: string; url: string }>
    expect(list).toHaveLength(1)
    expect(list[0]?.url).toBe(HOOK_URL)
    expect((await call('DELETE', '/webhooks/x')).status).toBe(204)
    expect(((await (await call('GET', '/webhooks')).json()) as unknown[]).length).toBe(0)
  })

  it('PATCH /settings can rotate the signing key', async () => {
    const { call, control, register, receiver, server } = await boot()
    await register('system:ping')
    await call('PATCH', '/settings', { webhooks: { signing_key: 'rotated' } })
    await control('ping')
    await server.settled()
    const r = receiver.received[0]
    expect(r).toBeDefined()
    expect(r?.headers['x-signature']).toBe(signWebhook('rotated', r?.body ?? '', String(r?.headers['x-timestamp'])))
  })
})

describe('webhook delivery', () => {
  it('posts signed envelopes exactly as the device does and our provider verifies them', async () => {
    const { server, control, register, receiver, call, clock } = await boot()
    for (const e of ['sms:received', 'sms:sent', 'sms:delivered', 'system:ping', 'app:started']) await register(e)
    await call('POST', '/messages', { id: 'm1', textMessage: { text: 'hi' }, phoneNumbers: ['+17865550151'] })
    await control('sent/m1')
    await control('delivered/m1')
    await control('inbound', { from: '(786) 555-0151', message: 'C' })
    await control('ping')
    await control('app-started')
    await server.settled()
    expect(receiver.received).toHaveLength(5)

    const provider = new SmsGateProvider(smsGateConfig({ baseUrl: server.url, username: 'u', password: 'p', webhookSecret: 'sim-key' }), { clock })
    const events = receiver.received.map((r) => provider.verifyAndParseWebhook(Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])), r.body))
    expect(events.map((e) => e.kind).sort()).toEqual(['app_started', 'delivered', 'ping', 'received', 'sent'])
    const rx = events.find((e) => e.kind === 'received')
    expect(rx).toMatchObject({ from: '+17865550151', body: 'C' })
    expect(receiver.received[0]?.headers['content-type']).toBe('application/json')
    // envelope ids are unique per delivery
    expect(new Set(events.map((e) => e.eventId)).size).toBe(5)
  })

  it('retries a delivery the receiver rejected with the same envelope id and body, re-signed each time', async () => {
    const { server, control, register, receiver, clock } = await boot()
    receiver.statuses = [500, 502, 200]
    await register('sms:received')
    await control('inbound', { from: '+17865550151', message: 'hello' })
    clock.advance(1000)
    await server.settled()
    expect(receiver.received).toHaveLength(3)
    const ids = receiver.received.map((r) => (JSON.parse(r.body) as { id: string }).id)
    expect(new Set(ids).size).toBe(1)
    expect(new Set(receiver.received.map((r) => r.body)).size).toBe(1)
    expect(server.deliveries[0]).toMatchObject({ state: 'delivered' })
    expect(server.deliveries[0]?.attempts.map((a) => a.status)).toEqual([500, 502, 200])

    // every attempt verifies, and the receiving side dedupes on the envelope id
    const provider = new SmsGateProvider(smsGateConfig({ baseUrl: server.url, username: 'u', password: 'p', webhookSecret: 'sim-key' }), { clock })
    const seen = new InMemoryProcessedEvents()
    let processed = 0
    for (const r of receiver.received) {
      const e = provider.verifyAndParseWebhook(Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])), r.body)
      if (await seen.markIfNew(e.eventId)) processed += 1
    }
    expect(processed).toBe(1)
  })

  it('gives up after the retry budget', async () => {
    const { server, control, register, receiver } = await boot({ retryDelaysMs: [2, 2] })
    receiver.statuses = [500]
    await register('system:ping')
    await control('ping')
    await server.settled()
    expect(receiver.received).toHaveLength(3)
    expect(server.deliveries[0]?.state).toBe('failed')
  })

  it('records connection errors for an unreachable receiver and marks the delivery failed when the budget runs out', async () => {
    const { server, control, register, receiver } = await boot({ retryDelaysMs: [30, 30, 30] })
    await register('system:ping', 'http://127.0.0.1:1/hook')
    await control('ping')
    await new Promise((r) => setTimeout(r, 20))
    expect(server.deliveries[0]?.attempts[0]?.error).toBeDefined()
    await server.settled()
    expect(server.deliveries[0]?.state).toBe('failed')
    expect(receiver.received).toHaveLength(0)
  })

  it('duplicate injection delivers the same envelope twice', async () => {
    const { server, control, register, receiver } = await boot()
    await register('sms:received')
    await control('duplicate', { count: 1 })
    await control('inbound', { from: '+17865550151', message: 'once' })
    await control('inbound', { from: '+17865550151', message: 'twice? no' })
    await server.settled()
    expect(receiver.received).toHaveLength(3)
    const ids = receiver.received.map((r) => (JSON.parse(r.body) as { id: string }).id)
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[0])
  })

  it('out-of-order injection holds deliveries and releases them newest first', async () => {
    const { server, control, register, receiver, call } = await boot()
    await register('sms:sent')
    await register('sms:delivered')
    await call('POST', '/messages', { id: 'm1', textMessage: { text: 'hi' }, phoneNumbers: ['+17865550151'] })
    await control('hold')
    await control('sent/m1')
    await control('delivered/m1')
    await server.settled()
    expect(receiver.received).toHaveLength(0)
    const flushed = await (await control('flush')).json()
    expect(flushed).toMatchObject({ released: 2 })
    await server.settled()
    expect(receiver.received.map((r) => (JSON.parse(r.body) as { event: string }).event)).toEqual(['sms:delivered', 'sms:sent'])
  })

  it('does not emit webhooks for events nobody registered', async () => {
    const { server, control, receiver } = await boot()
    await control('inbound', { from: '+17865550151', message: 'unheard' })
    await server.settled()
    expect(receiver.received).toHaveLength(0)
  })
})

describe('outage injection', () => {
  const body = { id: 'o1', textMessage: { text: 'hi' }, phoneNumbers: ['+17865550151'] }

  it('error5xx answers 503 until cleared, once if asked', async () => {
    const { call, control } = await boot()
    await control('outage', { mode: 'error5xx', once: true })
    expect((await call('POST', '/messages', body)).status).toBe(503)
    expect((await call('POST', '/messages', body)).status).toBe(202)
    await control('outage', { mode: 'error5xx' })
    expect((await call('GET', '/messages/o1')).status).toBe(503)
    expect((await call('GET', '/messages/o1')).status).toBe(503)
    await control('outage', { mode: 'off' })
    expect((await call('GET', '/messages/o1')).status).toBe(200)
  })

  it('down drops the connection', async () => {
    const { call, control } = await boot()
    await control('outage', { mode: 'down' })
    await expect(call('GET', '/health')).rejects.toThrow()
  })

  it('hang_after_accept keeps the message but never answers: the adapter checks before re-sending', async () => {
    const { server, url, control } = await boot()
    await control('outage', { mode: 'hang_after_accept', once: true })
    const provider = new SmsGateProvider(smsGateConfig({ baseUrl: url, username: 'u', password: 'p', webhookSecret: 'k', timeoutMs: 250, resendDelayMs: 0 }), { sleep: async () => {} })
    const res = await provider.send({ id: 'h1', to: '+17865550151', body: 'maybe' })
    expect(res).toMatchObject({ providerMessageId: 'h1', state: 'Pending' })
    expect(server.device.listMessages()).toHaveLength(1)
  })

  it('hang never answers anything', async () => {
    const { control, url } = await boot()
    await control('outage', { mode: 'hang' })
    const provider = new SmsGateProvider(smsGateConfig({ baseUrl: url, username: 'u', password: 'p', webhookSecret: 'k', timeoutMs: 150, resendDelayMs: 0 }), { sleep: async () => {} })
    expect(await provider.health()).toMatchObject({ ok: false, details: { reachable: false } })
    await expect(provider.status('x')).rejects.toMatchObject({ kind: 'transient' })
  })

  it('rejects unknown control modes and endpoints', async () => {
    const { control } = await boot()
    expect((await control('outage', { mode: 'sideways' })).status).toBe(400)
    expect((await control('nonsense')).status).toBe(404)
    expect((await control('inbound', {})).status).toBe(400)
  })

  it('reports state and delivery log for debugging', async () => {
    const { call, url } = await boot()
    await call('POST', '/messages', body)
    const state = (await (await fetch(`${url}/__sim/state`)).json()) as { messages: unknown[]; outage: string }
    expect(state).toMatchObject({ outage: 'off', messages: [{ id: 'o1', state: 'Pending' }] })
    expect((await fetch(`${url}/__sim/deliveries`)).status).toBe(200)
  })
})
