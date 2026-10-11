// In-chat actions confirmed by a server reply number (ADR 0160, design sections 0, 3, 4 and 10; wave W3b): a proposal inside the
// 30-day trust texts "<summary>. Reply NNNN to confirm." (the number masked in the thread, never in the model's data); only that
// number, from that phone, within 15 minutes and 3 tries, runs the action, after the kill switches and the trust are checked again.
// Must-have tests: a spoofed action inside the trust never executes without the reply number; a reply number from another phone does
// nothing; STOP and a staff takeover cancel a pending action.
import { describe, expect, it, beforeEach } from 'vitest'
import { sql } from 'kysely'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import type { AnyAssistantTool, ToolOutcome } from '../../src/modules/assistant/contract.js'
import { createActionCodeHandler } from '../../src/modules/assistant/actions/handler.js'
import { createToolRegistry } from '../../src/modules/assistant/tools/index.js'
import { revokeTrust } from '../../src/modules/identity/trust.js'
import { useToolWorld, type CtxProbe } from './world.js'

const w = useToolWorld()
const tool = (name: string): AnyAssistantTool => createToolRegistry(w.deps).get(name)!
const handler = () => createActionCodeHandler(w.deps)
const maria = () => w.customer('Maria Delgado')
const david = () => w.customer('David Okafor')
const MIN = 60_000
let n = 0

async function run(name: string, probe: CtxProbe, input: unknown): Promise<ToolOutcome> {
  const t = tool(name)
  return t.run(probe.ctx, t.input.parse(input))
}

/** A text from the number through the real webhook (the reply classes need one in the last 15 minutes). */
async function inbound(phone: string, text: string) {
  n += 1
  const ev = w.signed('sms:received', {
    messageId: `w3b-in-${n}`,
    sender: phone,
    recipient: '+18623885827',
    simNumber: 1,
    message: text,
    receivedAt: w.clock.now().toISOString(),
  })
  const res = await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
  await w.settle()
  return res
}

/** The reply number the last action_confirm text to the phone carries (read from the outbox: only the sent text has it). */
async function lastCode(phone: string): Promise<string> {
  const r = await w.t.db
    .selectFrom('sms_outbox')
    .select('body')
    .where('to_e164', '=', phone)
    .where('klass', '=', 'action_confirm')
    .orderBy('queued_at', 'desc')
    .executeTakeFirstOrThrow()
  return /Reply (\d{4}) to confirm/.exec(r.body)![1]!
}

const reply = (phone: string, code: string, customerId: string | null) =>
  w.tx((tx) => handler().handle(tx, { locationId: w.locationId, phone, customerId, code, inboxId: w.newId(), at: w.clock.now() }))

const appointmentsOf = (customerId: string) =>
  w.t.db.selectFrom('appointments').select(['id', 'source', 'status', 'scheduled_start', 'categories', 'service_id']).where('customer_id', '=', customerId).execute()
const pending = () => w.t.db.selectFrom('assistant_pending_actions').select(['id', 'state', 'attempts', 'kind', 'appointment_id', 'error']).orderBy('created_at').execute()
const aiTexts = (customerId: string) =>
  w.t.db.selectFrom('messages').select(['template_key', 'body', 'klass', 'sender_kind']).where('customer_id', '=', customerId).where('direction', '=', 'out').orderBy('queued_at').orderBy('id').execute()

async function trustedMaria(): Promise<CtxProbe> {
  await w.assistantOn({ actions: true })
  await w.trust(maria().phone, maria().id)
  await inbound(maria().phone, 'Can I book an express wash Monday at 10?')
  return w.ctx({ customerId: maria().id, phone: maria().phone, trust: 'trusted' })
}

const BOOK = { serviceKey: 'express-hand-wash', addonKeys: [], date: '2026-06-15', startMin: 600, vehicle: null }

beforeEach(() => {
  n += 100
})

describe('propose_booking', () => {
  it('records the proposal and texts the summary with a reply number the model never sees; nothing is booked yet', async () => {
    const probe = await trustedMaria()
    const r = await run('propose_booking', probe, { ...BOOK, vehicle: 'the Audi' })
    expect(r).toMatchObject({ ok: true, data: { proposed: 'book', summary: 'Express Hand Wash, Mon Jun 15 at 10:00 AM', confirmationTexted: true } })
    const code = await lastCode(maria().phone)
    expect(JSON.stringify(r)).not.toContain(code)
    const [p] = await pending()
    expect(p).toMatchObject({ state: 'pending', kind: 'book', attempts: 0 })
    expect(await appointmentsOf(maria().id)).toEqual([])
    const confirm = (await aiTexts(maria().id)).find((m) => m.klass === 'action_confirm')!
    expect(confirm).toMatchObject({ sender_kind: 'ai' })
    expect(confirm.body).toMatch(/^Express Hand Wash, Mon Jun 15 at 10:00 AM\. Reply \[code\] to confirm\./)
    expect(await w.t.db.selectFrom('audit_log').select('action').where('action', '=', 'assistant.book.proposed').execute()).toHaveLength(1)
  })

  it('needs the 30-day trust: a caller (or a revoked trust) gets needs_verification and no proposal', async () => {
    await w.assistantOn({ actions: true })
    await inbound(maria().phone, 'book me')
    const caller = await w.ctx({ customerId: maria().id, phone: maria().phone, trust: 'caller' })
    expect(await run('propose_booking', caller, BOOK)).toMatchObject({ ok: false, error: 'needs_verification' })
    // the turn thinks it is trusted, the server does not: refused by createPendingAction's own check
    const spoofed = await w.ctx({ customerId: maria().id, phone: maria().phone, trust: 'trusted' })
    expect(await run('propose_booking', spoofed, BOOK)).toMatchObject({ ok: false, error: 'needs_verification' })
    expect(await pending()).toEqual([])
    expect((await aiTexts(maria().id)).filter((m) => m.klass === 'action_confirm')).toEqual([])
  })

  it('refuses while actions are off, a slot that is not open, an unknown service or add-on, and a vehicle not on file', async () => {
    const probe = await trustedMaria()
    const off = { ...probe, ctx: { ...probe.ctx, actionsEnabled: false } }
    expect(await run('propose_booking', off, BOOK)).toMatchObject({ ok: false, error: 'unavailable' })
    expect(await run('propose_booking', probe, { ...BOOK, startMin: 601 })).toMatchObject({ ok: false, error: 'invalid' })
    expect(await run('propose_booking', probe, { ...BOOK, date: '2026-06-12' })).toMatchObject({ ok: false, error: 'invalid' })
    expect(await run('propose_booking', probe, { ...BOOK, serviceKey: 'nope' })).toMatchObject({ ok: false, error: 'invalid' })
    expect(await run('propose_booking', probe, { ...BOOK, addonKeys: ['nope'] })).toMatchObject({ ok: false, error: 'invalid' })
    expect(await run('propose_booking', probe, { ...BOOK, vehicle: 'my Lamborghini' })).toMatchObject({ ok: false, error: 'invalid' })
    expect(await pending()).toEqual([])
  })

  it('keeps at most two future bookings made by text per client', async () => {
    const probe = await trustedMaria()
    for (const at of ['2026-06-16T10:00:00-04:00', '2026-06-17T10:00:00-04:00']) {
      const id = await w.appointment({ customer: 'Maria Delgado', at })
      await sql`update appointments set source = 'sms_ai' where id = ${id}`.execute(w.t.db)
    }
    expect(await run('propose_booking', probe, BOOK)).toMatchObject({ ok: false, error: 'rate_limited' })
  })
})

describe('the reply number (ActionCodeHandler)', () => {
  it('a spoofed action inside the trust never executes without the reply number: a new proposal, a YES or a wrong number do nothing', async () => {
    const probe = await trustedMaria()
    await run('propose_booking', probe, BOOK)
    const code = await lastCode(maria().phone)
    await run('propose_booking', probe, BOOK) // supersedes, books nothing
    await inbound(maria().phone, 'YES confirm it')
    const wrong = String((Number(await lastCode(maria().phone)) + 1) % 10_000).padStart(4, '0')
    await reply(maria().phone, wrong, maria().id)
    expect(await appointmentsOf(maria().id)).toEqual([])
    expect((await pending()).map((p) => p.state)).toEqual(['superseded', 'pending'])
    expect((await pending())[1]!.attempts).toBe(1)
    expect((await aiTexts(maria().id)).some((m) => m.template_key === 'action_code_wrong')).toBe(true)
    // the superseded proposal's number is dead too
    if (code !== (await lastCode(maria().phone))) {
      await reply(maria().phone, code, maria().id)
      expect(await appointmentsOf(maria().id)).toEqual([])
    }
  })

  it('the right number books: online channel, source sms_ai, categories, the lead closed, the confirmation from Oasis AI', async () => {
    const probe = await trustedMaria()
    await w.t.db.insertInto('leads').values({ id: w.newId(), location_id: w.locationId, phone_e164: maria().phone, customer_id: maria().id, source: 'text', first_contact_at: w.clock.now(), last_contact_at: w.clock.now() }).execute()
    await run('propose_booking', probe, { ...BOOK, vehicle: 'Audi Q5' })
    await reply(maria().phone, await lastCode(maria().phone), maria().id)
    const [a] = await appointmentsOf(maria().id)
    expect(a).toMatchObject({ source: 'sms_ai', status: 'booked', categories: ['wash'] })
    expect(a!.scheduled_start).toEqual(new Date('2026-06-15T10:00:00-04:00'))
    expect(await pending()).toMatchObject([{ state: 'executed', appointment_id: a!.id }])
    expect(await w.t.db.selectFrom('leads').select(['status', 'booked_appointment_id']).executeTakeFirstOrThrow()).toEqual({ status: 'booked', booked_appointment_id: a!.id })
    const booked = (await aiTexts(maria().id)).find((m) => m.template_key === 'action_booked')!
    expect(booked).toMatchObject({ klass: 'ai_reply', sender_kind: 'ai' })
    expect(booked.body).toMatch(/^You're booked: Express Hand Wash, Mon Jun 15 at 10:00 AM\. \$\d+\.\d\d booking fee due at the shop\. See you then!/)
    const vehicle = await w.t.db.selectFrom('appointments').innerJoin('vehicles', 'vehicles.id', 'appointments.vehicle_id').select(['vehicles.model']).where('appointments.id', '=', a!.id).executeTakeFirst()
    expect(vehicle).toEqual({ model: 'Q5' })
    expect(await w.t.db.selectFrom('audit_log').select('actor_name').where('action', '=', 'assistant.booking.confirmed').execute()).toEqual([{ actor_name: 'Oasis AI (SMS)' }])
    // the same number again does nothing more
    await reply(maria().phone, await lastCode(maria().phone), maria().id)
    expect(await appointmentsOf(maria().id)).toHaveLength(1)
  })

  it('a reply number from another phone does nothing (and leaves the owner’s action pending)', async () => {
    const probe = await trustedMaria()
    await run('propose_booking', probe, BOOK)
    const code = await lastCode(maria().phone)
    const h = handler()
    expect(await h.hasPending(w.t.db, { locationId: w.locationId, phone: david().phone, now: w.clock.now() })).toBe(false)
    await reply(david().phone, code, david().id)
    // through the webhook too: David's digits are no reply number of his (no pending action of his number)
    w.rt.useAssistant({ actionCodes: h })
    await inbound(david().phone, code)
    expect(await appointmentsOf(maria().id)).toEqual([])
    expect(await appointmentsOf(david().id)).toEqual([])
    expect(await pending()).toMatchObject([{ state: 'pending', attempts: 0 }])
  })

  it('through the webhook: the owner’s digits are routed to the handler before any model, filed masked, and book', async () => {
    const probe = await trustedMaria()
    w.rt.useAssistant({ actionCodes: handler() })
    await run('propose_booking', probe, BOOK)
    const code = await lastCode(maria().phone)
    await inbound(maria().phone, ` ${code} `)
    expect(await appointmentsOf(maria().id)).toHaveLength(1)
    const inboxRows = await w.t.db.selectFrom('sms_inbox').select(['body', 'decision']).where('from_e164', '=', maria().phone).orderBy('received_at', 'desc').orderBy('id', 'desc').execute()
    expect(inboxRows[0]).toMatchObject({ decision: 'action_code' })
    expect(JSON.stringify(inboxRows)).not.toContain(code)
  })

  it('three wrong numbers lock the action; an expired one is refused', async () => {
    const probe = await trustedMaria()
    await run('propose_booking', probe, BOOK)
    const code = await lastCode(maria().phone)
    const wrong = String((Number(code) + 5) % 10_000).padStart(4, '0')
    for (let i = 0; i < 3; i++) await reply(maria().phone, wrong, maria().id)
    expect(await pending()).toMatchObject([{ state: 'locked', attempts: 3 }])
    await reply(maria().phone, code, maria().id)
    expect(await appointmentsOf(maria().id)).toEqual([])
    expect((await aiTexts(maria().id)).some((m) => m.template_key === 'action_code_locked')).toBe(true)

    const again = await w.ctx({ customerId: maria().id, phone: maria().phone, trust: 'trusted' })
    await run('propose_booking', again, BOOK)
    const fresh = await lastCode(maria().phone)
    w.clock.advance(16 * MIN)
    await inbound(maria().phone, 'hello?')
    await reply(maria().phone, fresh, maria().id)
    expect(await appointmentsOf(maria().id)).toEqual([])
    expect((await pending()).at(-1)).toMatchObject({ state: 'expired' })
  })

  it('kill switches: actions off cancels and says a team member will text; the assistant off cancels silently', async () => {
    const probe = await trustedMaria()
    await run('propose_booking', probe, BOOK)
    await w.setting('assistant.actions_enabled', false)
    await reply(maria().phone, await lastCode(maria().phone), maria().id)
    expect(await appointmentsOf(maria().id)).toEqual([])
    expect(await pending()).toMatchObject([{ state: 'canceled' }])
    expect((await aiTexts(maria().id)).some((m) => m.template_key === 'action_unavailable')).toBe(true)

    await w.setting('assistant.actions_enabled', true)
    const again = await w.ctx({ customerId: maria().id, phone: maria().phone, trust: 'trusted' })
    await run('propose_booking', again, BOOK)
    await w.setting('assistant.enabled', false)
    const before = (await aiTexts(maria().id)).length
    await reply(maria().phone, await lastCode(maria().phone), maria().id)
    expect(await appointmentsOf(maria().id)).toEqual([])
    expect((await pending()).at(-1)).toMatchObject({ state: 'canceled' })
    expect(await aiTexts(maria().id)).toHaveLength(before)
  })

  it('the trust is checked again: revoked after the proposal, the right number runs nothing', async () => {
    const probe = await trustedMaria()
    await run('propose_booking', probe, BOOK)
    await w.tx((tx) => revokeTrust(tx, { locationId: w.locationId, phone: maria().phone, reason: 'staff', now: w.clock.now() }))
    await reply(maria().phone, await lastCode(maria().phone), maria().id)
    expect(await appointmentsOf(maria().id)).toEqual([])
    expect((await aiTexts(maria().id)).some((m) => m.template_key === 'action_needs_verify')).toBe(true)
  })

  it('STOP cancels the pending action (and its digits are no reply number any more)', async () => {
    const probe = await trustedMaria()
    w.rt.useAssistant({ actionCodes: handler() })
    await run('propose_booking', probe, BOOK)
    const code = await lastCode(maria().phone)
    await inbound(maria().phone, 'STOP')
    expect(await pending()).toMatchObject([{ state: 'canceled' }])
    await inbound(maria().phone, code)
    expect(await appointmentsOf(maria().id)).toEqual([])
    await sql`update customers set sms_opted_out_at = null where id = ${maria().id}`.execute(w.t.db)
  })

  it('a staff takeover cancels the pending action', async () => {
    const probe = await trustedMaria()
    await run('propose_booking', probe, BOOK)
    const target = await w.rt.queue.target(w.t.db, w.locationId, maria().id)
    await w.tx((tx) =>
      w.rt.queue.enqueueFor(tx, { locationId: w.locationId, customerId: maria().id, recipient: target!.recipient, appointmentId: null, text: 'Hi Maria, Joe here.', klass: 'staff_message', purpose: 'staff', senderKind: 'staff' }),
    )
    expect(await pending()).toMatchObject([{ state: 'canceled', error: 'staff took the thread over' }])
    await reply(maria().phone, await lastCode(maria().phone), maria().id)
    expect(await appointmentsOf(maria().id)).toEqual([])
  })

  it('a time taken between the proposal and the reply fails the action and says so', async () => {
    const probe = await trustedMaria()
    await run('propose_booking', probe, BOOK)
    await w.t.db.insertInto('closures').values({ id: w.newId(), location_id: w.locationId, date: '2026-06-15', name: 'Water outage', type: 'closed', source: 'manual' } as never).execute()
    try {
      await reply(maria().phone, await lastCode(maria().phone), maria().id)
      expect(await appointmentsOf(maria().id)).toEqual([])
      expect(await pending()).toMatchObject([{ state: 'failed', error: 'that time was just taken.' }])
      expect((await aiTexts(maria().id)).find((m) => m.template_key === 'action_failed')?.body).toMatch(/That time was just taken\./)
    } finally {
      await w.t.db.deleteFrom('closures').where('date', '=', '2026-06-15').execute()
    }
  })
})

describe('propose_reschedule and propose_cancel', () => {
  it('reschedule: the own visit by ref, a new open time, confirmed by the reply number; the scheduling text tells the client', async () => {
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-16T09:00:00-04:00' })
    const probe = await trustedMaria()
    const r = await run('propose_reschedule', probe, { appointmentRef: 'A1', date: '2026-06-17', startMin: 660 })
    expect(r).toMatchObject({ ok: true, data: { summary: 'Move your Express Hand Wash to Wed Jun 17 at 11:00 AM' } })
    await reply(maria().phone, await lastCode(maria().phone), maria().id)
    const moved = await w.t.db.selectFrom('appointments').select(['scheduled_start', 'status']).where('id', '=', appt).executeTakeFirstOrThrow()
    expect(moved.scheduled_start).toEqual(new Date('2026-06-17T11:00:00-04:00'))
    expect((await aiTexts(maria().id)).some((m) => m.template_key === 'reschedule')).toBe(true)
    expect(await run('propose_reschedule', probe, { appointmentRef: 'A3', date: '2026-06-17', startMin: 660 })).toMatchObject({ ok: false, error: 'not_found' })
  })

  it('cancel: outside the late window and with no money held, confirmed by the reply number, with the notice', async () => {
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-16T09:00:00-04:00' })
    const probe = await trustedMaria()
    expect(await run('propose_cancel', probe, { appointmentRef: 'A1', reason: 'out of town' })).toMatchObject({ ok: true, data: { summary: 'Cancel your Express Hand Wash on Tue Jun 16 at 9:00 AM' } })
    await reply(maria().phone, await lastCode(maria().phone), maria().id)
    expect((await w.t.db.selectFrom('appointments').select('status').where('id', '=', appt).executeTakeFirstOrThrow()).status).toBe('canceled')
    expect((await aiTexts(maria().id)).some((m) => /has been canceled/.test(m.body))).toBe(true)
  })

  it('cancel inside the late window goes to staff (handoff), with no proposal', async () => {
    await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T15:00:00-04:00' })
    const probe = await trustedMaria()
    const r = await run('propose_cancel', probe, { appointmentRef: 'A1', reason: 'sick' })
    expect(r).toMatchObject({ ok: false, error: 'not_allowed', handoff: { reason: 'late_cancel' } })
    expect(probe.handoffs).toMatchObject([{ reason: 'late_cancel' }])
    expect(await pending()).toEqual([])
  })

  it('a ref never reaches another client’s visit', async () => {
    await w.appointment({ customer: 'David Okafor', at: '2026-06-16T09:00:00-04:00' })
    const probe = await trustedMaria()
    expect(await run('propose_cancel', probe, { appointmentRef: 'A1', reason: 'x' })).toMatchObject({ ok: false, error: 'not_found' })
  })
})
