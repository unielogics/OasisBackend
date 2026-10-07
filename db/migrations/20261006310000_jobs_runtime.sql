-- Background-job runtime (M7): what the platform records about every pg-boss run (job_runs, feeds GET /api/v1/system/jobs
-- and /readyz) and the small bookkeeping tables that make the scans safe to repeat. Nothing here is written by the API's
-- request path; the worker owns it. audit_log and the ledger are untouched.

-- One row per job name, updated at start and at finish of every run. pg-boss archives its own rows after a retention window,
-- so "last success" of a daily job must not depend on them.
create table job_runs (
  name text primary key,
  runs bigint not null default 0,
  failures bigint not null default 0,
  consecutive_failures integer not null default 0,
  last_job_id text,
  last_attempt integer not null default 1,
  last_outcome text not null check (last_outcome in ('running', 'completed', 'failed')),
  last_started_at timestamptz not null,
  last_finished_at timestamptz,
  last_success_at timestamptz,
  last_error_at timestamptz,
  -- masked and truncated by the writer; never holds a job payload
  last_error text,
  last_duration_ms integer,
  updated_at timestamptz not null default app_now()
);

-- vip.hold_release_scan: one row per (weekly hold, concrete slot) whose release moment has been announced, so a rerun (or two
-- workers) announces it once. Rows go with their hold and are purged a week after the slot.
create table vip_hold_releases (
  hold_id uuid not null references vip_holds(id) on delete cascade,
  slot_start timestamptz not null,
  location_id uuid not null references locations(id) on delete cascade,
  released_at timestamptz not null default app_now(),
  primary key (hold_id, slot_start)
);
create index vip_hold_releases_slot_idx on vip_hold_releases (slot_start);

-- credit.expire: one row per store-credit lot whose unspent remainder expired. The ledger is append-only and the balance
-- already excludes an expired lot at query time, so this is the record that the loss was announced (once) to staff.
create table credit_expiries (
  lot_event_id uuid primary key references ledger_events(id),
  location_id uuid not null references locations(id) on delete cascade,
  customer_id uuid not null references customers(id),
  expired_cents integer not null check (expired_cents > 0),
  expires_at timestamptz not null,
  recorded_at timestamptz not null default app_now()
);
create index credit_expiries_customer_idx on credit_expiries (customer_id);
