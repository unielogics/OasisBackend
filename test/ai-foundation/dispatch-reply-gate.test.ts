// The dispatcher's consent gate applies the same reply rule as enqueueFor (ADR 0160): a class consent-exempt only as a reply
// (personal_link) and the reply-only classes (ai_reply, action_confirm) are decided by the number's last inbound text, re-read at
// dispatch time. Within the class window the text goes, even to a client whose SMS opt-in is off; once the window has passed it is
// cancelled with 'reply window passed'. Also: with no customer id, a reply class still finds the client by the number and honours
// the client's own opt-out (sms_opted_out_at) when sms_opt_outs holds no row.
import { describe, expect, it } from 'vitest'
import type { EnqueueArgs } from '../../src/modules/messaging/queue.js'
import { STRANGER, useWorld } from '../messaging-db/world.js'

const w = useWorld()
let k = 0

const inbound = async (phone: string, minutesAgo: number): Promise<void> => {
  const dev = await w.device()
  const at = new Date(w.clock.now().getTime() - minutesAgo * 60_000)
  await w.t.db
    .insertInto('sms_inbox')
    .values({ id: w.newId(), device_id: dev.id, provider_message_id: `gate-in-${++k}`, from_raw: phone, from_e164: phone, body: 'hello', device_received_at: at, received_at: at })
    .execute()
}

/** Maria, a known client whose SMS opt-in is off. */
const unconsentedMaria = async () => {
  const maria = w.customer('Maria Delgado')
  await w.t.db.updateTable('customers').set({ sms_opted_in: false, sms_opt_in_source: null }).where('id', '=', maria.id).execute()
  const target = (await w.rt.queue.target(w.t.db, w.locationId, maria.id))!
  expect(target.recipient.smsOptIn).toBe(false)
  return { ...maria, recipient: target.recipient }
}

const enqueue = async (over: Partial<EnqueueArgs> & Pick<EnqueueArgs, 'customerId' | 'recipient'>): Promise<string> => {
  const r = await w.tx((tx) =>
    w.rt.queue.enqueueFor(tx, { locationId: w.locationId, appointmentId: null, purpose: 'test', senderKind: 'ai', dedupeKey: `gate-${++k}`, ...over }),
  )
  expect(r, JSON.stringify(r)).toMatchObject({ queued: true })
  return (r as { messageId: string }).messageId
}

const link = { templateKey: 'personal_link_verify', secretVars: { link: 'https://oasisautospanj.com/#/v/T' } } as const
const confirm = { templateKey: 'action_confirm', vars: { summary: 'Signature Wash, Sat 10:00 AM' }, secretVars: { code: '4821' } } as const
const aiReply = { text: 'We open at 8 AM.', klass: 'ai_reply' } as const

const outboxOf = (id: string) => w.t.db.selectFrom('sms_outbox').select(['state', 'last_error']).where('id', '=', id).executeTakeFirstOrThrow()
const tickAll = async (): Promise<void> => {
  await w.tick()
  await w.settle()
}

describe('dispatch gate: the reply exemption enqueue applied', () => {
  it('a personal link to a client with SMS opt-in off, queued within 15 minutes of their text, is SENT by tickAll()', async () => {
    const maria = await unconsentedMaria()
    await inbound(maria.phone, 2)
    const id = await enqueue({ customerId: maria.id, recipient: maria.recipient, ...link })
    await tickAll()
    expect(await outboxOf(id)).toMatchObject({ state: expect.stringMatching(/^(accepted|sent|delivered)$/), last_error: null })
  })

  it('the same link dispatched after the window is cancelled: reply window passed', async () => {
    const maria = await unconsentedMaria()
    await inbound(maria.phone, 2)
    const id = await enqueue({ customerId: maria.id, recipient: maria.recipient, ...link })
    w.clock.advance(14 * 60_000) // 16 minutes after her text, well within the link's 30-minute life
    await tickAll()
    expect(await outboxOf(id)).toEqual({ state: 'cancelled', last_error: 'reply window passed' })
    const msg = await w.t.db.selectFrom('messages').select('status').where('id', '=', id).executeTakeFirstOrThrow()
    expect(msg.status).toBe('canceled')
  })

  it('the last inbound is re-read at dispatch: a newer text from the client keeps the link going', async () => {
    const maria = await unconsentedMaria()
    await inbound(maria.phone, 2)
    const id = await enqueue({ customerId: maria.id, recipient: maria.recipient, ...link })
    w.clock.advance(14 * 60_000)
    await inbound(maria.phone, 1)
    await tickAll()
    expect((await outboxOf(id)).state).toMatch(/^(accepted|sent|delivered)$/)
  })

  it('a link outside the window still goes to a client who has consent (normal rules, never refused for the window alone)', async () => {
    const maria = w.customer('Maria Delgado')
    const target = (await w.rt.queue.target(w.t.db, w.locationId, maria.id))!
    expect(target.recipient.smsOptIn).toBe(true)
    await inbound(maria.phone, 2)
    const id = await enqueue({ customerId: maria.id, recipient: target.recipient, ...link })
    w.clock.advance(14 * 60_000)
    await tickAll()
    expect((await outboxOf(id)).state).toMatch(/^(accepted|sent|delivered)$/)
  })

  for (const [name, args] of [
    ['ai_reply', aiReply],
    ['action_confirm', confirm],
  ] as const) {
    it(`${name}: sent within the window to a client with opt-in off and to a stranger`, async () => {
      const maria = await unconsentedMaria()
      await inbound(maria.phone, 2)
      await inbound(STRANGER, 2)
      const a = await enqueue({ customerId: maria.id, recipient: maria.recipient, ...args })
      const b = await enqueue({ customerId: null, recipient: { kind: 'customer', phone: STRANGER, smsOptIn: false, activeOptOut: false, synthetic: false }, ...args })
      await tickAll()
      await tickAll()
      expect((await outboxOf(a)).state).toMatch(/^(accepted|sent|delivered)$/)
      expect((await outboxOf(b)).state).toMatch(/^(accepted|sent|delivered)$/)
    })

    it(`${name}: dispatched after the window is cancelled: reply window passed`, async () => {
      const maria = await unconsentedMaria()
      await inbound(maria.phone, 2)
      const id = await enqueue({ customerId: maria.id, recipient: maria.recipient, ...args })
      w.clock.advance(14 * 60_000) // 16 minutes after the text, 1 minute before the 15-minute TTL of the class
      await tickAll()
      expect(await outboxOf(id)).toEqual({ state: 'cancelled', last_error: 'reply window passed' })
    })
  }

  it('an ordinary class to a client whose opt-in is off is still cancelled as before', async () => {
    const maria = w.customer('Maria Delgado')
    const target = (await w.rt.queue.target(w.t.db, w.locationId, maria.id))!
    await inbound(maria.phone, 1)
    const id = await enqueue({ customerId: maria.id, recipient: target.recipient, senderKind: 'system', templateKey: 'ready' })
    await w.t.db.updateTable('customers').set({ sms_opted_in: false }).where('id', '=', maria.id).execute()
    await tickAll()
    expect(await outboxOf(id)).toEqual({ state: 'cancelled', last_error: 'recipient no longer opted in' })
  })
})

describe('enqueue: a reply class with no customer id finds the client by the number', () => {
  it("refuses a number whose client opted out (sms_opted_out_at) even with no sms_opt_outs row", async () => {
    const maria = w.customer('Maria Delgado')
    await inbound(maria.phone, 1)
    await w.t.db.updateTable('customers').set({ sms_opted_out_at: w.clock.now() }).where('id', '=', maria.id).execute()
    expect(await w.t.db.selectFrom('sms_opt_outs').select('id').execute()).toEqual([])
    const recipient = { kind: 'customer' as const, phone: maria.phone, smsOptIn: true, activeOptOut: false, synthetic: false }
    for (const args of [aiReply, confirm, link, { text: 'Still interested?', klass: 'lead_follow_up' as const }]) {
      const r = await w.tx((tx) =>
        w.rt.queue.enqueueFor(tx, { locationId: w.locationId, customerId: null, recipient, appointmentId: null, purpose: 'test', senderKind: 'ai', dedupeKey: `gate-${++k}`, ...args }),
      )
      expect(r, JSON.stringify(args)).toEqual({ queued: false, skipped: 'opted_out' })
    }
    // the same number with the client's opt-out lifted goes
    await w.t.db.updateTable('customers').set({ sms_opted_out_at: null }).where('id', '=', maria.id).execute()
    await enqueue({ customerId: null, recipient, ...aiReply })
  })
})
