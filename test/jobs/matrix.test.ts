// Every registered job through the real pg-boss worker, twice: the first run has its effect, the second changes nothing.
// A job with its own double-run suite is listed under `dedicated` and the test proves that suite names it. A job that is
// in the registry and in neither list fails the test, so a new job cannot ship without a proof.
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { sql } from 'kysely'
import { createStorageProvider } from '../../src/integrations/storage/config.js'
import { queueEmail } from '../../src/modules/messaging/email/service.js'
import {
  emailSendJob,
  smsHealthJob,
  smsReconcileJob,
  smsRegisterWebhooksJob,
} from '../../src/modules/messaging/jobs/index.js'
import { alertsScanJob } from '../../src/modules/scheduling/jobs.js'
import { photoFinalizeJob, photoThumbnailJob } from '../../src/modules/scheduling/photo-jobs.js'
import { paymentsLagScanJob } from '../../src/modules/payments/jobs.js'
import {
  standingAutoconfirmJob,
  standingMaterializeJob,
  waitlistOfferExpiryJob,
} from '../../src/modules/standing/jobs.js'
import {
  emergencyAutoReopenJob,
  emergencySweepJob,
  federalHolidaysJob,
} from '../../src/modules/settings/jobs/index.js'
import { jobDefinitions } from '../../src/platform/job-registry.js'
import { maintenancePurgeJob } from '../../src/platform/maintenance.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { useWorld } from '../messaging-db/world.js'
import { addEvent, makeInvoice, type Env } from '../payments/helpers.js'
import { useJobsHarness } from './harness.js'

const w = useWorld({ start: '2026-06-12T12:00:00-04:00' })
const h = useJobsHarness({ testDb: () => w.t })
const fsRoot = mkdtempSync(path.join(tmpdir(), 'oasis-matrix-files-'))
const mailDir = mkdtempSync(path.join(tmpdir(), 'oasis-matrix-mail-'))

const saved: Record<string, string | undefined> = {}
beforeAll(() => {
  for (const [k, v] of Object.entries({
    DATABASE_URL: testDatabaseUrl(),
    DB_SEARCH_PATH: `${w.t.schema},public`,
    STORAGE_PROVIDER: 'fs',
    STORAGE_FS_ROOT: fsRoot,
    EMAIL_CONSOLE_DIR: mailDir,
    SMS_ALLOWLIST: w.env.SMS_ALLOWLIST,
    SMSGATE_MIN_INTERVAL_MS: '0',
    SMS_DISPATCH_MODE: 'jobs',
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
afterEach(async () => {
  await sql`delete from settings where key = 'federal_holidays.auto'`.execute(w.t.db)
  await setStanding(false)
  await sql`delete from standing_series`.execute(w.t.db)
})

/** The standing-appointment and waitlist feature (off by default); its jobs do nothing while it is off. */
async function setStanding(on: boolean): Promise<void> {
  await sql`update settings set value = ${JSON.stringify(on)}::jsonb
    where location_id = ${w.locationId} and key = 'features.standing_waitlist'`.execute(w.t.db)
}

const D = 24 * 3600_000
const db = () => w.t.db
const env = (): Env => ({ location: { id: w.locationId } as never, locationId: w.locationId, newId: w.newId })
const count = async (table: string, where = sql`true`): Promise<number> =>
  Number(
    (
      await sql<{ n: number }>`select count(*)::int as n from ${sql.table(table)} where ${where}`.execute(
        db(),
      )
    ).rows[0]!.n,
  )

/** Runs the job once through pg-boss and waits for that run to complete. */
async function run(
  worker: Awaited<ReturnType<typeof h.start>>,
  name: string,
  data: object = {},
): Promise<void> {
  const before = (await h.states(worker.schema, name)).filter((s) => s === 'completed').length
  await worker.jobs.enqueue(name, data)
  await h.waitFor(
    async () => (await h.states(worker.schema, name)).filter((s) => s === 'completed').length > before,
    120_000,
  )
}

interface Scenario {
  job: string
  defs: unknown[]
  /** The job payload, read after arrange() ran. */
  data?: () => Promise<object> | object
  arrange(): Promise<void>
  /** What the job changes, as a comparable value. */
  observe(): Promise<unknown>
  /** True when the first run is expected to have changed `observe()`. Default true. */
  changes?: boolean
}

let thumbPhotoId = ''

const photoBytes = async (): Promise<Buffer> =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: '#2266aa' } })
    .jpeg()
    .toBuffer()

const observeEmergency = async (): Promise<unknown> =>
  (await db().selectFrom('emergency_closures').select(['active', 'auto_reopened']).execute()).map((r) => ({
    ...r,
  }))

const scenarios: Scenario[] = [
  {
    job: 'maintenance.purge',
    defs: [maintenancePurgeJob],
    async arrange() {
      const old = new Date(w.clock.now().getTime() - 5 * D)
      await db()
        .insertInto('idempotency_keys')
        .values({
          key: 'matrix-expired-key',
          actor: 'u',
          method: 'POST',
          route: '/x',
          request_hash: 'h',
          state: 'done',
          created_at: old,
          lock_expires_at: old,
          expires_at: old,
        })
        .execute()
    },
    observe: () => count('idempotency_keys'),
  },
  {
    job: 'federal_holidays.generate',
    defs: [federalHolidaysJob],
    arrange: async () => void (await sql`delete from closures where source = 'federal'`.execute(db())),
    observe: async () => ({
      closures: await count('closures', sql`source = 'federal'`),
      runs: await count('federal_holiday_runs'),
    }),
  },
  {
    job: 'emergency.sweep',
    defs: [emergencySweepJob],
    arrange: arrangeEmergency,
    observe: observeEmergency,
  },
  {
    job: 'emergency.auto_reopen',
    defs: [emergencyAutoReopenJob],
    arrange: arrangeEmergency,
    observe: observeEmergency,
    data: async () => ({
      locationId: w.locationId,
      emergencyClosureId: (await db().selectFrom('emergency_closures').select('id').executeTakeFirstOrThrow())
        .id,
    }),
  },
  {
    job: 'appointments.late_scan',
    defs: [alertsScanJob],
    async arrange() {
      await w.appointment({ customer: 'Maria Delgado', at: '2026-06-12T11:00:00-04:00', status: 'booked' }) // an hour ago: late
    },
    observe: async () => ({
      announced: await count('realtime_events', sql`type = 'alerts.changed'`),
      state: await count('ops_alert_state'),
    }),
  },
  {
    job: 'photos.finalize',
    defs: [photoFinalizeJob],
    async arrange() {
      const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-12T09:00:00-04:00' })
      await db()
        .insertInto('appointment_photos')
        .values({
          id: w.newId(),
          appointment_id: appt,
          category: 'before',
          s3_key: 'matrix/pending.jpg',
          status: 'pending_upload',
          created_at: new Date(w.clock.now().getTime() - 20 * 60_000),
        } as never)
        .execute()
    },
    observe: async () =>
      (await db().selectFrom('appointment_photos').select('status').execute()).map((r) => r.status),
  },
  {
    job: 'photos.thumbnail',
    defs: [photoThumbnailJob],
    async arrange() {
      const storage = createStorageProvider(h.env({ STORAGE_FS_ROOT: fsRoot }))
      await storage.put('matrix/shot.jpg', await photoBytes(), 'image/jpeg')
      const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-12T09:00:00-04:00' })
      thumbPhotoId = w.newId()
      await db()
        .insertInto('appointment_photos')
        .values({
          id: thumbPhotoId,
          appointment_id: appt,
          category: 'before',
          s3_key: 'matrix/shot.jpg',
          content_type: 'image/jpeg',
          bytes: 100,
          status: 'ready',
        } as never)
        .execute()
    },
    data: () => ({ photoId: thumbPhotoId }),
    async observe() {
      const row = await db().selectFrom('appointment_photos').select('thumb_key').executeTakeFirstOrThrow()
      const storage = createStorageProvider(h.env({ STORAGE_FS_ROOT: fsRoot }))
      return {
        thumb: row.thumb_key,
        stored: row.thumb_key ? (await storage.head(row.thumb_key)) !== null : false,
      }
    },
  },
  {
    job: 'payments.lag-scan',
    defs: [paymentsLagScanJob],
    async arrange() {
      const inv = await makeInvoice(db(), env(), { customerId: w.customer('Maria Delgado').id })
      await addEvent(db(), env(), inv, {
        type: 'pay',
        amountCents: 5000,
        methodKind: 'card',
        method: 'Visa',
        processorState: 'awaiting_processor',
        at: new Date(w.clock.now().getTime() - 3 * 3600_000),
      })
    },
    // the scan never writes business data; it republishes one advisory event per run while the condition holds
    observe: async () => ({
      ledger: await count('ledger_events'),
      states: (await db().selectFrom('ledger_events').select('processor_state').execute()).map(
        (r) => r.processor_state,
      ),
    }),
    changes: false,
  },
  {
    job: 'sms.device.healthcheck',
    defs: [smsHealthJob],
    arrange: async () => undefined,
    observe: async () =>
      db()
        .selectFrom('sms_devices')
        .select(['status', 'health_status', 'consecutive_poll_failures', 'enabled', 'last_poll_ok_at'])
        .orderBy('device_key')
        .execute(),
  },
  {
    job: 'sms.webhooks.register',
    defs: [smsRegisterWebhooksJob],
    arrange: async () => undefined,
    observe: async () =>
      db()
        .selectFrom('sms_devices')
        .select(['device_key', 'status', 'remote_device_id', 'last_error'])
        .orderBy('device_key')
        .execute(),
    changes: false,
  },
  {
    job: 'sms.reconcile',
    defs: [smsReconcileJob],
    arrange: async () => undefined,
    observe: async () => db().selectFrom('sms_outbox').select(['state', 'reconcile_resends']).execute(),
    changes: false,
  },
  {
    job: 'standing.materialize',
    defs: [standingMaterializeJob],
    async arrange() {
      await setStanding(true)
      await insertSeries({ startDate: '2026-06-20', timeMin: 540 })
    },
    observe: observeStanding,
  },
  {
    job: 'standing.autoconfirm',
    defs: [standingAutoconfirmJob],
    async arrange() {
      await setStanding(true)
      const series = await insertSeries({ startDate: '2026-06-13', timeMin: 600 })
      // tomorrow's occurrence, booked: inside the 48-hour auto-confirm window
      const appt = await w.appointment({
        customer: 'Liam Chen',
        at: '2026-06-13T10:00:00-04:00',
        status: 'booked',
      })
      await db()
        .updateTable('appointments')
        .set({ standing_series_id: series })
        .where('id', '=', appt)
        .execute()
    },
    observe: async () => ({
      standing: await observeStanding(),
      texts: await count('messages', sql`direction = 'out'`),
    }),
  },
  {
    job: 'waitlist.offer_expiry',
    defs: [waitlistOfferExpiryJob],
    async arrange() {
      await setStanding(true)
      const entry = w.newId()
      await db()
        .insertInto('waitlist_entries')
        .values({
          id: entry,
          location_id: w.locationId,
          customer_id: w.customer('Liam Chen').id,
          service_id: (
            await db()
              .selectFrom('services')
              .select('id')
              .where('name', '=', 'Express Hand Wash')
              .executeTakeFirstOrThrow()
          ).id,
          desired_date: '2026-06-13',
          window_start_min: 540,
          window_end_min: 720,
          status: 'offered',
        } as never)
        .execute()
      await db()
        .insertInto('waitlist_offers')
        .values({
          id: w.newId(),
          location_id: w.locationId,
          entry_id: entry,
          slot_start: new Date('2026-06-13T10:00:00-04:00'),
          slot_end: new Date('2026-06-13T10:35:00-04:00'),
          phase: 'everyone',
          expires_at: new Date(w.clock.now().getTime() - 5 * 60_000),
        } as never)
        .execute()
    },
    observe: async () => ({
      offers: (
        await db().selectFrom('waitlist_offers').select(['status', 'phase']).orderBy('slot_start').execute()
      ).map((r) => ({ ...r })),
      entries: (await db().selectFrom('waitlist_entries').select('status').execute()).map((r) => r.status),
    }),
  },
  {
    job: 'email.send',
    defs: [emailSendJob],
    async arrange() {
      await w.tx((tx) =>
        queueEmail(
          tx,
          {
            locationId: w.locationId,
            to: 'matrix@example.test',
            template: 'device_alert',
            vars: { deviceLabel: 'Tablet', status: 'offline', occurredLabel: '10:00 AM' },
            purpose: 'matrix',
            dedupeKey: 'matrix-mail',
          },
          w.rt.deps,
        ),
      )
    },
    observe: async () => ({
      states: (await db().selectFrom('outbox_emails').select('state').execute()).map((r) => r.state),
      files: existsSync(mailDir) ? readdirSync(mailDir).length : 0,
    }),
  },
]

async function arrangeEmergency(): Promise<void> {
  await sql`delete from closures where source = 'emergency'`.execute(db())
  await sql`delete from emergency_closures`.execute(db())
  await db()
    .insertInto('emergency_closures')
    .values({
      id: w.newId(),
      location_id: w.locationId,
      active: true,
      reason: 'other',
      duration_kind: 'today',
      ends_at: new Date(w.clock.now().getTime() - 10 * 60_000),
      message: '',
      notify: false,
      started_at: new Date(w.clock.now().getTime() - 3 * 3600_000),
    } as never)
    .execute()
}
async function insertSeries(o: { startDate: string; timeMin: number }): Promise<string> {
  const id = w.newId()
  await db()
    .insertInto('standing_series')
    .values({
      id,
      location_id: w.locationId,
      customer_id: w.customer('Liam Chen').id,
      service_id: (
        await db()
          .selectFrom('services')
          .select('id')
          .where('name', '=', 'Express Hand Wash')
          .executeTakeFirstOrThrow()
      ).id,
      cadence: 'weekly',
      weekday: 6,
      time_min: o.timeMin,
      start_date: o.startDate,
    } as never)
    .execute()
  return id
}

async function observeStanding(): Promise<unknown> {
  return {
    appointments: (
      await sql<{ start: Date; status: string }>`
      select scheduled_start as start, status from appointments where standing_series_id is not null
      order by scheduled_start`.execute(db())
    ).rows.map((r) => `${r.start.toISOString()} ${r.status}`),
    through: (await db().selectFrom('standing_series').select('generated_through').execute()).map(
      (r) => r.generated_through,
    ),
  }
}

/** Jobs whose own suite runs them twice through the real worker; the suite file must mention the job. */
const dedicated: Record<string, string> = {
  'maintenance.retention': 'test/jobs/scans.test.ts',
  'photos.retention': 'test/jobs/scans.test.ts',
  'credit.expire': 'test/jobs/scans.test.ts',
  'vip.hold_release_scan': 'test/jobs/scans.test.ts',
  'appointments.reminders': 'test/jobs/reminders.test.ts',
  'appointments.review_request': 'test/jobs/reminders.test.ts',
  'sms.dispatch': 'test/jobs/matrix-sms.test.ts',
  'sqsp.sync': 'test/jobs/matrix-sqsp.test.ts',
  'sqsp.contacts': 'test/jobs/matrix-sqsp.test.ts',
  'sqsp.reconcile': 'test/jobs/matrix-sqsp.test.ts',
  'sqsp.webhook.process': 'test/jobs/matrix-sqsp.test.ts',
  'membership.cycle': 'test/jobs/matrix-sqsp.test.ts',
}

describe('every registered job runs twice through the real worker', () => {
  it('has a scenario or a dedicated suite for every job in the registry, and none for a job that does not exist', () => {
    const covered = [...scenarios.map((s) => s.job), ...Object.keys(dedicated)]
    expect(new Set(covered).size).toBe(covered.length)
    expect([...covered].sort()).toEqual(jobDefinitions.map((j) => j.name).sort())
    for (const [job, file] of Object.entries(dedicated)) {
      expect(existsSync(file), file).toBe(true)
      expect(readFileSync(file, 'utf8'), `${file} must run ${job}`).toContain(job)
    }
  })

  for (const s of scenarios) {
    it(`${s.job}: the second run changes nothing`, async () => {
      await s.arrange()
      const worker = await h.start({ definitions: s.defs as never })
      const data = s.data ? await s.data() : {}
      const before = JSON.stringify(await s.observe())
      await run(worker, s.job, data)
      const first = JSON.stringify(await s.observe())
      await run(worker, s.job, data)
      const second = JSON.stringify(await s.observe())
      if (s.changes !== false) expect(first, `${s.job} had no effect`).not.toBe(before)
      expect(second, `${s.job} repeated its effect`).toBe(first)
      expect((await h.rows(worker.schema, s.job)).map((r) => r.state)).toEqual(['completed', 'completed'])
    }, 150_000)
  }

  it('payments.lag-scan republishes its advisory event once per run while card money is still waiting', async () => {
    await scenarios.find((s) => s.job === 'payments.lag-scan')!.arrange()
    const worker = await h.start({ definitions: [paymentsLagScanJob] as never })
    await run(worker, 'payments.lag-scan')
    await run(worker, 'payments.lag-scan')
    const events = await db()
      .selectFrom('realtime_events')
      .select(['channel', 'payload'])
      .where('type', '=', 'reconciliation.stale')
      .execute()
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ channel: 'payments', payload: { count: 1, cents: 5000 } })
  })

  it('appointments.late_scan announces the alert set once, and again only when it changes', async () => {
    await scenarios.find((s) => s.job === 'appointments.late_scan')!.arrange()
    const worker = await h.start({ definitions: [alertsScanJob] as never })
    await run(worker, 'appointments.late_scan')
    await run(worker, 'appointments.late_scan')
    expect(await count('realtime_events', sql`type = 'alerts.changed'`)).toBe(1)
    await w.appointment({ customer: 'Liam Chen', at: '2026-06-12T10:00:00-04:00', status: 'booked' })
    await run(worker, 'appointments.late_scan')
    expect(await count('realtime_events', sql`type = 'alerts.changed'`)).toBe(2)
  })
})
