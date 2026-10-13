-- Review Q4 fixes (ADR 0171 wave Q4 notes).
--
-- SQ-SEM-1: a refund made in the Square app before its payment is on an invoice (the counter delay, the "payments to match" queue) is
-- kept here until the payment is recorded on an invoice; then it is recorded on that invoice in the same transaction and the row is
-- deleted. Nothing here moves money: with the defaults no Square refund reaches Oasis.
create table square_refunds_waiting (
  square_refund_id text primary key,
  location_id uuid not null references locations(id) on delete cascade,
  square_payment_id text not null,
  -- the refund as Square answered it (SquareRefundFacts: id, status, payment, order, location, amount in cents, reason, created_at)
  facts jsonb not null,
  received_at timestamptz not null default app_now()
);
create index square_refunds_waiting_payment_idx on square_refunds_waiting (square_payment_id);

-- SQ-SEM-5: the catch-up also runs, from the log itself, the Square rows the hook claimed whose job was lost and the failed rows,
-- wherever its search window is.
create index webhook_log_square_open_idx on webhook_log (received_at) where provider = 'square' and status in ('received', 'failed');
