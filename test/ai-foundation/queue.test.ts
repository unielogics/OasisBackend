// The outbound queue's AI-foundation rules on Postgres (ADR 0160): the AI's replies need a recent inbound text from that number
// (loaded from sms_inbox by enqueueFor, strangers included), links and reply numbers reach the outbox but the message row and the
// event stream carry them masked, and a message the AI wrote reads as "Oasis AI".
import { describe, expect, it } from 'vitest'
import { loadMessageDto } from '../../src/modules/messaging/db/messages.js'
import type { EnqueueArgs } from '../../src/modules/messaging/queue.js'
import { STRANGER, useWorld } from '../messaging-db/world.js'

const w = useWorld()
let k = 0

const inbound = async (phone: string, minutesAgo: number): Promise<void> => {
  const dev = await w.device()
  await w.t.db
    .insertInto('sms_inbox')
    .values({
      id: w.newId(),
      device_id: dev.id,
      provider_message_id: `in-${++k}`,
      from_raw: phone,
      from_e164: phone,
      body: 'hello',
      device_received_at: new Date(w.clock.now().getTime() - minutesAgo * 60_000),
      received_at: new Date(w.clock.now().getTime() - minutesAgo * 60_000),
    })
    .execute()
}

const send = (over: Partial<EnqueueArgs>) =>
  w.tx((tx) =>
    w.rt.queue.enqueueFor(tx, {
      locationId: w.locationId,
      customerId: null,
      recipient: { kind: 'customer', phone: STRANGER, smsOptIn: false, activeOptOut: false, synthetic: false },
      appointmentId: null,
      purpose: 'test',
      senderKind: 'ai',
      dedupeKey: `q-${++k}`,
      ...over,
    }),
  )

describe('reply-only classes in enqueueFor', () => {
  it('an AI reply to a stranger goes only within 15 minutes of their text; a caller cannot claim one', async () => {
    const none = await send({ text: 'We open at 8 AM.', klass: 'ai_reply', recipient: { kind: 'customer', phone: STRANGER, smsOptIn: false, activeOptOut: false, synthetic: false, lastInboundAt: w.clock.now() } })
    expect(none).toEqual({ queued: false, skipped: 'no_recent_inbound' })
    await inbound(STRANGER, 20)
    expect(await send({ text: 'We open at 8 AM.', klass: 'ai_reply' })).toMatchObject({ queued: false, skipped: 'no_recent_inbound' })
    await inbound(STRANGER, 2)
    const ok = await send({ text: 'We open at 8 AM.', klass: 'ai_reply' })
    expect(ok).toMatchObject({ queued: true })
    const row = await w.t.db.selectFrom('messages').select(['sender_kind', 'klass', 'body']).where('id', '=', (ok as { messageId: string }).messageId).executeTakeFirstOrThrow()
    expect(row).toMatchObject({ sender_kind: 'ai', klass: 'ai_reply' })
    expect(await send({ templateKey: 'ai_fallback' })).toMatchObject({ queued: true })
  })

  it('never to an opted-out number, however recent the text', async () => {
    await inbound(STRANGER, 1)
    const r = await send({ text: 'Hi!', klass: 'ai_reply', recipient: { kind: 'customer', phone: STRANGER, smsOptIn: false, activeOptOut: true, synthetic: false } })
    expect(r).toEqual({ queued: false, skipped: 'opted_out' })
  })
})

describe('secret variables', () => {
  it('a personal link: the outbox has the URL, the message row and its DTO show it masked', async () => {
    const maria = w.customer('Maria Delgado')
    const url = 'https://oasisautospanj.com/#/c/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde'
    const r = await w.tx((tx) =>
      w.rt.queue.enqueueFor(tx, {
        locationId: w.locationId,
        customerId: maria.id,
        recipient: { kind: 'customer', phone: maria.phone, smsOptIn: true, activeOptOut: false, synthetic: false, consentSource: 'inbound_text' },
        appointmentId: null,
        templateKey: 'personal_link_calendar',
        vars: { first: 'Maria' },
        secretVars: { link: url },
        purpose: 'link',
        senderKind: 'ai',
        dedupeKey: `q-${++k}`,
      }),
    )
    expect(r).toMatchObject({ queued: true })
    const id = (r as { messageId: string }).messageId
    const msg = await w.t.db.selectFrom('messages').select('body').where('id', '=', id).executeTakeFirstOrThrow()
    const out = await w.t.db.selectFrom('sms_outbox').select('body').where('id', '=', id).executeTakeFirstOrThrow()
    expect(out.body).toContain(url)
    expect(msg.body).not.toContain('AbCdEf')
    expect(msg.body).toContain('Here is your personal Oasis Auto Spa booking link, Maria: [private link]')
    const events = await w.t.db.selectFrom('realtime_events').select('payload').where('type', '=', 'message.out').execute()
    expect(JSON.stringify(events)).not.toContain('AbCdEf')
    expect(events.length).toBe(1)
    const dto = (await loadMessageDto(w.t.db, id))!.dto
    expect(dto).toMatchObject({ from: 'system', author: 'ai', senderName: 'Oasis AI' })
  })

  it('a reply number: masked in the row, real in the outbox; secret variables need a class whose outbox is wiped', async () => {
    const maria = w.customer('Maria Delgado')
    await inbound(maria.phone, 1)
    const r = await w.tx((tx) =>
      w.rt.queue.enqueueFor(tx, {
        locationId: w.locationId,
        customerId: maria.id,
        recipient: { kind: 'customer', phone: maria.phone, smsOptIn: true, activeOptOut: false, synthetic: false },
        appointmentId: null,
        templateKey: 'action_confirm',
        vars: { summary: 'Signature Wash, Sat 10:00 AM' },
        secretVars: { code: '4821' },
        purpose: 'action',
        senderKind: 'system',
        dedupeKey: `q-${++k}`,
      }),
    )
    const id = (r as { messageId: string }).messageId
    expect((await w.t.db.selectFrom('messages').select('body').where('id', '=', id).executeTakeFirstOrThrow()).body).toMatch(/^Signature Wash, Sat 10:00 AM\. Reply \[code\] to confirm\./)
    expect((await w.t.db.selectFrom('sms_outbox').select('body').where('id', '=', id).executeTakeFirstOrThrow()).body).toMatch(/Reply 4821 to confirm\./)
    await expect(send({ text: 'Your link: {link}', klass: 'ai_reply', secretVars: { link: 'https://x.test/t' } })).rejects.toThrow(/secretVars/)
  })
})

describe('consent of a client the assistant created', () => {
  it('no broadcast for an inbound_text client; a transactional text goes', async () => {
    const maria = w.customer('Maria Delgado')
    await w.t.db.updateTable('customers').set({ sms_opted_in: true, sms_opt_in_source: 'inbound_text' }).where('id', '=', maria.id).execute()
    const target = (await w.rt.queue.target(w.t.db, w.locationId, maria.id))!
    expect(target.recipient.consentSource).toBe('inbound_text')
    const base = { locationId: w.locationId, customerId: maria.id, recipient: target.recipient, appointmentId: null, purpose: 'test', senderKind: 'system' as const }
    expect(await w.tx((tx) => w.rt.queue.enqueueFor(tx, { ...base, text: 'Spring sale!', klass: 'broadcast', dedupeKey: `q-${++k}` }))).toEqual({
      queued: false,
      skipped: 'consent_source_insufficient',
    })
    expect(await w.tx((tx) => w.rt.queue.enqueueFor(tx, { ...base, templateKey: 'ready', dedupeKey: `q-${++k}` }))).toMatchObject({ queued: true })
  })
})
