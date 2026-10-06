import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { FixedClock } from '../../../src/platform/clock.js'
import {
  InMemoryNotificationDedupe,
  buildSignedNotification,
  receiveWebhook,
  signSquarespacePayload,
  verifySquarespaceSignature,
  type WebhookDeps,
} from '../../../src/integrations/squarespace/webhook.js'
import {
  InMemoryWebhookSubscriptionManager,
  ensureWebhookSubscription,
} from '../../../src/integrations/squarespace/subscriptions.js'
import { SquarespaceSimApi } from '../../../src/integrations/squarespace/sim/api.js'
import { SquarespaceSimStore } from '../../../src/integrations/squarespace/sim/store.js'
import { fixture, NOW, type WebhookFixture } from '../../fixtures/squarespace/load.js'

const fx = fixture<WebhookFixture>('webhooks.json')

function deps(over: Partial<WebhookDeps> = {}): {
  deps: WebhookDeps
  clock: FixedClock
  dedupe: InMemoryNotificationDedupe
} {
  const clock = new FixedClock('2026-10-05T10:03:00.000Z')
  const dedupe = new InMemoryNotificationDedupe()
  return { deps: { clock, dedupe, secrets: () => [fx.secret], ...over }, clock, dedupe }
}

describe('signature', () => {
  it('matches the vector computed independently with `openssl sha256 -mac hmac -macopt hexkey:` (fixture)', () => {
    expect(signSquarespacePayload(fx.orderCreate.body, fx.secret)).toBe(fx.orderCreate.signature)
    expect(fx.orderCreate.signature).toBe('4f3b93bb8d5ec53981ad23ee6a1550362f1c5ab1ee0d3da5da424aeb41ce80b0')
  })

  it('decodes the hex secret to bytes first (using the hex text as the key gives a different, wrong MAC)', async () => {
    const { createHmac } = await import('node:crypto')
    const wrong = createHmac('sha256', fx.secret).update(fx.orderCreate.body).digest('hex')
    expect(wrong).not.toBe(fx.orderCreate.signature)
    expect(verifySquarespaceSignature(fx.orderCreate.body, wrong, fx.secret)).toBe(false)
  })

  it('verifies valid, rejects tampered body, wrong secret, missing/short/long header, accepts uppercase hex', () => {
    const ok = (sig: string | undefined, body = fx.orderCreate.body, secret = fx.secret) =>
      verifySquarespaceSignature(body, sig, secret)
    expect(ok(fx.orderCreate.signature)).toBe(true)
    expect(ok(fx.orderCreate.signature.toUpperCase())).toBe(true)
    expect(ok(fx.orderCreate.signature, fx.orderCreate.body.replace('0009', '0008'))).toBe(false)
    expect(ok(fx.orderCreate.signature, fx.orderCreate.body, '00'.repeat(32))).toBe(false)
    expect(ok(undefined)).toBe(false)
    expect(ok('')).toBe(false)
    expect(ok(fx.orderCreate.signature.slice(0, 20))).toBe(false)
    expect(ok(`${fx.orderCreate.signature}00`)).toBe(false)
  })

  it('refuses a non-hex secret rather than silently using it', () => {
    expect(() => signSquarespacePayload('x', 'not-hex')).toThrow(/hex/)
  })

  it('signs raw bytes exactly: re-serialising the JSON would change the signature', () => {
    const reformatted = JSON.stringify(JSON.parse(fx.orderCreate.body), null, 2)
    expect(verifySquarespaceSignature(reformatted, fx.orderCreate.signature, fx.secret)).toBe(false)
  })
})

describe('receiveWebhook', () => {
  it('accepts a valid order.create', async () => {
    const { deps: d } = deps()
    const out = await receiveWebhook(d, {
      rawBody: fx.orderCreate.body,
      headers: { 'Squarespace-Signature': fx.orderCreate.signature },
    })
    expect(out).toMatchObject({
      status: 'accepted',
      topic: 'order.create',
      orderId: '64f0a1000000000000000009',
      notificationId: '5c2ba184b63ed3cb411ce2b1',
    })
  })

  it('accepts header names in any case and carries the order.update kind', async () => {
    const { deps: d } = deps()
    const out = await receiveWebhook(d, {
      rawBody: fx.orderUpdate.body,
      headers: { 'SQUARESPACE-SIGNATURE': fx.orderUpdate.signature },
    })
    expect(out).toMatchObject({ status: 'accepted', topic: 'order.update', update: 'REFUNDED' })
  })

  it('rejects a bad signature and does not consume the notification id', async () => {
    const { deps: d, dedupe } = deps()
    const bad = await receiveWebhook(d, {
      rawBody: fx.orderCreate.body,
      headers: { 'squarespace-signature': '0'.repeat(64) },
    })
    expect(bad).toEqual({ status: 'invalid_signature' })
    expect(dedupe.size).toBe(0)
    const missing = await receiveWebhook(d, { rawBody: fx.orderCreate.body, headers: {} })
    expect(missing).toEqual({ status: 'invalid_signature' })
    const ok = await receiveWebhook(d, {
      rawBody: fx.orderCreate.body,
      headers: { 'squarespace-signature': fx.orderCreate.signature },
    })
    expect(ok.status).toBe('accepted')
  })

  it('dedupes by notification id (replay and at-least-once redelivery)', async () => {
    const { deps: d } = deps()
    const req = {
      rawBody: fx.orderCreate.body,
      headers: { 'squarespace-signature': fx.orderCreate.signature },
    }
    expect((await receiveWebhook(d, req)).status).toBe('accepted')
    expect(await receiveWebhook(d, req)).toEqual({
      status: 'duplicate',
      notificationId: '5c2ba184b63ed3cb411ce2b1',
    })
    // a distinct update for the same order is a different notification and is processed
    const upd = await receiveWebhook(d, {
      rawBody: fx.orderUpdate.body,
      headers: { 'squarespace-signature': fx.orderUpdate.signature },
    })
    expect(upd.status).toBe('accepted')
  })

  it('release() lets Squarespace retry after a failed enqueue', async () => {
    const { deps: d, dedupe } = deps()
    const req = {
      rawBody: fx.orderCreate.body,
      headers: { 'squarespace-signature': fx.orderCreate.signature },
    }
    await receiveWebhook(d, req)
    await dedupe.release('5c2ba184b63ed3cb411ce2b1')
    expect((await receiveWebhook(d, req)).status).toBe('accepted')
  })

  it('rejects notifications older than the replay window even if the dedupe entry expired', async () => {
    const { deps: d, clock } = deps()
    clock.set('2026-10-20T00:00:00.000Z')
    const out = await receiveWebhook(d, {
      rawBody: fx.orderCreate.body,
      headers: { 'squarespace-signature': fx.orderCreate.signature },
    })
    expect(out).toEqual({ status: 'stale', notificationId: '5c2ba184b63ed3cb411ce2b1' })
  })

  it('dedupe ids expire after the TTL', async () => {
    const dedupe = new InMemoryNotificationDedupe(1000)
    expect(await dedupe.claim('a', new Date(NOW))).toBe(true)
    expect(await dedupe.claim('a', new Date(Date.parse(NOW) + 500))).toBe(false)
    expect(await dedupe.claim('a', new Date(Date.parse(NOW) + 1500))).toBe(true)
  })

  it('acknowledges but ignores topics Oasis does not use', async () => {
    const { deps: d } = deps()
    const out = await receiveWebhook(d, {
      rawBody: fx.extensionUninstall.body,
      headers: { 'squarespace-signature': fx.extensionUninstall.signature },
    })
    expect(out).toMatchObject({ status: 'ignored', topic: 'extension.uninstall' })
  })

  it('reports malformed bodies; a validly signed but non-notification body is malformed, an unsigned one invalid', async () => {
    const { deps: d } = deps()
    expect((await receiveWebhook(d, { rawBody: 'not json', headers: {} })).status).toBe('malformed')
    const body = JSON.stringify({ hello: 'world' })
    expect(
      await receiveWebhook(d, { rawBody: body, headers: { 'squarespace-signature': 'a'.repeat(64) } }),
    ).toEqual({ status: 'invalid_signature' })
    const signed = await receiveWebhook(d, {
      rawBody: body,
      headers: { 'squarespace-signature': signSquarespacePayload(body, fx.secret) },
    })
    expect(signed.status).toBe('malformed')
    const noOrder = buildSignedNotification({
      secretHex: fx.secret,
      id: 'n1',
      websiteId: 'w',
      subscriptionId: 's',
      topic: 'order.create',
      createdOn: new Date('2026-10-05T10:02:30Z'),
      data: {},
    })
    expect((await receiveWebhook(d, { rawBody: noOrder.rawBody, headers: noOrder.headers })).status).toBe(
      'malformed',
    )
  })

  it('tries each secret for the subscription (secret rotation window) and resolves by subscription id', async () => {
    const seen: (string | undefined)[] = []
    const newSecret = 'ab'.repeat(32)
    const { deps: d } = deps({
      secrets: (id) => {
        seen.push(id)
        return [newSecret, fx.secret]
      },
    })
    const out = await receiveWebhook(d, {
      rawBody: fx.orderCreate.body,
      headers: { 'squarespace-signature': fx.orderCreate.signature },
    })
    expect(out.status).toBe('accepted')
    expect(seen).toEqual(['5f3c2155d947844beedda991'])
  })
})

describe('simulator delivers signed webhooks like the real service', () => {
  it('auto-delivers order.create (paid) and order.update (refund) to a live HTTP endpoint, verified by receiveWebhook', async () => {
    const clock = new FixedClock('2026-10-06T14:00:00.000Z')
    const store = new SquarespaceSimStore(clock)
    const api = new SquarespaceSimApi(store, clock)
    const received: Awaited<ReturnType<typeof receiveWebhook>>[] = []
    const d: WebhookDeps = { clock, dedupe: new InMemoryNotificationDedupe(), secrets: () => [fx.secret] }
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', async () => {
        const headers: Record<string, string | undefined> = {}
        for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v
        expect(headers['user-agent']).toBe('Squarespace/1.0')
        received.push(await receiveWebhook(d, { rawBody: Buffer.concat(chunks), headers }))
        res.writeHead(200).end()
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks/squarespace`
      api.opts.webhook = {
        url,
        secret: fx.secret,
        subscriptionId: 'sub1',
        websiteId: 'web1',
        autoDeliver: true,
      }
      const { orderId } = store.createOrder({
        email: 'a@example.com',
        lineItems: [{ name: 'Wash', unitCents: 5000 }],
      })
      store.refund(orderId, { amountCents: 1000 })
      await api.settled()
      expect(
        received.map((r) => (r.status === 'accepted' ? [r.topic, r.orderId, r.update ?? null] : r.status)),
      ).toEqual([
        ['order.create', orderId, null],
        ['order.update', orderId, 'REFUNDED'],
      ])
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('does not announce an unpaid/partially paid order.create until it is paid (payment plan semantics)', () => {
    const clock = new FixedClock(NOW)
    const store = new SquarespaceSimStore(clock)
    const { orderId } = store.createOrder({
      email: 'a@example.com',
      lineItems: [{ name: 'Plan', unitCents: 90000 }],
      pay: { amountCents: 30000 },
    })
    expect(store.events.filter((e) => e.topic === 'order.create')).toEqual([])
    store.addPayment(orderId, { amountCents: 60000 })
    expect(store.getOrder(orderId).paymentState).toBe('PAID')
  })
})

describe('webhook subscription management (OAuth only; interface, in-memory)', () => {
  it('ensure creates once, is idempotent, and updates changed topics; the secret is only returned on create', async () => {
    const m = new InMemoryWebhookSubscriptionManager()
    const url = 'https://oasis.example/hooks/squarespace'
    const first = await ensureWebhookSubscription(m, {
      endpointUrl: url,
      topics: ['order.update', 'order.create'],
    })
    expect(first.action).toBe('created')
    expect(first.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(first.subscription.topics).toEqual(['order.create', 'order.update'])
    const again = await ensureWebhookSubscription(m, {
      endpointUrl: url,
      topics: ['order.create', 'order.update'],
    })
    expect(again).toMatchObject({ action: 'unchanged' })
    expect(again.secret).toBeUndefined()
    const changed = await ensureWebhookSubscription(m, { endpointUrl: url, topics: ['order.create'] })
    expect(changed.action).toBe('updated')
    expect(await m.list()).toHaveLength(1)
  })

  it('requires an HTTPS endpoint and supports rotate/test/delete', async () => {
    const m = new InMemoryWebhookSubscriptionManager()
    await expect(m.create({ endpointUrl: 'http://x', topics: [] })).rejects.toThrow(/HTTPS/)
    const s = await m.create({ endpointUrl: 'https://x.example/h', topics: ['order.create'] })
    await m.sendTest(s.id, 'order.create')
    expect(m.tests).toHaveLength(1)
    const before = m.secretOf(s.id)
    expect((await m.rotateSecret(s.id)).secret).toBe(m.secretOf(s.id))
    expect(before).toBe(m.secretOf(s.id)) // fixed generator in this test double
    await m.delete(s.id)
    expect(await m.list()).toEqual([])
  })
})
