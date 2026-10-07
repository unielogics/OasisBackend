# Background jobs

Every background behaviour of the backend runs as a pg-boss job in the `pgboss` Postgres schema (no Redis). Two processes
take part:

* **API** (`src/server.ts`): starts pg-boss as a producer (creates the queues, enqueues delayed and startup jobs, hosts
  `GET /api/v1/system/jobs` and the queue part of `/healthz` and `/readyz`). It registers no handlers.
* **Worker** (`src/worker.ts`, `pnpm start:worker`): `startWorker()` registers every handler and every cron schedule from
  `src/platform/job-registry.ts` and runs them. Tests boot the same factory against an isolated pg-boss schema.

The same Postgres holds the business data, so a job and its effect commit in one database; there is no second system to
fall out of step. Time inside a job always comes from the injected `Clock` (`CLOCK_FREEZE_AT` freezes it); pg-boss itself
schedules in wall-clock time, which is why tests move the frozen clock and enqueue jobs rather than wait for a cron.

## Catalogue

The table is generated from the registry and `src/platform/jobs-catalog.ts` (`pnpm jobs:doc`). `test/jobs/registry.test.ts`
fails when a registered job is missing from it, when it lists a job that is not registered, and when it is out of date.

<!-- jobs-table:start -->
| Job | Owner | Schedule | Queue policy | Retry / expiry | What it does | Idempotency | Clock | Enqueued by | Tests | Status |
|---|---|---|---|---|---|---|---|---|---|---|
| `appointments.late_scan` | scheduling | `* * * * *` America/New_York | short | 0 x 30s backoff; expires 15m (pg-boss default) | Recomputes the Needs Attention set every minute and publishes alerts.changed and kpi.dirty when it differs. | Compares a hash stored in ops_alert_state under a row lock; an unchanged set publishes nothing. | Injected clock (late = start + grace, arriving soon). | cron | test/scheduling/jobs.test.ts, test/jobs/registry.test.ts | existing |
| `appointments.reminders` | messaging | `*/5 * * * *` America/New_York | short | 2 x 60s backoff; expires 240s | Queues the 24 h and 2 h reminders (settings reminders.offsets_min) for booked and confirmed appointments: a confirmation request with "Reply C" for booked ones, a reminder for confirmed ones. | Message idempotency key reminder:<appointment>:<offset>:<start>; one row lock per appointment. | Elapsed-minute offsets from the injected clock; local words from calendar dates; quiet hours in the business tz. | cron | test/jobs/reminders.test.ts, test/jobs/kill.test.ts, test/jobs/dst.test.ts | built |
| `appointments.review_request` | messaging | `*/10 * * * *` America/New_York | short | 2 x 60s backoff; expires 480s | Sends one review request 2 h after a visit is completed, only when settings reviews.enabled is on (default off). | Message idempotency key review:<appointment>. | Injected clock against completed_at (2 h to 24 h after). | cron | test/jobs/reminders.test.ts, test/jobs/registry.test.ts | built |
| `credit.expire` | payments | `10 0 * * *` America/New_York | short | 2 x 120s backoff; expires 600s | Announces store credit that expired unspent (notification to managers, credit.expired event) once per lot. | credit_expiries primary key (lot); only a newly inserted marker announces. The ledger is never written. | Injected clock against each lot expires_at; remainder = cents minus FIFO allocations. | cron | test/jobs/scans.test.ts, test/jobs/registry.test.ts | built |
| `email.send` | messaging | `* * * * *` America/New_York | short | 0 x 30s backoff; expires 15m (pg-boss default) | Sends due rows of outbox_emails through the email provider. | Claims a row before sending; sent rows are never claimed again. | Injected clock for retry timing. | cron | test/messaging-db/adapters.test.ts, test/jobs/registry.test.ts | existing |
| `emergency.auto_reopen` | settings | queue only | short | 3 x 30s backoff; expires 15m (pg-boss default) | Reopens the shop when an emergency closure reaches its end time. | Reopens only an emergency that is still active and due; a repeat finds none. | Injected clock against the closure end time. | POST /emergency/close (delayed to ends_at) | test/settings-http/jobs.test.ts, test/jobs/registry.test.ts | existing |
| `emergency.sweep` | settings | `0 * * * *` America/New_York | short | 3 x 30s backoff; expires 15m (pg-boss default) | Backstop for a lost or missed auto_reopen job: reopens any emergency whose end time has passed. | Same guard as auto_reopen. | Injected clock. | API start (singleton key "startup") | test/settings-http/jobs.test.ts, test/jobs/registry.test.ts | existing |
| `federal_holidays.generate` | settings | `5 0 1 1 *` America/New_York | short | 3 x 30s backoff; expires 15m (pg-boss default) | Adds the federal holidays of this and next year as closed days (notify=false); never re-adds a deleted one. | Unique (location, holiday key, year) row; a year that already ran is skipped. | Injected clock for the current business year. | API start (singleton key "startup", catch-up) and the enable-toggle | test/settings-http/jobs.test.ts, test/jobs/registry.test.ts | existing |
| `maintenance.purge` | platform | `*/10 * * * *` America/New_York | short | 3 x 30s backoff; expires 600s | Drops expired idempotency keys, realtime events older than 10 minutes and webhook log rows older than 90 days. | Deletes by cutoff; a second run finds nothing left to delete. | Injected clock for every cutoff. | cron | test/integration/jobs.test.ts, test/jobs/registry.test.ts | existing |
| `maintenance.retention` | platform | `40 3 * * *` America/New_York | short | 3 x 30s backoff; expires 1800s | Daily retention: sessions (7 days past expiry), password resets, messages and SMS inbox and emails (24 months), SMS bookkeeping, VIP release markers. audit_log and the ledger are never purged. | Batched deletes by cutoff; a second run finds nothing left to delete. | Injected clock; month cutoffs by calendar arithmetic. | cron | test/jobs/scans.test.ts, test/jobs/registry.test.ts | built |
| `membership.cycle` | memberships | `0 3 * * *` America/New_York | short | 2 x 30s backoff; expires 15m (pg-boss default) | Rolls manual membership cycles, grants cycle credits, runs the subscription inference (past due, lagged cancel). | Credit grants keyed by (membership, cycle, rule); the cycle roll is guarded by cycle dates. | Injected clock. | cron | test/memberships/seed-cycle.test.ts, test/payments-sync-db/pgboss.test.ts, test/jobs/registry.test.ts | existing |
| `payments.lag-scan` | payments | `*/15 * * * *` America/New_York | short | 3 x 30s backoff; expires 15m (pg-boss default) | Publishes reconciliation.stale when card money has waited for Squarespace more than 2 hours. | Read-only apart from the advisory event, which repeats while the condition holds (the dashboard debounces). | Injected clock. | cron | test/payments/credit.test.ts, test/jobs/registry.test.ts | existing |
| `photos.finalize` | scheduling | `*/15 * * * *` America/New_York | short | 3 x 30s backoff; expires 15m (pg-boss default) | Marks uploads that never completed (pending for more than 15 minutes) as deleted. | Only rows still pending_upload and older than the cutoff change. | Injected clock. | cron | test/scheduling/jobs.test.ts, test/jobs/registry.test.ts | existing |
| `photos.retention` | scheduling | `20 4 * * *` America/New_York | short | 2 x 300s backoff; expires 1800s | Removes the stored objects and the row of deleted photos, and of photos older than 24 months (object first, row second). | Storage delete of a missing object succeeds; a row is deleted only after its objects. | Injected clock; 24 calendar months. | cron | test/jobs/scans.test.ts, test/jobs/registry.test.ts | built |
| `photos.thumbnail` | scheduling | queue only | short | 3 x 30s backoff; expires 15m (pg-boss default) | Writes the thumbnail of an uploaded photo next to the original and stores its key. | Deterministic thumbnail key; rewriting the same object and key changes nothing. | Not used. | POST /appointments/:id/photos/:photoId/complete (singleton key = photo id) | test/integrations/media/thumbnail.test.ts, test/jobs/registry.test.ts | existing |
| `sms.device.healthcheck` | messaging | `* * * * *` America/New_York | short | 0 x 30s backoff; expires 15m (pg-boss default) | Polls each device and feeds the health state machine (alerts when offline). | Writes the observed state; a transition notifies once. | Injected clock. | cron | test/messaging-db/health.test.ts, test/jobs/registry.test.ts | existing |
| `sms.dispatch` | messaging | `* * * * *` America/New_York | stately | 0 x 30s backoff; expires 180s | Drains sms_outbox through the SMS Gate device for about 55 seconds per run under the leader lock. | Atomic claim of outbox rows plus the provider message id; a stately policy allows one active and one queued run. | Injected clock for token buckets, holds and TTL. | cron | test/messaging-db/dispatch.test.ts, test/jobs/registry.test.ts | existing |
| `sms.reconcile` | messaging | `*/2 * * * *` America/New_York | short | 0 x 30s backoff; expires 15m (pg-boss default) | Asks the device about texts it accepted but never confirmed; expires past-TTL rows. | Only unconfirmed rows are asked about; resend count is capped. | Injected clock. | cron | test/messaging-db/dispatch.test.ts, test/jobs/registry.test.ts | existing |
| `sms.webhooks.register` | messaging | `7 * * * *` America/New_York | short | 0 x 30s backoff; expires 15m (pg-boss default) | Converges the oasis-* webhooks registered on each device. | Registers only what is missing or different. | Not used. | API start when SMS_DISPATCH_MODE=jobs (singleton key "boot") | test/messaging-db/simulator.test.ts, test/jobs/registry.test.ts | existing |
| `sqsp.contacts` | payments-sync | `17 * * * *` America/New_York | stately | 0 x 30s backoff; expires 900s | Hourly full read of Squarespace contacts and customer links. | Upserts by Squarespace id. | Injected clock. | cron | test/payments-sync/sync.test.ts, test/jobs/registry.test.ts | existing |
| `sqsp.reconcile` | payments-sync | `30 3 * * *` America/New_York | stately | 1 x 30s backoff; expires 1800s | Nightly re-read of the last 45 days to catch what the poll missed. | Upserts by Squarespace id; does not touch the poll watermarks. | Injected clock. 03:30, not 02:30: the 02:30 hour does not exist on spring-forward day. | cron | test/payments-sync-db/sync.test.ts, test/jobs/registry.test.ts | existing |
| `sqsp.sync` | payments-sync | `*/2 * * * *` America/New_York | stately | 0 x 30s backoff; expires 900s | Polls Squarespace orders then transactions, matches them to the ledger, runs the membership pass when orders changed. | Upserts by Squarespace id; watermark advances in the same transaction; matches are keyed. | Injected clock and sleeper. | POST /integrations/squarespace/sync (Sync now) | test/payments-sync-db/pgboss.test.ts, test/jobs/registry.test.ts | existing |
| `sqsp.webhook.process` | payments-sync | queue only | standard | 5 x 30s backoff; expires 15m (pg-boss default) | Fetches the order a verified Squarespace notification names, stores and matches it. | webhook_log unique (provider, notification id) plus the same upsert as the poll. | Injected clock. | POST /hooks/squarespace after signature verification | test/payments-sync-db/pgboss.test.ts, test/jobs/registry.test.ts | existing |
| `standing.autoconfirm` | standing | `0 * * * *` America/New_York | short | 1 x 30s backoff; expires 15m (pg-boss default) | Confirms standing appointments whose series has auto-confirm on, once they are inside the confirmation window. | Confirms only appointments still in booked status; a repeat finds none. | Injected clock against each appointment start. | cron | test/standing/jobs.test.ts, test/jobs/registry.test.ts | built |
| `standing.materialize` | standing | `0 4 * * *` America/New_York | short | 2 x 30s backoff; expires 15m (pg-boss default) | Books the next four weeks of every active standing (recurring) series of a VIP client; a date that cannot be booked is recorded as skipped with its reason. Does nothing while features.standing_waitlist is off. | One standing_occurrences row per (series, date) under a unique key, and the series watermark only moves forward; a second run books nothing new. | Injected clock, business-timezone dates. | cron | test/standing/jobs.test.ts, test/standing/standing.test.ts, test/jobs/registry.test.ts | built |
| `vip.hold_release_scan` | scheduling | `*/5 * * * *` America/New_York | short | 1 x 30s backoff; expires 240s | Publishes availability.changed for a day when one of its VIP-held slots reaches its release moment. | vip_hold_releases primary key (hold, slot); only a newly inserted row announces. | Injected clock; release moment is slot start minus release hours (elapsed time, DST-aware slot start). | cron | test/jobs/scans.test.ts, test/jobs/registry.test.ts | built |
| `waitlist.offer_expiry` | standing | `* * * * *` America/New_York | short | 0 x 30s backoff; expires 15m (pg-boss default) | Lapses waitlist offers nobody accepted in time and offers the slot to the next matching entry (VIPs first when that toggle is on). | Moves only open offers past expires_at; the next offer is unique per (entry, slot_start), so a repeat neither lapses nor offers twice. | Injected clock against expires_at. | cron | test/standing/waitlist.test.ts, test/standing/jobs.test.ts, test/jobs/registry.test.ts | built |
<!-- jobs-table:end -->

Queue policy: `stately` keeps one queued and one active run per queue (right for a periodic job: no overlap, no backlog
after downtime); `short` keeps at most one queued run; `standard` collapses nothing. A `singleton` queue (one active, any
number queued) was used by `sms.dispatch` and the `sqsp.*` polls until M7: after a worker outage it kept one queued run per
missed minute (proved in `test/jobs/runtime.test.ts`), so they are `stately` now.

## Required behaviours: exists, built or gap

| Behaviour | Job | State | Evidence |
|---|---|---|---|
| Appointment reminders at 24 h and 2 h (settings `reminders.offsets_min`) | `appointments.reminders` | built | `test/jobs/reminders.test.ts` (moments, once each across repeated runs, two workers at once), `test/jobs/dst.test.ts` |
| Reminders skip cancelled, no-show, arrived and opted-out; never twice | `appointments.reminders` | built | `test/jobs/reminders.test.ts` ("skips cancelled..."), `test/jobs/kill.test.ts` (kill -9 after the effect, retry adds nothing) |
| Reminder arithmetic and words across DST; quiet hours | `appointments.reminders` | built | `test/jobs/dst.test.ts` (2026-11-01, 2027-03-14), `test/jobs/reminders.test.ts` ("holds a reminder through quiet hours...") |
| Late scan and alerts scan | `appointments.late_scan` | exists | `test/scheduling/jobs.test.ts`; matrix in `test/jobs/matrix.test.ts` |
| VIP hold release | `vip.hold_release_scan` | built (waitlist offer: gap, the waitlist is P2 and has no table yet) | `test/jobs/scans.test.ts` |
| Emergency auto-reopen | `emergency.auto_reopen`, `emergency.sweep` | exists | `test/settings-http/jobs.test.ts`; matrix |
| Federal-holiday generation (rolling, `notify=false`) | `federal_holidays.generate` | exists | `test/settings-http/jobs.test.ts`; matrix |
| Membership cycle and credit grants | `membership.cycle` | exists | `test/memberships/seed-cycle.test.ts`, `test/payments-sync-db/pgboss.test.ts`; matrix |
| Store-credit expiry (FIFO allocations, notification) | `credit.expire` | built | `test/jobs/scans.test.ts` |
| Review request (feature flag, default off) | `appointments.review_request` | built | `test/jobs/reminders.test.ts` |
| Squarespace polls, reconcile, contacts, webhook processing | `sqsp.sync`, `sqsp.reconcile`, `sqsp.contacts`, `sqsp.webhook.process` | exists | `test/payments-sync-db/*.test.ts`; matrix |
| SMS dispatch, reconcile, health, webhook registration | `sms.dispatch`, `sms.reconcile`, `sms.device.healthcheck`, `sms.webhooks.register` | exists | `test/messaging-db/*.test.ts`; matrix |
| Email sending | `email.send` | exists | `test/messaging-db/adapters.test.ts`; matrix |
| Photo thumbnails and finalize | `photos.thumbnail`, `photos.finalize` | exists | `test/scheduling/jobs.test.ts`, `test/integrations/media/thumbnail.test.ts`; matrix |
| Payments lag scan | `payments.lag-scan` | exists | `test/payments/credit.test.ts`; matrix |
| Retention: idempotency keys (48 h), realtime events (10 min), webhook log (90 d) | `maintenance.purge` | exists | `test/integration/jobs.test.ts` |
| Retention: sessions, password resets, messages / SMS inbox / emails (24 months), SMS bookkeeping | `maintenance.retention` | built | `test/jobs/scans.test.ts` |
| Retention: photos (24 months) and the objects of deleted photos | `photos.retention` | built | `test/jobs/scans.test.ts` |
| Audit log is never purged | `maintenance.*` | built (guard) | `test/jobs/scans.test.ts`, `test/integration/jobs.test.ts` |
| pg-boss maintenance (archive, expiry of crashed runs, retries) | pg-boss supervisor | exists (configured) | `test/jobs/kill.test.ts` (an abandoned run is failed and retried by the 1 s maintenance pass used in tests; production uses 60 s) |
| `appointments.no_show_scan` (surface possible no-shows, no auto-action) | none | gap | design section 8 lists it, the Needs Attention set already shows late jobs; not required by the plan |
| `ledger.integrity_check` (view equals `calcInvoice`, credit lot sums) | none | gap | not required by the plan; the golden and property tests cover the invariants |
| `notifications.alerts_refresh` | none | gap | folded into `appointments.late_scan`, which computes the same alert set every minute |
| `standing.*`, `waitlist.*` (P2) | none | gap | behind a flag in the plan; no tables yet |
| `sqsp.token.refresh`, `sqsp.webhooks.ensure` | none | gap | OAuth webhooks are not built; polling is the baseline |
| Nightly `pg_dump` to S3 | host cron | gap | M8 (deployment) |

## What the platform does for every job

* **Retries and dead letters.** Defaults: 3 retries, 30 s delay, exponential backoff; a job overrides them in its
  definition. A job that exhausts its retries stays in its queue as `failed` and is copied into `<job>.dead` (kept 30 days).
  The first exhausted cycle of a failure streak sends a `job.failed` notification to the managers (once per streak, not per
  run).
* **Expiry.** A run still active after `expireInSeconds` (default 15 minutes) is failed by the pg-boss maintenance pass and
  retried. This is how a crashed worker is noticed; the pass runs every 60 s. A handler that outlives its expiry keeps
  running in its process while the retry starts, so every handler must be safe to overlap with itself (they all are: see the
  idempotency column).
* **Singleton keys.** Producers pass a `singletonKey` where a duplicate must collapse (`startup`, `boot`, a photo id, an
  emergency id). The queue policy decides what collapses; see above.
* **Schedules.** Registered by the worker on every start in the business timezone; a schedule whose job lost its `cron` is
  removed. Queue options (policy, retry, expiry, dead letter) are re-applied on every start, because pg-boss only inserts a
  queue when it is missing.
* **Run records.** `job_runs` (one row per job name) holds runs, failures, the failure streak, last start, finish, success,
  error (masked, 500 characters) and duration. pg-boss archives its own rows, so "last success" of a daily job cannot be read
  from them.
* **Logs.** `job started` and `job finished` / `job failed` with `job`, `jobId`, `attempt`, `durationMs` (and `final` on a
  failure); never the payload. The logger masks phone numbers and emails in error text.
* **Shutdown.** `stop()` stops taking jobs, lets running handlers finish for up to 60 s (the worker) and fails the rest back to
  the queue for a retry. Give the service manager a stop timeout above 60 s.

### Daylight saving time

pg-boss sends a scheduled job when `cron-parser`'s *previous* fire time is less than a minute old. Around a clock change that
differs from the *next* fire time: a time inside the skipped spring hour never fires that day (`30 2 * * *` fired zero times on
2027-03-14), and a time inside the repeated autumn hour fires twice (`30 1 * * *` twice on 2026-11-01). So no job is scheduled at
a fixed local time between 01:00 and 02:59 (`sqsp.reconcile` moved from 02:30 to 03:30), and `test/jobs/dst.test.ts` checks
every registered cron against an independent wall-clock reading on both days.

Reminder offsets are elapsed time (ADR 0090): "24 h before" a 09:00 EDT visit on 2027-03-14 is 08:00 EST the day before.

## Retention

| Data | Kept | Job |
|---|---|---|
| Idempotency keys | 48 h | `maintenance.purge` |
| Realtime events | 10 min (clients resync after a longer gap) | `maintenance.purge` |
| Webhook log | 90 days | `maintenance.purge` |
| Sessions | 7 days past expiry or revocation | `maintenance.retention` |
| Password resets | 30 days past expiry or use | `maintenance.retention` |
| Messages (SMS in and out, with their outbox rows), SMS inbox, sent and failed emails | 24 months | `maintenance.retention` |
| SMS processed events | 90 days | `maintenance.retention` |
| SMS usage counters | 7 days | `maintenance.retention` |
| VIP release markers | 7 days past the slot | `maintenance.retention` |
| Photos and their stored objects | 24 months; a deleted photo loses its objects and its row at the next daily run | `photos.retention` |
| Audit log, ledger | forever | never purged |

## Operability

* `GET /api/v1/system/jobs` (needs `set.billing`, which Super Admin holds): per job last run, last success, last error, next
  run, run and failure counts, queue depth (`queued`, `scheduled`, `active`, `failed`, `deadLetter`). See `docs/api-spec.md`
  section 25.
* `GET /healthz` always answers 200 while the process lives and reports the database and queue state; `GET /readyz` answers
  503 when the database, a migration or the queue is unreachable. Neither fails because a worker is down or a job failed: a
  proxy that pulls the API out of rotation for that would turn a late reminder into an outage. The worker state is in the
  body (`checks.jobs.worker.state`: `ok`, `stale` after 10 minutes without a finished job, `unknown`).
* Realtime resilience (`GET /api/v1/events`): see `docs/api-spec.md` section 7; `test/jobs/sse-restart.test.ts` restarts a
  real API process on port 4027.

## Running and testing

```
pnpm start:worker              # production: node dist/worker.js
pnpm dev:worker                # development
pnpm jobs:doc                  # regenerate the catalogue table above (pnpm jobs:doc:check verifies)
pnpm vitest run test/jobs      # the M7 suites (they start real workers on isolated pg-boss schemas)
```

Environment: `JOBS_ENABLED` (false stops the worker and makes enqueue a no-op), `PGBOSS_SCHEMA`, `BUSINESS_TZ`, `CLOCK_FREEZE_AT`,
`SMS_DISPATCH_MODE=jobs` for the SMS jobs, `SQSP_POLL_INTERVAL_SECONDS` for the `sqsp.sync` cron.
