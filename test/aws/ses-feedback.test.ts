// POST /hooks/ses end to end on the real app and Postgres: SNS signatures (version 1 and 2) against a certificate issued by a test
// CA and served by an injected fetcher, the topic allow-list, the certificate URL rules, replay protection by MessageId, and what a
// bounce, complaint, soft bounce or delivery leaves behind (suppression list, customers.email_bounced_at, outbox feedback, an
// activity line, notifications), then that a suppressed address is never mailed again.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import type { EmailRequest } from '../../src/integrations/ports/email.js'
import { MessagingAccountNotifier } from '../../src/modules/messaging/adapters/accounts.js'
import { createSesHookModule } from '../../src/modules/messaging/email/hook.js'
import { queueEmail } from '../../src/modules/messaging/email/service.js'
import { MessagingRuntime } from '../../src/modules/messaging/runtime.js'
import { systemModule } from '../../src/modules/system/index.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { useWorld } from '../messaging-db/world.js'
import {
  CERT_URL,
  OTHER_TOPIC,
  REGION,
  TOPIC,
  generateSigningCert,
  notification,
  sesEvent,
  subscriptionConfirmation,
  type SigningCert,
} from './helpers/sns.js'

// The clock must sit inside the generated certificate's validity window, so the world starts a minute from the real now.
const START = new Date(Date.now() + 60_000).toISOString()
const w = useWorld({ start: START })

let cert: SigningCert
let app: TestApp
const fetched: string[] = []
const confirmed: string[] = []
let confirmOk = true

beforeAll(async () => {
  cert = generateSigningCert()
  app = await createTestApp({
    testDb: w.t,
    env: { SES_SNS_TOPIC_ARNS: `${TOPIC}, arn:aws:sns:${REGION}:123456789012:unused` },
    modules: [systemModule],
    hookModules: [
      createSesHookModule({
        fetchCertificate: async (url) => {
          fetched.push(url)
          return cert.certPem
        },
        confirm: async (url) => {
          confirmed.push(url)
          return { ok: confirmOk, status: confirmOk ? 200 : 500 }
        },
      }),
    ],
  })
})
afterAll(async () => {
  await app?.close()
})

const CUSTOMER = 'Jane.Bounce@Example.test'
const ADDRESS = CUSTOMER.toLowerCase()
let customerId: string
let appointmentId: string

beforeEach(async () => {
  confirmed.length = 0
  confirmOk = true
  await sql`truncate table email_suppressions`.execute(w.t.db)
  await sql`update customers set email_bounced_at = null`.execute(w.t.db)
  const first = await w.t.db.selectFrom('customers').select(['id', 'full_name']).orderBy('full_name').executeTakeFirstOrThrow()
  customerId = first.id
  await w.t.db.updateTable('customers').set({ email: CUSTOMER }).where('id', '=', customerId).execute()
  appointmentId = await w.appointment({ customer: first.full_name, at: START, status: 'completed', completedAt: START })
})

async function sentReceipt(sesMessageId: string, to = CUSTOMER): Promise<string> {
  const id = w.newId()
  await w.t.db
    .insertInto('outbox_emails')
    .values({
      id,
      location_id: w.locationId,
      customer_id: customerId,
      appointment_id: appointmentId,
      to_email: to,
      template: 'receipt',
      vars: '{}' as never,
      purpose: 'receipt',
      state: 'sent',
      provider_message_id: sesMessageId,
      sent_at: w.clock.now(),
    })
    .execute()
  return id
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  app.app.inject({
    method: 'POST',
    url: '/hooks/ses',
    headers: { 'content-type': 'text/plain; charset=UTF-8', 'x-amz-sns-message-type': 'Notification', ...headers },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  })

const suppressions = () => w.t.db.selectFrom('email_suppressions').selectAll().execute()
const now = () => w.clock.now()

describe('POST /hooks/ses: authentication', () => {
  it('records a SignatureVersion 1 bounce: suppression, email_bounced_at, outbox feedback, activity line, notification', async () => {
    const ses = `0100${randomUUID()}`
    const outboxId = await sentReceipt(ses)
    const res = await post(notification(cert, sesEvent('Bounce', { messageId: ses, recipient: CUSTOMER, at: now() }), { at: now(), version: '1' }))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ message: 'recorded 1' })

    const [s] = await suppressions()
    expect(s).toMatchObject({
      address: ADDRESS,
      reason: 'bounce',
      bounce_type: 'Permanent',
      bounce_subtype: 'General',
      count: 1,
      source_message_ids: [ses],
      cleared_at: null,
    })
    expect(s!.first_seen_at.toISOString()).toBe(now().toISOString())
    expect(s!.last_seen_at.toISOString()).toBe(now().toISOString())

    const c = await w.t.db.selectFrom('customers').select('email_bounced_at').where('id', '=', customerId).executeTakeFirstOrThrow()
    expect(c.email_bounced_at?.toISOString()).toBe(now().toISOString())
    const o = await w.t.db.selectFrom('outbox_emails').select(['feedback', 'feedback_detail']).where('id', '=', outboxId).executeTakeFirstOrThrow()
    expect(o).toEqual({ feedback: 'hard_bounce', feedback_detail: 'Permanent / General: smtp; 550 5.1.1 user unknown' })

    const act = await w.t.db.selectFrom('activity_log').select(['text', 'channels', 'actor_type']).where('appointment_id', '=', appointmentId).execute()
    expect(act).toEqual([{ text: 'Receipt email to j***@example.test bounced; no more email to that address', channels: ['email', 'system'], actor_type: 'system' }])
    const notes = await w.t.db.selectFrom('notifications').select(['kind', 'title', 'body', 'entity_type']).where('kind', '=', 'email.suppressed').execute()
    expect(notes.length).toBeGreaterThan(0)
    expect(notes[0]).toMatchObject({ title: 'Email address suppressed', entity_type: 'customer' })
    expect(notes[0]!.body).toContain('j***@example.test')
    expect(notes[0]!.body).not.toContain(ADDRESS)

    const log = await w.t.db.selectFrom('webhook_log').select(['provider', 'status', 'body']).execute()
    expect(log).toEqual([{ provider: 'ses', status: 'processed', body: null }])
  })

  it('answers a replayed MessageId 200 without recording it twice', async () => {
    const ses = `0100${randomUUID()}`
    await sentReceipt(ses)
    const env = notification(cert, sesEvent('Bounce', { messageId: ses, recipient: CUSTOMER, at: now() }), { at: now() })
    expect((await post(env)).statusCode).toBe(200)
    const again = await post(env)
    expect(again.statusCode).toBe(200)
    expect(again.json()).toEqual({ message: 'duplicate' })
    expect((await suppressions())[0]!.count).toBe(1)
    expect(await w.t.db.selectFrom('activity_log').select('id').where('appointment_id', '=', appointmentId).execute()).toHaveLength(1)
  })

  it('rejects a topic that is not on SES_SNS_TOPIC_ARNS, even with a valid signature', async () => {
    const env = notification(cert, sesEvent('Bounce', { messageId: 'x1', recipient: CUSTOMER, at: now() }), { at: now(), topic: OTHER_TOPIC })
    const res = await post(env)
    expect(res.statusCode).toBe(403)
    expect(await suppressions()).toEqual([])
    expect(await w.t.db.selectFrom('webhook_log').select('id').execute()).toEqual([])
  })

  it.each([
    ['a look-alike host', `https://sns.${REGION}.amazonaws.com.evil.example/cert.pem`],
    ['plain http', `http://sns.${REGION}.amazonaws.com/cert.pem`],
    ['a path that is not .pem', `https://sns.${REGION}.amazonaws.com/cert.txt`],
    ['another AWS service', `https://s3.${REGION}.amazonaws.com/cert.pem`],
    ['a custom port', `https://sns.${REGION}.amazonaws.com:8443/cert.pem`],
  ])('rejects a SigningCertURL on %s without fetching it', async (_label, certUrl) => {
    const before = fetched.length
    const env = notification(cert, sesEvent('Bounce', { messageId: 'x2', recipient: CUSTOMER, at: now() }), { at: now(), certUrl })
    expect((await post(env)).statusCode).toBe(403)
    expect(fetched.slice(before)).toEqual([])
    expect(await suppressions()).toEqual([])
  })

  it('rejects a tampered body (recipient changed after signing) and a signature by another key', async () => {
    const env = notification(cert, sesEvent('Bounce', { messageId: 'x3', recipient: 'someone@example.test', at: now() }), { at: now() })
    const tampered = { ...env, Message: env.Message.replace('someone@example.test', CUSTOMER) }
    expect((await post(tampered)).statusCode).toBe(403)
    const other = generateSigningCert()
    const forged = notification(other, sesEvent('Bounce', { messageId: 'x4', recipient: CUSTOMER, at: now() }), { at: now() })
    expect((await post(forged)).statusCode).toBe(403)
    const downgraded = { ...env, SignatureVersion: '1' as const }
    expect((await post(downgraded)).statusCode).toBe(403)
    expect(await suppressions()).toEqual([])
  })

  it('rejects a message older than SNS ever retries (replay of an old capture)', async () => {
    const old = new Date(now().getTime() - 2 * 3600_000)
    const env = notification(cert, sesEvent('Bounce', { messageId: 'x5', recipient: CUSTOMER, at: old }), { at: old })
    expect((await post(env)).statusCode).toBe(403)
    expect(await suppressions()).toEqual([])
  })

  it('caches the signing certificate: one download for many messages', async () => {
    for (let i = 0; i < 3; i++) {
      const env = notification(cert, sesEvent('Delivery', { messageId: `d-${i}`, recipient: CUSTOMER, at: now() }), { at: now() })
      expect((await post(env)).statusCode).toBe(200)
    }
    expect(fetched.filter((u) => u === CERT_URL)).toHaveLength(1)
  })

  it('answers 400 to a body that is not JSON or not an SNS envelope, and 413 above the body limit', async () => {
    expect((await post('not json')).statusCode).toBe(400)
    expect((await post({ hello: 'world' })).statusCode).toBe(400)
    expect((await post('x'.repeat(1024 * 1024 + 10))).statusCode).toBe(413)
  })
})

describe('POST /hooks/ses: subscription confirmation', () => {
  it('follows SubscribeURL for an allow-listed topic on an SNS host', async () => {
    const env = subscriptionConfirmation(cert, { at: now() })
    const res = await post(env, { 'x-amz-sns-message-type': 'SubscriptionConfirmation' })
    expect(res.statusCode).toBe(200)
    expect(confirmed).toEqual([env.SubscribeURL])
  })

  it('never follows it for another topic, another host, or a URL naming another topic', async () => {
    expect((await post(subscriptionConfirmation(cert, { at: now(), topic: OTHER_TOPIC }))).statusCode).toBe(403)
    expect((await post(subscriptionConfirmation(cert, { at: now(), subscribeUrl: 'https://evil.example/confirm' }))).statusCode).toBe(400)
    const elsewhere = `https://sns.${REGION}.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(OTHER_TOPIC)}&Token=t`
    expect((await post(subscriptionConfirmation(cert, { at: now(), subscribeUrl: elsewhere }))).statusCode).toBe(400)
    expect(confirmed).toEqual([])
  })

  it('asks SNS to retry (502) when the confirmation GET fails', async () => {
    confirmOk = false
    expect((await post(subscriptionConfirmation(cert, { at: now() }))).statusCode).toBe(502)
  })
})

describe('POST /hooks/ses: what each event records', () => {
  it('a complaint (SignatureVersion 2) outranks an earlier bounce and is counted per SES message', async () => {
    const a = `0100${randomUUID()}`
    const b = `0100${randomUUID()}`
    await sentReceipt(a)
    await sentReceipt(b)
    await post(notification(cert, sesEvent('Bounce', { messageId: a, recipient: CUSTOMER, at: now() }), { at: now() }))
    w.clock.advance(60_000)
    await post(notification(cert, sesEvent('Complaint', { messageId: b, recipient: CUSTOMER, at: now() }), { at: now(), version: '2' }))
    // a second SNS notification about the same SES message (another MessageId) is not a second bounce
    await post(notification(cert, sesEvent('Complaint', { messageId: b, recipient: CUSTOMER, at: now() }), { at: now() }))
    const [s] = await suppressions()
    expect(s).toMatchObject({ reason: 'complaint', complaint_feedback_type: 'abuse', bounce_type: 'Permanent', count: 2, source_message_ids: [a, b] })
    expect(s!.last_seen_at.toISOString()).toBe(now().toISOString())
    expect(s!.first_seen_at.getTime()).toBe(now().getTime() - 60_000)
    const notes = await w.t.db.selectFrom('notifications').select('id').where('kind', '=', 'email.suppressed').execute()
    const managers = notes.length
    expect(managers).toBeGreaterThan(0)
    // the second event did not notify again: one notification per manager
    expect(new Set((await w.t.db.selectFrom('notifications').select('employee_id').where('kind', '=', 'email.suppressed').execute()).map((n) => n.employee_id)).size).toBe(managers)
  })

  it('a soft bounce, a delivery and a reject only annotate the email; nothing is suppressed', async () => {
    const soft = `0100${randomUUID()}`
    const ok = `0100${randomUUID()}`
    const softRow = await sentReceipt(soft)
    const okRow = await sentReceipt(ok)
    await post(notification(cert, sesEvent('Bounce', { messageId: soft, recipient: CUSTOMER, at: now(), bounceType: 'Transient', subType: 'MailboxFull' }), { at: now() }))
    await post(notification(cert, sesEvent('Delivery', { messageId: ok, recipient: CUSTOMER, at: now() }), { at: now() }))
    const reject = await post(notification(cert, sesEvent('Reject', { messageId: ok, recipient: CUSTOMER, at: now() }), { at: now() }))
    expect(reject.statusCode).toBe(200)
    expect(await suppressions()).toEqual([])
    const rows = await w.t.db.selectFrom('outbox_emails').select(['id', 'feedback', 'delivered_at']).where('id', 'in', [softRow, okRow]).execute()
    expect(rows.find((r) => r.id === softRow)).toMatchObject({ feedback: 'soft_bounce', delivered_at: null })
    expect(rows.find((r) => r.id === okRow)?.delivered_at?.toISOString()).toBe(now().toISOString())
    const c = await w.t.db.selectFrom('customers').select('email_bounced_at').where('id', '=', customerId).executeTakeFirstOrThrow()
    expect(c.email_bounced_at).toBeNull()
  })
})

describe('a suppressed address is never mailed again', () => {
  async function suppress(address: string): Promise<void> {
    const res = await post(notification(cert, sesEvent('Bounce', { messageId: `0100${randomUUID()}`, recipient: address, at: now() }), { at: now() }))
    expect(res.statusCode).toBe(200)
  }

  it('skips a queued receipt with the reason recorded; the provider is never called', async () => {
    await suppress(CUSTOMER)
    const calls: EmailRequest[] = []
    const rt = new MessagingRuntime({
      db: w.t.db,
      clock: w.clock,
      newId: w.newId,
      env: w.env,
      emailProvider: { send: async (r) => (calls.push(r), { id: 'never' }) },
    })
    const q = await w.t.db.transaction().execute((tx) =>
      queueEmail(tx, { locationId: w.locationId, to: '  JANE.BOUNCE@example.test ', template: 'receipt', vars: {}, purpose: 'receipt', customerId }, w),
    )
    const report = await rt.emailSender.sendDue()
    expect(report).toEqual({ sent: 0, failed: 0, retried: 0, suppressed: 1 })
    expect(calls).toEqual([])
    const row = await w.t.db.selectFrom('outbox_emails').select(['state', 'error', 'error_at']).where('id', '=', q.emailId).executeTakeFirstOrThrow()
    expect(row.state).toBe('suppressed')
    expect(row.error).toBe(
      `Not sent: j***@example.test is suppressed because it bounced (Permanent / General) on ${now().toISOString().slice(0, 10)}`,
    )
    expect(row.error_at?.toISOString()).toBe(now().toISOString())
  })

  it('an invitation to a suppressed staff address fails visibly: not delivered, and every Super Admin is notified', async () => {
    const kevin = await w.t.db.selectFrom('employees').select(['id', 'email']).where('first', '=', 'Kevin').executeTakeFirstOrThrow()
    await suppress(kevin.email!)
    await sql`delete from notifications`.execute(w.t.db)
    const r = await new MessagingAccountNotifier(w.rt).deliver({
      kind: 'invite',
      employeeId: kevin.id,
      firstName: 'Kevin',
      phone: null,
      email: kevin.email,
      link: 'https://dashboard.oasis.test/invite?token=SECRET-LINK',
      expiresAt: new Date(now().getTime() + 86_400_000),
    })
    expect(r).toEqual({ delivered: false, channel: 'email' })
    const mail = await w.t.db.selectFrom('outbox_emails').select(['state', 'vars']).where('template', '=', 'staff_invite').executeTakeFirstOrThrow()
    expect(mail.state).toBe('suppressed')
    expect(mail.vars).toEqual({}) // the one-time link does not linger in the queue
    const notes = await w.t.db
      .selectFrom('notifications as n')
      .innerJoin('employees as e', 'e.id', 'n.employee_id')
      .select(['e.first', 'n.title', 'n.body', 'n.kind'])
      .execute()
    expect(notes.map((n) => n.first)).toEqual(['Amara'])
    expect(notes[0]).toMatchObject({ kind: 'email.suppressed_account_link', title: "Kevin's invitation was not emailed" })
    expect(notes[0]!.body).not.toContain('SECRET-LINK')
  })
})

describe('suppression list routes', () => {
  it('lists the active suppressions and lifts one (audited); a new bounce suppresses it again', async () => {
    await post(notification(cert, sesEvent('Bounce', { messageId: 'm-1', recipient: CUSTOMER, at: now() }), { at: now() }))
    const list = await app.app.inject({ method: 'GET', url: '/api/v1/system/email-suppressions' })
    expect(list.statusCode).toBe(200)
    expect(list.json().items).toMatchObject([{ address: ADDRESS, reason: 'bounce', count: 1 }])
    const masked = await app.app.inject({ method: 'GET', url: '/api/v1/system/email-suppressions', headers: { 'x-test-permissions': 'set.billing' } })
    expect(masked.json().items[0].address).toBe('j***@example.test')

    const amara = await w.t.db
      .selectFrom('users as u')
      .innerJoin('employees as e', 'e.id', 'u.employee_id')
      .select('u.id')
      .where('e.first', '=', 'Amara')
      .executeTakeFirstOrThrow()
    const del = await app.app.inject({
      method: 'DELETE',
      url: `/api/v1/system/email-suppressions/${encodeURIComponent(CUSTOMER)}`,
      headers: { 'x-test-user': amara.id },
    })
    expect(del.statusCode, del.body).toBe(200)
    expect((await suppressions())[0]).toMatchObject({ cleared_by: amara.id })
    expect((await app.app.inject({ method: 'GET', url: '/api/v1/system/email-suppressions' })).json().items).toEqual([])
    const audit = await w.t.db.selectFrom('audit_log').select(['action', 'entity_id']).where('action', '=', 'email.suppression.clear').execute()
    expect(audit).toEqual([{ action: 'email.suppression.clear', entity_id: 'j***@example.test' }])
    expect((await app.app.inject({ method: 'DELETE', url: `/api/v1/system/email-suppressions/${encodeURIComponent(CUSTOMER)}` })).statusCode).toBe(404)

    await post(notification(cert, sesEvent('Bounce', { messageId: 'm-2', recipient: CUSTOMER, at: now() }), { at: now() }))
    const [s] = await suppressions()
    expect(s).toMatchObject({ cleared_at: null, count: 2 })
  })
})
