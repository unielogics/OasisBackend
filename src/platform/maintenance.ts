// Housekeeping that keeps platform tables bounded. Every task is idempotent: running it twice in a row removes nothing
// the second time. Verticals register their own tasks (sessions, webhook payloads, ...) with registerPurgeTask.
//
// Two groups: 'frequent' runs every 10 minutes (maintenance.purge; the realtime log is only kept for 10 minutes) and
// 'daily' runs at 03:40 business time (maintenance.retention; sessions, 24-month message retention, ...).
// audit_log is NEVER purged, and neither is the ledger: no task below touches either table. Appointment photos (24 months) live
// in the photos.retention job; the pictures saved from an MMS go with the message or inbox row that lists them (below).
import { DateTime } from 'luxon'
import { sql, type RawBuilder } from 'kysely'
import { loadEnv } from '../config/env.js'
import type { StorageProvider } from '../integrations/ports/storage.js'
import { createStorageProvider } from '../integrations/storage/config.js'
import type { Clock } from './clock.js'
import type { Db } from './db.js'
import { purgeExpiredKeys } from './idempotency.js'
import type { JobDefinition } from './jobs.js'
import { purgeRealtimeEvents } from './realtime.js'
import { purgeOtpRows } from '../modules/public/otp.js'
import { purgeRateLimits } from '../modules/public/limits.js'

export const REALTIME_RETENTION_MS = 10 * 60 * 1000
export const WEBHOOK_LOG_RETENTION_MS = 90 * 24 * 3600 * 1000
/** A signed delivery Oasis could not use ('unparsed', body cut to 4 KB) is kept a week for diagnosis (ADR 0151). */
export const WEBHOOK_UNPARSED_RETENTION_MS = 7 * 24 * 3600 * 1000
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

/** What a task may need besides the database: the photos store, created on first use (saved MMS pictures, ADR 0151). */
export interface PurgeEnv {
  storage?: () => Pick<StorageProvider, 'delete'>
}

export type PurgeTask = (db: Db, clock: Clock, env: PurgeEnv) => Promise<number>
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
  const unparsedCutoff = before(clock, WEBHOOK_UNPARSED_RETENTION_MS)
  const r = await db
    .deleteFrom('webhook_log')
    .where((eb) => eb.or([eb('received_at', '<', cutoff), eb.and([eb('status', '=', 'unparsed'), eb('received_at', '<', unparsedCutoff)])]))
    .executeTakeFirst()
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

/** A task that removed what it could and kept the rest for the next run; runMaintenancePurge reports it after the others ran. */
export class PurgeIncomplete extends Error {
  constructor(
    readonly task: string,
    readonly removed: number,
    message: string,
  ) {
    super(message)
    this.name = 'PurgeIncomplete'
  }
}

/**
 * Deletes the rows of `table` that `expired` selects, together with the photos-store objects their `attachments` list as saved
 * (MMS pictures under messaging/mms/, ADR 0151): objects first, row second, so a crash or a store outage never leaves an
 * object nobody can find. A row whose objects could not all be deleted is kept for the next run (the run then fails, so the
 * job retries and is seen); the others are purged. `ownsObjects` says which rows' objects are this table's to delete.
 */
async function purgeWithObjects(
  db: Db,
  env: PurgeEnv,
  table: 'messages' | 'sms_inbox',
  expired: RawBuilder<boolean>,
  ownsObjects: RawBuilder<boolean>,
): Promise<number> {
  let total = 0
  let failures = 0
  let firstError: string | undefined
  let after = '00000000-0000-0000-0000-000000000000'
  let storage: Pick<StorageProvider, 'delete'> | undefined
  for (let i = 0; i < MAX_BATCHES; i++) {
    const r = await sql<{ id: string; keys: string[] }>`
      select t.id,
        case when ${ownsObjects} then coalesce((
          select array_agg(a->>'key') from jsonb_array_elements(case when jsonb_typeof(t.attachments) = 'array' then t.attachments else '[]'::jsonb end) a
          where jsonb_typeof(a->'key') = 'string' and a->>'key' <> ''), '{}') else '{}' end as keys
      from ${sql.table(table)} t
      where ${expired} and t.id > ${after}::uuid
      order by t.id
      limit ${PURGE_BATCH}`.execute(db)
    const rows = r.rows
    if (rows.length === 0) break
    after = rows[rows.length - 1]!.id
    const gone: string[] = []
    for (const row of rows) {
      try {
        if (row.keys.length > 0) {
          storage ??= env.storage?.()
          if (!storage) throw new Error('no photos store to delete them from')
          for (const key of row.keys) await storage.delete(key)
        }
        gone.push(row.id)
      } catch (err) {
        failures += 1
        firstError ??= (err as Error).message.slice(0, 200)
      }
    }
    if (gone.length > 0) total += deleted(await sql`delete from ${sql.table(table)} where id = any(${gone}::uuid[])`.execute(db))
    if (rows.length < PURGE_BATCH) break
  }
  if (failures > 0) throw new PurgeIncomplete(table, total, `${failures} ${table} row(s) kept: their saved pictures could not be removed from storage (${firstError ?? 'unknown error'})`)
  return total
}

// messages cascade to sms_outbox; sms_inbox.message_id is set null (the inbox row is purged on its own clock below). An MMS
// message takes its saved pictures with it.
registerPurgeTask(
  'messages',
  (db, clock, env) => {
    const cutoff = monthsBefore(clock.now(), MESSAGE_RETENTION_MONTHS)
    return purgeWithObjects(db, env, 'messages', sql<boolean>`t.created_at < ${cutoff}`, sql<boolean>`true`)
  },
  'daily',
)

// An inbox row filed as a message leaves its pictures to the message (purged above, which sets message_id null); one that never
// was (a quarantined stranger's, a superseded placeholder's) or whose message is already gone takes them with it.
registerPurgeTask(
  'sms_inbox',
  (db, clock, env) => {
    const cutoff = monthsBefore(clock.now(), MESSAGE_RETENTION_MONTHS)
    return purgeWithObjects(db, env, 'sms_inbox', sql<boolean>`t.received_at < ${cutoff}`, sql<boolean>`t.message_id is null`)
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

/**
 * Runs every task of the group. A task that fails does not stop the others: the run throws once all of them ran, naming each
 * failure, so the job is retried (and dead-lettered if it keeps failing).
 */
export async function runMaintenancePurge(
  db: Db,
  clock: Clock,
  group: PurgeGroup = 'frequent',
  env: PurgeEnv = {},
): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  const failed: string[] = []
  for (const [name, t] of tasks) {
    if (t.group !== group) continue
    try {
      out[name] = await t.task(db, clock, env)
    } catch (err) {
      if (err instanceof PurgeIncomplete) out[name] = err.removed
      failed.push(`${name}: ${(err as Error).message}`)
    }
  }
  if (failed.length > 0) throw new Error(`maintenance (${group}) incomplete; removed ${JSON.stringify(out)}; ${failed.join('; ')}`)
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
    // the photos store is only built when a purged MMS has saved pictures to delete
    let storage: StorageProvider | undefined
    const removed = await runMaintenancePurge(ctx.db, ctx.clock, 'daily', {
      storage: () => (storage ??= createStorageProvider(loadEnv(), { clock: ctx.clock })),
    })
    ctx.logger.info({ removed }, 'maintenance.retention done')
  },
}
