// The full SMS loop on Postgres with the in-process SMS Gate simulator: queued in the caller's transaction, dispatched,
// confirmed by signed webhooks, visible on the thread.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { useWorld } from './world.js'

const w = useWorld()

async function queueThanks(first = 'Maria', customer = 'Maria Delgado', appointmentId: string | null = null) {
  return w.tx((tx) =>
    w.rt.queue.enqueue(tx, { customerId: w.customer(customer).id, appointmentId, templateKey: 'booking_thanks', vars: { first }, purpose: 'booking' }),
  )
}

describe('outbound loop', () => {
  it('queues in the caller transaction, dispatches, and follows the device receipts to delivered', async () => {
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    const q = await queueThanks('Maria', 'Maria Delgado', appt)
    expect(q.queued).toBe(true)
    const id = q.messageId!

    const queued = await w.t.db.selectFrom('messages').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
    expect(queued).toMatchObject({ status: 'queued', direction: 'out', sender_kind: 'system', template_key: 'booking_thanks', appointment_id: appt, klass: 'booking_thanks' })
    expect(queued.body).toBe('Hi Maria, thanks for booking with Oasis Auto Spa. Reply STOP to opt out.')
    const box = await w.t.db.selectFrom('sms_outbox').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
    expect(box).toMatchObject({ state: 'pending', priority: 1, segments: 1, to_e164: w.customer('Maria Delgado').phone })
    expect(await w.t.db.selectFrom('message_threads').select('unread_count').executeTakeFirstOrThrow()).toEqual({ unread_count: 0 })

    const [tick] = await w.tick()
    expect(tick!.report.sent).toEqual([id])
    expect((await w.messagesOf('Maria Delgado'))[0]!.status).toBe('sent')
    expect(await w.t.db.selectFrom('sms_usage').select(['provider_message_id', 'segments']).execute()).toEqual([{ provider_message_id: id, segments: 1 }])

    const sim = await w.sim()
    expect(sim.markSent(id)).toBe(true)
    await w.settle()
    expect(await w.t.db.selectFrom('sms_outbox').select('state').where('id', '=', id).executeTakeFirstOrThrow()).toEqual({ state: 'sent' })

    expect(sim.deliver(id)).toBe(true)
    await w.settle()
    const done = await w.t.db.selectFrom('messages').select(['status', 'delivered_at', 'provider_message_id']).where('id', '=', id).executeTakeFirstOrThrow()
    expect(done.status).toBe('delivered')
    expect(done.delivered_at).not.toBeNull()
    expect(done.provider_message_id).toBe(id)
    const dev = await w.device()
    expect(dev).toMatchObject({ sent_count: 1, delivered_count: 1, remote_device_id: 'simDevice000000001' })

    // every envelope is kept and marked applied
    const log = await w.t.db.selectFrom('webhook_log').select(['status', 'signature_valid', 'provider']).execute()
    expect(log.length).toBeGreaterThanOrEqual(2)
    expect(log.every((l) => l.status === 'processed' && l.signature_valid && l.provider === 'smsgate')).toBe(true)
  })

  it('publishes message.out on enqueue and message.status on every transition', async () => {
    const q = await queueThanks()
    await w.tick()
    const sim = await w.sim()
    sim.deliver(q.messageId!)
    await w.settle()
    const events = await w.t.db.selectFrom('realtime_events').select(['channel', 'type', 'payload']).where('channel', '=', 'messages').orderBy('id').execute()
    expect(events[0]).toMatchObject({ type: 'message.out' })
    expect(events[0]!.payload).toMatchObject({ id: q.messageId, direction: 'out', status: 'queued', text: expect.stringContaining('Hi Maria') })
    const statuses = events.filter((e) => e.type === 'message.status').map((e) => (e.payload as { status: string }).status)
    expect(statuses).toEqual(['sending', 'sent', 'delivered'])
  })

  it('a rolled-back caller transaction takes its text with it', async () => {
    await expect(
      w.tx(async (tx) => {
        await w.rt.queue.enqueue(tx, { customerId: w.customer('Maria Delgado').id, appointmentId: null, templateKey: 'booking_thanks', vars: { first: 'Maria' }, purpose: 'booking' })
        throw new Error('booking failed')
      }),
    ).rejects.toThrow('booking failed')
    expect(await w.t.db.selectFrom('messages').select('id').execute()).toEqual([])
    expect(await w.t.db.selectFrom('sms_outbox').select('id').execute()).toEqual([])
  })

  it('a duplicate dedupe key returns the first message', async () => {
    const send = () =>
      w.tx((tx) => w.rt.queue.enqueue(tx, { customerId: w.customer('Maria Delgado').id, appointmentId: null, templateKey: 'booking_thanks', vars: { first: 'Maria' }, purpose: 'booking', dedupeKey: 'booking:1' }))
    const a = await send()
    const b = await send()
    expect(b.messageId).toBe(a.messageId)
    expect(await w.t.db.selectFrom('messages').select('id').execute()).toHaveLength(1)
  })

  it('counts segments after GSM-7 normalisation and strips the star of the review text', async () => {
    const q = await w.tx((tx) => w.rt.queue.enqueue(tx, { customerId: w.customer('Maria Delgado').id, appointmentId: null, templateKey: 'review', purpose: 'review' }))
    const row = await w.t.db.selectFrom('messages').select(['body', 'segments', 'encoding']).where('id', '=', q.messageId!).executeTakeFirstOrThrow()
    expect(row.encoding).toBe('GSM-7')
    expect(row.body).not.toContain('⭐')
    expect(row.segments).toBe(1)
  })

  it('marks a text the policy refuses as skipped with the reason and writes nothing', async () => {
    await sql`update customers set sms_opted_in = false where id = ${w.customer('Maria Delgado').id}`.execute(w.t.db)
    const q = await queueThanks()
    expect(q).toEqual({ queued: false, messageId: null, skipped: 'not_opted_in' })
    expect(await w.t.db.selectFrom('messages').select('id').execute()).toEqual([])
  })
})
