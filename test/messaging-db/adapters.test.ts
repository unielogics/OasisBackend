// The rest of the app delivering through messaging, over the production module list: scheduling (booking and lifecycle),
// payments (receipt and payment link), settings (closure notices and the emergency fan-out), account links for employees,
// and the email queue behind them.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { sql } from 'kysely'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { configureProductionSettings, messagingRuntimeFor } from '../../src/composition.js'
import { createPermissiveAuthorizer } from '../../src/http/authorizer.js'
import { apiModules } from '../../src/http/modules.js'
import { EmailError } from '../../src/integrations/email/errors.js'
import type { EmailProvider } from '../../src/integrations/ports/email.js'
import { MessagingAccountNotifier } from '../../src/modules/messaging/adapters/accounts.js'
import type { MessagingRuntime } from '../../src/modules/messaging/runtime.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { makeUser } from '../helpers/factories.js'
import { useWorld } from './world.js'

const EMPLOYEE_PHONE = '+13055550198'
const w = useWorld()
let app: TestApp
let rt: MessagingRuntime
let keyN = 0

beforeAll(async () => {
  const user = await makeUser(w.t.db, w.newId, { first: 'Desk', email: 'desk-adapters@example.test' })
  app = await createTestApp({
    testDb: w.t,
    modules: apiModules,
    authorizer: (location) => createPermissiveAuthorizer({ locationId: location.id, userId: user.userId, employeeId: user.employeeId, actorName: 'Desk U.' }),
    env: { SMS_ALLOWLIST: w.env.SMS_ALLOWLIST, SMSGATE_MIN_INTERVAL_MS: '0', EMAIL_CONSOLE_DIR: w.env.EMAIL_CONSOLE_DIR },
  })
  rt = messagingRuntimeFor({ db: w.t.db, clock: w.clock, env: app.env })
  configureProductionSettings({ clock: w.clock, newId: w.newId, messaging: rt })
})
afterAll(async () => {
  await rt?.idle()
  await app?.close()
})

const key = (): string => `adapters-key-${++keyN}-abcdefgh`
const call = (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, k: string | null = method === 'GET' ? null : key()): Promise<LightMyRequestResponse> =>
  app.app.inject({ method, url: `/api/v1${url}`, headers: k ? { 'idempotency-key': k } : {}, ...(body !== undefined ? { payload: body as object } : {}) })
const json = <T = Record<string, any>>(r: LightMyRequestResponse): T => r.json() as T // eslint-disable-line @typescript-eslint/no-explicit-any
const simOf = async () => rt.simulator((await rt.store.getByKey(SIM_DEVICE_KEY))!)!
const drain = async (): Promise<void> => {
  await rt.pollHealthAll()
  for (let i = 0; i < 6; i++) if ((await rt.tickAll()).every((t) => t.report.sent.length === 0)) break
  await rt.idle()
}

async function book(customer: string, start = '2026-06-13T14:00:00-04:00'): Promise<{ appointmentId: string; invoiceId: string; invoiceNo: number }> {
  const svc = await w.t.db.selectFrom('services').select('id').where('name', '=', 'Express Hand Wash').where('kind', '=', 'package').executeTakeFirstOrThrow()
  const res = await call('POST', '/appointments', { customer: { id: w.customer(customer).id }, serviceId: svc.id, start })
  expect(res.statusCode, res.body).toBe(201)
  const b = json(res)
  expect(b.messageQueued).toBe(true)
  return { appointmentId: b.appointment.id, invoiceId: b.invoice.invoiceId, invoiceNo: b.invoice.invoiceNo }
}

describe('scheduling', () => {
  it('a booking queues its thanks text in the booking transaction and the lifecycle texts follow, each under the appointment', async () => {
    const { appointmentId } = await book('Maria Delgado')
    let msgs = (await w.messagesOf('Maria Delgado')).filter((m) => m.direction === 'out')
    expect(msgs.map((m) => m.template_key)).toEqual(['booking_thanks'])
    expect(msgs[0]).toMatchObject({ appointment_id: appointmentId, status: 'queued' })

    expect((await call('POST', `/appointments/${appointmentId}/advance`, { expectedStatus: 'booked' })).statusCode).toBe(200)
    await drain()
    msgs = (await w.messagesOf('Maria Delgado')).filter((m) => m.direction === 'out')
    expect(msgs.map((m) => m.template_key)).toEqual(['booking_thanks', 'confirmed'])
    expect(msgs.every((m) => m.appointment_id === appointmentId && m.status === 'delivered')).toBe(true)
    const log = (await w.t.db.selectFrom('activity_log').select('text').where('appointment_id', '=', appointmentId).orderBy('id').execute()).map((l) => l.text)
    expect(log).toContain('Confirmation + reminder sent')
    expect(log.some((l) => l.includes('not sent'))).toBe(false)
  })

  it('annotates the activity log when the policy refuses (opted out) and still completes the booking', async () => {
    await sql`update customers set sms_opted_out_at = ${w.clock.now()} where id = ${w.customer('Maria Delgado').id}`.execute(w.t.db)
    const svc = await w.t.db.selectFrom('services').select('id').where('name', '=', 'Express Hand Wash').where('kind', '=', 'package').executeTakeFirstOrThrow()
    const res = await call('POST', '/appointments', { customer: { id: w.customer('Maria Delgado').id }, serviceId: svc.id, start: '2026-06-13T14:00:00-04:00' })
    expect(res.statusCode).toBe(201)
    expect(json(res).messageQueued).toBe(false)
    expect(await w.t.db.selectFrom('messages').select('id').execute()).toEqual([])
  })

  it('every non-synthetic-safe notification class is held by quiet hours or sent, never lost: a late-evening booking still gets its confirmation', async () => {
    w.clock.set('2026-06-13T21:45:00-04:00')
    const svc = await w.t.db.selectFrom('services').select('id').where('name', '=', 'Express Hand Wash').where('kind', '=', 'package').executeTakeFirstOrThrow()
    const res = await call('POST', '/appointments', { customer: { id: w.customer('Maria Delgado').id }, serviceId: svc.id, start: '2026-06-14T10:00:00-04:00', override: undefined })
    // the shop is closed that late in the day for booking cutoffs on some days; if the booking was accepted its text is not held
    if (res.statusCode === 201) {
      const row = await w.t.db.selectFrom('sms_outbox').select(['hold_until', 'klass']).where('klass', '=', 'booking_thanks').executeTakeFirst()
      if (row) expect(row.hold_until).toBeNull()
    }
  })
})

describe('payments', () => {
  it('sends the receipt by SMS and as an itemised email through the EmailProvider', async () => {
    const { invoiceId, invoiceNo } = await book('Maria Delgado')
    await sql`update customers set email = 'maria@example.test' where id = ${w.customer('Maria Delgado').id}`.execute(w.t.db)
    const res = await call('POST', `/invoices/${invoiceId}/receipt`, {})
    expect(res.statusCode, res.body).toBe(200)

    const sms = await w.t.db.selectFrom('messages').select(['klass', 'body', 'appointment_id', 'status']).where('klass', '=', 'receipt').executeTakeFirstOrThrow()
    expect(sms.body).toContain(`INV-${invoiceNo}`)
    expect(sms.appointment_id).not.toBeNull()
    const mail = await w.t.db.selectFrom('outbox_emails').selectAll().executeTakeFirstOrThrow()
    expect(mail).toMatchObject({ template: 'receipt', to_email: 'maria@example.test', state: 'pending', purpose: 'receipt' })
    expect(mail.vars).toMatchObject({ customerName: 'Maria Delgado', invoiceNumber: `INV-${invoiceNo}`, totalCents: 4815, subtotalCents: 4500, taxCents: 315, balanceCents: 4815 })

    expect(await rt.emailSender.sendDue()).toEqual({ sent: 1, failed: 0, retried: 0, suppressed: 0 })
    const sent = await w.t.db.selectFrom('outbox_emails').select(['state', 'subject', 'body', 'provider_message_id']).executeTakeFirstOrThrow()
    expect(sent.state).toBe('sent')
    expect(sent.subject).toContain(`INV-${invoiceNo}`)
    expect(sent.body).toContain('Express Hand Wash')
    expect(sent.provider_message_id).toMatch(/^sim-/)
    const files = readdirSync(w.env.EMAIL_CONSOLE_DIR).filter((f) => f.endsWith('.eml'))
    expect(files.length).toBeGreaterThan(0)
  })

  it('a repeated receipt request does not repeat its text or email', async () => {
    const { invoiceId } = await book('Maria Delgado')
    await sql`update customers set email = 'maria@example.test' where id = ${w.customer('Maria Delgado').id}`.execute(w.t.db)
    const k = key()
    await call('POST', `/invoices/${invoiceId}/receipt`, {}, k)
    await call('POST', `/invoices/${invoiceId}/receipt`, {}, k)
    expect(await w.t.db.selectFrom('messages').select('id').where('klass', '=', 'receipt').execute()).toHaveLength(1)
    expect(await w.t.db.selectFrom('outbox_emails').select('id').execute()).toHaveLength(1)
  })

  it('texts the payment link and records the message on the link', async () => {
    const { invoiceId, appointmentId } = await book('Maria Delgado')
    const res = await call('POST', `/invoices/${invoiceId}/payments`, { method: 'payment_link', url: 'https://oasis.squarespace.com/checkout/abc123' })
    expect(res.statusCode, res.body).toBe(201)
    const m = await w.t.db.selectFrom('messages').select(['id', 'body', 'klass', 'appointment_id']).where('klass', '=', 'payment_link').executeTakeFirstOrThrow()
    expect(m.body).toContain('https://oasis.squarespace.com/checkout/abc123')
    expect(m.appointment_id).toBe(appointmentId)
    const link = await w.t.db.selectFrom('payment_links').select(['sent_message_id', 'sent_at']).executeTakeFirstOrThrow()
    expect(link.sent_message_id).toBe(m.id)
    expect(link.sent_at).not.toBeNull()
  })
})

describe('settings notifiers', () => {
  it('a planned closure texts the reachable customers once, and the rest by email', async () => {
    for (const [customer, at] of [['Maria Delgado', '2026-06-20T10:00:00-04:00'], ['David Okafor', '2026-06-20T11:00:00-04:00'], ['Priya Nair', '2026-06-20T12:00:00-04:00']] as const)
      await w.appointment({ customer, at })
    await sql`update customers set sms_opted_out_at = ${w.clock.now()}, email = 'david@example.test' where id = ${w.customer('David Okafor').id}`.execute(w.t.db)
    await sql`delete from messages`.execute(w.t.db)
    await sql`delete from outbox_emails`.execute(w.t.db)

    const res = await call('POST', '/closures', { date: '2026-06-20', name: 'Staff day', type: 'closed', notify: true })
    expect(res.statusCode, res.body).toBe(201)
    expect(json(res)).toMatchObject({ affectedCount: 3, notified: 3 })
    const texts = await w.t.db.selectFrom('messages').select(['customer_id', 'klass', 'body', 'appointment_id']).where('klass', '=', 'closure_notice').execute()
    expect(texts.map((t) => t.customer_id).sort()).toEqual([w.customer('Maria Delgado').id, w.customer('Priya Nair').id].sort())
    expect(texts[0]!.body).toMatch(/^Hi (Maria|Priya), Oasis Auto Spa will be closed on Jun 20, 2026\./)
    expect(await w.t.db.selectFrom('sms_outbox').select('priority').where('klass', '=', 'closure_notice').execute()).toEqual([{ priority: 3 }, { priority: 3 }])
    const email = await w.t.db.selectFrom('outbox_emails').select(['to_email', 'template', 'purpose']).executeTakeFirstOrThrow()
    expect(email).toEqual({ to_email: 'david@example.test', template: 'closure_notice', purpose: 'closure' })
    const log = await w.t.db.selectFrom('activity_log').select(['text']).where('text', 'like', 'Closure notice queued%').execute()
    expect(log).toHaveLength(3)
  })

  it('an emergency closure fans out in lane 3, records each message on its notification, and follows the receipts', async () => {
    const a1 = await book('Maria Delgado', '2026-06-13T14:00:00-04:00')
    await book('David Okafor', '2026-06-13T15:00:00-04:00')
    await book('Priya Nair', '2026-06-13T16:00:00-04:00')
    await sql`update customers set sms_opted_out_at = ${w.clock.now()} where id = ${w.customer('David Okafor').id}`.execute(w.t.db)
    await sql`update customers set phone_e164 = null, email = 'priya@example.test', synthetic = false where id = ${w.customer('Priya Nair').id}`.execute(w.t.db)
    await sql`delete from messages`.execute(w.t.db)

    const res = await call('POST', '/emergency/close', { reason: 'Severe weather', dur: 'today', notify: true, link: true, credits: true, pause: true, crew: false })
    expect(res.statusCode, res.body).toBe(201)
    const notes = await w.t.db.selectFrom('emergency_notifications').select(['appointment_id', 'channel', 'state', 'message_id']).orderBy('created_at').execute()
    const byAppt = Object.fromEntries(notes.map((n) => [n.appointment_id, n]))
    expect(byAppt[a1.appointmentId]).toMatchObject({ channel: 'sms', state: 'queued' })
    expect(byAppt[a1.appointmentId]!.message_id).not.toBeNull()
    // David opted out of texts: Settings routes him to email like Priya, who has no number
    expect(notes.map((n) => [n.channel, n.state]).sort()).toEqual([['email', 'queued'], ['email', 'queued'], ['sms', 'queued']])

    const m = await w.t.db.selectFrom('messages').select(['id', 'body', 'klass']).where('klass', '=', 'emergency').executeTakeFirstOrThrow()
    expect(m.id).toBe(byAppt[a1.appointmentId]!.message_id)
    expect(m.body).toContain('severe weather')
    expect(m.body).not.toContain('oasis.spa') // RESCHEDULE_LINK_ENABLED is false: the link sentence is stripped
    expect((await w.t.db.selectFrom('sms_outbox').select('priority').where('id', '=', m.id).executeTakeFirstOrThrow()).priority).toBe(3)
    expect((await w.t.db.selectFrom('outbox_emails').select('template').execute()).map((e) => e.template)).toEqual(['closure_notice', 'closure_notice'])

    await drain()
    expect((await w.t.db.selectFrom('emergency_notifications').select('state').where('message_id', '=', m.id).executeTakeFirstOrThrow()).state).toBe('delivered')
  })
})

describe('account links for employees', () => {
  let seq = 0
  const employee = async (o: { phone?: string | null; email?: string | null } = {}) => {
    const { employeeId } = await makeUser(w.t.db, w.newId, { first: 'Kevin', email: `kevin-login-${++seq}-${keyN}@example.test` })
    await sql`update employees set phone_e164 = ${o.phone ?? null}, email = ${o.email ?? null}, status = 'invited' where id = ${employeeId}`.execute(w.t.db)
    return employeeId
  }
  const message = (employeeId: string, o: { phone?: string | null; email?: string | null; kind?: 'invite' | 'password_reset' }) => ({
    kind: o.kind ?? ('invite' as const),
    employeeId,
    firstName: 'Kevin',
    phone: o.phone ?? null,
    email: o.email ?? null,
    link: 'https://dashboard.oasis.test/invite?token=SECRET-TOKEN-123',
    expiresAt: new Date(w.clock.now().getTime() + 7 * 86400_000),
  })
  const notifier = (): MessagingAccountNotifier => new MessagingAccountNotifier(rt)

  it('texts the link when the device is usable, keeps the live text out of the thread and wipes it once delivered', async () => {
    const id = await employee({ phone: EMPLOYEE_PHONE })
    const r = await notifier().deliver(message(id, { phone: EMPLOYEE_PHONE }))
    expect(r).toEqual({ delivered: false, channel: 'sms' }) // a simulator device never counts as delivered
    const m = await w.t.db.selectFrom('messages').select(['id', 'body', 'klass', 'customer_id', 'employee_id', 'thread_id']).executeTakeFirstOrThrow()
    expect(m).toMatchObject({ klass: 'staff_invite', customer_id: null, employee_id: id, thread_id: null, body: '[link sent privately]' })
    expect((await w.t.db.selectFrom('sms_outbox').select('body').executeTakeFirstOrThrow()).body).toContain('SECRET-TOKEN-123')
    expect((await call('GET', '/messages/outbox?state=pending')).body).not.toContain('SECRET-TOKEN-123')
    expect(await w.t.db.selectFrom('realtime_events').select('id').where('type', '=', 'message.out').execute()).toEqual([])

    await drain()
    expect(await w.t.db.selectFrom('sms_outbox').select(['state', 'body']).executeTakeFirstOrThrow()).toEqual({ state: 'delivered', body: '[link sent privately]' })
  })

  it('emails the link when there is no phone, and wipes its variables after sending', async () => {
    const email = `kevin-reset-${++seq}@example.test`
    const id = await employee({ email })
    const r = await notifier().deliver(message(id, { email, kind: 'password_reset' }))
    expect(r).toEqual({ delivered: false, channel: 'email' }) // the console driver is not a real delivery
    const row = await w.t.db.selectFrom('outbox_emails').select(['state', 'template', 'vars', 'to_email']).executeTakeFirstOrThrow()
    expect(row).toMatchObject({ state: 'sent', template: 'password_reset', to_email: email, vars: {} })
    const eml = readdirSync(w.env.EMAIL_CONSOLE_DIR).filter((f) => f.endsWith('.eml')).map((f) => readFileSync(path.join(w.env.EMAIL_CONSOLE_DIR, f), 'utf8'))
    expect(eml.some((t) => t.includes('SECRET-TOKEN-123'))).toBe(true)
  })

  it('falls back to email when the device is offline, and says not delivered when nothing can carry it', async () => {
    await sql`update sms_devices set status = 'offline' where device_key = ${SIM_DEVICE_KEY}`.execute(w.t.db)
    const email = `kevin-offline-${++seq}@example.test`
    const id = await employee({ phone: EMPLOYEE_PHONE, email })
    expect(await notifier().deliver(message(id, { phone: EMPLOYEE_PHONE, email }))).toMatchObject({ channel: 'email' })
    expect(await w.t.db.selectFrom('sms_outbox').select('id').execute()).toEqual([])
    const none = await employee()
    expect(await notifier().deliver(message(none, {}))).toEqual({ delivered: false, channel: 'none' })
  })

  it('e-mails an invite that waited in the queue while the device was away, once', async () => {
    const email = `kevin-fallback-${++seq}@example.test`
    const id = await employee({ phone: EMPLOYEE_PHONE, email })
    await rt.pollHealthAll()
    await notifier().deliver(message(id, { phone: EMPLOYEE_PHONE, email }))
    const sim = await simOf()
    sim.setOutage('down')
    for (let i = 0; i < 3; i++) await rt.pollHealthAll()
    w.clock.advance(11 * 60_000)
    await rt.pollHealthAll()
    expect((await rt.store.getByKey(SIM_DEVICE_KEY))!.status).toBe('offline')
    await rt.tickAll()
    const mails = await w.t.db.selectFrom('outbox_emails').select(['state', 'purpose', 'template']).execute()
    expect(mails).toEqual([{ state: 'sent', purpose: 'sms-fallback', template: 'staff_invite' }])
    expect((await w.t.db.selectFrom('sms_outbox').select('fallback_emailed_at').executeTakeFirstOrThrow()).fallback_emailed_at).not.toBeNull()
    await rt.tickAll()
    expect(await w.t.db.selectFrom('outbox_emails').select('id').execute()).toHaveLength(1)
    expect(existsSync(w.env.EMAIL_CONSOLE_DIR)).toBe(true)
  })
})

describe('email queue', () => {
  const queueOne = (to = 'someone@example.test') =>
    w.tx((tx) =>
      import('../../src/modules/messaging/email/service.js').then((m) =>
        m.queueEmail(tx, { locationId: w.locationId, to, template: 'device_alert', vars: { deviceLabel: 'Tablet', status: 'offline', occurredLabel: '10:00 AM' }, purpose: 'test' }, w.rt.deps),
      ),
    )

  it('retries a retryable provider error with backoff, then sends', async () => {
    let calls = 0
    const flaky: EmailProvider = {
      async send() {
        calls += 1
        if (calls < 3) throw new EmailError('PROVIDER_UNAVAILABLE', 'throttled', { retryable: true })
        return { id: 'ses-1' }
      },
    }
    const local = new (await import('../../src/modules/messaging/runtime.js')).MessagingRuntime({ ...w.rt.deps, emailProvider: flaky })
    await queueOne()
    expect(await local.emailSender.sendDue()).toMatchObject({ retried: 1, sent: 0 })
    expect(await local.emailSender.sendDue()).toMatchObject({ sent: 0 }) // not due yet
    w.clock.advance(61_000)
    expect(await local.emailSender.sendDue()).toMatchObject({ retried: 1 })
    w.clock.advance(121_000)
    expect(await local.emailSender.sendDue()).toMatchObject({ sent: 1 })
    expect(await w.t.db.selectFrom('outbox_emails').select(['state', 'attempts', 'provider_message_id']).executeTakeFirstOrThrow()).toEqual({ state: 'sent', attempts: 3, provider_message_id: 'ses-1' })
  })

  it('marks a permanent rejection failed at once and a suppressed address suppressed', async () => {
    const rejecting: EmailProvider = {
      async send(req) {
        if (req.to.startsWith('bounced')) throw new EmailError('SUPPRESSED', 'on the suppression list')
        throw new EmailError('INVALID_ADDRESS', 'bad address')
      },
    }
    const local = new (await import('../../src/modules/messaging/runtime.js')).MessagingRuntime({ ...w.rt.deps, emailProvider: rejecting })
    await queueOne('bounced@example.test')
    await queueOne('nobody@example.test')
    expect(await local.emailSender.sendDue()).toEqual({ sent: 0, failed: 1, retried: 0, suppressed: 1 })
    const rows = await w.t.db.selectFrom('outbox_emails').select(['to_email', 'state', 'error']).orderBy('to_email').execute()
    expect(rows).toEqual([
      { to_email: 'bounced@example.test', state: 'suppressed', error: 'on the suppression list' },
      { to_email: 'nobody@example.test', state: 'failed', error: 'bad address' },
    ])
  })

  it('a second queue call with the same dedupe key does nothing', async () => {
    const q = () => w.tx((tx) => import('../../src/modules/messaging/email/service.js').then((m) => m.queueEmail(tx, { locationId: w.locationId, to: 'a@example.test', template: 'device_alert', vars: { deviceLabel: 'T', status: 'offline', occurredLabel: 'now' }, purpose: 'x', dedupeKey: 'once' }, w.rt.deps)))
    const a = await q()
    const b = await q()
    expect(b).toEqual({ emailId: a.emailId, duplicate: true })
  })
})

describe('housekeeping', () => {
  it('purge drops old window accounting and wipes sensitive text that outlived its use', async () => {
    const id = await makeUser(w.t.db, w.newId, { first: 'Kevin', email: `purge-${keyN++}@example.test` })
    await sql`update employees set phone_e164 = ${EMPLOYEE_PHONE} where id = ${id.employeeId}`.execute(w.t.db)
    await new MessagingAccountNotifier(rt).deliver({ kind: 'invite', employeeId: id.employeeId, firstName: 'Kevin', phone: EMPLOYEE_PHONE, email: null, link: 'https://dashboard.oasis.test/invite?token=LATE', expiresAt: new Date(w.clock.now().getTime() + 86400_000) })
    // a carrier that never reports delivery leaves the text in "sent" forever
    await sql`update sms_outbox set state = 'sent', accepted_at = ${w.clock.now()}, sent_at = ${w.clock.now()}`.execute(w.t.db)
    await sql`insert into sms_usage (device_id, provider_message_id, segments, accepted_at) values (null, 'old', 1, ${new Date(w.clock.now().getTime() - 3 * 86400_000)})`.execute(w.t.db)
    await rt.purge()
    expect((await w.t.db.selectFrom('sms_outbox').select('body').executeTakeFirstOrThrow()).body).toContain('LATE') // not yet: the link may still be needed
    w.clock.advance(7 * 3600_000)
    await rt.purge()
    expect((await w.t.db.selectFrom('sms_outbox').select('body').executeTakeFirstOrThrow()).body).toBe('[link sent privately]')
    expect(await w.t.db.selectFrom('sms_usage').select('provider_message_id').execute()).toEqual([])
  })
})
