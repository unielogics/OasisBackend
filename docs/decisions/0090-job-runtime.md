# 0090 Job runtime: dead letters, run records, schedule upkeep, queue policy and daylight saving

Status: accepted (2026-10-07). Catalogue: `docs/jobs.md`.

## Decisions

* **Every queue has a dead-letter queue `<job>.dead`** (kept 30 days). A job that exhausts its retries stays in its own queue as
  `failed` and is copied there with its payload. `GET /api/v1/system/jobs` counts both.
* **Run records live in our tables, not only in pg-boss.** `job_runs` (one row per job name) is written at the start and the
  end of every run: runs, failures, failure streak, last start, finish, success, error (masked, 500 characters) and duration.
  pg-boss archives its rows after 12 hours, so "last success" of a nightly job cannot be read from them.
* **Logs**: `job started`, `job finished` / `job failed` with job name, job id, attempt, duration and `final`; never the
  payload. A job that exhausts its retries tells the managers once per failure streak (`job.failed` notification).
* **Queue options are re-applied on every start** (`updateQueue`), because `createQueue` only inserts when the queue is missing;
  a schedule whose job lost its `cron` is unscheduled. Without this a changed retry limit or policy never reaches a deployment
  that already has the queue.
* **`stately` instead of `singleton` for periodic jobs** (`sms.dispatch`, `sqsp.sync`, `sqsp.contacts`, `sqsp.reconcile`). The
  `singleton` policy allows one active run but any number queued; after a worker outage it holds one queued run per missed
  minute (test: five queued with `singleton`, one with `stately`). `stately` is one queued plus one active.
* **Shutdown drains**: `stop()` stops taking jobs, aborts `JobContext.signal` (`sms.dispatch` ends its 55 s window after the
  current tick) and gives running handlers `shutdownTimeoutMs` (30 s in the worker, under the unit's `TimeoutStopSec=45`). A job
  the shutdown interrupts is handed back as a retry with one more allowed attempt, so pg-boss's own fail never makes it final:
  no dead letter, no failure in `job_runs`, no report. (2026-10-12: the drain was 60 s, the unit killed the worker at 45 s, and
  pg-boss's fail of an interrupted job used the job's own retry count: a deploy that caught `sms.dispatch` with over 45 s of its
  window left had it killed, and the run (`retryLimit: 0`) dead-lettered when it expired, holding the stately queue until then.)
  The dead-letter report counts the failure streak against the queue's configured limit, since an interrupted attempt is in the
  job's limit but never in the streak.
* **`startWorker()` is the worker's factory** (`src/worker.ts`); the file runs `main()` only when started as a program, so tests
  boot the same code the service runs.

## Daylight saving time

pg-boss does not compute the next run; it asks `cron-parser` for the previous fire time and sends the job when it is under a
minute old. Measured with that rule (`test/jobs/dst.test.ts`): `30 2 * * *` never fires on 2027-03-14 (the hour does not exist),
`30 1 * * *` fires twice on 2026-11-01. Rule: **no job is scheduled at a fixed local time between 01:00 and 02:59**; the registry test
enforces it. `sqsp.reconcile` moved from 02:30 to 03:30; the new jobs run at 00:10 (`credit.expire`), 03:40 (`maintenance.retention`)
and 04:20 (`photos.retention`). Interval jobs fire 23 or 25 hours worth of times on the two days, by the wall clock. `cron-parser`
4.9.0 (the version pg-boss uses) is a direct dependency now so the tests and the status endpoint use the same arithmetic.

## Found on the way

`logger.warn({ err: error.message })`, used at 24 call sites, threw `TypeError` inside the logger: the pino `err` serializer
assumed an `Error` object. In a job handler that replaced the real error; inside `boss.on('error')` it was an uncaught exception.
The serializer accepts strings now (`src/platform/logging.ts`).
