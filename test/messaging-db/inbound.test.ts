// Inbound texts through the real webhook path: signed delivery -> webhook_log -> one transaction that records the text,
// routes it (opt-out tables, the scheduling confirm command, staff alerts) and queues the replies.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { STRANGER, useWorld } from './world.js'

const w = useWorld()
let n = 0

async function inbound(from: string, text: string, o: { id?: string; messageId?: string } = {}) {
  n += 1
  const ev = w.signed(
    'sms:received',
    { messageId: o.messageId ?? `in-${n}`, sender: from, recipient: '+15555550100', simNumber: 1, message: text, receivedAt: w.clock.now().toISOString() },
    { id: o.id },
  )
  const res = await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
  await w.settle()
  return res
}

const maria = (): string => w.customer('Maria Delgado').phone
const count = async (table: 'customers' | 'messages' | 'sms_inbox' | 'sms_opt_outs'): Promise<number> =>
  Number((await w.t.db.selectFrom(table).select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n)

describe('a customer replies', () => {
  it('lands in the thread of the most relevant appointment, unread, with an alert and an SSE event', async () => {
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    const res = await inbound(maria(), 'Can I come 15 minutes late?')
    expect(res).toEqual({ status: 200, body: { ok: true, status: 'accepted' } })

    const [m] = await w.messagesOf('Maria Delgado')
    expect(m).toMatchObject({ direction: 'in', status: 'received', appointment_id: appt, body: 'Can I come 15 minutes late?' })
    const thread = await w.t.db.selectFrom('message_threads').select(['unread_count', 'last_inbound_at']).executeTakeFirstOrThrow()
    expect(thread.unread_count).toBe(1)
    expect(thread.last_inbound_at).not.toBeNull()
    const ev = await w.t.db.selectFrom('realtime_events').select(['type', 'payload']).where('type', '=', 'message.in').executeTakeFirstOrThrow()
    expect(ev.payload).toMatchObject({ direction: 'in', from: 'customer', text: 'Can I come 15 minutes late?', appointmentId: appt })
    const log = await w.t.db.selectFrom('activity_log').select(['text', 'actor_type']).where('appointment_id', '=', appt).execute()
    expect(log).toContainEqual({ text: 'Customer replied by SMS', actor_type: 'customer' })
    expect(await w.t.db.selectFrom('sms_inbox').select(['decision', 'quarantined', 'customer_id', 'appointment_id']).executeTakeFirstOrThrow()).toEqual({
      decision: 'message',
      quarantined: false,
      customer_id: w.customer('Maria Delgado').id,
      appointment_id: appt,
    })
    expect(await w.rt.webhooks.sweep()).toEqual({ processed: 0, abandoned: 0 })
  })

  it('with no open appointment the reply is still filed and a manager is notified', async () => {
    await inbound(maria(), 'Do you do ceramic coating?')
    const [m] = await w.messagesOf('Maria Delgado')
    expect(m).toMatchObject({ direction: 'in', appointment_id: null })
    const notes = await w.t.db.selectFrom('notifications').select(['kind', 'title', 'body']).execute()
    expect(notes.length).toBeGreaterThan(0)
    expect(notes.every((x) => x.kind === 'sms.unattributed_reply' && x.title.includes('Maria Delgado'))).toBe(true)
  })

  it('CANCEL is a staff alert, never an opt-out', async () => {
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    await inbound(maria(), 'cancel')
    expect(await count('sms_opt_outs')).toBe(0)
    expect((await w.messagesOf('Maria Delgado'))[0]).toMatchObject({ direction: 'in', appointment_id: appt })
    const notes = await w.t.db.selectFrom('notifications').select(['kind', 'entity_id']).execute()
    expect(notes.length).toBeGreaterThan(0)
    expect(notes.every((x) => x.kind === 'sms.cancel_request' && x.entity_id === appt)).toBe(true)
  })
})

describe('keywords', () => {
  it('STOP opts the number out, confirms once, and every later text is suppressed, emergencies included', async () => {
    await inbound(maria(), 'STOP')
    expect(await w.t.db.selectFrom('sms_opt_outs').select(['phone_e164', 'source', 'keyword', 'opted_in_again_at']).execute()).toEqual([
      { phone_e164: maria(), source: 'keyword', keyword: 'STOP', opted_in_again_at: null },
    ])
    const c = await w.t.db.selectFrom('customers').select('sms_opted_out_at').where('id', '=', w.customer('Maria Delgado').id).executeTakeFirstOrThrow()
    expect(c.sms_opted_out_at).not.toBeNull()

    const msgs = await w.messagesOf('Maria Delgado')
    expect(msgs.map((m) => [m.direction, m.template_key])).toEqual([['in', null], ['out', 'opt_out_confirm']])

    // the confirmation is the one text a stopped number may still get
    const [tick] = await w.tick()
    expect(tick!.report.sent).toHaveLength(1)

    const thanks = await w.tx((tx) => w.rt.queue.enqueue(tx, { customerId: w.customer('Maria Delgado').id, appointmentId: null, templateKey: 'booking_thanks', vars: { first: 'Maria' }, purpose: 'booking' }))
    expect(thanks).toEqual({ queued: false, messageId: null, skipped: 'opted_out' })
    const blast = await w.tx((tx) =>
      w.rt.queue.enqueueFor(tx, {
        locationId: w.locationId,
        customerId: w.customer('Maria Delgado').id,
        recipient: { kind: 'customer', phone: maria(), smsOptIn: true, activeOptOut: true, synthetic: false },
        appointmentId: null,
        text: 'Storm closure',
        klass: 'emergency',
        purpose: 'emergency',
        senderKind: 'system',
      }),
    )
    expect(blast).toMatchObject({ queued: false, skipped: 'opted_out' })
  })

  it('a second STOP does not confirm again; START opts back in and later texts flow', async () => {
    await inbound(maria(), 'STOP')
    await inbound(maria(), 'Stop.')
    expect((await w.messagesOf('Maria Delgado')).filter((m) => m.template_key === 'opt_out_confirm')).toHaveLength(1)
    expect(await count('sms_opt_outs')).toBe(1)

    await inbound(maria(), 'START')
    expect(await w.t.db.selectFrom('sms_opt_outs').select('opted_in_again_at').executeTakeFirstOrThrow()).not.toEqual({ opted_in_again_at: null })
    const c = await w.t.db.selectFrom('customers').select(['sms_opted_out_at', 'sms_opted_in', 'sms_opt_in_source']).where('id', '=', w.customer('Maria Delgado').id).executeTakeFirstOrThrow()
    expect(c).toEqual({ sms_opted_out_at: null, sms_opted_in: true, sms_opt_in_source: 'keyword' })
    const thanks = await w.tx((tx) => w.rt.queue.enqueue(tx, { customerId: w.customer('Maria Delgado').id, appointmentId: null, templateKey: 'booking_thanks', vars: { first: 'Maria' }, purpose: 'booking' }))
    expect(thanks.queued).toBe(true)
  })

  it('HELP is answered with the HELP text', async () => {
    await inbound(maria(), 'help')
    const out = (await w.messagesOf('Maria Delgado')).find((m) => m.direction === 'out')!
    expect(out.template_key).toBe('help_reply')
    expect(out.body).toContain('Reply STOP to opt out')
  })

  it('C confirms the next unconfirmed appointment through the scheduling command and sends ONE reply', async () => {
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    await inbound(maria(), 'C')
    const a = await w.t.db.selectFrom('appointments').select(['status', 'version']).where('id', '=', appt).executeTakeFirstOrThrow()
    expect(a.status).toBe('confirmed')
    expect(a.version).toBe(2)
    const outs = (await w.messagesOf('Maria Delgado')).filter((m) => m.direction === 'out')
    expect(outs.map((m) => m.template_key)).toEqual(['confirm_ack'])
    expect(outs[0]!.appointment_id).toBe(appt)
    expect(outs[0]!.body).toMatch(/confirmed for 2:00 PM/)
    const log = await w.t.db.selectFrom('activity_log').select(['text', 'actor_type']).where('appointment_id', '=', appt).orderBy('id').execute()
    expect(log.map((l) => l.text)).toEqual(expect.arrayContaining(['Confirmed by customer reply (C)']))
    const ev = await w.t.db.selectFrom('realtime_events').select('payload').where('type', '=', 'appointment.updated').executeTakeFirstOrThrow()
    expect(ev.payload).toMatchObject({ id: appt, status: 'confirmed' })
  })

  it('C with nothing waiting says so and tells staff', async () => {
    await inbound(maria(), 'confirm')
    const out = (await w.messagesOf('Maria Delgado')).find((m) => m.direction === 'out')!
    expect(out.template_key).toBe('confirm_none')
  })

  it('C for an appointment staff already confirmed does not fail the webhook', async () => {
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00', status: 'confirmed' })
    const res = await inbound(maria(), 'C')
    expect(res.status).toBe(200)
    expect((await w.t.db.selectFrom('appointments').select('status').where('id', '=', appt).executeTakeFirstOrThrow()).status).toBe('confirmed')
    expect((await w.t.db.selectFrom('webhook_log').select('status').executeTakeFirstOrThrow()).status).toBe('processed')
  })
})

describe('unknown senders are quarantined', () => {
  it('creates no customer row, keeps the text in sms_inbox, and still honours a stranger\'s STOP by number', async () => {
    const before = await count('customers')
    await inbound(STRANGER, 'Your verification code is 123456')
    expect(await count('customers')).toBe(before)
    expect(await count('messages')).toBe(0)
    expect(await w.t.db.selectFrom('sms_inbox').select(['from_e164', 'quarantined', 'decision', 'customer_id', 'message_id']).executeTakeFirstOrThrow()).toEqual({
      from_e164: STRANGER,
      quarantined: true,
      decision: 'quarantined',
      customer_id: null,
      message_id: null,
    })

    await inbound(STRANGER, 'STOP')
    expect(await count('customers')).toBe(before)
    expect(await w.t.db.selectFrom('sms_opt_outs').select(['phone_e164', 'source']).execute()).toEqual([{ phone_e164: STRANGER, source: 'keyword' }])
    // the one confirmation to the stranger exists as a bare-number message (no customer, no thread)
    const reply = await w.t.db.selectFrom('messages').select(['customer_id', 'thread_id', 'template_key', 'peer_e164']).executeTakeFirstOrThrow()
    expect(reply).toEqual({ customer_id: null, thread_id: null, template_key: 'opt_out_confirm', peer_e164: STRANGER })
  })

  it('a short code or alphanumeric sender is quarantined as not a phone number', async () => {
    await inbound('22000', 'Carrier notice')
    await inbound('AMAZON', 'Your package')
    const rows = await w.t.db.selectFrom('sms_inbox').select(['from_e164', 'quarantined']).orderBy('received_at').execute()
    expect(rows.every((r) => r.from_e164 === null && r.quarantined)).toBe(true)
    expect(await count('messages')).toBe(0)
  })
})

describe('delivery quirks', () => {
  it('a repeated envelope is applied once; so is a repeated provider message id under a new envelope', async () => {
    await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    const ev = w.signed('sms:received', { messageId: 'dup-1', sender: maria(), recipient: '+15555550100', simNumber: 1, message: 'On my way', receivedAt: w.clock.now().toISOString() })
    expect((await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)).body.status).toBe('accepted')
    await w.settle()
    expect((await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)).body.status).toBe('duplicate')
    await w.settle()
    const again = w.signed('sms:received', { messageId: 'dup-1', sender: maria(), recipient: '+15555550100', simNumber: 1, message: 'On my way', receivedAt: w.clock.now().toISOString() })
    await w.rt.webhooks.receive(SIM_DEVICE_KEY, again.headers, again.body)
    await w.settle()
    expect(await count('messages')).toBe(1)
    expect(await count('sms_inbox')).toBe(1)
    expect(await w.t.db.selectFrom('message_threads').select('unread_count').executeTakeFirstOrThrow()).toEqual({ unread_count: 1 })
  })

  it('delivered before sent: the outbox ends delivered and a late sent only corrects the time', async () => {
    const q = await w.tx((tx) => w.rt.queue.enqueue(tx, { customerId: w.customer('Maria Delgado').id, appointmentId: null, templateKey: 'booking_thanks', vars: { first: 'Maria' }, purpose: 'booking' }))
    await w.tick()
    const id = q.messageId!
    const at = w.clock.now().toISOString()
    for (const [event, key] of [['sms:delivered', 'deliveredAt'], ['sms:sent', 'sentAt'], ['sms:delivered', 'deliveredAt']] as const) {
      const ev = w.signed(event, { messageId: id, sender: '+15555550100', recipient: w.customer('Maria Delgado').phone, simNumber: 1, [key]: at })
      await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
      await w.settle()
    }
    expect(await w.t.db.selectFrom('sms_outbox').select(['state', 'sent_at', 'delivered_at']).where('id', '=', id).executeTakeFirstOrThrow()).toMatchObject({ state: 'delivered' })
    expect((await w.messagesOf('Maria Delgado'))[0]!.status).toBe('delivered')
  })

  it('a failed event for a message already delivered does not regress it', async () => {
    const q = await w.tx((tx) => w.rt.queue.enqueue(tx, { customerId: w.customer('Maria Delgado').id, appointmentId: null, templateKey: 'booking_thanks', vars: { first: 'Maria' }, purpose: 'booking' }))
    await w.tick()
    const sim = await w.sim()
    sim.deliver(q.messageId!)
    await w.settle()
    const ev = w.signed('sms:failed', { messageId: q.messageId, sender: '+15555550100', recipient: maria(), simNumber: 1, failedAt: w.clock.now().toISOString(), reason: 'Generic failure' })
    await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
    await w.settle()
    expect((await w.messagesOf('Maria Delgado'))[0]!.status).toBe('delivered')
  })

  it('an event for a message Oasis never sent is acknowledged and ignored', async () => {
    const ev = w.signed('sms:delivered', { messageId: 'someone-elses-1', sender: '+15555550100', recipient: maria(), simNumber: 1, deliveredAt: w.clock.now().toISOString() })
    expect((await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)).status).toBe(200)
    await w.settle()
    expect((await w.t.db.selectFrom('webhook_log').select('status').executeTakeFirstOrThrow()).status).toBe('ignored')
  })
})

describe('webhook verification', () => {
  const ok = (): ReturnType<typeof w.signed> => w.signed('system:ping', { status: 'pass', version: '1.77.1', checks: {} })

  it('rejects a wrong signing key, a tampered body, missing headers and a stale timestamp with 401 and stores nothing', async () => {
    const good = ok()
    const wrongKey = w.signed('system:ping', { status: 'pass' }, { secret: 'not-the-key' })
    const tampered = { ...good, body: good.body.replace('pass', 'fail') }
    const stale = w.signed('system:ping', { status: 'pass' }, { timestamp: Math.floor(w.clock.now().getTime() / 1000) - 3 * 86400 })
    const noSig = { ...good, headers: { 'x-timestamp': good.headers['x-timestamp']! } }
    const noTs = { ...good, headers: { 'x-signature': good.headers['x-signature']! } }
    const badTs = { ...good, headers: { ...good.headers, 'x-timestamp': 'yesterday' } }
    for (const [name, ev] of Object.entries({ wrongKey, tampered, stale, noSig, noTs, badTs })) {
      const r = await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
      expect(r.status, name).toBe(401)
    }
    expect(Number((await w.t.db.selectFrom('webhook_log').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n)).toBe(0)
  })

  it('verifies against the exact raw bytes: a re-serialised body does not verify', async () => {
    const good = ok()
    const reserialised = JSON.stringify(JSON.parse(good.body), null, 1)
    expect((await w.rt.webhooks.receive(SIM_DEVICE_KEY, good.headers, reserialised)).status).toBe(401)
  })

  it('answers 400 for a signed body that is not an envelope, 404 for an unknown device key, 200 for an event type it ignores', async () => {
    const body = '{"hello":"world"}'
    const ts = String(Math.floor(w.clock.now().getTime() / 1000))
    const { signWebhook } = await import('../../src/integrations/smsgate/signature.js')
    const headers = { 'x-signature': signWebhook('sim-signing-key-design', body, ts), 'x-timestamp': ts }
    expect((await w.rt.webhooks.receive(SIM_DEVICE_KEY, headers, body)).status).toBe(400)
    expect((await w.rt.webhooks.receive('no-such-device-key', headers, body)).status).toBe(404)
    const mms = w.signed('mms:received', { messageId: 'x' })
    expect((await w.rt.webhooks.receive(SIM_DEVICE_KEY, mms.headers, mms.body)).status).toBe(200)
  })

  it('applies an envelope that was persisted but never processed (crash recovery sweep)', async () => {
    await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    const ev = w.signed('sms:received', { messageId: 'lost-1', sender: maria(), recipient: '+15555550100', simNumber: 1, message: 'Hello?', receivedAt: w.clock.now().toISOString() })
    await sql`insert into webhook_log (id, provider, external_id, headers, body, signature_valid, received_at, status)
      values (${w.newId()}, 'smsgate', ${ev.id}, ${JSON.stringify({ ...ev.headers, 'x-device-key': SIM_DEVICE_KEY })}::jsonb, ${ev.body}, true, ${new Date(w.clock.now().getTime() - 120_000)}, 'received')`.execute(w.t.db)
    expect(await w.rt.webhooks.sweep()).toEqual({ processed: 1, abandoned: 0 })
    expect((await w.messagesOf('Maria Delgado'))[0]).toMatchObject({ direction: 'in', body: 'Hello?' })
    expect(await w.rt.webhooks.sweep()).toEqual({ processed: 0, abandoned: 0 })
  })

  it('gives up on an envelope that has failed for a day', async () => {
    await sql`insert into webhook_log (id, provider, external_id, headers, body, signature_valid, received_at, status)
      values (${w.newId()}, 'smsgate', 'ancient', '{}'::jsonb, '{}', true, ${new Date(w.clock.now().getTime() - 25 * 3600_000)}, 'received')`.execute(w.t.db)
    expect(await w.rt.webhooks.sweep()).toEqual({ processed: 0, abandoned: 1 })
    expect((await w.t.db.selectFrom('webhook_log').select(['status', 'error']).executeTakeFirstOrThrow()).status).toBe('failed')
  })
})
