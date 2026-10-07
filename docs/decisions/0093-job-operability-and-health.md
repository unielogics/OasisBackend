# 0093 Job operability, health probes and realtime resilience

Status: accepted (2026-10-07).

* **`GET /api/v1/system/jobs`** (`set.billing`): per job last run, last success, last error, next run (cron in the business
  timezone or the earliest delayed run), runs, failures, failure streak and queue depth. Read from `job_runs`, the pg-boss tables
  and the schedule table; it returns no payloads and no PII (the error text is masked).
* **`/healthz`** stays 200 while the process answers (a database blip must not make a supervisor restart a healthy API) and now
  reports the database and queue state. **`/readyz`** is 503 when the database, a migration or the queue is unreachable. Neither
  fails because the worker is stale or a job failed: a proxy that pulls the only API out of rotation for that would turn a late
  reminder into an outage. `checks.jobs.worker.state` (`ok`, `stale` after 10 minutes without a finished job, `unknown`) and the
  failed and dead-letter counts are in the body for the uptime monitor to alert on.
* **Realtime**: the event log is in Postgres with a database sequence, so an API restart loses nothing; a reconnecting client gets what
  it missed in order and once, `resync` when the cursor is older than the retention, ahead of the log, or the replay is over 5,000
  events (`replay_too_large`). Proven against a real API process killed with SIGTERM and SIGKILL (`test/jobs/sse-restart.test.ts`, port
  4027).
