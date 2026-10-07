// appointments.reminders and appointments.review_request through the real pg-boss worker, on the `design` seed with the SMS
// simulator and a frozen clock that the tests move: moments, one message per moment however often the job runs, skips
// for cancelled and opted-out customers, quiet hours, reschedules, two workers at once and the review request flag.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { remindersJob, reviewRequestJob } from '../../src/modules/messaging/jobs/reminders.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { useWorld } from '../messaging-db/world.js'
import { useJobsHarness } from './harness.js'

const FRI_NOON = '2026-06-12T12:00:00-04:00'
const w = useWorld({ start: FRI_NOON })
const h = useJobsHarness({ testDb: () => w.t })

const saved: Record<string, string | undefined> = {}
beforeAll(() => {
  // the job handlers build their messaging runtime from the process environment
  const vars = {
    DATABASE_URL: testDatabaseUrl(),
    DB_SEARCH_PATH: `${w.t.schema},public`,
    SMS_ALLOWLIST: w.env.SMS_ALLOWLIST,
    SMSGATE_MIN_INTERVAL_MS: '0',
    EMAIL_CONSOLE_DIR: w.env.EMAIL_CONSOLE_DIR,
  }
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
})

const defs = [remindersJob, reviewRequestJob] as never

/** Runs a job once through pg-boss and waits until that run is completed. */
async function runThroughQueue(
  worker: Awaited<ReturnType<typeof h.start>>,
  name: string,
  key?: string,
): Promise<void> {
  const before = (await h.states(worker.schema, name)).filter((s) => s === 'completed').length
  await worker.jobs.enqueue(name, {}, key ? { singletonKey: key } : {})
  await h.waitFor(
    async () => (await h.states(worker.schema, name)).filter((s) => s === 'completed').length > before,
  )
}

const messages = (appointmentId: string) =>
  w.t.db
    .selectFrom('messages')
    .select(['id', 'template_key', 'klass', 'body', 'status', 'idempotency_key', 'customer_id'])
    .where('appointment_id', '=', appointmentId)
    .where('purpose', 'in', ['reminder', 'review'])
    .orderBy('queued_at')
    .orderBy('id')
    .execute()

const at = (iso: string): void => w.clock.set(iso)

afterEach(async () => {
  await sql`delete from settings where key = 'reviews.enabled'`.execute(w.t.db)
})

describe('appointments.reminders', () => {
  it('sends the 24 h and 2 h reminders once each, however many times the job runs', async () => {
    const booked = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    const confirmed = await w.appointment({
      customer: 'Maria Delgado',
      at: '2026-06-13T14:00:00-04:00',
      status: 'confirmed',
    })
    const worker = await h.start({ definitions: defs })

    at('2026-06-12T13:59:00-04:00') // one minute before the 24 h moment
    await runThroughQueue(worker, 'appointments.reminders')
    expect(await messages(booked)).toEqual([])

    at('2026-06-12T14:00:00-04:00') // exactly 24 h before
    await runThroughQueue(worker, 'appointments.reminders')
    await runThroughQueue(worker, 'appointments.reminders') // second run: no second message
    const [ask] = await messages(booked)
    const [remind] = await messages(confirmed)
    expect(await messages(booked)).toHaveLength(1)
    expect(await messages(confirmed)).toHaveLength(1)
    expect(ask).toMatchObject({ template_key: 'confirm_request', klass: 'confirm_request', status: 'queued' })
    expect(ask!.body).toContain('tomorrow at 2:00 PM')
    expect(ask!.body).toContain('Reply C to confirm')
    expect(ask!.idempotency_key).toBe(
      `reminder:${booked}:1440:${new Date('2026-06-13T14:00:00-04:00').getTime()}`,
    )
    expect(remind).toMatchObject({ template_key: 'reminder', klass: 'reminder' })
    expect(remind!.body).toContain('Reminder: your Oasis Auto Spa appointment is tomorrow at 2:00 PM.')

    const activity = await w.t.db
      .selectFrom('activity_log')
      .select(['text', 'channels', 'actor_type'])
      .where('appointment_id', '=', booked)
      .execute()
    expect(activity).toEqual([
      { text: 'Confirmation request sent · 24 h before', channels: ['sms'], actor_type: 'automation' },
    ])

    at('2026-06-13T12:00:00-04:00') // 2 h before
    await runThroughQueue(worker, 'appointments.reminders')
    await runThroughQueue(worker, 'appointments.reminders')
    expect((await messages(booked)).map((m) => m.idempotency_key!.split(':')[2])).toEqual(['1440', '120'])
    expect((await messages(confirmed)).map((m) => m.idempotency_key!.split(':')[2])).toEqual(['1440', '120'])
    expect((await messages(confirmed))[1]!.body).toContain('is today at 2:00 PM')

    // the run log says what happened, without naming anyone
    const processed = h.logs.filter((l) => l.msg === 'reminders processed')
    expect(processed.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(h.logs)).not.toContain('Maria')
  })

  it('skips cancelled, no-show, arrived and opted-out appointments and says why', async () => {
    const cancelled = await w.appointment({
      customer: 'Maria Delgado',
      at: '2026-06-13T14:00:00-04:00',
      status: 'canceled',
    })
    const noShow = await w.appointment({
      customer: 'Maria Delgado',
      at: '2026-06-13T14:00:00-04:00',
      status: 'no_show',
    })
    const arrived = await w.appointment({
      customer: 'Maria Delgado',
      at: '2026-06-13T14:00:00-04:00',
      status: 'arrived',
    })
    const optedOutId = w.customer('Liam Chen')
    const gone = await w.appointment({ customer: 'Liam Chen', at: '2026-06-13T14:00:00-04:00' })
    await sql`update customers set sms_opted_out_at = ${w.clock.now()} where id = ${optedOutId.id}`.execute(
      w.t.db,
    )
    const worker = await h.start({ definitions: defs })
    at('2026-06-12T14:00:00-04:00')
    await runThroughQueue(worker, 'appointments.reminders')
    for (const id of [cancelled, noShow, arrived, gone]) expect(await messages(id), id).toEqual([])
    const processed = h.logs.find((l) => l.msg === 'reminders processed')
    expect(processed).toMatchObject({ considered: 1, queued: 0, skipped: { opted_out: 1 } })
  })

  it('does not send a reminder whose moment is more than an hour old (the worker was down)', async () => {
    const id = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    const worker = await h.start({ definitions: defs })
    at('2026-06-12T15:30:00-04:00') // 90 minutes after the 24 h moment
    await runThroughQueue(worker, 'appointments.reminders')
    expect(await messages(id)).toEqual([])
  })

  it('does not send the 24 h reminder for a booking made inside the window, only the 2 h one', async () => {
    at('2026-06-13T09:00:00-04:00')
    const id = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' }) // booked 5 h before
    const worker = await h.start({ definitions: defs })
    await runThroughQueue(worker, 'appointments.reminders')
    expect(await messages(id)).toEqual([])
    at('2026-06-13T12:00:00-04:00')
    await runThroughQueue(worker, 'appointments.reminders')
    expect((await messages(id)).map((m) => m.idempotency_key!.split(':')[2])).toEqual(['120'])
  })

  it('a rescheduled appointment gets reminders for its new time, and the old ones stay a single message', async () => {
    const id = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    const worker = await h.start({ definitions: defs })
    at('2026-06-12T14:00:00-04:00')
    await runThroughQueue(worker, 'appointments.reminders')
    expect(await messages(id)).toHaveLength(1)
    await sql`update appointments set scheduled_start = ${new Date('2026-06-14T10:00:00-04:00')}, scheduled_end = ${new Date('2026-06-14T11:00:00-04:00')} where id = ${id}`.execute(
      w.t.db,
    )
    await runThroughQueue(worker, 'appointments.reminders')
    expect(await messages(id)).toHaveLength(1) // 10:00 Sunday is not due yet
    at('2026-06-13T10:00:00-04:00')
    await runThroughQueue(worker, 'appointments.reminders')
    const keys = (await messages(id)).map((m) => m.idempotency_key)
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(`reminder:${id}:1440:${new Date('2026-06-14T10:00:00-04:00').getTime()}`)
  })

  it('holds a reminder through quiet hours but never past the start of the visit', async () => {
    // 08:05 visit: its 2 h moment (06:05) is inside 21:00-08:00 and the hold ends at 08:00, five minutes before the visit
    const tooEarly = await w.appointment({ customer: 'Liam Chen', at: '2026-06-13T08:05:00-04:00' })
    // 09:00 visit: its 2 h moment (07:00) is quiet too, so it leaves at 08:00 and expires at 09:00
    const early = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T09:00:00-04:00' })
    const worker = await h.start({ definitions: defs })
    at('2026-06-13T06:05:00-04:00')
    await runThroughQueue(worker, 'appointments.reminders')
    expect(await messages(tooEarly)).toEqual([])
    expect(h.logs.filter((l) => l.msg === 'reminders processed').at(-1)).toMatchObject({
      considered: 1,
      queued: 0,
      skipped: { quiet_hours: 1 },
    })
    at('2026-06-13T07:00:00-04:00')
    await runThroughQueue(worker, 'appointments.reminders')
    expect((await messages(early)).map((m) => m.idempotency_key!.split(':')[2])).toEqual(['120'])
    const outbox = await w.t.db
      .selectFrom('sms_outbox')
      .innerJoin('messages as m', 'm.id', 'sms_outbox.message_id')
      .select(['sms_outbox.hold_until', 'sms_outbox.ttl_at', 'sms_outbox.state'])
      .where('m.appointment_id', '=', early)
      .executeTakeFirstOrThrow()
    expect(outbox.hold_until).toEqual(new Date('2026-06-13T08:00:00-04:00'))
    expect(outbox.ttl_at).toEqual(new Date('2026-06-13T09:00:00-04:00'))
  })

  it('two workers running the job at the same moment queue one message per reminder', async () => {
    const ids: string[] = []
    for (let i = 0; i < 6; i++)
      ids.push(await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' }))
    const schema = h.newSchema()
    const a = await h.start({ schema, definitions: defs })
    await h.start({ schema, definitions: defs })
    at('2026-06-12T14:00:00-04:00')
    for (const key of ['k1', 'k2', 'k3', 'k4'])
      await a.jobs.enqueue('appointments.reminders', {}, { singletonKey: key })
    await h.waitFor(
      async () =>
        (await h.states(schema, 'appointments.reminders')).filter((s) => s === 'completed').length === 4,
    )
    for (const id of ids) expect(await messages(id), id).toHaveLength(1)
  })
})

describe('appointments.review_request', () => {
  it('does nothing while reviews.enabled is off (the default)', async () => {
    const id = await w.appointment({
      customer: 'Maria Delgado',
      at: '2026-06-12T08:00:00-04:00',
      status: 'completed',
      completedAt: '2026-06-12T09:00:00-04:00',
    })
    const worker = await h.start({ definitions: defs })
    await runThroughQueue(worker, 'appointments.review_request')
    expect(await messages(id)).toEqual([])
  })

  it('sends one review request 2 h after completion when enabled, not before, not twice, not after a day', async () => {
    const fresh = await w.appointment({
      customer: 'Maria Delgado',
      at: '2026-06-12T08:00:00-04:00',
      status: 'completed',
      completedAt: '2026-06-12T10:30:00-04:00',
    })
    const old = await w.appointment({
      customer: 'Liam Chen',
      at: '2026-06-11T08:00:00-04:00',
      status: 'completed',
      completedAt: '2026-06-11T10:30:00-04:00',
    })
    await sql`insert into settings (location_id, key, value) values (${w.locationId}, 'reviews.enabled', 'true'::jsonb)`.execute(
      w.t.db,
    )
    const worker = await h.start({ definitions: defs })
    at('2026-06-12T12:29:00-04:00') // 1 h 59 min after completion
    await runThroughQueue(worker, 'appointments.review_request')
    expect(await messages(fresh)).toEqual([])
    at('2026-06-12T12:30:00-04:00')
    await runThroughQueue(worker, 'appointments.review_request')
    await runThroughQueue(worker, 'appointments.review_request')
    const sent = await messages(fresh)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      template_key: 'review',
      klass: 'review',
      idempotency_key: `review:${fresh}`,
    })
    expect(sent[0]!.body).toContain('How did we do?')
    expect(await messages(old)).toEqual([]) // completed 26 hours ago: too late to ask
    expect(
      await w.t.db.selectFrom('activity_log').select('text').where('appointment_id', '=', fresh).execute(),
    ).toEqual([{ text: 'Review request sent' }])
  })
})
