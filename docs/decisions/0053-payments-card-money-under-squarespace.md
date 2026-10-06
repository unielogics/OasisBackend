# 0053 Payments: card money recorded in Oasis, awaiting Squarespace

Status: accepted (2026-10-06)

Squarespace stays the card processor and is read-only (ADR 0003); Oasis owns the ledger.

* A card payment recorded by staff is a `pay` event that counts as paid immediately with `processor_state =
  awaiting_processor`. Its label is **the card brand only** (`Card`, or `Visa` when a `CardHintProvider` knows the brand);
  `last4` is never filled for a card staff recorded (Squarespace does not expose it). The design's hard-coded `Visa ••4421` is
  gone. Seeded design fixtures keep their `Visa ••4421` labels (`source = 'seed'`, `confirmed`).
* A done card refund (requested within limit, or approved) is `awaiting_processor` too: it must be completed in Squarespace.
  A pending refund has `processor_state = na` until approval.
* Cash, store credit and cash refunds have no processor leg (`na`).
* **Closing the loop**: staff `POST /ledger-events/:id/confirm-processor` (permission of the original action), or the sync
  (payments-sync `LedgerCommands.confirmAwaitingEvent`) sets `confirmed` with `processor_ref` and `sqsp_order_id`; only those
  fields may change (ADR 0050). `GET /payments/reconciliation` and the `payments.lag-scan` job (every 15 minutes) flag events
  waiting more than 2 hours (review B8). Revenue KPIs count awaiting events; `awaitingProcessor{count,cents}` is an API field.
* **Payment links**: staff attach a Squarespace checkout or invoice URL (https, allow-listed host) which is texted to the
  client; `payment_links` records the expected amount and purpose (balance or deposit). No ledger event exists until the sync
  or staff record the payment, so a link can never be counted before money moves. The matcher binds a later Squarespace order
  to an existing awaiting event first, then to a link (payments-sync, review B10).
* Receipts and links go through the `PaymentMessenger` port (opt-in and opt-out aware); SMS policy (quiet hours, allowlist,
  synthetic numbers) is applied by the outbox that Messaging provides.
