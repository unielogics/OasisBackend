// The HTTP surface of messaging through the production module list (apiModules): the Messages tab, sending, templates,
// the outbox with retry/cancel, SMS consent, device administration and the dev helpers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { sql } from 'kysely'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { createPermissiveAuthorizer } from '../../src/http/authorizer.js'
import { apiModules } from '../../src/http/modules.js'
import { messagingRuntimeFor } from '../../src/composition.js'
import type { MessagingRuntime } from '../../src/modules/messaging/runtime.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { makeUser } from '../helpers/factories.js'
import { useWorld } from './world.js'

const w = useWorld()
let app: TestApp
let rt: MessagingRuntime
let keyN = 0

beforeAll(async () => {
  // the world's beforeAll hooks run first (registered earlier), so the schema and seed exist here
  const user = await makeUser(w.t.db, w.newId, { first: 'Desk', email: 'desk-routes@example.test' })
  app = await createTestApp({
    testDb: w.t,
    modules: apiModules,
    authorizer: (location) => createPermissiveAuthorizer({ locationId: location.id, userId: user.userId, employeeId: user.employeeId, actorName: 'Desk U.' }),
    env: { SMS_ALLOWLIST: w.env.SMS_ALLOWLIST, SMSGATE_MIN_INTERVAL_MS: '0', ALLOW_DEV_ENDPOINTS: 'true', EMAIL_CONSOLE_DIR: w.env.EMAIL_CONSOLE_DIR },
  })
  rt = messagingRuntimeFor({ db: w.t.db, clock: w.clock, env: app.env })
})
afterAll(async () => {
  await rt?.idle()
  await app?.close()
})

const key = (): string => `routes-key-${++keyN}-abcdefgh`
const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, body?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> =>
  app.app.inject({ method, url: `/api/v1${url}`, headers, ...(body !== undefined ? { payload: body as object } : {}) })
const post = (url: string, body?: unknown, k: string | null = key()) => call('POST', url, body, k ? { 'idempotency-key': k } : {})
const json = <T = Record<string, any>>(r: LightMyRequestResponse): T => r.json() as T // eslint-disable-line @typescript-eslint/no-explicit-any
const maria = (): { id: string; phone: string } => w.customer('Maria Delgado')

describe('the Messages tab', () => {
  it('shows an empty thread and whether a send would be accepted, without any phone number', async () => {
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    const res = await call('GET', `/appointments/${appt}/messages`)
    expect(res.statusCode).toBe(200)
    expect(json(res)).toEqual({
      items: [],
      customer: { id: maria().id, name: 'Maria Delgado', smsOptedIn: true, optedOut: false, hasPhone: true, canMessage: true },
      unread: 0,
    })
    expect(res.body).not.toContain(maria().phone)
    expect((await call('GET', '/appointments/00000000-0000-7000-8000-000000000000/messages')).statusCode).toBe(404)
  })

  it('sends free text as an SMS, files it under the appointment, logs it, and follows its delivery', async () => {
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    const res = await post(`/appointments/${appt}/messages`, { text: 'We have a bay open early if you want to come now.' })
    expect(res.statusCode).toBe(201)
    const b = json(res)
    expect(b).toMatchObject({ queued: true, held: false, holdUntil: null, segments: 1 })
    expect(b.message).toMatchObject({
      direction: 'out',
      from: 'staff',
      senderName: 'Desk',
      status: 'queued',
      channel: 'sms',
      appointmentId: appt,
      customerId: maria().id,
      templateKey: null,
      read: true,
    })
    expect(b.message.text).toContain('We have a bay open early')
    expect(b.message.text).toContain('Reply STOP to opt out.') // the first text to this number carries the footer
    const row = await w.t.db.selectFrom('messages').select(['klass', 'purpose', 'sender_kind', 'sender_employee_id']).where('id', '=', b.message.id).executeTakeFirstOrThrow()
    expect(row).toMatchObject({ klass: 'staff_message', purpose: 'staff', sender_kind: 'staff' })
    expect(row.sender_employee_id).not.toBeNull()
    expect((await w.t.db.selectFrom('activity_log').select(['text', 'channels']).where('appointment_id', '=', appt).execute())).toContainEqual({ text: 'Staff message sent', channels: ['sms'] })

    await rt.pollHealthAll()
    await rt.tickAll()
    await rt.idle()
    const thread = json(await call('GET', `/appointments/${appt}/messages`))
    expect(thread.items).toHaveLength(1)
    expect(thread.items[0]).toMatchObject({ id: b.message.id, status: 'delivered' })
  })

  it('sends a quick reply by key, and an automation by key with its variables filled from the appointment', async () => {
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    const quick = json(await post(`/appointments/${appt}/messages`, { templateKey: 'qr_ready_pickup' }))
    expect(quick.message).toMatchObject({ templateKey: 'qr_ready_pickup', from: 'staff' })
    expect(quick.message.text).toContain('Your vehicle is ready for pickup!')

    const nudge = json(await post(`/appointments/${appt}/messages`, { templateKey: 'late_nudge' }))
    expect(nudge.message.text).toContain('Hi Maria,')
    expect(nudge.message.text).toContain('2:00 PM')
    expect(await w.t.db.selectFrom('messages').select('klass').where('id', '=', nudge.message.id).executeTakeFirstOrThrow()).toEqual({ klass: 'late_nudge' })
  })

  it('refuses templates a person must not send and unknown ones', async () => {
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    for (const templateKey of ['opt_out_confirm', 'emergency', 'staff_invite', 'nope']) {
      const res = await post(`/appointments/${appt}/messages`, { templateKey })
      expect(res.statusCode, templateKey).toBe(422)
      expect(json(res).code).toBe('SMS_TEMPLATE_INVALID')
    }
    expect((await post(`/appointments/${appt}/messages`, { text: 'a', templateKey: 'ready' })).statusCode).toBe(422)
    expect((await post(`/appointments/${appt}/messages`, {})).statusCode).toBe(422)
    expect((await post(`/appointments/${appt}/messages`, { text: 'hi', extra: 1 })).statusCode).toBe(422)
  })

  it('answers 422 for a customer who opted out, one who never opted in, one with no number, and a message that is too long', async () => {
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    const send = (text = 'Hello there') => post(`/appointments/${appt}/messages`, { text })

    await sql`update customers set sms_opted_out_at = ${w.clock.now()} where id = ${maria().id}`.execute(w.t.db)
    let res = await send()
    expect(res.statusCode).toBe(422)
    expect(json(res)).toMatchObject({ code: 'SMS_OPTED_OUT', title: 'Customer opted out', detail: 'Maria Delgado texted STOP, so texts to this number are turned off' })
    expect(await w.t.db.selectFrom('messages').select('id').execute()).toEqual([])

    await sql`update customers set sms_opted_out_at = null, sms_opted_in = false where id = ${maria().id}`.execute(w.t.db)
    res = await send()
    expect(json(res)).toMatchObject({ code: 'SMS_NOT_OPTED_IN', title: 'Not opted in to texts' })

    await sql`update customers set sms_opted_in = true where id = ${maria().id}`.execute(w.t.db)
    res = await send('x'.repeat(1300))
    expect(res.statusCode).toBe(422)
    expect(json(res).code).toBe('SMS_TOO_LONG')
    expect(json(res).detail).toMatch(/\d+ text segments/)
    expect(json(res).detail).toContain('Shorten it to 8 or fewer')

    expect(json(await send('   ')).code).toBe('SMS_EMPTY')

    await sql`update customers set phone_e164 = null, synthetic = false where id = ${maria().id}`.execute(w.t.db)
    expect(json(await send()).code).toBe('SMS_NO_PHONE')
    await sql`update customers set phone_e164 = ${maria().phone} where id = ${maria().id}`.execute(w.t.db)
  })

  it('refuses a number outside the allow-list in this environment (seeds never text strangers)', async () => {
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    await sql`update customers set phone_e164 = '+13055550177' where id = ${maria().id}`.execute(w.t.db)
    const res = await post(`/appointments/${appt}/messages`, { text: 'Hello' })
    expect(res.statusCode).toBe(422)
    expect(json(res)).toMatchObject({ code: 'SMS_BLOCKED', detail: 'This is a seeded demo number and is never texted' })
    await sql`update customers set phone_e164 = ${maria().phone} where id = ${maria().id}`.execute(w.t.db)
  })

  it('needs an Idempotency-Key and replays the same response for the same one', async () => {
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    expect((await post(`/appointments/${appt}/messages`, { text: 'Hi' }, null)).statusCode).toBe(400)
    const k = key()
    const a = await post(`/appointments/${appt}/messages`, { text: 'Only once' }, k)
    const b = await post(`/appointments/${appt}/messages`, { text: 'Only once' }, k)
    expect(a.statusCode).toBe(201)
    expect(b.statusCode).toBe(201)
    expect(b.headers['idempotent-replayed']).toBe('true')
    expect(json(b).message.id).toBe(json(a).message.id)
    expect(await w.t.db.selectFrom('messages').select('id').execute()).toHaveLength(1)
    expect((await post(`/appointments/${appt}/messages`, { text: 'Different' }, k)).statusCode).toBe(422)
  })

  it('answering a customer marks their replies read and clears the unread alert', async () => {
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    const sim = rt.simulator((await rt.store.getByKey(SIM_DEVICE_KEY))!)!
    sim.injectInbound(maria().phone, 'Is my car ready?')
    await rt.idle()
    let thread = json(await call('GET', `/appointments/${appt}/messages`))
    expect(thread).toMatchObject({ unread: 1 })
    expect(thread.items[0]).toMatchObject({ direction: 'in', from: 'customer', read: false, text: 'Is my car ready?' })
    let alerts = json(await call('GET', '/ops/alerts')).alerts as Array<{ kind: string; appointmentId: string | null; title: string }>
    expect(alerts.find((a) => a.kind === 'new_reply')).toMatchObject({ appointmentId: appt, title: 'New reply · Maria Delgado' })

    // a plain read does not clear it; markRead=true or an answer does
    expect(json(await call('GET', `/appointments/${appt}/messages`)).unread).toBe(1)
    await post(`/appointments/${appt}/messages`, { text: 'Almost done!' })
    thread = json(await call('GET', `/appointments/${appt}/messages`))
    expect(thread.unread).toBe(0)
    expect(thread.items.map((m: { direction: string }) => m.direction)).toEqual(['in', 'out'])
    alerts = json(await call('GET', '/ops/alerts')).alerts
    expect(alerts.find((a) => a.kind === 'new_reply')).toBeUndefined()
    expect((await w.t.db.selectFrom('message_threads').select('unread_count').executeTakeFirstOrThrow()).unread_count).toBe(0)
  })

  it('marks a customer thread read on request, and lists every appointment\'s messages in the customer thread', async () => {
    const a1 = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    const a2 = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-20T10:00:00-04:00' })
    await post(`/appointments/${a1}/messages`, { text: 'First visit' })
    w.clock.advance(1000)
    await post(`/appointments/${a2}/messages`, { text: 'Second visit' })
    w.clock.advance(1000)
    const sim = rt.simulator((await rt.store.getByKey(SIM_DEVICE_KEY))!)!
    sim.injectInbound(maria().phone, 'Thanks!')
    await rt.idle()
    const thread = json(await call('GET', `/customers/${maria().id}/messages`))
    expect(thread.items.map((m: { text: string; appointmentId: string | null }) => [m.text.split(' Reply STOP')[0], m.appointmentId])).toEqual([
      ['First visit', a1],
      ['Second visit', a2],
      ['Thanks!', a1],
    ])
    expect(thread.unread).toBe(1)
    expect(json(await post(`/customers/${maria().id}/messages/read`, undefined, null))).toEqual({ marked: 1 })
    expect(json(await call('GET', `/customers/${maria().id}/messages?markRead=true`)).unread).toBe(0)
    expect((await call('GET', '/customers/00000000-0000-7000-8000-000000000000/messages')).statusCode).toBe(404)
  })
})

describe('templates', () => {
  it('lists the seven quick replies and the automations with lane, TTL and who may send them', async () => {
    const b = json(await call('GET', '/messages/templates'))
    expect(b.quickReplies).toHaveLength(7)
    expect(b.quickReplies[0]).toEqual({ key: 'qr_confirmed', label: 'Confirmed', text: 'Your appointment is confirmed. See you soon!' })
    const ready = b.templates.find((t: { key: string }) => t.key === 'ready')
    expect(ready).toMatchObject({ class: 'ready', lane: 0, ttlSeconds: 14400, transactional: true, staffSendable: true, editable: true })
    const reminder = b.templates.find((t: { key: string }) => t.key === 'reminder')
    expect(reminder).toMatchObject({ lane: 2, transactional: false })
    expect(b.templates.find((t: { key: string }) => t.key === 'opt_out_confirm')).toMatchObject({ staffSendable: false, editable: false })
    expect(b.templates.find((t: { key: string }) => t.key === 'welcome').body).toContain('Welcome to Oasis!')
    expect(JSON.stringify(b).toLowerCase()).not.toContain('whatsapp')
  })
})

describe('outbox: failed texts, retry and cancel', () => {
  async function failOne(): Promise<string> {
    const sim = rt.simulator((await rt.store.getByKey(SIM_DEVICE_KEY))!)!
    const real = sim.device.enqueue.bind(sim.device)
    sim.device.enqueue = () => ({ status: 400, body: { message: 'Invalid phone number' } })
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    const id = json(await post(`/appointments/${appt}/messages`, { text: 'Will bounce' })).message.id as string
    await rt.pollHealthAll()
    await rt.tickAll()
    sim.device.enqueue = real
    return id
  }

  it('lists failed texts with their error, masks the number without cli.contact, and retries one', async () => {
    const id = await failOne()
    const b = json(await call('GET', '/messages/outbox?state=failed'))
    expect(b.items).toHaveLength(1)
    expect(b.items[0]).toMatchObject({ id, state: 'failed', klass: 'staff_message', lane: 1, lastError: expect.stringContaining('Invalid phone number'), customerName: 'Maria Delgado', canRetry: true, canCancel: false })
    expect(b.items[0].to).toBe(maria().phone) // the test caller holds every permission, cli.contact included
    expect(json(await call('GET', '/messages/outbox?state=pending')).items).toEqual([])

    const retry = await post(`/messages/${id}/retry`, undefined, null)
    expect(retry.statusCode).toBe(200)
    expect(json(retry)).toEqual({ id, state: 'pending' })
    expect((await w.t.db.selectFrom('messages').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status).toBe('queued')
    expect(await w.t.db.selectFrom('audit_log').select('action').where('action', '=', 'message.retry').execute()).toHaveLength(1)

    await rt.tickAll()
    await rt.idle()
    expect((await w.t.db.selectFrom('messages').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status).toBe('delivered')
    expect((await post(`/messages/${id}/retry`, undefined, null)).statusCode).toBe(409)
  })

  it('cancels a queued text that has not been handed to the device, and refuses once it has', async () => {
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    const queued = json(await post(`/appointments/${appt}/messages`, { text: 'Hold on' })).message.id as string
    expect(json(await call('GET', '/messages/outbox?state=pending')).items[0]).toMatchObject({ id: queued, canCancel: true })
    const res = await post(`/messages/${queued}/cancel`, undefined, null)
    expect(json(res)).toEqual({ id: queued, state: 'cancelled' })
    expect((await w.t.db.selectFrom('messages').select('status').where('id', '=', queued).executeTakeFirstOrThrow()).status).toBe('canceled')
    expect((await post(`/messages/${queued}/cancel`, undefined, null)).statusCode).toBe(409)
    expect((await post('/messages/00000000-0000-7000-8000-000000000000/cancel', undefined, null)).statusCode).toBe(404)

    const sent = json(await post(`/appointments/${appt}/messages`, { text: 'Going out' })).message.id as string
    await rt.pollHealthAll()
    await rt.tickAll()
    expect(json(await post(`/messages/${sent}/cancel`, undefined, null)).code).toBe('MESSAGE_NOT_CANCELABLE')
  })

  it('pages the outbox with a cursor', async () => {
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    for (let i = 0; i < 3; i++) {
      await post(`/appointments/${appt}/messages`, { text: `Queued ${i}` })
      w.clock.advance(1000)
    }
    const first = json(await call('GET', '/messages/outbox?state=pending&limit=2'))
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toEqual(expect.any(String))
    const second = json(await call('GET', `/messages/outbox?state=pending&limit=2&cursor=${first.nextCursor}`))
    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.items, ...second.items].map((i: { id: string }) => i.id)).size).toBe(3)
  })
})

describe('quarantine inbox', () => {
  it('lists texts from unknown numbers, masks the sender without cli.contact semantics, and marks them reviewed', async () => {
    const sim = rt.simulator((await rt.store.getByKey(SIM_DEVICE_KEY))!)!
    sim.injectInbound('+13055550199', 'Your code is 424242')
    sim.injectInbound('22000', 'Carrier notice')
    await rt.idle()
    const b = json(await call('GET', '/messages/inbox'))
    expect(b.items).toHaveLength(2)
    expect(b.items.map((i: { reason: string }) => i.reason).sort()).toEqual(['not_a_phone_number', 'unknown_sender'])
    const review = await post(`/messages/inbox/${b.items[0].id}/review`, undefined, null)
    expect(review.statusCode).toBe(200)
    expect(json(await call('GET', '/messages/inbox')).items).toHaveLength(1)
    expect(await w.t.db.selectFrom('customers').select('id').where('phone_e164', '=', '+13055550199').execute()).toEqual([])
  })
})

describe('SMS consent', () => {
  it('reads consent and lets staff record an opt-in, a manual opt-out and lift it', async () => {
    const id = maria().id
    expect(json(await call('GET', `/customers/${id}/sms-consent`))).toMatchObject({ customerId: id, smsOptedIn: true, optedOut: false, optOutSource: null, staffCanClearOptOut: true, hasPhone: true })

    let res = await call('PUT', `/customers/${id}/sms-consent`, { optedOut: true })
    expect(res.statusCode).toBe(200)
    expect(json(res)).toMatchObject({ optedOut: true, optOutSource: 'manual', staffCanClearOptOut: true })
    expect(await w.t.db.selectFrom('sms_opt_outs').select(['phone_e164', 'source']).execute()).toEqual([{ phone_e164: maria().phone, source: 'manual' }])
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    expect(json(await post(`/appointments/${appt}/messages`, { text: 'Hello' })).code).toBe('SMS_OPTED_OUT')

    res = await call('PUT', `/customers/${id}/sms-consent`, { optedOut: false })
    expect(json(res)).toMatchObject({ optedOut: false })
    expect((await post(`/appointments/${appt}/messages`, { text: 'Hello again' })).statusCode).toBe(201)

    res = await call('PUT', `/customers/${id}/sms-consent`, { optedIn: false })
    expect(json(res)).toMatchObject({ smsOptedIn: false, optInSource: null })
    res = await call('PUT', `/customers/${id}/sms-consent`, { optedIn: true })
    expect(json(res)).toMatchObject({ smsOptedIn: true, optInSource: 'dashboard' })
    expect((await w.t.db.selectFrom('audit_log').select('action').where('action', '=', 'customer.sms_consent').execute()).length).toBe(4)
  })

  it('refuses to lift a STOP the customer texted: only START does', async () => {
    const id = maria().id
    const sim = rt.simulator((await rt.store.getByKey(SIM_DEVICE_KEY))!)!
    sim.injectInbound(maria().phone, 'STOP')
    await rt.idle()
    const read = json(await call('GET', `/customers/${id}/sms-consent`))
    expect(read).toMatchObject({ optedOut: true, optOutSource: 'keyword', staffCanClearOptOut: false })
    for (const body of [{ optedOut: false }, { optedIn: true }]) {
      const res = await call('PUT', `/customers/${id}/sms-consent`, body)
      expect(res.statusCode).toBe(422)
      expect(json(res)).toMatchObject({ code: 'SMS_STOP_ACTIVE', detail: 'They texted STOP. Only they can turn texts back on, by replying START' })
    }
    sim.injectInbound(maria().phone, 'START')
    await rt.idle()
    expect(json(await call('GET', `/customers/${id}/sms-consent`))).toMatchObject({ optedOut: false, smsOptedIn: true, optInSource: 'keyword' })
  })

  it('validates the body and 404s for an unknown customer', async () => {
    expect((await call('PUT', `/customers/${maria().id}/sms-consent`, {})).statusCode).toBe(422)
    expect((await call('PUT', '/customers/00000000-0000-7000-8000-000000000000/sms-consent', { optedIn: true })).statusCode).toBe(404)
  })
})

describe('device administration', () => {
  it('lists the seeded simulator device without any secret', async () => {
    const b = json(await call('GET', '/integrations/sms/devices'))
    expect(b.items).toHaveLength(1)
    expect(b.items[0]).toMatchObject({ key: SIM_DEVICE_KEY, provider: 'sim', enabled: true, hasPassword: false, status: 'unknown' })
    expect(JSON.stringify(b)).not.toMatch(/secret|password_enc|sim-signing-key/i)
  })

  it('creates an SMS Gate device (secret shown once, credentials encrypted), edits it, and never returns a credential', async () => {
    const res = await call('POST', '/integrations/sms/devices', { label: 'Tablet 2', provider: 'smsgate', baseUrl: 'http://100.64.0.7:8080', username: 'admin', password: 'hunter2-hunter2', maxPerWindow: 20 })
    expect(res.statusCode).toBe(201)
    const b = json(res)
    expect(b.webhookSecret).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(b.device).toMatchObject({ label: 'Tablet 2', provider: 'smsgate', hasPassword: true, username: 'admin', maxPerWindow: 20, enabled: true })
    expect(JSON.stringify(b.device)).not.toContain('hunter2')
    const row = await w.t.db.selectFrom('sms_devices').select(['password_enc', 'webhook_secret_enc']).where('id', '=', b.device.id).executeTakeFirstOrThrow()
    expect(row.password_enc).toMatch(/^v1\./)
    expect(row.password_enc).not.toContain('hunter2')
    expect(rt.secrets.decrypt(row.password_enc!)).toBe('hunter2-hunter2')
    expect(rt.secrets.decrypt(row.webhook_secret_enc)).toBe(b.webhookSecret)
    expect(b.device.webhookUrl).toBeNull() // SMSGATE_WEBHOOK_PUBLIC_URL is not set in this environment

    const patched = await call('PATCH', `/integrations/sms/devices/${b.device.id}`, { label: 'Tablet 2 (front)', enabled: false, maxPerWindow: 25, password: 'new-password-123' })
    expect(patched.statusCode).toBe(200)
    expect(json(patched).device ?? json(patched)).toMatchObject({ label: 'Tablet 2 (front)', enabled: false, maxPerWindow: 25 })
    expect(rt.secrets.decrypt((await w.t.db.selectFrom('sms_devices').select('password_enc').where('id', '=', b.device.id).executeTakeFirstOrThrow()).password_enc!)).toBe('new-password-123')
    expect((await w.t.db.selectFrom('audit_log').select('action').where('entity_type', '=', 'sms_device').execute()).map((a) => a.action).sort()).toEqual(['sms_device.create', 'sms_device.update'])
    expect(JSON.stringify((await w.t.db.selectFrom('audit_log').select(['after']).where('entity_type', '=', 'sms_device').execute()))).not.toMatch(/hunter2|new-password/)
  })

  it('refuses an SMS Gate device without its URL and credentials', async () => {
    const res = await call('POST', '/integrations/sms/devices', { label: 'Broken', provider: 'smsgate' })
    expect(res.statusCode).toBe(422)
    expect(json(res).errors[0].path).toBe('baseUrl')
  })

  it('tests the connection, registers webhooks and reports health with the dispatcher state', async () => {
    const dev = (await rt.store.getByKey(SIM_DEVICE_KEY))!
    expect(json(await post(`/integrations/sms/devices/${dev.id}/test`, undefined, null))).toEqual({ reachable: true, credentials: 'ok', healthStatus: 'pass', battery: 87, error: null })
    const reg = json(await post(`/integrations/sms/devices/${dev.id}/register-webhooks`, undefined, null))
    expect(reg).toMatchObject({ registered: true, error: null })
    expect(reg.url).toContain(`/hooks/smsgate/${SIM_DEVICE_KEY}`)

    const health = json(await call('GET', `/integrations/sms/devices/${dev.id}/health?refresh=true`))
    expect(health.device).toMatchObject({ status: 'online', battery: 87, charging: true })
    expect(health.dispatch).toMatchObject({ state: 'idle', rateLimited: false, heldByQuietHours: 0 })
    expect(health.dispatch.budget).toEqual({ used: 0, max: 30, reservedForP0: 6, remainingP0: 30, remainingOthers: 24, windowMinutes: 30 })
    expect(health.quietHours).toEqual({ enabled: true, active: false, endsAt: null })
    expect(health.failedLast24h).toBe(0)
    expect((await call('GET', '/integrations/sms/devices/00000000-0000-7000-8000-000000000000/health')).statusCode).toBe(404)
  })

  it('reports an unreachable device in the test endpoint instead of failing', async () => {
    const dev = (await rt.store.getByKey(SIM_DEVICE_KEY))!
    const sim = rt.simulator(dev)!
    sim.setOutage('down')
    const b = json(await post(`/integrations/sms/devices/${dev.id}/test`, undefined, null))
    expect(b).toMatchObject({ reachable: false, credentials: 'unknown' })
    sim.setOutage('off')
  })
})

describe('dev helpers (ALLOW_DEV_ENDPOINTS)', () => {
  it('injects a text from a phone into the simulator and returns once it has been applied', async () => {
    await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    const res = await post('/dev/sms/inbound', { from: maria().phone, body: 'Dev reply' }, null)
    expect(res.statusCode).toBe(200)
    expect((await w.messagesOf('Maria Delgado'))[0]).toMatchObject({ direction: 'in', body: 'Dev reply' })
    expect((await post('/dev/sms/inbound', { from: maria().phone, body: 'x', deviceKey: 'nope' }, null)).statusCode).toBe(404)
  })

  it('shows the console mailbox', async () => {
    const res = await call('GET', '/dev/mail')
    expect(res.statusCode).toBe(200)
    expect(json(res)).toEqual({ items: [] })
  })
})
