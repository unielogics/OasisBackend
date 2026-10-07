// Customer reminders sent by the worker.
//   appointments.reminders       every 5 minutes: the 24 h and 2 h reminders (settings reminders.offsets_min) for booked and
//                                confirmed appointments
//   appointments.review_request  every 10 minutes: one review request 2 h after a visit is completed, only when
//                                settings reviews.enabled is on (default off)
//
// Both are safe to repeat: a message carries the idempotency key reminder:<appointment>:<offset>:<start> (review:<appointment>),
// so a second run, a second worker or a retry after a crash returns the first message instead of queuing another. Each
// appointment is handled in its own transaction under a row lock, so a cancel that commits first is respected and a crash
// leaves only whole messages behind.
//
// Offsets are elapsed time: "24 h before" is start minus 1440 minutes, not the same wall-clock time yesterday (ADR 0090). Local
// time only matters for the words in the text ("tomorrow at 9:00 AM") and for quiet hours, both computed from calendar dates
// so they stay right on the 23 and 25 hour days of a DST change.
import { transaction } from '../../../platform/db.js'
import type { JobDefinition } from '../../../platform/jobs.js'
import { getSetting } from '../../../platform/settings.js'
import { addDays, fmtT, minutesOfDay, toBizDate } from '../../../platform/time.js'
import { DateTime } from 'luxon'
import { whenLabel } from '../../scheduling/appointments.js'
import { classSpec, type SmsClass } from '../policy/classes.js'
import { isQuietHour, quietHoursEnd } from '../policy/quietHours.js'
import type { MessagingRuntime } from '../runtime.js'
import { jobRuntime } from './index.js'

export const REMINDER_JOB = 'appointments.reminders'
export const REVIEW_JOB = 'appointments.review_request'

/** A reminder this much later than its moment is not sent (the worker was down; the customer would get a stale text). */
export const REMINDER_LATE_GRACE_MS = 60 * 60_000
/** A reminder is worthless in the last minutes before the visit; one that quiet hours would hold that long is dropped. */
export const REMINDER_MIN_LEAD_MS = 10 * 60_000
/** The review request goes out this long after completion... */
export const REVIEW_DELAY_MS = 2 * 3_600_000
/** ...and is dropped when it is still unsent this long after completion. */
export const REVIEW_EXPIRES_MS = 24 * 3_600_000
const BATCH = 2000

export interface RunReport {
  considered: number
  queued: number
  duplicate: number
  /** Reasons the SMS policy or this job skipped an appointment, with counts. */
  skipped: Record<string, number>
}

const emptyReport = (): RunReport => ({ considered: 0, queued: 0, duplicate: 0, skipped: {} })
const skip = (r: RunReport, why: string): void => {
  r.skipped[why] = (r.skipped[why] ?? 0) + 1
}

/** "today", "tomorrow" or "on Sat, Jun 13", by business calendar date. */
export function reminderWhen(start: Date, now: Date, tz: string): string {
  const day = toBizDate(start, tz)
  const today = toBizDate(now, tz)
  if (day === today) return 'today'
  if (day === addDays(today, 1)) return 'tomorrow'
  return `on ${DateTime.fromISO(day, { zone: 'utc' }).setLocale('en-US').toFormat('ccc, LLL d')}`
}

export const offsetLabel = (min: number): string => (min % 60 === 0 ? `${min / 60} h` : `${min} min`)

/** The offsets (minutes) whose reminder moment has arrived and is not stale, for an appointment booked at `bookedAt`. */
export function dueOffsets(offsets: readonly number[], start: Date, bookedAt: Date, now: Date): number[] {
  return [...new Set(offsets)]
    .filter((off) => {
      const at = start.getTime() - off * 60_000
      return at <= now.getTime() && now.getTime() < at + REMINDER_LATE_GRACE_MS && bookedAt.getTime() <= at
    })
    .sort((a, b) => a - b)
}

async function locations(rt: MessagingRuntime, only?: string): Promise<Array<{ id: string; tz: string }>> {
  let q = rt.db.selectFrom('locations').select(['id', 'timezone']).orderBy('created_at').orderBy('id')
  if (only) q = q.where('id', '=', only)
  return (await q.execute()).map((l) => ({ id: l.id, tz: l.timezone }))
}

export async function runReminders(
  rt: MessagingRuntime,
  o: { locationId?: string } = {},
): Promise<RunReport> {
  const report = emptyReport()
  const now = rt.clock.now()
  for (const loc of await locations(rt, o.locationId)) {
    const offsets = (await getSetting(rt.db, loc.id, 'reminders.offsets_min')).value
    if (offsets.length === 0) continue
    const horizon = new Date(now.getTime() + Math.max(...offsets) * 60_000)
    const candidates = await rt.db
      .selectFrom('appointments')
      .select(['id', 'scheduled_start', 'created_at'])
      .where('location_id', '=', loc.id)
      .where('status', 'in', ['booked', 'confirmed'])
      .where('scheduled_start', '>', now)
      .where('scheduled_start', '<=', horizon)
      .orderBy('scheduled_start')
      .orderBy('id')
      .limit(BATCH)
      .execute()
    for (const c of candidates) {
      const due = dueOffsets(offsets, c.scheduled_start, c.created_at, now)
      if (due.length === 0) continue
      report.considered += 1
      // the closest moment wins when several are due at once; the others would only repeat it
      const offset = due[0]!
      await transaction(rt.db, async (tx) => {
        const a = await tx
          .selectFrom('appointments')
          .select(['id', 'customer_id', 'status', 'scheduled_start'])
          .where('id', '=', c.id)
          .forUpdate()
          .executeTakeFirst()
        if (
          !a ||
          (a.status !== 'booked' && a.status !== 'confirmed') ||
          a.scheduled_start.getTime() !== c.scheduled_start.getTime()
        )
          return skip(report, 'changed')
        const target = await rt.queue.target(tx, loc.id, a.customer_id)
        if (!target) return skip(report, 'no_customer')
        const unconfirmed = a.status === 'booked'
        const klass: SmsClass = unconfirmed ? 'confirm_request' : 'reminder'
        // Quiet hours hold automated texts until morning, and a held text gets its full TTL from the release moment. A
        // reminder must never arrive after the visit has begun, so it is dropped when the hold leaves less than the minimum
        // lead, and otherwise expires at the start of the visit.
        const quiet = rt.config.plan.quietHours
        const releaseAt = isQuietHour(now, quiet) ? quietHoursEnd(now, quiet) : now
        const leadMs = a.scheduled_start.getTime() - releaseAt.getTime()
        if (leadMs < REMINDER_MIN_LEAD_MS) return skip(report, releaseAt === now ? 'too_late' : 'quiet_hours')
        const out = await rt.queue.enqueueFor(tx, {
          locationId: loc.id,
          customerId: a.customer_id,
          recipient: target.recipient,
          appointmentId: a.id,
          // an unconfirmed booking is asked to reply C; a confirmed one is only reminded
          templateKey: unconfirmed ? 'confirm_request' : 'reminder',
          vars: unconfirmed
            ? { time: whenLabel(a.scheduled_start, now, loc.tz) }
            : {
                when: reminderWhen(a.scheduled_start, now, loc.tz),
                time: fmtT(minutesOfDay(a.scheduled_start, loc.tz)),
              },
          purpose: 'reminder',
          senderKind: 'system',
          ttlOverrideSec: Math.min(classSpec(klass).ttlSec, Math.floor(leadMs / 1000)),
          dedupeKey: `reminder:${a.id}:${offset}:${a.scheduled_start.getTime()}`,
        })
        if (!out.queued) return skip(report, out.skipped)
        if (out.duplicate) {
          report.duplicate += 1
          return
        }
        report.queued += 1
        await tx
          .insertInto('activity_log')
          .values({
            appointment_id: a.id,
            at: now,
            text: `${unconfirmed ? 'Confirmation request' : 'Reminder'} sent · ${offsetLabel(offset)} before`,
            channels: ['sms'],
            actor_type: 'automation',
            actor_name: null,
            meta: JSON.stringify({ offsetMin: offset }) as never,
          })
          .execute()
      })
    }
  }
  return report
}

export async function runReviewRequests(
  rt: MessagingRuntime,
  o: { locationId?: string } = {},
): Promise<RunReport> {
  const report = emptyReport()
  const now = rt.clock.now()
  for (const loc of await locations(rt, o.locationId)) {
    if (!(await getSetting(rt.db, loc.id, 'reviews.enabled')).value) continue
    const candidates = await rt.db
      .selectFrom('appointments')
      .select(['id', 'completed_at'])
      .where('location_id', '=', loc.id)
      .where('status', '=', 'completed')
      .where('completed_at', '<=', new Date(now.getTime() - REVIEW_DELAY_MS))
      .where('completed_at', '>', new Date(now.getTime() - REVIEW_EXPIRES_MS))
      .orderBy('completed_at')
      .orderBy('id')
      .limit(BATCH)
      .execute()
    for (const c of candidates) {
      report.considered += 1
      await transaction(rt.db, async (tx) => {
        const a = await tx
          .selectFrom('appointments')
          .select(['id', 'customer_id', 'status'])
          .where('id', '=', c.id)
          .forUpdate()
          .executeTakeFirst()
        if (!a || a.status !== 'completed') return skip(report, 'changed')
        const target = await rt.queue.target(tx, loc.id, a.customer_id)
        if (!target) return skip(report, 'no_customer')
        const out = await rt.queue.enqueueFor(tx, {
          locationId: loc.id,
          customerId: a.customer_id,
          recipient: target.recipient,
          appointmentId: a.id,
          templateKey: 'review',
          purpose: 'review',
          senderKind: 'system',
          dedupeKey: `review:${a.id}`,
        })
        if (!out.queued) return skip(report, out.skipped)
        if (out.duplicate) {
          report.duplicate += 1
          return
        }
        report.queued += 1
        await tx
          .insertInto('activity_log')
          .values({
            appointment_id: a.id,
            at: now,
            text: 'Review request sent',
            channels: ['sms'],
            actor_type: 'automation',
            actor_name: null,
            meta: JSON.stringify({}) as never,
          })
          .execute()
      })
    }
  }
  return report
}

export const remindersJob: JobDefinition = {
  name: REMINDER_JOB,
  cron: '*/5 * * * *',
  policy: 'short',
  retryLimit: 2,
  retryDelaySeconds: 60,
  expireInSeconds: 4 * 60,
  async handler(ctx) {
    const r = await runReminders(jobRuntime(ctx))
    if (r.considered > 0) ctx.logger.info(r, 'reminders processed')
  },
}

export const reviewRequestJob: JobDefinition = {
  name: REVIEW_JOB,
  cron: '*/10 * * * *',
  policy: 'short',
  retryLimit: 2,
  retryDelaySeconds: 60,
  expireInSeconds: 8 * 60,
  async handler(ctx) {
    const r = await runReviewRequests(jobRuntime(ctx))
    if (r.considered > 0) ctx.logger.info(r, 'review requests processed')
  },
}
