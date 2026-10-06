# 0050 Payments: append-only ledger and the invoice calc

Status: accepted (2026-10-06)

* **The ledger is append-only in the database.** `ledger_events` has a `BEFORE UPDATE OR DELETE` trigger: deletes are refused
  and an update may only (a) resolve a pending refund (`pending -> done | denied`, with `resolved_at` and the matching
  approver or denier fields) or (b) move the processor fields (`processor_state`, `processor_ref`, `sqsp_order_id`,
  confirmation stamp). Every other column, including `occurred_at` (an approval never changes when a refund was requested),
  is frozen. `credit_allocations` is insert-only. Table checks keep malformed rows out (adjust is signed and non-zero,
  everything else positive, only refunds carry `dest`, only credit issues carry an expiry, a void names the event it voids).
* **One calc, in cents, in SQL and in TypeScript.** `invoice_calc_of(invoice_id)` (a per-invoice SQL function, so a list only
  pays for its own rows) ports the design's `calc()` exactly: tax is half-up on the adjusted items subtotal at the rate
  snapshotted on the invoice (`tax_bp`), tip is untaxed, store credit counts as payment, refunds of any destination count as
  refunded, a pending refund only reserves `refundable`, `toOrigMax` excludes store credit used, balance is never negative and
  is 0 for a canceled invoice, `net = items + adj - round(refunded * 10000 / (10000 + tax_bp))` per invoice. `invoice_calc` is
  the view over all invoices. `calcInvoice()` in `payments/calc.ts` is the twin used for sheet previews and seeds; a test
  asserts SQL equals the twin on every seeded invoice and equals the ORIGINAL bundle's `calc()` (to the cent) on all 105.
* **Status ladder** (first match wins): `canceled` (canceled, nothing paid or refunded), `canceled_refunded` (canceled,
  refunded >= paid), `canceled_kept` (canceled with a deposit that stays), `refunded` (refunded > 0 and within one cent of
  paid), `unpaid`, `partially_paid`, `partially_refunded`, `paid`. The design only had `Canceled · refunded`; a canceled
  invoice with a kept deposit fell through to `Paid` (review B2, C2). Display label `Refund pending` overrides while a refund
  waits.
* **Void** is a ledger event (`void`, amount of the voided payment, `voids_event_id`), only for cash or a card payment still
  awaiting Squarespace; confirmed card money is refunded instead. Un-pay is therefore never a silent edit.
* Every command locks the invoice row (`SELECT ... FOR UPDATE`), is idempotent by `Idempotency-Key` (the ledger key is
  `<actor>:<key>[:suffix]`, unique), bumps `invoices.version`, writes the audit row and publishes on the `payments` channel in
  the same transaction.
