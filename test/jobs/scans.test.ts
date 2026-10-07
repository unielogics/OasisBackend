// The scheduled sweeps that have no customer-facing text: VIP hold release, store-credit expiry and the retention jobs
// (sessions, 24-month messages, photos). Each runs through the real pg-boss worker on a frozen clock that the tests move.
import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { createStorageProvider } from '../../src/integrations/storage/config.js'
import { creditExpireJob } from '../../src/modules/payments/jobs-credit.js'
import { recordAllocations } from '../../src/modules/payments/credit.js'
import { photoRetentionJob } from '../../src/modules/scheduling/jobs-retention.js'
import { vipHoldReleaseJob } from '../../src/modules/scheduling/jobs-vip.js'
import { maintenanceRetentionJob } from '../../src/platform/maintenance.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { makeUser } from '../helpers/factories.js'
import { useWorld } from '../messaging-db/world.js'
import { addEvent, makeInvoice, type Env } from '../payments/helpers.js'
import { useJobsHarness } from './harness.js'

const w = useWorld({ start: '2026-06-11T09:00:00-04:00' })
const h = useJobsHarness({ testDb: () => w.t })
const fsRoot = mkdtempSync(path.join(tmpdir(), 'oasis-files-'))

const saved: Record<string, string | undefined> = {}
beforeAll(() => {
  for (const [k, v] of Object.entries({
    DATABASE_URL: testDatabaseUrl(),
    DB_SEARCH_PATH: `${w.t.schema},public`,
    STORAGE_PROVIDER: 'fs',
    STORAGE_FS_ROOT: fsRoot,
  })) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
})

async function runOnce(
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

const at = (iso: string): void => w.clock.set(iso)
const D = 24 * 3600_000

describe('vip.hold_release_scan', () => {
  const setHold = async (weekday: number, timeMin: number, releaseHours = 48): Promise<string> => {
    await sql`delete from vip_holds`.execute(w.t.db)
    const id = w.newId()
    await w.t.db
      .insertInto('vip_holds')
      .values({ id, location_id: w.locationId, weekday, time_min: timeMin })
      .execute()
    await sql`update vip_settings set release_hours = ${releaseHours} where location_id = ${w.locationId}`.execute(
      w.t.db,
    )
    return id
  }
  const releases = async () =>
    (
      await w.t.db
        .selectFrom('realtime_events')
        .select(['type', 'payload', 'channel'])
        .where('type', '=', 'availability.changed')
        .orderBy('id')
        .execute()
    ).map((e) => ({ channel: e.channel, ...e.payload }))

  it('announces a held slot once, at its release moment (48 h before), and not before', async () => {
    const hold = await setHold(6, 10 * 60) // Saturdays at 10:00; Thu 2026-06-11 10:00 EDT is 48 h before Sat 06-13 10:00
    const worker = await h.start({ definitions: [vipHoldReleaseJob] as never })
    at('2026-06-11T09:59:00-04:00')
    await runOnce(worker, 'vip.hold_release_scan')
    expect(await releases()).toEqual([])

    at('2026-06-11T10:00:00-04:00')
    await runOnce(worker, 'vip.hold_release_scan')
    await runOnce(worker, 'vip.hold_release_scan') // a second run announces nothing new
    expect(await releases()).toEqual([{ channel: 'ops', date: '2026-06-13' }])
    const rows = await w.t.db.selectFrom('vip_hold_releases').selectAll().execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ hold_id: hold, location_id: w.locationId })
    expect(rows[0]!.slot_start).toEqual(new Date('2026-06-13T10:00:00-04:00'))

    // the next Saturday's slot is released a week later
    at('2026-06-18T10:00:00-04:00')
    await runOnce(worker, 'vip.hold_release_scan')
    expect(await releases()).toEqual([
      { channel: 'ops', date: '2026-06-13' },
      { channel: 'ops', date: '2026-06-20' },
    ])
  })

  it('computes the release moment in elapsed hours across the spring-forward change', async () => {
    // Sunday 2027-03-14 09:00 EDT is 13:00Z; 48 h before is 2027-03-12 13:00Z = 08:00 EST (not 09:00 on the wall clock)
    await setHold(0, 9 * 60)
    const worker = await h.start({ definitions: [vipHoldReleaseJob] as never })
    at('2027-03-12T07:59:00-05:00')
    await runOnce(worker, 'vip.hold_release_scan')
    expect(await releases()).toEqual([])
    at('2027-03-12T08:00:00-05:00')
    await runOnce(worker, 'vip.hold_release_scan')
    expect(await releases()).toEqual([{ channel: 'ops', date: '2027-03-14' }])
    expect(
      (await w.t.db.selectFrom('vip_hold_releases').select('slot_start').execute())[0]!.slot_start,
    ).toEqual(new Date('2027-03-14T13:00:00Z'))
  })

  it('does not announce a slot whose start has passed, and two workers announce it once', async () => {
    await setHold(6, 10 * 60)
    const schema = h.newSchema()
    const a = await h.start({ schema, definitions: [vipHoldReleaseJob] as never })
    await h.start({ schema, definitions: [vipHoldReleaseJob] as never })
    at('2026-06-13T11:00:00-04:00') // Saturday 11:00: today's 10:00 slot is over; next Saturday's is 7 days away
    await runOnce(a, 'vip.hold_release_scan')
    expect(await releases()).toEqual([])
    at('2026-06-11T10:30:00-04:00')
    for (const key of ['x1', 'x2', 'x3'])
      await a.jobs.enqueue('vip.hold_release_scan', {}, { singletonKey: key })
    await h.waitFor(
      async () =>
        (await h.states(schema, 'vip.hold_release_scan')).filter((s) => s === 'completed').length === 4,
    )
    expect(await releases()).toEqual([{ channel: 'ops', date: '2026-06-13' }])
  })
})

describe('credit.expire', () => {
  const day = (n: number): Date => new Date(new Date('2026-06-11T09:00:00-04:00').getTime() + n * D)
  const env = (): Env => ({
    location: { id: w.locationId } as never,
    locationId: w.locationId,
    newId: w.newId,
  })
  const expiries = async () =>
    w.t.db
      .selectFrom('credit_expiries')
      .select(['lot_event_id', 'expired_cents', 'customer_id'])
      .orderBy('expires_at')
      .execute()
  const payEvents = async () =>
    (
      await w.t.db
        .selectFrom('realtime_events')
        .select(['payload'])
        .where('type', '=', 'credit.expired')
        .orderBy('id')
        .execute()
    ).map((e) => e.payload)

  async function managers(): Promise<void> {
    await sql`insert into users (id, employee_id, email, password_hash)
      select gen_random_uuid(), e.id, lower(e.first) || '@example.test', 'not-a-real-hash' from employees e
      where not exists (select 1 from users u where u.employee_id = e.id)`.execute(w.t.db)
  }

  it('announces the unspent remainder of an expired lot, FIFO-aware, once, and tells the managers', async () => {
    await managers()
    const maria = w.customer('Maria Delgado').id
    const inv = await makeInvoice(w.t.db, env(), { customerId: maria })
    const apply = await makeInvoice(w.t.db, env(), { customerId: maria })
    // lot A $25 expires day 10, lot B $30 expires day 30, lot C $40 never expires
    const A = await addEvent(w.t.db, env(), inv, {
      type: 'credit_issue',
      amountCents: 2500,
      expiry: 'd30',
      expiresAt: day(10),
      at: day(0),
    })
    const B = await addEvent(w.t.db, env(), inv, {
      type: 'credit_issue',
      amountCents: 3000,
      expiry: 'd90',
      expiresAt: day(30),
      at: day(0),
    })
    await addEvent(w.t.db, env(), inv, {
      type: 'credit_issue',
      amountCents: 4000,
      expiry: 'none',
      at: day(0),
    })
    // day 5: a $30 credit_apply is allocated FIFO: all of A (earliest expiry), then $5 of B
    const applyId = await addEvent(w.t.db, env(), apply, {
      type: 'credit_apply',
      amountCents: 3000,
      methodKind: 'store_credit',
      at: day(5),
    })
    await w.t.db.transaction().execute((tx) =>
      recordAllocations(tx, {
        applyEventId: applyId,
        customerId: maria,
        cents: 3000,
        at: day(5),
        newId: w.newId,
      }),
    )
    const worker = await h.start({ definitions: [creditExpireJob] as never })

    at(day(9).toISOString())
    await runOnce(worker, 'credit.expire')
    expect(await expiries()).toEqual([])

    at(day(11).toISOString()) // A expired but was used up completely: nothing is lost
    await runOnce(worker, 'credit.expire')
    expect(await expiries()).toEqual([])

    at(day(31).toISOString()) // B expired with $25 of its $30 unspent
    await runOnce(worker, 'credit.expire')
    await runOnce(worker, 'credit.expire')
    expect(await expiries()).toEqual([{ lot_event_id: B, expired_cents: 2500, customer_id: maria }])
    expect(A).not.toBe(B)
    expect(await payEvents()).toEqual([{ customerId: maria, cents: 2500 }])
    const notes = await w.t.db
      .selectFrom('notifications')
      .select(['kind', 'title', 'body', 'entity_id'])
      .where('kind', '=', 'credit.expired')
      .execute()
    expect(notes.length).toBeGreaterThan(0)
    expect(notes[0]).toMatchObject({ title: 'Store credit expired', entity_id: maria })
    expect(notes[0]!.body).toBe("$25.00 of Maria Delgado's store credit expired unused")
    // the never-expiring lot is untouched and the ledger gained no rows
    expect((await w.t.db.selectFrom('ledger_events').select('id').execute()).length).toBe(4)
  })
})

describe('retention', () => {
  const months = (n: number): Date => {
    const d = new Date(w.clock.now())
    d.setUTCMonth(d.getUTCMonth() - n)
    return d
  }

  it('maintenance.retention removes sessions, 24-month-old messages and old bookkeeping, and never touches audit_log', async () => {
    const { userId } = await makeUser(w.t.db, w.newId)
    const now = w.clock.now().getTime()
    const sid = (name: string): string => createHash('sha256').update(name).digest('hex')
    const session = (name: string, over: Partial<{ idle: Date; abs: Date; revoked: Date | null }> = {}) => ({
      id: sid(name),
      user_id: userId,
      csrf_secret: 'x',
      created_at: new Date(now - 40 * D),
      last_seen_at: new Date(now - 40 * D),
      idle_expires_at: over.idle ?? new Date(now + D),
      absolute_expires_at: over.abs ?? new Date(now + D),
      revoked_at: over.revoked ?? null,
    })
    await w.t.db
      .insertInto('sessions')
      .values([
        session('live'),
        session('expired-long-ago', { idle: new Date(now - 9 * D), abs: new Date(now - 8 * D) }),
        session('expired-recently', { idle: new Date(now - 2 * D), abs: new Date(now - 1 * D) }),
        session('revoked-long-ago', { revoked: new Date(now - 10 * D) }),
        session('revoked-yesterday', { revoked: new Date(now - D) }),
      ])
      .execute()

    const maria = w.customer('Maria Delgado').id
    const msg = (id: string, createdAt: Date) => ({
      id,
      location_id: w.locationId,
      customer_id: maria,
      direction: 'out' as const,
      sender_kind: 'system' as const,
      body: 'hello',
      status: 'sent' as const,
      created_at: createdAt,
    })
    const oldMsg = w.newId()
    const recentMsg = w.newId()
    await w.t.db
      .insertInto('messages')
      .values([msg(oldMsg, months(25)), msg(recentMsg, months(23))])
      .execute()
    await w.t.db
      .insertInto('sms_outbox')
      .values({
        id: w.newId(),
        message_id: oldMsg,
        to_e164: '+13055550101',
        body: 'hello',
        encoding: 'GSM-7',
        segments: 1,
        klass: 'reminder',
        priority: 2,
        state: 'sent',
        ttl_at: months(25),
      } as never)
      .execute()
    await w.t.db
      .insertInto('sms_processed_events')
      .values([
        { event_id: 'old-evt', processed_at: new Date(now - 100 * D) },
        { event_id: 'new-evt', processed_at: new Date(now - 10 * D) },
      ])
      .execute()
    await w.t.db
      .insertInto('audit_log')
      .values({ location_id: w.locationId, action: 'a', entity_type: 'b', at: new Date(0) })
      .execute()

    const worker = await h.start({ definitions: [maintenanceRetentionJob] as never })
    await runOnce(worker, 'maintenance.retention')
    await runOnce(worker, 'maintenance.retention')

    expect(
      (await w.t.db.selectFrom('sessions').select('id').orderBy('id').execute()).map((r) => r.id),
    ).toEqual(['expired-recently', 'live', 'revoked-yesterday'].map(sid).sort())
    expect((await w.t.db.selectFrom('messages').select('id').execute()).map((r) => r.id)).toEqual([recentMsg])
    expect(await w.t.db.selectFrom('sms_outbox').select('id').execute()).toEqual([]) // cascaded with its message
    expect(
      (await w.t.db.selectFrom('sms_processed_events').select('event_id').execute()).map((r) => r.event_id),
    ).toEqual(['new-evt'])
    expect(await w.t.db.selectFrom('audit_log').selectAll().execute()).toHaveLength(1)
    const run = h.logs.filter((l) => l.msg === 'maintenance.retention done')
    expect(run[0]).toMatchObject({ removed: { sessions: 2, messages: 1, sms_processed_events: 1 } })
    expect(run[1]).toMatchObject({ removed: { sessions: 0, messages: 0, sms_processed_events: 0 } })
  })

  it('photos.retention deletes the objects of deleted photos and of photos past 24 months, and is safe to repeat', async () => {
    const storage = createStorageProvider(h.env({ STORAGE_FS_ROOT: fsRoot }))
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-12T09:00:00-04:00' })
    const png = Buffer.from('89504e470d0a1a0a', 'hex')
    const photo = async (key: string, status: 'ready' | 'deleted' | 'pending_upload', createdAt: Date) => {
      const id = w.newId()
      await storage.put(`${key}.jpg`, png, 'image/jpeg')
      await storage.put(`${key}.thumb.webp`, png, 'image/webp')
      await w.t.db
        .insertInto('appointment_photos')
        .values({
          id,
          appointment_id: appt,
          category: 'before',
          s3_key: `${key}.jpg`,
          thumb_key: `${key}.thumb.webp`,
          content_type: 'image/jpeg',
          bytes: png.length,
          status,
          created_at: createdAt,
        } as never)
        .execute()
      return id
    }
    const keep = await photo('keep', 'ready', months(3))
    const deleted = await photo('deleted', 'deleted', months(1))
    const ancient = await photo('ancient', 'ready', months(25))
    const worker = await h.start({ definitions: [photoRetentionJob] as never })
    await runOnce(worker, 'photos.retention')
    await runOnce(worker, 'photos.retention')

    const rows = await w.t.db
      .selectFrom('appointment_photos')
      .select(['id', 's3_key', 'thumb_key', 'status'])
      .orderBy('id')
      .execute()
    expect(rows.find((r) => r.id === keep)).toMatchObject({
      s3_key: 'keep.jpg',
      thumb_key: 'keep.thumb.webp',
      status: 'ready',
    })
    expect(rows.find((r) => r.id === deleted)).toBeUndefined()
    expect(rows.find((r) => r.id === ancient)).toBeUndefined()
    expect(await storage.head('keep.jpg')).not.toBeNull()
    expect(await storage.head('keep.thumb.webp')).not.toBeNull()
    for (const k of ['deleted.jpg', 'deleted.thumb.webp', 'ancient.jpg', 'ancient.thumb.webp'])
      expect(await storage.head(k), k).toBeNull()
    const done = h.logs.filter((l) => l.msg === 'photos.retention done')
    expect(done[0]).toMatchObject({ deletedRemoved: 1, expiredRemoved: 1, objectsDeleted: 4, failures: 0 })
    expect(done[1]).toMatchObject({ deletedRemoved: 0, expiredRemoved: 0, objectsDeleted: 0, failures: 0 })
  })

  it('photos.retention fails the job (so it retries and dead-letters) when storage cannot delete', async () => {
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-12T09:00:00-04:00' })
    const id = w.newId()
    await w.t.db
      .insertInto('appointment_photos')
      .values({
        id,
        appointment_id: appt,
        category: 'before',
        s3_key: 'x/../../escape.jpg', // a key the filesystem provider refuses
        thumb_key: null,
        content_type: 'image/jpeg',
        bytes: 1,
        status: 'deleted',
        created_at: months(1),
      } as never)
      .execute()
    const worker = await h.start({ definitions: [{ ...photoRetentionJob, retryLimit: 0 }] as never })
    await worker.jobs.enqueue('photos.retention', {})
    await h.waitFor(async () => (await h.states(worker.schema, 'photos.retention')).includes('failed'))
    expect(
      (
        await w.t.db
          .selectFrom('appointment_photos')
          .select('s3_key')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).s3_key,
    ).toBe('x/../../escape.jpg')
    expect((await h.rows(worker.schema, 'photos.retention.dead')).length).toBe(1)
  })
})
