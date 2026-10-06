import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SmsDeviceHealth, SmsEvent, SmsProvider } from '../../../src/integrations/ports/sms.js'
import { SmsWebhookError } from '../../../src/integrations/sms/errors.js'

export interface WebhookDelivery {
  headers: Record<string, string>
  body: string
}

/**
 * What the shared contract suite needs from a device (real recorded fixtures, the HTTP simulator, or the in-process
 * simulator). Every harness drives the same SmsProvider interface and the same assertions.
 */
export interface ContractHarness {
  provider: SmsProvider
  webhookUrl: string
  secret: string
  /** Ids the suite uses. Fixture-backed harnesses return the ids baked into their recordings. */
  ids: { accepted: string; failing: string; cancelled: string; unknown: string; second: string }
  /** The device produces a signed webhook for the message. */
  emit(kind: 'sent' | 'delivered' | 'failed' | 'cancelled', id: string): Promise<WebhookDelivery>
  inbound(from: string, body: string): Promise<WebhookDelivery>
  ping(): Promise<WebhookDelivery>
  appStarted(): Promise<WebhookDelivery>
  /** Messages the device holds (accepted POSTs). */
  deviceMessageCount(): number
  registeredWebhookCount(): number
  /** Make the device fail every request with a 5xx, and repair it. */
  breakDevice(): void
  repairDevice(): void
  advanceClock(ms: number): void
  /** Set when the harness can accept a message and then lose the response. */
  supportsLostResponse: boolean
  loseNextResponse?(): void
  close(): Promise<void>
}

const VALID_STATES = ['Pending', 'Processed', 'Sent', 'Delivered']

function verify(h: ContractHarness, d: WebhookDelivery): SmsEvent {
  return h.provider.verifyAndParseWebhook(d.headers, d.body)
}

function errorCode(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    return e instanceof SmsWebhookError ? e.code : `other:${(e as Error).message}`
  }
  return 'no error'
}

export function describeSmsProviderContract(name: string, make: () => Promise<ContractHarness>): void {
  describe(`SmsProvider contract: ${name}`, () => {
    let h: ContractHarness
    beforeAll(async () => {
      h = await make()
    })
    afterAll(async () => {
      await h.close()
    })

    it('registers webhooks for all seven events, and again without duplicating them', async () => {
      await h.provider.registerWebhooks(h.webhookUrl, h.secret)
      expect(h.registeredWebhookCount()).toBe(7)
      await h.provider.registerWebhooks(h.webhookUrl, h.secret)
      expect(h.registeredWebhookCount()).toBe(7)
    })

    it('reports a healthy device with a battery level', async () => {
      const health: SmsDeviceHealth = await h.provider.health()
      expect(health.ok).toBe(true)
      expect(health.battery).toBeGreaterThanOrEqual(0)
      expect(health.battery).toBeLessThanOrEqual(100)
    })

    it('sends with our id and returns it as the provider id', async () => {
      const res = await h.provider.send({ id: h.ids.accepted, to: '+17865550151', body: 'Your vehicle is ready for pickup!', ttlSec: 600, priority: 0 })
      expect(res.providerMessageId).toBe(h.ids.accepted)
      expect(VALID_STATES).toContain(res.state)
      expect(h.deviceMessageCount()).toBe(1)
    })

    it('never creates a second message when the same id is sent again', async () => {
      const again = await h.provider.send({ id: h.ids.accepted, to: '+17865550151', body: 'Your vehicle is ready for pickup!', ttlSec: 600 })
      expect(again.providerMessageId).toBe(h.ids.accepted)
      expect(VALID_STATES).toContain(again.state)
      expect(h.deviceMessageCount()).toBe(1)
    })

    it('looks a message up by our id, and returns null for one the device has never seen', async () => {
      const found = await h.provider.status(h.ids.accepted)
      expect(found).not.toBeNull()
      expect(VALID_STATES).toContain(found?.state)
      expect(await h.provider.status(h.ids.unknown)).toBeNull()
    })

    it('rejects a recipient that is not E.164 without retry advice', async () => {
      await expect(h.provider.send({ id: h.ids.second, to: '7865550151', body: 'hi' })).rejects.toMatchObject({ retryable: false })
      expect(h.deviceMessageCount()).toBe(1)
    })

    it('verifies and parses a sent webhook', async () => {
      const e = verify(h, await h.emit('sent', h.ids.accepted))
      expect(e).toMatchObject({ kind: 'sent', providerMessageId: h.ids.accepted })
      expect(e.eventId).toBeTruthy()
      expect((e as { at: Date }).at).toBeInstanceOf(Date)
    })

    it('verifies and parses a delivered webhook', async () => {
      const e = verify(h, await h.emit('delivered', h.ids.accepted))
      expect(e).toMatchObject({ kind: 'delivered', providerMessageId: h.ids.accepted })
    })

    it('verifies and parses a failed webhook with its reason', async () => {
      await h.provider.send({ id: h.ids.failing, to: '+17865550151', body: 'Will fail' })
      const e = verify(h, await h.emit('failed', h.ids.failing))
      expect(e).toMatchObject({ kind: 'failed', providerMessageId: h.ids.failing, reason: 'Radio off' })
    })

    it('verifies and parses a cancelled webhook', async () => {
      await h.provider.send({ id: h.ids.cancelled, to: '+17865550151', body: 'Will be cancelled' })
      const e = verify(h, await h.emit('cancelled', h.ids.cancelled))
      expect(e).toMatchObject({ kind: 'cancelled', providerMessageId: h.ids.cancelled })
    })

    it('verifies and parses an inbound text with an E.164 sender', async () => {
      const e = verify(h, await h.inbound('+17865550151', 'C'))
      expect(e).toMatchObject({ kind: 'received', from: '+17865550151', body: 'C' })
      expect((e as { deviceId: string }).deviceId).toBeTruthy()
      expect((e as { providerMessageId: string }).providerMessageId).toBeTruthy()
    })

    it('verifies and parses ping and app:started', async () => {
      expect(verify(h, await h.ping())).toMatchObject({ kind: 'ping' })
      expect(verify(h, await h.appStarted())).toMatchObject({ kind: 'app_started' })
    })

    it('rejects a tampered body, a bad signature and a stale timestamp', async () => {
      const d = await h.inbound('+17865550151', 'C')
      expect(errorCode(() => verify(h, { ...d, body: d.body.replace('"C"', '"STOP"') }))).toBe('bad_signature')
      expect(errorCode(() => verify(h, { ...d, headers: { ...d.headers, 'x-signature': '0'.repeat(64) } }))).toBe('bad_signature')
      expect(errorCode(() => verify(h, d))).toBe('no error')
      h.advanceClock(25 * 3600_000)
      expect(errorCode(() => verify(h, d))).toBe('stale_timestamp')
      h.advanceClock(-25 * 3600_000)
    })

    it('a device that answers 5xx yields a retryable error, and recovers when repaired', async () => {
      h.breakDevice()
      await expect(h.provider.send({ id: h.ids.second, to: '+17865550151', body: 'while down' })).rejects.toMatchObject({ retryable: true })
      h.repairDevice()
      const res = await h.provider.send({ id: h.ids.second, to: '+17865550151', body: 'after repair' })
      expect(res.providerMessageId).toBe(h.ids.second)
    })

    it('a response lost after the device accepted the message does not produce a duplicate', async (ctx) => {
      if (!h.supportsLostResponse || !h.loseNextResponse) return ctx.skip()
      const before = h.deviceMessageCount()
      h.loseNextResponse()
      const res = await h.provider.send({ id: 'lost-response-1', to: '+17865550151', body: 'maybe sent' }).catch((e: unknown) => e)
      // Either the adapter resolved the ambiguity itself, or it raised a retryable error and the retry resolves it.
      if (res instanceof Error) {
        expect(res).toMatchObject({ retryable: true })
        const retry = await h.provider.send({ id: 'lost-response-1', to: '+17865550151', body: 'maybe sent' })
        expect(retry.providerMessageId).toBe('lost-response-1')
      }
      expect(h.deviceMessageCount()).toBe(before + 1)
    })
  })
}
