# 0071 Squarespace sync over the real ledger

Status: accepted (2026-10-07). Implements backend design 7.1.2 to 7.1.5 and reviews B10, B41, B42, D14.

`PgLedger` (`src/modules/payments-sync/db/ledger.ts`) implements `LedgerReader` and `LedgerCommands` over `ledger_events`,
`payment_links` and `invoices`; `InMemoryLedger` stayed the reference and its behaviour is what the tests assert.

## Reading

`loadContext(order)` returns, for the order: events tied to it by `sqsp_order_id` or `processor_ref`, plus staff-recorded events
waiting on the processor within 48 h of the arrivals; active payment links inside the 14-day window plus any link explicitly
attached to the order; the customers' identities (email, phone, linked Squarespace ids); and an invoice summary per touched
invoice (total, tax, balance from `invoice_calc_of`, the live pay events). **Voided events are excluded** (a voided awaiting
payment can never be "confirmed"), and a card refund still pending Oasis approval is presented as waiting on the processor so a
feed refund for it goes to a person (`refund_pending_approval`) instead of being ingested as an external refund.

## Commands

Each command claims its Squarespace-derived key (`sqsp:<orderId>:<payment|refund>:<transactionId|order>`) in `sqsp_matches`
(unique) in the same transaction, locks the invoice row, writes, bumps the invoice version, writes an audit row (actor
"Squarespace", or the staff member for manual matches) and publishes `invoice.updated` and `ledger.event` on the payments channel
exactly as a staff command does. A repeat is a no-op that returns the first result.

* **Confirm** (`confirmAwaitingEvent`, `confirmRefundEvent`): only the processor fields the ledger guard allows move
  (`processor_state = confirmed`, `processor_ref`, `sqsp_order_id`, `processor_confirmed_at/by`). An event staff already confirmed
  by hand only gets the missing references.
* **Record a payment** (link match or manual): one `pay` event, `source = squarespace`, `processor_state = confirmed`, method label
  from the card brand only (`Visa`, `Card` for `OTHER`), `occurred_at` = Squarespace `paidOn`, `deposit` when below the balance;
  the link becomes `paid` with `matched_sqsp_order_id`. Never a second pay event for money already recorded: rule 0 of the matcher
  (an event with this `processor_ref`, or this `sqsp_order_id` and amount without one) is checked before anything else, and every
  command's key is unique.
* **External refund**: a feed refund with no Oasis event on an order booked against an invoice becomes a `refund` event,
  `source = squarespace`, `status = done`, `dest = card`, `processor_state = confirmed`, `needs_review = true`, plus the
  `external_refund` alert (it bypassed Oasis limits and approvals). For an order not yet booked it is deferred and retried.
* **Variance** (B41): every confirm or record stores `{sqspTotalCents, oasisTotalCents, deltaCents, sqspTaxCents, oasisTaxCents,
  taxDeltaCents, exceedsAlert}` on `sqsp_matches` and raises `variance_exceeds_delta` past `SQSP_VARIANCE_ALERT_CENTS`. The amount
  actually paid is what the ledger records; the invoice total is never rewritten.

## The manual queue

Arrivals the matcher will not decide alone (no candidate, ambiguous, below the 0.8 threshold, possible double count, settled or
overpaid invoice) are rows in `sqsp_manual_queue` with up to three scored suggestions. `POST /integrations/squarespace/orders/:id/match`
confirms a waiting card payment (`eventId`) or records the payment on an invoice (`invoiceId`; 409 `SQSP_MATCH_DUPLICATE` when the
invoice already shows a waiting or equal card payment unless `force`); `.../ignore` takes the order out (409 once money is on an
invoice). Both use the matcher's keys, so a later poll recognises the money as recorded.

**Retry without a person.** At the counter the customer usually pays on the terminal first and the staff member records the card
payment in Oasis minutes later, so the order reaches us before the staff event exists. Each cycle re-offers queued orders
(reason `no_candidate` or `low_confidence`) to the matcher once when a staff-recorded payment waiting on Squarespace, or a new
payment link, was created after the item was queued. The fresh queue row is newer than the candidate, so it cannot loop.
`sync-now` with `rematch` re-offers the whole queue.

## Other hooks

`UnmatchedSource` (Payments reconciliation lists the queue and the transactions waiting on a person), `CardHintProvider` (the
brand of the customer's latest Squarespace card payment; no last4 exists) and the Operations `ExternalAlertSource` (alert 12:
card money awaiting Squarespace for more than **2 hours**, review B8, not the design's 24; orders in the manual queue for
managers) are implemented in `db/queries.ts` and wired in `src/http/modules.ts`.
