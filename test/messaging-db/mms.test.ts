// Inbound MMS through the real webhook path (ADR 0151). Production finding 2026-10-10: the owner's plain "OK" reached the tablet
// as MMS and never reached the server. mms:downloaded is now routed exactly like sms:received (keywords, quarantine,
// attribution); pictures are saved in the photos store; an MMS with no text is filed under a placeholder and announced;
// anything signed that Oasis cannot use is kept in webhook_log as 'unparsed'.
import { afterEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import type { ObjectStorage } from '../../src/integrations/storage/types.js'
import { buildHooksApp, type HooksApp } from '../../src/modules/messaging/http/hooks-app.js'
import { MMS_MAX_PICTURE_BYTES, PICTURE_MESSAGE_TEXT, PICTURE_UNAVAILABLE_TEXT } from '../../src/modules/messaging/inbound/mms.js'
import { runMaintenancePurge } from '../../src/platform/maintenance.js'
import { STRANGER, useWorld } from './world.js'

// ---- a photos store that keeps objects in memory -------------------------------------------------------------------
const objects = new Map<string, { body: Buffer; contentType: string }>()
let storageDown = false
const fakeStorage: ObjectStorage = {
  createUpload: () => Promise.reject(new Error('not used')),
  head: async (key) => {
    const o = objects.get(key)
    return o ? { bytes: o.body.length, contentType: o.contentType } : null
  },
  getDownloadUrl: async (key) => `https://photos.invalid/${key}?signed`,
  delete: async (key) => void objects.delete(key),
  get: async (key) => {
    const o = objects.get(key)
    if (!o) throw new Error('no such object')
    return o.body
  },
  put: async (key, body, contentType) => {
    if (storageDown) throw new Error('S3 is unreachable')
    objects.set(key, { body, contentType })
  },
}

const warnings: Array<{ obj: unknown; msg?: string }> = []
const logger = { info: () => undefined, warn: (obj: unknown, msg?: string) => void warnings.push({ obj, msg }), error: () => undefined }

const w = useWorld({ deps: { storage: fakeStorage, logger } })
afterEach(() => {
  objects.clear()
  storageDown = false
  warnings.length = 0
})

// 1x1-ish JPEG and PNG headers: the store checks the bytes (sniff), not only the declared type
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex')
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const GIF = Buffer.from('47494638396101000100', 'hex')
const b64 = (b: Buffer): string => b.toString('base64')

let n = 0
interface MmsOpts {
  body?: string | null
  subject?: string | null
  attachments?: Array<{ contentType: string; name?: string; data: string | null; size?: number }>
  messageId?: string
  envelopeId?: string
  /** Which field carries the sender: the docs show both. */
  senderField?: 'sender' | 'phoneNumber' | 'none'
}

function mmsPayload(from: string, o: MmsOpts = {}): Record<string, unknown> {
  n += 1
  const field = o.senderField ?? 'sender'
  return {
    messageId: o.messageId ?? `mms-${n}`,
    ...(field === 'none' ? {} : { [field]: from }),
    recipient: '+15555550100',
    simNumber: 1,
    body: o.body === undefined ? null : o.body,
    subject: o.subject === undefined ? null : o.subject,
    attachments: (o.attachments ?? []).map((a, i) => ({ partId: String(i + 1), contentType: a.contentType, name: a.name ?? `part${i + 1}`, size: a.size ?? 0, data: a.data })),
    receivedAt: w.clock.now().toISOString(),
  }
}

async function deliver(event: string, payload: Record<string, unknown>, id?: string) {
  const ev = w.signed(event, payload, id ? { id } : {})
  const res = await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
  await w.settle()
  return { res, ev }
}

const mms = (from: string, o: MmsOpts = {}) => deliver('mms:downloaded', mmsPayload(from, o), o.envelopeId)
const sms = (from: string, text: string) =>
  deliver('sms:received', { messageId: `sms-${++n}`, sender: from, recipient: '+15555550100', simNumber: 1, message: text, receivedAt: w.clock.now().toISOString() })

const maria = (): string => w.customer('Maria Delgado').phone
const inMessages = () =>
  w.t.db
    .selectFrom('messages')
    .select(['id', 'customer_id', 'appointment_id', 'body', 'kind', 'attachments', 'read_at', 'channel', 'status'])
    .where('direction', '=', 'in')
    .orderBy('queued_at')
    .orderBy('id')
    .execute()
const notices = () => w.t.db.selectFrom('notifications').select(['kind', 'title', 'body', 'entity_type', 'entity_id']).execute()
const inbox = () => w.t.db.selectFrom('sms_inbox').selectAll().orderBy('received_at').orderBy('id').execute()

describe('an MMS reply is routed exactly like an SMS', () => {
  it('"OK" by MMS lands in the thread of the same appointment an SMS would, marked mms, with its parts recorded', async () => {
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    const { res } = await mms(maria(), {
      body: ' OK \n',
      messageId: 'mms-ok-1',
      attachments: [
        { contentType: 'image/jpeg', name: 'IMG_0001.jpg', data: b64(JPEG) },
        { contentType: 'text/plain', name: 'text_0.txt', data: b64(Buffer.from('OK')), size: 2 },
      ],
    })
    expect(res).toEqual({ status: 200, body: { ok: true, status: 'accepted' } })

    const [m] = await inMessages()
    expect(m).toMatchObject({ customer_id: w.customer('Maria Delgado').id, appointment_id: appt, body: 'OK', kind: 'mms', channel: 'sms', status: 'received', read_at: null })
    const key = `messaging/mms/${w.locationId}/mms-ok-1/0.jpg`
    expect(m!.attachments).toEqual([
      { index: 0, partId: '1', name: 'IMG_0001.jpg', contentType: 'image/jpeg', size: JPEG.length, status: 'stored', reason: null, key },
      { index: 1, partId: '2', name: 'text_0.txt', contentType: 'text/plain', size: 2, status: 'listed', reason: null, key: null },
    ])
    expect(objects.get(key)).toEqual({ body: JPEG, contentType: 'image/jpeg' })
    expect([...objects.keys()]).toEqual([key])

    const log = await w.t.db.selectFrom('activity_log').select(['text', 'actor_type']).where('appointment_id', '=', appt).execute()
    expect(log).toContainEqual({ text: 'Customer replied by MMS', actor_type: 'customer' })
    const [row] = await inbox()
    expect(row).toMatchObject({ kind: 'mms', body: 'OK', decision: 'message', quarantined: false, appointment_id: appt, message_id: m!.id })
    expect(row!.attachments).toEqual(m!.attachments)

    // the thread read model and the SSE event say mms and list the parts, never the storage key
    const ev = await w.t.db.selectFrom('realtime_events').select('payload').where('type', '=', 'message.in').executeTakeFirstOrThrow()
    expect(ev.payload).toMatchObject({
      text: 'OK',
      kind: 'mms',
      appointmentId: appt,
      attachments: [
        { index: 0, name: 'IMG_0001.jpg', contentType: 'image/jpeg', size: JPEG.length, status: 'stored' },
        { index: 1, name: 'text_0.txt', contentType: 'text/plain', size: 2, status: 'listed' },
      ],
    })
    expect(JSON.stringify(ev.payload)).not.toContain('messaging/mms/')
  })

  it('makes the same routing decision as the SMS it replaces (attribution, unread, alert)', async () => {
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    await sms(maria(), 'OK')
    await mms(maria(), { body: 'OK' })
    const rows = await inbox()
    expect(rows.map((r) => [r.kind, r.decision, r.quarantined, r.appointment_id])).toEqual([
      ['sms', 'message', false, appt],
      ['mms', 'message', false, appt],
    ])
    const msgs = await inMessages()
    expect(msgs.map((m) => [m.kind, m.appointment_id, m.read_at])).toEqual([
      ['sms', appt, null],
      ['mms', appt, null],
    ])
  })

  it('STOP by MMS (sender in phoneNumber) opts the number out and queues the one confirmation', async () => {
    await mms(maria(), { body: 'STOP', senderField: 'phoneNumber' })
    expect(await w.t.db.selectFrom('sms_opt_outs').select(['phone_e164', 'source', 'keyword']).execute()).toEqual([{ phone_e164: maria(), source: 'keyword', keyword: 'STOP' }])
    const msgs = await w.messagesOf('Maria Delgado')
    expect(msgs.map((m) => [m.direction, m.template_key])).toEqual([
      ['in', null],
      ['out', 'opt_out_confirm'],
    ])
    expect((await inbox())[0]).toMatchObject({ kind: 'mms', decision: 'opt_out' })
  })

  it('STOP by MMS from a stranger is honoured by number too', async () => {
    await mms(STRANGER, { body: 'stop' })
    expect(await w.t.db.selectFrom('sms_opt_outs').select('phone_e164').execute()).toEqual([{ phone_e164: STRANGER }])
    expect(await w.t.db.selectFrom('sms_outbox').select(['to_e164', 'klass']).execute()).toEqual([{ to_e164: STRANGER, klass: 'opt_out_confirm' }])
  })

  it('C by MMS confirms the next appointment through the scheduling command and sends one confirm_ack', async () => {
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    await mms(maria(), { body: 'C' })
    expect((await w.t.db.selectFrom('appointments').select('status').where('id', '=', appt).executeTakeFirstOrThrow()).status).toBe('confirmed')
    const outs = (await w.messagesOf('Maria Delgado')).filter((m) => m.direction === 'out')
    expect(outs.map((m) => m.template_key)).toEqual(['confirm_ack'])
    expect((await inbox())[0]).toMatchObject({ kind: 'mms', decision: 'confirm' })
  })

  it('uses the subject when the body is empty (some phones put a short reply there)', async () => {
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    await mms(maria(), { body: '', subject: 'C' })
    expect((await w.t.db.selectFrom('appointments').select('status').where('id', '=', appt).executeTakeFirstOrThrow()).status).toBe('confirmed')
  })

  it('an MMS from the simulated tablet (mms:received then mms:downloaded) files one message', async () => {
    const sim = await w.sim()
    sim.injectMms(maria(), { body: 'Running late', attachments: [{ contentType: 'image/png', name: 'map.png', data: b64(PNG) }] })
    await w.settle()
    const msgs = await inMessages()
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ body: 'Running late', kind: 'mms' })
    expect(objects.size).toBe(1)
    const logged = await w.t.db.selectFrom('webhook_log').select('status').execute()
    expect(logged.map((r) => r.status).sort()).toEqual(['processed', 'processed'])
  })
})

describe('an MMS with no text', () => {
  it('a picture from a customer is filed as "[Picture message]", the picture saved, and managers told to look', async () => {
    await mms(maria(), { messageId: 'pic-1', attachments: [{ contentType: 'image/jpeg', name: 'car.jpg', data: b64(JPEG) }] })
    const [m] = await inMessages()
    expect(m).toMatchObject({ body: PICTURE_MESSAGE_TEXT, kind: 'mms', customer_id: w.customer('Maria Delgado').id, read_at: null })
    expect(objects.has(`messaging/mms/${w.locationId}/pic-1/0.jpg`)).toBe(true)
    const notes = await notices()
    expect(notes.length).toBeGreaterThan(0)
    expect(notes.every((x) => x.kind === 'sms.picture_message')).toBe(true)
    expect(notes[0]).toMatchObject({
      title: 'Picture message from Maria Delgado — check the tablet / dashboard',
      body: PICTURE_MESSAGE_TEXT,
      entity_type: 'customer',
      entity_id: w.customer('Maria Delgado').id,
    })
  })

  it('a picture attributed to an appointment points the alert at the appointment', async () => {
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    await mms(maria(), { attachments: [{ contentType: 'image/jpeg', data: b64(JPEG) }] })
    expect((await inMessages())[0]).toMatchObject({ appointment_id: appt })
    const notes = await notices()
    expect(notes.length).toBeGreaterThan(0)
    expect(notes.every((x) => x.kind === 'sms.picture_message' && x.entity_type === 'appointment' && x.entity_id === appt)).toBe(true)
  })

  it('a picture from a stranger stays quarantined, but the picture is kept and the alert names the masked number', async () => {
    await mms(STRANGER, { attachments: [{ contentType: 'image/jpeg', data: b64(JPEG) }] })
    expect(await inMessages()).toEqual([])
    const [row] = await inbox()
    expect(row).toMatchObject({ kind: 'mms', body: PICTURE_MESSAGE_TEXT, quarantined: true, decision: 'quarantined' })
    expect(row!.attachments?.[0]).toMatchObject({ status: 'stored' })
    expect(objects.size).toBe(1)
    const notes = await notices()
    expect(notes.length).toBeGreaterThan(0)
    expect(notes[0]!.title).toBe('Picture message from +1******0199 — check the tablet / dashboard')
    expect(notes[0]!.title).not.toContain(STRANGER)
    expect(notes[0]).toMatchObject({ kind: 'sms.picture_message', entity_type: null, entity_id: null })
  })

  it('an MMS whose content never arrived ("content incomplete", no sender) is stored with a placeholder and announced, never dropped', async () => {
    await mms('', { senderField: 'none', body: null, attachments: [] })
    const [row] = await inbox()
    expect(row).toMatchObject({ kind: 'mms', from_raw: 'unknown', body: PICTURE_UNAVAILABLE_TEXT, quarantined: true })
    const notes = await notices()
    expect(notes.length).toBeGreaterThan(0)
    expect(notes[0]).toMatchObject({ kind: 'sms.picture_message', title: 'Picture message from an unknown sender — check the tablet / dashboard', body: PICTURE_UNAVAILABLE_TEXT })
  })

  it('the same from a customer lands in the thread with the placeholder and the alert', async () => {
    await mms(maria(), { body: null })
    expect((await inMessages())[0]).toMatchObject({ body: PICTURE_UNAVAILABLE_TEXT, kind: 'mms', attachments: null })
    expect((await notices()).every((x) => x.kind === 'sms.picture_message' && x.title.includes('Maria Delgado'))).toBe(true)
  })
})

describe('attachments', () => {
  it('saves at most five pictures of up to 5 MB, in formats the photos store takes; the rest are listed, broken ones unavailable', async () => {
    const big = Buffer.concat([JPEG.subarray(0, 3), Buffer.alloc(MMS_MAX_PICTURE_BYTES)])
    await mms(maria(), {
      body: 'pics',
      messageId: 'many',
      attachments: [
        { contentType: 'image/jpeg', data: b64(JPEG) },
        { contentType: 'image/jpeg', data: b64(big) },
        { contentType: 'image/gif', data: b64(GIF) },
        { contentType: 'image/jpeg', data: '%%%not base64%%%' },
        { contentType: 'image/jpeg', data: null },
        { contentType: 'image/png', data: b64(PNG) },
        { contentType: 'image/jpeg', data: b64(JPEG) },
        { contentType: 'image/jpeg', data: b64(JPEG) },
        { contentType: 'image/jpeg', data: b64(JPEG) },
        { contentType: 'image/jpeg', data: b64(JPEG) },
        { contentType: 'text/x-vcard', name: 'contact.vcf', data: b64(Buffer.from('BEGIN:VCARD')) },
      ],
    })
    const [m] = await inMessages()
    expect((m!.attachments ?? []).map((a) => [a.index, a.status, a.reason])).toEqual([
      [0, 'stored', null],
      [1, 'skipped', 'too_large'],
      [2, 'skipped', 'unsupported_type'],
      [3, 'unavailable', 'decode_failed'],
      [4, 'unavailable', 'missing'],
      [5, 'stored', null],
      [6, 'stored', null],
      [7, 'stored', null],
      [8, 'stored', null],
      [9, 'skipped', 'limit'],
      [10, 'listed', null],
    ])
    expect([...objects.keys()].sort()).toEqual(['0.jpg', '5.png', '6.jpg', '7.jpg', '8.jpg'].map((f) => `messaging/mms/${w.locationId}/many/${f}`))
    expect(m!.body).toBe('pics')
  })

  it('a storage failure loses the picture, never the text: the part is unavailable and the reply is still routed', async () => {
    storageDown = true
    await mms(maria(), { body: 'STOP', attachments: [{ contentType: 'image/jpeg', data: b64(JPEG) }] })
    expect(await w.t.db.selectFrom('sms_opt_outs').select('phone_e164').execute()).toHaveLength(1)
    expect((await inbox())[0]!.attachments).toEqual([expect.objectContaining({ status: 'unavailable', reason: 'storage_error', key: null })])
  })

  it('a device message id that is not a safe key segment still gives a safe, stable key', async () => {
    await mms(maria(), { body: 'x', messageId: '../../etc/passwd id#7', attachments: [{ contentType: 'image/jpeg', data: b64(JPEG) }] })
    const [key] = [...objects.keys()]
    expect(key).toMatch(new RegExp(`^messaging/mms/${w.locationId}/etcpasswdid7-[0-9a-f]{16}/0\\.jpg$`))
  })

  it('the stored webhook_log copy of an applied mms:downloaded no longer holds the picture bytes', async () => {
    await mms(maria(), { body: 'OK', attachments: [{ contentType: 'image/jpeg', data: b64(JPEG) }] })
    const row = await w.t.db.selectFrom('webhook_log').select(['status', 'body']).executeTakeFirstOrThrow()
    expect(row.status).toBe('processed')
    expect(row.body).not.toContain(b64(JPEG))
    expect(JSON.parse(row.body!).payload.attachments[0]).toMatchObject({ data: null, dataRedacted: true, contentType: 'image/jpeg' })
  })
})

describe('dedupe and mms:received', () => {
  it('mms:received alone records the delivery and files no message', async () => {
    const { res } = await deliver('mms:received', { messageId: 'pending-1', sender: maria(), recipient: '+15555550100', simNumber: 1, transactionId: 'T1', subject: null, size: 1234, contentClass: null, receivedAt: w.clock.now().toISOString() })
    expect(res).toEqual({ status: 200, body: { ok: true, status: 'accepted' } })
    expect(await inMessages()).toEqual([])
    expect(await inbox()).toEqual([])
    expect(await notices()).toEqual([])
    expect((await w.t.db.selectFrom('webhook_log').select('status').executeTakeFirstOrThrow()).status).toBe('processed')
  })

  it('a repeated mms:downloaded (same envelope, or a new envelope for the same message) files one message', async () => {
    const payload = mmsPayload(maria(), { body: 'OK', messageId: 'dup-1', attachments: [{ contentType: 'image/jpeg', data: b64(JPEG) }] })
    const first = await deliver('mms:downloaded', payload, 'env-dup-1')
    const again = await deliver('mms:downloaded', payload, 'env-dup-1')
    const other = await deliver('mms:downloaded', payload, 'env-dup-2')
    expect([first.res.body.status, again.res.body.status, other.res.body.status]).toEqual(['accepted', 'duplicate', 'accepted'])
    expect(await inMessages()).toHaveLength(1)
    expect(await inbox()).toHaveLength(1)
    expect(objects.size).toBe(1)
  })
})

describe('diagnostics: signed deliveries Oasis cannot use', () => {
  it('an unknown event is answered 200 (no retries) and kept as unparsed, body cut to 4 KB, logged by event name only', async () => {
    const payload = { messageId: 'b1', filler: 'x'.repeat(10_000), secret: 'customer text here' }
    const { res, ev } = await deliver('sms:batch:received', payload)
    expect(res).toEqual({ status: 200, body: { ok: true, status: 'ignored' } })
    const row = await w.t.db.selectFrom('webhook_log').selectAll().executeTakeFirstOrThrow()
    expect(row).toMatchObject({ provider: 'smsgate', external_id: ev.id, status: 'unparsed', signature_valid: true })
    expect(Buffer.byteLength(row.body!, 'utf8')).toBe(4096)
    expect(ev.body.startsWith(row.body!)).toBe(true)
    expect(row.error).toMatch(/^unsupported_event: /)
    expect(row.headers).toMatchObject({ 'x-device-key': SIM_DEVICE_KEY, 'x-event': 'sms:batch:received' })
    const warned = warnings.find((x) => x.msg?.includes('not parsed'))
    expect(warned?.obj).toEqual({ device: SIM_DEVICE_KEY, event: 'sms:batch:received', code: 'unsupported_event' })
    expect(JSON.stringify(warnings)).not.toContain('customer text here')
    // a retry of the same delivery adds nothing
    await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
    expect(await w.t.db.selectFrom('webhook_log').select('id').execute()).toHaveLength(1)
  })

  it('a signed payload it cannot read is answered 400 and kept as unparsed too', async () => {
    const { res, ev } = await deliver('mms:downloaded', { sender: maria(), body: 'no message id' })
    expect(res.status).toBe(400)
    const row = await w.t.db.selectFrom('webhook_log').selectAll().executeTakeFirstOrThrow()
    expect(row).toMatchObject({ external_id: ev.id, status: 'unparsed', body: ev.body })
    expect(row.error).toMatch(/^bad_body: /)
    expect(await inbox()).toEqual([])
  })

  it('an unsigned delivery is still rejected and stored nowhere', async () => {
    const ev = w.signed('sms:batch:received', { x: 1 }, { secret: 'not-the-key' })
    expect((await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)).status).toBe(401)
    expect(await w.t.db.selectFrom('webhook_log').select('id').execute()).toEqual([])
  })

  it('maintenance.purge drops unparsed rows after 7 days and keeps the others for 90', async () => {
    const now = w.clock.now().getTime()
    const at = (days: number): Date => new Date(now - days * 86_400_000)
    const row = (external: string, status: string, days: number) =>
      sql`insert into webhook_log (id, provider, external_id, headers, body, signature_valid, received_at, status)
        values (${w.newId()}, 'smsgate', ${external}, '{}'::jsonb, '{}', true, ${at(days)}, ${status})`.execute(w.t.db)
    await row('unparsed-old', 'unparsed', 8)
    await row('unparsed-new', 'unparsed', 6)
    await row('processed-8', 'processed', 8)
    await row('processed-91', 'processed', 91)
    const removed = await runMaintenancePurge(w.t.db, w.clock)
    expect(removed.webhook_log).toBe(2)
    const left = await w.t.db.selectFrom('webhook_log').select('external_id').orderBy('external_id').execute()
    expect(left.map((r) => r.external_id)).toEqual(['processed-8', 'unparsed-new'])
  })
})

describe('the hooks listener body limit', () => {
  const listeners: HooksApp[] = []
  afterEach(async () => {
    await Promise.all(listeners.splice(0).map((h) => h.close()))
  })

  it('takes an MMS body of several MB on /hooks/smsgate and answers 413 above 16 MB', async () => {
    const hooks = await buildHooksApp(w.rt, { host: '127.0.0.1', port: 0 })
    listeners.push(hooks)
    const base = await hooks.listen()
    // ~3 MB picture: three times the 1 MB every other webhook route accepts
    const picture = Buffer.concat([JPEG.subarray(0, 3), Buffer.alloc(2_300_000, 7)])
    const ok = w.signed('mms:downloaded', mmsPayload(maria(), { body: 'OK', attachments: [{ contentType: 'image/jpeg', data: b64(picture) }] }))
    expect(ok.body.length).toBeGreaterThan(3_000_000)
    const r1 = await fetch(`${base}/hooks/smsgate/${SIM_DEVICE_KEY}`, { method: 'POST', headers: ok.headers, body: ok.body })
    expect(r1.status).toBe(200)
    await w.settle()
    expect(await inMessages()).toHaveLength(1)
    expect(objects.size).toBe(1)

    const huge = w.signed('mms:downloaded', mmsPayload(maria(), { body: 'big', attachments: [{ contentType: 'image/jpeg', data: 'A'.repeat(17 * 1024 * 1024) }] }))
    const r2 = await fetch(`${base}/hooks/smsgate/${SIM_DEVICE_KEY}`, { method: 'POST', headers: huge.headers, body: huge.body })
    expect(r2.status).toBe(413)
    expect(await r2.json()).toEqual({ ok: false, status: 'payload_too_large' })
    expect(await w.t.db.selectFrom('webhook_log').select('id').execute()).toHaveLength(1)
  })
})
