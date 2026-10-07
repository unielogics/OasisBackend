# 0072 Squarespace jobs, runtime and credentials

Status: accepted (2026-10-07).

## Jobs (registered in `src/platform/job-registry.ts`)

| Job | Schedule | Policy | Does |
|---|---|---|---|
| `sqsp.sync` | every `SQSP_POLL_INTERVAL_SECONDS` (rounded to whole minutes, at least 1; default `*/2`) | singleton, no retry | orders then transactions (watermark minus the 5 minute overlap, 7-day chunks, per-run request budget, 429 handling inside the client), then the match runner, then the membership pass when orders changed. |
| `sqsp.contacts` | hourly at :17 | singleton | the full Contacts read, then customer links. |
| `sqsp.reconcile` | 02:30 business time | singleton, 1 retry | re-reads the last 45 days (orders, then transactions), upserts what the poll missed, runs the matcher. Does not touch the poll watermarks. |
| `sqsp.webhook.process` | queue only | standard, 5 retries | fetch the order a verified notification names, store it (same upsert as the poll), match. |
| `membership.cycle` | 03:00 business time | short | roll manual membership cycles, grant cycle credits, run the subscription inference. |

A sync run that Squarespace rejects (401, 5xx, a persist failure) is **recorded** in `sqsp_sync_state` and does not throw: the
next cron fire is the retry, five consecutive failures dead-letter the resource (ADR 0070), so pg-boss never stacks retries on top
of the engine's own accounting. The runs go through one shared function (`jobs/sync.ts`) that the "Sync now" endpoint also uses
(queued when there is a queue, inline otherwise).

## Runtime and wiring seam

`SqspRuntime` (`db/runtime.ts`) builds, per location, the client (or an injected source), the sync engine, the match runner over
`PgLedger`, the product map and the connection. pg-boss handlers only receive `{db, clock, logger}`, so jobs and routes get the
runtime through `createSqspRuntime()` (`db/runtime-config.ts`), which reads the process environment once and can be overridden
with `configureSqspRuntime({ env, sleeper, fetch, sourceFactory })` (tests, an embedding process). The HTTP client is kept per
key for the process lifetime so the sliding-window budget (`SQSP_REQUESTS_PER_MINUTE`, 240 of the documented 300) and 429 cool
downs are shared across runs. The worker calls `configureProductionSchedulingJobs` (composition.ts) so the alerts scan has the
real invoice gateway, ledger revenue, memberships port and Squarespace alert source, as the API process does.

## Credentials

`PUT /integrations/squarespace/connection` verifies the key with one read (unless `verify:false`), then stores it AES-256-GCM
encrypted with `SECRETS_KEY` (base64, 32 bytes; 503 naming the variable when unset). The stored form carries the key id, so a
rotated key can still read old rows (`createSecretBox([new, old])`). No route returns the key or any part of it; the audit trail
holds `{authKind, verified, siteId}`; pino redacts `apiKey`. Key resolution: the stored key, else `SQSP_API_KEY`, else (provider
`sim`) the simulator's `sim-api-key`; an explicit `DELETE .../connection` stops polling even when an environment key exists. With
`SQSP_PROVIDER=sim` and the default API base the client talks to `http://127.0.0.1:4590` (`pnpm sim:squarespace`).

## Environment (all optional)

`SQSP_PROVIDER`, `SQSP_API_BASE`, `SQSP_API_KEY`, `SQSP_POLL_INTERVAL_SECONDS` (existing), and from
`src/integrations/squarespace/config.ts` now also validated in `src/config/env.ts`: `SQSP_USER_AGENT`, `SQSP_OVERLAP_SECONDS`,
`SQSP_RECONCILE_DAYS`, `SQSP_REQUESTS_PER_MINUTE`, `SQSP_MAX_REQUESTS_PER_RUN`, `SQSP_INCLUDE_TEST_ORDERS`,
`SQSP_MEMBERSHIP_GRACE_DAYS`, `SQSP_MATCH_CONFIDENCE_THRESHOLD`, `SQSP_VARIANCE_ALERT_CENTS`, `SQSP_LINK_WINDOW_DAYS`,
`SQSP_LINK_AMOUNT_TOLERANCE_CENTS`, `SQSP_PRODUCT_MAP` (a JSON bootstrap; the table overrides it), `SQSP_WEBHOOK_SECRET` (hex).
New: `SQSP_LAPSE_CANCEL_DAYS` (default 60; 0 never infers a cancellation). `SECRETS_KEY` is required to store a key.

## Webhook

`POST /hooks/squarespace`: hex-decoded HMAC-SHA256 over the raw body, constant-time compare, secrets from the encrypted
subscription rows plus `SQSP_WEBHOOK_SECRET`; 401 for a bad signature (nothing logged or stored), 400 malformed, 200 for stale
(older than 7 days), duplicate or ignored topics (a non-2xx would make Squarespace retry for 48 hours), 202 when accepted
(queued, or processed inline when there is no queue). If queueing fails the notification id is given back and the answer is 503
so Squarespace's retry is accepted. OAuth subscription management stays the interface in `integrations/squarespace/subscriptions.ts`.

## First live run: what the simulator covers and what still needs a key

The checklist is `docs/integrations/squarespace.md` section 7. Everything below runs in tests against the simulator and Postgres;
the items marked LIVE need the real site and key and are not verified.

| Checklist step | Status |
|---|---|
| 1 key, headers, 200 and shapes | LIVE (the client sends Bearer, User-Agent; verified against the documented contract only) |
| 2 window rules (`modifiedAfter` alone, cursor with dates, inclusive bounds, direction) | LIVE (the engine does not rely on any of them: overlap, full page reads, monotonic upserts) |
| 3 `paymentStates` surviving a cursor | LIVE (a `PARTIALLY_PAID` or `PENDING` order must stay visible on later pages) |
| 4 transactions: brand, no last4, refunds per payment or per document, admin refunds | LIVE (the mapper reads both shapes; `externalTransactionProperties` kept in `raw`) |
| 5 subscription products: `lineItemType`, ids, SKUs, renewals as separate orders | LIVE: fill the map with `PUT /integrations/squarespace/product-map`; until then `product_map_empty` is raised and orders are ignored |
| 6 how staff collect (checkout link, Invoicing, POS, Scheduling) appears | LIVE: decides whether payments reach Orders or Transactions at all |
| 7 request counter per cycle | simulator: a cycle is 2 requests when quiet (orders, transactions) |
| 8 empty store, matcher report-only, reconcile quiet | simulator: tested (the second reconcile writes nothing); report-only mode does not exist, read the manual queue first |
| 9 capture real payloads into `test/fixtures/squarespace/` | LIVE |
| 10 webhooks (OAuth app, `sendTestNotification`, `REFUNDED` update) | LIVE; the verification, dedupe and replay handling are tested with signed fixtures |

Also unverified until a live run: that a payment made through the staff's checkout flow carries the customer's email or phone (the
matcher needs one of them), and that Squarespace's tax on a tax-inclusive deposit product stays within `SQSP_VARIANCE_ALERT_CENTS`.
