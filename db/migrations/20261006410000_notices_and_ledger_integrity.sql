-- Operations leftovers (ADR 0122, 0123): the debounce record of manager notices that can repeat (an SMS device flapping between
-- offline and online, the SMS app restarting, texts queued with no device), and the result of every nightly ledger integrity
-- check. Neither table holds business data; the ledger itself is untouched.

-- One row per notice subject and kind (key 'sms.device:<id>:offline', 'sms.device:<id>:online', 'sms.device:<id>:state',
-- 'sms.app_restarted:<id>', 'sms.no_device'): when it was last announced, what it said, and how many repeats were held back since.
create table notice_debounce (
  location_id uuid not null references locations(id) on delete cascade,
  key text not null,
  state text,
  last_sent_at timestamptz,
  suppressed integer not null default 0 check (suppressed >= 0),
  updated_at timestamptz not null default app_now(),
  primary key (location_id, key)
);

-- ledger.integrity_check: the result of the night's check per location and business date. A re-run the same day that finds the
-- same thing leaves the row alone; one that finds something different replaces the result. `findings` lists every violation
-- (empty when ok).
create table ledger_integrity_runs (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  check_date date not null,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  ok boolean not null,
  invoices_checked integer not null check (invoices_checked >= 0),
  findings jsonb not null default '[]'::jsonb,
  job_id text,
  created_at timestamptz not null default app_now(),
  unique (location_id, check_date)
);
