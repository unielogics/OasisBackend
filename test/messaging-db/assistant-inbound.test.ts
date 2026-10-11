// The assistant's inbound plumbing on Postgres (ADR 0160, design sections 2-3): the gate, the durable marker written in the
// webhook's transaction and the post-commit kick, AGENT handoffs, the staff takeover, reply numbers and redacted codes, the loop
// breakers. AI_ENABLED is on in this world; each test switches the settings it needs (assistant.enabled is off by default).
import { describe, expect, it, beforeEach } from 'vitest'
import { sql } from 'kysely'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { CODE_MASK } from '../../src/modules/messaging/inbound/keywords.js'
import { hasPendingAction, handoffSourceRef } from '../../src/modules/messaging/assistant/inbox.js'
import type { ActionCodeInput } from '../../src/modules/assistant/ports.js'
import { STRANGER, useWorld } from './world.js'

const kicked: string[][] = []
// what the kick saw: the marker is committed before the turn is started
const seenAtKick: Array<string | null> = []
const w = useWorld({
  env: { AI_ENABLED: 'true', BUSINESS_PHONE: '+12015986304' },
  deps: {
    assistant: {
      kick: {
        kick: async (ids) => {
          kicked.push([...ids])
          const r = await w.t.db.selectFrom('assistant_conversations').select('pending_since').where('id', '=', ids[0]!).executeTakeFirst()
          seenAtKick.push(r?.pending_since ? 'committed' : null)
        },
      },
    },
  },
})
let n = 0

async function inbound(from: string, text: string, o: { recipient?: string } = {}) {
  n += 1
  const ev = w.signed('sms:received', {
    messageId: `ai-in-${n}`,
    sender: from,
    recipient: o.recipient ?? '+18623885827',
    simNumber: 1,
    message: text,
    receivedAt: w.clock.now().toISOString(),
  })
  const res = await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
  await w.settle()
  return { res, envelopeId: ev.id }
}

async function setting(key: string, value: unknown): Promise<void> {
  await sql`insert into settings (location_id, key, value) values (${w.locationId}, ${key}, ${JSON.stringify(value)}::jsonb)
    on conflict (location_id, key) do update set value = excluded.value`.execute(w.t.db)
}
const assistantOn = async (stage: 'allowlist' | 'customers' | 'everyone' = 'everyone', allowlist: string[] = []): Promise<void> => {
  await setting('assistant.enabled', true)
  await setting('assistant.stage', stage)
  await setting('assistant.allowlist', allowlist)
}

const maria = (): string => w.customer('Maria Delgado').phone
const lastInbox = () =>
  w.t.db
    .selectFrom('sms_inbox')
    .select(['body', 'decision', 'quarantined', 'customer_id', 'assistant_conversation_id', 'message_id'])
    .orderBy('received_at', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirstOrThrow()
const conversations = () =>
  w.t.db.selectFrom('assistant_conversations').select(['id', 'phone_e164', 'customer_id', 'pending_since', 'last_inbound_at', 'handoff_state', 'handoff_reason']).orderBy('created_at').execute()
const notifications = () => w.t.db.selectFrom('notifications').select(['kind', 'title', 'source_ref', 'read_at']).execute()

beforeEach(async () => {
  kicked.length = 0
  seenAtKick.length = 0
  await sql`truncate table assistant_conversations cascade`.execute(w.t.db)
  await sql`delete from settings where key like 'assistant.%'`.execute(w.t.db)
})

describe('the gate', () => {
  it('assistant.enabled=false (the default): a text is filed unread with an alert, exactly as before, and nothing is kicked', async () => {
    await inbound(maria(), 'Do you do ceramic coating?')
    expect(await lastInbox()).toMatchObject({ decision: 'message', quarantined: false, assistant_conversation_id: null, body: 'Do you do ceramic coating?' })
    const [m] = await w.messagesOf('Maria Delgado')
    expect(m).toMatchObject({ direction: 'in', body: 'Do you do ceramic coating?' })
    expect((await w.t.db.selectFrom('message_threads').select('unread_count').executeTakeFirstOrThrow()).unread_count).toBe(1)
    expect((await notifications()).every((x) => x.kind === 'sms.unattributed_reply')).toBe(true)
    expect(await conversations()).toEqual([])
    expect(kicked).toEqual([])
  })

  it("a client's text goes to the assistant: filed read, no alert, the marker set in the transaction, kicked after commit", async () => {
    await assistantOn()
    await inbound(maria(), 'Do you do ceramic coating?')
    const row = await lastInbox()
    expect(row).toMatchObject({ decision: 'assistant', quarantined: false, customer_id: w.customer('Maria Delgado').id })
    const [c] = await conversations()
    expect(c).toMatchObject({ phone_e164: maria(), customer_id: w.customer('Maria Delgado').id, handoff_state: null })
    expect(c!.pending_since).toEqual(w.clock.now())
    expect(row.assistant_conversation_id).toBe(c!.id)
    const thread = await w.t.db.selectFrom('message_threads').select(['unread_count', 'ai_paused_until']).executeTakeFirstOrThrow()
    expect(thread).toEqual({ unread_count: 0, ai_paused_until: null })
    expect((await w.messagesOf('Maria Delgado'))[0]).toMatchObject({ direction: 'in', body: 'Do you do ceramic coating?' })
    expect(await notifications()).toEqual([])
    expect(kicked).toEqual([[c!.id]])
    expect(seenAtKick).toEqual(['committed'])
  })

  it('a burst keeps the oldest unanswered text as the marker and moves last_inbound_at', async () => {
    await assistantOn()
    const first = w.clock.now()
    await inbound(maria(), 'hi')
    w.clock.advance(3000)
    await inbound(maria(), 'how much is a wash')
    const [c] = await conversations()
    expect(c!.pending_since).toEqual(first)
    expect(c!.last_inbound_at).toEqual(w.clock.now())
    expect(kicked).toHaveLength(2)
  })

  it("a stranger's text goes to the assistant and is not quarantined; no client is created here", async () => {
    await assistantOn()
    const customersBefore = await w.t.db.selectFrom('customers').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()
    await inbound(STRANGER, 'How much is a wash?')
    expect(await lastInbox()).toMatchObject({ decision: 'assistant', quarantined: false, customer_id: null })
    expect(await conversations()).toMatchObject([{ phone_e164: STRANGER, customer_id: null }])
    expect(await w.t.db.selectFrom('customers').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).toEqual(customersBefore)
  })

  it('a +44 sender, a short code and our own number get nothing from the AI (filed as before)', async () => {
    await assistantOn()
    await inbound('+447911123456', 'hello')
    expect(await lastInbox()).toMatchObject({ decision: 'quarantined', quarantined: true })
    await inbound('32665', 'Your code is 123456')
    expect(await lastInbox()).toMatchObject({ decision: 'quarantined', quarantined: true })
    await inbound('+18623885827', 'echo')
    expect(await lastInbox()).toMatchObject({ decision: 'quarantined', quarantined: true })
    await inbound('+12015986304', 'echo from the shop phone')
    expect(await lastInbox()).toMatchObject({ decision: 'quarantined', quarantined: true })
    expect(await conversations()).toEqual([])
    expect(kicked).toEqual([])
  })

  it('stage allowlist answers only the listed numbers; stage customers only clients', async () => {
    await assistantOn('allowlist', [w.customer('Liam Chen').phone])
    await inbound(maria(), 'hi')
    expect((await lastInbox()).decision).toBe('message')
    await inbound(w.customer('Liam Chen').phone, 'hi')
    expect((await lastInbox()).decision).toBe('assistant')

    await assistantOn('customers')
    await inbound(STRANGER, 'hi')
    expect((await lastInbox()).decision).toBe('quarantined')
    await inbound(maria(), 'hi again')
    expect((await lastInbox()).decision).toBe('assistant')
  })

  it('AI_ENABLED is read from the environment: with it off no setting turns the assistant on', async () => {
    await assistantOn()
    const gate = w.rt.assistant().gate
    const off = (await import('../../src/modules/messaging/assistant/gate.js')).createAssistantGate({ aiEnabled: false, ownNumbers: [] })
    const input = { locationId: w.locationId, from: maria(), phone: maria(), customerId: w.customer('Maria Delgado').id, optedOut: false, body: 'hi', now: w.clock.now() }
    expect(await gate.evaluate(w.t.db, input)).toEqual({ active: true, allow: true, reason: null })
    expect(await off.evaluate(w.t.db, input)).toEqual({ active: false, allow: false, reason: 'ai_disabled' })
  })

  it('STOP gets no AI answer and later texts get none', async () => {
    await assistantOn()
    await inbound(maria(), 'STOP')
    expect((await lastInbox()).decision).toBe('opt_out')
    await inbound(maria(), 'actually what are your hours?')
    expect((await lastInbox()).decision).toBe('message')
    expect(kicked).toEqual([])
    expect(await conversations()).toEqual([])
  })
})

describe('AGENT', () => {
  it('opens a handoff (no AI), files the text unread and alerts managers; the next texts stay with staff', async () => {
    await assistantOn()
    await inbound(maria(), 'hi')
    await inbound(maria(), 'AGENT')
    expect(await lastInbox()).toMatchObject({ decision: 'handoff', quarantined: false })
    const [c] = await conversations()
    expect(c).toMatchObject({ handoff_state: 'open', handoff_reason: 'agent_keyword', pending_since: null })
    const alert = (await notifications()).filter((x) => x.kind === 'assistant.handoff')
    expect(alert.length).toBeGreaterThan(0)
    expect(alert.every((x) => x.source_ref === handoffSourceRef(c!.id) && x.title.includes('Maria Delgado'))).toBe(true)
    expect((await w.t.db.selectFrom('message_threads').select('unread_count').executeTakeFirstOrThrow()).unread_count).toBe(1)

    await inbound(maria(), 'are you there?')
    expect((await lastInbox()).decision).toBe('message')
    expect(kicked).toHaveLength(1)
  })

  it('from a stranger: handoff kept for review in the quarantine list, alert names the masked number', async () => {
    await assistantOn()
    await inbound(STRANGER, 'agent')
    expect(await lastInbox()).toMatchObject({ decision: 'handoff', quarantined: true })
    const alert = (await notifications()).find((x) => x.kind === 'assistant.handoff')!
    expect(alert.title).toContain(STRANGER.slice(-4))
    expect(alert.title).not.toContain(STRANGER)
  })
})

describe('staff takeover', () => {
  const staffText = (text: string) =>
    w.tx(async (tx) => {
      const t = (await w.rt.queue.target(tx, w.locationId, w.customer('Maria Delgado').id))!
      const employee = await tx.selectFrom('employees').select('id').limit(1).executeTakeFirstOrThrow()
      return w.rt.queue.enqueueFor(tx, {
        locationId: w.locationId,
        customerId: w.customer('Maria Delgado').id,
        recipient: t.recipient,
        appointmentId: null,
        text,
        klass: 'staff_message',
        purpose: 'staff',
        senderKind: 'staff',
        senderEmployeeId: employee.id,
      })
    })

  it('a staff text pauses the AI on the thread for staff_pause_hours and resolves the open handoff and its alert', async () => {
    await assistantOn()
    await setting('assistant.staff_pause_hours', 6)
    await inbound(maria(), 'AGENT')
    expect((await staffText('Hi Maria, Sam here. How can I help?')).queued).toBe(true)
    const thread = await w.t.db.selectFrom('message_threads').select(['ai_paused_until', 'ai_paused_by']).executeTakeFirstOrThrow()
    expect(thread.ai_paused_until).toEqual(new Date(w.clock.now().getTime() + 6 * 3600_000))
    expect(thread.ai_paused_by).not.toBeNull()
    expect(await conversations()).toMatchObject([{ handoff_state: 'resolved' }])
    expect((await notifications()).filter((x) => x.kind === 'assistant.handoff').every((x) => x.read_at !== null)).toBe(true)

    // paused: texts go to staff as before
    w.clock.advance(60_000)
    await inbound(maria(), 'thanks!')
    expect((await lastInbox()).decision).toBe('message')
    // after the pause the AI answers again
    w.clock.advance(6 * 3600_000)
    await inbound(maria(), 'one more question')
    expect((await lastInbox()).decision).toBe('assistant')
  })

  it('with the assistant off the pause is only recorded (it changes nothing until the AI is on)', async () => {
    await staffText('Your car is ready')
    const thread = await w.t.db.selectFrom('message_threads').select('ai_paused_until').executeTakeFirstOrThrow()
    expect(thread.ai_paused_until).toEqual(new Date(w.clock.now().getTime() + 12 * 3600_000))
    await inbound(maria(), 'on my way')
    expect((await lastInbox()).decision).toBe('message')
  })

  it('a system text (a reminder, the AI) does not pause', async () => {
    await w.tx((tx) => w.rt.queue.enqueue(tx, { customerId: w.customer('Maria Delgado').id, appointmentId: null, templateKey: 'booking_thanks', vars: { first: 'Maria' }, purpose: 'booking' }))
    expect(await w.t.db.selectFrom('message_threads').select('ai_paused_until').executeTakeFirstOrThrow()).toEqual({ ai_paused_until: null })
  })
})

describe('codes', () => {
  async function pendingAction(phone: string, customerId: string): Promise<void> {
    const conv = w.newId()
    await w.t.db.insertInto('assistant_conversations').values({ id: conv, location_id: w.locationId, phone_e164: phone, customer_id: customerId }).execute()
    await w.t.db
      .insertInto('assistant_pending_actions')
      .values({
        id: w.newId(),
        location_id: w.locationId,
        conversation_id: conv,
        customer_id: customerId,
        phone_e164: phone,
        kind: 'book',
        payload: JSON.stringify({ serviceKey: 'express-hand-wash' }) as never,
        code_hash: 'a'.repeat(64),
        expires_at: new Date(w.clock.now().getTime() + 15 * 60_000),
      })
      .execute()
  }

  it('a reply number while an action waits goes to the handler only; inbox, thread, events and webhook log hold [code]', async () => {
    const handled: ActionCodeInput[] = []
    w.rt.useAssistant({ actionCodes: { hasPending: hasPendingAction, handle: async (_tx, i) => void handled.push(i) } })
    await assistantOn()
    await pendingAction(maria(), w.customer('Maria Delgado').id)
    const { envelopeId } = await inbound(maria(), ' 4821 ')
    expect(handled).toMatchObject([{ phone: maria(), customerId: w.customer('Maria Delgado').id, code: '4821' }])
    expect(await lastInbox()).toMatchObject({ decision: 'action_code', body: CODE_MASK })
    expect((await w.messagesOf('Maria Delgado'))[0]).toMatchObject({ direction: 'in', body: CODE_MASK })
    const log = await w.t.db.selectFrom('webhook_log').select(['body', 'status']).where('external_id', '=', envelopeId).executeTakeFirstOrThrow()
    expect(log.status).toBe('processed')
    expect(log.body).not.toContain('4821')
    expect(JSON.parse(log.body!).payload.message).toBe(CODE_MASK)
    const events = await w.t.db.selectFrom('realtime_events').select('payload').execute()
    expect(JSON.stringify(events)).not.toContain('4821')
    expect(kicked).toEqual([])
  })

  it('with the assistant off a pending action still keeps the code out of every table (the handler decides)', async () => {
    const handled: string[] = []
    w.rt.useAssistant({ actionCodes: { hasPending: hasPendingAction, handle: async (_tx, i) => void handled.push(i.code) } })
    await pendingAction(maria(), w.customer('Maria Delgado').id)
    await inbound(maria(), '4821')
    expect(handled).toEqual(['4821'])
    expect(await lastInbox()).toMatchObject({ decision: 'action_code', body: CODE_MASK })
  })

  it('an expired pending action is not waiting: the code is answered with the link-page line, filed [code]', async () => {
    await assistantOn()
    await pendingAction(maria(), w.customer('Maria Delgado').id)
    w.clock.advance(16 * 60_000)
    await inbound(maria(), '4821')
    expect(await lastInbox()).toMatchObject({ decision: 'message', body: CODE_MASK })
    const out = (await w.messagesOf('Maria Delgado')).filter((m) => m.direction === 'out')
    expect(out).toMatchObject([{ template_key: 'code_on_link_page', klass: 'ai_reply' }])
    expect(JSON.stringify(await w.t.db.selectFrom('sms_outbox').select('body').execute())).not.toContain('4821')
  })

  it('a burst of codes gets one link-page answer per 30 minutes', async () => {
    await assistantOn()
    await inbound(maria(), '1111')
    w.clock.advance(20_000)
    await inbound(maria(), '2222')
    expect((await w.messagesOf('Maria Delgado')).filter((m) => m.direction === 'out')).toHaveLength(1)
    w.clock.advance(31 * 60_000)
    await inbound(maria(), '3333')
    expect((await w.messagesOf('Maria Delgado')).filter((m) => m.direction === 'out')).toHaveLength(2)
  })

  it('with the assistant off and nothing pending, digits are an ordinary message (as before)', async () => {
    await inbound(maria(), '4821')
    expect(await lastInbox()).toMatchObject({ decision: 'message', body: '4821' })
  })
})

describe('loop breakers', () => {
  it('the third identical text and a burst get no AI answer', async () => {
    await assistantOn()
    await inbound(maria(), 'Out of office')
    w.clock.advance(10_000)
    await inbound(maria(), 'out of office.')
    expect((await lastInbox()).decision).toBe('assistant')
    w.clock.advance(10_000)
    await inbound(maria(), 'Out of office')
    expect((await lastInbox()).decision).toBe('message')

    w.clock.advance(3600_000)
    for (let i = 0; i < 5; i++) {
      await inbound(w.customer('Liam Chen').phone, `text ${i}`)
      w.clock.advance(5000)
    }
    expect((await lastInbox()).decision).toBe('assistant')
    await inbound(w.customer('Liam Chen').phone, 'text 6')
    expect((await lastInbox()).decision).toBe('message')
  })
})
