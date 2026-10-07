# Squarespace integration (read side)

Status: built and tested against a simulator and hand-built fixtures; **not yet run against a live site** (see the
checklist at the end). Decision record: [ADR 0003](../decisions/0003-squarespace-boundary.md).

Squarespace stays the card processor. Oasis owns invoices and the append-only ledger and **reads** Squarespace (orders,
transactions, contacts) to confirm and reconcile what staff recorded. SMS (including payment-link texts) goes through
SMS Gate on the tablet over Tailscale and is independent of this module.

## 1. Verified contract

Verified on **2026-10-06** against https://developers.squarespace.com/commerce-apis (rendered pages and the `.md`
variants of the guides): overview, authentication-and-permissions, making-requests, rate-limits, versioning,
responses-error-handling, orders-overview, orders, transactions-overview, transactions, contacts-overview, contacts,
webhook-subscriptions-overview, webhooksubscriptions, webhooks/overview, webhooks/verifying-notifications,
webhooks/notification-delivery, webhooks/events/order-create, order-update, oauth, glossary, faq, changelog, `~schemas`.

### Transport

| Item | Verified fact |
|---|---|
| Base URL | `https://api.squarespace.com/{api-version}/{resource-path}`. HTTP is rejected. |
| Versions per resource | Orders `1.0`, Transactions `1.0`, Webhook Subscriptions `1.0`, Contacts `v1`, Profiles `1.0` (maintenance mode), Products `v2`. Since 2025 versions are integers and additive changes do not bump the version: ignore unknown fields. |
| Required headers | `Authorization: Bearer <API key or OAuth token>` and `User-Agent`. "Requests without a User-Agent header are rejected"; default client UAs (curl/...) may be rate limited harder. `Content-Type: application/json` only for bodies. `Accept` is optional. |
| Responses | JSON only. Documented fields are always present but may be `null`; arrays may be `null` or `[]`. Errors: `{type, subtype, message, details(always null), contextId}`. |
| Status codes | 400 bad request, 401 bad/expired token, 402 the site that owns the token is expired, 403 insufficient permission, 404, 409, 429, 5xx (retry with exponential backoff, report `contextId`). |
| Rate limit | **300 requests per minute per site** (about 5/s). Over the limit: `429` with a **one-minute cool down**. Create Order has a separate 100/hour limit with API keys (unused here). The old review note of "300/hour" was wrong. |
| Pagination | List responses carry `pagination: {hasNextPage, nextPageCursor, nextPageUrl}`. Orders and Transactions return at most **50** per page; Contacts `pageSize` 1..1000 (default 50). Cursors are "dynamic": not a snapshot, so the collection can shift while paging. |

### Orders (`GET /1.0/commerce/orders`, `GET /1.0/commerce/orders/{id}`)

- Query: `modifiedAfter` and `modifiedBefore` (ISO 8601 UTC `YYYY-MM-DDThh:mm:ss.sZ`) are **required together**; `cursor`
  "cannot be used with other parameters"; also `customerId`, `fulfillmentStatus`, and `paymentStates`.
- `paymentStates` (comma list of `NOT_CHARGED, AUTHORIZED, PAID, PARTIALLY_PAID, PENDING, FAILED, REFUND_PENDING,
  REFUNDED, REFUND_FAILED`) **defaults to `NOT_CHARGED,AUTHORIZED,PAID,REFUNDED`**, which hides payment-plan, pending,
  failed and refund-in-flight orders. The client always sends all nine.
- Order fields used: `id`, `orderNumber`, `createdOn`, `modifiedOn`, `channel` (`web`|`pos`), `testmode` (boolean, "test
  order created using a payment method in test mode"), `customerEmail`, `customerId` (equals the Contacts API contact
  id), `paymentState`, `fulfillmentStatus`, `billingAddress.{firstName,lastName,phone}`, `lineItems[]` (`productId`,
  `productName`, `sku`, `variantId`, `quantity`, `unitPricePaid{currency,value}`, `lineItemType`), `subtotal`,
  `shippingTotal`, `discountTotal`, `taxTotal`, `refundedTotal`, `grandTotal` (`{currency, value}` with a **decimal**
  `value`, e.g. 49.99; converted to integer cents with rounding), `priceTaxInterpretation` (`EXCLUSIVE|INCLUSIVE`).
  Results are "ordered by modification date"; the direction is not documented, so nothing relies on it.
- Order `paymentState` was added 2026-05-08 and is "the canonical source for an order's payment status". `REFUNDED`
  means any refund activity, full or partial: compare `refundedTotal` with `grandTotal`.
- **Payment plans** (2026-05-26): one Order whose `paymentState` is `PARTIALLY_PAID` from the deposit until all
  installments are collected; the Transactions document gains one payment per collected installment.
- For recurring subscription orders `customerEmail` and the addresses are "the customer's current" values.

### Transactions (`GET /1.0/commerce/transactions[/{documentIds}]`)

- One **Document per order or donation** (1:1), at most 50 per page, `modifiedAfter`, `modifiedBefore`, `cursor`,
  and (2026-04-15) `orderId`. Documents without `salesOrderId` are donations.
- `payments[]`: `id`, `amount`, `paidOn`, `provider` (`SQUARESPACE|STRIPE|PAYPAL|SQUARE`), `creditCardType`
  (**brand enum only**: `VISA, MASTERCARD, DISCOVER, AMEX, JCB, OTHER`, null when the gateway has none), `giftCardId`,
  `externalTransactionId`, `externalTransactionProperties[]` (gateway key/values), `refundedAmount`, `refunds[]`
  (`id`, `amount`, `refundedOn`, `externalTransactionId`), `processingFees[]`. **No last4, no wallet (Apple Pay) field.**
  The sample response also shows document-level `provider`, `refunds`, `refundedAmount`; the mapper reads both shapes.
- Document: `id`, `createdOn`, `modifiedOn`, `customerEmail` (may be null for point of sale), `voided` ("order
  cancellation"), `total*` fields, `paymentGatewayError`.
- "Not available: refunds initiated outside of Squarespace, e.g. via Stripe". Only refunds made through Squarespace appear.
- The client flattens each Document into `SqspTransaction` rows: one per payment, one per refund (refunds carry
  `paymentId`).

### Contacts (`GET /v1/contacts`)

- The Profiles API is in maintenance mode; Contacts is the replacement and supports **API keys since 2026-06-17**
  (key scope `CONTACT_READONLY`). Contact `id` = order `customerId` = profile id.
- `primaryEmail.email`, `firstName`, `lastName`, `defaultShippingAddress.address.phoneNumber` (the only phone on a contact).
  No modified filter: the list is read in full (cursor paging).

### Webhooks

- Webhook Subscriptions API (`/1.0/webhook_subscriptions`, list/create/get/update/delete,
  `.../{id}/actions/rotateSecret`, `.../{id}/actions/sendTestNotification`) is **OAuth only; API keys are not supported**.
  Topics: `order.create`, `order.update`, `extension.uninstall`, `contact.*`, `address.*`. **No transaction topic.**
  Order topics need OAuth scope `website.orders` or `website.orders.read`. The endpoint must be HTTPS.
- Notification: `POST` with `User-Agent: Squarespace/1.0`, `Content-Type: application/json`, header
  **`Squarespace-Signature`**, body `{id, websiteId, subscriptionId, topic, createdOn, data}`. `order.create` data is
  `{orderId}`; `order.update` adds `update` (`FULFILLED|REFUNDED|CANCELED|MARKED_PENDING|EMAIL_UPDATED`).
- **Signature** = hex `HMAC-SHA256(hexToBytes(secret), raw body)`; the hex secret must be decoded to bytes; compare in
  constant time. The secret is only returned when creating a subscription or rotating it. There is **no timestamp** in the
  signature scheme, so replay protection is ours (dedupe on the notification `id` plus an age limit).
- Delivery: at-least-once, retried for up to 48 hours on non-2xx/timeout, possibly duplicated, **not ordered**; a
  subscription may be deleted after repeated failures. A **payment-plan order fires `order.create` only when fully paid.**
- The fixture signature in `test/fixtures/squarespace/webhooks.json` was computed with the documented OpenSSL command
  (`openssl sha256 -mac hmac -macopt hexkey:$SECRET`), independently of the code under test.

### OAuth (webhooks only)

`POST https://login.squarespace.com/api/1/login/oauth/provider/tokens`, `Authorization: Basic base64(client_id:client_secret)`,
`grant_type=refresh_token`. Access tokens last **30 minutes**; refresh tokens **7 days** and are **single use** (each refresh
returns a new pair that must be stored before use). Apps are registered at https://account.squarespace.com/developer-apps.

## 2. Not documented or unverified (do not assume)

| Question | Treatment |
|---|---|
| How to tell a subscription order from a one-off. **No subscription field, subscription id, status, or cancellation signal exists** on Orders. `lineItemType` is a free string (sample: `PHYSICAL_PRODUCT`; product types in Products v2: `PHYSICAL, SERVICE, GIFT_CARD, DIGITAL`). | Membership is driven only by the product/SKU map. `isSubscription` is a heuristic (type contains `subscription`/`recurring`, or product id configured as subscription) and nothing depends on it. |
| Sort direction; inclusive/exclusive bounds of `modifiedAfter/Before`. | Not relied on. The 5 minute overlap and the full read of every page cover it. The simulator uses strict bounds and both directions in tests. |
| Whether `paymentStates` survives inside the cursor; whether Transactions accepts a cursor alone or needs the dates; whether Transactions needs both dates together. | The client sends dates (both) on page 1 and only the cursor afterwards. First-live-run item. |
| Whether point-of-sale, Squarespace Invoicing and Scheduling payments surface as Orders/Transactions. | Unknown: it decides how staff collect (section 6). First-live-run item. |
| `externalTransactionProperties` contents (could hold last4 for some gateways). | Kept in `raw`; not used. Check on the first live payload. |
| Status for a missing User-Agent; status when an API key calls the Webhook Subscriptions API; whether 429s carry `Retry-After`. | Client accepts numeric and HTTP-date `Retry-After`, otherwise waits the documented 60 s. |
| Caller-controlled values that survive onto an order (for matching a payment link). Documented candidates: `formSubmission[]` (checkout custom form), `lineItems[].customizations[]`, `discountLines[].promoCode`, `externalOrderReference` (imported orders only). A query-string reference on a checkout URL is **not** stored. | Not used in v1. Matching is email/phone + amount + window with staff confirmation. A single-use discount code per invoice is the only plausible reference token (Discounts API supports API keys); needs a spike. |
| Plan name: docs say API keys need "Commerce Advanced". | Ask the owner which plan the site is on before generating the key. |

## 3. Capability gap table

| Wanted | Squarespace API | What Oasis does now | Fallback |
|---|---|---|---|
| Charge a card | Not possible (read-only for payments) | Staff take the payment in Squarespace. Oasis records it as Paid with `processor_state=awaiting_processor`; the Transactions feed or staff confirm it. | Connect the owner's own Stripe account to Squarespace and charge through Stripe later (`PaymentProcessor` seam, `capabilities.chargeCard=true`). |
| Refund a card | Not possible | Refund is approved in Oasis (limits, approvals), flagged "complete in Squarespace", closed when the refund shows in the feed. | Stripe refunds. **Caveat (review B42/C13): refunds made outside Squarespace (e.g. directly in Stripe) never appear in the Transactions API, so the Stripe route needs its own sync adapter and cannot reuse this feed.** |
| Payment link / invoice | Not creatable | Staff attach a Squarespace checkout/invoice URL to the Oasis invoice and send it by SMS. | Stripe Payment Links. |
| Saved card / card on file | Not exposed | Display "Visa · managed in Squarespace" (brand only; last4 and wallet are not available). | Stripe customers. |
| Membership billing management | Subscription orders are readable; billing is not manageable; Member Areas billing not exposed | Read-only: tier and status inferred from renewal orders. Plan changes and cancellations happen in Squarespace. | Stripe Billing. |
| Subscription cancellation signal | None | **Lagged** inference: `past_due` after period end + grace; `canceled` only after a further `lapseCancelDays` (default 60), flagged `lagged_cancellation`. Staff can cancel by hand. | Webhooks do not help (no subscription topic). |
| Transaction webhooks | None; order webhooks need OAuth | Polling every 120 s is the baseline; webhooks are an optional accelerator for orders. | Shorter interval (the budget allows it). |
| Failed-payment dunning visibility | `paymentState=FAILED` only for payments that were first `PENDING` | Grace period (default 7 days) absorbs Squarespace retries. | |
| Tip | Not a Squarespace concept | Tip stays an Oasis invoice attribute. | |
| Test environment | No sandbox; `testmode` orders from test payment methods | `testmode` orders are stored as ignored unless `SQSP_INCLUDE_TEST_ORDERS=true`. | |

## 4. How it works

```
SquarespaceClient (live) | InProcessSquarespace / HTTP sim  --implements-->  SquarespaceSource (port)
                                   |
                              SyncEngine  -- OrderRepository / TransactionRepository / ContactRepository /
                                   |         SyncStateRepository / SyncErrorRepository   (interfaces; in-memory impls)
                                   v
                              MatchRunner -- planOrder + matchArrivals (pure) -- LedgerReader / LedgerCommands / AlertSink
                                   |                                              (interfaces; InMemoryLedger reference)
                          inferMemberships / reconcileMembership (pure)      receiveWebhook (verify, dedupe)
```

Code: `src/integrations/squarespace/**` (client, mappers, webhook, oauth, simulator) and `src/modules/payments-sync/**`
(sync, matcher, membership, runner) hold no database code; the Postgres repositories, jobs and routes live in
`src/modules/payments-sync/{db,jobs,http}` and `src/modules/memberships` (ADRs 0070-0073).

### Client
Typed mapping to the port types (extended additively: phone, customer id, payment state, tax and subtotal cents, provider,
document and payment ids; raw payloads kept). Bearer auth (API key or OAuth `AccessTokenProvider`, one refresh on 401),
User-Agent, cursor-only continuation, per-item mapping failures collected in `Page.rejected` instead of failing the page.
**Limiter**: sliding window, default 240/min (below the 300 limit, `SQSP_REQUESTS_PER_MINUTE`). **429**: waits `Retry-After`
(seconds or date) or 60 s, puts a cool down on the shared limiter so every caller waits, retries up to 5 times in a row.
5xx and network errors: exponential backoff 0.5 s doubling to 30 s, 5 attempts. All waiting goes through an injected
`Sleeper` and `Clock` (`FakeSleeper` advances a `FixedClock`).

### Sync engine
- **Poll** (`pollOrders`, `pollTransactions`, `runCycle` every `SQSP_POLL_INTERVAL_SECONDS`): window =
  `[watermark - overlap, now]`, overlap 5 min (clock skew, late commits). Watermark advances to the request time only after the
  whole window is stored. First run looks back 45 days. Windows are chunked to 7 days and progress is saved per chunk.
- **Request budget** per run (default 120 port calls): when hit, the in-flight window and cursor are saved and the next run
  resumes; the watermark never passes unread data.
- **Idempotent upserts** keyed by Squarespace ids; an older `modifiedOn` never overwrites a newer row (`stale`), identical
  payloads are `unchanged`; match fields survive updates.
- **Errors**: run failures count toward `dead_letter` (default 5 consecutive; polling stops until `resume()`). A row that
  cannot be persisted holds the watermark for `maxItemAttempts` (5) then is dead-lettered so it cannot wedge the sync;
  unmappable rows are dead-lettered immediately. A 400 on a saved cursor restarts that window. `health()` reports lag and
  dead letters.
- **test_mode** orders are stored with `match_state=ignored (test_mode)`; their transactions are ignored too. Donations
  (no order) are ignored.
- **Nightly `reconcile()`**: re-reads the last 45 days (orders then transactions), upserts anything missed, and (when one
  invocation covers the window) lists local orders Squarespace no longer returns. Resumable under its own budget.
- **Webhook path**: `receiveWebhook` verifies, parses, rejects stale (>7 days) and duplicate notifications, then the caller
  enqueues `SyncEngine.ingestOrder(orderId)`. Out-of-order delivery is harmless because the upsert is monotonic.

### Matching (pure)
Orders become **arrivals**: one per payment and refund in the feed; if the feed has not caught up but the order is `PAID`, the
order itself is the arrival (the later transaction is recognised as already recorded and only attaches its reference).

Binding precedence (reviews B10, D14):

0. **Already recorded**: a ledger event with this `processor_ref`, or with this `sqsp_order_id` and the same amount and no
   reference, means no new money: attach the missing references.
1. **Staff-recorded `awaiting_processor` event**: same customer (Squarespace customer id, email or phone), **equal amount**
   (exact cents), within **48 h** either way. Exactly one identity-matching candidate confirms it.
2. **Payment link** on an invoice: exactly one active link whose customer matches, whose expected amount is within
   `max(1 cent, bp)` and whose window is `[sent, sent + 14 d]` (or the link's expiry). A staff-attached order number is an
   explicit match.
3. **Manual queue** with up to 3 scored suggestions.

Guards that force manual (never a second pay event): any equal-looking awaiting event blocks rule 2; an unconfirmed
staff-recorded payment of the same customer inside the window blocks rule 2 even with a different amount; a card/other pay
event of the same amount already on the invoice; a settled invoice; an overpayment; non-USD.

Confidence = identity (0.5 customer id or email+phone, 0.45 email, 0.4 phone) + amount (0.3 exact, 0.25 within tolerance) +
time/window (0.1 to 0.2 for rule 1, 0.15 for rule 2); explicit attached references score 1. **Nothing auto-applies below
`SQSP_MATCH_CONFIDENCE_THRESHOLD` (0.8)**; below it the same match becomes a manual queue item.

**Variance**: Squarespace computes its own tax; every confirm/record stores `{sqspTotal, oasisTotal, delta, tax delta}` and raises
`variance_exceeds_delta` past `SQSP_VARIANCE_ALERT_CENTS` (100). Which amount is authoritative: the **amount actually paid** (the
transaction) is what the ledger records; the invoice total is not rewritten.

**Refunds**: an awaiting Oasis refund with equal amount (linked by order or customer) is confirmed; a refund still pending
Oasis approval goes to a human; a feed refund with no Oasis event on a tracked order becomes a `source=squarespace` refund event
(`done`, `confirmed`) with an `external_refund` alert, because it bypassed Oasis limits and approvals; for an order not yet booked
it is **deferred** (retried next run). An Oasis-denied refund never absorbs a feed refund. A partial feed refund of a different
amount than an open Oasis refund is ingested as external and the Oasis refund stays open for the overdue alert.

**Ignored orders**: test_mode, `FAILED`, and orders none of whose line items is in the product map (`SQSP_PRODUCT_MAP`); a
partly unmapped order proceeds with `partially_unmapped_skus`. An empty map raises `product_map_empty` instead of silently
ignoring everything. Membership orders become `match_state=membership` (no invoice).

`findOverdueAwaiting` returns staff-recorded events still unconfirmed after 24 h (the alert card).

### Membership inference (pure)
Product/SKU map entries: `{productId|sku, kind: membership|service, tierLabel, intervalMonths}`; "Premium Care" normalises to
Premium (label kept as `planLabel`). Per person (linked Oasis customer, else email, else Squarespace id, else phone):
subscription ref `sqsp:<email>:<productId|sku>` (B11); latest **paid** order sets tier and `period = [createdOn, +interval)`;
**active** until period end + `graceDays` (default **7**, configurable; the design's 3 misfires on Squarespace retries), then
**past_due**; **canceled** only after `lapseCancelDays` more (default 60, `null` disables) and flagged as a lagged inference. A
**full refund flags review and never cancels**; a partial refund stays paid and flags; pending/failed latest orders flag. Linking:
Squarespace customer id, then email (case-insensitive), then phone (E.164, ambiguity links nobody and flags). `reconcileMembership`
respects hand-set pause/cancel until a newer paid order arrives and returns `needs_customer` for unknown people.

## 5. Integrator guide

Implement over Postgres (suggested columns beyond design §3.8 in italics):

| Interface | Table | Notes |
|---|---|---|
| `OrderRepository` | `sqsp_orders` | *`customer_id` (Squarespace), `customer_phone`, `payment_state`, `tax_cents`, `subtotal_cents`, `ignore_reason`*; `upsert` must be one statement keyed on `sqspOrderId` guarded by `modified_on <=` incoming. |
| `TransactionRepository` | `sqsp_transactions` | *`document_id`, `payment_id`, `provider`, `external_transaction_id`, `voided`, `document_modified_on`, `ignore_reason`*; `state` new/matched/manual/ignored/deferred/membership. `last4` stays null. |
| `ContactRepository` | `sqsp_profiles` (rename to contacts) | email, name, phone. |
| `SyncStateRepository`, `SyncErrorRepository` | `sqsp_sync_state` (+ `in_flight` jsonb, `phase`, `window_start`), new `sqsp_sync_errors` | resource enum gains `contacts`, `reconcile`. |
| `LedgerReader.loadContext` | `ledger_events`, `payment_links`, `invoices` | Events tied to the order or its processor refs plus `awaiting_processor` events near the arrival times; active links; invoice summaries (`balance` from the invoice calc view). |
| `LedgerCommands` | ledger commands | Every command carries an `idempotencyKey` (`sqsp:<orderId>:<kind>:<txnId|order>`): store it on the event (`ledger_events.idempotency_key`) and return the existing result on repeat. Confirm = the `ledger_guard`-allowed update of `processor_state/processor_ref/sqsp_order_id` only. New pay events are `source=squarespace`, `processor_state=confirmed`; external refunds `source=squarespace`, `done`, `confirmed`, flagged for review. |
| `AlertSink` | notifications | Codes: `variance_exceeds_delta`, `external_refund`, `partially_unmapped_skus`, `mixed_membership_order`, `refund_exceeds_payment`, `product_map_empty`. |

`InMemoryLedger` is the reference behaviour; port its tests to the SQL implementation. Jobs: `sqsp.sync.orders/transactions` →
`runCycle`, then `MatchRunner.run`, hourly `syncContacts`, nightly `reconcile`, `sqsp.webhook.process` → `ingestOrder`, daily
membership pass (`inferMemberships` over orders in the last ~6 months plus `reconcileMembership` per person).

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SQSP_PROVIDER` | `sim` | `sim` or `live` (shared contract) |
| `SQSP_API_BASE` | `https://api.squarespace.com` | `http://127.0.0.1:4590` for the simulator (shared contract) |
| `SQSP_API_KEY` | | Commerce API key, required when live (shared contract) |
| `SQSP_POLL_INTERVAL_SECONDS` | 120 | Poll cadence (shared contract) |
| `SQSP_USER_AGENT` | `OasisAutoSpa-Sync/1.0` | Required header; identify the app |
| `SQSP_OVERLAP_SECONDS` | 300 | Watermark overlap |
| `SQSP_RECONCILE_DAYS` | 45 | Nightly re-read horizon |
| `SQSP_REQUESTS_PER_MINUTE` | 240 | Client budget (limit is 300) |
| `SQSP_MAX_REQUESTS_PER_RUN` | 120 | Port calls per sync run |
| `SQSP_INCLUDE_TEST_ORDERS` | false | Process `testmode` orders |
| `SQSP_MEMBERSHIP_GRACE_DAYS` | 7 | Grace after the paid period |
| `SQSP_MATCH_CONFIDENCE_THRESHOLD` | 0.8 | Auto-apply floor |
| `SQSP_VARIANCE_ALERT_CENTS` | 100 | Variance alert delta |
| `SQSP_LINK_WINDOW_DAYS` | 14 | Payment link match window |
| `SQSP_LINK_AMOUNT_TOLERANCE_CENTS` | 1 | Payment link amount tolerance |
| `SQSP_PRODUCT_MAP` | | JSON array of product map entries (or the admin table) |
| `SQSP_WEBHOOK_SECRET` | | Hex secret from subscription creation (store encrypted in the DB for rotation) |

OAuth additionally needs (only if webhooks are wanted): client id/secret, redirect URI, and the encrypted token store (B45).
`loadSquarespaceEnv` (src/integrations/squarespace/config.ts) parses and validates all of the above.

## 6. Simulator and tests

- `pnpm sim:squarespace [--seed demo|fixtures|none] [--port 4590] [--api-key ...] [--rate-limit 300] [--order desc]
  [--webhook-url ... --webhook-secret <hex>]` serves the same endpoints from memory. Control surface under `/__sim`:
  `POST /orders` (renewals: `/orders/:id/renew`; extra payments `/payments`; refunds `/refunds`, optionally `documentLevel`;
  `/state`), `/failures` (500s, 429 with `Retry-After`), `/rate-limit`, `/webhooks/deliver`, `/webhook-config`, `/reset`;
  `GET /state`, `/requests`. It enforces the documented rules (date pair required, cursor alone, `paymentStates` default,
  User-Agent, bearer key) and signs webhooks exactly like Squarespace.
- In process: `InProcessSquarespace` over a `SquarespaceSimStore`, and `SquarespaceSimApi` + `SquarespaceClient({fetch})`.
- The same `SquarespaceSource` contract suite (`test/integrations/squarespace/contract.test.ts`) runs against the client over
  the sim and the in-process fake, in both server orders; recorded-shape fixtures run through the sim's HTTP surface.
- **Fixtures are hand-built from the documented schemas** (one order is the documentation's sample verbatim), not recorded
  from a live site. Replace them after the first live run (checklist step 9).

## 7. First live run: verification checklist

Prerequisites: owner confirms the plan includes API keys (Commerce Advanced); key created in Settings > Advanced > Developer
API Keys with **Orders: Read Only, Transactions: Read Only, Contacts: Read Only** (nothing else); a few real or test orders
including one subscription renewal, one partial refund and one paid through the checkout/invoice flow staff will use.

1. `SQSP_PROVIDER=live`, key in env (never logged). `curl -H "Authorization: Bearer $KEY" -H "User-Agent: OasisAutoSpa-Sync/1.0" "https://api.squarespace.com/1.0/commerce/orders?modifiedAfter=...&modifiedBefore=..."`: expect 200 and the shapes in section 1.
2. Confirm `modifiedAfter` alone is rejected (400) and that cursor + dates is rejected; note the order direction and whether the bounds are inclusive.
3. Page with `cursor` only: confirm `paymentStates` still applies (a `PARTIALLY_PAID` or `PENDING` order stays visible).
4. Transactions: confirm shape, `creditCardType`, absence of last4/wallet, contents of `externalTransactionProperties`, where refunds sit (per payment or document level) and that a refund made in the Squarespace admin appears.
5. Subscription product: record the order's `lineItemType`, `productId`, `sku` for each membership tier, confirm renewals are separate orders with the same product, and what `customerEmail`/`customerId` they carry. Fill `SQSP_PRODUCT_MAP`.
6. Check how the collection flow staff use (checkout link, Squarespace Invoicing, POS, Scheduling) appears: order or not, `channel`, `paymentState`, whether an email/phone is present.
7. 429 behaviour: not worth provoking; confirm the client's request counter (`requestCount`) per cycle is small (expected under 10).
8. Run one poll cycle against an empty store, then the matcher in report-only mode; read the manual queue before enabling auto-apply. Run `reconcile()` and confirm zero `updated` on a quiet site.
9. Capture the real payloads (redact emails) into `test/fixtures/squarespace/` and re-run `pnpm test`; update section 2.
10. Webhooks (optional): register an OAuth app, subscribe `order.create`/`order.update` to the public HTTPS endpoint, `sendTestNotification`, verify the signature against the stored secret, confirm a refunded order sends `order.update` with `update=REFUNDED`.

## 8. Decisions and deviations

- Grace default 7 days (design said 3; review B11 made it configurable and flagged 3 as misfiring).
- Cancellation is inferred only after a further 60 days (configurable, can be off); a manual cancel is always possible.
- Contacts API replaces Profiles (review B44/C12); products are not synced from the API (the map is configuration).
- The port gained optional fields only (`Page.rejected`, order/transaction/contact extras); `listTransactionsForOrder` exists on the
  client, not the port.
- Webhook subscription management is an interface with an in-memory implementation; no live HTTP implementation (needs OAuth).
- Order-level arrivals (PAID order before its transaction) are matched immediately; deposits are flagged when the amount is below the
  invoice balance.
