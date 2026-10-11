// The welcome flow's first step (ADR 0160, owner 2026-10-11; the W2d NewTexters port; wave W3b): the first text the gate admits from
// a number with no client creates the provisional client "New texter ••NNNN" (source inbound_sms, consent inbound_text: never
// marketing, needs_details) and its lead in the webhook's transaction, once per number; off by default; an archived one comes back.
import { describe, expect, it } from 'vitest'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { createNewTexters } from '../../src/modules/assistant/welcome/new-texters.js'
import { archiveStaleProvisionalClients, isProvisionalClient, provisionalName } from '../../src/modules/assistant/welcome/provisional.js'
import { canSendSms } from '../../src/modules/messaging/policy/canSend.js'
import { loadCustomerTarget } from '../../src/modules/messaging/db/recipients.js'
import { STRANGER, STRANGER2, useToolWorld } from './world.js'

const w = useToolWorld()
let n = 0

async function inbound(phone: string, text: string) {
  n += 1
  const ev = w.signed('sms:received', { messageId: `welcome-${n}`, sender: phone, recipient: '+18623885827', simNumber: 1, message: text, receivedAt: w.clock.now().toISOString() })
  await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
  await w.settle()
}

const clientsOf = (phone: string) =>
  w.t.db
    .selectFrom('customers')
    .select(['id', 'full_name', 'source', 'sms_opted_in', 'sms_opt_in_source', 'needs_details', 'deleted_at', 'archived_at', 'synthetic'])
    .where('phone_e164', '=', phone)
    .execute()

describe('NewTexters.adopt through the webhook', () => {
  it('does nothing while the assistant is off (the default): no client, no lead', async () => {
    w.rt.useAssistant({ newTexters: createNewTexters(w.deps) })
    await inbound(STRANGER, 'How much is a wash?')
    expect(await clientsOf(STRANGER)).toEqual([])
    expect(await w.t.db.selectFrom('leads').select('id').execute()).toEqual([])
    // called directly while off it adopts nobody either
    expect(await w.tx((tx) => createNewTexters(w.deps).adopt(tx, { locationId: w.locationId, phone: STRANGER, inboxId: w.newId(), receivedAt: w.clock.now() }))).toBeNull()
  })

  it('creates the provisional client and its lead at the first text, files the text in its thread, once per number', async () => {
    await w.assistantOn()
    w.rt.useAssistant({ newTexters: createNewTexters(w.deps) })
    await inbound(STRANGER, 'How much is a wash?')
    await inbound(STRANGER, 'And tint?')
    const [c, ...more] = await clientsOf(STRANGER)
    expect(more).toEqual([])
    expect(c).toMatchObject({
      full_name: 'New texter ••0199',
      source: 'inbound_sms',
      sms_opted_in: true,
      sms_opt_in_source: 'inbound_text',
      needs_details: true,
      deleted_at: null,
      synthetic: false,
    })
    expect(provisionalName(STRANGER)).toBe('New texter ••0199')
    expect(await isProvisionalClient(w.t.db, c!.id)).toBe(true)
    const thread = await w.t.db.selectFrom('messages').select(['body', 'direction']).where('customer_id', '=', c!.id).orderBy('received_at').execute()
    expect(thread).toEqual([
      { body: 'How much is a wash?', direction: 'in' },
      { body: 'And tint?', direction: 'in' },
    ])
    const lead = await w.t.db.selectFrom('leads').selectAll().executeTakeFirstOrThrow()
    expect(lead).toMatchObject({ phone_e164: STRANGER, customer_id: c!.id, source: 'text', status: 'new' })
    const conv = await w.t.db.selectFrom('assistant_conversations').select(['customer_id', 'pending_since']).where('phone_e164', '=', STRANGER).executeTakeFirstOrThrow()
    expect(conv.customer_id).toBe(c!.id)
    expect(await w.t.db.selectFrom('audit_log').select(['action', 'actor_name']).where('action', '=', 'assistant.client.created').execute()).toEqual([
      { action: 'assistant.client.created', actor_name: 'Oasis AI (SMS)' },
    ])
  })

  it('an AI-created client fails canSendSms for broadcasts (transactional consent only), and passes for a transactional text', async () => {
    await w.assistantOn()
    const adopted = await w.tx((tx) => createNewTexters(w.deps).adopt(tx, { locationId: w.locationId, phone: STRANGER2, inboxId: w.newId(), receivedAt: w.clock.now() }))
    const target = await loadCustomerTarget(w.t.db, w.locationId, adopted!.customerId)
    const ctx = { now: w.clock.now(), environment: 'test' as const, allowlist: [STRANGER2] }
    expect(canSendSms(target!.recipient, { klass: 'broadcast' }, ctx)).toMatchObject({ allowed: false })
    expect(canSendSms(target!.recipient, { klass: 'booking_thanks' }, ctx)).toMatchObject({ allowed: true })
  })

  it('a known client is never adopted again; an opted-out number gets a client without consent', async () => {
    await w.assistantOn()
    const maria = w.customer('Maria Delgado')
    const r = await w.tx((tx) => createNewTexters(w.deps).adopt(tx, { locationId: w.locationId, phone: maria.phone, inboxId: w.newId(), receivedAt: w.clock.now() }))
    expect(r).toEqual({ customerId: maria.id })
    expect(await clientsOf(maria.phone)).toHaveLength(1)
    await w.t.db.insertInto('sms_opt_outs').values({ id: w.newId(), location_id: w.locationId, phone_e164: STRANGER2, opted_out_at: w.clock.now(), source: 'keyword', keyword: 'STOP' }).execute()
    await w.tx((tx) => createNewTexters(w.deps).adopt(tx, { locationId: w.locationId, phone: STRANGER2, inboxId: w.newId(), receivedAt: w.clock.now() }))
    expect(await clientsOf(STRANGER2)).toMatchObject([{ sms_opted_in: false, sms_opt_in_source: null }])
  })

  it('an archived provisional client is restored (not duplicated) when the number texts again', async () => {
    await w.assistantOn()
    w.rt.useAssistant({ newTexters: createNewTexters(w.deps) })
    await inbound(STRANGER, 'hi')
    const [c] = await clientsOf(STRANGER)
    w.clock.advance(31 * 86_400_000)
    expect(await archiveStaleProvisionalClients(w.t.db, { now: w.clock.now() })).toEqual({ archived: 1 })
    expect(await clientsOf(STRANGER)).toMatchObject([{ id: c!.id, deleted_at: w.clock.now(), archived_at: w.clock.now() }])
    await inbound(STRANGER, 'hello again')
    expect(await clientsOf(STRANGER)).toMatchObject([{ id: c!.id, deleted_at: null, archived_at: null }])
    expect((await w.t.db.selectFrom('leads').select('status').executeTakeFirstOrThrow()).status).toBe('new')
  })
})
