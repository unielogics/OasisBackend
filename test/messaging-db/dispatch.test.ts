// The dispatcher on Postgres: pacing and lanes, quiet hours, device outages, expiry, retries, and two dispatchers at once.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { SmsProviderError } from '../../src/integrations/sms/errors.js'
import type { SmsProvider } from '../../src/integrations/ports/sms.js'
import { Dispatcher } from '../../src/modules/messaging/dispatch/dispatcher.js'
import { DeviceHealthMonitor } from '../../src/modules/messaging/dispatch/health.js'
import { PgDeviceRepository } from '../../src/modules/messaging/db/device-repo.js'
import { PgOutboxRepository } from '../../src/modules/messaging/db/outbox-repo.js'
import { jobDefinitions } from '../../src/platform/job-registry.js'
import { runDispatchWindow } from '../../src/modules/messaging/jobs/index.js'
import { useWorld } from './world.js'

const w = useWorld()
let k = 0

type Tpl = { templateKey: string; vars?: Record<string, string | number> }
const queue = (t: Tpl, customer = 'Maria Delgado') =>
  w.tx((tx) => w.rt.queue.enqueue(tx, { customerId: w.customer(customer).id, appointmentId: null, purpose: 'test', ...t }))

const queueRaw = (klass: 'emergency' | 'staff_message' | 'ready', text: string, customer = 'Maria Delgado') =>
  w.tx((tx) =>
    w.rt.queue.enqueueFor(tx, {
      locationId: w.locationId,
      customerId: w.customer(customer).id,
      recipient: { kind: 'customer', phone: w.customer(customer).phone, smsOptIn: true, activeOptOut: false, synthetic: false },
      appointmentId: null,
      text,
      klass,
      purpose: 'test',
      senderKind: 'system',
      dedupeKey: `k-${++k}`,
    }),
  )

const states = async (): Promise<Record<string, number>> => {
  const rows = await w.t.db.selectFrom('sms_outbox').select(['state']).execute()
  const out: Record<string, number> = {}
  for (const r of rows) out[r.state] = (out[r.state] ?? 0) + 1
  return out
}

/** Heartbeats the device so the silence-based health rules stay out of the way. */
const online = async (): Promise<void> => void (await w.rt.pollHealthAll())

describe('quiet hours', () => {
  it('hold only the non-transactional classes; the held ones go out when the window ends', async () => {
    w.clock.set('2026-06-12T22:00:00-04:00')
    await online()
    const reminder = await queue({ templateKey: 'reminder', vars: { when: 'tomorrow', time: '9:00 AM' } })
    const confirmReq = await queue({ templateKey: 'confirm_request', vars: { time: '9:00 AM' } })
    const ready = await queue({ templateKey: 'ready' })
    const receipt = await queue({ templateKey: 'receipt' })
    const welcome = await queue({ templateKey: 'welcome', vars: { bay: 1 } })

    const rows = await w.t.db.selectFrom('sms_outbox').select(['id', 'hold_until', 'next_attempt_at']).execute()
    const held = new Set(rows.filter((r) => r.hold_until !== null).map((r) => r.id))
    expect(held).toEqual(new Set([reminder.messageId, confirmReq.messageId]))
    expect([...held].every((id) => rows.find((r) => r.id === id)!.hold_until!.toISOString() === '2026-06-13T12:00:00.000Z')).toBe(true) // 8:00 AM EDT

    const [t1] = await w.tick()
    expect(new Set(t1!.report.sent)).toEqual(new Set([ready.messageId, receipt.messageId, welcome.messageId]))
    expect(await states()).toEqual({ accepted: 3, pending: 2 })

    // still quiet at 07:59, released at 08:00
    w.clock.set('2026-06-13T07:59:00-04:00')
    await online()
    expect((await w.tick())[0]!.report.sent).toEqual([])
    w.clock.set('2026-06-13T08:00:30-04:00')
    await online()
    const [t2] = await w.tick()
    expect(new Set(t2!.report.sent)).toEqual(new Set([reminder.messageId, confirmReq.messageId]))
  })

  it('the TTL clock of a held reminder starts at the release, not at queueing', async () => {
    w.clock.set('2026-06-12T22:00:00-04:00')
    const r = await queue({ templateKey: 'reminder', vars: { when: 'tomorrow', time: '9:00 AM' } })
    const row = await w.t.db.selectFrom('sms_outbox').select('ttl_at').where('id', '=', r.messageId!).executeTakeFirstOrThrow()
    expect(row.ttl_at.toISOString()).toBe('2026-06-13T14:00:00.000Z') // 08:00 EDT + 2 h
  })
})

describe('lanes under an emergency blast', () => {
  it('keeps the reserved part of the window for lane 0 so a ready-for-pickup text is never starved', async () => {
    await online()
    for (let i = 0; i < 40; i++) await queueRaw('emergency', `Storm closure notice ${i}`)
    // 40 bulk texts against 30 per 30 minutes with 6 reserved: the blast may spend 24
    let sent = 0
    for (let i = 0; i < 4; i++) sent += (await w.tick())[0]!.report.sent.length
    expect(sent).toBe(24)
    const [stalled] = await w.tick()
    expect(stalled!.report.rateLimited).toBe(true)
    expect(stalled!.report.sent).toEqual([])
    expect(await states()).toEqual({ accepted: 24, pending: 16 })

    const ready = await queueRaw('ready', 'Your vehicle is ready for pickup!', 'David Okafor')
    const [t] = await w.tick()
    expect(t!.report.sent).toEqual([ready.queued ? ready.messageId : ''])

    // the window slides: 30 minutes later the blast resumes
    w.clock.advance(31 * 60_000)
    await online()
    let more = 0
    for (let i = 0; i < 4; i++) more += (await w.tick())[0]!.report.sent.length
    expect(more).toBe(16)
  })

  it('the device status endpoint data reports the window and the lane budget', async () => {
    await online()
    for (let i = 0; i < 5; i++) await queueRaw('emergency', `Notice ${i}`)
    await w.tick()
    const { dispatcher } = w.rt.dispatcherFor(await w.device())
    const s = await dispatcher.status()
    expect(s.budget).toMatchObject({ used: 5, max: 30, reservedForP0: 6, remainingP0: 25, remainingOthers: 19 })
    expect(s.state).toBe('idle')
  })
})

describe('device outage', () => {
  it('queues while offline, flushes when back, and drops what outlived its class TTL (a welcome is worth 15 minutes)', async () => {
    const sim = await w.sim()
    await online()
    sim.setOutage('down')
    for (let i = 0; i < 3; i++) await w.rt.pollHealthAll()
    expect((await w.device()).status).toBe('offline')

    const welcome = await queue({ templateKey: 'welcome', vars: { bay: 2 } })
    const thanks = await queue({ templateKey: 'booking_thanks', vars: { first: 'Maria' } }, 'David Okafor')
    const [held] = await w.tick()
    expect(held!.report.offline).toBe(true)
    expect(held!.report.sent).toEqual([])
    expect(await states()).toEqual({ pending: 2 })

    w.clock.advance(16 * 60_000)
    sim.setOutage('off')
    await w.rt.pollHealthAll()
    expect((await w.device()).status).toBe('online')
    const [t] = await w.tick()
    expect(t!.report.expired).toEqual([welcome.messageId])
    expect(t!.report.sent).toEqual([thanks.messageId])
    const byId = Object.fromEntries((await w.t.db.selectFrom('messages').select(['id', 'status', 'error']).execute()).map((m) => [m.id, m]))
    expect(byId[welcome.messageId!]).toMatchObject({ status: 'expired', error: 'expired before it could be sent' })
    expect(byId[thanks.messageId!]!.status).toBe('sent')
  })

  it('retries a transient error with backoff and marks the text failed after the attempt limit', async () => {
    await online()
    const sim = await w.sim()
    const q = await queue({ templateKey: 'booking_thanks', vars: { first: 'Maria' } })
    for (let attempt = 1; attempt <= 6; attempt++) {
      sim.setOutage('error5xx')
      const [t] = await w.tick()
      expect(t!.report.sent).toEqual([])
      const row = await w.t.db.selectFrom('sms_outbox').select(['state', 'attempts', 'next_attempt_at']).where('id', '=', q.messageId!).executeTakeFirstOrThrow()
      expect(row.attempts).toBe(attempt)
      if (attempt < 6) {
        expect(row.state).toBe('pending')
        expect(row.next_attempt_at!.getTime()).toBeGreaterThan(w.clock.now().getTime())
      } else expect(row.state).toBe('failed')
      // a healthy poll between attempts keeps the device from being declared offline
      sim.setOutage('off')
      w.clock.advance(16 * 60_000)
      await online()
    }
    const m = await w.t.db.selectFrom('messages').select(['status', 'error']).where('id', '=', q.messageId!).executeTakeFirstOrThrow()
    expect(m.status).toBe('failed')
    expect(m.error).toContain('device error 503')
    // staff see it in the failed list; retry gives it a fresh attempt
    const { dispatcher } = w.rt.dispatcherFor(await w.device())
    expect(await dispatcher.retryFailed(q.messageId!)).toBe(true)
    expect((await w.tick())[0]!.report.sent).toEqual([q.messageId])
  })

  it('three failed sends in a row make the device offline: the queue then holds instead of hammering it', async () => {
    await online()
    const sim = await w.sim()
    sim.setOutage('error5xx')
    const q = await queue({ templateKey: 'booking_thanks', vars: { first: 'Maria' } })
    for (let i = 0; i < 3; i++) {
      await w.tick()
      w.clock.advance(16 * 60_000)
      await w.rt.pollHealthAll().catch(() => undefined)
    }
    expect((await w.device()).status).toBe('offline')
    const [t] = await w.tick()
    expect(t!.report.offline).toBe(true)
    const row = await w.t.db.selectFrom('sms_outbox').select(['state', 'attempts']).where('id', '=', q.messageId!).executeTakeFirstOrThrow()
    expect(row).toMatchObject({ state: 'pending' })
    expect(row.attempts).toBeLessThanOrEqual(3)
  })

  it('a rejected number fails at once without retries, and the failure is listed in the outbox for staff', async () => {
    await online()
    const sim = await w.sim()
    sim.device.enqueue = () => ({ status: 400, body: { message: 'Invalid phone number' } })
    const q = await queue({ templateKey: 'booking_thanks', vars: { first: 'Maria' } })
    await w.tick()
    expect((await w.t.db.selectFrom('sms_outbox').select(['state', 'attempts']).where('id', '=', q.messageId!).executeTakeFirstOrThrow())).toMatchObject({ state: 'failed' })
  })

  it('a device-reported failure with a transient reason is retried once under a new device id (r1), then succeeds', async () => {
    await online()
    const sim = await w.sim()
    const q = await queue({ templateKey: 'booking_thanks', vars: { first: 'Maria' } })
    await w.tick()
    sim.fail(q.messageId!, 'Radio off')
    await w.settle()
    const row = await w.t.db.selectFrom('sms_outbox').select(['state', 'device_failures', 'provider_message_id']).executeTakeFirstOrThrow()
    expect(row.state).toBe('pending')
    expect(row.device_failures).toBe(1)
    expect(row.provider_message_id).toBe(`${q.messageId!.replace(/-/g, '')}r1`)
    expect(row.provider_message_id!.length).toBeLessThanOrEqual(36)
    expect((await w.messagesOf('Maria Delgado'))[0]!.status).toBe('queued')
    w.clock.advance(3 * 60_000)
    await online()
    const [t] = await w.tick()
    expect(t!.report.sent).toEqual([row.provider_message_id])
    sim.deliver(row.provider_message_id!)
    await w.settle()
    expect((await w.messagesOf('Maria Delgado'))[0]!.status).toBe('delivered')
  })

  it('a device failure with a permanent reason is final and lists the text as failed', async () => {
    await online()
    const sim = await w.sim()
    const q = await queue({ templateKey: 'booking_thanks', vars: { first: 'Maria' } })
    await w.tick()
    sim.fail(q.messageId!, 'Invalid destination address')
    await w.settle()
    expect(await w.t.db.selectFrom('sms_outbox').select(['state', 'last_error']).executeTakeFirstOrThrow()).toEqual({ state: 'failed', last_error: 'Invalid destination address' })
    expect((await w.messagesOf('Maria Delgado'))[0]).toMatchObject({ status: 'failed', error: 'Invalid destination address' })
  })

  it('reconcile asks the device about texts whose receipts never came and resends one the device lost', async () => {
    await online()
    const sim = await w.sim()
    const q = await queue({ templateKey: 'booking_thanks', vars: { first: 'Maria' } })
    await w.tick()
    sim.wipeDevice()
    w.clock.advance(6 * 60_000)
    await online()
    const [r] = await w.rt.reconcileAll()
    expect(r).toMatchObject({ checked: 1, resent: 1 })
    expect((await w.t.db.selectFrom('sms_outbox').select(['state', 'reconcile_resends']).where('id', '=', q.messageId!).executeTakeFirstOrThrow())).toEqual({ state: 'pending', reconcile_resends: 1 })
    const [t] = await w.tick()
    expect(t!.report.sent).toEqual([q.messageId])
  })
})

describe('two dispatchers', () => {
  function counting(): { provider: SmsProvider; sends: string[] } {
    const sends: string[] = []
    const provider: SmsProvider = {
      async send(req) {
        sends.push(req.id)
        await new Promise((r) => setTimeout(r, 10))
        return { providerMessageId: req.id, state: 'Pending' }
      },
      status: async () => null,
      health: async () => ({ ok: true }),
      registerWebhooks: async () => undefined,
      verifyAndParseWebhook: () => {
        throw new SmsProviderError('protocol', 'unused')
      },
    }
    return { provider, sends }
  }

  it('claim is atomic: concurrent claims of one message produce exactly one winner', async () => {
    const q = await queue({ templateKey: 'booking_thanks', vars: { first: 'Maria' } })
    const device = await w.device()
    const claims = await Promise.all(
      Array.from({ length: 12 }, () => new PgOutboxRepository(w.t.db, { deviceId: device.id }).claim(q.messageId!, w.clock.now())),
    )
    expect(claims.filter((c) => c !== null)).toHaveLength(1)
  })

  it('two dispatchers draining the same outbox send every message exactly once', async () => {
    const device = await w.device()
    await online()
    const ids: string[] = []
    for (let i = 0; i < 12; i++) ids.push((await queue({ templateKey: 'booking_thanks', vars: { first: 'Maria' } }, i % 2 ? 'Maria Delgado' : 'David Okafor')).messageId!)
    const { provider, sends } = counting()
    const mk = (): Dispatcher => {
      const cfg = w.rt.config.dispatch({ id: device.id, simSlotDefault: null, minIntervalMs: 0, maxPerWindow: null, windowMinutes: null })
      const monitor = new DeviceHealthMonitor(new PgDeviceRepository(w.t.db), w.clock, cfg.health)
      return new Dispatcher(provider, new PgOutboxRepository(w.t.db, { deviceId: device.id }), monitor, w.clock, { ...cfg.dispatcher, maxPerTick: 100 })
    }
    const [a, b] = await Promise.all([mk().tick(), mk().tick()])
    expect([...sends].sort()).toEqual([...ids].sort())
    expect(a.sent.length + b.sent.length).toBe(12)
    expect(await states()).toEqual({ accepted: 12 })
  })

  it('concurrent sent and delivered envelopes for one message never regress it', async () => {
    const q = await queue({ templateKey: 'booking_thanks', vars: { first: 'Maria' } })
    await w.tick()
    const at = w.clock.now().toISOString()
    const base = { messageId: q.messageId, sender: '+15555550100', recipient: w.customer('Maria Delgado').phone, simNumber: 1 }
    const events = [
      w.signed('sms:sent', { ...base, sentAt: at }),
      w.signed('sms:delivered', { ...base, deliveredAt: at }),
      w.signed('sms:sent', { ...base, sentAt: at }),
      w.signed('sms:delivered', { ...base, deliveredAt: at }),
    ]
    await Promise.all(events.map((e) => w.rt.webhooks.receive(SIM_DEVICE_KEY, e.headers, e.body)))
    await w.settle()
    expect(await states()).toEqual({ delivered: 1 })
    expect((await w.messagesOf('Maria Delgado'))[0]!.status).toBe('delivered')
  })

  it('a leader lock keeps a second runner out', async () => {
    const inside: boolean[] = []
    const first = w.rt.withLeader('test.lock', async () => {
      inside.push((await w.rt.withLeader('test.lock', async () => true)) === true)
      return 'leader'
    })
    expect(await first).toBe('leader')
    expect(inside).toEqual([false])
    expect(await w.rt.withLeader('test.lock', async () => 'again')).toBe('again')
    await sql`select 1`.execute(w.t.db)
  })
})

describe('jobs', () => {
  it('the sms.dispatch window ticks repeatedly under the leader lock and drains what is queued meanwhile', async () => {
    await online()
    const first = await queue({ templateKey: 'booking_thanks', vars: { first: 'Maria' } })
    const window = runDispatchWindow(w.rt, { windowMs: 1200, intervalMs: 100 })
    await new Promise((r) => setTimeout(r, 300))
    const second = await queue({ templateKey: 'booking_thanks', vars: { first: 'David' } }, 'David Okafor')
    const r = await window
    expect(r.leader).toBe(true)
    expect(r.ticks).toBeGreaterThanOrEqual(3)
    expect(new Set((await w.t.db.selectFrom('sms_outbox').select(['id', 'state']).execute()).filter((o) => o.state === 'accepted').map((o) => o.id))).toEqual(new Set([first.messageId, second.messageId]))
  })

  it('a second runner does nothing while the first holds the lock', async () => {
    const outer = await w.rt.withLeader('sms.dispatch', async () => runDispatchWindow(w.rt, { windowMs: 200, intervalMs: 50 }))
    expect(outer).toEqual({ ticks: 0, leader: false })
  })

  it('the job registry carries the messaging jobs on their schedules', () => {
    const byName = Object.fromEntries(jobDefinitions.map((j) => [j.name, j]))
    expect(byName['sms.dispatch']).toMatchObject({ cron: '* * * * *', policy: 'singleton' })
    expect(byName['sms.reconcile']).toMatchObject({ cron: '*/2 * * * *' })
    expect(byName['sms.device.healthcheck']).toMatchObject({ cron: '* * * * *' })
    expect(byName['sms.webhooks.register']).toMatchObject({ cron: '7 * * * *' })
    expect(byName['email.send']).toMatchObject({ cron: '* * * * *' })
  })
})
