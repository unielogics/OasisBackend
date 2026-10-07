# 0051 Payments: limits, approvals and the settlement refund

Status: accepted (2026-10-06)

* **Limits** come from the RBAC engine (ADR 0010): the highest among the roles that grant the permission, `null` unlimited,
  no row 2500 cents. Ledger `actor_roles` are the names of those granting roles (`Management + Accounting`); the real person
  is the actor under view-as, with `view_as_role_id` recorded.
* **Refund**: `pending` exactly when the amount is strictly greater than the caller's refund limit, otherwise `done`.
  Adjust and credit over their limits are blocked with the design text and have no approval path (as designed).
* **Approve** needs `pay.refund` and a limit of at least the amount (403 `CANT_APPROVE`, titled with the design toast). The
  requester cannot approve their own request unless the approver is unlimited (no limit) or the setting `approvals.allow_self`
  is on (403 `SELF_APPROVAL`, review C7: a Super Admin viewing as a lesser role is still the same person). Refundable and
  the card cap are re-validated at approval **without** the request's own reservation, since other refunds may have been
  resolved since. The event keeps its original time; `approved_by_*`, `approved_at`, `resolved_at` are set.
* **Deny** needs `pay.refund` (the design had no check); the requester may withdraw their own request. A denied refund
  returns its amount to `refundable` and counts nowhere else.
* **Adjustment settlement** (review B27): when a discount leaves a paid invoice overpaid, the difference
  (`paid - refunded - newTotal`, capped at refundable) becomes a **normal refund event** (`reason 'Adjustment settlement'`,
  `parent_event_id` = the adjustment). Destination store credit by default or card. It follows the normal rules: pending when
  it exceeds the actor's refund limit (an actor without `pay.refund` has limit 0, so it always waits for approval), a card
  settlement is capped by what was paid by card (`REFUND_EXCEEDS_CARD`) and is `awaiting_processor` like any card refund. The
  design created it as done with no checks.
* **Refund by item** records the selected `invoice_items` ids on the event; an item in a done or pending item refund cannot be
  refunded again (422 `ITEM_ALREADY_REFUNDED`). The value is the selected lines plus tax at the invoice rate, as designed
  (tip and invoice-level discounts are not allocated).
* **Refund caps (money review).** `toOrigMax` in the calc keeps the design's meaning (every non-credit payment less every non-credit
  refund) for display, but the commands cap a refund by `originalRefundCap`: to cash, the non-credit payments less the card and
  cash refunds done or pending; to card, additionally the card and wallet payments less the card refunds done or pending. Store
  credit therefore never comes back as cash or card, a cash payment cannot be refunded "to card", and pending requests reserve
  the cap so a second request that could never be approved is refused up front. A void is refused when it would push either cap
  below zero. An approval re-validates the same caps without its own request.
