-- Square foundation (ADR 0171, wave Q1b): the webhook log takes Square deliveries (deduplicated on Square's event_id, shared with the
-- Events API catch-up so a webhook and the catch-up never both process one event), and square_state keeps, per location, what the
-- connection test learned (merchant, events enabled, our webhook subscription), the catch-up watermark and the last reconcile.
-- Nothing here moves money; the ledger columns, the Square payment mirror and the refund legs come with the core wave (Q2b).
alter table webhook_log drop constraint webhook_log_provider_check;
alter table webhook_log
  add constraint webhook_log_provider_check check (provider in ('squarespace', 'smsgate', 'ses', 'square'));

create table square_state (
  location_id uuid primary key references locations(id) on delete cascade,
  -- sandbox | production | sim: the Square the facts below were learned from
  environment text not null check (environment in ('sandbox', 'production', 'sim')),
  square_location_id text,
  -- learned by POST /integrations/square/test; a webhook from any other merchant is ignored
  merchant_id text,
  events_enabled_at timestamptz,
  webhook_subscription_id text,
  webhook_checked_at timestamptz,
  last_webhook_at timestamptz,
  -- created_at of the newest event the catch-up has read; it searches again from 10 minutes before it
  watermark timestamptz,
  last_catchup_at timestamptz,
  last_catchup_events integer not null default 0 check (last_catchup_events >= 0),
  -- the last time the catch-up found an event no webhook had delivered
  last_catchup_claimed_at timestamptz,
  last_reconcile_at timestamptz,
  last_reconcile jsonb,
  last_test_at timestamptz,
  last_test jsonb,
  last_error text,
  last_error_at timestamptz,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now()
);
