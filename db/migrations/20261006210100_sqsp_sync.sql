-- Squarespace read side: connection (credentials encrypted with SECRETS_KEY), per-resource sync state, the synced orders,
-- transactions and contacts, the product map, dead letters, applied matches (the idempotency record of every ledger
-- command the sync issues), the manual matching queue and sync alerts. Squarespace is READ-ONLY for payments; Oasis owns
-- the ledger. Webhook notifications are logged in the platform webhook_log (unique provider + notification id).

create table sqsp_connections (
  id uuid primary key,
  location_id uuid not null unique references locations(id) on delete cascade,
  auth_kind text not null default 'api_key' check (auth_kind in ('api_key', 'oauth')),
  -- <key id>:<iv>:<tag>:<ciphertext>, AES-256-GCM, see src/modules/payments-sync/db/secrets.ts; never returned by any route
  api_key_enc text,
  site_id text,
  -- OAuth (webhook subscriptions only) is reserved: refresh tokens are single use and must be stored before use
  client_id text,
  client_secret_enc text,
  access_token_enc text,
  refresh_token_enc text,
  token_expires_at timestamptz,
  scopes text[] not null default '{}',
  status text not null default 'connected' check (status in ('connected', 'error', 'disconnected')),
  last_error text,
  last_verified_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now()
);

create table sqsp_sync_state (
  location_id uuid not null references locations(id) on delete cascade,
  resource text not null check (resource in ('orders', 'transactions', 'contacts', 'reconcile')),
  -- end of the last fully ingested window; the next window starts at watermark minus the overlap
  watermark timestamptz,
  in_flight jsonb,
  phase text check (phase is null or phase in ('orders', 'transactions')),
  window_start timestamptz,
  last_run_at timestamptz,
  last_success_at timestamptz,
  status text not null default 'idle' check (status in ('idle', 'ok', 'partial', 'error', 'dead_letter')),
  last_error text,
  consecutive_failures integer not null default 0,
  updated_at timestamptz not null default app_now(),
  primary key (location_id, resource)
);

create table sqsp_orders (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  sqsp_order_id text not null,
  order_number text not null,
  created_on timestamptz not null,
  modified_on timestamptz not null,
  customer_email text,
  customer_name text,
  customer_phone text,
  sqsp_customer_id text,
  channel text,
  fulfillment_status text,
  payment_state text,
  is_subscription boolean not null default false,
  grand_total_cents integer not null,
  refunded_total_cents integer not null default 0,
  subtotal_cents integer,
  tax_cents integer,
  currency text not null,
  test_mode boolean not null default false,
  line_items jsonb not null default '[]'::jsonb,
  -- the mapped order (dates as ISO strings) that the sync and the matcher read back, and the wire payload
  order_json jsonb not null,
  raw jsonb,
  payload_hash text not null,
  -- the Oasis customer, once linked (Squarespace customer id, then email, then phone)
  customer_id uuid references customers(id),
  matched_invoice_id uuid references invoices(id),
  match_state text not null default 'unmatched' check (match_state in ('unmatched', 'auto', 'manual', 'ignored', 'membership')),
  ignore_reason text,
  first_seen_at timestamptz not null,
  synced_at timestamptz not null,
  matched_at timestamptz,
  unique (location_id, sqsp_order_id)
);
create index sqsp_orders_state_idx on sqsp_orders (location_id, match_state, created_on);
create index sqsp_orders_modified_idx on sqsp_orders (location_id, modified_on);
create index sqsp_orders_customer_idx on sqsp_orders (location_id, sqsp_customer_id) where sqsp_customer_id is not null;
create index sqsp_orders_email_idx on sqsp_orders (location_id, lower(customer_email)) where customer_email is not null;

create table sqsp_transactions (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  sqsp_txn_id text not null,
  sqsp_order_id text,
  kind text not null check (kind in ('payment', 'refund')),
  created_on timestamptz not null,
  amount_cents integer not null,
  currency text not null,
  brand text,
  -- Squarespace documents no last4; stays null unless a real payload proves otherwise
  last4 text check (last4 is null or last4 ~ '^[0-9]{4}$'),
  provider text,
  document_id text,
  payment_id text,
  external_transaction_id text,
  voided boolean not null default false,
  document_modified_on timestamptz,
  -- coalesce(document_modified_on, created_on): the version a stale write is compared against
  effective_modified_on timestamptz not null,
  customer_email text,
  txn_json jsonb not null,
  raw jsonb,
  payload_hash text not null,
  state text not null default 'new' check (state in ('new', 'matched', 'manual', 'ignored', 'deferred', 'membership')),
  ignore_reason text,
  matched_event_id uuid references ledger_events(id),
  first_seen_at timestamptz not null,
  synced_at timestamptz not null,
  unique (location_id, sqsp_txn_id)
);
create index sqsp_transactions_order_idx on sqsp_transactions (location_id, sqsp_order_id);
create index sqsp_transactions_state_idx on sqsp_transactions (location_id, state, created_on)
  where state in ('new', 'deferred', 'manual');

create table sqsp_contacts (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  sqsp_contact_id text not null,
  email text,
  name text,
  phone text,
  created_on timestamptz,
  payload_hash text not null,
  synced_at timestamptz not null,
  unique (location_id, sqsp_contact_id)
);
create index sqsp_contacts_email_idx on sqsp_contacts (location_id, lower(email)) where email is not null;

-- Squarespace customer id (= Contacts API contact id = order customerId) to an Oasis customer. Written by the contact sync
-- when exactly one customer matches the email, then the phone, or by hand.
create table sqsp_customer_links (
  location_id uuid not null references locations(id) on delete cascade,
  sqsp_customer_id text not null,
  customer_id uuid not null references customers(id),
  source text not null check (source in ('email', 'phone', 'manual')),
  linked_by uuid references users(id) on delete set null,
  created_at timestamptz not null default app_now(),
  primary key (location_id, sqsp_customer_id)
);
create index sqsp_customer_links_customer_idx on sqsp_customer_links (customer_id);

-- Squarespace product / SKU to Oasis meaning. The Orders API has no subscription flag and no tier: this table is the only
-- source of truth for "this order is a Premium membership payment" and "this order is one of ours at all".
create table sqsp_products (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  sqsp_product_id text,
  sku text,
  name text,
  kind text not null check (kind in ('membership', 'service')),
  plan_id uuid references membership_plans(id),
  -- how it was sold, e.g. "Premium Care"
  plan_label text,
  interval_months integer not null default 1 check (interval_months between 1 and 12),
  service_id uuid references services(id),
  active boolean not null default true,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  check (sqsp_product_id is not null or sku is not null),
  check (kind <> 'membership' or plan_id is not null)
);
create unique index uq_sqsp_products_product on sqsp_products (location_id, sqsp_product_id) where sqsp_product_id is not null;
create unique index uq_sqsp_products_sku on sqsp_products (location_id, lower(sku)) where sku is not null;

create table sqsp_webhook_subscriptions (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  sqsp_subscription_id text not null,
  topic text not null,
  endpoint_url text not null check (endpoint_url ~ '^https://'),
  secret_enc text,
  created_at timestamptz not null default app_now(),
  last_delivery_at timestamptz,
  unique (location_id, sqsp_subscription_id)
);

-- Dead letters: an item that cannot be mapped or persisted. attempts counts failures of the same key; dead_lettered_at is set
-- when attempts reaches the limit (5) and the sync stops holding the watermark for it.
create table sqsp_sync_errors (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  resource text not null check (resource in ('orders', 'transactions', 'contacts', 'reconcile')),
  key text not null,
  kind text not null check (kind in ('mapping', 'persist')),
  message text not null,
  raw jsonb,
  attempts integer not null default 1,
  first_at timestamptz not null,
  last_at timestamptz not null,
  dead_lettered_at timestamptz,
  resolved_at timestamptz,
  unique (location_id, resource, key)
);
create index sqsp_sync_errors_open_idx on sqsp_sync_errors (location_id, resource) where resolved_at is null;

-- Every applied match decision and the idempotency record of the ledger commands: a repeat of the same key is a no-op.
create table sqsp_matches (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  idempotency_key text not null unique,
  kind text not null check (kind in (
    'confirm_awaiting', 'attach_refs', 'record_payment', 'confirm_refund', 'external_refund', 'manual_ignore')),
  sqsp_order_id text,
  sqsp_txn_id text,
  event_id uuid references ledger_events(id),
  invoice_id uuid references invoices(id),
  rule text,
  confidence numeric(4, 3),
  -- { sqspTotalCents, oasisTotalCents, deltaCents, sqspTaxCents, oasisTaxCents, taxDeltaCents, exceedsAlert }
  variance jsonb,
  manual boolean not null default false,
  actor_user_id uuid references users(id) on delete set null,
  created_at timestamptz not null default app_now()
);
create index sqsp_matches_order_idx on sqsp_matches (location_id, sqsp_order_id);
create index sqsp_matches_event_idx on sqsp_matches (event_id) where event_id is not null;

-- Arrivals the matcher would not decide alone (no candidate, ambiguous, below the confidence threshold, possible double count).
create table sqsp_manual_queue (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  idempotency_key text not null unique,
  sqsp_order_id text not null,
  sqsp_txn_id text,
  reason text not null,
  candidates jsonb not null default '[]'::jsonb,
  arrival jsonb not null,
  variance jsonb,
  state text not null default 'open' check (state in ('open', 'resolved', 'ignored')),
  resolution text,
  resolved_at timestamptz,
  resolved_by uuid references users(id) on delete set null,
  created_at timestamptz not null default app_now()
);
create index sqsp_manual_queue_open_idx on sqsp_manual_queue (location_id, created_at) where state = 'open';
create index sqsp_manual_queue_order_idx on sqsp_manual_queue (location_id, sqsp_order_id);

-- Sync and matching alerts (variance, external refund, empty product map, dead letters, members without an Oasis customer).
-- dedupe_key makes raising idempotent per code, order and transaction; resolving closes it.
create table sqsp_alerts (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  dedupe_key text not null,
  code text not null,
  sqsp_order_id text,
  sqsp_txn_id text,
  invoice_id uuid references invoices(id),
  message text not null,
  variance jsonb,
  created_at timestamptz not null default app_now(),
  resolved_at timestamptz,
  resolved_by uuid references users(id) on delete set null,
  unique (location_id, dedupe_key)
);
create index sqsp_alerts_open_idx on sqsp_alerts (location_id, created_at desc) where resolved_at is null;
