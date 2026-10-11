// The job catalogue: what each registered job is for, who owns it and why it is safe to repeat. The schedule, queue policy,
// retry and expiry columns of docs/jobs.md are generated from the registry itself (renderJobsTable), so the document cannot
// drift from the code; this file holds the facts a definition cannot state. test/jobs/registry.test.ts fails when a
// registered job has no entry here, when an entry has no job, and when docs/jobs.md is not the rendered table.
import type { JobDefinition } from './jobs.js'

export interface JobCatalogEntry {
  /** The module that owns the behaviour. */
  owner: string
  /** What it does, in a sentence. */
  purpose: string
  /** Why a second run (or a retry after a crash) has no second effect. */
  idempotency: string
  /** How the job reads time. */
  clock: string
  /** Who enqueues a queue-only job, and with which singleton key. */
  enqueuedBy?: string
  /** The test files that run it. */
  tests: string
  /** built = added by M7; existing = delivered by its module earlier and audited in M7. */
  status: 'built' | 'existing'
}

export const jobCatalog: Record<string, JobCatalogEntry> = {
  'leads.follow_up': {
    owner: 'assistant (leads)',
    purpose:
      'The one automatic follow-up text of a lead who did not book (ADR 0160, plan J): template lead_follow_up with a personal calendar link when PUBLIC_LINKS_ENABLED, after leads.follow_up_delay_min since their last text, inside business hours when leads.business_hours_only, within leads.within_hours of their last text, never after a STOP since the lead began, never to an opted-out number, only to numbers inside the rollout stage (assistant.stage / assistant.allowlist); a stale record (identity/stale.ts) gets the text a stranger gets (no name, a link bound to the number only). A lead whose client booked since the first contact is closed as booked first, whatever the switches (that sends nothing); no text while AI_ENABLED, assistant.enabled or leads.follow_up_enabled is off.',
    idempotency:
      'One follow-up per lead: the lead row is locked, the text carries the idempotency key lead-follow-up:<lead>, and the lead moves to followed_up with follow_up_message_id; a follow-up that can no longer go clears follow_up_at.',
    clock: 'Injected clock against the last text (lead and sms_inbox), the delay, the window and the business hours of the business tz.',
    tests: 'test/leads/follow-up.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'leads.provisional_archive': {
    owner: 'assistant (leads)',
    purpose:
      'Archives the welcome flow’s provisional clients ("New texter ••NNNN", source inbound_sms, needs_details) that never gave a name and never booked, 30 days after their last text: soft delete with archived_at (reversible: a new text from the number restores the record), the open lead closed, the thread kept for retention, an audit row (ADR 0160). Only rows the assistant created match.',
    idempotency: 'Archives only live provisional rows; an archived row is no longer live, so a repeat finds nothing.',
    clock: 'Injected clock: 30 days after the later of the creation and the last inbound text.',
    tests: 'test/leads/archive.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'maintenance.purge': {
    owner: 'platform',
    purpose:
      'Drops expired idempotency keys, realtime events older than 10 minutes, webhook log rows older than 90 days (unparsed SMS Gate deliveries after 7 days, ADR 0151), and the website’s one-time codes, member tokens and limit counters a day or two past their window (ADR 0150).',
    idempotency: 'Deletes by cutoff; a second run finds nothing left to delete.',
    clock: 'Injected clock for every cutoff.',
    tests: 'test/integration/jobs.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'maintenance.retention': {
    owner: 'platform',
    purpose:
      'Daily retention: sessions (7 days past expiry), password resets, messages and SMS inbox and emails (24 months, with the MMS pictures they saved in the photos store, ADR 0151), SMS bookkeeping, VIP release markers, and the phone identity (ADR 0160: personal links, link sessions, wrong-PIN rows, ended phone trust, resolved in-chat actions). audit_log and the ledger are never purged.',
    idempotency:
      'Batched deletes by cutoff, storage objects before their row; a row whose pictures cannot be deleted stays and the run fails after the other tasks (retried); a second run finds nothing left to delete.',
    clock: 'Injected clock; month cutoffs by calendar arithmetic.',
    tests: 'test/jobs/scans.test.ts, test/jobs/registry.test.ts, test/messaging-db/mms.test.ts, test/identity/purge.test.ts',
    status: 'built',
  },
  'federal_holidays.generate': {
    owner: 'settings',
    purpose:
      'Adds the federal holidays of this and next year as closed days (notify=false); never re-adds a deleted one.',
    idempotency: 'Unique (location, holiday key, year) row; a year that already ran is skipped.',
    clock: 'Injected clock for the current business year.',
    enqueuedBy: 'API start (singleton key "startup", catch-up) and the enable-toggle',
    tests: 'test/settings-http/jobs.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'emergency.auto_reopen': {
    owner: 'settings',
    purpose: 'Reopens the shop when an emergency closure reaches its end time.',
    idempotency: 'Reopens only an emergency that is still active and due; a repeat finds none.',
    clock: 'Injected clock against the closure end time.',
    enqueuedBy: 'POST /emergency/close (delayed to ends_at)',
    tests: 'test/settings-http/jobs.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'emergency.sweep': {
    owner: 'settings',
    purpose:
      'Backstop for a lost or missed auto_reopen job: reopens any emergency whose end time has passed.',
    idempotency: 'Same guard as auto_reopen.',
    clock: 'Injected clock.',
    enqueuedBy: 'API start (singleton key "startup")',
    tests: 'test/settings-http/jobs.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'appointments.late_scan': {
    owner: 'scheduling',
    purpose:
      'Recomputes the Needs Attention set every minute and publishes alerts.changed and kpi.dirty when it differs.',
    idempotency:
      'Compares a hash stored in ops_alert_state under a row lock; an unchanged set publishes nothing.',
    clock: 'Injected clock (late = start + grace, arriving soon).',
    tests: 'test/scheduling/jobs.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'appointments.reminders': {
    owner: 'messaging',
    purpose:
      'Queues the 24 h and 2 h reminders (settings reminders.offsets_min) for booked and confirmed appointments: a confirmation request with "Reply C" for booked ones (unless reminders.confirm_request is off), a reminder for confirmed ones, each with the preparation line of the visit’s categories (reminders.category_prep, ADR 0160).',
    idempotency:
      'Message idempotency key reminder:<appointment>:<offset>:<start>; one row lock per appointment.',
    clock:
      'Elapsed-minute offsets from the injected clock; local words from calendar dates; quiet hours in the business tz.',
    tests: 'test/jobs/reminders.test.ts, test/jobs/kill.test.ts, test/jobs/dst.test.ts',
    status: 'built',
  },
  'appointments.review_request': {
    owner: 'messaging',
    purpose:
      'Sends one review request 2 h after a visit is completed, only when settings reviews.enabled is on (default off).',
    idempotency: 'Message idempotency key review:<appointment>.',
    clock: 'Injected clock against completed_at (2 h to 24 h after).',
    tests: 'test/jobs/reminders.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'appointments.checkin_texts': {
    owner: 'status-texts',
    purpose:
      'Sends the "checked in" text that a manual arrival queued status_texts.checked_in_delay_min earlier (pending_checkin_texts); drops it when the wash started first (the "wash started" text went instead), the visit was canceled, the setting is off, the client cannot be texted or it is over 15 minutes late (ADR 0160). Off by default.',
    idempotency:
      'Each pending row is settled once under the appointment and row locks; the text carries the message idempotency key status:checked_in:<appointment>.',
    clock: 'Injected clock against due_at.',
    tests: 'test/status-texts/status-texts.test.ts, test/status-texts/jobs.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'appointments.late_texts': {
    owner: 'status-texts',
    purpose:
      'Texts "running a little behind, new estimate h:mm" (now + 15 min, rounded up to 5) to a visit still cleaning past its promised end + status_texts.late_grace_min, the next one only past that estimate + the grace, at most status_texts.late_max per visit, never over 30 minutes after its moment (ADR 0160). Off by default.',
    idempotency:
      'One appointment_late_texts row per (appointment, seq), decided again under the appointment row lock; message idempotency key status:running_late:<appointment>:<seq>.',
    clock: 'Injected clock against the promised end (the booked end, or cleaning start + duration when later) and the last estimate.',
    tests: 'test/status-texts/status-texts.test.ts, test/status-texts/jobs.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'vip.hold_release_scan': {
    owner: 'scheduling',
    purpose:
      'Publishes availability.changed for a day when one of its VIP-held slots reaches its release moment.',
    idempotency: 'vip_hold_releases primary key (hold, slot); only a newly inserted row announces.',
    clock:
      'Injected clock; release moment is slot start minus release hours (elapsed time, DST-aware slot start).',
    tests: 'test/jobs/scans.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'photos.thumbnail': {
    owner: 'scheduling',
    purpose: 'Writes the thumbnail of an uploaded photo next to the original and stores its key.',
    idempotency: 'Deterministic thumbnail key; rewriting the same object and key changes nothing.',
    clock: 'Not used.',
    enqueuedBy: 'POST /appointments/:id/photos/:photoId/complete (singleton key = photo id)',
    tests: 'test/integrations/media/thumbnail.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'photos.finalize': {
    owner: 'scheduling',
    purpose: 'Marks uploads that never completed (pending for more than 15 minutes) as deleted.',
    idempotency: 'Only rows still pending_upload and older than the cutoff change.',
    clock: 'Injected clock.',
    tests: 'test/scheduling/jobs.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'photos.retention': {
    owner: 'scheduling',
    purpose:
      'Removes the stored objects and the row of deleted photos, and of photos older than 24 months (object first, row second).',
    idempotency: 'Storage delete of a missing object succeeds; a row is deleted only after its objects.',
    clock: 'Injected clock; 24 calendar months.',
    tests: 'test/jobs/scans.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'payments.lag-scan': {
    owner: 'payments',
    purpose: 'Publishes reconciliation.stale when card money has waited for Squarespace more than 2 hours.',
    idempotency:
      'Read-only apart from the advisory event, which repeats while the condition holds (the dashboard debounces).',
    clock: 'Injected clock.',
    tests: 'test/payments/credit.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'credit.expire': {
    owner: 'payments',
    purpose:
      'Announces store credit that expired unspent (notification to managers, credit.expired event) once per lot.',
    idempotency:
      'credit_expiries primary key (lot); only a newly inserted marker announces. The ledger is never written.',
    clock: 'Injected clock against each lot expires_at; remainder = cents minus FIFO allocations.',
    tests: 'test/jobs/scans.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'ledger.integrity_check': {
    owner: 'payments',
    purpose:
      'Nightly proof that every invoice_calc_of row equals calcInvoice over the raw lines and ledger events, that the append-only triggers on ledger_events and credit_allocations exist and are enabled, and that FIFO allocations sum to their credit_apply and never overdraw a lot. Records the result; a problem notifies the managers.',
    idempotency:
      'One ledger_integrity_runs row per location and business date; a re-run with the same result changes nothing and a known problem is not announced twice. The ledger is only read.',
    clock: 'Injected clock for the run time and the business date.',
    tests: 'test/payments/ledger-integrity.test.ts, test/jobs/matrix.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'sms.dispatch': {
    owner: 'messaging',
    purpose:
      'Drains sms_outbox through the SMS Gate device for about 55 seconds per run under the leader lock.',
    idempotency:
      'Atomic claim of outbox rows plus the provider message id; a stately policy allows one active and one queued run.',
    clock: 'Injected clock for token buckets, holds and TTL.',
    tests: 'test/messaging-db/dispatch.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'sms.reconcile': {
    owner: 'messaging',
    purpose: 'Asks the device about texts it accepted but never confirmed; expires past-TTL rows.',
    idempotency: 'Only unconfirmed rows are asked about; resend count is capped.',
    clock: 'Injected clock.',
    tests: 'test/messaging-db/dispatch.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'sms.device.healthcheck': {
    owner: 'messaging',
    purpose: 'Polls each device and feeds the health state machine (alerts when offline).',
    idempotency: 'Writes the observed state; a transition notifies once.',
    clock: 'Injected clock.',
    tests: 'test/messaging-db/health.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'sms.webhooks.register': {
    owner: 'messaging',
    purpose: 'Converges the oasis-* webhooks registered on each device.',
    idempotency: 'Registers only what is missing or different.',
    clock: 'Not used.',
    enqueuedBy: 'API start when SMS_DISPATCH_MODE=jobs (singleton key "boot")',
    tests: 'test/messaging-db/simulator.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'email.send': {
    owner: 'messaging',
    purpose: 'Sends due rows of outbox_emails through the email provider.',
    idempotency: 'Claims a row before sending; sent rows are never claimed again.',
    clock: 'Injected clock for retry timing.',
    tests: 'test/messaging-db/adapters.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'sqsp.sync': {
    owner: 'payments-sync',
    purpose:
      'Polls Squarespace orders then transactions, matches them to the ledger, runs the membership pass when orders changed.',
    idempotency: 'Upserts by Squarespace id; watermark advances in the same transaction; matches are keyed.',
    clock: 'Injected clock and sleeper.',
    enqueuedBy: 'POST /integrations/squarespace/sync (Sync now)',
    tests: 'test/payments-sync-db/pgboss.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'sqsp.contacts': {
    owner: 'payments-sync',
    purpose: 'Hourly full read of Squarespace contacts and customer links.',
    idempotency: 'Upserts by Squarespace id.',
    clock: 'Injected clock.',
    tests: 'test/payments-sync/sync.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'sqsp.reconcile': {
    owner: 'payments-sync',
    purpose: 'Nightly re-read of the last 45 days to catch what the poll missed.',
    idempotency: 'Upserts by Squarespace id; does not touch the poll watermarks.',
    clock: 'Injected clock. 03:30, not 02:30: the 02:30 hour does not exist on spring-forward day.',
    tests: 'test/payments-sync-db/sync.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'sqsp.webhook.process': {
    owner: 'payments-sync',
    purpose: 'Fetches the order a verified Squarespace notification names, stores and matches it.',
    idempotency: 'webhook_log unique (provider, notification id) plus the same upsert as the poll.',
    clock: 'Injected clock.',
    enqueuedBy: 'POST /hooks/squarespace after signature verification',
    tests: 'test/payments-sync-db/pgboss.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'membership.cycle': {
    owner: 'memberships',
    purpose:
      'Rolls manual membership cycles, grants cycle credits, runs the subscription inference (past due, lagged cancel).',
    idempotency:
      'Credit grants keyed by (membership, cycle, rule); the cycle roll is guarded by cycle dates.',
    clock: 'Injected clock.',
    tests:
      'test/memberships/seed-cycle.test.ts, test/payments-sync-db/pgboss.test.ts, test/jobs/registry.test.ts',
    status: 'existing',
  },
  'membership.checkouts': {
    owner: 'memberships',
    purpose:
      'Expires open membership checkout intents after their 72-hour window and closes pending website or personal-link memberships staff never edited that saw no paid Squarespace order in the 7 days after their last checkout attempt (canceled, cancel_reason checkout_abandoned, intents abandoned; ADR 0160). Changes nothing when there are none.',
    idempotency:
      'Only open intents past their window and pending memberships with no paid order move, each under a row lock re-checked inside its transaction; a second run finds nothing left to move.',
    clock: 'Injected clock for the window and the 7-day cutoff.',
    tests: 'test/memberships/checkouts.test.ts, test/jobs/matrix-sqsp.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'standing.materialize': {
    owner: 'standing',
    purpose:
      'Books the next four weeks of every active standing (recurring) series of a VIP client; a date that cannot be booked is recorded as skipped with its reason. Does nothing while features.standing_waitlist is off.',
    idempotency:
      'One standing_occurrences row per (series, date) under a unique key, and the series watermark only moves forward; a second run books nothing new.',
    clock: 'Injected clock, business-timezone dates.',
    tests: 'test/standing/jobs.test.ts, test/standing/standing.test.ts, test/jobs/registry.test.ts, test/jobs/matrix.test.ts',
    status: 'built',
  },
  'standing.autoconfirm': {
    owner: 'standing',
    purpose:
      'Confirms standing appointments whose series has auto-confirm on, once they are inside the confirmation window.',
    idempotency: 'Confirms only appointments still in booked status; a repeat finds none.',
    clock: 'Injected clock against each appointment start.',
    tests: 'test/standing/jobs.test.ts, test/jobs/registry.test.ts, test/jobs/matrix.test.ts',
    status: 'built',
  },
  'waitlist.offer_expiry': {
    owner: 'standing',
    purpose:
      'Lapses waitlist offers nobody accepted in time and offers the slot to the next matching entry (VIPs first when that toggle is on).',
    idempotency:
      'Moves only open offers past expires_at; the next offer is unique per (entry, slot_start), so a repeat neither lapses nor offers twice.',
    clock: 'Injected clock against expires_at.',
    tests: 'test/standing/waitlist.test.ts, test/standing/jobs.test.ts, test/jobs/registry.test.ts, test/jobs/matrix.test.ts',
    status: 'built',
  },
  'ai.respond': {
    owner: 'assistant',
    purpose:
      'One turn of the AI text assistant for a conversation whose texts wait (ADR 0160): deferred while the newest text is under AI_DEBOUNCE_MS old (at most 45 s after the first), then the gate again, the caps, the claim, the Converse loop, the output guard and the reply (or the fallback and a handoff). Returns at once while AI_ENABLED=false.',
    idempotency:
      'Stately per conversation (singletonKey); the turn claims the conversation under a row lock and a 3-minute lease, answers only while its marker (pending_since) is set and clears it, and queues the reply with a per-turn dedupe key.',
    clock: 'Injected clock for the debounce, the lease, the caps and the reply window; monotonic time only for latencies.',
    enqueuedBy: 'the webhook after commit (assistant kick, singleton key = the conversation, 8 s later), the turn itself (deferral, newer texts) and ai.sweep',
    tests: 'test/assistant/jobs.test.ts, test/assistant/conversations.test.ts, test/assistant/guard.test.ts, test/assistant/prompt.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
  'ai.sweep': {
    owner: 'assistant',
    purpose:
      'Backstop of the assistant (ADR 0160): re-kicks conversations whose texts have waited over 30 s with no turn running, and fails turns that held their lease over 3 minutes (the fallback text and a handoff to staff). Returns at once while AI_ENABLED=false.',
    idempotency: 'Kicks collapse on the stately ai.respond queue; a dead lease is failed under a row lock once (the lease is cleared in the same transaction).',
    clock: 'Injected clock against pending_since and running_since.',
    tests: 'test/assistant/jobs.test.ts, test/jobs/registry.test.ts',
    status: 'built',
  },
}

const policyOf = (d: JobDefinition<never>): string => d.policy ?? 'standard'

/** Retry and expiry as the queue gets them (the defaults of createJobs applied). */
export const retryText = (d: JobDefinition<never>): string =>
  `${d.retryLimit ?? 3} x ${d.retryDelaySeconds ?? 30}s backoff; expires ${d.expireInSeconds ? `${d.expireInSeconds}s` : '15m (pg-boss default)'}`

export const scheduleText = (d: JobDefinition<never>, defaultTz: string): string =>
  d.cron ? `\`${d.cron}\` ${d.tz ?? defaultTz}` : 'queue only'

const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

/** The catalogue table of docs/jobs.md, generated from the registry and the catalogue. */
export function renderJobsTable(defs: readonly JobDefinition<never>[], defaultTz: string): string {
  const head = [
    '| Job | Owner | Schedule | Queue policy | Retry / expiry | What it does | Idempotency | Clock | Enqueued by | Tests | Status |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ]
  const rows = [...defs]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => {
      const c = jobCatalog[d.name]
      return `| \`${d.name}\` | ${cell(c?.owner ?? 'MISSING')} | ${scheduleText(d, defaultTz)} | ${policyOf(d)} | ${cell(retryText(d))} | ${cell(c?.purpose ?? 'MISSING')} | ${cell(c?.idempotency ?? 'MISSING')} | ${cell(c?.clock ?? 'MISSING')} | ${cell(c?.enqueuedBy ?? (d.cron ? 'cron' : 'MISSING'))} | ${cell(c?.tests ?? 'MISSING')} | ${c?.status ?? 'MISSING'} |`
    })
  return [...head, ...rows].join('\n')
}

export const JOBS_TABLE_START = '<!-- jobs-table:start -->'
export const JOBS_TABLE_END = '<!-- jobs-table:end -->'

/** docs/jobs.md with its generated block replaced. */
export function withJobsTable(doc: string, table: string): string {
  const a = doc.indexOf(JOBS_TABLE_START)
  const b = doc.indexOf(JOBS_TABLE_END)
  if (a < 0 || b < a) throw new Error('docs/jobs.md has no jobs-table markers')
  return `${doc.slice(0, a + JOBS_TABLE_START.length)}\n${table}\n${doc.slice(b)}`
}
