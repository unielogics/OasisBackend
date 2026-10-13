// Status texts as the car moves (ADR 0160, design section 6, wave W3d) on Postgres with the real messaging queue: the lifecycle
// commands call the port through the production scheduling ports (src/composition.ts schedulingPortsFor), the jobs run their
// functions directly (test/status-texts/jobs.test.ts runs them through the real worker). Checked in (a manual arrival, 3 minutes
// later, dropped once the wash starts), running late (past the promised end + grace, a new estimate, at most late_max), ready
// (status_texts.ready), picked up (the thank-you, the receipt line, the book-again link only with marketing-grade consent and the
// link pages on). Off by default; each text once per visit; STOP honoured; transactional, so quiet hours never hold them.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { hashToken } from '../../src/modules/auth/tokens.js'
import type { Actor, SchedulingCtx } from '../../src/modules/scheduling/context.js'
import {
  arriveAppointment,
  completeAppointment,
  setPickup,
  startCleaning,
} from '../../src/modules/scheduling/lifecycle.js'
import { buildPreview } from '../../src/modules/settings/http/reminders-preview.js'
import { createStatusTexts, runCheckinTexts, runLateTexts, statusJobDeps } from '../../src/modules/status-texts/index.js'
import type { Tx } from '../../src/platform/db.js'
import { NIL_UUID } from '../../src/platform/ids.js'
import { updateSetting, type SettingKey } from '../../src/platform/settings.js'
import { useWorld } from '../messaging-db/world.js'

const FRI_10 = '2026-06-12T10:00:00-04:00'
const w = useWorld({ start: FRI_10 })

const actor = (): Actor => ({
  auth: { userId: NIL_UUID, employeeId: null, locationId: w.locationId, permissions: new Set(['jobs.status', 'sched.edit']), actorName: 'Desk' },
  audit: { actor: { userId: null, name: 'Desk' } },
})
const ctx = (): Promise<SchedulingCtx> => w.rt.schedulingCtx(w.locationId)
async function step<T>(fn: (tx: Tx, c: SchedulingCtx) => Promise<T>, c?: SchedulingCtx): Promise<T> {
  const cc = c ?? (await ctx())
  return w.tx((tx) => fn(tx, cc))
}
const arrive = (id: string, source?: 'manual' | 'geofence') => step((tx, c) => arriveAppointment(tx, c, actor(), id, source ? { source } : {}))
const start = (id: string) => step((tx, c) => startCleaning(tx, c, actor(), id))
const complete = (id: string) => step((tx, c) => completeAppointment(tx, c, actor(), id))
const pickup = (id: string, state: 'collected' | 'pending' = 'collected', c?: SchedulingCtx) =>
  step((tx, cc) => setPickup(tx, cc, actor(), id, { state }), c)

const at = (iso: string): void => w.clock.set(iso)
const set = (key: SettingKey, value: unknown) => w.tx((tx) => updateSetting(tx, { locationId: w.locationId, key, value }))
const on = async (...keys: SettingKey[]): Promise<void> => {
  for (const k of keys) await set(k, true)
}
const runCheckin = () => runCheckinTexts(statusJobDeps(w.rt))
const runLate = () => runLateTexts(statusJobDeps(w.rt))

const visit = (customer = 'Maria Delgado', iso = FRI_10) => w.appointment({ customer, at: iso })
const texts = (appointmentId: string) =>
  w.t.db
    .selectFrom('messages')
    .select(['id', 'template_key', 'klass', 'body', 'purpose', 'idempotency_key', 'status'])
    .where('appointment_id', '=', appointmentId)
    .where('direction', '=', 'out')
    .orderBy('queued_at')
    .orderBy('id')
    .execute()
const keys = async (appointmentId: string) => (await texts(appointmentId)).map((m) => m.template_key)
const activity = async (appointmentId: string) =>
  (
    await w.t.db.selectFrom('activity_log').select(['text', 'actor_type']).where('appointment_id', '=', appointmentId).orderBy('at').execute()
  ).map((r) => r.text)
const pending = (appointmentId: string) =>
  w.t.db.selectFrom('pending_checkin_texts').selectAll().where('appointment_id', '=', appointmentId).executeTakeFirst()
const outboxOf = (messageId: string) =>
  w.t.db.selectFrom('sms_outbox').select(['body', 'hold_until', 'klass', 'priority']).where('message_id', '=', messageId).executeTakeFirstOrThrow()
/** The text without the STOP line the first text to a number carries. */
const bodyOf = (s: string): string => s.replace(/ Reply STOP to opt out\.$/, '')

async function inboundStop(phone: string): Promise<void> {
  const ev = w.signed('sms:received', {
    messageId: `stop-${w.newId().slice(-8)}`,
    sender: phone,
    recipient: '+15555550100',
    simNumber: 1,
    message: 'STOP',
    receivedAt: w.clock.now().toISOString(),
  })
  await w.rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
  await w.settle()
}

let invoiceNo = 90000
/** The visit's invoice: one item at `cents`, no tax, `paid` paid in cash. */
async function invoice(appointmentId: string, cents: number, paid: number): Promise<string> {
  const a = await w.t.db.selectFrom('appointments').select('customer_id').where('id', '=', appointmentId).executeTakeFirstOrThrow()
  const id = w.newId()
  await w.t.db
    .insertInto('invoices')
    .values({ id, location_id: w.locationId, invoice_no: ++invoiceNo, appointment_id: appointmentId, customer_id: a.customer_id, client_name: 'Maria Delgado', occurred_at: w.clock.now(), biz_date: '2026-06-12', tax_dbp: 0, tip_cents: 0 })
    .execute()
  await w.t.db.insertInto('invoice_items').values({ id: w.newId(), invoice_id: id, position: 0, kind: 'package', service_id: null, name: 'Express Hand Wash', price_cents: cents }).execute()
  if (paid > 0)
    await w.t.db
      .insertInto('ledger_events')
      .values({ id: w.newId(), location_id: w.locationId, invoice_id: id, customer_id: a.customer_id, type: 'pay', amount_cents: paid, method: 'Cash', method_kind: 'cash', occurred_at: w.clock.now() })
      .execute()
  return id
}

const clean = async (): Promise<void> => {
  await sql`delete from settings where key like 'status_texts.%'`.execute(w.t.db)
  await sql`delete from client_link_sessions`.execute(w.t.db)
  await sql`delete from client_links`.execute(w.t.db)
}
beforeEach(clean)
afterEach(clean)

describe('off by default (nothing switches on by itself)', () => {
  it('a manual arrival, a long wash and a pickup send only the texts sent before: wash started and ready', async () => {
    const id = await visit()
    await arrive(id)
    expect(await pending(id)).toBeUndefined()
    await start(id)
    at('2026-06-12T10:50:00-04:00')
    expect(await runLate()).toMatchObject({ considered: 0, queued: 0 })
    await complete(id)
    await pickup(id)
    at('2026-06-12T11:30:00-04:00')
    expect(await runCheckin()).toMatchObject({ considered: 0 })
    expect(await keys(id)).toEqual(['in_progress', 'ready'])
    expect(await w.t.db.selectFrom('appointment_late_texts').selectAll().execute()).toEqual([])
  })
})

describe('checked in', () => {
  it('a manual arrival queues it 3 minutes later; the job sends the welcome text once, without the bay', async () => {
    await on('status_texts.checked_in')
    const id = await visit()
    await arrive(id)
    expect(await pending(id)).toMatchObject({ state: 'pending', due_at: new Date('2026-06-12T10:03:00-04:00'), drop_reason: null })
    at('2026-06-12T10:02:59-04:00')
    expect(await runCheckin()).toMatchObject({ considered: 0 })
    expect(await texts(id)).toEqual([])
    at('2026-06-12T10:03:00-04:00')
    expect(await runCheckin()).toMatchObject({ considered: 1, queued: 1 })
    expect(await runCheckin()).toMatchObject({ considered: 0 })
    const [m] = await texts(id)
    expect(await texts(id)).toHaveLength(1)
    expect(m).toMatchObject({ template_key: 'welcome', klass: 'welcome', purpose: 'checked_in', idempotency_key: `status:checked_in:${id}` })
    expect(bodyOf(m!.body)).toBe("Welcome to Oasis! You're checked in.")
    expect(await pending(id)).toMatchObject({ state: 'sent', message_id: m!.id })
    expect(await activity(id)).toContain('Checked-in text sent')
    // the Settings preview shows exactly this text
    const preview = buildPreview({ values: previewValues(), categories: [], sample: {}, now: w.clock.now(), tz: 'America/New_York' })
    expect(preview.texts.find((t) => t.id === 'status.checked_in')!.text).toBe(bodyOf(m!.body))
  })

  it('follows the configured delay', async () => {
    await on('status_texts.checked_in')
    await set('status_texts.checked_in_delay_min', 0)
    const id = await visit()
    await arrive(id)
    expect(await runCheckin()).toMatchObject({ queued: 1 })
  })

  it('is dropped when the wash starts first: then only "wash started" goes', async () => {
    await on('status_texts.checked_in')
    const id = await visit()
    await arrive(id)
    at('2026-06-12T10:01:00-04:00')
    await start(id)
    expect(await pending(id)).toMatchObject({ state: 'dropped', drop_reason: 'cleaning_started' })
    at('2026-06-12T10:05:00-04:00')
    expect(await runCheckin()).toMatchObject({ considered: 0 })
    expect(await keys(id)).toEqual(['in_progress'])
  })

  it('a geofence arrival got its own welcome text: no second one', async () => {
    await on('status_texts.checked_in')
    const id = await visit()
    await arrive(id, 'geofence')
    expect(await pending(id)).toBeUndefined()
    at('2026-06-12T10:05:00-04:00')
    await runCheckin()
    expect((await keys(id)).filter((k) => k === 'welcome').length).toBeLessThanOrEqual(1)
  })

  it('is dropped when the setting is turned off before it is due, or when it is over 15 minutes late', async () => {
    await on('status_texts.checked_in')
    const a = await visit()
    const b = await visit('Liam Chen')
    await arrive(a)
    await arrive(b)
    await set('status_texts.checked_in', false)
    at('2026-06-12T10:03:00-04:00')
    expect(await runCheckin()).toMatchObject({ considered: 2, dropped: 2, skipped: { disabled: 2 } })
    expect(await pending(a)).toMatchObject({ state: 'dropped', drop_reason: 'disabled' })

    await on('status_texts.checked_in')
    const late = await visit('Liam Chen', '2026-06-12T11:00:00-04:00')
    at('2026-06-12T10:30:00-04:00')
    await arrive(late)
    at('2026-06-12T10:49:00-04:00') // due 10:33, the worker was down: a welcome 16 minutes late is not sent
    expect(await runCheckin()).toMatchObject({ dropped: 1, skipped: { too_late: 1 } })
    expect(await pending(late)).toMatchObject({ state: 'dropped', drop_reason: 'not_sendable' })
    expect(await texts(late)).toEqual([])
  })

  it('STOP after the arrival: nothing goes, the row is dropped and the activity says why', async () => {
    await on('status_texts.checked_in')
    const id = await visit()
    await arrive(id)
    await inboundStop(w.customer('Maria Delgado').phone)
    at('2026-06-12T10:03:00-04:00')
    expect(await runCheckin()).toMatchObject({ queued: 0, dropped: 1, skipped: { opted_out: 1 } })
    expect(await texts(id)).toEqual([])
    expect(await pending(id)).toMatchObject({ state: 'dropped', drop_reason: 'not_sendable' })
    expect(await activity(id)).toContain('Checked-in text not sent (customer opted out of SMS)')
  })

  it('is transactional: quiet hours do not hold it (an automated text queued at the same moment is held)', async () => {
    await on('status_texts.checked_in')
    at('2026-06-12T21:30:00-04:00')
    const id = await visit('Maria Delgado', '2026-06-12T21:00:00-04:00')
    await arrive(id)
    at('2026-06-12T21:33:00-04:00')
    expect(await runCheckin()).toMatchObject({ queued: 1 })
    const [m] = await texts(id)
    expect((await outboxOf(m!.id)).hold_until).toBeNull()
    const target = (await w.rt.queue.target(w.t.db, w.locationId, w.customer('Liam Chen').id))!
    const review = await w.tx((tx) =>
      w.rt.queue.enqueueFor(tx, { locationId: w.locationId, customerId: target.customerId, recipient: target.recipient, appointmentId: null, templateKey: 'review', purpose: 'review', senderKind: 'system' }),
    )
    expect(review).toMatchObject({ queued: true, held: true })
  })
})

describe('running late', () => {
  // Express Hand Wash, 35 minutes: booked 10:00-10:35, cleaning from 10:00, the first late text due at 10:35 + 10 = 10:45
  async function washing(customer = 'Maria Delgado', startAt = FRI_10): Promise<string> {
    const id = await visit(customer)
    at(startAt)
    await arrive(id)
    await start(id)
    return id
  }

  it('past the promised end + grace: a new estimate (now + 15, rounded up to 5), then one more past it, at most two', async () => {
    await on('status_texts.running_late')
    const id = await washing()
    at('2026-06-12T10:44:00-04:00')
    expect(await runLate()).toMatchObject({ considered: 0, queued: 0 })
    at('2026-06-12T10:46:00-04:00')
    expect(await runLate()).toMatchObject({ considered: 1, queued: 1 })
    expect(await runLate()).toMatchObject({ considered: 0, queued: 0 })
    let late = (await texts(id)).filter((m) => m.template_key === 'job_delay')
    expect(late).toHaveLength(1)
    expect(late[0]).toMatchObject({ klass: 'job_delay', purpose: 'running_late', idempotency_key: `status:running_late:${id}:1` })
    expect(bodyOf(late[0]!.body)).toBe("We're running a little behind on your vehicle. New estimate: 11:05 AM. Sorry for the wait!")
    expect(await activity(id)).toContain('Running-late text sent · new estimate 11:05 AM')

    at('2026-06-12T11:14:00-04:00') // the next one only past 11:05 + 10
    expect(await runLate()).toMatchObject({ queued: 0 })
    at('2026-06-12T11:16:00-04:00')
    expect(await runLate()).toMatchObject({ queued: 1 })
    at('2026-06-12T11:46:00-04:00')
    expect(await runLate()).toMatchObject({ queued: 0 })
    late = (await texts(id)).filter((m) => m.template_key === 'job_delay')
    expect(late.map((m) => bodyOf(m.body).match(/New estimate: ([^.]+)\./)![1])).toEqual(['11:05 AM', '11:35 AM'])
    const rows = await w.t.db.selectFrom('appointment_late_texts').select(['seq', 'eta_at', 'message_id']).where('appointment_id', '=', id).orderBy('seq').execute()
    expect(rows).toEqual([
      { seq: 1, eta_at: new Date('2026-06-12T11:05:00-04:00'), message_id: late[0]!.id },
      { seq: 2, eta_at: new Date('2026-06-12T11:35:00-04:00'), message_id: late[1]!.id },
    ])
  })

  it('counts from the start of cleaning when the wash began late, honours late_max and late_grace_min', async () => {
    await on('status_texts.running_late')
    await set('status_texts.late_max', 1)
    await set('status_texts.late_grace_min', 5)
    const id = await washing('Maria Delgado', '2026-06-12T10:30:00-04:00') // promised end 10:30 + 35 = 11:05
    at('2026-06-12T10:50:00-04:00')
    expect(await runLate()).toMatchObject({ queued: 0 })
    at('2026-06-12T11:10:00-04:00')
    expect(await runLate()).toMatchObject({ queued: 1 })
    at('2026-06-12T11:40:00-04:00')
    expect(await runLate()).toMatchObject({ queued: 0 })
    expect((await keys(id)).filter((k) => k === 'job_delay')).toHaveLength(1)
  })

  it('stops when the wash is done, sends nothing stale (a visit left "cleaning"), nothing with late_max 0', async () => {
    await on('status_texts.running_late')
    const done = await washing()
    await complete(done)
    const forgotten = await washing('Liam Chen')
    at('2026-06-12T11:20:00-04:00') // due 10:45, the send window closed at 11:15
    expect(await runLate()).toMatchObject({ queued: 0, skipped: { too_late: 1 } })
    expect((await keys(done)).filter((k) => k === 'job_delay')).toEqual([])
    expect((await keys(forgotten)).filter((k) => k === 'job_delay')).toEqual([])

    await set('status_texts.late_max', 0)
    const other = await washing('Liam Chen', '2026-06-12T12:00:00-04:00')
    at('2026-06-12T12:50:00-04:00')
    expect(await runLate()).toMatchObject({ considered: 0 })
    expect((await keys(other)).filter((k) => k === 'job_delay')).toEqual([])
  })

  it('STOP: the attempt is used up (no retry every 2 minutes) and the activity says why', async () => {
    await on('status_texts.running_late')
    const id = await washing()
    await inboundStop(w.customer('Maria Delgado').phone)
    at('2026-06-12T10:46:00-04:00')
    expect(await runLate()).toMatchObject({ queued: 0, skipped: { opted_out: 1 } })
    at('2026-06-12T10:48:00-04:00')
    expect(await runLate()).toMatchObject({ considered: 0 })
    expect((await keys(id)).filter((k) => k === 'job_delay')).toEqual([])
    expect(await w.t.db.selectFrom('appointment_late_texts').select(['seq', 'message_id']).where('appointment_id', '=', id).execute()).toEqual([
      { seq: 1, message_id: null },
    ])
    expect(await activity(id)).toContain('Running-late text not sent (customer opted out of SMS) · new estimate 11:05 AM')
  })

  it('is transactional: quiet hours do not hold it', async () => {
    await on('status_texts.running_late')
    const id = await washing('Maria Delgado', '2026-06-12T21:00:00-04:00') // booked 10:00, cleaning from 21:00: promised end 21:35
    at('2026-06-12T21:46:00-04:00')
    expect(await runLate()).toMatchObject({ queued: 1 })
    const m = (await texts(id)).find((x) => x.template_key === 'job_delay')!
    expect((await outboxOf(m.id)).hold_until).toBeNull()
  })
})

describe('ready for pickup reads status_texts.ready', () => {
  it('on (the default): the ready text goes as before; off: none, and the activity and the toast say so', async () => {
    const a = await visit()
    await arrive(a)
    await start(a)
    const r1 = await complete(a)
    expect(r1.toast.detail).toBe('Ready-for-pickup sent · moved to pickup')
    expect(await keys(a)).toEqual(['in_progress', 'ready'])

    await set('status_texts.ready', false)
    const b = await visit('Liam Chen')
    await arrive(b)
    await start(b)
    const r2 = await complete(b)
    expect(r2.toast).toEqual({ title: 'Job completed', detail: 'Moved to pickup' })
    expect(await keys(b)).toEqual(['in_progress'])
    expect(await activity(b)).toContain('Ready-for-pickup text is off in Settings')
    expect((await w.t.db.selectFrom('appointments').select('ready_notified_at').where('id', '=', b).executeTakeFirstOrThrow()).ready_notified_at).toBeNull()
  })
})

describe('picked up', () => {
  async function ready(customer = 'Maria Delgado'): Promise<string> {
    const id = await visit(customer)
    await arrive(id)
    await start(id)
    await complete(id)
    return id
  }
  const pickedUpTexts = async (id: string) => (await texts(id)).filter((m) => m.purpose === 'picked_up')

  it('the thank-you at pickup, once per visit even when pickup is reopened and collected again', async () => {
    await on('status_texts.picked_up')
    const id = await ready()
    await pickup(id)
    await pickup(id, 'pending')
    await pickup(id)
    const sent = await pickedUpTexts(id)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ template_key: 'picked_up', klass: 'picked_up', idempotency_key: `status:picked_up:${id}` })
    expect(bodyOf(sent[0]!.body)).toBe('Thanks for visiting Oasis Auto Spa, Maria!')
    expect((await activity(id)).filter((t) => t.startsWith('Picked-up text'))).toEqual(['Picked-up text sent'])
  })

  it('adds "Paid in full" when nothing is owed, not when money is owed or a receipt text went in the last 2 hours', async () => {
    await on('status_texts.picked_up')
    const paid = await ready()
    await invoice(paid, 4500, 4500)
    await pickup(paid)
    const [m] = await pickedUpTexts(paid)
    expect(bodyOf(m!.body)).toBe('Thanks for visiting Oasis Auto Spa, Maria! Paid in full: $45.00.')
    // the Settings preview's sample is a $45.00 visit paid in full: the very text
    const preview = buildPreview({ values: previewValues(), categories: [], sample: {}, now: w.clock.now(), tz: 'America/New_York' })
    expect(preview.texts.find((t) => t.id === 'status.picked_up')!.text).toBe(bodyOf(m!.body))

    const owing = await ready('Liam Chen')
    await invoice(owing, 4500, 2000)
    await pickup(owing)
    expect(bodyOf((await pickedUpTexts(owing))[0]!.body)).toBe('Thanks for visiting Oasis Auto Spa, Liam!')

    const receipted = await ready('Liam Chen')
    await invoice(receipted, 4500, 4500)
    const target = (await w.rt.queue.target(w.t.db, w.locationId, w.customer('Liam Chen').id))!
    await w.tx((tx) =>
      w.rt.queue.enqueueFor(tx, { locationId: w.locationId, customerId: target.customerId, recipient: target.recipient, appointmentId: null, text: 'Oasis Auto Spa receipt #1: total $45.00, paid $45.00. Thank you!', klass: 'receipt', purpose: 'receipt', senderKind: 'system' }),
    )
    at('2026-06-12T11:59:00-04:00')
    await pickup(receipted)
    expect(bodyOf((await pickedUpTexts(receipted))[0]!.body)).toBe('Thanks for visiting Oasis Auto Spa, Liam!')
  })

  it('never uses a placeholder name', async () => {
    await on('status_texts.picked_up')
    const id = await ready()
    await sql`update customers set needs_details = true where id = ${w.customer('Maria Delgado').id}`.execute(w.t.db)
    try {
      await pickup(id)
    } finally {
      await sql`update customers set needs_details = false where id = ${w.customer('Maria Delgado').id}`.execute(w.t.db)
    }
    expect(bodyOf((await pickedUpTexts(id))[0]!.body)).toBe('Thanks for visiting Oasis Auto Spa!')
  })

  describe('the book-again link', () => {
    const SITE = 'https://oasisautospanj.com'
    /** The scheduling context with the link pages on (PUBLIC_LINKS_ENABLED=true). */
    const linksOn = async (): Promise<SchedulingCtx> => {
      const c = await ctx()
      return { ...c, ports: { ...c.ports, statusTexts: createStatusTexts({ queue: w.rt.queue, links: { enabled: true, siteUrl: SITE } }) } }
    }
    const marketing = (name: string) => sql`update customers set sms_opt_in_source = 'squarespace' where id = ${w.customer(name).id}`.execute(w.t.db)
    const links = () => w.t.db.selectFrom('client_links').selectAll().execute()

    it('goes with marketing-grade consent, the setting on and the link pages on: masked in the thread, real only in the outbox', async () => {
      await on('status_texts.picked_up', 'status_texts.book_again_link')
      await marketing('Maria Delgado')
      const id = await ready()
      await pickup(id, 'collected', await linksOn())
      const [m] = await pickedUpTexts(id)
      expect(m).toMatchObject({ template_key: 'picked_up_link', klass: 'personal_link' })
      expect(bodyOf(m!.body)).toBe('Thanks for visiting Oasis Auto Spa, Maria! Book your next visit: [private link]')
      const out = await outboxOf(m!.id)
      const token = out.body.match(/#\/c\/([A-Za-z0-9_-]{43})/)![1]!
      expect(out.body).toContain(`${SITE}/#/c/${token}`)
      const [link] = await links()
      expect(await links()).toHaveLength(1)
      expect(link).toMatchObject({ kind: 'book_again', customer_id: w.customer('Maria Delgado').id, issued_by: 'system', token_hash: hashToken(token), revoked_at: null })
      // the token is nowhere but the outbox: not in the message row, not in the activity log
      expect(JSON.stringify(await activity(id))).not.toContain(token)
      expect(await activity(id)).toContain('Picked-up text sent')
    })

    it('stays out without marketing-grade consent, with the setting off, or while the link pages are off', async () => {
      await on('status_texts.picked_up', 'status_texts.book_again_link')
      const transactionalOnly = await ready() // opted in through a booking form: transactional consent only
      await pickup(transactionalOnly, 'collected', await linksOn())
      expect((await pickedUpTexts(transactionalOnly))[0]).toMatchObject({ template_key: 'picked_up' })

      await marketing('Liam Chen')
      const pagesOff = await ready('Liam Chen')
      await pickup(pagesOff) // the production port: PUBLIC_LINKS_ENABLED is false
      expect((await pickedUpTexts(pagesOff))[0]).toMatchObject({ template_key: 'picked_up' })

      await set('status_texts.book_again_link', false)
      const settingOff = await ready('Liam Chen')
      await pickup(settingOff, 'collected', await linksOn())
      expect((await pickedUpTexts(settingOff))[0]).toMatchObject({ template_key: 'picked_up' })
      expect(await links()).toEqual([])
    })

    it('STOP: no text and no link', async () => {
      await on('status_texts.picked_up', 'status_texts.book_again_link')
      await marketing('Maria Delgado')
      const id = await ready()
      await inboundStop(w.customer('Maria Delgado').phone)
      await pickup(id, 'collected', await linksOn())
      expect(await pickedUpTexts(id)).toEqual([])
      expect(await links()).toEqual([])
      expect(await activity(id)).toContain('Picked-up text not sent (customer opted out of SMS)')
    })
  })

  it('is transactional: quiet hours do not hold it', async () => {
    await on('status_texts.picked_up')
    at('2026-06-12T21:00:00-04:00')
    const id = await ready()
    at('2026-06-12T21:30:00-04:00')
    await pickup(id)
    const [m] = await pickedUpTexts(id)
    expect((await outboxOf(m!.id)).hold_until).toBeNull()
  })

  it('a failing status text never blocks the pickup: rolled back to its savepoint and logged', async () => {
    await on('status_texts.picked_up')
    const id = await ready()
    const errors: unknown[] = []
    const c = await ctx()
    const broken = createStatusTexts({
      queue: { enqueueFor: (tx, a) => w.rt.queue.enqueueFor(tx, a), target: async () => { throw new Error('boom') } },
      links: { enabled: false },
      log: { error: (o) => void errors.push(o) },
    })
    const r = await pickup(id, 'collected', { ...c, ports: { ...c.ports, statusTexts: broken } })
    expect(r.appointment.pickupState).toBe('collected')
    expect((await w.t.db.selectFrom('appointments').select('pickup_state').where('id', '=', id).executeTakeFirstOrThrow()).pickup_state).toBe('collected')
    expect(errors).toEqual([expect.objectContaining({ err: 'boom', appointmentId: id, change: 'pickup' })])
    expect(await pickedUpTexts(id)).toEqual([])
  })
})

/** Settings values for the preview: every status text on, the defaults otherwise. */
function previewValues() {
  return {
    reminders: { offsetsMin: [1440], confirmRequest: true, categoryPrep: {}, reviewRequest: false },
    statusTexts: { checkedIn: true, checkedInDelayMin: 3, runningLate: true, lateGraceMin: 10, lateMax: 2, ready: true, pickedUp: true, bookAgainLink: false },
    leads: { followUpEnabled: false, followUpDelayMin: 180, businessHoursOnly: true, withinHours: 24 },
  }
}
