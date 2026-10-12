# 0171 Square for everything: pay-by-link, memberships, counter payments and cards on file
Status: accepted (2026-10-12, owner plan "Square payments + prices by vehicle size", decisions 1 to 9); wave Q1b (the foundation) built

The shop already takes cards at the counter with the Square POS app and reader. The owner wants Square for everything: payment links,
memberships billed monthly, counter payments recorded in Oasis without typing, and cards on file. Today payments are Squarespace-shaped
(pasted checkout URLs, memberships inferred from orders, counter card payments typed by hand). This ADR records how Square comes in,
what is switched on when, and what each wave adds. The detailed design is `wt/_reports/q-design-square.md`; where it differs from the
approved plan, the plan wins (section "Amendments").

## Decisions (D1 to D12, as amended by the plan)

| # | Decision |
|---|---|
| D1 | Our own `fetch` client and simulator, like the other integrations. **No Square SDK.** `Square-Version` is pinned (`2026-09-16`). |
| D2 | **The booking fee is a deposit toward the visit** (ADR 0150, plan decision 4): a `pay` with `deposit=true` on the visit's invoice, paid by a Square quick-pay link or at the counter, settled by the existing cancel and no-show rules. Not an invoice line. |
| D3 | **Payment links are created at click time for the exact current balance**; the order's lines plus a "Sales tax" line must add up to the amount exactly. Staff "Send link" texts the client's personal pay link; while personal links are off it texts the `square.link` URL. The fresh PIN or code before paying stays. |
| D4 | Card refunds go out through the Square API, the refund ledger row being the outbox. **A refund Square reports FAILED or REJECTED stops counting as refunded** (`invoice_calc_of`, `calc.ts`, `jobs-integrity.ts` and the dashboard's `cents.ts` change together). |
| D5 | Tips: off on links by default (a setting). A tip on a POS or link payment adds to the invoice's tip and is its own `pay` row. |
| D6 | **Counter (POS app) payments are recorded automatically only on strong evidence** (plan decision 5): staff tapped "Square reader" for that amount, or the invoice number is in the note, or exactly one open invoice of that amount matches the client. Everything else goes to a one-tap "Square payments to match" queue. Nothing is ever recorded twice. |
| D7 | **A saved card is charged only after a staff member confirms** (plan decision 6): membership billing; no-show and late-cancel fees (off until the amounts are set); a balance, with the client's OK. The consent box starts unchecked, is versioned, and we store its text hash, time, IP and user agent. |
| D8 | Memberships are enrolled on our `#/m` page with the Web Payments SDK; a membership is active only when Square's first subscription invoice is paid. |
| D9 | **Price changes are grandfathered** (plan decision 8): existing members keep their price unless admin presses "Move members", which sends a 30-day notice, then swaps their Square plan. |
| D10 | **Failed renewal** (plan decision 7): day 0 the client gets a text with a card link and perks stay on; day 7 perks pause; day 21 the membership is canceled. A payment at any point restores it. The design's day-3 retry through `CreatePayment` on the invoice's order is **dropped**: the sandbox refuses it (403 "owned by another application", section "Sandbox findings"); retries are Square's own plus a card update on the subscription. |
| D11 | Switches, all off by default (below). Observe-only mode (`SQUARE_WRITES_ENABLED=false`) mirrors and matches but writes nothing at Square. |
| D12 | Card entry exists only on personal link pages (PCI SAQ-A scope), so cards on file, memberships and the pay page need `PUBLIC_LINKS_ENABLED=true` (the W5 links rollout). Plain texted Square links work without it. |

## Switches

| Switch | Default | Effect |
|---|---|---|
| `SQUARE_PROVIDER` | `sim` | `sim`: an in-process simulator, nothing leaves the process. `live`: Square (or `SQUARE_API_BASE`, a `pnpm sim:square`). |
| `SQUARE_ENVIRONMENT` | `sandbox` | Which Square the token belongs to. Production refuses `sandbox` once `PAYMENT_PROCESSOR=square`. |
| `SQUARE_WRITES_ENABLED` | `false` | Observe-only: webhooks, catch-up, mirror and matching; any call that creates or changes something at Square is refused in the client before it is sent (setup calls such as EnableEvents and the webhook subscription still go). |
| `PAYMENT_PROCESSOR` | `squarespace` | The cutover: which processor new links, saved cards, memberships and refunds use. |
| `SQUARE_POS_API_ENABLED` | `false` | The POS app switch from the dashboard (iPad). Only with live production Square. |
| `SQSP_SYNC_MODE` (wave Q2b) | `active` | `history` keeps Squarespace read-only about 60 days for late refunds, then `off`. |

The environment contract refuses: `live` without the token, location, application id, webhook key or webhook URL; production with
`PAYMENT_PROCESSOR=square` on the simulator or the sandbox; the POS switch outside live production; a production webhook URL that is
not `https://<domain>/hooks/square`; a previous webhook key without a current one. The token and both webhook keys are secret keys
(Secrets Manager only, `SECRET_KEYS`).

## The foundation (wave Q1b, built)

- **Client** (`src/integrations/square/client.ts`): Bearer token, pinned version, timeout, zod-validated answers (unknown fields pass),
  typed errors (`SquareAuthError`, `SquareDeclined` with a friendly text, `SquareIdempotencyReused`, `SquareRateLimited`,
  `SquareNotFound`, `SquareNetworkError`, `SquareWireError`, `SquareWritesDisabled`). Retries: a GET, a read-only POST (searches) or a
  call carrying an `idempotency_key` is repeated on network errors, timeouts, 429 (Retry-After) and 5xx with backoff and jitter; any
  other write (cancel, pause, swap, disable, delete) only when the request surely never left (connection refused, DNS), and its
  "already done" answers count as success. Create calls take a `SquareKey` (`keys.ts`: `<prefix>_<32 hex>`, 35 characters, checked
  against Square's 45), so none can go out without a deterministic key. Money is USD integer cents only (`money.ts`). The token is
  never logged or put in an error.
- **The port** `SquareApi` (`src/integrations/ports/square.ts`) covers every call of the design: locations; payments; refunds; payment
  links; orders; customers; cards; catalog; subscriptions (with pause, resume, cancel, swap, bulk swap, delete action); invoices;
  events (search, enable, types); webhook subscriptions (list, create, update, test, event types, signature-key rotation).
  `squareApiFor(env)` gives the HTTP client or the in-process simulator through the same client.
- **Simulator** (`sim/*`, `pnpm sim:square`): every call above in memory, the way the sandbox answered; real idempotency; test nonces;
  clock-driven refunds, subscription billing and scheduled actions; an event log for SearchEvents; signed webhook delivery with
  duplicate and out-of-order modes; `/__sim` controls (link pay, POS payment and refund, subscription billing, card updates, failed
  refunds, faults). The captured sandbox answers keep it honest (`test/fixtures/square/`, `test/square/sim.test.ts`).
- **`/hooks/square`**: signature = base64 HMAC-SHA256(key, `SQUARE_WEBHOOK_URL` + raw body), current and previous key, constant time;
  a merchant other than ours is acknowledged and dropped; the event is claimed in `webhook_log('square', event_id)` (the platform
  `DbWebhookLog`, now shared with the Squarespace hook), `square.event.process` is queued and Square gets 200 at once; a duplicate gets
  200; a queue that refuses the job releases the claim and answers 503. nginx: `location = /hooks/square`, POST only, zone
  `oasis_hooks`, 1 MB.
- **Jobs**: `square.event.process` re-fetches the event's object by id (payment, refund, invoice, subscription, card, customer) and
  dispatches it to an ingest handler under an advisory lock per object; this wave's handlers only log and close the row.
  `square.events.catchup` (every 10 minutes, live only) reads SearchEvents from the watermark minus 10 minutes through the same
  `webhook_log` claim, so a webhook and the catch-up never both process an event; a failed event holds the watermark back; a watermark
  older than 27 days is an alert (Square keeps events 28 days). `square.reconcile` (nightly, live only) counts the last 72 hours of
  payments and refunds into `square_state`.
- **Status and connection**: the `square` row of `GET /system/integrations`; `GET /integrations/square`; `POST /integrations/square/test`
  (`set.billing`, audited): ListLocations (active, USD, card processing), EnableEvents, our webhook subscription carries every event type;
  it stores the merchant id the hook checks.
- **Scripts**: `pnpm square:webhooks [--apply | --rotate-key]` (prints a new signature key once), `pnpm verify:square` (`--sim`,
  `--secret oasis/sandbox/square`, `--read-only` for production), part of `pnpm verify:all` and `verify.sh square`.
- **Data**: migration `20261014200000_square_foundation.sql` (`webhook_log` provider `square`, `square_state`).

Nothing in this wave moves money or changes today's behaviour: with the defaults no request leaves the process, the catch-up and the
reconcile do nothing, and the hook verifies nothing (no key) and answers 401.

## Sandbox findings (2026-10-12, `pnpm verify:square --secret oasis/sandbox/square`, 10 PASS)

Recorded in `docs/integrations/square.md` section 8; the ones that change later waves:

- **CreatePayment cannot pay a subscription invoice's order**: 403 "The order is owned by another application". A failed renewal is
  paid by Square's own retry, by the client from the invoice's `public_url`, or after a card update on the subscription (D10).
- **A payment link's order is DRAFT** until Square's checkout opens it; paying it through `CreatePayment(order_id)` works after the
  order is OPEN, and the payment carries `order_id`, which is how the classifier recognises a link payment. The order stays OPEN (its
  DIGITAL fulfillment is PROPOSED), the link stays retrievable, and DeletePaymentLink still succeeds after payment.
- **Link hosts**: sandbox `sandbox.square.link` (short `url`) and `connect.squareupsandbox.com` (`long_url`). Production is expected on
  `square.link` (`url`) and `square.site` / checkout hosts (`long_url`): `PAYMENT_LINK_HOSTS` and the site's redirect hosts take the
  production hosts at rollout, `squareupsandbox.com` only outside production.
- **The first subscription invoice is charged within seconds** (about 10 s) of CreateSubscription with a card; the subscription answers
  ACTIVE at once and lists the invoice a few seconds later.
- **A customer email Square cannot deliver to** (`example.com`) makes Square DEACTIVATE the subscription within seconds, with or
  without a card: enrollment must require a real email (it already does: Square needs one).
- **SwapPlan, Pause and Cancel take effect at the next billing date** (an action dated `charged_through_date`); the status stays
  ACTIVE until then. Resume of a scheduled pause is refused (INVALID_DATE); a scheduled action is undone with DeleteSubscriptionAction
  (billing-anchor actions cannot be deleted). A second cancel answers BAD_REQUEST "already has a pending cancel date" (treated as done).
- **The Events API works in the sandbox** (enable, list types, SearchEvents); it also returns `order.*` and `catalog.version.updated`
  events, the latter without `data.id`.
- **Declines**: CreateCard answers every declined test nonce with INVALID_CARD_DATA (400, INVALID_REQUEST_ERROR); CreatePayment gives the
  specific PAYMENT_METHOD_ERROR code (GENERIC_DECLINE, CVV_FAILURE, ADDRESS_VERIFICATION_FAILURE, INVALID_EXPIRATION) with the FAILED
  payment in the body.
- **Wallets**: a card nonce pays as `source_type CARD`, entry `KEYED`; a saved card as `CARD`, entry `ON_FILE`. The sandbox cannot
  produce an Apple Pay or Google Pay payment through the API; per Square's documentation they arrive as `source_type CARD` (a wallet
  such as Cash App Pay as `WALLET`), so `method_kind` maps CARD to card, CASH to cash, everything else to other. To confirm on the first
  production wallet payment.
- Not answerable in the sandbox: 3-D Secure under `Cross-Origin-Opener-Policy` (needs the Web Payments SDK on a page, wave Q3a) and the
  POS note field (production only).

## Amendments to the design by the plan

1. No `square_plan_variations` table: the append-only `membership_tier_prices` (ADR 0170) is the variation history; the design's
   `memberships.vehicle_class` / `price_cents` are `memberships.plan_class` + `tier_price_id`.
2. No per-size Squarespace checkout URLs: memberships are sold through Square (Q3b); until then staff create them by hand.
3. Migrations sort after `20261013090000`: pricing `20261014100000_*`, Square `20261014200000_*`.
4. ADR 0170 is vehicle sizes, prices and tiers; this ADR is Square.
5. Q1b differences from the design text: the status row's later-wave counts (unmatched, failed refunds, pending enrollments) are `null`
   until their waves; the catch-up's 27-day alert is the status row warning and `square_state.last_error` (the external-alert source
   `squareExternalAlerts` comes with Q2b); `square.reconcile` counts only (the matcher, link sweep and subscription drift come with the
   waves that create them); the webhook route answers 200 (not 202) for an accepted event.

## What the later waves add

| Wave | Adds |
|---|---|
| Q2b | Migration `20261014200100_square_core.sql`: `ledger_events.processor` / `processor_order_id`, the guard trigger re-created, failed refunds out of `invoice_calc_of` (D4); `square_payments` mirror, `square_refund_legs`, `square_pos_intents`; `SquareLedgerOps` with the announce tail extracted to `payments/announce.ts`; the classifier and matcher (R1 to R5), the unmatched queue routes and alerts; payment and deposit links with `square.links.sweep`; API refunds (`square.refunds.submit`); the real `payment` and `refund` ingest handlers; `SQSP_SYNC_MODE`. |
| Q3a | Cards on file: the site's card component and CSP, link kind `card`, `square_customer_links`, `customer_cards`, `card_consents`, `square_charges`, the fee proposal and charge; the `card` and `customer` handlers. |
| Q3b | Memberships on Square: catalog sync of the tier x size prices, enrollment with resume, billing webhooks (`invoice` and `subscription` handlers), the failure policy (D10), staff actions. |
| Q3c, Q3e | The website's v2 catalog, join and pay pages; the dashboard's billing block, saved cards and Settings, Billing & integrations (Square status and Test connection). |
| Q4 | The adversarial money and security review, and a sandbox end-to-end run on a disposable stack. |

Rollout (plan): deploy with `SQUARE_PROVIDER=sim`; production token into the secret, `pnpm square:webhooks --apply`, the key pushed,
Test connection, observe-only for about a week; writes on in stages (links, deposits and refunds; saved cards and fees; catalog and
memberships); then `PAYMENT_PROCESSOR=square` with the production CSP and redirect hosts; Squarespace to `history`, then `off`.
