import { describe, expect, it } from 'vitest'
import { FixedClock } from '../../../src/platform/clock.js'
import { SmsProviderError } from '../../../src/integrations/sms/errors.js'
import { smsGateConfig, smsGateConfigFromEnv, DEFAULT_PRIORITY_MAP } from '../../../src/integrations/smsgate/config.js'
import { SmsGateProvider } from '../../../src/integrations/smsgate/provider.js'
import { SMSGATE_WEBHOOK_EVENTS } from '../../../src/integrations/smsgate/types.js'
import { FIXTURE_NOW, FIXTURE_SECRET, httpFixtures, webhookFixture } from './fixtures.js'

interface Call {
  method: string
  path: string
  body: unknown
  headers: Record<string, string>
}
type Step = (call: Call) => Response | Error | Promise<Response | Error>

const json = (status: number, body?: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: body === undefined ? {} : { 'content-type': 'application/json' } })
const timeout = (): Error => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
const netdown = (): Error => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })

const BASE = 'http://100.64.0.7:8080'
const doc = (id: string, state: string, error?: string) => ({ id, deviceId: 'd', state, recipients: [{ phoneNumber: '+17865550151', state, ...(error ? { error } : {}) }] })

function make(steps: Step[], over: Parameters<typeof smsGateConfig>[0] extends infer T ? Partial<T> : never = {}) {
  const calls: Call[] = []
  let i = 0
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input)
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname + url.search,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
    }
    calls.push(call)
    const step = steps[i++]
    if (!step) throw new Error(`unexpected call #${i}: ${call.method} ${call.path}`)
    const out = await step(call)
    if (out instanceof Error) throw out
    return out
  }
  const provider = new SmsGateProvider(smsGateConfig({ baseUrl: BASE, username: 'u', password: 'p', webhookSecret: FIXTURE_SECRET, resendDelayMs: 0, ...over }), {
    fetch: fetchImpl,
    clock: new FixedClock(FIXTURE_NOW),
    sleep: async () => {},
  })
  return { provider, calls, remaining: () => steps.length - i }
}

const req = { id: 'msg-1', to: '+17865550151', body: 'Your vehicle is ready for pickup!' }

describe('send: request shape', () => {
  it('posts our id, the text, one recipient, a delivery report, ttl and the mapped priority with Basic auth', async () => {
    const { provider, calls } = make([() => json(202, doc('msg-1', 'Pending'))])
    const res = await provider.send({ ...req, simSlot: 2, ttlSec: 600, priority: 0 })
    expect(res).toEqual({ providerMessageId: 'msg-1', state: 'Pending' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/messages',
      body: { id: 'msg-1', textMessage: { text: req.body }, phoneNumbers: ['+17865550151'], withDeliveryReport: true, simNumber: 2, ttl: 600, priority: DEFAULT_PRIORITY_MAP[0] },
    })
    expect(calls[0]?.headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`)
    expect(calls[0]?.headers['content-type']).toBe('application/json')
  })

  it('omits optional fields it was not given, rounds ttl up and never goes below the device minimum of 5 s', async () => {
    const a = make([() => json(202, doc('msg-1', 'Pending'))])
    await a.provider.send(req)
    expect(a.calls[0]?.body).toEqual({ id: 'msg-1', textMessage: { text: req.body }, phoneNumbers: ['+17865550151'], withDeliveryReport: true })
    const b = make([() => json(202, doc('msg-1', 'Pending'))])
    await b.provider.send({ ...req, ttlSec: 2.2 })
    expect((b.calls[0]?.body as { ttl: number }).ttl).toBe(5)
    const c = make([() => json(202, doc('msg-1', 'Pending'))])
    await c.provider.send({ ...req, ttlSec: 61.2 })
    expect((c.calls[0]?.body as { ttl: number }).ttl).toBe(62)
  })

  it('maps lanes to device priorities, never reaching the bypass threshold of 100', async () => {
    for (const lane of [0, 1, 2, 3] as const) {
      const { provider, calls } = make([() => json(202, doc('msg-1', 'Pending'))])
      await provider.send({ ...req, priority: lane })
      const p = (calls[0]?.body as { priority: number }).priority
      expect(p).toBe(DEFAULT_PRIORITY_MAP[lane])
      expect(p).toBeLessThan(100)
    }
  })

  it('can send the deprecated message field and use another path and default SIM', async () => {
    const { provider, calls } = make([() => json(202, doc('msg-1', 'Pending'))], { legacyMessageField: true, messagesPath: '/message', defaultSimNumber: 3 })
    await provider.send(req)
    expect(calls[0]?.path).toBe('/message')
    expect(calls[0]?.body).toMatchObject({ message: req.body, simNumber: 3 })
    expect(calls[0]?.body).not.toHaveProperty('textMessage')
  })

  it('refuses locally what the device would refuse', async () => {
    const { provider, calls } = make([])
    for (const bad of [{ ...req, to: '7865550151' }, { ...req, body: '' }, { ...req, id: '' }, { ...req, id: 'x'.repeat(37) }]) {
      await expect(provider.send(bad)).rejects.toMatchObject({ kind: 'rejected', retryable: false })
    }
    expect(calls).toHaveLength(0)
  })

  it('treats a 2xx without a state document as queued', async () => {
    const { provider } = make([() => new Response('', { status: 202 })])
    expect(await provider.send(req)).toEqual({ providerMessageId: 'msg-1', state: 'Pending' })
  })
})

describe('send: errors and the ambiguity rule', () => {
  it('a 400 is permanent and is not followed by a status check or a retry', async () => {
    const { provider, calls } = make([() => json(400, { message: 'fields conflict: ttl and validUntil' })])
    await expect(provider.send(req)).rejects.toMatchObject({ kind: 'rejected', status: 400, retryable: false })
    expect(calls).toHaveLength(1)
  })

  it('a 401 is an auth error', async () => {
    const { provider } = make([() => json(401)])
    await expect(provider.send(req)).rejects.toMatchObject({ kind: 'auth', retryable: false })
  })

  it('a 409 means the device already has the id: never post again, report its state', async () => {
    const { provider, calls } = make([() => json(409, { message: 'Message with the same ID already exists' }), () => json(200, doc('msg-1', 'Sent'))])
    expect(await provider.send(req)).toEqual({ providerMessageId: 'msg-1', state: 'Sent' })
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET'])
    expect(calls[1]?.path).toBe('/messages/msg-1')
  })

  it('timeout, then the device has the message: report it and do NOT re-send', async () => {
    const { provider, calls } = make([() => timeout(), () => json(200, doc('msg-1', 'Processed'))])
    expect(await provider.send(req)).toEqual({ providerMessageId: 'msg-1', state: 'Processed' })
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /messages', 'GET /messages/msg-1'])
  })

  it('timeout, then the device has never seen the id (404): re-send once, and it lands', async () => {
    const { provider, calls } = make([() => timeout(), () => json(404), () => json(202, doc('msg-1', 'Pending'))])
    expect(await provider.send(req)).toEqual({ providerMessageId: 'msg-1', state: 'Pending' })
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /messages', 'GET /messages/msg-1', 'POST /messages'])
  })

  it('a 5xx is ambiguous too: it asks first', async () => {
    const { provider, calls } = make([() => json(502, { message: 'bad gateway' }), () => json(200, doc('msg-1', 'Sent'))])
    expect(await provider.send(req)).toMatchObject({ state: 'Sent' })
    expect(calls).toHaveLength(2)
  })

  it('a connection failure is ambiguous as well', async () => {
    const { provider, calls } = make([() => netdown(), () => json(404), () => json(202, doc('msg-1', 'Pending'))])
    await provider.send(req)
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'POST'])
  })

  it('gives up with a retryable error after the re-send budget, never POSTing more than twice', async () => {
    const { provider, calls } = make([() => json(503, { message: 'Queue limits exceeded' }), () => json(404), () => json(503, { message: 'Queue limits exceeded' }), () => json(404)])
    await expect(provider.send(req)).rejects.toMatchObject({ kind: 'transient', retryable: true, status: 503 })
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2)
  })

  it('resend attempts are configurable, zero disables re-sending', async () => {
    const { provider, calls } = make([() => timeout(), () => json(404)], { resendAttempts: 0 })
    await expect(provider.send(req)).rejects.toMatchObject({ retryable: true })
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET'])
  })

  it('when the status check itself fails the outcome is unknown: error out without re-sending', async () => {
    const { provider, calls } = make([() => timeout(), () => netdown()])
    const err = await provider.send(req).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SmsProviderError)
    expect(err).toMatchObject({ kind: 'transient', retryable: true })
    expect(calls.map((c) => c.method)).toEqual(['POST', 'GET'])
  })

  it('a 409 for an id the device cannot then find is a protocol error', async () => {
    const { provider } = make([() => json(409, { message: 'exists' }), () => json(404)])
    await expect(provider.send(req)).rejects.toMatchObject({ kind: 'protocol' })
  })

  it('a body that is cut off mid-response counts as transient', async () => {
    const broken = { status: 202, text: async () => { throw new TypeError('terminated') } } as unknown as Response
    const { provider } = make([() => broken, () => json(200, doc('msg-1', 'Pending'))])
    expect(await provider.send(req)).toMatchObject({ state: 'Pending' })
  })
})

describe('status', () => {
  it.each([
    ['Pending', 'Pending'],
    ['Cancelling', 'Pending'],
    ['Processed', 'Processed'],
    ['Sent', 'Sent'],
    ['Delivered', 'Delivered'],
    ['Failed', 'Failed'],
  ])('maps %s to %s', async (device, mapped) => {
    const { provider } = make([() => json(200, doc('msg-1', device))])
    expect(await provider.status('msg-1')).toMatchObject({ state: mapped })
  })

  it('maps Cancelled to Failed with reason cancelled (the port has no cancelled state)', async () => {
    const { provider } = make([() => json(200, doc('msg-1', 'Cancelled'))])
    expect(await provider.status('msg-1')).toEqual({ state: 'Failed', reason: 'cancelled' })
  })

  it('surfaces the recipient error as the reason', async () => {
    const { provider } = make([() => json(200, doc('msg-1', 'Failed', 'Radio off'))])
    expect(await provider.status('msg-1')).toEqual({ state: 'Failed', reason: 'Radio off' })
  })

  it('returns null for an unknown id (404) and throws for anything else unexpected', async () => {
    expect(await make([() => json(404)]).provider.status('nope')).toBeNull()
    await expect(make([() => json(500, { message: 'boom' })]).provider.status('x')).rejects.toMatchObject({ kind: 'transient' })
    await expect(make([() => json(401)]).provider.status('x')).rejects.toMatchObject({ kind: 'auth' })
    await expect(make([() => json(200, { nope: true })]).provider.status('x')).rejects.toMatchObject({ kind: 'protocol' })
    await expect(make([() => netdown()]).provider.status('x')).rejects.toMatchObject({ kind: 'transient' })
  })

  it('encodes the id in the path', async () => {
    const { provider, calls } = make([() => json(404)])
    await provider.status('a/b c')
    expect(calls[0]?.path).toBe('/messages/a%2Fb%20c')
  })
})

describe('health', () => {
  const fx = httpFixtures()
  it('reads battery and charging from a healthy device', async () => {
    const { provider } = make([() => json(fx['get-health-pass']?.response.status as number, fx['get-health-pass']?.response.body)])
    const h = await provider.health()
    expect(h).toMatchObject({ ok: true, battery: 87, details: { reachable: true, status: 'pass', charging: true, version: '1.77.1' } })
  })

  it('a failing health document (HTTP 500) is reported as not ok but reachable', async () => {
    const { provider } = make([() => json(fx['get-health-fail']?.response.status as number, fx['get-health-fail']?.response.body)])
    expect(await provider.health()).toMatchObject({ ok: false, battery: 8, details: { reachable: true, status: 'fail', charging: false } })
  })

  it('warn is still ok', async () => {
    const { provider } = make([() => json(200, { status: 'warn', checks: {} })])
    expect(await provider.health()).toMatchObject({ ok: true, details: { status: 'warn' } })
  })

  it('an unreachable device is a result, not an exception', async () => {
    expect(await make([() => timeout()]).provider.health()).toMatchObject({ ok: false, details: { reachable: false, status: 'unreachable' } })
    expect(await make([() => json(200, '<html>')]).provider.health()).toMatchObject({ ok: false, details: { reachable: true, status: 'unreachable' } })
    expect(await make([() => json(502)]).provider.health()).toMatchObject({ ok: false })
  })
})

describe('registerWebhooks', () => {
  const URL_ = 'https://oasis-api.example.ts.net/hooks/smsgate/tablet-1'
  const idFor = (e: string): string => `oasis-${e.replace(/[^a-z0-9]+/gi, '-')}`

  it('registers one webhook per event with fixed ids on a blank device', async () => {
    const steps: Step[] = [() => json(200, []), ...SMSGATE_WEBHOOK_EVENTS.map(() => (c: Call) => json(201, c.body))]
    const { provider, calls } = make(steps)
    await provider.registerWebhooks(URL_, 'secret')
    const posts = calls.filter((c) => c.method === 'POST')
    expect(posts).toHaveLength(7)
    expect(posts.map((c) => c.body)).toEqual(SMSGATE_WEBHOOK_EVENTS.map((e) => ({ id: idFor(e), url: URL_, event: e })))
    expect(posts.every((c) => (c.body as { id: string }).id.length <= 36)).toBe(true)
    expect(SMSGATE_WEBHOOK_EVENTS).toEqual(['sms:received', 'sms:sent', 'sms:delivered', 'sms:failed', 'sms:cancelled', 'system:ping', 'app:started'])
  })

  it('is idempotent: when everything is already registered nothing is posted', async () => {
    const existing = SMSGATE_WEBHOOK_EVENTS.map((e) => ({ id: idFor(e), url: URL_, event: e, deviceId: null }))
    const { provider, calls } = make([() => json(200, existing)])
    const report = await provider.syncWebhooks(URL_, 'secret')
    expect(calls).toHaveLength(1)
    expect(report).toMatchObject({ created: [], replaced: [], removed: [] })
    expect(report.unchanged).toHaveLength(7)
  })

  it('re-posts (replaces) a registration whose URL changed and creates the missing ones', async () => {
    const existing = [
      { id: idFor('sms:received'), url: 'https://old.example.ts.net/hooks', event: 'sms:received' },
      { id: idFor('sms:sent'), url: URL_, event: 'sms:sent' },
    ]
    const steps: Step[] = [() => json(200, existing), ...Array.from({ length: 6 }, () => (c: Call) => json(201, c.body))]
    const { provider } = make(steps)
    const report = await provider.syncWebhooks(URL_, 'secret')
    expect(report.replaced).toEqual([idFor('sms:received')])
    expect(report.unchanged).toEqual([idFor('sms:sent')])
    expect(report.created).toHaveLength(5)
  })

  it('removes stale oasis- registrations and leaves foreign ones alone', async () => {
    const existing = [
      ...SMSGATE_WEBHOOK_EVENTS.map((e) => ({ id: idFor(e), url: URL_, event: e })),
      { id: 'oasis-sms-batch-received', url: URL_, event: 'sms:batch:received' },
      { id: 'someone-elses', url: 'https://other.example/hook', event: 'sms:received' },
    ]
    const { provider, calls } = make([() => json(200, existing), () => json(204)])
    const report = await provider.syncWebhooks(URL_, 'secret')
    expect(report.removed).toEqual(['oasis-sms-batch-received'])
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/webhooks/oasis-sms-batch-received' })
    expect(calls.filter((c) => c.path.includes('someone-elses'))).toHaveLength(0)
  })

  it('refuses a plain http URL before talking to the device, as the app would', async () => {
    const { provider, calls } = make([])
    await expect(provider.registerWebhooks('http://oasis-api.example.ts.net/hooks', 'secret')).rejects.toMatchObject({ kind: 'rejected' })
    await expect(provider.registerWebhooks('not a url', 'secret')).rejects.toMatchObject({ kind: 'rejected' })
    expect(calls).toHaveLength(0)
    const loopback = make([() => json(200, SMSGATE_WEBHOOK_EVENTS.map((e) => ({ id: idFor(e), url: 'http://127.0.0.1:3001/h', event: e }))) ])
    await loopback.provider.registerWebhooks('http://127.0.0.1:3001/h', 'secret')
    const insecure = make([() => json(200, SMSGATE_WEBHOOK_EVENTS.map((e) => ({ id: idFor(e), url: 'http://lan.example/h', event: e })))], { allowInsecureWebhookUrl: true })
    await insecure.provider.registerWebhooks('http://lan.example/h', 'secret')
  })

  it('requires a secret and surfaces device errors', async () => {
    await expect(make([]).provider.registerWebhooks(URL_, '')).rejects.toMatchObject({ kind: 'rejected' })
    await expect(make([() => json(401)]).provider.registerWebhooks(URL_, 's')).rejects.toMatchObject({ kind: 'auth' })
    await expect(make([() => json(200, []), () => json(400, { message: 'bad' })]).provider.registerWebhooks(URL_, 's')).rejects.toMatchObject({ kind: 'rejected' })
  })

  it('pushes the signing key to the device only when asked to', async () => {
    const steps: Step[] = [() => json(200, {}), () => json(200, []), ...SMSGATE_WEBHOOK_EVENTS.map(() => (c: Call) => json(201, c.body))]
    const { provider, calls } = make(steps, { syncSigningKey: true })
    await provider.registerWebhooks(URL_, 'new-secret')
    expect(calls[0]).toMatchObject({ method: 'PATCH', path: '/settings', body: { webhooks: { signing_key: 'new-secret' } } })
  })

  it('verifies with the secret it was last given', async () => {
    const f = webhookFixture('sms-sent')
    const { provider } = make([() => json(200, SMSGATE_WEBHOOK_EVENTS.map((e) => ({ id: idFor(e), url: URL_, event: e })))], { webhookSecret: 'stale-config-secret' })
    expect(() => provider.verifyAndParseWebhook(f.headers, f.body)).toThrow(/Signature mismatch/)
    await provider.registerWebhooks(URL_, FIXTURE_SECRET)
    expect(provider.verifyAndParseWebhook(f.headers, f.body).kind).toBe('sent')
  })
})

describe('config', () => {
  it('reads the environment contract and applies defaults', () => {
    const c = smsGateConfigFromEnv({ SMSGATE_DEVICE_URL: 'http://100.64.0.7:8080/', SMSGATE_USERNAME: 'u', SMSGATE_PASSWORD: 'p', SMSGATE_WEBHOOK_SECRET: 's' })
    expect(c).toMatchObject({ baseUrl: 'http://100.64.0.7:8080', messagesPath: '/messages', timeoutMs: 10_000, webhookToleranceSec: 86_400, resendAttempts: 1, legacyMessageField: false, syncSigningKey: false })
  })

  it('takes overrides and rejects a missing secret', () => {
    const base = { SMSGATE_DEVICE_URL: 'http://100.64.0.7:8080', SMSGATE_USERNAME: 'u', SMSGATE_PASSWORD: 'p', SMSGATE_WEBHOOK_SECRET: 's' }
    expect(smsGateConfigFromEnv({ ...base, SMSGATE_API_PATH: '/message', SMSGATE_TIMEOUT_MS: '3000', SMSGATE_SIM_NUMBER: '2', SMSGATE_LEGACY_MESSAGE_FIELD: 'true' })).toMatchObject({
      messagesPath: '/message',
      timeoutMs: 3000,
      defaultSimNumber: 2,
      legacyMessageField: true,
    })
    expect(() => smsGateConfigFromEnv({ ...base, SMSGATE_WEBHOOK_SECRET: undefined })).toThrow()
  })
})
