// The status-text jobs (ADR 0160, design section 6), run by the pg-boss worker:
//   appointments.checkin_texts   every minute: sends the checked-in texts that are due (pending_checkin_texts, queued by a manual
//                                arrival status_texts.checked_in_delay_min earlier); one whose visit is no longer "arrived" is
//                                dropped (the wash started: "wash started" went instead; or the visit was canceled)
//   appointments.late_texts      every 2 minutes: a visit still cleaning past its promised end + status_texts.late_grace_min gets
//                                "running a little behind, new estimate h:mm" (now + 15 min, rounded up to 5); the next one only
//                                past that estimate + the grace; at most status_texts.late_max (2) per visit
// Both are harmless while the settings are off (the defaults): nothing is queued for them, and the late job reads one setting per
// location. A repeat has no second effect: each visit is handled in its own transaction under its row lock, the pending row is
// settled once, a late text takes the next free (appointment, seq) row, and every text carries a dedupe key per visit.
import type { Clock } from '../../platform/clock.js'
import { transaction, type Db } from '../../platform/db.js'
import type { JobDefinition } from '../../platform/jobs.js'
import { getSetting } from '../../platform/settings.js'
import { fmtT, minutesOfDay } from '../../platform/time.js'
import { jobRuntime } from '../messaging/jobs/index.js'
import type { MessagingRuntime } from '../messaging/runtime.js'
import { CHECKIN_SEND_WINDOW_MS, checkedInMessage, lateDecision, lateEta, lateMessage, promisedEnd } from './compose.js'
import { dedupeKeyOf, deliveryNote, dropCheckedIn, logStatusActivity, type StatusTextsQueue } from './service.js'
import './schema.js'

export const CHECKIN_TEXTS_JOB = 'appointments.checkin_texts'
export const LATE_TEXTS_JOB = 'appointments.late_texts'
const BATCH = 500

export interface StatusJobDeps {
  db: Db
  clock: Clock
  queue: StatusTextsQueue
}

export interface StatusRunReport {
  considered: number
  queued: number
  duplicate: number
  dropped: number
  /** Why a visit got no text this run, with counts. */
  skipped: Record<string, number>
}

const emptyReport = (): StatusRunReport => ({ considered: 0, queued: 0, duplicate: 0, dropped: 0, skipped: {} })
const skip = (r: StatusRunReport, why: string): void => {
  r.skipped[why] = (r.skipped[why] ?? 0) + 1
}

export const statusJobDeps = (rt: MessagingRuntime): StatusJobDeps => ({ db: rt.db, clock: rt.clock, queue: rt.queue })

export async function runCheckinTexts(d: StatusJobDeps, o: { locationId?: string } = {}): Promise<StatusRunReport> {
  const report = emptyReport()
  const now = d.clock.now()
  const due = await d.db
    .selectFrom('pending_checkin_texts')
    .select(['appointment_id', 'location_id'])
    .where('state', '=', 'pending')
    .where('due_at', '<=', now)
    .$if(o.locationId !== undefined, (q) => q.where('location_id', '=', o.locationId!))
    .orderBy('due_at')
    .orderBy('appointment_id')
    .limit(BATCH)
    .execute()
  for (const row of due) {
    report.considered += 1
    await transaction(d.db, async (tx) => {
      // the appointment first, then its pending row: the order the lifecycle's transitions lock them in
      const a = await tx
        .selectFrom('appointments')
        .select(['id', 'status', 'customer_id'])
        .where('id', '=', row.appointment_id)
        .forUpdate()
        .executeTakeFirst()
      const p = await tx
        .selectFrom('pending_checkin_texts')
        .select(['appointment_id', 'location_id', 'due_at'])
        .where('appointment_id', '=', row.appointment_id)
        .where('state', '=', 'pending')
        .forUpdate()
        .executeTakeFirst()
      if (!p) return skip(report, 'changed')
      const drop = async (reason: Parameters<typeof dropCheckedIn>[2], why: string): Promise<void> => {
        await dropCheckedIn(tx, p.appointment_id, reason, now)
        report.dropped += 1
        skip(report, why)
      }
      if (!a || a.status !== 'arrived')
        return drop(a && (a.status === 'cleaning' || a.status === 'completed') ? 'cleaning_started' : 'canceled', 'not_arrived')
      if (!(await getSetting(tx, p.location_id, 'status_texts.checked_in')).value) return drop('disabled', 'disabled')
      if (now.getTime() > p.due_at.getTime() + CHECKIN_SEND_WINDOW_MS) return drop('not_sendable', 'too_late')
      const target = await d.queue.target(tx, p.location_id, a.customer_id)
      if (!target) return drop('not_sendable', 'no_customer')
      const m = checkedInMessage()
      const out = await d.queue.enqueueFor(tx, {
        locationId: p.location_id,
        customerId: a.customer_id,
        recipient: target.recipient,
        appointmentId: a.id,
        templateKey: m.templateKey,
        vars: m.vars,
        purpose: 'checked_in',
        senderKind: 'system',
        dedupeKey: dedupeKeyOf.checkedIn(a.id),
      })
      if (!out.queued) {
        await logStatusActivity(tx, a.id, now, deliveryNote('Checked-in text', out), { status: 'checked_in' })
        return drop('not_sendable', out.skipped)
      }
      await tx
        .updateTable('pending_checkin_texts')
        .set({ state: 'sent', message_id: out.messageId, settled_at: now })
        .where('appointment_id', '=', a.id)
        .execute()
      if (out.duplicate) {
        report.duplicate += 1
        return
      }
      report.queued += 1
      await logStatusActivity(tx, a.id, now, deliveryNote('Checked-in text', out), { status: 'checked_in' })
    })
  }
  return report
}

export async function runLateTexts(d: StatusJobDeps, o: { locationId?: string } = {}): Promise<StatusRunReport> {
  const report = emptyReport()
  const now = d.clock.now()
  const locations = await d.db
    .selectFrom('locations')
    .select(['id', 'timezone'])
    .$if(o.locationId !== undefined, (q) => q.where('id', '=', o.locationId!))
    .orderBy('created_at')
    .orderBy('id')
    .execute()
  for (const loc of locations) {
    if (!(await getSetting(d.db, loc.id, 'status_texts.running_late')).value) continue
    const max = (await getSetting(d.db, loc.id, 'status_texts.late_max')).value
    if (max <= 0) continue
    const graceMin = (await getSetting(d.db, loc.id, 'status_texts.late_grace_min')).value
    const cleaning = await d.db
      .selectFrom('appointments')
      .select(['id', 'scheduled_end', 'cleaning_started_at', 'duration_min'])
      .where('location_id', '=', loc.id)
      .where('status', '=', 'cleaning')
      .orderBy('scheduled_end')
      .orderBy('id')
      .limit(BATCH)
      .execute()
    if (cleaning.length === 0) continue
    const sentRows = await d.db
      .selectFrom('appointment_late_texts')
      .select(['appointment_id', 'seq', 'eta_at'])
      .where(
        'appointment_id',
        'in',
        cleaning.map((c) => c.id),
      )
      .execute()
    for (const c of cleaning) {
      const mine = sentRows.filter((r) => r.appointment_id === c.id).sort((x, y) => x.seq - y.seq)
      const first = lateDecision({
        now,
        promisedEnd: promisedEnd({ scheduledEnd: c.scheduled_end, cleaningStartedAt: c.cleaning_started_at, durationMin: c.duration_min }),
        lastEta: mine.at(-1)?.eta_at ?? null,
        sent: mine.length,
        max,
        graceMin,
      })
      if (!first.send) {
        if (first.reason === 'too_late') skip(report, 'too_late')
        continue
      }
      report.considered += 1
      await transaction(d.db, async (tx) => {
        const a = await tx
          .selectFrom('appointments')
          .select(['id', 'status', 'customer_id', 'scheduled_end', 'cleaning_started_at', 'duration_min'])
          .where('id', '=', c.id)
          .forUpdate()
          .executeTakeFirst()
        if (!a || a.status !== 'cleaning') return skip(report, 'changed')
        // decided again under the row lock: another run may have sent one meanwhile
        const rows = await tx
          .selectFrom('appointment_late_texts')
          .select(['seq', 'eta_at'])
          .where('appointment_id', '=', a.id)
          .orderBy('seq')
          .execute()
        const decision = lateDecision({
          now,
          promisedEnd: promisedEnd({ scheduledEnd: a.scheduled_end, cleaningStartedAt: a.cleaning_started_at, durationMin: a.duration_min }),
          lastEta: rows.at(-1)?.eta_at ?? null,
          sent: rows.length,
          max,
          graceMin,
        })
        if (!decision.send) return skip(report, decision.reason)
        const eta = lateEta(now)
        const target = await d.queue.target(tx, loc.id, a.customer_id)
        if (!target) return skip(report, 'no_customer')
        const m = lateMessage(eta, loc.timezone)
        const out = await d.queue.enqueueFor(tx, {
          locationId: loc.id,
          customerId: a.customer_id,
          recipient: target.recipient,
          appointmentId: a.id,
          templateKey: m.templateKey,
          vars: m.vars,
          purpose: 'running_late',
          senderKind: 'system',
          dedupeKey: dedupeKeyOf.runningLate(a.id, decision.seq),
        })
        // the seq is used even when the text could not go (an opted-out client): the job does not retry it every 2 minutes, and
        // the visit never gets more than late_max attempts
        await tx
          .insertInto('appointment_late_texts')
          .values({ appointment_id: a.id, seq: decision.seq, eta_at: eta, message_id: out.queued ? out.messageId : null, created_at: now })
          .onConflict((oc) => oc.columns(['appointment_id', 'seq']).doNothing())
          .execute()
        if (out.queued && out.duplicate) {
          report.duplicate += 1
          return
        }
        if (out.queued) report.queued += 1
        else skip(report, out.skipped)
        const label = fmtT(minutesOfDay(eta, loc.timezone))
        await logStatusActivity(tx, a.id, now, `${deliveryNote('Running-late text', out)} · new estimate ${label}`, {
          status: 'running_late',
          seq: decision.seq,
          eta: eta.toISOString(),
        })
      })
    }
  }
  return report
}

export const checkinTextsJob: JobDefinition = {
  name: CHECKIN_TEXTS_JOB,
  cron: '* * * * *',
  policy: 'short',
  retryLimit: 1,
  retryDelaySeconds: 20,
  expireInSeconds: 2 * 60,
  async handler(ctx) {
    const r = await runCheckinTexts(statusJobDeps(jobRuntime(ctx)))
    if (r.considered > 0) ctx.logger.info(r, 'checked-in texts processed')
  },
}

export const lateTextsJob: JobDefinition = {
  name: LATE_TEXTS_JOB,
  cron: '*/2 * * * *',
  policy: 'short',
  retryLimit: 1,
  retryDelaySeconds: 30,
  expireInSeconds: 3 * 60,
  async handler(ctx) {
    const r = await runLateTexts(statusJobDeps(jobRuntime(ctx)))
    if (r.considered > 0) ctx.logger.info(r, 'running-late texts processed')
  },
}

export const statusTextJobs: readonly JobDefinition[] = [checkinTextsJob, lateTextsJob]
