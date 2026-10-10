// Housekeeping that keeps platform tables bounded. Every task is idempotent: running it twice in a row removes nothing
// the second time. Verticals register their own tasks (sessions, webhook payloads, ...) with registerPurgeTask.
//
// Two groups: 'frequent' runs every 10 minutes (maintenance.purge; the realtime log is only kept for 10 minutes) and
// 'daily' runs at 03:40 business time (maintenance.retention; sessions, 24-month message retention, ...).
// audit_log is NEVER purged, and neither is the ledger: no task below touches either table. Photos (24 months) need object
// storage and live in the photos.retention job.
import { DateTime } from 'luxon'
import { sql } from 'kysely'
import type { Clock } from './clock.js'
import type { Db } from './db.js'
import { purgeExpiredKeys } from './idempotency.js'
import type { JobDefinition } from './jobs.js'
import { purgeRealtimeEvents } from './realtime.js'
import { purgeOtpRows } from '../modules/public/otp.js'
import { purgeRateLimits } from '../modules/public/limits.js'

export const REALTIME_RETENTION_MS = 10 * 60 * 1000
export const WEBHOOK_LOG_RETENTION_MS = 90 * 24 * 3600 * 1000
/** Expired and revoked sessions stay a week (support questions about a recent sign-in), then go. */
export const SESSION_RETENTION_MS = 7 * 24 * 3600 * 1000
export const PASSWORD_RESET_RETENTION_MS = 30 * 24 * 3600 * 1000
/** Messages (SMS in and out, queued emails) are kept 24 months. */
export const MESSAGE_RETENTION_MONTHS = 24
export const SMS_PROCESSED_EVENT_RETENTION_MS = 90 * 24 * 3600 * 1000
export const SMS_USAGE_RETENTION_MS = 7 * 24 * 3600 * 1000
export const VIP_RELEASE_RETENTION_MS = 7 * 24 * 3600 * 1000
/** One delete statement removes at most this many rows; a run repeats it up to MAX_BATCHES times. */
export const PURGE_BATCH = 5000
const MAX_BATCHES = 40

export type PurgeTask = (db: Db, clock: Clock) => Promise<number>
export type PurgeGroup = 'frequent' | 'daily'

const tasks = new Map<string, { task: PurgeTask; group: PurgeGroup }>()

export function registerPurgeTask(name: string, task: PurgeTask, group: PurgeGroup = 'frequent'): void {
  tasks.set(name, { task, group })
}

/** The instant `months` calendar months before `at` (UTC calendar; the sweep is not date-sensitive to the hour). */
export function monthsBefore(at: Date, months: number): Date {
  return DateTime.fromJSDate(at, { zone: 'utc' }).minus({ months }).toJSDate()
}

const before = (clock: Clock, ms: number): Date => new Date(clock.now().getTime() - ms)

/** Repeats a bounded delete until it removes fewer rows than a batch (or the batch cap is hit). */
async function inBatches(run: () => Promise<number>): Promise<number> {
  let total = 0
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await run()
    total += n
    if (n < PURGE_BATCH) break
  }
  return total
}

const deleted = (r: { numAffectedRows?: bigint | undefined }): number => Number(r.numAffectedRows ?? 0)

registerPurgeTask('idempotency_keys', (db, clock) => purgeExpiredKeys(db, clock))
registerPurgeTask('realtime_events', (db, clock) =>
  purgeRealtimeEvents(db, new Date(clock.now().getTime() - REALTIME_RETENTION_MS)),
)
// the website's one-time codes, member tokens (a day past expiry) and limit counters (windows two days old): ADR 0150
registerPurgeTask('public_otp', (db, clock) => purgeOtpRows(db, clock.now()))
registerPurgeTask('public_rate_limits', (db, clock) => purgeRateLimits(db, clock))
registerPurgeTask('webhook_log', async (db, clock) => {
  const cutoff = before(clock, WEBHOOK_LOG_RETENTION_MS)
  const r = await db.deleteFrom('webhook_log').where('received_at', '<', cutoff).executeTakeFirst()
  return Number(r.numDeletedRows)
})

registerPurgeTask(
  'sessions',
  (db, clock) => {
    const cutoff = before(clock, SESSION_RETENTION_MS)
    return inBatches(async () =>
      deleted(
        await sql`delete from sessions where id in (
          select id from sessions
          where least(idle_expires_at, absolute_expires_at) < ${cutoff} or revoked_at < ${cutoff}
          limit ${PURGE_BATCH})`.execute(db),
      ),
    )
  },
  'daily',
)

registerPurgeTask(
  'password_resets',
  async (db, clock) => {
    const cutoff = before(clock, PASSWORD_RESET_RETENTION_MS)
    const r = await db
      .deleteFrom('password_resets')
      .where((eb) => eb.or([eb('expires_at', '<', cutoff), eb('used_at', '<', cutoff)]))
      .executeTakeFirst()
    return Number(r.numDeletedRows)
  },
  'daily',
)

// messages cascade to sms_outbox; sms_inbox.message_id is set null (the inbox row is purged on its own clock below)
registerPurgeTask(
  'messages',
  (db, clock) => {
    const cutoff = monthsBefore(clock.now(), MESSAGE_RETENTION_MONTHS)
    return inBatches(async () =>
      deleted(
        await sql`delete from messages where id in (
          select id from messages where created_at < ${cutoff} limit ${PURGE_BATCH})`.execute(db),
      ),
    )
  },
  'daily',
)

registerPurgeTask(
  'sms_inbox',
  (db, clock) => {
    const cutoff = monthsBefore(clock.now(), MESSAGE_RETENTION_MONTHS)
    return inBatches(async () =>
      deleted(
        await sql`delete from sms_inbox where id in (
          select id from sms_inbox where received_at < ${cutoff} limit ${PURGE_BATCH})`.execute(db),
      ),
    )
  },
  'daily',
)

registerPurgeTask(
  'outbox_emails',
  (db, clock) => {
    const cutoff = monthsBefore(clock.now(), MESSAGE_RETENTION_MONTHS)
    return inBatches(async () =>
      deleted(
        await sql`delete from outbox_emails where id in (
          select id from outbox_emails
          where created_at < ${cutoff} and state in ('sent', 'failed', 'suppressed') limit ${PURGE_BATCH})`.execute(
          db,
        ),
      ),
    )
  },
  'daily',
)

registerPurgeTask(
  'sms_processed_events',
  async (db, clock) => {
    const cutoff = before(clock, SMS_PROCESSED_EVENT_RETENTION_MS)
    const r = await db
      .deleteFrom('sms_processed_events')
      .where('processed_at', '<', cutoff)
      .executeTakeFirst()
    return Number(r.numDeletedRows)
  },
  'daily',
)

registerPurgeTask(
  'sms_usage',
  async (db, clock) => {
    const cutoff = before(clock, SMS_USAGE_RETENTION_MS)
    const r = await db.deleteFrom('sms_usage').where('accepted_at', '<', cutoff).executeTakeFirst()
    return Number(r.numDeletedRows)
  },
  'daily',
)

registerPurgeTask(
  'vip_hold_releases',
  async (db, clock) => {
    const cutoff = before(clock, VIP_RELEASE_RETENTION_MS)
    const r = await db.deleteFrom('vip_hold_releases').where('slot_start', '<', cutoff).executeTakeFirst()
    return Number(r.numDeletedRows)
  },
  'daily',
)

export async function runMaintenancePurge(
  db: Db,
  clock: Clock,
  group: PurgeGroup = 'frequent',
): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const [name, t] of tasks) if (t.group === group) out[name] = await t.task(db, clock)
  return out
}

/** Runs every 10 minutes; the realtime retention window is 10 minutes. audit_log is never purged. */
export const maintenancePurgeJob: JobDefinition<Record<string, never>> = {
  name: 'maintenance.purge',
  policy: 'short',
  cron: '*/10 * * * *',
  expireInSeconds: 10 * 60,
  async handler(ctx) {
    const removed = await runMaintenancePurge(ctx.db, ctx.clock)
    ctx.logger.info({ removed }, 'maintenance.purge done')
  },
}

/** Daily sweep of the long-retention tables (sessions, 24-month messages, bookkeeping). 03:40 is outside the DST hours. */
export const maintenanceRetentionJob: JobDefinition<Record<string, never>> = {
  name: 'maintenance.retention',
  policy: 'short',
  cron: '40 3 * * *',
  expireInSeconds: 30 * 60,
  async handler(ctx) {
    const removed = await runMaintenancePurge(ctx.db, ctx.clock, 'daily')
    ctx.logger.info({ removed }, 'maintenance.retention done')
  },
}
