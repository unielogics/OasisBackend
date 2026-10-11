-- Membership matching (ADR 0160, design section 5 "Squarespace", wave W2e). The order sync links a membership order to a client
-- through the checkout intent first (expected email + product + window), never through an email nobody verified: an order whose
-- email matches only such an email waits for staff in a checkout row of its own ('awaiting_match', opened by the sync), which staff
-- confirm ('matched') or reject ('rejected'). A row the sync opens names the waiting order and has no checkout URL.

-- who opened the row: a personal link (the membership page) or the order sync (an order waiting for staff)
alter table membership_checkouts
  add column origin text not null default 'link' check (origin in ('link', 'sync')),
  alter column checkout_url drop not null,
  add constraint membership_checkouts_url_origin_check check (checkout_url is not null or origin = 'sync'),
  -- the order a sync row waits for (matched_order_id) is always named
  add constraint membership_checkouts_sync_order_check check (origin = 'link' or matched_order_id is not null);

alter table membership_checkouts drop constraint membership_checkouts_state_check;
alter table membership_checkouts add constraint membership_checkouts_state_check
  check (state in ('open', 'matched', 'awaiting_match', 'expired', 'superseded', 'abandoned', 'rejected'));

-- staff review the waiting rows; the sync finds a row again by its order
create index membership_checkouts_awaiting_idx on membership_checkouts (location_id, created_at desc) where state = 'awaiting_match';
create index membership_checkouts_order_idx on membership_checkouts (matched_order_id) where matched_order_id is not null;
-- one row per client and waiting order: a second pass never opens a second one
create unique index uq_membership_checkouts_sync_order on membership_checkouts (customer_id, matched_order_id) where origin = 'sync';

-- An email that changes is no longer the one that was verified: the flag always drops with it. customers.email_verified feeds the
-- order sync's email tier, so a stale true would let anyone who knows the new address claim the client's Squarespace orders. A
-- statement cannot show that it verified the new address (when the flag was already true, "set email_verified = true" and "left
-- it alone" look the same), so the only way to keep it is memberships/verified-email.ts setVerifiedEmail: it names the address in
-- the transaction-local setting oasis.verified_email for that one statement. Changing only the letter case (citext) is no change.
create function customers_email_unverify() returns trigger
language plpgsql as $$
begin
  if new.email is distinct from old.email
     and not (new.email_verified
              and new.email is not null
              and lower(coalesce(current_setting('oasis.verified_email', true), '')) = lower(new.email::text)) then
    new.email_verified := false;
  end if;
  return new;
end
$$;
create trigger customers_email_unverify before update of email on customers
  for each row execute function customers_email_unverify();
