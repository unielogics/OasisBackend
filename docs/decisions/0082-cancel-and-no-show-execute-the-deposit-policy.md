# 0082 Cancel and no-show execute the deposit policy

Status: accepted (2026-10-07). Closes gap 1 of the b6 list. Builds on ADR 0042 (lifecycle), 0051 (limits), 0053 (card money), 0054 (invoice lifecycle).

Before: `POST /appointments/:id/cancel` canceled the invoice and only *recorded* `deposit: keep | refund_card | refund_credit`; the
invoice kept the money and nobody was told. No-show canceled the invoice and left the deposit untouched.

* **The policy is a setting**, `cancellation.policy` in the settings registry, edited at `GET/PUT /settings/cancellation-policy`
  (read: any signed-in user; write: `set.hours`, optimistic `version`, audited). Defaults: `freeCancelHours 24`,
  `lateRetainBp 10000` (all kept inside the window), `noShowRetainBp 10000`, `refundTo original`. Cancelling at least
  `freeCancelHours` before the start (lead time = start minus the clock, floor of whole hours) refunds the held money in full;
  later, or after the start, `lateRetainBp` of it is kept (half-up, in basis points, so 5000 keeps half and refunds half); a
  no-show keeps `noShowRetainBp`. `refundTo` is the original tender (card back to the card, cash as cash) or store credit.
* **"Held" is the invoice's refundable amount**: payments less done refunds less refunds already waiting for approval. A job with
  nothing held settles to nothing and logs no deposit line. The refund to the original tender is capped by `to_orig_max`; any
  remainder (money that was store credit) goes back to store credit as a second event.
* **Execution is the payments command layer** (`PaymentsService.refund`), in the cancel transaction, in
  `src/modules/scheduling/settlement.ts`. A *policy* refund is a **system** event (`source = system`, `actor_roles = "Cancellation
  policy"`, reason "Cancellation policy" / "No-show policy", note = the rule sentence): it needs no `pay.refund` and is exempt from
  the actor's refund limit, because the published rule decided it, not the person; the real actor still owns it for audit. A card
  refund is `awaiting_processor` (Squarespace completes it, ADR 0053). Ledger keys are `<user>:<kind>:<appointment>:v<version>:<part>`,
  so a retry of the same cancel writes nothing twice; the HTTP Idempotency-Key still replays the stored response.
* **`deposit` in the request** (default `policy`) is the staff override: `keep` retains everything whatever the policy says
  (recorded "Deposit kept by staff"); `refund_card` / `refund_credit` refund the whole held amount as the **caller's own** refund:
  `pay.refund` is checked before anything changes (403 `required: ["pay.refund"]`) and a refund over their limit becomes
  `pending` (the invoice shows "Refund pending"), as backend design 4.1 specifies for a manual choice. The override is
  discretionary, so it keeps the human's rights; the policy is not, so it does not need them.
* **State and log.** The invoice ends `canceled_refunded` (everything refunded), `canceled_kept` (anything kept, including a
  partial) or `canceled` (nothing held). The activity log gets `Appointment canceled · reason`, then `Deposit refunded · $25.00 to
  the card (awaiting Squarespace)` / `... in cash` / `... to store credit` / `Deposit refund requested ... (needs approval)` per
  refund, then `Deposit kept · $X (cancellation policy | no-show policy | set by staff)`. The response carries `settlement
  {policy, heldCents, refundedCents, retainedCents, refunds[], rule}`; `depositPolicy` echoes the request.
* **The cancellation SMS** (`notify: true`) is still free text through the queue, now with the money outcome ("Your $25.00 deposit
  is being refunded to your card.", "... is kept under our cancellation policy.", "$12.50 of your $25.01 deposit is being refunded
  to your card; $12.51 is kept ..."), deduped per cancel (`cancel:<appointment>:v<version>`). A no-show still sends nothing.
* **Wiring.** `SchedulingPorts.deposits` (a `DepositSettlement`) is optional: `resolvePorts` installs the database one, an
  in-memory test setup without it only records the choice (the previous behaviour), and a database without that invoice (the
  in-memory gateway) settles to nothing. The settings registry gained one key.
* **Reopen.** The real payments gateway never revived a canceled invoice (only the in-memory one did), so a reopened job kept a
  canceled invoice with balance 0 and would never have been charged. `reopen` now revives it (`payments.invoice_reopened`, SSE
  `invoice.updated`), so a kept deposit counts again. When a refund was issued (done or pending) the reopen is refused with 409
  `REOPEN_REFUNDED` ("The deposit was refunded. Book a new appointment instead"): the ledger's balance is total minus payments,
  refunds do not reopen it, so the job would be undercharged by the refunded amount.
* **Known limit.** The held-money split does not remember which tender paid which part of a mixed (card plus cash) deposit: the
  refund goes to the card when any card payment exists.
* Tests: `test/scheduling-gaps/cancel-policy.test.ts` (18, real Postgres, real app).
