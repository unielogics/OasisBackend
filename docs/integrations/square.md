# Square integration

Status: **foundation (wave Q1b), core (wave Q2b) and cards on file and fees (wave Q3a, section 12) and memberships (wave Q3b, section 13) built**, verified against the Square sandbox
on 2026-10-12 (`pnpm verify:square`, section 7). Off by default: nothing reaches Square until `SQUARE_PROVIDER=live`, nothing is
created or changed at Square until `SQUARE_WRITES_ENABLED=true` (memberships also need `SQUARE_MEMBERSHIPS_ENABLED=true`), and links,
deposits, refunds and memberships stay on Squarespace until `PAYMENT_PROCESSOR=square`.
Decision record: [ADR 0171](../decisions/0171-square-payments.md).

Square will take every payment: payment links, the booking deposit, memberships (Square subscriptions), counter payments from the
Square POS app and reader, and cards on file. Oasis keeps the invoices and the append-only ledger; Square is the processor. The
foundation (Q1b) is the plumbing (client, simulator, webhook, catch-up, status, test connection, scripts); the core (Q2b, section 11)
records Square payments and refunds in the ledger, matches counter payments, makes payment and deposit links, and refunds through the
API. Cards on file (Q3a) and memberships (Q3b) come next.

## 1. The pieces

| Piece | Where |
|---|---|
| Environment contract and its rules | `src/integrations/square/config.ts` (merged into `src/config/env.ts`) |
| Client: fetch, `Square-Version`, timeout, retries, typed errors | `src/integrations/square/client.ts`, `errors.ts` |
| Idempotency keys, money | `src/integrations/square/keys.ts`, `money.ts` |
| Wire schemas (zod, unknown fields pass) | `src/integrations/square/wire.ts` |
| One thin module per API | `src/integrations/square/api/*.ts`; the port `src/integrations/ports/square.ts` |
| Webhook signature, envelope, event types, dispatch decision | `src/integrations/square/webhook.ts` |
| Simulator (in-process and HTTP) | `src/integrations/square/sim/*`, `pnpm sim:square` |
| `/hooks/square`, routes, jobs, catch-up, reconcile, status | `src/modules/square/**` |
| Webhook subscription setup | `pnpm square:webhooks` (`scripts/square-webhooks.ts`) |
| Sandbox and production verification | `pnpm verify:square` (`scripts/verify-live/square.ts`) |
| The payment mirror, classifier, matcher and its runs (Q2b) | `src/modules/square/{facts,classify,matcher,payments,match-runner}.ts` |
| The ledger ops (record, confirm, tip, cash, reassign, external refund) | `src/modules/square/ledger.ts` (tail: `src/modules/payments/announce.ts`) |
| Payment and deposit links, the sweep | `src/modules/square/{links,deposits,public}.ts` |
| Refunds through the API, refund events | `src/modules/square/refunds.ts` |
| POS app switch | `src/modules/square/pos.ts` |
| Memberships billed by Square (Q3b): catalog sync, enrollment, billing events, failure policy, staff actions, Move members | `src/modules/memberships/square/*` (`catalog-plan.ts` pure planner, `catalog-sync.ts`, `enroll.ts`, `billing.ts`, `policy.ts`, `timeline.ts`, `actions.ts`, `moves.ts`, `notify.ts`, `jobs.ts`, `http/routes.ts`); the link routes `src/modules/public/links/http/subscribe-routes.ts` |
| The queue routes, alerts, card hint, reconciliation | `src/modules/square/http/payment-routes.ts`, `src/modules/square/db/alerts.ts` |

## 2. Environment

| Variable | Default | Meaning |
|---|---|---|
| `SQUARE_PROVIDER` | `sim` | `sim`: the in-process simulator answers (no network). `live`: Square for `SQUARE_ENVIRONMENT`, or `SQUARE_API_BASE`. |
| `SQUARE_ENVIRONMENT` | `sandbox` | `sandbox` (connect.squareupsandbox.com) or `production` (connect.squareup.com). |
| `SQUARE_APPLICATION_ID` | | From the Developer Dashboard. Not secret (the Web Payments SDK needs it in the page). |
| `SQUARE_ACCESS_TOKEN` | | **Secret.** The merchant's access token. |
| `SQUARE_LOCATION_ID` | | The shop's location. In sim mode the simulator's `LSIMOASIS0001`. |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | | **Secret.** The signature key of our webhook subscription. |
| `SQUARE_WEBHOOK_SIGNATURE_KEY_PREVIOUS` | | **Secret.** The old key during a rotation (section 6). |
| `SQUARE_WEBHOOK_URL` | | The exact URL registered with Square, `https://<domain>/hooks/square`. Every signature covers it. |
| `SQUARE_API_VERSION` | `2026-09-16` | The pinned `Square-Version`. Change it only with a reviewed upgrade and a fresh `verify:square`. |
| `SQUARE_API_BASE` | | Host override for a `pnpm sim:square` simulator. |
| `SQUARE_TIMEOUT_MS`, `SQUARE_MAX_ATTEMPTS` | `15000`, `4` | Per request. |
| `SQUARE_WRITES_ENABLED` | `false` | Observe-only when false (section 6). |
| `SQUARE_MEMBERSHIPS_ENABLED` | `false` | Memberships billed by Square (section 13): the catalog sync and joining with a card. The last stage of turning writes on; needs `SQUARE_WRITES_ENABLED`. |
| `SQUARE_POS_API_ENABLED` | `false` | The POS app switch (production only). |
| `SQUARE_MATCH_DELAY_SECONDS` | `90` | How long a counter payment waits before matching (wave Q2b). |
| `SQUARE_POS_AUTOMATCH` | `evidence` | `evidence`: counter payments are recorded only on strong evidence (plan decision 5). `amount`: also when the amount alone matches exactly one open invoice of the day (the owner's call). |
| `PAYMENT_PROCESSOR` | `squarespace` | The cutover switch. |

The contract refuses to start with: `live` and any of the token, location, application id, webhook key or webhook URL missing; production
with `PAYMENT_PROCESSOR=square` while Square is the simulator or the sandbox; `SQUARE_POS_API_ENABLED` outside live production; in
production a webhook URL other than `https://<domain>/hooks/square`; a previous webhook key without a current one.

## 3. Secrets

`SQUARE_ACCESS_TOKEN`, `SQUARE_WEBHOOK_SIGNATURE_KEY` and `SQUARE_WEBHOOK_SIGNATURE_KEY_PREVIOUS` are secret keys (`SECRET_KEYS`,
`deploy/lib/common.sh`): they live only in the Secrets Manager secret (`oasis/prod/app`), are pushed with `pnpm secrets:push`, and the
deploy templates keep them commented out. The status row shows them only as `set` / `not set`.

The **sandbox** app's credentials are in the separate secret `oasis/sandbox/square` (keys `SQUARE_ACCESS_TOKEN`,
`SQUARE_APPLICATION_ID`, `SQUARE_ENVIRONMENT`; the sandbox location is `LCEVRH6NQ775N`). `pnpm verify:square --secret oasis/sandbox/square`
reads it at run time and never prints it. Never point `OASIS_SECRET_ID` at it: it holds no `DATABASE_URL`. A staging stack copies it
into its own app secret with `pnpm secrets:push`.

## 4. Webhooks

**Endpoint** `POST /hooks/square` (nginx: `location = /hooks/square`, POST only, zone `oasis_hooks`, 1 MB).

- **Signature**: `x-square-hmacsha256-signature` = base64 HMAC-SHA256(signature key, `SQUARE_WEBHOOK_URL` + raw body). The URL comes
  from the environment, never from the request. The current key and the previous key are tried, in constant time. Anything else is
  401 and nothing is kept. With no key or URL configured (the default) every delivery is 401.
- **Merchant**: once Test connection learned our merchant id, an event of any other merchant is answered 200 and dropped. The merchant
  counts only in the Square environment it was learned in: `square_state` keeps one environment (sim, sandbox or production), is read
  only when that is the configured one, and starts afresh when a save comes from another, so a merchant, "events enabled", subscription
  or watermark learned from the simulator or the sandbox never applies to production. Run Test connection again after switching.
- **Dedupe**: the event is claimed in `webhook_log` (provider `square`, external id = `event_id`) with its body and the headers without
  the signature. A second delivery of the same event answers 200 `duplicate`. The Events API catch-up claims in the same place.
- **Answer**: `square.event.process` is queued (singleton per event id) and Square gets 200 at once. If the queue refuses, the claim is
  released and the answer is 503, so Square's retry is accepted. Without a queue (single process) the event is processed inline.
- **Processing**: the job re-fetches the object by id (payment, refund, invoice, subscription, card, customer); amounts in the payload
  are never trusted. An object of another location is ignored; the handler runs under an advisory lock per object. Payments and refunds
  are recorded (section 11); card.* and customer.* keep the saved cards in step (section 12); invoices and subscriptions drive the
  memberships billed by Square (section 13). The row is closed
  `processed` (or `ignored` with the reason in `error`).

**Event types** of our subscription (`SQUARE_EVENT_TYPES`): `payment.created`, `payment.updated`, `refund.created`, `refund.updated`,
`invoice.payment_made`, `invoice.scheduled_charge_failed`, `invoice.updated`, `invoice.canceled`, `invoice.refunded`,
`subscription.created`, `subscription.updated`, `card.created`, `card.updated`, `card.disabled`, `card.forgotten`,
`card.automatically_updated`, `customer.updated`, `customer.deleted`. All 18 exist at version 2026-09-16 (sandbox, 2026-10-12).

**Registration** (Square needs a public https URL; there is nothing to register for a stack without one). The script reads only
`SQUARE_ACCESS_TOKEN`, `SQUARE_WEBHOOK_URL`, `SQUARE_ENVIRONMENT` (and `SQUARE_API_BASE`, the API version and timeouts), never the
signature key, and always talks to Square whatever `SQUARE_PROVIDER` says. So the first `--apply` runs while the stack is still
`SQUARE_PROVIDER=sim`: the app refuses `live` until the key exists, and the key is what `--apply` prints.

```bash
# the stack still runs SQUARE_PROVIDER=sim; the token and SQUARE_WEBHOOK_URL are set
pnpm square:webhooks             # what exists for SQUARE_WEBHOOK_URL and what --apply would change
pnpm square:webhooks --apply     # creates the subscription (prints its signature key ONCE) or updates its types / version
pnpm secrets:push                # put the printed key in the secret as SQUARE_WEBHOOK_SIGNATURE_KEY
# then SQUARE_PROVIDER=live in the env file, restart
```

Then Settings, Square, **Test connection** (`POST /api/v1/integrations/square/test`) checks: the token works; the location is active, in
USD and takes cards; the Events API is enabled; our subscription exists, is enabled and carries every type. It stores the merchant id.

## 5. Jobs

| Job | When | What |
|---|---|---|
| `square.event.process` | queued by the hook | Re-fetch and dispatch one logged event (section 4). 5 retries, 30 s apart. |
| `square.events.catchup` | every 10 minutes, live only | SearchEvents from the watermark minus 10 minutes (the first run reads the last day; never more than 28 days back), ascending, paged; each event claimed in `webhook_log` and processed. A failed event holds the watermark back so a later run tries it again (once its back-off has passed, below); a complete run with no failure moves it to at least the run time minus 10 minutes (a quiet week is not an alert). From the log itself, wherever the window is: rows the hook claimed whose job was lost (still `received` after 15 minutes, up to 50 a run) and failed rows (another 50, least recently tried first, each only after its back-off: 10 minutes after its last failure, doubling with `webhook_log.attempts`, at most a day; review Q4 SQ-SEM-5-R1), so rows that keep failing never starve a lost one. A watermark older than 27 days (runs failing or never finishing for that long) is an alert (status row and `square_state.last_error`): Square keeps events 28 days. |
| `square.reconcile` | nightly 03:45, live only | Lists the last 72 hours of payments and refunds at our location and keeps the counts (by status, source, product) in `square_state.last_reconcile`; decides every completed payment and records every completed refund the webhook and the catch-up both missed (same locks and keys). |
| `square.payments.match` | every minute | Counter payments past `SQUARE_MATCH_DELAY_SECONDS` through the matcher (section 11.2). |
| `square.links.sweep` | every minute | Cancels Square links that no longer match what is owed, gives up on pending rows, deletes canceled links at Square (observe-only too: a clean-up, review Q4 M2). |
| `square.deposit-link` | every minute, processor square, writes on | A booking's deposit request becomes a texted quick-pay link. |
| `square.refunds.submit` | every minute, processor square, writes on | Card refunds through the API: legs planned and sent (section 11.4). |
| `square.charges.resolve` | every minute | Saved-card charges Square did not answer: looked up (GetPayment, or ListPayments by reference); with writes on and within 23 hours the same CreatePayment with the same key; watch-only or older, nothing is sent and a charge Square has no payment for is closed NOT_SENT (section 12.3). |
| `square.cards.nightly` | nightly 04:20 | Card links for membership cards about to expire; deleted clients' cards disabled at Square (section 12.5). |
| `square.catalog.sync` | every 5 minutes, writes on | Tier prices a save left pending become plan variations (section 13.1). |
| `square.catalog.drift` | nightly 04:20, writes on | The sync plus Square's catalog read back and compared (section 13.1). |
| `square.enrollments.resume` | every 5 minutes, writes on | Membership-page attempts resumed with the same keys, abandoned after an hour, cleaned up at Square; stale pending memberships closed; a newer saved card put on the subscription (section 13.2). |
| `membership.billing` | daily 09:30 | The failure policy: day 7 past due, day 21 canceled at Square; a client not yet told is texted (section 13.4). |
| `square.plans.swap` | daily 10:15, writes on | "Move members" whose notice has run get their SwapPlan (section 13.5). |

With `SQUARE_PROVIDER=sim` (the default) the catch-up and the reconcile do nothing and call nobody; the matcher finds nothing to match;
the sweep, the deposit links and the refunds find nothing (no Square link or Square refund exists before `PAYMENT_PROCESSOR=square`)
and the last two skip unless the processor is Square and writes are on.

## 6. Runbook

**History before the connection.** The first time Oasis reads a real Square environment it stamps `square_state.connected_at`, the
connection point: whichever comes first of the first catch-up page, the first reconcile listing, the first successful Test connection
and the first webhook (a webhook is live, so its stamp is set 10 minutes before its event). The first catch-up reads the last day of
events and the nightly reconcile the last 72 hours, so the shop's earlier POS sales are mirrored too: a counter payment made before the
stamp is kept as history (ignored, "before connection"), never in "Square payments to match" and never alerted (sandbox run F2). Later
reads keep the stamp; switching environment (sim to sandbox to production) starts it afresh; a stack already reading events before the
stamp existed gets none. Nothing to do in the setup order: set `SQUARE_PROVIDER=live`, restart, then run Test connection whenever
convenient, the history is cut either way. The simulator is never stamped by a read (only by Test connection).

**Observe-only first.** With `SQUARE_WRITES_ENABLED=false` the client refuses, before sending, every call that would create or change
something at Square (payments, refunds, links, customers, cards, catalog, subscription actions). Reads, searches and the setup calls
(EnableEvents, webhook subscriptions) still go. Run a week this way after connecting production: counter payments are mirrored and
matched while staff watch the queue (Payments, "Square payments to match"), and nothing is charged or refunded through the API (Send
link answers "Square is in watch-only mode"; the pay page falls back to asking the shop for a link).

**The queue.** A counter payment Oasis could not record on strong evidence waits there with ranked candidates: Apply (to an invoice, or
confirming its "Square reader" entry), Set aside (not an Oasis sale, a duplicate, a test), or, once matched, Move to the right invoice
(`pay.void`). More than 30 minutes waiting is a "Needs attention" alert for the managers. Ask the counter to put the invoice number
(INV-20640) in the POS note: that is recorded at once (rule R1).

**A card refund Square refused** (FAILED or REJECTED, or the Square money on the invoice cannot cover it) no longer counts as refunded;
when part of it did go back (a refund split over two payments), that part stays counted as its own refund and the alert "Card refund
failed" names only the rest. Give the rest back in cash or store credit (a new refund), or try the card refund again. A refund sent to
Square updates by itself: there is nothing to confirm by hand.

**Rotating the webhook signature key**

1. `pnpm square:webhooks --rotate-key` prints the new key once.
2. In the secret: the current key becomes `SQUARE_WEBHOOK_SIGNATURE_KEY_PREVIOUS`, the new one `SQUARE_WEBHOOK_SIGNATURE_KEY`
   (`pnpm secrets:push`), restart. Both verify during the switch.
3. After a day, remove `SQUARE_WEBHOOK_SIGNATURE_KEY_PREVIOUS` and restart.

**Rotating the access token**: create the new token in the Developer Dashboard, `pnpm secrets:push SQUARE_ACCESS_TOKEN`, restart, Test
connection, then revoke the old token. A 401 from Square shows in the status row (`lastError`) and in Test connection ("Square refused the
access token").

**Square down or slow**: GETs and keyed creates retry with backoff; the 10-minute catch-up reads whatever webhooks missed, from the
watermark. Nothing needs replaying by hand within 27 days.

**Webhook silent**: the status row warns when the catch-up found events that no webhook delivered in the last 24 hours: check the
subscription (`pnpm square:webhooks`), nginx and `/hooks/square` (401 = wrong key or URL).

**Checking a stack**: `sudo $D/verify.sh square --read-only` (production) or `pnpm verify:square --secret oasis/sandbox/square --location
LCEVRH6NQ775N` (sandbox).

## 7. Sandbox verification (`pnpm verify:square`)

```bash
AWS_PROFILE=oasis-setup pnpm verify:square --secret oasis/sandbox/square --location LCEVRH6NQ775N [--capture DIR] [--keep]
pnpm verify:square --sim                 # the same checks against the simulator
pnpm verify:square --read-only           # production: reads only (a production token is refused without it)
```

| Item | Check |
|---|---|
| SQR-01 | Token, `Square-Version 2026-09-16` and the location: active, USD, `CREDIT_CARD_PROCESSING` |
| SQR-02 | EnableEvents; all 18 event types exist for webhooks and for the Events API |
| SQR-03 | CreateCustomer (reference `verify-…`), the same key answers the same customer, SearchCustomers finds it |
| SQR-04 | CreateCard with `cnon:card-nonce-ok`; the declined nonces through CreateCard and CreatePayment |
| SQR-05 | A $1 card-on-file payment (COMPLETED), RefundPayment, polled to COMPLETED |
| SQR-06 | A payment link with order lines and a "Sales tax" line: exact total; paid through its order; deleted. A quick-pay (deposit) link too |
| SQR-07 | A subscription plan with two STATIC MONTHLY variations; CreateSubscription with the card; the first invoice PAID |
| SQR-08 | SwapPlan, Pause, Resume, Cancel (and a second cancel); a subscription without a card: is its invoice paid by CreatePayment on its order? |
| SQR-09 | SearchEvents since the run started; every event parses and goes through our dispatcher |
| SQR-10 | TestWebhookSubscription to `--webhook-url` (optional: needs a public URL and a subscription) |
| SQR-11 | Cleanup: links deleted, subscriptions canceled, card disabled, customer deleted (plan variations used by a subscription stay) |
| SQR-13 | (Q3b) Oasis's own catalog sync (planner and executor): a plan and STATIC MONTHLY variations; the same keys answer the same objects; a price edit is a new variation, the old one kept |
| SQR-14 | (Q3b) Oasis's own subscription request (`sb_` key, start today), a deliverable email, the first invoice paid and its period; swap, pause and cancel scheduled at the next billing date and undone; CancelInvoice of an unpaid invoice |
| SQR-12 | (Q2b) Oasis's own link builder (`balanceLines`: two lines, a "Sales tax" line at 6.625% and a "Tip" line) gives an order total of exactly the balance, paid through its order; a refund leg sent twice with its `rf_` key is one refund; one cent over what the payment can still give back is refused by the leg planner and by Square alike |

Scrubbed answers of the 2026-10-12 run (ids replaced, no emails, URL paths dropped) are the fixtures in `test/fixtures/square/`; the
wire schemas, the error mapping, the dispatcher and the simulator are tested against them.

## 8. Sandbox findings (2026-10-12)

The design's "check in the sandbox" list, answered:

| Question | Finding |
|---|---|
| Payment link URL hosts | Sandbox: `url` on `sandbox.square.link`, `long_url` on `connect.squareupsandbox.com`. Production hosts to confirm on the first production link; the defaults are the exact hosts `=square.link,=checkout.square.site` (plus `=sandbox.square.link` and `squareupsandbox.com` outside production; review Q4 SEC-3: never `square.site` as a whole). |
| Paying a link through its order | The link's order is **DRAFT**; `CreatePayment(order_id)` answers 400 "The order must be OPEN to be paid." until it is opened (UpdateOrder `state OPEN`, as Square's checkout does). Then the payment completes with `order_id` set; the order stays OPEN (its DIGITAL fulfillment is PROPOSED); the link stays retrievable; DeletePaymentLink still succeeds. The order total is exactly the lines (a "Sales tax" line item, not a Square tax). |
| Apple Pay / wallet `source_type` | Not producible through the sandbox API. A card nonce pays as `CARD`, entry `KEYED`; a saved card as `CARD`, entry `ON_FILE`. Per Square's documentation Apple Pay and Google Pay arrive as `CARD` and Cash App Pay as `WALLET`: `method_kind` maps CARD to card, CASH to cash, anything else to other. Confirm on the first production wallet payment. |
| Does CreatePayment on a subscription invoice's order mark it paid? | **No**: 403 FORBIDDEN "The order … is owned by another application." The invoice is paid by Square's own retry, by the client from its `public_url`, or after a card update on the subscription. The design's day-3 retry is dropped (ADR 0171 D10). |
| How fast is the first subscription invoice charged? | Within seconds: ACTIVE at once, the invoice listed and already PAID about 10 to 12 s after CreateSubscription. `charged_through_date` is a month after `start_date`. |
| SwapPlan timing | A `SWAP_PLAN` action dated the next billing date (`charged_through_date`); the plan changes then. Pause likewise (a `PAUSE` action, status ACTIVE until then); Resume of a scheduled pause is refused (INVALID_DATE: undo it with DeleteSubscriptionAction; billing-anchor actions cannot be deleted); Cancel sets `canceled_date` to the period end, status ACTIVE until then; a second Cancel is 400 BAD_REQUEST "already has a pending cancel date" (the client treats it as done). |
| Events API in the sandbox | Available: EnableEvents, ListEventTypes (153 types), SearchEvents with type and time filters. It also returns `order.*` and `catalog.version.updated` (no `data.id`), which the dispatcher ignores. |
| Card declines | CreateCard answers every declined nonce with 400 INVALID_CARD_DATA (category INVALID_REQUEST_ERROR); CreatePayment gives the specific PAYMENT_METHOD_ERROR code (GENERIC_DECLINE, CVV_FAILURE, ADDRESS_VERIFICATION_FAILURE, INVALID_EXPIRATION) and the FAILED payment. |
| Subscriptions DEACTIVATED | A customer email Square cannot deliver to (`…@example.com`) makes the subscription DEACTIVATED within seconds, with or without a card, and no invoice is created. Enrollment needs a real email. |
| Refund timing | PENDING at once, COMPLETED about 4.5 s later. |
| Catalog cleanup | A plan variation used by a subscription (even canceled) cannot be deleted (400 BAD_REQUEST). |
| Not answerable here | 3-D Secure under `Cross-Origin-Opener-Policy: same-origin` (needs the Web Payments SDK on a page, wave Q3a); the POS note field (production only). |
| (Q3b) The same swap after its undo | DeleteSubscriptionAction on a scheduled SWAP_PLAN, then SwapPlan to the same variation: 500 "Subscription … is locked and is not billable" (still after 6 minutes); after it every DeleteSubscriptionAction of that subscription answers 409 "Unable to lock subscription" (new Pause and Cancel are still accepted). A swap to another variation after the delete is accepted. Oasis never sends the undone swap again in the billing period. |
| (Q3b) A change right after another | 409 CONFLICT "Unable to lock subscription" while an earlier change is still being made: sent again after a short wait. |
| (Q3b) CancelInvoice | An UNPAID invoice of a subscription without a card: CANCELED. Again: 400 "Can only cancel an unpaid or scheduled invoice" (the same answer as for a paid invoice). |
| (Q3b) A swap before the first payment | Applied at once (no action, the plan changes now); after it, at the next billing date. |
| (Q3b) The sandbox location's time zone | UTC (the shop's is America/New_York): Oasis sends the shop's own zone with every subscription (`timezone`, `start_date`) and computes periods in it. |

## 9. Simulator

`SQUARE_PROVIDER=sim` runs it inside the process; `pnpm sim:square` serves it on `http://127.0.0.1:4593` (token
`sim-square-access-token`, location `LSIMOASIS0001`; point the app at it with `SQUARE_PROVIDER=live SQUARE_API_BASE=…`). It answers every
call of the port the way the sandbox did (section 8): real idempotency (the same key and body answer the same result, another body is
IDEMPOTENCY_KEY_REUSED), the test nonces, refunds that settle with the clock, subscriptions that bill their first period at once and renew
with the clock, scheduled actions, the event log for SearchEvents, and signed webhook delivery (normal, duplicate, out of order). Controls
under `/__sim` (`pnpm sim:square --help`): pay a link, a POS card or cash payment, a refund in the Square app, bill a subscription (paid or
failed), card auto-update and forget, fail a refund, faults (429, 500, a dropped connection), webhook mode, clock.

## 10. What comes next

See ADR 0171, "What the later waves add": cards on file and fees (Q3a, built: section 12); memberships on Square (Q3b, built:
section 13); the website and dashboard (Q3c, Q3e); `SQSP_SYNC_MODE` (Squarespace history mode) still to build. Their shared
foundation is built (ADR 0171, "The cards
foundation"): the client's Square customer (`cu_<client id>`, found again by `reference_id` after a crash), saving a card (`cd_<attempt>`)
with the client's versioned consent, removing it (DisableCard), and the card link kind `card` (`#/k`).

## 11. The core (wave Q2b)

### 11.1 The ledger

`ledger_events.processor` (`squarespace|square`) names who took the card money and `processor_order_id` its Square order; a Square
payment is a `pay` with source and processor `square`, `processor_state confirmed`, `processor_ref` the payment id, labelled
`Visa ••4242` (or `Cash`, or `Square` for a wallet), its tip a second `pay` "Tip" that also raises the invoice's tip (the balance does
not move). `SquareLedgerOps` (`src/modules/square/ledger.ts`) does every write under the invoice lock, re-checks under it, and never
writes a second live `pay` of one Square payment whatever key it comes with. A card refund the processor reported `failed` no longer
counts as refunded (`invoice_calc_of`, `calc.ts`, `jobs-integrity.ts`; the dashboard's `cents.ts` follows).

### 11.2 Counter payments (the POS app and reader)

Mirrored in `square_payments` and classified (link, charge, membership, POS intent, counter). Counter payments wait
`SQUARE_MATCH_DELAY_SECONDS`, then: R1 the invoice number in the note; R2 a POS intent; R3 one staff "Square reader" entry of the
amount (tip excluded; that entry is confirmed and filled with the card); R4 one open invoice of the day of that balance, backed by the
payer's identity; R4a amount alone only with `SQUARE_POS_AUTOMATCH=amount`; otherwise the queue (R5). Cash taken in the POS app of the
amount of a staff cash entry only takes its references. Every path (webhook, catch-up, reconcile, the matching job, a POS callback, a
person) takes the advisory lock `square:payment:<id>` first: a payment is recorded at most once, on one invoice.

### 11.3 Links and the deposit

A Square link is made at click time for exactly what is owed (asserted): an untouched invoice's lines plus "Sales tax" and "Tip"
lines, else one "Balance due" line; a deposit is a quick-pay link. Staff "Send link" texts the client's personal pay page while
`PUBLIC_LINKS_ENABLED` (the page makes the link when they pay), else the `square.link` URL. The row is written `pending` before the
Square call and made `active` by the command; older links of the purpose are superseded; `square.links.sweep` cancels and deletes
what no longer matches. The booking fee is a deposit toward the visit (ADR 0150): with the fee collected by link, every online booking
asks for a deposit link (a pending row) and `square.deposit-link` makes and texts it; the calendar page's "Pay the deposit now" opens
it. Link hosts: exactly `square.link` and `checkout.square.site`, and the sandbox's outside production (`PAYMENT_LINK_HOSTS` overrides;
`=host` is an exact host; a sandbox host never passes in production).

### 11.4 Refunds

The refund ledger row is the outbox: a card refund on an invoice holding Square card money, written while Square is the processor,
carries `processor square`. `square.refunds.submit` plans legs (newest Square payment first, each capped), sends RefundPayment with the
leg's own key (`rf_<leg id>`, a retry answers the same refund), and `refund.*` events settle them once every leg has: all completed,
the refund is confirmed; any failed or rejected, it is `failed` (not counted), the completed part becomes its own confirmed refund
(key `square:refund-part:<event id>`) and an alert asks for the rest. Staff cannot confirm such a refund by hand, from the moment it
is recorded (the job will send it: its waiting alert offers Review); in observe-only mode nothing is sent and staff still confirm it.
The Squarespace matcher never confirms it either. The completed part keeps the original's items, so they stay refunded: the rest goes
back as an amount (refunding the items again would give their whole price back a second time). Refunds made in the Square app are
attached to the staff's waiting card refund of the amount (or one they confirmed by hand before Square's event came, only on an
invoice whose card money is all Square's), or recorded for review ("Refunded in Square").

### 11.5 POS app switch

Production only (`SQUARE_POS_API_ENABLED`, live production, an application id). Register the app's Point of Sale API callback URL
(`PUBLIC_DASHBOARD_URL/payments/square-callback`) in the Developer Dashboard first. "Open Square POS" writes the staff card entry and an
intent whose code goes in the payment note (`INV-20640 · OAS-PI-xxxxxx`); the payment is recorded on that entry by the app's callback
or by the webhook (rule R2).

## 12. Cards on file and fees (wave Q3a)

Everything here needs `PAYMENT_PROCESSOR=square` and `SQUARE_WRITES_ENABLED=true`; the card page also needs
`PUBLIC_LINKS_ENABLED=true`. With the defaults no card is saved or charged and no fee is proposed.

### 12.1 The card page (`#/k`)

Staff text a card link from the client file (`POST /customers/:id/card-link`, template `personal_link_card`, 24 hours, 3 cards). The
page needs a fresh PIN or code (5 minutes) and the client proven; it loads Square's Web Payments SDK (the settings come in
`LinkState.cardSetup`: application id, location id, SDK URL, and the consent wording) and posts the one-time token with the consent
(`POST /public/links/cards`, Idempotency-Key). Limits: 10 an hour per address, 5 a day per number, 3 per page; 3 declined cards a day
lock the number for the day (`CARD_SAVE_LOCKED`; card testing). The page lists the client's active cards (`LinkState.cards`) and removes
one (`DELETE /public/links/cards/:cardId`: DisableCard at Square, consents revoked).

**CSP.** The website's default policy (`install.sh`) lets the SDK in: `script-src`, `style-src` and `frame-src`
`https://web.squarecdn.com`, `connect-src` `https://web.squarecdn.com https://pci-connect.squareup.com https://o160250.ingest.sentry.io`,
`font-src` `https://square-fonts-production-f.squarecdn.com https://d1g145x70srn7h.cloudfront.net`. `--square-env sandbox` uses
`https://sandbox.web.squarecdn.com` and `https://pci-connect.squareupsandbox.com` instead (a staging site against the sandbox).
`Permissions-Policy: payment=()` stays: cards only (no Apple Pay or Google Pay through the browser). 3-D Secure under
`Cross-Origin-Opener-Policy: same-origin` is still to confirm with the SDK on a sandbox page (site package).

### 12.2 Consent

The box starts unchecked. The client ticks what the card may be charged for (membership billing, a no-show fee, a late-cancel fee, a
balance); the wording is versioned (`v1`), and each consent stores the version, the SHA-256 and the text shown, the time, the address,
the browser, the link and the page. A page that showed an older wording gets 409 `CARD_CONSENT_OUTDATED` (reload). Removing a card
revokes its consents; nothing is ever deleted.

### 12.3 Charging a saved card

Only after a staff member confirms (plan decision 6):

* **A balance**, with the client's OK: `POST /invoices/:id/card-charges {cardId, amountCents}` (pay.collect). The card's consent must
  cover `balance`; one charge at a time per invoice; at most the balance.
* **A fee** the cancel or no-show proposed: `POST /appointments/:id/fee-charges/:chargeId/charge` (pay.collect), or `…/waive` with a
  reason.

CreatePayment (`source_id` the card, `customer_id` its Square customer, `autocomplete`, `reference_id` the charge id, a note
`INV-20640 · No-show fee`) is sent in the idempotency `prepare` hook, never while the invoice is locked, with the key `ch_<charge id>`
(`ch_<charge id:attempt>` for a new attempt after a decline). The payment is recorded through `SquareLedgerOps` (rule `charge`, the
ledger reason "Balance" / "No-show fee" / "Late-cancel fee", in the name of the staff member who confirmed it). A decline answers 422
`CARD_DECLINED` with the plain reason and keeps the charge `declined`. The same balance request sent again after a decline is a new
attempt on that charge, checked like a new charge first (the invoice not canceled, the amount still within the balance, no other
charge waiting for Square), so a card is never charged for money no longer owed. No answer leaves it `unknown` (202): `square.charges.resolve`
looks the payment up (GetPayment when the payment id is known, otherwise ListPayments by `reference_id`) and, within 23 hours and with
writes on, sends the same request with the same key (Square answers the payment it made, or makes it once). Watch-only (the rollback
lever) or past the 23 hours, nothing is sent: a charge Square has no payment for 15 minutes after its last request is closed `declined`
(NOT_SENT, "Nothing was charged: Square has no payment for it."), so it never blocks its invoice for good (review Q4 H1-R1). After 10
minutes without an answer staff see the alert "Saved-card charge not confirmed"; when the Square dashboard has no such payment they
press **Not charged** (`POST /invoices/:id/card-charges/:chargeId/not-charged`, pay.collect, audited `card.charge_not_charged`): the
same read-only look-up at once, which records the payment instead if Square has it. The webhook of the payment finds the charge by its
`reference_id` (a declined one too) and records it the same way, so whichever comes first records it.

### 12.4 Fees

Setting `fees.card_on_file {enabled, noShowCents, lateCancelCents}` (`GET/PUT /settings/card-fees`, set.billing), off by default. A
no-show, or a cancel inside the free-cancellation window, proposes the fee BEYOND the deposit kept (a $40 fee with a $25 deposit kept
proposes $15) on the client's newest card whose consent covers that fee; the cancel and no-show answers carry it as
`settlement.cardFee`, and an activity line says "No-show fee proposed · $15.00 on Visa ••4242 (charge or waive it)". A staff refund of
the deposit proposes none. Charged, the fee is a payment on the canceled invoice (status canceled, kept) and the client is texted
`card_fee_charged` ("Oasis Auto Spa charged $15.00 to your saved Visa ending in 4242 for the no-show fee. ..."). Reopening the visit
waives an open fee.

### 12.5 Card lifecycle

`card.automatically_updated` / `card.updated`: the new expiry and last 4 are copied onto the card. `card.disabled` / `card.forgotten`
(also a card Square no longer has): the card is closed and its consents revoked; when it paid a membership the managers get a notice
and the client a card link ("Your saved Visa ending in 4242 can no longer be charged for your membership. ..."). `customer.deleted`:
the Square customer's cards are closed and the link removed (the next save makes a new Square customer, with a new key). A card Oasis
did not save is ignored (it has no consent, so it is never charged). Nightly, a card paying a membership that expires within 30 days
gets a card link texted (once per expiry), and the cards of a deleted client are disabled at Square.

## 13. Memberships billed by Square (wave Q3b)

Everything below needs `SQUARE_WRITES_ENABLED=true`; the catalog sync and enrollment also `SQUARE_MEMBERSHIPS_ENABLED=true` (so links,
deposits and refunds can write to Square first), enrollment also `PAYMENT_PROCESSOR=square` and `PUBLIC_LINKS_ENABLED=true` (the `#/m`
page). Square memberships that already exist keep being billed, cleaned up and changed by staff whatever `SQUARE_MEMBERSHIPS_ENABLED`
says. With the defaults no job does anything and no membership is billed by Square.

### 13.1 The catalog

`membership_tier_prices` (append-only, ADR 0170) is the plan-variation history: one SUBSCRIPTION_PLAN per tier
(`membership_plans.square_plan_id`, named after the tier) and one SUBSCRIPTION_PLAN_VARIATION per current price row ("Gold · Compact
car", one MONTHLY phase with a STATIC price). The pure planner (`catalog-plan.ts`) decides; the executor sends one call at a time with a
key derived from our row and its content (`ct_`), so a run that stopped after Square answered gets the same object back. A price edit is
a new row, so a new variation: members keep theirs (grandfathered, plan decision 8). A variation is never changed in place, and never
deleted while a membership or an enrollment names its row; a superseded price nobody used is retired (deleted at Square; when Square
keeps it, because a subscription used it, the reason stays on the row and it is not tried again). The nightly drift check reads
Square's plans back: a price changed at Square, or a variation deleted there while members use it, marks the row `failed` with the
reason and tells the managers (nothing is overwritten); a deleted variation nobody uses is made again; a tier renamed in Oasis renames
its plan. Settings shows each price's `squareState`; "Sync to Square" is `POST /api/v1/integrations/square/catalog/sync`. A failure
tells the managers once per set of failures (`square.catalog_sync_failed`), again a day later while it lasts, not on every 5-minute
retry.

### 13.2 Joining on the `#/m` page

The page shows the tier's prices by size (`plan.prices`, `joinable` once synced) and, with `plan.billing: square`, takes the size, the
email Square bills to, the card (Square's Web Payments SDK in the page) and the consent. `POST /public/links/membership/subscribe`:
the page's guards (fresh PIN or code, the client proven, no PIN-reset hold), the household rule (no live membership held or shared), a
synced price at the size, a deliverable-looking email (example and test domains refused: Square deactivated the subscription of an
`example.com` customer within seconds, section 8), the current consent wording; then the client's Square customer (with the email),
the card (`cd_<enrollment>`, consent `membership_billing`) and the subscription (`sb_<enrollment>`, `start_date` today in the shop's
time zone). The membership is `pending` until Square's first invoice is paid (about 10 s in the sandbox), then `active`. The attempt is
a state machine in `square_enrollments` (started, customer_ready, card_saved, subscribed, active; failed or abandoned):
`square.enrollments.resume` repeats a step after a lost answer with the same key (only from `card_saved` on: the card's one-time token
is never stored), reads a late first invoice back, abandons an attempt older than an hour (a subscribed one is read back once more
first, and kept while Square does not answer), and cleans up what a failed one left at Square (CancelSubscription, CancelInvoice,
DisableCard with reason `membership_failed`). Each subscription has a membership of its own: a retry on the same page reuses the
pending membership only if no earlier attempt left anything at Square; otherwise that one is closed (`canceled`, the cleanup still
runs) and the retry starts a new one. The cleanup never cancels a membership a newer attempt is using. A first payment Square could not take ends the
attempt the same way and texts the client a new membership page. A website join (`POST /public/memberships`) with Square as the
processor texts the client their membership page.

### 13.3 Billing by events

`invoice.*` and `subscription.*` events (re-fetched; an invoice with its subscription, read before the transaction) drive the
membership (`billing.ts`): a PAID invoice applies its cycle once (`square_subscription_invoices.applied_at`): the period from the due
date to the subscription's `charged_through_date` in shop-local midnights, the membership active, any failure cleared, the cycle's
credits granted (`grantCycleCredits`, once per cycle however often the events arrive). PAUSED is `paused`; CANCELED and DEACTIVATED are
`canceled`; scheduled actions show as `billing.cancelAt`, `billing.pauseAt`; a plan swap that took effect moves the membership to the
price row of its new variation. The payment of a subscription invoice is a `membership` payment in the mirror (ignored by the counter
matcher; Square sends `payment.*` before `invoice.payment_made`, and the counter delay covers the gap). When the invoice event is later
than the delay, a card-on-file payment of a client with a Square membership is not auto-matched: it waits in the payments queue
(`unmatched`) and the invoice event takes it out as a membership payment. `syncMemberships` (Squarespace)
skips Square memberships.

### 13.4 A failed renewal (plan decision 7)

| Day | What happens |
|---|---|
| 0 | `invoice.scheduled_charge_failed`: `billing_status failed`, in grace (perks on); the client texted their card page (personal link `card`) and Square's invoice page, emailed Square's page; the managers told. |
| 7 | `membership.billing`: `past_due` (perks off: the memberships port reads only active memberships). |
| 21 | CancelSubscription and CancelInvoice at Square; the membership `canceled`, `cancel_reason payment_failed`; the managers told. |

The days are the setting `memberships.billing_policy` (`{graceDays: 7, cancelDays: 21}`), counted in shop-local calendar days. A
payment at any point (Square's own retry, the client paying Square's invoice page, Square retrying after the card on the subscription
changed) restores the membership. Oasis never retries the charge itself: CreatePayment cannot pay a subscription invoice's order
(section 8). A card the client saves on the card page for membership billing is put on the subscription by `square.enrollments.resume`
(UpdateSubscription `card_id`).

### 13.5 Staff actions and price moves

`POST /api/v1/memberships/:id/billing/{pause, resume, cancel, cancel/undo, change, change/undo, card-link, refund-last}` (api-spec
30.11). Refund last payment keeps Square's `refund_status` (`refund.*` events); a refund Square fails or rejects is cleared (nothing was
refunded), the managers are told (`membership.refund_failed`), and a new try uses a new key. SwapPlan, Pause and Cancel take effect at the next billing date (section 8); undo removes the scheduled action
(DeleteSubscriptionAction); a paused membership resumes at once. A patch of a Square membership changes only auto-apply and the note.
"Move members" (`POST /api/v1/catalog/tiers/:key/move-members {notice}`) tells every member billed at an older price of their size (text
and email, `notice` days, default 30) and schedules the move; `square.plans.swap` then sends SwapPlan (per subscription: BulkSwapPlan
would also move anyone Oasis did not notify), and Square swaps at the next billing date.

### 13.6 Rollout

1. `SQUARE_MEMBERSHIPS_ENABLED=true` with writes on (catalog sync and memberships are the last stage of ADR 0171's rollout): the sync makes every priced tier's plan and
   variations; check Settings shows them synced and `pnpm verify:square` SQR-13/SQR-14 pass against the sandbox.
2. `PAYMENT_PROCESSOR=square` with personal links open: `#/m` pages join with a card; staff use the billing actions.
3. Watch the managers' notifications (`square.catalog_sync_failed`, `membership.payment_failed`, `membership.first_payment_failed`,
   `membership.canceled_unpaid`) and the status row's `pendingEnrollments`.
