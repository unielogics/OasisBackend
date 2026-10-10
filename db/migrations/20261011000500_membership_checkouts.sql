-- Memberships started through a personal link (ADR 0160, design section 5 "Squarespace"): the verified client confirms an email,
-- a pending membership is created with a checkout intent (expected email, product, link, 72 hours), and the page redirects to the
-- plan's Squarespace checkout. The order sync matches the intent first; without a match the intent waits for staff
-- (awaiting_match). A pending membership whose checkout never completes is closed after 7 days: its intent becomes 'abandoned' and
-- the membership itself 'canceled' with cancel_reason 'checkout_abandoned' (no new membership status, so the dashboard and the API
-- keep their five states).

create table membership_checkouts (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  membership_id uuid not null references memberships(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  link_id uuid references client_links(id) on delete set null,
  -- membership_plans.key and the Squarespace product the order should carry
  plan_key text not null check (plan_key ~ '^[a-z][a-z0-9_]{0,31}$'),
  product_key text check (product_key is null or length(product_key) <= 200),
  expected_email citext check (expected_email is null or btrim(expected_email::text) <> ''),
  checkout_url text not null check (
    checkout_url ~ '^https://([a-z0-9-]+\.)*squarespace\.com(/[^[:space:]]*)?$' and length(checkout_url) <= 2048),
  started_at timestamptz not null,
  -- started_at + 72 hours
  expires_at timestamptz not null,
  state text not null default 'open'
    check (state in ('open', 'matched', 'awaiting_match', 'expired', 'superseded', 'abandoned')),
  matched_order_id uuid references sqsp_orders(id) on delete set null,
  matched_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  check (expires_at > started_at),
  check ((state = 'matched') = (matched_at is not null))
);
-- one open checkout per membership; the sync's checkout-intent tier looks up open intents by email and by client
create unique index uq_membership_checkouts_open on membership_checkouts (membership_id) where state = 'open';
create index membership_checkouts_email_idx on membership_checkouts (location_id, expected_email)
  where state in ('open', 'awaiting_match');
create index membership_checkouts_customer_idx on membership_checkouts (customer_id, started_at desc);
create index membership_checkouts_expiry_idx on membership_checkouts (expires_at) where state = 'open';
