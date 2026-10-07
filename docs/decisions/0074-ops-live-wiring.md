# 0074 Operations on the real stack: pending card money, ops events for payments, the seeded design day's money, the simulator store

Status: accepted (2026-10-07). Found while running the Operations screen against a live stack (`design,parity-ops`).

* **Payment pending on the board (DV-212).** Card money staff recorded and Squarespace has not confirmed counts toward the
  balance at once (ADR 0053) but the invoice never reads "Paid" while any of it waits. `InvoiceSummary` gains `awaitingCents`
  (sum of non-voided `pay` events in `processor_state = awaiting_processor`) and `taxBp`; `payView` gains `kind: 'pending'` with
  the label `Payment pending`, or `Payment pending · $X due` while the funded amount (confirmed plus waiting) is below the total.
  It becomes `Paid` when the processor leg is confirmed. KPIs are unchanged: Pending payments is balance based, so waiting card
  money already left it; Revenue today is cash basis and already counted it.
* **Payment changes are Operations news.** Every payment command and every Squarespace match or confirmation publishes, next to
  its `payments` events, `ops appointment.updated {id, version, status, change: "payment"}` and `ops kpi.dirty` when the invoice
  belongs to an appointment (`src/modules/payments/ops-events.ts`), in the command's transaction. Before this a second browser on
  the board kept stale balances, pay pills and KPIs until something else touched the appointment.
* **The seeded design day carries its money.** `parity-ops` created appointments but no invoices and no members, so a seeded board
  showed "No invoice" everywhere, Pending payments `$0`, Revenue `$0`, no membership badge and nothing to collect. It now creates
  one invoice per design appointment through the real gateway (numbers continue from 20611), the tips and payments of
  `PARITY_OPS_MONEY` (a paid invoice is one confirmed card payment `Visa ••4421` dated this morning, a deposit one dated
  yesterday, a12 paid in advance yesterday so Revenue today stays `$1,487.48`) and runs the `memberships` profile for the design
  members. Pending payments becomes `$1,298.53` over 6 jobs, as the oracle says. The profile keeps `dependsOn: ['design']`.
* **The simulator object store is mounted.** `STORAGE_PROVIDER=fs` outside production serves `/dev-storage/*` (presigned photo POST
  with CORS for `PUBLIC_DASHBOARD_URL`, signed thumbnails and downloads with `Cross-Origin-Resource-Policy: cross-origin`).
  `createFsStorageHandler` existed and was tested but nothing mounted it, so the photo flow (presign, POST, complete, thumbnail)
  returned 404 from a running API. The routes are public (their signature is the credential) and appear in the authz matrix's
  public list.
* **Not changed, worth knowing.** Seeded customers have synthetic numbers; outside production the API texts only numbers in
  `SMS_ALLOWLIST` (so a live stack that should send must list them), and `/dev/sms/inbound` needs `ALLOW_DEV_ENDPOINTS=true`.
