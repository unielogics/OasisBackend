-- Charges on a saved card (ADR 0171 D7, plan decision 6, wave Q3a; design q-design-square.md 4.3): the fields the charge flow needs
-- on top of the cards foundation (20261014500000_square_cards.sql).
--   attempted_at  when the current CreatePayment attempt started (the job square.charges.resolve re-sends an unanswered attempt with
--                 the same key while it is younger than 23 hours; a staff retry after a decline starts a new attempt with a new key)
--   decline_code  Square's code for a declined attempt (GENERIC_DECLINE, CVV_FAILURE, ...); `error` keeps the plain words staff see
--   reason        what the charge is for, as the ledger and the client's text say it ("No-show fee", "Balance")
-- customer_cards.expiry_notice_for: the expiry ("2026-11") the nightly job square.cards.nightly last texted a card link about, for a
-- card paying a membership (one text per card and expiry).
-- One open fee per visit and purpose: a second cancel or no-show of the same visit (after a reopen) never proposes a second fee
-- while the first is still open (proposed, being charged, unanswered or declined).
-- Nothing here moves money: a row is only proposed while fees.card_on_file is enabled and Square is the processor, and only
-- charged after a staff member confirms it.

alter table square_charges add column attempted_at timestamptz;
alter table square_charges add column decline_code text check (decline_code is null or length(decline_code) <= 64);
alter table square_charges add column reason text check (reason is null or length(reason) <= 120);

alter table customer_cards add column expiry_notice_for text check (expiry_notice_for is null or expiry_notice_for ~ '^[0-9]{4}-[0-9]{2}$');

create unique index square_charges_open_fee_idx on square_charges (appointment_id, purpose)
  where appointment_id is not null and purpose in ('no_show_fee', 'late_cancel_fee')
    and state in ('proposed', 'charging', 'unknown', 'declined');
