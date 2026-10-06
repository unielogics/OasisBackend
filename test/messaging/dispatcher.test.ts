import { describe, expect, it } from 'vitest'
import { SmsProviderError } from '../../src/integrations/sms/errors.js'
import { SimulatorProvider } from '../../src/integrations/sms/simulator.js'
import type { SmsEvent } from '../../src/integrations/ports/sms.js'
import { SmsEventIngestor } from '../../src/modules/messaging/dispatch/ingest.js'
import { retryProviderId } from '../../src/modules/messaging/dispatch/retry.js'
import { DEVICE, enqueue, harness, recipient } from './helpers.js'

const sentIds = (h: ReturnType<typeof harness>): string[] => h.provider.device.listMessages().map((m) => m.id)

describe('enqueue', () => {
  it('queues, normalises to GSM-7, adds the first-message footer and stores segments', async () => {
    const h = harness()
    const r = await h.dispatcher.enqueue({ messageId: 'm1', klass: 'ready', text: 'Your vehicle’s ready — come in ⭐', recipient: recipient(1) })
    expect(r).toMatchObject({ status: 'queued', encoding: 'GSM-7', segments: 1, body: "Your vehicle's ready - come in Reply STOP to opt out." })
    const item = await h.outbox.get('m1')
    expect(item).toMatchObject({ state: 'pending', priority: 0, segments: 1, deviceId: DEVICE })
    // second message to the same number: no footer for a class that only needs it on first contact
    const r2 = await h.dispatcher.enqueue({ messageId: 'm2', klass: 'ready', text: 'Again!', recipient: recipient(1) })
    expect(r2).toMatchObject({ body: 'Again!' })
  })

  it('suppresses by policy and never touches the outbox', async () => {
    const h = harness()
    const r = await h.dispatcher.enqueue({ messageId: 'm1', klass: 'ready', text: 'hi', recipient: recipient(1, { activeOptOut: true }) })
    expect(r).toEqual({ status: 'suppressed', reason: 'opted_out' })
    expect(await h.outbox.get('m1')).toBeNull()
  })

  it('is idempotent on the message id', async () => {
    const h = harness()
    await enqueue(h, 'm1', 'ready')
    expect(await h.dispatcher.enqueue({ messageId: 'm1', klass: 'ready', text: 'hello', recipient: recipient(1) })).toEqual({ status: 'duplicate', id: 'm1' })
  })

  it('rejects empty and over-long bodies', async () => {
    const h = harness({ config: { maxSegments: 3 } })
    expect(await h.dispatcher.enqueue({ messageId: 'e', klass: 'ready', text: '  ', recipient: recipient(1) })).toEqual({ status: 'rejected', reason: 'empty' })
    expect(await h.dispatcher.enqueue({ messageId: 'e2', klass: 'ready', text: '⭐', recipient: recipient(1) })).toEqual({ status: 'rejected', reason: 'empty' })
    expect(await h.dispatcher.enqueue({ messageId: 'l', klass: 'ready', text: 'a'.repeat(500), recipient: recipient(1) })).toMatchObject({ status: 'rejected', reason: 'too_long', segments: 4 })
  })

  it('holds non-transactional classes in quiet hours and starts their expiry clock at release', async () => {
    const h = harness({ start: '2026-06-13T22:00:00-04:00' })
    const r = await h.dispatcher.enqueue({ messageId: 'r1', klass: 'reminder', text: 'Reminder', recipient: recipient(1) })
    expect(r).toMatchObject({ status: 'held' })
    if (r.status === 'held') {
      expect(r.holdUntil?.toISOString()).toBe(new Date('2026-06-14T08:00:00-04:00').toISOString())
      expect(r.ttlAt.toISOString()).toBe(new Date('2026-06-14T10:00:00-04:00').toISOString())
    }
    const t = await h.dispatcher.enqueue({ messageId: 't1', klass: 'confirmed', text: 'Confirmed', recipient: recipient(2) })
    expect(t.status).toBe('queued')
  })
})

describe('lanes and ordering', () => {
  it('sends lane 0 before lane 3, FIFO within a lane', async () => {
    const h = harness()
    await enqueue(h, 'blast1', 'emergency', 'x', 1)
    h.clock.advance(1000)
    await enqueue(h, 'reply1', 'quick_reply', 'x', 2)
    h.clock.advance(1000)
    await enqueue(h, 'ready1', 'ready', 'x', 3)
    h.clock.advance(1000)
    await enqueue(h, 'ready2', 'ready', 'x', 4)
    h.clock.advance(1000)
    await enqueue(h, 'rem1', 'reminder', 'x', 5)
    const report = await h.dispatcher.tick()
    expect(report.sent).toEqual(['ready1', 'ready2', 'reply1', 'rem1', 'blast1'])
  })

  it('a bulk emergency blast cannot starve ready-for-pickup texts: the last 6 of 30 are reserved for lane 0', async () => {
    const h = harness()
    for (let i = 0; i < 40; i++) await enqueue(h, `blast-${i}`, 'emergency', 'Closed today', 100 + i)
    const first = await h.dispatcher.tick()
    expect(first.sent).toHaveLength(24)
    expect(first.rateLimited).toBe(true)

    // a customer's car finishes while the blast is stuck behind the window
    await enqueue(h, 'ready-1', 'ready', 'Ready', 900)
    const second = await h.dispatcher.tick()
    expect(second.sent).toEqual(['ready-1'])
    // and lane 0 can use the whole reserve, not more than the window
    for (let i = 0; i < 10; i++) await enqueue(h, `ready-x${i}`, 'ready', 'Ready', 910 + i)
    const third = await h.dispatcher.tick()
    expect(third.sent).toHaveLength(5)
    const fourth = await h.dispatcher.tick()
    expect(fourth.sent).toHaveLength(0)
    const usage = await h.outbox.listUsage(new Date(h.clock.now().getTime() - 30 * 60_000))
    expect(usage.reduce((n, u) => n + u.segments, 0)).toBe(30)
  })

  it('maps lanes to the priority handed to the provider and passes the remaining TTL', async () => {
    const h = harness()
    await enqueue(h, 'w1', 'welcome', 'Welcome', 1)
    await h.dispatcher.tick()
    const m = h.provider.device.message('w1')
    expect(m?.ttl).toBe(15 * 60)
    expect(m?.priority).toBe(0)
  })
})

describe('send budget', () => {
  it('never exceeds 30 segments in any 30-minute window and frees room as entries age out', async () => {
    const h = harness()
    for (let i = 0; i < 40; i++) await enqueue(h, `p0-${i}`, 'ready', 'Ready', 100 + i)
    const a = await h.dispatcher.tick()
    expect(a.sent).toHaveLength(30)
    expect(a.rateLimited).toBe(true)
    expect(a.resumesAt?.toISOString()).toBe(new Date(h.clock.now().getTime() + 30 * 60_000).toISOString())

    h.clock.advance(29 * 60_000)
    expect((await h.dispatcher.tick()).sent).toHaveLength(0)
    h.clock.advance(60_000 + 1)
    const b = await h.dispatcher.tick()
    expect(b.sent).toHaveLength(10)
  })

  it('a sliding window is stricter than a refilling bucket: no second burst at the boundary', async () => {
    const h = harness()
    for (let i = 0; i < 30; i++) await enqueue(h, `a-${i}`, 'ready', 'Ready', 100 + i)
    await h.dispatcher.tick()
    h.clock.advance(15 * 60_000)
    for (let i = 0; i < 30; i++) await enqueue(h, `b-${i}`, 'ready', 'Ready', 200 + i)
    expect((await h.dispatcher.tick()).sent).toHaveLength(0)
  })

  it('charges multipart messages per segment', async () => {
    const h = harness({ config: { budget: { maxPerWindow: 6, windowMs: 30 * 60_000, reservedForP0: 0, safetyMargin: 0 } } })
    await enqueue(h, 'long1', 'ready', 'a'.repeat(300), 1) // 2 segments + footer pushes to 3? first message
    await enqueue(h, 'long2', 'ready', 'a'.repeat(300), 2)
    await enqueue(h, 'long3', 'ready', 'a'.repeat(300), 3)
    const item = await h.outbox.get('long1')
    expect(item?.segments).toBe(3)
    const r = await h.dispatcher.tick()
    expect(r.sent).toEqual(['long1', 'long2'])
    expect(r.rateLimited).toBe(true)
  })

  it('honours the pacing interval between sends', async () => {
    const h = harness({ config: { minIntervalMs: 4000 } })
    for (let i = 0; i < 3; i++) await enqueue(h, `m${i}`, 'ready', 'Ready', 100 + i)
    expect((await h.dispatcher.tick()).sent).toEqual(['m0'])
    expect((await h.dispatcher.tick()).paced).toBe(true)
    h.clock.advance(4000)
    expect((await h.dispatcher.tick()).sent).toEqual(['m1'])
  })

  it('reports rate_limited, queue depth by lane and an ETA from the window', async () => {
    const h = harness()
    for (let i = 0; i < 30; i++) await enqueue(h, `ready-${i}`, 'ready', 'Ready', 100 + i)
    await h.dispatcher.tick()
    await enqueue(h, 'ready-31', 'ready', 'Ready', 500)
    await enqueue(h, 'rem-1', 'reminder', 'Reminder', 501)
    const status = await h.dispatcher.status()
    expect(status.state).toBe('rate_limited')
    expect(status.rateLimited).toBe(true)
    expect(status.queue.depth).toBe(2)
    expect(status.queue.byLane).toEqual({ 0: 1, 1: 0, 2: 1, 3: 0 })
    expect(status.budget).toMatchObject({ used: 30, max: 30, remainingP0: 0, remainingOthers: 0 })
    // the first message leaves the window 30 minutes after it was sent
    expect(status.queue.etaFirst?.toISOString()).toBe(new Date(h.clock.now().getTime() + 30 * 60_000).toISOString())
    expect(status.resumesAt?.toISOString()).toBe(status.queue.etaFirst?.toISOString())
  })

  it('the ETA flags messages that will expire before their turn', async () => {
    const h = harness()
    for (let i = 0; i < 30; i++) await enqueue(h, `ready-${i}`, 'ready', 'Ready', 100 + i)
    await h.dispatcher.tick()
    await enqueue(h, 'welcome-1', 'welcome', 'Hi', 500) // 15 minute life, next window slot in 30
    const status = await h.dispatcher.status()
    expect(status.queue.willExpire).toBe(1)
  })
})

describe('dispatch state', () => {
  it('says idle, sending, quiet_hours and device_offline', async () => {
    const h = harness({ health: { failuresToOffline: 1 } })
    expect((await h.dispatcher.status()).state).toBe('idle')
    await enqueue(h, 'a', 'ready', 'Ready', 1)
    expect((await h.dispatcher.status()).state).toBe('sending')
    h.provider.setOutage('down')
    await h.dispatcher.tick()
    expect((await h.dispatcher.status()).state).toBe('device_offline')

    const q = harness({ start: '2026-06-13T22:00:00-04:00' })
    await q.dispatcher.enqueue({ messageId: 'r', klass: 'reminder', text: 'Reminder', recipient: recipient(1) })
    expect((await q.dispatcher.status()).state).toBe('quiet_hours')
  })
})

describe('quiet hours at tick time', () => {
  it('holds automated messages overnight and releases them at 08:00; transactional ones go through', async () => {
    const h = harness({ start: '2026-06-13T20:50:00-04:00' })
    await enqueue(h, 'rem', 'reminder', 'Reminder', 1)
    await enqueue(h, 'conf', 'confirm_request', 'Confirm', 2)
    h.clock.set('2026-06-13T21:30:00-04:00')
    await enqueue(h, 'booked', 'booking_thanks', 'Thanks', 3)
    const night = await h.dispatcher.tick()
    expect(night.sent).toEqual(['booked'])
    expect(night.heldByQuietHours).toBe(2)

    h.clock.set('2026-06-14T07:59:00-04:00')
    const before = await h.dispatcher.tick()
    expect(before.sent).toEqual([])
    // the reminder (2 h life) expired at 22:50 the night before without ever being allowed out
    expect(before.expired).toEqual(['rem'])
    h.clock.set('2026-06-14T08:00:00-04:00')
    const morning = await h.dispatcher.tick()
    // the confirmation request (12 h life) survives and goes at 08:00
    expect(morning.sent).toEqual(['conf'])
  })

  it('an item enqueued during quiet hours keeps its full life after release', async () => {
    const h = harness({ start: '2026-06-13T23:00:00-04:00' })
    await enqueue(h, 'rem', 'reminder', 'Reminder', 1)
    h.clock.set('2026-06-14T08:30:00-04:00')
    expect((await h.dispatcher.tick()).sent).toEqual(['rem'])
  })
})

describe('TTL and expiry', () => {
  it('a checked-in message expires after 15 minutes instead of arriving late', async () => {
    const h = harness()
    h.provider.setOutage('down')
    await enqueue(h, 'welcome', 'welcome', 'Welcome', 1)
    await h.dispatcher.tick()
    h.provider.setOutage('off')
    h.clock.advance(16 * 60_000)
    const r = await h.dispatcher.tick()
    expect(r.expired).toEqual(['welcome'])
    expect(r.sent).toEqual([])
    expect(await h.outbox.get('welcome')).toMatchObject({ state: 'expired' })
    expect(h.provider.messageCount()).toBe(0)
  })

  it('does not hand the device a message with under 5 seconds of life left', async () => {
    const h = harness()
    await enqueue(h, 'welcome', 'welcome', 'Welcome', 1)
    h.clock.advance(15 * 60_000 - 3000)
    const r = await h.dispatcher.tick()
    expect(r.expired).toEqual(['welcome'])
    expect(h.provider.messageCount()).toBe(0)
  })
})

describe('retries', () => {
  it('backs off 15 s, 30 s, 60 s on transient errors and gives up after six attempts', async () => {
    const h = harness({ config: { retry: { baseMs: 15_000, factor: 2, maxMs: 15 * 60_000, maxAttempts: 6 } }, health: { failuresToOffline: 99 } })
    h.provider.setOutage('error5xx')
    await enqueue(h, 'm1', 'ready', 'Ready', 1)
    const waits: number[] = []
    for (let i = 0; i < 6; i++) {
      const before = h.clock.now().getTime()
      await h.dispatcher.tick()
      const item = await h.outbox.get('m1')
      if (item?.state === 'pending') {
        waits.push((item.nextAttemptAt?.getTime() ?? 0) - before)
        h.clock.set(item.nextAttemptAt as Date)
      }
    }
    expect(waits).toEqual([15_000, 30_000, 60_000, 120_000, 240_000])
    expect(await h.outbox.get('m1')).toMatchObject({ state: 'failed', attempts: 6 })
    expect(h.provider.messageCount()).toBe(0)
  })

  it('does not retry a rejected message: a 4xx is permanent', async () => {
    const h = harness()
    const original = h.provider.send.bind(h.provider)
    h.provider.send = async () => {
      throw new SmsProviderError('rejected', 'bad number', { status: 400 })
    }
    await enqueue(h, 'm1', 'ready', 'Ready', 1)
    const r = await h.dispatcher.tick()
    expect(r.failed).toEqual(['m1'])
    expect(await h.outbox.get('m1')).toMatchObject({ state: 'failed', attempts: 0, lastError: 'bad number' })
    h.provider.send = original
    h.clock.advance(3600_000)
    expect((await h.dispatcher.tick()).sent).toEqual([])
  })

  it('an auth failure puts the message back untouched and stops the tick', async () => {
    const h = harness()
    h.provider.send = async () => {
      throw new SmsProviderError('auth', 'credentials rejected', { status: 401 })
    }
    await enqueue(h, 'm1', 'ready', 'Ready', 1)
    await enqueue(h, 'm2', 'ready', 'Ready', 2)
    const r = await h.dispatcher.tick()
    expect(r.authFailure).toBe(true)
    expect(await h.outbox.get('m1')).toMatchObject({ state: 'pending', attempts: 0 })
    expect(await h.outbox.get('m2')).toMatchObject({ state: 'pending' })
  })

  it('an ambiguous timeout after the device accepted never duplicates: the retry finds the message', async () => {
    const h = harness()
    await enqueue(h, 'm1', 'ready', 'Ready', 1)
    h.provider.setOutage('hang_after_accept', { once: true })
    const first = await h.dispatcher.tick()
    expect(first.sent).toEqual([])
    expect(await h.outbox.get('m1')).toMatchObject({ state: 'pending', attempts: 1 })
    expect(h.provider.messageCount()).toBe(1)

    h.clock.advance(20_000)
    const second = await h.dispatcher.tick()
    expect(second.sent).toEqual(['m1'])
    expect(h.provider.messageCount()).toBe(1)
    expect(await h.outbox.get('m1')).toMatchObject({ state: 'accepted' })
  })

  it('retryFailed gives a failed message a fresh attempt and TTL', async () => {
    const h = harness({ health: { failuresToOffline: 99 } })
    h.provider.send = async () => {
      throw new SmsProviderError('rejected', 'nope')
    }
    await enqueue(h, 'm1', 'ready', 'Ready', 1)
    await h.dispatcher.tick()
    expect((await h.outbox.get('m1'))?.state).toBe('failed')
    h.provider.send = SimulatorProvider.prototype.send.bind(h.provider)
    expect(await h.dispatcher.retryFailed('m1')).toBe(true)
    expect((await h.dispatcher.tick()).sent).toEqual(['m1'])
    expect(await h.dispatcher.retryFailed('m1')).toBe(false)
  })

  it('cancel only works before the device has the message', async () => {
    const h = harness()
    await enqueue(h, 'm1', 'ready', 'Ready', 1)
    await enqueue(h, 'm2', 'ready', 'Ready', 2)
    expect(await h.dispatcher.cancel('m1')).toBe(true)
    await h.dispatcher.tick()
    expect(await h.dispatcher.cancel('m2')).toBe(false)
    expect(sentIds(h)).toEqual(['m2'])
  })

  it('puts an orphaned inflight claim back after a crash and the provider dedupes by id', async () => {
    const h = harness()
    await enqueue(h, 'm1', 'ready', 'Ready', 1)
    await h.outbox.claim('m1', h.clock.now())
    // the process died after the device accepted the message but before we recorded it
    await h.provider.send({ id: 'm1', to: recipient(1).phone as string, body: 'Ready', ttlSec: 600 })
    h.clock.advance(3 * 60_000)
    const r = await h.dispatcher.tick()
    expect(r.sent).toEqual(['m1'])
    expect(h.provider.messageCount()).toBe(1)
  })
})


describe('device events', () => {
  const evt = (e: Partial<SmsEvent> & { kind: SmsEvent['kind'] }): SmsEvent => ({ eventId: `e${Math.random()}`, providerMessageId: 'm1', at: new Date(NOONISO), ...e }) as SmsEvent
  const NOONISO = '2026-06-13T16:00:00Z'

  it('walks accepted -> sent -> delivered', async () => {
    const h = harness()
    await enqueue(h, 'm1', 'ready', 'Ready', 1)
    await h.dispatcher.tick()
    await h.dispatcher.handleEvent(evt({ kind: 'sent' }))
    expect(await h.outbox.get('m1')).toMatchObject({ state: 'sent' })
    await h.dispatcher.handleEvent(evt({ kind: 'delivered' }))
    expect(await h.outbox.get('m1')).toMatchObject({ state: 'delivered' })
  })

  it('tolerates out-of-order and repeated events', async () => {
    const h = harness()
    await enqueue(h, 'm1', 'ready', 'Ready', 1)
    await h.dispatcher.tick()
    await h.dispatcher.handleEvent(evt({ kind: 'delivered' }))
    const late = await h.dispatcher.handleEvent(evt({ kind: 'sent', at: new Date('2026-06-13T15:59:00Z') }))
    expect(late.detail).toBe('ignored_stale')
    expect(await h.outbox.get('m1')).toMatchObject({ state: 'delivered', sentAt: new Date('2026-06-13T15:59:00Z') })
    const failedAfter = await h.dispatcher.handleEvent(evt({ kind: 'failed', reason: 'Generic failure' }))
    expect(failedAfter.detail).toBe('ignored_stale')
    expect(await h.outbox.get('m1')).toMatchObject({ state: 'delivered' })
    expect((await h.dispatcher.handleEvent(evt({ kind: 'delivered' }))).detail).toBe('ignored_stale')
  })

  it('ignores events for messages it does not know', async () => {
    const h = harness()
    expect(await h.dispatcher.handleEvent(evt({ kind: 'delivered', providerMessageId: 'who' }))).toMatchObject({ handled: false, detail: 'ignored_unknown_message' })
  })

  it('retries a transient device failure once, under a new device id, after 2 minutes', async () => {
    const h = harness()
    await enqueue(h, 'a1b2c3d4-0000-4000-8000-000000000001', 'ready', 'Ready', 1)
    const id = 'a1b2c3d4-0000-4000-8000-000000000001'
    await h.dispatcher.tick()
    const r = await h.dispatcher.handleEvent(evt({ kind: 'failed', providerMessageId: id, reason: 'Radio off' }))
    expect(r.detail).toBe('requeued')
    const item = await h.outbox.get(id)
    expect(item).toMatchObject({ state: 'pending', deviceFailures: 1 })
    expect(item?.providerMessageId).toBe(retryProviderId(id, 1))
    expect(item?.providerMessageId?.length).toBeLessThanOrEqual(36)
    expect(item?.nextAttemptAt?.getTime()).toBe(h.clock.now().getTime() + 120_000)

    expect((await h.dispatcher.tick()).sent).toEqual([])
    h.clock.advance(120_000)
    expect((await h.dispatcher.tick()).sent).toEqual([retryProviderId(id, 1)])
    expect(h.provider.messageCount()).toBe(2)

    const second = await h.dispatcher.handleEvent(evt({ kind: 'failed', providerMessageId: retryProviderId(id, 1), reason: 'Radio off' }))
    expect(second.detail).toBe('updated')
    expect(await h.outbox.get(id)).toMatchObject({ state: 'failed', lastError: 'Radio off' })
  })

  it('does not retry a permanent device failure', async () => {
    const h = harness()
    await enqueue(h, 'm1', 'ready', 'Ready', 1)
    await h.dispatcher.tick()
    await h.dispatcher.handleEvent(evt({ kind: 'failed', reason: 'Invalid destination address' }))
    expect(await h.outbox.get('m1')).toMatchObject({ state: 'failed', deviceFailures: 0 })
  })

  it('a device-side cancel ends the message', async () => {
    const h = harness()
    await enqueue(h, 'm1', 'ready', 'Ready', 1)
    await h.dispatcher.tick()
    await h.dispatcher.handleEvent(evt({ kind: 'cancelled' }))
    expect(await h.outbox.get('m1')).toMatchObject({ state: 'cancelled' })
  })

  it('uses the device send time for the rate window', async () => {
    const h = harness()
    await enqueue(h, 'm1', 'ready', 'Ready', 1)
    await h.dispatcher.tick()
    await h.dispatcher.handleEvent(evt({ kind: 'sent', at: new Date(h.clock.now().getTime() + 5 * 60_000) }))
    const usage = await h.outbox.listUsage(new Date(h.clock.now().getTime() - 60_000))
    expect(usage[0]?.at.getTime()).toBe(h.clock.now().getTime() + 5 * 60_000)
  })

  it('the ingestor drops a duplicate envelope and replays a failed one', async () => {
    const h = harness()
    await enqueue(h, 'm1', 'ready', 'Ready', 1)
    await h.dispatcher.tick()
    const sent = evt({ kind: 'sent', eventId: 'env-1' })
    expect(await h.ingestor.ingest(sent)).toMatchObject({ outcome: 'handled' })
    expect(await h.ingestor.ingest(sent)).toEqual({ outcome: 'duplicate', eventId: 'env-1' })

    const rx = { kind: 'received', eventId: 'env-2', from: '+17865550151', body: 'hi', at: new Date(NOONISO), deviceId: DEVICE, providerMessageId: 'in-1' } as const
    expect(await h.ingestor.ingest(rx)).toEqual({ outcome: 'received', eventId: 'env-2' })
    expect(h.received).toHaveLength(1)

    const failing = harness()
    const ing = new SmsEventIngestor(failing.processed, failing.dispatcher, failing.clock, async () => {
      throw new Error('db down')
    })
    await expect(ing.ingest({ ...rx, eventId: 'env-3' })).rejects.toThrow('db down')
    // the envelope was released, so the device's retry is processed instead of being swallowed as a duplicate
    await expect(ing.ingest({ ...rx, eventId: 'env-3' })).rejects.toThrow('db down')
  })
})

describe('offline queue and flush', () => {
  it('goes offline after repeated failures, holds the queue, and flushes on recovery', async () => {
    const h = harness({ health: { failuresToOffline: 3 } })
    const transitions: string[] = []
    h.monitor.onTransition((e) => transitions.push(`${e.previous}->${e.state}`))

    await enqueue(h, 'a', 'ready', 'Ready', 1)
    await h.dispatcher.tick() // device is up, message accepted
    expect(transitions).toEqual(['unknown->online'])

    h.provider.setOutage('down')
    for (let i = 0; i < 3; i++) {
      await enqueue(h, `q${i}`, 'ready', 'Ready', 10 + i)
      await h.dispatcher.tick()
      h.clock.advance(60_000)
    }
    const held = await h.dispatcher.tick()
    expect(held.offline).toBe(true)
    expect(transitions).toContain('degraded->offline')
    expect(h.provider.messageCount()).toBe(1)

    // more work arrives while offline; nothing is attempted
    await enqueue(h, 'later', 'ready', 'Ready', 20)
    const stillOffline = await h.dispatcher.tick()
    expect(stillOffline.offline).toBe(true)
    expect(stillOffline.sent).toEqual([])

    // the tablet comes back: a ping webhook proves it, and the queue flushes
    h.provider.setOutage('off')
    await h.dispatcher.handleEvent({ kind: 'ping', eventId: 'p1', deviceId: DEVICE, at: h.clock.now() })
    await h.monitor.record(DEVICE, { kind: 'poll_ok', at: h.clock.now() })
    h.clock.advance(5 * 60_000)
    await h.monitor.record(DEVICE, { kind: 'poll_ok', at: h.clock.now() })
    const flushed = await h.dispatcher.tick()
    expect(flushed.offline).toBe(false)
    expect(flushed.sent.sort()).toEqual(['later', 'q0', 'q1', 'q2'])
    expect(transitions.at(-1)).toBe('offline->online')
  })

  it('reports lane-0 messages stranded while offline as e-mail fallback candidates', async () => {
    const h = harness({ health: { failuresToOffline: 1 } })
    await enqueue(h, 'invite', 'ready', 'Ready', 1)
    await enqueue(h, 'rem', 'reminder', 'Reminder', 2)
    h.provider.setOutage('down')
    await h.dispatcher.tick()
    h.clock.advance(6 * 60_000)
    const r = await h.dispatcher.tick()
    expect(r.offline).toBe(true)
    expect(r.p0FallbackCandidates).toEqual(['invite'])
  })

  it('messages that expire while the device is offline never go out afterwards', async () => {
    const h = harness({ health: { failuresToOffline: 1 } })
    h.provider.setOutage('down')
    await enqueue(h, 'welcome', 'welcome', 'Welcome', 1)
    await enqueue(h, 'ready', 'ready', 'Ready', 2)
    await h.dispatcher.tick()
    h.clock.advance(20 * 60_000)
    await h.dispatcher.tick()
    h.provider.setOutage('off')
    await h.monitor.record(DEVICE, { kind: 'poll_ok', at: h.clock.now() })
    const r = await h.dispatcher.tick()
    expect(r.sent).toEqual(['ready'])
    expect((await h.outbox.get('welcome'))?.state).toBe('expired')
  })
})

describe('reconciliation', () => {
  it('asks the device about messages accepted more than 5 minutes ago with no confirmation', async () => {
    const h = harness()
    await enqueue(h, 'm1', 'ready', 'Ready', 1)
    await enqueue(h, 'm2', 'ready', 'Ready', 2)
    await h.dispatcher.tick()
    h.provider.deliver('m1') // the webhook for this never reached us
    h.clock.advance(4 * 60_000)
    expect(await h.dispatcher.reconcile()).toMatchObject({ checked: 0 })
    h.clock.advance(2 * 60_000)
    const r = await h.dispatcher.reconcile()
    expect(r).toMatchObject({ checked: 2, updated: 1 })
    expect(await h.outbox.get('m1')).toMatchObject({ state: 'delivered' })
    expect(await h.outbox.get('m2')).toMatchObject({ state: 'accepted' })
    // not asked again within the minimum gap
    expect((await h.dispatcher.reconcile()).checked).toBe(0)
  })

  it('moves accepted to sent when the device says Sent', async () => {
    const h = harness()
    await enqueue(h, 'm1', 'ready', 'Ready', 1)
    await h.dispatcher.tick()
    h.provider.markSent('m1')
    h.clock.advance(6 * 60_000)
    await h.dispatcher.reconcile()
    expect(await h.outbox.get('m1')).toMatchObject({ state: 'sent' })
  })

  it('a message the device has never heard of is safe to send again, once', async () => {
    const h = harness()
    await enqueue(h, 'm1', 'ready', 'Ready', 1)
    await h.dispatcher.tick()
    // the app was reinstalled and lost its database
    h.provider.wipeDevice()
    h.clock.advance(6 * 60_000)
    expect(await h.dispatcher.reconcile()).toMatchObject({ resent: 1 })
    expect(await h.outbox.get('m1')).toMatchObject({ state: 'pending', reconcileResends: 1 })
    expect((await h.dispatcher.tick()).sent).toEqual(['m1'])
    expect(h.provider.messageCount()).toBe(1)

    h.provider.wipeDevice()
    h.clock.advance(6 * 60_000)
    await h.dispatcher.reconcile()
    expect(await h.outbox.get('m1')).toMatchObject({ state: 'failed', lastError: 'device lost the message' })
  })

  it('turns a device-reported Failed into the normal failure handling', async () => {
    const h = harness()
    await enqueue(h, 'm1', 'ready', 'Ready', 1)
    await h.dispatcher.tick()
    h.provider.fail('m1', 'Invalid destination address')
    h.clock.advance(6 * 60_000)
    await h.dispatcher.reconcile()
    expect(await h.outbox.get('m1')).toMatchObject({ state: 'failed' })
  })

  it('stops after a provider error without marking anything failed', async () => {
    const h = harness()
    await enqueue(h, 'm1', 'ready', 'Ready', 1)
    await h.dispatcher.tick()
    h.clock.advance(6 * 60_000)
    h.provider.setOutage('down')
    expect(await h.dispatcher.reconcile()).toMatchObject({ errors: 1, updated: 0 })
    expect((await h.outbox.get('m1'))?.state).toBe('accepted')
  })

  it('leaves very old unconfirmed messages alone', async () => {
    const h = harness()
    await enqueue(h, 'm1', 'ready', 'Ready', 1)
    await h.dispatcher.tick()
    h.clock.advance(7 * 3600_000)
    expect((await h.dispatcher.reconcile()).checked).toBe(0)
  })
})
