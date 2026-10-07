# 0070 Squarespace read side: persistence, idempotency and dead letters

Status: accepted (2026-10-07). Builds on ADR 0003 (Squarespace is read-only for payments, Oasis owns the ledger).

The pure sync engine, matcher and membership inference (`src/modules/payments-sync`) now run over Postgres. Migration
`20261006210100_sqsp_sync.sql`; Kysely types in `src/modules/payments-sync/db/schema.ts`.

| Table | Holds |
|---|---|
| `sqsp_connections` | One row per location: the API key as `<key id>:<iv>:<tag>:<ciphertext>` (AES-256-GCM, `SECRETS_KEY`), status and last error. OAuth columns (client id and secret, access and refresh tokens, expiry, scopes) exist but are reserved: webhook subscriptions are the only OAuth consumer. |
| `sqsp_sync_state` | Per resource (`orders`, `transactions`, `contacts`, `reconcile`): watermark, the in-flight window and cursor, phase, last run and success, status, consecutive failures. |
| `sqsp_orders` | The mapped order (`order_json`, dates as ISO strings), the wire payload (`raw`), a payload hash, queryable columns, `match_state`, `ignore_reason`, `matched_invoice_id`, `customer_id`. Unique `(location_id, sqsp_order_id)`. |
| `sqsp_transactions` | One row per Squarespace payment or refund (a Document is flattened), `state`, `matched_event_id`, `effective_modified_on` (the version a stale write is compared against). `last4` stays null: Squarespace documents none. |
| `sqsp_contacts`, `sqsp_customer_links` | The Contacts feed and the Squarespace customer id to Oasis customer link (email, then phone, when exactly one customer matches; or by hand). |
| `sqsp_products` | The product map (see ADR 0073). |
| `sqsp_sync_errors` | Dead letters: per key, attempts, `dead_lettered_at` at 5, `resolved_at` when the item finally succeeds. |
| `sqsp_matches`, `sqsp_manual_queue`, `sqsp_alerts` | Applied decisions (the idempotency record of every ledger command, with confidence and the variance), arrivals waiting for a person, and alerts. |
| `sqsp_webhook_subscriptions` | Subscription id, topic, endpoint, encrypted secret, last delivery. |

Webhook notifications are logged in the **platform `webhook_log`** (unique provider + notification id, retained 90 days by
`maintenance.purge`), not in a second table: the notification id, never the order id, is the dedupe key so two updates of one
order are both processed.

## Rules

* **One guarded statement per upsert.** `INSERT ... ON CONFLICT (location_id, sqsp_order_id) DO UPDATE ... WHERE modified_on <= excluded
  AND payload_hash <> excluded` returns inserted or updated; otherwise one read classifies `stale` (stored row is newer) or
  `unchanged`. A re-sync never touches `match_state`, `matched_invoice_id`, `customer_id`, transaction `state` or
  `matched_event_id`. Transactions compare `coalesce(document_modified_on, created_on)`.
* **Dead letters.** `PgSyncErrorRepository.record` counts failures per `(resource, key)`; at 5 it sets `dead_lettered_at`, and
  the engine then stops holding the watermark for that item. A key that succeeds later is marked resolved and starts from 1 if it
  fails again. An unmappable row is recorded as a `mapping` error. Five consecutive failed runs of a resource set
  `sqsp_sync_state.status = dead_letter` (polling stops, alert `sync_dead_letter`) until "Sync now" with `resume`.
* **SSE.** Every stored or re-matched order publishes `squarespace.order_synced` on the `payments` channel
  (`orderId`, `orderNumber`, `matchState`, optional `invoiceId`) in the same transaction as the write.
* **Alerts** are idempotent per `(code, order, transaction, subject)`; raising a resolved alert again re-opens it. Codes:
  `variance_exceeds_delta`, `external_refund`, `partially_unmapped_skus`, `mixed_membership_order`, `refund_exceeds_payment`,
  `product_map_empty`, `sync_dead_letter`, `sync_failing` (3 consecutive failures), `membership_needs_customer`.
* Test-mode orders are stored `ignored (test_mode)` unless `SQSP_INCLUDE_TEST_ORDERS=true`; an empty product map raises
  `product_map_empty` and ignores the orders as `unmapped_sku`; saving the map re-opens exactly those.
