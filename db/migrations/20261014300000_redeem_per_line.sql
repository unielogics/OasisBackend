-- Membership coverage follows the visit (ADR 0170, wave Q2a review). An inclusion covers every line of a visit it names (one redeem
-- per covered line: "Wax and rain repellent every wash" covers both), and a visit changed after it was settled (the size confirmed,
-- an add-on added or removed) is settled again: a redeem whose line changed is given back (a `restore` keyed restore:<redeem id>,
-- whose ledger_event_id is the adjust that reverses it) and a new redeem takes its place. So one appointment and inclusion can hold
-- several redeems over time. The service settles a visit under its appointment row lock, and the unique idempotency key names
-- each redeem: redeem:<appointment>:<inclusion> for the first, redeem:<appointment>:<inclusion>:<n> for the n-th.
drop index uq_credit_redeem_appointment;
create index membership_credit_events_appointment_idx on membership_credit_events (appointment_id)
  where appointment_id is not null;
