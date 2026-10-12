-- Memberships on Square (ADR 0171 wave Q3b, design q-design-square.md Phase 5 with the plan's amendments): a membership can be billed
-- by a Square subscription (source 'square'). The append-only membership_tier_prices (ADR 0170) IS the Square plan-variation history:
-- each row becomes one SUBSCRIPTION_PLAN_VARIATION (STATIC, MONTHLY) and a price edit adds a row, so a new variation; there is no
-- separate variations table. A membership names the size it is priced at (plan_class) and the price row it is billed at
-- (tier_price_id); the Square subscription's state is mirrored here; the enrollment of a personal-link page is a resumable state
-- machine (square_enrollments) and every subscription invoice Square sends is kept (square_subscription_invoices).
-- Nothing here does anything by itself: with the defaults (SQUARE_WRITES_ENABLED=false, PAYMENT_PROCESSOR=squarespace,
-- PUBLIC_LINKS_ENABLED=false) no row of the new tables is written and no tier price is synced.

-- ---- tier prices: the Square plan variations ----------------------------------------------------------------------------------

-- 'retired': a superseded price whose variation no subscription ever used was deleted at Square (one that has subscriptions is
-- never deleted: Square refuses it, and members keep their price, plan decision 8)
alter table membership_tier_prices drop constraint membership_tier_prices_square_state_check;
alter table membership_tier_prices
  add constraint membership_tier_prices_square_state_check check (square_state in ('pending', 'synced', 'failed', 'retired')),
  -- why the last sync of this price failed (plain words, no ids or secrets)
  add column square_error text check (square_error is null or length(square_error) <= 300);

-- The guard of 20261014100100 with square_error among the Square fields that may change.
create or replace function membership_tier_prices_guard() returns trigger
language plpgsql as $$
declare
  mutable text[] := array['superseded_at', 'square_variation_id', 'square_state', 'square_synced_at', 'square_error'];
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from membership_plans p where p.id = old.plan_id) then
      raise exception 'membership_tier_prices is append-only: rows cannot be deleted' using errcode = 'restrict_violation';
    end if;
    return old;
  end if;
  if (to_jsonb(new) - mutable) is distinct from (to_jsonb(old) - mutable) then
    raise exception 'membership_tier_prices is append-only: only superseded_at and the Square fields can change'
      using errcode = 'restrict_violation';
  end if;
  if old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at then
    raise exception 'membership_tier_prices: a superseded price stays superseded' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;

create unique index uq_membership_tier_prices_square_variation on membership_tier_prices (square_variation_id)
  where square_variation_id is not null;

-- ---- memberships billed by Square ------------------------------------------------------------------------------------------------

alter table memberships drop constraint memberships_source_check;
alter table memberships
  add constraint memberships_source_check check (source in ('squarespace', 'manual', 'square')),
  -- the Square subscription billing this membership, its customer and the saved card it charges (customer_cards)
  add column square_subscription_id text check (square_subscription_id is null or length(square_subscription_id) <= 64),
  add column square_customer_id text check (square_customer_id is null or length(square_customer_id) <= 64),
  add column card_id uuid references customer_cards(id),
  -- Square's own status of the subscription (PENDING, ACTIVE, PAUSED, CANCELED, DEACTIVATED), as last read
  add column square_status text check (square_status is null or square_status ~ '^[A-Z_]{1,20}$'),
  -- the renewal failure policy (plan decision 7): ok, or failed since payment_failed_at (day 0: in grace, perks on; day 7: past
  -- due, perks off; day 21: canceled); any payment sets it back to ok
  add column billing_status text not null default 'ok' check (billing_status in ('ok', 'failed')),
  add column payment_failed_at timestamptz,
  -- when the client was texted (and emailed) the card link for this failure (null: not yet)
  add column failure_notified_at timestamptz,
  -- what Square has scheduled for the next billing date (SwapPlan, Pause and Cancel take effect then: sandbox 2026-10-12)
  add column cancel_effective_at date,
  add column pause_effective_at date,
  -- a tier or size change (staff, or "Move members"): {kind, toTierPriceId, fromTierPriceId, planKey, planClass, effectiveDate,
  -- swapAfter, noticeSentAt, requestedAt, by}
  add column scheduled_change jsonb check (scheduled_change is null or jsonb_typeof(scheduled_change) = 'object'),
  -- plan variations whose scheduled swap staff undid in this billing period: Square must not get the same SwapPlan again (after
  -- DeleteSubscriptionAction it answered 500 "locked and is not billable" and then refused every change: sandbox 2026-10-12);
  -- cleared when the next paid cycle starts
  add column swap_undone_variations text[] not null default '{}',
  add column square_synced_at timestamptz,
  add constraint memberships_square_check check (
    source <> 'square' or (square_customer_id is not null or status in ('pending', 'canceled'))),
  add constraint memberships_billing_failed_check check ((billing_status = 'failed') = (payment_failed_at is not null));
create unique index uq_memberships_square_subscription on memberships (square_subscription_id) where square_subscription_id is not null;
create index memberships_billing_failed_idx on memberships (location_id, payment_failed_at) where billing_status = 'failed';

-- ---- enrollments --------------------------------------------------------------------------------------------------------------

-- One attempt to join on a membership page (#/m) with a card: started -> customer_ready -> card_saved -> subscribed -> active, or
-- failed / abandoned. The Square calls use keys derived from the row id (cd_<id> the card, sb_<id> the subscription), so the job
-- square.enrollments.resume repeats a step with the same key and Square answers the same object. The card's one-time token is
-- never stored: an attempt that died before its card was saved cannot be resumed (the page asks again). cleanup: the Square work
-- a failed attempt still owes (cancel the subscription and its open invoice, disable the card).
create table square_enrollments (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  customer_id uuid not null references customers(id),
  membership_id uuid not null references memberships(id),
  link_id uuid,
  plan_id uuid not null references membership_plans(id),
  tier_price_id uuid not null references membership_tier_prices(id),
  plan_class text not null check (plan_class ~ '^[a-z][a-z0-9_]{0,31}$'),
  square_variation_id text not null check (length(square_variation_id) <= 64),
  monthly_cents integer not null check (monthly_cents >= 0),
  -- the email Square bills to (receipts, a failed payment's invoice): checked deliverable-looking, never a reserved test domain
  email text not null check (length(email) between 3 and 254 and position('@' in email) > 1),
  state text not null default 'started'
    check (state in ('started', 'customer_ready', 'card_saved', 'subscribed', 'active', 'failed', 'abandoned')),
  square_customer_id text check (square_customer_id is null or length(square_customer_id) <= 64),
  card_id uuid references customer_cards(id),
  consent_id uuid references card_consents(id),
  square_subscription_id text check (square_subscription_id is null or length(square_subscription_id) <= 64),
  start_date date not null,
  failure_code text check (failure_code is null or failure_code in
    ('card_declined', 'square_unavailable', 'subscription_refused', 'first_payment_failed', 'deactivated', 'expired', 'superseded')),
  failure_detail text check (failure_detail is null or length(failure_detail) <= 300),
  cleanup text not null default 'none' check (cleanup in ('none', 'pending', 'done')),
  attempts integer not null default 0 check (attempts >= 0),
  last_attempt_at timestamptz,
  started_at timestamptz not null,
  finished_at timestamptz,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  check ((state in ('failed', 'abandoned')) = (failure_code is not null)),
  check (state in ('started', 'customer_ready') or state in ('failed', 'abandoned') or card_id is not null),
  check (state not in ('subscribed', 'active') or square_subscription_id is not null)
);
create index square_enrollments_membership_idx on square_enrollments (membership_id, started_at);
create index square_enrollments_open_idx on square_enrollments (location_id, state, started_at)
  where state in ('started', 'customer_ready', 'card_saved', 'subscribed') or cleanup = 'pending';
create unique index uq_square_enrollments_subscription on square_enrollments (square_subscription_id)
  where square_subscription_id is not null;
-- one attempt in flight per membership
create unique index uq_square_enrollments_live on square_enrollments (membership_id)
  where state in ('started', 'customer_ready', 'card_saved', 'subscribed');

-- ---- subscription invoices ----------------------------------------------------------------------------------------------------

-- Every invoice Square makes for a membership's subscription, as last read (GetInvoice), and what Oasis did with it: applied_at
-- when the paid cycle was applied (the period moved, the cycle's credits granted: once per invoice), failed_at when its charge
-- failed (the failure policy), refunded when staff refunded its payment.
create table square_subscription_invoices (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  membership_id uuid not null references memberships(id),
  square_invoice_id text not null unique check (length(square_invoice_id) <= 64),
  square_subscription_id text not null check (length(square_subscription_id) <= 64),
  square_order_id text check (square_order_id is null or length(square_order_id) <= 64),
  status text not null check (status ~ '^[A-Z_]{1,24}$'),
  amount_cents integer not null check (amount_cents >= 0),
  paid_cents integer not null default 0 check (paid_cents >= 0),
  due_date date,
  period_start timestamptz,
  period_end timestamptz,
  -- Square's own page where the client can pay it (not a secret: it is in Square's emails)
  public_url text check (public_url is null or (public_url ~ '^https://' and length(public_url) <= 2048)),
  paid_at timestamptz,
  applied_at timestamptz,
  failed_at timestamptz,
  canceled_at timestamptz,
  square_payment_id text check (square_payment_id is null or length(square_payment_id) <= 64),
  refunded_cents integer not null default 0 check (refunded_cents >= 0),
  square_refund_id text check (square_refund_id is null or length(square_refund_id) <= 64),
  refunded_at timestamptz,
  -- Square's status of that refund, kept current by its refund.* events: one FAILED or REJECTED sets refunded_cents back to 0 (the
  -- money never left) and keeps its id, so staff can refund again with a new key
  refund_status text check (refund_status is null or refund_status in ('PENDING', 'COMPLETED', 'FAILED', 'REJECTED')),
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  check (period_end is null or period_start is null or period_end > period_start),
  check (refunded_cents <= paid_cents)
);
create index square_subscription_invoices_membership_idx on square_subscription_invoices (membership_id, created_at);
create index square_subscription_invoices_order_idx on square_subscription_invoices (square_order_id) where square_order_id is not null;

-- ---- cards: why a card or consent ended when a membership did not start ----------------------------------------------------------

alter table customer_cards drop constraint customer_cards_disabled_reason_check;
alter table customer_cards add constraint customer_cards_disabled_reason_check check (disabled_reason is null or disabled_reason in
  ('client_removed', 'staff_removed', 'square_disabled', 'square_forgotten', 'expired', 'customer_deleted', 'membership_failed'));
alter table card_consents drop constraint card_consents_revoke_reason_check;
alter table card_consents add constraint card_consents_revoke_reason_check check (revoke_reason is null or revoke_reason in
  ('client_removed', 'staff_removed', 'card_disabled', 'card_forgotten', 'card_expired', 'replaced', 'customer_deleted',
   'membership_failed'));
