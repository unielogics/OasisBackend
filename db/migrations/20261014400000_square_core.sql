-- Square core (ADR 0171, wave Q2b): the ledger learns which processor took a card payment or refund, a refund Square reports
-- FAILED or REJECTED stops counting as refunded, payment links carry their Square ids, and three new tables hold the Square payment
-- mirror (with the counter-matching decision), the refund legs sent through the Square API and the POS app-switch intents.
-- Nothing here moves money: with the defaults (SQUARE_PROVIDER=sim, SQUARE_WRITES_ENABLED=false, PAYMENT_PROCESSOR=squarespace) no
-- row of the new tables is ever written outside tests.

-- Ledger ----------------------------------------------------------------------------------------------------------------------

alter table ledger_events drop constraint ledger_events_source_check;
alter table ledger_events
  add constraint ledger_events_source_check check (source in ('oasis', 'squarespace', 'system', 'seed', 'square'));

-- which processor took (or is to take) the card money: squarespace (the sync, staff confirming in Squarespace) or square
alter table ledger_events add column processor text check (processor is null or processor in ('squarespace', 'square'));
-- the Square order of a Square payment (a link's order, a POS order)
alter table ledger_events add column processor_order_id text;

create index ledger_events_processor_ref_idx on ledger_events (processor, processor_ref) where processor_ref is not null;

-- Append-only, as before, with two changes: the processor and its order id may be filled in (like processor_ref), and the method
-- label, brand and last4 may change only on the move from awaiting_processor to confirmed (a staff "card" entry confirmed by a
-- Square payment becomes "Visa ••4242").
create or replace function ledger_events_guard() returns trigger
language plpgsql as $$
declare
  mutable text[] := array[
    'status', 'resolved_at',
    'approved_by_user_id', 'approved_by_employee_id', 'approved_by_name', 'approved_by_roles', 'approved_at',
    'denied_by_user_id', 'denied_by_employee_id', 'denied_by_name', 'denied_by_roles', 'denied_at', 'denied_note',
    'processor_state', 'processor_ref', 'sqsp_order_id', 'processor_confirmed_at', 'processor_confirmed_by',
    'processor', 'processor_order_id'
  ];
  on_confirm text[] := array['method', 'brand', 'last4'];
begin
  if tg_op = 'DELETE' then
    raise exception 'ledger_events is append-only: rows cannot be deleted' using errcode = 'restrict_violation';
  end if;
  if old.processor_state = 'awaiting_processor' and new.processor_state = 'confirmed' then
    mutable := mutable || on_confirm;
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

-- the Squarespace money already in the ledger (the re-created guard lets the processor be filled in)
update ledger_events set processor = 'squarespace' where source = 'squarespace' or sqsp_order_id is not null;

-- Calc: a card refund the processor reports failed (processor_state 'failed') is no longer money given back: it leaves `refunded`
-- and `ref_orig` (and with them refundable, net, overpaid and the status). Everything else is the 20261006190000 function unchanged.
-- Twins: src/modules/payments/calc.ts, src/modules/payments/jobs-integrity.ts, the dashboard's src/lib/payments/cents.ts.
create or replace function invoice_calc_of(p_invoice uuid)
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
      coalesce(sum(amount_cents) filter (where type = 'refund' and status = 'done' and processor_state <> 'failed'), 0)::bigint
        as refunded,
      coalesce(sum(amount_cents) filter (where type = 'refund' and status = 'done' and processor_state <> 'failed'
        and dest <> 'credit'), 0)::bigint as ref_orig,
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

-- Payment links -----------------------------------------------------------------------------------------------------------------

-- A Square link is created at click time for an exact amount (ADR 0171 D3). Its row starts `pending` (planned before the Square
-- call, so a crash between the call and the command leaves a row the sweep can clean up), becomes `active` when the command that
-- asked for it commits, and is canceled (and deleted at Square) once the invoice no longer owes exactly that amount. A booking's
-- deposit request is a pending row the job square.deposit-link turns into a quick-pay link (origin 'booking', no URL yet).
alter table payment_links alter column url drop not null;
alter table payment_links drop constraint payment_links_url_check;
alter table payment_links add constraint payment_links_url_check check (url is null or url ~ '^https://');
alter table payment_links drop constraint payment_links_kind_check;
alter table payment_links
  add constraint payment_links_kind_check check (kind in ('checkout', 'invoice', 'square_order', 'square_quick_pay'));
alter table payment_links drop constraint payment_links_state_check;
alter table payment_links
  add constraint payment_links_state_check check (state in ('pending', 'active', 'paid', 'expired', 'canceled'));
alter table payment_links add column provider text not null default 'squarespace' check (provider in ('squarespace', 'square'));
-- who asked for it: staff (Send link, Collect), the pay page, a booking (the deposit), the deposit button of a calendar page
alter table payment_links add column origin text not null default 'staff'
  check (origin in ('staff', 'pay_page', 'booking', 'deposit_page'));
alter table payment_links add column square_payment_link_id text unique;
alter table payment_links add column square_order_id text unique;
alter table payment_links add column square_version integer;
-- invoices.version when the amount was fixed (diagnostics: what the link was made for)
alter table payment_links add column invoice_version integer;
alter table payment_links add column canceled_at timestamptz;
alter table payment_links add column cancel_reason text check (cancel_reason is null or cancel_reason in
  ('superseded', 'amount_changed', 'paid_elsewhere', 'invoice_canceled', 'expired', 'stale', 'square_error', 'deposit_paid'));
alter table payment_links add column square_deleted_at timestamptz;
alter table payment_links add column paid_square_payment_id text;
alter table payment_links add constraint payment_links_square_check check (
  (provider = 'square') = (kind in ('square_order', 'square_quick_pay'))
  and (url is not null or (provider = 'square' and state in ('pending', 'canceled', 'expired'))));
create index payment_links_square_open_idx on payment_links (location_id, created_at) where provider = 'square' and state in ('pending', 'active');

-- The Square payment mirror -----------------------------------------------------------------------------------------------------

-- Every Square payment of our location as Square last answered it (re-fetched by id, never trusted from a payload), and what Oasis
-- decided about it: the classification (link, charge, membership, pos_intent, counter, ignored) and the match (pending until decided;
-- matched to an invoice and a ledger event; unmatched with ranked candidates for the "Square payments to match" queue; ignored).
create table square_payments (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  square_payment_id text not null unique,
  square_location_id text,
  status text not null,
  source_type text,
  square_product text,
  application_id text,
  square_order_id text,
  reference_id text,
  note text,
  receipt_number text,
  receipt_url text,
  amount_cents integer not null check (amount_cents >= 0),
  tip_cents integer not null default 0 check (tip_cents >= 0),
  total_cents integer not null check (total_cents >= 0),
  refunded_cents integer not null default 0 check (refunded_cents >= 0),
  card_brand text,
  last4 text check (last4 is null or last4 ~ '^[0-9]{4}$'),
  entry_method text,
  square_customer_id text,
  buyer_email text,
  square_created_at timestamptz not null,
  square_updated_at timestamptz,
  classification text check (classification is null or classification in
    ('link', 'charge', 'membership', 'pos_intent', 'counter', 'ignored')),
  match_state text not null default 'pending' check (match_state in ('pending', 'matched', 'unmatched', 'ignored')),
  -- a counter payment is matched no earlier than this (SQUARE_MATCH_DELAY_SECONDS after Square created it)
  match_after timestamptz,
  invoice_id uuid references invoices(id),
  event_id uuid references ledger_events(id),
  tip_event_id uuid references ledger_events(id),
  -- R1 invoice number, R2 POS intent, R3 awaiting entry, R4 identity + balance, R4a amount only, link, cash_entry, manual
  rule text,
  confidence numeric(3, 2),
  candidates jsonb not null default '[]',
  variance jsonb,
  decided_by text,
  decided_by_user_id uuid references users(id) on delete set null,
  decided_at timestamptz,
  ignore_reason text check (ignore_reason is null or ignore_reason in ('not_oasis_sale', 'duplicate', 'test', 'other')),
  ignore_note text,
  first_seen_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  check ((match_state = 'matched') = (invoice_id is not null and event_id is not null)),
  check ((match_state = 'ignored') = (ignore_reason is not null))
);
create index square_payments_open_idx on square_payments (location_id, square_created_at) where match_state in ('pending', 'unmatched');
create index square_payments_invoice_idx on square_payments (invoice_id) where invoice_id is not null;
create index square_payments_order_idx on square_payments (square_order_id) where square_order_id is not null;

-- Refund legs -------------------------------------------------------------------------------------------------------------------

-- One Square refund of one Square payment for one ledger refund: the refund row is the outbox (job square.refunds.submit plans the
-- legs newest payment first, each capped by what that payment can still give back, and sends RefundPayment with the leg's key);
-- refund.* webhooks move the legs. A refund made in the Square POS app that Oasis attached or recorded is a leg too (origin pos), so
-- every Square refund tied to the ledger is here and a payment's remaining refundable amount is its total less its live legs.
create table square_refund_legs (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  ledger_event_id uuid not null references ledger_events(id),
  square_payment_id text not null,
  amount_cents integer not null check (amount_cents > 0),
  origin text not null default 'api' check (origin in ('api', 'pos')),
  idempotency_key text unique,
  square_refund_id text unique,
  state text not null default 'to_submit' check (state in ('to_submit', 'pending', 'completed', 'failed', 'rejected')),
  error text,
  attempts integer not null default 0 check (attempts >= 0),
  submitted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  check (origin = 'pos' or idempotency_key is not null)
);
create index square_refund_legs_event_idx on square_refund_legs (ledger_event_id);
create index square_refund_legs_payment_idx on square_refund_legs (square_payment_id);
create index square_refund_legs_open_idx on square_refund_legs (location_id, created_at) where state in ('to_submit', 'pending');

-- POS app switch ----------------------------------------------------------------------------------------------------------------

-- "Open Square POS" from the dashboard (SQUARE_POS_API_ENABLED, production only): the intent remembers the invoice, the amount, the
-- staff "card" entry it wrote, the random `state` the callback must return and the short code in the payment's note (OAS-PI-xxxx),
-- so the payment is recorded on strong evidence (rule R2).
create table square_pos_intents (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  invoice_id uuid not null references invoices(id),
  ledger_event_id uuid references ledger_events(id),
  amount_cents integer not null check (amount_cents > 0),
  callback_state text not null unique,
  code text not null unique check (code ~ '^OAS-PI-[A-Z0-9]{4,8}$'),
  note text not null,
  status text not null default 'open' check (status in ('open', 'callback_ok', 'callback_error', 'matched', 'expired')),
  transaction_id text,
  client_transaction_id text,
  error_code text,
  square_payment_id text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default app_now(),
  expires_at timestamptz not null,
  callback_at timestamptz
);
create index square_pos_intents_open_idx on square_pos_intents (location_id, created_at) where status in ('open', 'callback_ok');
