-- Memberships: the four plans (display data and credit rules), the member rows driven by Squarespace subscription orders
-- (or by hand when the subscription data is missing) and the credit ledger. Plans carry DISPLAY data (perks text, colours,
-- percent-discount basis points); only credits are ever redeemed, through an explicit command (backend design 4.6, review
-- B11 and B12). Percent perks are never applied automatically.

create table membership_plans (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  key text not null check (key in ('essential', 'premium', 'executive', 'exotic')),
  name text not null check (btrim(name) <> ''),
  color text not null,
  bg_color text not null,
  tint text not null,
  sort integer not null default 0,
  -- the design's marketing lines, verbatim
  perks text[] not null default '{}',
  addon_discount_bp integer not null default 0 check (addon_discount_bp between 0 and 10000),
  service_discount_bp integer not null default 0 check (service_discount_bp between 0 and 10000),
  billing_interval_months integer not null default 1 check (billing_interval_months between 1 and 12),
  active boolean not null default true,
  version integer not null default 1,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  unique (location_id, key)
);

-- A credit covers one visit of a service whose tags include any of include_tags and none of exclude_tags.
-- per_cycle null = unlimited. Tag vocabulary (services.tags): express, premium, executive, handwash.
create table plan_credit_rules (
  id uuid primary key,
  plan_id uuid not null references membership_plans(id) on delete cascade,
  label text not null check (btrim(label) <> ''),
  include_tags text[] not null check (cardinality(include_tags) > 0),
  exclude_tags text[] not null default '{}',
  per_cycle integer check (per_cycle is null or per_cycle > 0),
  sort integer not null default 0,
  created_at timestamptz not null default app_now()
);
create index plan_credit_rules_plan_idx on plan_credit_rules (plan_id, sort);

create table memberships (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  customer_id uuid not null references customers(id),
  plan_id uuid not null references membership_plans(id),
  -- what was sold, for example "Premium Care" (a Premium product with a label)
  plan_label text not null check (btrim(plan_label) <> ''),
  status text not null check (status in ('pending', 'active', 'past_due', 'paused', 'canceled')),
  source text not null check (source in ('squarespace', 'manual')),
  -- derived, Squarespace exposes no subscription id: sqsp:<email>:<product id or sku>
  sqsp_subscription_ref text,
  sqsp_customer_id text,
  sqsp_product_key text,
  started_at timestamptz not null,
  current_period_start timestamptz,
  current_period_end timestamptz,
  canceled_at timestamptz,
  cancel_reason text,
  last_sqsp_order_id text,
  last_paid_at timestamptz,
  paid_order_count integer not null default 0,
  -- past the paid period but inside the grace days
  in_grace boolean not null default false,
  -- when staff last set paused or canceled (or any override) by hand; only a later paid order reactivates
  manual_status_at timestamptz,
  review_flags jsonb not null default '[]'::jsonb,
  inference_reason text,
  auto_apply boolean not null default false,
  last_synced_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  check (current_period_end is null or current_period_start is null or current_period_end > current_period_start)
);
create unique index uq_memberships_customer_live on memberships (customer_id)
  where status in ('pending', 'active', 'past_due', 'paused');
create index memberships_plan_idx on memberships (plan_id);
create index memberships_status_idx on memberships (location_id, status);

create table membership_credit_events (
  id uuid primary key,
  membership_id uuid not null references memberships(id) on delete cascade,
  -- the cycle the event belongs to: memberships.current_period_start when it was written
  cycle_start timestamptz not null,
  kind text not null check (kind in ('grant', 'reserve', 'redeem', 'restore', 'protect', 'expire')),
  -- null only on the grant of an unlimited rule
  qty smallint check (qty is null or qty > 0),
  rule_id uuid references plan_credit_rules(id) on delete set null,
  appointment_id uuid references appointments(id),
  invoice_id uuid references invoices(id),
  -- the system adjust event a redeem created
  ledger_event_id uuid references ledger_events(id),
  note text,
  actor text,
  actor_user_id uuid references users(id) on delete set null,
  idempotency_key text unique,
  created_at timestamptz not null default app_now(),
  check (qty is not null or kind = 'grant')
);
create index membership_credit_events_cycle_idx on membership_credit_events (membership_id, cycle_start);
-- One credit per appointment: a second apply is refused by the database as well as by the service.
create unique index uq_credit_redeem_appointment on membership_credit_events (appointment_id)
  where kind = 'redeem' and appointment_id is not null;

alter table appointments
  add constraint appointments_membership_id_fkey foreign key (membership_id) references memberships(id) on delete set null;
