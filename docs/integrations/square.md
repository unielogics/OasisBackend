# Square integration

Status: **foundation (wave Q1b) and core (wave Q2b) built**, verified against the Square sandbox on 2026-10-12 (`pnpm verify:square`,
11 PASS with SQR-12, section 7). Off by default: nothing reaches Square until `SQUARE_PROVIDER=live`, nothing is created or changed at
Square until `SQUARE_WRITES_ENABLED=true`, and links, deposits and refunds stay on Squarespace until `PAYMENT_PROCESSOR=square`.
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
  are recorded (section 11); invoices, subscriptions, cards and customers only log until waves Q3a and Q3b. The row is closed
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
| `square.events.catchup` | every 10 minutes, live only | SearchEvents from the watermark minus 10 minutes (the first run reads the last day; never more than 28 days back), ascending, paged; each event claimed in `webhook_log` and processed. A failed event holds the watermark back so the next run tries it again; a complete run with no failure moves it to at least the run time minus 10 minutes (a quiet week is not an alert); a row the hook claimed whose job was lost (still `received` after 15 minutes) is run here. A watermark older than 27 days (runs failing or never finishing for that long) is an alert (status row and `square_state.last_error`): Square keeps events 28 days. |
| `square.reconcile` | nightly 03:45, live only | Lists the last 72 hours of payments and refunds at our location and keeps the counts (by status, source, product) in `square_state.last_reconcile`; decides every completed payment and records every completed refund the webhook and the catch-up both missed (same locks and keys). |
| `square.payments.match` | every minute | Counter payments past `SQUARE_MATCH_DELAY_SECONDS` through the matcher (section 11.2). |
| `square.links.sweep` | every minute | Cancels Square links that no longer match what is owed, gives up on pending rows, deletes canceled links at Square (writes on). |
| `square.deposit-link` | every minute, processor square, writes on | A booking's deposit request becomes a texted quick-pay link. |
| `square.refunds.submit` | every minute, processor square, writes on | Card refunds through the API: legs planned and sent (section 11.4). |

With `SQUARE_PROVIDER=sim` (the default) the catch-up and the reconcile do nothing and call nobody; the matcher finds nothing to match;
the sweep, the deposit links and the refunds find nothing (no Square link or Square refund exists before `PAYMENT_PROCESSOR=square`)
and the last two skip unless the processor is Square and writes are on.

## 6. Runbook

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
| SQR-12 | (Q2b) Oasis's own link builder (`balanceLines`: two lines, a "Sales tax" line at 6.625% and a "Tip" line) gives an order total of exactly the balance, paid through its order; a refund leg sent twice with its `rf_` key is one refund; one cent over what the payment can still give back is refused by the leg planner and by Square alike |

Scrubbed answers of the 2026-10-12 run (ids replaced, no emails, URL paths dropped) are the fixtures in `test/fixtures/square/`; the
wire schemas, the error mapping, the dispatcher and the simulator are tested against them.

## 8. Sandbox findings (2026-10-12)

The design's "check in the sandbox" list, answered:

| Question | Finding |
|---|---|
| Payment link URL hosts | Sandbox: `url` on `sandbox.square.link`, `long_url` on `connect.squareupsandbox.com`. Production hosts to confirm on the first production link; `PAYMENT_LINK_HOSTS` becomes `square.link,square.site` (plus `squareupsandbox.com` outside production). |
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

## 9. Simulator

`SQUARE_PROVIDER=sim` runs it inside the process; `pnpm sim:square` serves it on `http://127.0.0.1:4593` (token
`sim-square-access-token`, location `LSIMOASIS0001`; point the app at it with `SQUARE_PROVIDER=live SQUARE_API_BASE=…`). It answers every
call of the port the way the sandbox did (section 8): real idempotency (the same key and body answer the same result, another body is
IDEMPOTENCY_KEY_REUSED), the test nonces, refunds that settle with the clock, subscriptions that bill their first period at once and renew
with the clock, scheduled actions, the event log for SearchEvents, and signed webhook delivery (normal, duplicate, out of order). Controls
under `/__sim` (`pnpm sim:square --help`): pay a link, a POS card or cash payment, a refund in the Square app, bill a subscription (paid or
failed), card auto-update and forget, fail a refund, faults (429, 500, a dropped connection), webhook mode, clock.

## 10. What comes next

See ADR 0171, "What the later waves add": cards on file and fees (Q3a); memberships on Square (Q3b); the website and dashboard (Q3c,
Q3e); `SQSP_SYNC_MODE` (Squarespace history mode) still to build.

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
it. Link hosts: `square.link`, `square.site`, and `squareupsandbox.com` outside production (`PAYMENT_LINK_HOSTS` overrides).

### 11.4 Refunds

The refund ledger row is the outbox: a card refund on an invoice holding Square card money, written while Square is the processor,
carries `processor square`. `square.refunds.submit` plans legs (newest Square payment first, each capped), sends RefundPayment with the
leg's own key (`rf_<leg id>`, a retry answers the same refund), and `refund.*` events settle them once every leg has: all completed,
the refund is confirmed; any failed or rejected, it is `failed` (not counted), the completed part becomes its own confirmed refund
(key `square:refund-part:<event id>`) and an alert asks for the rest. Staff cannot confirm such a refund by hand. Refunds made in the
Square app are attached to the staff's waiting card refund of the amount (or one they confirmed by hand before Square's event came),
or recorded for review ("Refunded in Square").

### 11.5 POS app switch

Production only (`SQUARE_POS_API_ENABLED`, live production, an application id). Register the app's Point of Sale API callback URL
(`PUBLIC_DASHBOARD_URL/payments/square-callback`) in the Developer Dashboard first. "Open Square POS" writes the staff card entry and an
intent whose code goes in the payment note (`INV-20640 · OAS-PI-xxxxxx`); the payment is recorded on that entry by the app's callback
or by the webhook (rule R2).
