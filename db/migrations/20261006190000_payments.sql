-- Payments: invoices, the append-only ledger, store-credit allocations, payment links and the invoice_calc port of the
-- Payments design formulas (pay-domain section 2) in integer cents. Money is integer cents; every default reads
-- app_now(). Invoices are created at booking (one per appointment) and numbered INV-<n> from a gap-free per-location
-- counter that continues after the highest design id (20610). Review fixes folded in: B1 (credit allocations), B2
-- (canceled / kept deposit statuses), B3 (biz_date frozen at the service date, not at the first ledger event).

-- Counter ---------------------------------------------------------------------------------------------------------

-- Incremented in the transaction that creates the invoice (row lock), so a rolled-back booking never leaves a gap.
create table invoice_counters (
  location_id uuid primary key references locations(id) on delete cascade,
  next_no integer not null default 20611 check (next_no > 0)
);

-- Invoices ---------------------------------------------------------------------------------------------------------

create table invoices (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  invoice_no integer not null check (invoice_no > 0),
  appointment_id uuid unique references appointments(id),
  customer_id uuid not null references customers(id),
  -- label snapshots: the invoice keeps reading the same after a customer, vehicle or staff edit
  client_name text not null check (btrim(client_name) <> ''),
  vehicle_label text not null default '',
  staff_label text not null default 'Unassigned',
  occurred_at timestamptz not null,
  -- business date of the service (frozen once date_frozen_at is set); Payments ranges, the list sort and the chart use it
  biz_date date not null,
  date_frozen_at timestamptz,
  tax_bp integer not null check (tax_bp between 0 and 10000),
  tip_cents integer not null default 0 check (tip_cents >= 0),
  canceled_at timestamptz,
  canceled_by uuid references users(id) on delete set null,
  canceled_by_name text,
  cancel_reason text check (cancel_reason is null or cancel_reason in ('canceled', 'no_show')),
  payment_link_url text,
  payment_link_sent_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  unique (location_id, invoice_no),
  check ((canceled_at is null) = (cancel_reason is null))
);
create index invoices_biz_date_idx on invoices (location_id, biz_date desc, invoice_no desc);
create index invoices_customer_idx on invoices (customer_id, biz_date desc);

create table invoice_items (
  id uuid primary key,
  invoice_id uuid not null references invoices(id) on delete cascade,
  position integer not null check (position >= 0),
  kind text not null check (kind in ('package', 'addon')),
  service_id uuid references services(id),
  name text not null check (btrim(name) <> ''),
  price_cents integer not null check (price_cents >= 0),
  appointment_addon_id uuid references appointment_addons(id)
);
create index invoice_items_invoice_idx on invoice_items (invoice_id, position);

-- Ledger ------------------------------------------------------------------------------------------------------------

create table ledger_events (
  id uuid primary key,
  seq bigint generated always as identity unique,
  location_id uuid not null references locations(id) on delete cascade,
  invoice_id uuid not null references invoices(id),
  customer_id uuid not null references customers(id),
  type text not null check (type in ('pay', 'adjust', 'refund', 'credit_issue', 'credit_apply', 'void')),
  -- adjust is signed (negative = discount); every other type is positive
  amount_cents integer not null,
  status text not null default 'done' check (status in ('pending', 'done', 'denied')),
  method text,
  method_kind text check (method_kind is null or method_kind in ('card', 'apple_pay', 'cash', 'store_credit', 'other')),
  brand text,
  -- only ever filled from a processor or a seeded design fixture; never fabricated for a card recorded by staff
  last4 text check (last4 is null or last4 ~ '^[0-9]{4}$'),
  dest text check (dest is null or dest in ('card', 'credit', 'cash')),
  deposit boolean not null default false,
  reason text,
  note text,
  expiry text check (expiry is null or expiry in ('none', 'd30', 'd90')),
  expires_at timestamptz,
  item_ids uuid[] not null default '{}',
  parent_event_id uuid references ledger_events(id),
  voids_event_id uuid references ledger_events(id),
  -- the real person (under view-as too); actor_roles = names of the roles that granted the permission, joined with ' + '
  actor_user_id uuid references users(id) on delete set null,
  actor_employee_id uuid references employees(id) on delete set null,
  actor_name text,
  actor_roles text,
  view_as_role_id uuid,
  approved_by_user_id uuid references users(id) on delete set null,
  approved_by_employee_id uuid references employees(id) on delete set null,
  approved_by_name text,
  approved_by_roles text,
  approved_at timestamptz,
  denied_by_user_id uuid references users(id) on delete set null,
  denied_by_employee_id uuid references employees(id) on delete set null,
  denied_by_name text,
  denied_by_roles text,
  denied_at timestamptz,
  denied_note text,
  -- occurred_at is never changed by an approval; resolved_at marks pending -> done / denied
  occurred_at timestamptz not null,
  resolved_at timestamptz,
  source text not null default 'oasis' check (source in ('oasis', 'squarespace', 'system', 'seed')),
  -- the Squarespace leg of a card payment or refund: awaiting_processor until the feed or staff confirm it
  processor_state text not null default 'na' check (processor_state in ('na', 'awaiting_processor', 'confirmed', 'failed')),
  processor_ref text,
  sqsp_order_id text,
  processor_confirmed_at timestamptz,
  processor_confirmed_by text,
  -- a refund that exists only in Squarespace (ingested out of band) and needs a person to look at it
  needs_review boolean not null default false,
  -- <actor user id>:<Idempotency-Key>[:suffix]; Squarespace-derived keys for source=squarespace
  idempotency_key text unique,
  created_at timestamptz not null default app_now(),
  check ((type = 'adjust' and amount_cents <> 0) or (type <> 'adjust' and amount_cents > 0)),
  check (type = 'refund' or status = 'done'),
  check ((type = 'refund') = (dest is not null)),
  check (type <> 'void' or voids_event_id is not null),
  check ((type = 'credit_issue') = (expiry is not null)),
  check (expiry is null or ((expiry = 'none') = (expires_at is null))),
  check (status <> 'pending' or resolved_at is null),
  check (approved_at is null or status = 'done'),
  check (denied_at is null or status = 'denied'),
  check (type = 'refund' or cardinality(item_ids) = 0),
  check (type = 'refund' or processor_state = 'na' or type = 'pay')
);
create index ledger_events_invoice_idx on ledger_events (invoice_id, occurred_at desc, seq desc);
create index ledger_events_customer_idx on ledger_events (customer_id, type, occurred_at);
create index ledger_events_pending_idx on ledger_events (location_id, occurred_at) where status = 'pending';
create index ledger_events_awaiting_idx on ledger_events (location_id, occurred_at) where processor_state = 'awaiting_processor';
create index ledger_events_sqsp_order_idx on ledger_events (sqsp_order_id) where sqsp_order_id is not null;

-- Append-only: no deletes, and an update may only resolve a pending refund (pending -> done | denied, with the matching
-- approver or denier fields) or move the processor fields. Every other column is frozen.
create function ledger_events_guard() returns trigger
language plpgsql as $$
declare
  mutable text[] := array[
    'status', 'resolved_at',
    'approved_by_user_id', 'approved_by_employee_id', 'approved_by_name', 'approved_by_roles', 'approved_at',
    'denied_by_user_id', 'denied_by_employee_id', 'denied_by_name', 'denied_by_roles', 'denied_at', 'denied_note',
    'processor_state', 'processor_ref', 'sqsp_order_id', 'processor_confirmed_at', 'processor_confirmed_by'
  ];
begin
  if tg_op = 'DELETE' then
    raise exception 'ledger_events is append-only: rows cannot be deleted' using errcode = 'restrict_violation';
  end if;
  if (to_jsonb(new) - mutable) is distinct from (to_jsonb(old) - mutable) then
    raise exception 'ledger_events is append-only: only the refund resolution and processor fields can change'
      using errcode = 'restrict_violation';
  end if;
  if new.status is distinct from old.status then
    if not (old.type = 'refund' and old.status = 'pending' and new.status in ('done', 'denied')) then
      raise exception 'ledger_events: a status can only move from pending to done or denied' using errcode = 'restrict_violation';
    end if;
    if new.resolved_at is null then
      raise exception 'ledger_events: resolving a refund must set resolved_at' using errcode = 'restrict_violation';
    end if;
  elsif (new.approved_at is distinct from old.approved_at or new.denied_at is distinct from old.denied_at
         or new.resolved_at is distinct from old.resolved_at) then
    raise exception 'ledger_events: approval fields change only together with the status' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;

create trigger ledger_events_guard before update or delete on ledger_events
  for each row execute function ledger_events_guard();

-- Store credit -------------------------------------------------------------------------------------------------------

-- Written at apply time: which lot (a credit_issue, or a done refund to credit) a credit_apply consumed, FIFO by earliest
-- expiry and skipping lots already expired at that instant (review B1). Balance = remaining of the lots not expired now.
create table credit_allocations (
  id uuid primary key,
  apply_event_id uuid not null references ledger_events(id),
  lot_event_id uuid not null references ledger_events(id),
  customer_id uuid not null references customers(id),
  cents integer not null check (cents > 0),
  created_at timestamptz not null default app_now(),
  unique (apply_event_id, lot_event_id)
);
create index credit_allocations_lot_idx on credit_allocations (lot_event_id);
create index credit_allocations_customer_idx on credit_allocations (customer_id);

create function credit_allocations_guard() returns trigger
language plpgsql as $$
begin
  raise exception 'credit_allocations is append-only' using errcode = 'restrict_violation';
end $$;

create trigger credit_allocations_guard before update or delete on credit_allocations
  for each row execute function credit_allocations_guard();

-- Payment links -----------------------------------------------------------------------------------------------------

create table payment_links (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  invoice_id uuid not null references invoices(id),
  kind text not null default 'checkout' check (kind in ('checkout', 'invoice')),
  purpose text not null default 'balance' check (purpose in ('balance', 'deposit')),
  url text not null check (url ~ '^https://'),
  expected_cents integer not null check (expected_cents > 0),
  created_by uuid references users(id) on delete set null,
  sent_message_id uuid,
  sent_at timestamptz,
  expires_at timestamptz,
  state text not null default 'active' check (state in ('active', 'paid', 'expired', 'canceled')),
  matched_sqsp_order_id text,
  created_at timestamptz not null default app_now()
);
create index payment_links_invoice_idx on payment_links (invoice_id, created_at desc);
create index payment_links_active_idx on payment_links (location_id, created_at) where state = 'active';

-- Calc ---------------------------------------------------------------------------------------------------------------

-- Exact port of the design's calc() in cents (pay-domain 2.1/2.2) with the review fixes. Half-up tax per invoice on the
-- adjusted items subtotal, tip untaxed; store credit counts as payment; refunds of any destination count as refunded;
-- balance is never negative and is 0 for a canceled invoice. Per invoice (lateral) so a list only pays for its own rows.
create function invoice_calc_of(p_invoice uuid)
returns table (
  invoice_id uuid, items bigint, adj bigint, sub bigint, tax bigint, tip bigint, total bigint,
  paid_orig bigint, credit_applied bigint, paid bigint, refunded bigint, ref_orig bigint,
  pending_amt bigint, pending_n bigint, issued bigint, balance bigint, refundable bigint, to_orig_max bigint,
  net bigint, overpaid bigint, status text
)
language sql stable as $$
  with i as (
    select id, tax_bp, tip_cents, canceled_at from invoices where id = p_invoice
  ),
  it as (
    select coalesce(sum(price_cents), 0)::bigint as items from invoice_items where invoice_id = p_invoice
  ),
  e as (
    select
      coalesce(sum(amount_cents) filter (where type = 'adjust'), 0)::bigint as adj,
      (coalesce(sum(amount_cents) filter (where type = 'pay'), 0)
        - coalesce(sum(amount_cents) filter (where type = 'void'), 0))::bigint as paid_orig,
      coalesce(sum(amount_cents) filter (where type = 'credit_apply'), 0)::bigint as credit_applied,
      coalesce(sum(amount_cents) filter (where type = 'refund' and status = 'done'), 0)::bigint as refunded,
      coalesce(sum(amount_cents) filter (where type = 'refund' and status = 'done' and dest <> 'credit'), 0)::bigint as ref_orig,
      coalesce(sum(amount_cents) filter (where type = 'refund' and status = 'pending'), 0)::bigint as pending_amt,
      count(*) filter (where type = 'refund' and status = 'pending')::bigint as pending_n,
      coalesce(sum(amount_cents) filter (where type = 'credit_issue'), 0)::bigint as issued
    from ledger_events where invoice_id = p_invoice
  ),
  b as (
    select i.id as invoice_id, i.tax_bp, i.tip_cents::bigint as tip, i.canceled_at,
      it.items, e.adj, greatest(it.items + e.adj, 0) as sub,
      e.paid_orig, e.credit_applied, e.paid_orig + e.credit_applied as paid,
      e.refunded, e.ref_orig, e.pending_amt, e.pending_n, e.issued
    from i cross join it cross join e
  ),
  c as (
    select b.*, (b.sub * b.tax_bp + 5000) / 10000 as tax from b
  ),
  d as (
    select c.*, c.sub + c.tax + c.tip as total from c
  ),
  f as (
    select d.*, case when d.canceled_at is not null then 0 else greatest(0, d.total - d.paid) end as balance from d
  )
  select f.invoice_id, f.items, f.adj, f.sub, f.tax, f.tip, f.total,
    f.paid_orig, f.credit_applied, f.paid, f.refunded, f.ref_orig,
    f.pending_amt, f.pending_n, f.issued, f.balance,
    greatest(0, f.paid - f.refunded - f.pending_amt) as refundable,
    greatest(0, f.paid_orig - f.ref_orig) as to_orig_max,
    f.items + f.adj - ((f.refunded * 10000 + (10000 + f.tax_bp) / 2) / (10000 + f.tax_bp)) as net,
    greatest(0, f.paid - f.refunded - f.total) as overpaid,
    case
      when f.canceled_at is not null and f.paid = 0 and f.refunded = 0 then 'canceled'
      when f.canceled_at is not null and f.refunded >= f.paid then 'canceled_refunded'
      when f.canceled_at is not null then 'canceled_kept'
      when f.refunded > 0 and f.refunded >= f.paid - 1 then 'refunded'
      when f.paid = 0 then 'unpaid'
      when f.balance > 0 then 'partially_paid'
      when f.refunded > 0 then 'partially_refunded'
      else 'paid'
    end as status
  from f
$$;

create view invoice_calc as
  select c.* from invoices i cross join lateral invoice_calc_of(i.id) c;
