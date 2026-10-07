# API specification

Conventions and platform behaviour for the Oasis Auto Spa API (Fastify 5, Postgres 15). The machine-readable contract is
[`openapi.json`](openapi.json) (served at `/api/v1/openapi.json`, regenerated with `pnpm openapi`); this document is the
human-readable half: rules every endpoint follows, and how to add one. Per-vertical endpoint documentation is appended
by each vertical below the generated table.

## 1. Base rules

| Topic | Rule |
|---|---|
| Prefix and version | Domain routes live under `/api/v1` (additive changes only; breaking changes mean `/v2`). Every `/api/*` response carries `X-API-Version: 1`. Probes (`/healthz`, `/readyz`) and provider callbacks (`/hooks/*`) sit outside the prefix. |
| Same origin | The dashboard and API share one origin behind the reverse proxy, so there is no CORS. Cookies are host-only. |
| Money | Integer cents everywhere (`...Cents`). The API never formats money; CSV uses plain decimals (`1234.50`). Tax is half-up on the subtotal at `tax.rate_bp` (700); tip is untaxed. Helpers: `src/platform/money.ts`. |
| Time | Instants are ISO-8601 UTC. Business dates are `YYYY-MM-DD` in the location timezone (`America/New_York`); wall-clock times are minutes from midnight. Read models that show a time string also carry a ready label (`time`, `atLabel`). Helpers: `src/platform/time.ts`. Time is injected (`Clock`, SQL `app_now()`); see section 8. |
| Ids | UUIDv7 generated in the app (`createIdGenerator(clock)`); human refs (`INV-20611`, appointment seq) are separate fields. |
| Request id | `X-Request-Id` is accepted (8-64 chars of `A-Za-z0-9._-`) or generated, echoed on every response, present on every log line and in every error body as `requestId`. |
| Rate limit | 300 requests/minute per user (per IP when anonymous), in memory, `RATE_LIMIT_PER_MIN`. 429 `RATE_LIMITED` with `Retry-After`. Probes and `/hooks/*` are exempt; `/events` allows 30 connects/minute. |
| Body limits | JSON bodies up to 1 MB (413 `PAYLOAD_TOO_LARGE`); `/hooks/*` also 1 MB. Request schemas should be `.strict()`. |
| Security headers | Helmet with `default-src 'none'; frame-ancestors 'none'`, `nosniff`, `Cross-Origin-Resource-Policy: same-origin`, HSTS when `COOKIE_SECURE=true`. |

## 2. Route metadata, access and the authz matrix

Every route must declare who may call it in `config.access`; the app refuses to boot otherwise
(`Route GET /x has no access metadata`).

```ts
import { access } from '../http/access.js'
import { z } from '../http/zod.js'   // Zod 4 for anything attached to a route

app.get('/invoices', { config: { access: access.perm('pay.reports') }, schema: { querystring: paginationQuery } }, handler)
```

| Helper | Meaning |
|---|---|
| `access.perm('a', 'b')` | Signed in and holds every listed permission key |
| `access.anyPerm('a', 'b')` | Signed in and holds at least one |
| `access.authenticated()` | Any signed-in user |
| `access.public(reason)` | No session; the reason is mandatory |
| `access.webhook(provider)` | Signed provider callback under `/hooks`; exempt from Origin, CSRF and idempotency |

Boot-time checks (all in `src/http/hooks.ts`): access present; `public` has a reason; `perm` lists at least one key and,
when the Authorizer declares `knownPermissions`, only known keys (typos fail at boot); `idempotency: 'required'` routes
use `idempotentHandler`; webhook routes do not ask for idempotency. `app.routeRegistry` exposes every declared route
(`method`, `url`, `access`, `idempotency`) for the authz-matrix test.

Request pipeline (`onRequest`): request id header, Origin check on unsafe methods, session resolution through the
`Authorizer`, permission check, CSRF verification. `preHandler`: Idempotency-Key presence and format.

The auth/RBAC module implements the `Authorizer` port (`src/http/authorizer.ts`): `resolve(req)` turns the session cookie
into an `AuthContext { userId, employeeId, locationId, permissions, limits, ... }`, `requirePerm`, optional
`canSubscribe` (SSE channels), optional `verifyCsrf` (synchronizer token). Until it exists `src/server.ts` fails closed
(401 everywhere non-public); `DEV_AUTH_BYPASS=true` gives local development a permissive user (refused in production).
For view-as sessions `permissions` are those of the viewed role and `realUserId` is the real actor; `auditContextOf(req)`
records the real actor with `viewAsRoleId`.

CSRF layer 1 (platform): on `POST/PUT/PATCH/DELETE` the `Origin` (or `Referer`) must be the dashboard origin, the API
origin or one of `ALLOWED_ORIGINS`; a request with a cookie and neither header is rejected; a request with no cookie
cannot be forged cross-site and is allowed (403 `ORIGIN_NOT_ALLOWED`). Layer 2 is the Authorizer's `verifyCsrf`.

## 3. Errors (RFC 9457)

Errors are `application/problem+json`:

```json
{ "type": "urn:oasis:problem:slot-unavailable", "title": "Slot unavailable", "status": 409,
  "code": "SLOT_UNAVAILABLE", "detail": "Would overbook a bay \u2014 override required",
  "errors": [{ "path": "body.items[0].qty", "message": "..." }], "requestId": "...", "meta": {} }
```

`code` is the machine-readable key. For guard failures `title` and `detail` are exactly the design's toast strings; the
dashboard toasts them unchanged. Copy lives in the catalog in `src/platform/errors.ts`; a vertical adds its codes with
`registerProblems({ CODE: { status, title, detail } })` (placeholders like `{n}` are filled from `params`) and throws
`new AppError('CODE', { params })`. Unknown errors become 500 `INTERNAL` with no internal detail (the cause is logged).

| Status | Codes (platform) |
|---|---|
| 400 | `MALFORMED_REQUEST`, `INVALID_CURSOR`, `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_INVALID` |
| 401 | `UNAUTHENTICATED` |
| 403 | `FORBIDDEN` (meta: `required`, `mode`), `ORIGIN_NOT_ALLOWED` |
| 404 | `NOT_FOUND`, `ROUTE_NOT_FOUND` |
| 409 | `STALE_STATE`, `IDEMPOTENCY_IN_FLIGHT`, `CONCURRENT_UPDATE`, `BAY_BUSY`, `NO_BAY_FREE`, `SLOT_UNAVAILABLE`, `SLOT_VIP_HELD` |
| 412 | `VERSION_CONFLICT` (meta: `currentVersion`) |
| 413 / 415 | `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE` |
| 422 | `VALIDATION_FAILED` (with `errors[]`), `IDEMPOTENCY_MISMATCH` |
| 429 | `RATE_LIMITED` |
| 500 / 503 | `INTERNAL`, `SERVICE_UNAVAILABLE` |

Zod validation failures are 422 with `errors[].path` such as `body.items[0].qty` or `query.limit`; malformed JSON is 400.
Postgres serialization failures and deadlocks (`40001`, `40P01`) become 409 `CONCURRENT_UPDATE` (safe to retry).

## 4. Idempotency

`Idempotency-Key` (8-128 chars of `A-Za-z0-9._:-`; a UUID is typical) is mandatory on every money-effecting route and on
`POST /appointments` and `POST /emergency/close`, optional elsewhere. **The dashboard generates the key when the sheet or
form opens and reuses it for retries until the action succeeds or is cancelled** (a key generated at submit time would
defeat double-click protection).

Declare it on the route and build the handler with `idempotentHandler`; the command runs inside the idempotency
transaction, so the mutation, its audit row, its realtime event and the stored response commit together:

```ts
app.post('/invoices/:id/refunds',
  { config: { access: access.perm('pay.refund'), idempotency: 'required' }, schema: { body: RefundBody } },
  idempotentHandler(async (req, tx) => {
    const refund = await refunds.create(tx, req.auth!, req.params.id, req.body, auditContextOf(req))
    return { status: 201, body: refund, headers: { Location: `/api/v1/refunds/${refund.id}` } }
  }))
```

| Situation | Result |
|---|---|
| First request | Runs; response stored for 48 h |
| Same key, same method + path + body (key order irrelevant) | Stored response replayed with `Idempotent-Replayed: true` |
| Same key, different method, path or body | 422 `IDEMPOTENCY_MISMATCH` |
| Same key while the first is still running | 409 `IDEMPOTENCY_IN_FLIGHT` with `Retry-After: 1` |
| Command throws | Key released (the transaction rolled back); a corrected retry runs |
| Claim abandoned by a crashed process (older than 2 min) | Reclaimable |
| Different user, same key | Independent (keys are scoped by user) |

Permission and Origin checks run before the claim, so a rejected request never consumes a key. Details and rationale:
ADR 0006.

## 5. Optimistic concurrency

Mutable aggregates carry `version`. Edits send `If-Match: "<version>"` (or `version` in the body for settings); a stale
version is 412 `VERSION_CONFLICT` with `meta.currentVersion`. Commands (advance, collect, ...) lock the row
(`SELECT ... FOR UPDATE`) instead; `advance` additionally requires `expectedStatus` and answers 409 `STALE_STATE` when the
screen is behind. Settings use `updateSetting(tx, { expectedVersion })` (`src/platform/settings.ts`).

## 6. Pagination and CSV

Lists use keyset pagination: `?limit=` (default 100, max 500) and an opaque `?cursor=`; the response is
`{ items, nextCursor }` (`null` on the last page). Build pages with `paginationQuery`, fetch `limit + 1` rows,
`keysetCondition(columns, cursorValues, dir)` and `toPage`. Sort on a unique tuple such as `(occurred_at desc, id desc)`.

CSV (`src/platform/csv.ts`): UTF-8 with BOM, CRLF, RFC 4180 quoting, business-timezone dates, money as plain decimals.
Text cells that start with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'`; numeric columns are exempt.

## 7. Realtime: `GET /api/v1/events` (SSE)

`EventSource` with the session cookie. Query: `channels` (comma separated subset of `ops, payments, messages, settings,
notifications`; default all permitted) and optionally `lastEventId` (browsers send `Last-Event-ID` automatically on
reconnect).

| Channel | Needs | Examples |
|---|---|---|
| `ops` | `sched.view` | `appointment.updated`, `bay.changed`, `kpi.dirty` |
| `payments` | `pay.reports` | `invoice.updated`, `refund.pending` |
| `messages` | `cli.view` | `message.in`, `message.status` |
| `settings` | any user | `settings.changed`, `rbac.changed` |
| `notifications` | self only (events carry `targetUserId`) | `notification.new` |

The Authorizer's `canSubscribe` overrides the table. Channels the caller may not read are dropped, not errors, and
listed in `ready.denied`. Frames:

* default (unnamed) message, one per event: `id: <n>`, `data: {"channel","type","payload","at"}` (payloads are ids plus
  `version`; the client refetches, except messages which carry the full payload);
* `event: ready` first on every connection, data `{channels, denied, cursor, heartbeatMs}`; it carries an `id` only on
  fresh connections;
* `event: resync` when `Last-Event-ID` can no longer be replayed (events older than the 10-minute retention were purged,
  the cursor is ahead of the log after a restore, or it is not a number): data `{reason, latestId}`, `id: latestId`.
  The client must refetch everything; no events are replayed;
* `: hb` comment every 20 s (`SSE_HEARTBEAT_MS`) so proxies keep the stream open;
* `retry: 3000` once at the start.

Resuming replays `id > Last-Event-ID` (same permission filters), then continues live with no gaps or duplicates.
Delivery is at least once across reconnects; clients treat events as "refetch this" hints. Clients should also refetch on
reconnect and on tab visibility and keep a 30-60 s fallback poll. At most 8 concurrent streams per user (429 beyond);
a consumer that falls more than 1 MiB behind is disconnected and resumes with `Last-Event-ID`.

Operations: the stream needs no buffering (`X-Accel-Buffering: no` is sent; nginx also needs `proxy_buffering off` and
`proxy_read_timeout 1h` on `/api/`); Next.js rewrites are not a safe proxy for it (they gzip and time out), so
dashboard and API are served from one origin by the reverse proxy. The CSP (`default-src 'none'`) applies to API
responses only and does not affect `EventSource`.

Publishing (inside the mutation's transaction): `realtime.publish(tx, { locationId, channel, type, payload })`. A trigger
sends `NOTIFY` on commit; a single `RealtimeHub` per process owns ONE dedicated, non-pooled `LISTEN` connection,
reloads new rows (with a 5 s safety-net poll and automatic reconnect plus catch-up) and fans out to subscribers.

## 8. Time, clock freeze and `app_now()`

* Application code reads time only through an injected `Clock`; SQL reads `app_now()`. `Date.now()`, `new Date()`,
  `Date()`, `Math.random()`, Luxon `DateTime.now()/local()/utc()` and SQL `now()`, `current_timestamp`, etc. are banned
  (ESLint rules plus a source scan in `test/unit/time-ban.test.ts`) outside `src/platform/{clock,time,random}.ts`,
  `test/**` and `scripts/**`.
* `app_now()` returns the `oasis.now` GUC when set, else `clock_timestamp()`. All column defaults use it.
* `CLOCK_FREEZE_AT=<ISO instant with offset>` (parity and test environments only; refused when `NODE_ENV=production`)
  makes `createClock` return a `FixedClock` and sets the GUC on every pooled connection (startup option plus a
  `set_config` on each checkout, so a clock that moves is followed). The parity backend runs with its own database,
  `CLOCK_FREEZE_AT=2026-06-13T10:36:00-04:00` and `JOBS_ENABLED=false`.
* `GET /api/v1/meta/now` returns `{ now, tz, bizDate, weekday (0=Sunday), minutes, dateLabel }` from the injected clock.

## 9. Operations endpoints

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | Liveness; no dependencies |
| `GET /readyz` | 200 only when the database answers, every migration on disk is applied and unmodified, and the job queue is healthy; otherwise 503 with per-check detail. Point the external uptime monitor and nginx upstream check here |
| `GET /api/v1/openapi.json` | The OpenAPI 3.1 contract |

Logging: pino JSON, redacting `authorization`, `cookie`, `set-cookie`, passwords, tokens and secrets everywhere, masking
phone numbers and emails at `info` and above (including inside error text), redacting sensitive query parameters in
logged URLs, truncating strings above 8 KiB.

## 10. Webhooks (`/hooks/*`)

Mounted by `hookModules` under `/hooks`; exempt from Origin, CSRF, idempotency and rate limiting; 1 MB body cap; JSON
(`application/json` and `text/plain`, which SNS uses) is parsed into `req.body` and the exact bytes are kept in
`req.rawBody` for signature checks. Register with `webhookRoute(scope, { provider, path, handler })` and verify with
`hmacSha256Hex` + `safeEqual` (constant time). De-duplicate through `webhook_log (provider, external_id)`.
SMS Gate (verified against its docs): `X-Signature` is a hex HMAC-SHA256 over the raw body concatenated with the
`X-Timestamp` value (Unix seconds); non-localhost endpoints must be HTTPS with a valid certificate. The SMS routes must
only be reachable on the tailnet listener.

## 11. Persistence, migrations, seeds, jobs

* `db/migrations/YYYYMMDDHHMMSS_name.sql`, forward-only, applied in lexical order, one transaction each, recorded in
  `schema_migrations` with a checksum, advisory-lock guarded. `pnpm migrate up|status|new <name>`; editing an applied
  migration is refused; a migration that sorts before the last applied one is applied with a warning. First line
  `-- migrate:no-transaction` runs a single statement outside a transaction (`CREATE INDEX CONCURRENTLY`).
* `pnpm db:schema` regenerates `db/schema.sql` (migrations applied to an empty scratch schema, `pg_dump --schema-only`,
  from the `postgresql15` package); `pnpm db:schema:check` compares. Regenerate after merging migrations.
* Platform tables: `locations`, `settings`, `idempotency_keys`, `realtime_events` (+ `realtime_state`), `audit_log`
  (insert-only trigger), `webhook_log`, `notifications`; `ensure_location()` seeds the single location idempotently.
  Typed Kysely table types are in `src/platform/schema.ts`; a vertical adds its tables with
  `declare module '../../platform/schema.js' { interface Database { customers: CustomersTable } }`.
* Settings registry (`src/platform/settings.ts`): typed keys, defaults and validation; versioned, audited writes.
* Seeds: `pnpm seed -- --profile <name>` (see `db/seeds/README.md`).
* Jobs (`src/platform/jobs.ts`, `job-registry.ts`): pg-boss schema `pgboss`; `maintenance.purge` runs every 10 minutes
  (expired idempotency keys, realtime events older than 10 min, webhook log older than 90 days; audit is never purged).
  `JOBS_ENABLED=false` makes the queue inert. The worker is `src/worker.ts`; the API process only produces jobs.

## 12. Tests

`pnpm test` runs everything (`test:unit`, `test:int`); integration tests use the real local Postgres. The `oasis` role has
no `CREATEDB`, so each vitest worker owns a schema `t_<checkout hash>_<worker id>` of `DATABASE_URL_TEST`, migrated with
the real runner and reused while migration checksums match (rebuilt automatically otherwise). Helpers in `test/helpers`:
`useTestDb()`, `createTestApp()` (frozen clock, permissive authorizer, captured logs, optional realtime hub), factories,
`truncateAll`, an SSE client.

## 13. Endpoints

Generated from the route registry by `pnpm openapi`; do not edit between the markers.

<!-- openapi:start -->
| Method | Path | Access | Idempotency-Key |
|---|---|---|---|
| GET | `/api/v1/appointments` | sched.view |  |
| POST | `/api/v1/appointments` | sched.edit | required |
| GET | `/api/v1/appointments/:id` | sched.view |  |
| PATCH | `/api/v1/appointments/:id` | sched.edit |  |
| DELETE | `/api/v1/appointments/:id/addons/:serviceId` | sched.edit |  |
| PUT | `/api/v1/appointments/:id/addons/:serviceId` | sched.edit |  |
| POST | `/api/v1/appointments/:id/advance` | jobs.status | sched.edit |  |
| POST | `/api/v1/appointments/:id/arrive` | jobs.status | sched.edit |  |
| POST | `/api/v1/appointments/:id/assign-bay` | jobs.status |  |
| POST | `/api/v1/appointments/:id/cancel` | sched.cancel | required |
| POST | `/api/v1/appointments/:id/checklist/bulk` | jobs.checklist |  |
| PUT | `/api/v1/appointments/:id/checklist/items/:itemId` | jobs.checklist |  |
| POST | `/api/v1/appointments/:id/complete` | jobs.status |  |
| POST | `/api/v1/appointments/:id/confirm` | sched.edit | jobs.status |  |
| POST | `/api/v1/appointments/:id/membership-perks/apply` | cli.member | required |
| GET | `/api/v1/appointments/:id/messages` | cli.view |  |
| POST | `/api/v1/appointments/:id/messages` | msg.send | required |
| POST | `/api/v1/appointments/:id/no-show` | sched.cancel | required |
| POST | `/api/v1/appointments/:id/notify-ready` | msg.send |  |
| DELETE | `/api/v1/appointments/:id/photos/:photoId` | jobs.checklist |  |
| POST | `/api/v1/appointments/:id/photos/:photoId/complete` | jobs.checklist |  |
| POST | `/api/v1/appointments/:id/photos/note` | jobs.checklist |  |
| POST | `/api/v1/appointments/:id/photos/presign` | jobs.checklist |  |
| POST | `/api/v1/appointments/:id/pickup` | jobs.status |  |
| POST | `/api/v1/appointments/:id/prep-bay` | jobs.status | sched.edit |  |
| POST | `/api/v1/appointments/:id/reopen` | sched.cancel |  |
| POST | `/api/v1/appointments/:id/reschedule` | sched.edit |  |
| POST | `/api/v1/appointments/:id/start` | jobs.status |  |
| GET | `/api/v1/arrival-settings` | authenticated |  |
| PUT | `/api/v1/arrival-settings` | cli.member |  |
| GET | `/api/v1/auth/csrf` | authenticated |  |
| POST | `/api/v1/auth/invite/accept` | public |  |
| POST | `/api/v1/auth/login` | public |  |
| POST | `/api/v1/auth/logout` | authenticated |  |
| POST | `/api/v1/auth/password/change` | authenticated |  |
| POST | `/api/v1/auth/password/forgot` | public |  |
| POST | `/api/v1/auth/password/reset` | public |  |
| GET | `/api/v1/availability` | sched.view |  |
| GET | `/api/v1/bays` | sched.view |  |
| PATCH | `/api/v1/bays/:id` | sched.override |  |
| GET | `/api/v1/calendar/day` | sched.view |  |
| GET | `/api/v1/calendar/summary` | sched.view |  |
| GET | `/api/v1/clients/:id/credit` | pay.reports |  |
| GET | `/api/v1/closures` | authenticated |  |
| POST | `/api/v1/closures` | set.hours | optional |
| DELETE | `/api/v1/closures/:id` | set.hours |  |
| PATCH | `/api/v1/closures/:id` | set.hours |  |
| POST | `/api/v1/closures/preview` | set.hours |  |
| GET | `/api/v1/customers` | cli.view |  |
| POST | `/api/v1/customers` | sched.edit |  |
| GET | `/api/v1/customers/:id/membership` | cli.view |  |
| GET | `/api/v1/customers/:id/messages` | cli.view |  |
| POST | `/api/v1/customers/:id/messages/read` | msg.send |  |
| GET | `/api/v1/customers/:id/sms-consent` | cli.view |  |
| PUT | `/api/v1/customers/:id/sms-consent` | cli.edit |  |
| GET | `/api/v1/emergency` | authenticated |  |
| GET | `/api/v1/emergency/:id/affected` | set.emergency |  |
| POST | `/api/v1/emergency/close` | set.emergency | required |
| GET | `/api/v1/emergency/history` | set.emergency |  |
| GET | `/api/v1/emergency/preview` | set.emergency |  |
| POST | `/api/v1/emergency/reopen` | set.emergency | optional |
| GET | `/api/v1/employees` | team.view |  |
| POST | `/api/v1/employees` | team.edit |  |
| GET | `/api/v1/employees/:id` | team.view |  |
| PUT | `/api/v1/employees/:id` | team.edit |  |
| POST | `/api/v1/employees/:id/deactivate` | team.edit |  |
| GET | `/api/v1/employees/:id/effective-permissions` | team.view |  |
| POST | `/api/v1/employees/:id/invite/resend` | team.edit |  |
| POST | `/api/v1/employees/:id/password-reset` | team.edit |  |
| POST | `/api/v1/employees/:id/reactivate` | team.edit |  |
| GET | `/api/v1/events` | authenticated |  |
| GET | `/api/v1/integrations/sms/devices` | set.billing |  |
| POST | `/api/v1/integrations/sms/devices` | set.billing |  |
| PATCH | `/api/v1/integrations/sms/devices/:id` | set.billing |  |
| GET | `/api/v1/integrations/sms/devices/:id/health` | set.billing |  |
| POST | `/api/v1/integrations/sms/devices/:id/register-webhooks` | set.billing |  |
| POST | `/api/v1/integrations/sms/devices/:id/test` | set.billing |  |
| POST | `/api/v1/integrations/squarespace/alerts/:id/resolve` | set.billing |  |
| DELETE | `/api/v1/integrations/squarespace/connection` | set.billing |  |
| PUT | `/api/v1/integrations/squarespace/connection` | set.billing |  |
| PUT | `/api/v1/integrations/squarespace/customer-links/:sqspCustomerId` | set.billing |  |
| GET | `/api/v1/integrations/squarespace/orders` | set.billing | pay.collect |  |
| POST | `/api/v1/integrations/squarespace/orders/:id/ignore` | pay.collect | required |
| POST | `/api/v1/integrations/squarespace/orders/:id/match` | pay.collect | required |
| GET | `/api/v1/integrations/squarespace/product-map` | set.billing |  |
| PUT | `/api/v1/integrations/squarespace/product-map` | set.billing |  |
| GET | `/api/v1/integrations/squarespace/status` | set.billing |  |
| POST | `/api/v1/integrations/squarespace/sync-now` | set.billing |  |
| GET | `/api/v1/invoices/:id` | pay.reports |  |
| POST | `/api/v1/invoices/:id/adjustments` | pay.adjust | required |
| POST | `/api/v1/invoices/:id/credit-applications` | pay.collect | required |
| POST | `/api/v1/invoices/:id/credits` | pay.credit | required |
| POST | `/api/v1/invoices/:id/payment-links` | pay.collect | required |
| POST | `/api/v1/invoices/:id/payments` | pay.collect | required |
| POST | `/api/v1/invoices/:id/receipt` | msg.send | pay.collect | required |
| POST | `/api/v1/invoices/:id/refunds` | pay.refund | required |
| POST | `/api/v1/invoices/:id/refunds/:eventId/approve` | pay.refund | required |
| POST | `/api/v1/invoices/:id/refunds/:eventId/deny` | pay.refund | required |
| PUT | `/api/v1/invoices/:id/tip` | pay.collect | required |
| POST | `/api/v1/invoices/:id/void` | pay.void | required |
| POST | `/api/v1/ledger-events/:id/confirm-processor` | pay.collect | pay.refund | required |
| GET | `/api/v1/me` | authenticated |  |
| PUT | `/api/v1/me/preferences` | authenticated |  |
| POST | `/api/v1/me/view-as` | authenticated |  |
| GET | `/api/v1/memberships` | cli.member |  |
| POST | `/api/v1/memberships` | cli.member |  |
| PATCH | `/api/v1/memberships/:id` | cli.member |  |
| POST | `/api/v1/messages/:id/cancel` | msg.send |  |
| POST | `/api/v1/messages/:id/retry` | msg.send |  |
| GET | `/api/v1/messages/inbox` | msg.send |  |
| POST | `/api/v1/messages/inbox/:id/review` | msg.send |  |
| GET | `/api/v1/messages/outbox` | msg.send |  |
| GET | `/api/v1/messages/templates` | msg.send |  |
| GET | `/api/v1/meta/now` | public |  |
| GET | `/api/v1/openapi.json` | public |  |
| GET | `/api/v1/ops/alerts` | sched.view |  |
| GET | `/api/v1/ops/kpis` | sched.view |  |
| GET | `/api/v1/ops/snapshot` | sched.view |  |
| GET | `/api/v1/payments/approvals` | pay.reports |  |
| GET | `/api/v1/payments/export.csv` | pay.reports |  |
| GET | `/api/v1/payments/invoices` | pay.reports |  |
| GET | `/api/v1/payments/reconciliation` | pay.reports | set.billing |  |
| GET | `/api/v1/payments/summary` | pay.reports |  |
| GET | `/api/v1/roles` | team.view |  |
| POST | `/api/v1/roles` | team.roles |  |
| DELETE | `/api/v1/roles/:id` | team.roles |  |
| PATCH | `/api/v1/roles/:id` | team.roles |  |
| PUT | `/api/v1/roles/:id/limits/:kind` | team.roles |  |
| PUT | `/api/v1/roles/:id/permissions/:key` | team.roles |  |
| GET | `/api/v1/services` | authenticated |  |
| POST | `/api/v1/services` | set.services | optional |
| PATCH | `/api/v1/services/:id` | set.services |  |
| PUT | `/api/v1/services/:id/checklist` | set.services |  |
| PUT | `/api/v1/settings/auto-federal-holidays` | set.hours |  |
| GET | `/api/v1/settings/bundle` | authenticated |  |
| GET | `/api/v1/settings/hours` | authenticated |  |
| PUT | `/api/v1/settings/hours` | set.hours |  |
| GET | `/api/v1/settings/rules` | authenticated |  |
| PUT | `/api/v1/settings/rules` | set.hours |  |
| GET | `/api/v1/staff` | sched.view |  |
| GET | `/api/v1/vip` | authenticated |  |
| PUT | `/api/v1/vip` | cli.member |  |
| GET | `/api/v1/vip/clients` | cli.member |  |
| POST | `/api/v1/vip/clients` | cli.member |  |
| DELETE | `/api/v1/vip/clients/:customerId` | cli.member |  |
| POST | `/api/v1/vip/holds` | cli.member |  |
| DELETE | `/api/v1/vip/holds/:id` | cli.member |  |
| POST | `/hooks/squarespace` | webhook:squarespace |  |
<!-- openapi:end -->

## 14. Identity: sign-in, sessions, RBAC, employees and roles

Code: `src/modules/auth` (sessions, flows, authorizer), `src/modules/rbac` (permission catalog, engine), `src/modules/people`
(employees, roles, business-hours port). ADRs: 0008 (sessions and CSRF), 0009 (view-as), 0010 (limit storage).

### 14.1 Session and CSRF model

| Topic | Rule |
|---|---|
| Cookie | Name `SESSION_COOKIE_NAME` (`oasis_sid`); `__Host-oasis_sid` when `NODE_ENV=production` and `COOKIE_SECURE=true` (the browsers only accept that prefix on Secure cookies; the dashboard's "is there a session cookie" check must use `sessionCookieName(env)`). `HttpOnly; SameSite=Lax; Path=/`, `Secure` when `COOKIE_SECURE`, `Expires` = the absolute expiry. Value = opaque 256-bit token (43 chars). |
| Server state | `sessions.id` = hex sha256 of the token (a database read yields no usable session), `user_id`, `idle_expires_at` (12 h, sliding; rewritten at most once a minute), `absolute_expires_at` (14 d, never extended), `ip`, `ua`, `csrf_secret`, `view_as_role_id`, `revoked_at`. |
| Rotation | Login always creates a new session and revokes the session of the cookie it arrived with. A password change or reset revokes the person's other sessions (reset: all of them); deactivating an employee revokes all of theirs. |
| CSRF | Layer 1 is the platform Origin/Referer check. Layer 2 is the synchronizer token: `GET /auth/csrf` (also in the login response and `GET /me`) returns it, send it as `X-CSRF-Token` on every unsafe request of a signed-in caller (403 `CSRF_INVALID` otherwise). It is an HMAC of the session id under the session's own secret, so it is bound to the session. |
| Throttling | Per client IP (10 free failures, then 1, 2, 4 ... s, cap 120 s) and per account (4 free failures, then 1, 2, 4 ... s, cap 30 s). A throttled attempt is answered 429 `LOGIN_THROTTLED` with `Retry-After` **without evaluating the password**, and does not extend the wait. There is no hard lock: a known email is never locked out for minutes. Counters decay after 15 quiet minutes; a success clears the account counter. In-memory per process. Plus 30 logins/min per IP from the rate limiter. |
| Errors | Wrong password and unknown email are the same 401 `INVALID_CREDENTIALS` ("Email or password is incorrect"); a correct password on a deactivated account is 403 `ACCOUNT_DISABLED`. |
| Passwords | `node:crypto` scrypt, PHC-style `$scrypt$ln=15,r=8,p=3$<salt>$<hash>` (OWASP cost). Parameters are read from the stored string; `needsRehash` upgrades at the next login. 12-128 characters. |

### 14.2 Auth endpoints (`/api/v1`)

| Endpoint | Notes |
|---|---|
| `POST /auth/login` `{email, password}` | Sets the cookie; `{user:{id,employeeId,email,name}, csrfToken}`. |
| `POST /auth/logout` | 204; revokes the session, clears the cookie. |
| `GET /auth/csrf` | `{csrfToken}`. |
| `POST /auth/invite/accept` `{token, email, password}` | **Email is required** (employees may have none until now). Sets the email, creates the login, activates the employee, signs them in. 410 `INVITE_INVALID` for unknown, used, revoked or expired (7 d) tokens; 409 `EMAIL_TAKEN`. |
| `POST /auth/password/forgot` `{email}` | Always 202 `{accepted:true}`; a known active account gets a 1-hour link through the NotificationPort (at most one per minute per account). |
| `POST /auth/password/reset` `{token, password}` | Single use; revokes every session of the account. 410 `RESET_INVALID`. |
| `POST /auth/password/change` `{currentPassword, newPassword}` | Revokes all other sessions. 422 `CURRENT_PASSWORD_INVALID`. |
| `GET /me` | `{user, employee, roles, displayRole, isSuperAdmin, permissions:{key:{on,limit?}}, limits:{refund?,adjust?,credit?}, rbacVersion, preferences:{theme}, viewAs:{active,canViewAs,roleId,roleName,options[]}, csrfToken, session:{expiresAt}}`. `limit`/`limits` are cents, `null` = No limit, and are present only for money permissions that are on. `roles`, `permissions` and `limits` describe the **effective** authority (the viewed role under view-as); `isSuperAdmin` is the real person. `viewAs.options` lists every role (with limits) for a Super Admin so the menu works even while viewing a role that cannot read `/roles`. |
| `PUT /me/preferences` `{theme:'light'|'dark'}` | Per user; `preferences.theme` is `null` until set. |
| `POST /me/view-as` `{roleId|null}` | See 14.4. Returns the new `/me`. |

Links delivered to people: `${PUBLIC_DASHBOARD_URL}/invite?token=...` and `${PUBLIC_DASHBOARD_URL}/reset-password?token=...`
(`accountLink()` in `notifications.ts`). Delivery goes through `NotificationPort.deliver(message)`; the in-memory
implementation records messages and reports `delivered:false` (the SMS/email wiring comes later, see 14.8).

### 14.3 Effective permissions (the RBAC engine)

`effective(employee)` (`src/modules/rbac/engine.ts`, a port of Settings `eff()`):

* permissions are the **union** over the person's roles;
* a money limit (`pay.refund` -> refund, `pay.adjust` -> adjust, `pay.credit` -> credit) is the **highest limit among only the roles that grant that permission**; `null` (No limit) wins; a granting role with no `role_limits` row counts as **2500 cents**;
* a per-person **Deny beats everything** (even Super Admin); an **Allow** keeps the roles' limit when a role grants the permission, otherwise it gets 2500; the locked role grants everything and is unlimited whatever rows it has (keyed off `is_locked`, not the name);
* source labels: `via Management + Accounting · ≤ $1,000`, `Exception · allowed · ≤ $25`, `Exception · denied`, `Not included in assigned roles`.

Requests resolve authority from `rbac_state.version` (read in the same query as the session) and an in-process cache keyed by
`(employee, version)`. Every change to roles, grants, limits, overrides or a person's roles bumps the version in its own
transaction and publishes `rbac.changed` on the `settings` realtime channel, so a change applies to signed-in people on
their next request and clients can refetch `/me`.

For other modules: `access.perm('x')` on the route; in a handler `req.auth` carries `permissions`, `limits` (cents; `null` =
unlimited; compare `amount > limit`), `actorName`, `roles` (names), `viewAsRoleId` and `realUserId`. `sessionContext(req)`
(`src/modules/auth/context.ts`) returns the richer `SessionAuthContext` (`employee`, `isSuper`, `canViewAs`, `viewAsRole`,
`authority`). `auditContextOf(req)` records the real actor and the viewed role. `employeeId` is always the real person, so a
self-approval check (requester vs approver) cannot be bypassed by viewing as another role. `maskContact(ctx, {phone,email})`
and `searchMayMatchContact(ctx)` (`src/modules/people/redact.ts`) implement the `cli.contact` redaction for read models and
search.

### 14.4 View-as

`POST /me/view-as {roleId|null}` is allowed only when the **real** identity holds the locked Super Admin role (checked on
every call from the real roles, independent of the role being viewed, so a Super can always exit). While active:

* authority is the viewed role **only** (no per-person exceptions, in either direction), for reads and writes alike, and can never exceed Super (it is some role's permissions); `isSuper` is false unless the viewed role is the locked one, so limits, Super assignment and Super-only grants stay closed;
* the choice lives on the session row, survives reloads, ends with the session and is ignored if the person stops being Super;
* audit rows keep the real actor and set `view_as_role_id`; `GET /me` shows `viewAs.active`.

### 14.5 Employees

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /employees?q=&role=` | `team.view` | `q` matches first, last, full name, phone, title and role names, **not email**. `role` is a role id or built-in key. Pay type and rate are `null` without `team.edit`; phone/email are masked, and phone is not searchable, without `cli.contact` or `team.edit`. `{items}` (no paging; the list is small). |
| `GET /employees/:id` | `team.view` | Adds `schedule[7]`, `overrides`, `effectivePermissions[27]` (`{key,module,label,on,src,ov,limit?}`), `allowedCount`; `ETag: "<version>"`. |
| `POST /employees` | `team.edit` (+ `team.roles` for roles other than Crew or any exception) | Creates as `invited`, sends the invite. Roles default to Crew; schedule defaults to Mon-Fri 8-6 trimmed to the business hours. Body fields: `first,last,title,phone,email,roles[],employmentType,payType,rateText,skills[],schedule[{weekday,on,fromMin,toMin}],overrides{key:allow|deny},avatarColor`. Roles are ids or built-in keys. 201 `{employee, warnings[], invite:{sent,channel,expiresAt,link?}}`. |
| `PUT /employees/:id` | `team.edit` (+ `team.roles` when roles or exceptions change) | **`If-Match: "<version>"` required** (428 `PRECONDITION_REQUIRED`, 412 `VERSION_CONFLICT` with `meta.currentVersion`). Omitted fields are unchanged. Changing the phone or email of a Super Admin, or of anyone whose roles or exceptions grant `set.billing` or `pay.void`, needs a Super Admin (403 `SUPER_ONLY`; a person may still edit their own contact details): whoever controls those controls the invite, reset and sign-in. Changing your own roles or exceptions also needs a Super Admin, so a restriction someone else put on you stays. |
| `POST /employees/:id/deactivate` / `reactivate` | `team.edit` | Deactivate revokes sessions and disables the login. Reactivate restores `active` for someone who ever accepted an invite, otherwise `invited`. Both idempotent. |
| `POST /employees/:id/invite/resend` | `team.edit` | Revokes older links; 409 `INVITE_NOT_PENDING` unless the status is `invited`. |
| `POST /employees/:id/password-reset` | `team.edit` | Sends the person a 24-hour reset link; 409 `NO_LOGIN_YET`. The response carries `link` only for a Super Admin and only when no channel delivered it: a manager must not be able to read a link that lets them become that person. |
| `GET /employees/:id/effective-permissions` | `team.view` | `{items, allowedCount, total}`. |

Validation (422 `VALIDATION_FAILED`, `detail` = the design string, `errors[].path` = the field): `First name and mobile number are required.`,
`Assign at least one role.`, `Enter a valid mobile number.` (phone is normalised to E.164 in `phoneE164`), and for schedules
`{Day}: availability must sit inside business hours ({from} – {to}).` (`(closed)` for a closed day), produced through the
`BusinessHoursPort` (`src/modules/people/business-hours.ts`). When no hours are configured the schedule is saved and the
response carries a warning instead. Email must be unique across employees and logins (409 `EMAIL_TAKEN`).

### 14.6 Roles

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /roles` | `team.view` | `{roles[{id,key,name,description,locked,custom,peopleCount,permissionCount,version}], permissions[27], matrix{roleId:{key:bool}}, limits{roleId:{refund,adjust,credit}} (cents, null = No limit, default 2500 applied), limitChoicesCents, rbacVersion}`. |
| `POST /roles` | `team.roles` | `{name?, description?}`; default name `Shift Lead`, then `Shift Lead 2`...; copies Crew plus `sched.edit`; limits 25/25/25; 201. An explicit duplicate name is 409 `ROLE_NAME_TAKEN`. |
| `PATCH /roles/:id` | `team.roles` | Rename/describe; the locked role answers 409 `ROLE_LOCKED`. Optional `If-Match`. |
| `PUT /roles/:id/permissions/:key` `{granted}` | `team.roles` | Idempotent. Locked role: 409 `ROLE_LOCKED` ("Super Admin always has every permission"). Granting `set.billing` or `pay.void` needs a Super Admin. |
| `PUT /roles/:id/limits/:kind` `{value}` | `team.roles` + Super Admin | `value` in 25, 50, 100, 250, 500, 1000 (dollars) or `null`; stored in cents. 403 `SUPER_ONLY` for anyone else, 409 `ROLE_LOCKED` for the locked role. |
| `DELETE /roles/:id` | `team.roles` | Custom roles only (409 `ROLE_NOT_REMOVABLE`). Strips the role from people, assigns Crew to anyone left with no role, drops exceptions of those people that became no-ops (an Allow a remaining role already grants, a Deny of something no remaining role grants; what they can do is unchanged), returns `{removed, affected, reassignedToCrew}`. |

### 14.7 Invariants

* At least one **active** Super Admin always exists: deactivating or demoting the last one is 409 `LAST_SUPER_ADMIN` (the check runs under a row lock on the locked role, so two concurrent demotions cannot both succeed).
* Only a Super Admin (acting as one, not while viewing a lesser role) may: change limits; assign the Super role; assign a role that carries `set.billing` or `pay.void`; grant a Super-only permission by role or per-person Allow; change the roles/exceptions of, deactivate or reactivate a Super Admin. Everything else needs only the permission in the table (403 `SUPER_ONLY`).
* Nobody can deny themselves `team.roles` (422 `SELF_DENY_ROLES`).
* The locked role rejects permission and limit edits.

### 14.8 Operations: bootstrap, CLI, seeds, wiring

* **Bootstrap**: with `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` (min 12 chars) set and no user in the database, `server.ts` creates the Super Admin (and the five built-in roles) at boot. Safe on every boot.
* **CLI**: `pnpm user:create -- --email a@b.c --first Amara --last Okoye [--phone ...] [--title ...] [--roles super,mgmt] [--password-env VAR | --password-stdin]` (no password on the command line; prompts with echo off). Adds a login to an existing employee with that email.
* **Seeds**: `pnpm seed -- --profile people` creates the five roles with the design's grants and limits and the seven design employees (Sofia's `sched.override` exception, Kevin invited, schedules from the design's `sch()`); it creates no passwords. With `SEED_DEV_PASSWORD` set (refused in production) the six active employees also get a login with that password, emails `first@oasisautospa.com`.
* **Wiring left for later**: pass a real `NotificationPort` (SMS Gate then SES) and the Settings module's `BusinessHoursPort` to `createIdentity()` in `src/server.ts`; until then invite/reset links are not delivered (a Super Admin gets them in the response; a startup warning says so).
* **Tests**: `test/auth`, `test/rbac`, `test/people`, `test/authz-matrix`; `test/auth/harness.ts` builds the real app with the real authorizer (`useHarness()`).

## 15. Settings: hours, rules, closures, emergency, VIP, arrival and services

Code: `src/modules/settings/http` (routes, runtime, emergency commands), `src/modules/catalog/http` (services),
`src/modules/customers/http` (VIP clients), `src/modules/settings/db-adapters` (DB ports, recording notifiers, crew alert) and
`src/modules/settings/jobs`. Services underneath: `src/modules/settings/*.ts`, `src/modules/catalog/service.ts`. ADRs 0030-0033.
Every mutation runs in one transaction, writes an `audit_log` row and publishes `settings.changed {section}` (the emergency
also publishes on `ops`). The generated table in section 13 is the endpoint list; this section is the behaviour.

### 15.1 Reading, saving and versions

| Topic | Rule |
|---|---|
| Reads | Every `GET` is open to any signed-in user except `GET /vip/clients` (`cli.member`) and `GET /emergency/history`, `GET /emergency/preview`, `GET /emergency/{id}/affected` (`set.emergency`). `GET /services?includeInactive=true` needs `set.services`. |
| Versions | Each GET sets `ETag: "<version>"`. Hours and rules share one version (`booking_rules.version`). `PUT /settings/hours` **requires** it (body `version` or `If-Match`; 428 `PRECONDITION_REQUIRED` without, 412 `VERSION_CONFLICT` with `meta.currentVersion` when stale). Every other settings write takes it **optionally** and enforces it when sent: rules, VIP, arrival, federal toggle, checklists, catalog edits. |
| Rules save at once | `PUT /settings/rules` saves one chip (`slot`, `buffer`, `cutoff`; also `onlineLeadMinutes`, `allowOverrun`, `autoPlanBay`) and returns the new shared version. The Save/Discard bar of Working hours only covers the days; a rule click made while hours are unsaved moves the version, so the editor must adopt the returned version (or reload) before its own save. |
| Times | Hours and closure windows accept `"8:00 AM"` text (`from`/`to`) or minutes (`fromMin`/`toMin`); responses carry both. A day or closure sent with both forms must agree (422), so a loaded object can be edited and sent back. Closed days keep their times. |
| Round trip | `PUT /settings/hours` ignores the read-only fields of `GET /settings/hours` (`day`, `len`, `lenMinutes`, `weekHours`, `weekMinutes`, `federalAuto`). |
| Labels | `weekHours` is the design label (`"65 hrs"`, `"58.5 hrs"`), `len` per day likewise (`"0 hrs"` when closed); `weekMinutes`/`lenMinutes` are numbers. |

### 15.2 Working hours and closures

| Endpoint | Behaviour |
|---|---|
| `GET /settings/hours` | `{days[7] {weekday, day, open, from, to, fromMin, toMin, len, lenMinutes}, rules {slot, buffer, cutoff, ...}, weekHours, weekMinutes, federalAuto, version}`; `days` is Sunday first, the dashboard orders Monday first. |
| `PUT /settings/hours` | All seven days; validation messages are `"Tuesday: closing time must be after opening time."`, `"...use 30-minute steps."`, `"...hours must be between 5:00 AM and 11:30 PM."`. Returns the saved view plus `changed` and `warnings {employeeScheduleConflicts[], appointmentsOutsideHours[]}` (employees whose schedule no longer fits; upcoming booked/confirmed/arrived appointments outside the new hours). Nothing is moved. Employee schedules are validated against these stored hours (the people module's `BusinessHoursPort` is the DB adapter). |
| `GET /closures?from=&to=` | `{federalAuto, upcoming (date asc), past (newest first)}`; each row `{id, date, mon, day, dow, name, type, from, to, fromMin, toMin, notify, source, emergency, federalKey, typeLabel, affectedCount, subLine, past}`. `affectedCount` is real (closed day: non-canceled appointments; reduced: those outside the window; `null` for past rows) and `subLine` the design sentence with it. |
| `POST /closures/preview` | `{affected}` for `{date, type, from?, to?}`. |
| `POST /closures` | 201 `{closure, affectedCount, notified}`. 422 `CLOSURE_INCOMPLETE` "Add a date and a name." (title "Check the form") for a missing or blank date or name; 422 `CLOSURE_DATE_TAKEN` "There's already a closure on that date."; `notify` defaults true and messages reachable booked/confirmed customers once, at creation. `Idempotency-Key` optional. |
| `PATCH /closures/{id}` | `{notify, name, type, from, to}`; `notify` only stores the flag (nothing is sent later); emergency rows answer 409 `CLOSURE_LOCKED`. |
| `DELETE /closures/{id}` | Soft delete, sends nothing, a removed federal holiday is never regenerated. `{id, name, date, removed: true}`. |
| `PUT /settings/auto-federal-holidays` | `{enabled}`; enabling generates this year and next in the same transaction (closed days, `notify` off, past dates and holidays that already have a closure skipped). Job `federal_holidays.generate` does the same on Jan 1 and at startup. |

### 15.3 Emergency closing

| Endpoint | Behaviour |
|---|---|
| `GET /emergency` | Any signed-in user: `{active, summary, counters {affected, notified, rebooked, booking}, current, strip, history, canClose, closeRoleNames, requirement, options}`. `strip` is live: `{openNow, text, todayHours, appointmentsRemaining, vehiclesOnSite, ...}` with `text` reading `"Open now · Saturday 8:00 AM – 5:00 PM · 6 appointments left today, 3 vehicles on site"`. `canClose`/`closeRoleNames` ("Management", "Super Admin") replace the static access line; `history` is null without `set.emergency`. |
| `GET /emergency/preview` | `?reason&dur&until&through[&message&notify&link&pause]`; `reason` is the chip label or key, `dur` is `today`/`until`/`days` (`through` is accepted for `days`), `until` is `"2:00 PM"`. `{count, affected[{time, customerName, vehicle, bizDate, dateLabel, status}], onSite[], summary, untilText, renderedMessage, endsAt}`. No contact data is returned. |
| `POST /emergency/close` | **Idempotency-Key required** (replay: same response, `Idempotent-Replayed: true`; same key, other body: 422 `IDEMPOTENCY_MISMATCH`). One transaction: 409 `EMERGENCY_ACTIVE`; 422 `EMERGENCY_NOTHING_TO_CLOSE` for "rest of today" once the shop has closed or on a day it is not open; 422 for a reopening time that is not later than now and for a last day more than 60 days out. Writes the emergency row and closure rows (replacing planned ones for later restore), flags booked and confirmed appointments in the window (multi-day: every day through the last), records the message per customer (`sms`, `email`, or `skipped_opt_out`/`no_contact`), alerts on-shift crew, schedules `emergency.auto_reopen` at the end time. 201 `{summary, notifiedCount, skipped, affected[], onSite[], closuresCreated[], emergency}`. Vehicles already on site are reported, never touched. |
| `POST /emergency/reopen` | Soft-deletes today's and future emergency closure rows (days already over stay), restores replaced planned closures, writes history `"Reopened by {name} · {n} notified"` with real counters. 409 `EMERGENCY_NOT_ACTIVE` when nothing is active. Events on `ops`: `emergency.started`, `emergency.ended` (service) and `emergency.reopened` (command), all on one reopen. |
| `GET /emergency/history`, `GET /emergency/{id}/affected` | `set.emergency`; the second is the "needs rebooking" queue (booked or confirmed appointments of that emergency not yet rebooked). |

Notification fan-out is behind ports (`ClosureNotifier`, `EmergencyNotifier`, `EmergencyEffects`): today they write an
`activity_log` line per appointment and an audit row and report `queued`; the SMS wave replaces them with
`configureSettings({...})` in `src/server.ts`. Reschedule links appear in messages only when `RESCHEDULE_LINK_ENABLED=true`.

### 15.4 VIP, arrival and services

| Endpoint | Behaviour |
|---|---|
| `GET/PUT /vip` | Flat design keys `{release, windowVip, windowStd, sameDay, waitlist, offerMin, standing, autoConfirm, cadences}` plus `cadenceOptions`, `holds[]` (Monday first), `counts`, `version`. `PUT` is partial (`cli.member`); windows are ranges 7-90 and 7-60, not multiples of 7. |
| `POST /vip/holds`, `DELETE /vip/holds/{id}` | `{weekday, time | timeMin}`; 201 `{hold, toast: "Sat 11:00 AM held for VIPs"}`; duplicate 409 `VIP_HOLD_EXISTS` with title and detail "That slot is already held". |
| `GET/POST/DELETE /vip/clients` | By `customerId`, or by `name`: exactly one exact case-insensitive match is added (201, toast "{name} is now VIP"); several matches or only partial ones answer 409 `VIP_CLIENT_AMBIGUOUS` with `meta.candidates` (id, name, vehicles, `alreadyVip`, last-four phone hint only with `cli.contact`); no match is 404 `VIP_CLIENT_NOT_FOUND`; already VIP is 200 `added: false`. |
| `GET/PUT /arrival-settings` | `{on, radius, prepAt, autoArrive, welcome, crew, vipFirst, version}`; `PUT` partial (`cli.member`). |
| `GET /services` | Packages and add-ons with `tasks[{id, label, position}]`, `version`, `taskCount`. |
| `PUT /services/{id}/checklist` | `{tasks: [{id?, label} | string], version?}`: the whole ordered list, trimmed, blanks dropped; ids are stable (rename and reorder keep them; see ADR 0021 for the tie-break); removed tasks are retired. Calls the `ChecklistSync` port (default no-op). |
| `POST /services`, `PATCH /services/{id}` | Name, price (cents), duration (packages only), `bookableDesk`, `active`, tags, sort. Appointments keep their own snapshot. |
| `GET /settings/bundle` | `{hours, rules, federalAuto, closures {upcoming, past}, emergency, vip, arrival, services, counts {employees}, omitted[]}`: the Settings screen in one call. Parts that need more than a session are left out and named in `omitted`: `emergency.history` (`set.emergency`), `vip.clients` (`cli.member`), `counts.employees` (`team.view`). |

### 15.5 Jobs

| Job | Trigger | Behaviour |
|---|---|---|
| `federal_holidays.generate` | cron `5 0 1 1 *` (business tz), at API startup, on demand | Current and next year per location; years with a `federal_holiday_runs` row are skipped in catch-up mode; idempotent through the unique federal key. |
| `emergency.auto_reopen` | delayed to `ends_at` when the shop closes (`singletonKey` = emergency id) | Reopens that emergency when its end time has passed. |
| `emergency.sweep` | hourly cron and at API startup | Backstop: reopens any active emergency whose end time passed. |

Handlers take the injected `Clock`; tests move a `FixedClock` (`test/settings-http/jobs.test.ts`).

### 15.6 Tests and the oracle

`pnpm test:settings` runs `test/settings-http` (real Postgres). `oracle.test.ts` compares the API with values read from the
original Settings prototype (`test/fixtures/golden/settings-original.json`, produced by
`test/settings-http/golden/extract-settings-oracle.mjs`; commands in `test/fixtures/golden/README.md`).

## 20. Operations: appointments, availability, board, calendar

Code: `src/modules/scheduling` (routes in `http/`), customer search and create in `src/modules/customers/http`. Design: backend
design 4.1, 4.2, 4.4, 4.5, 5.3, 7.4; decisions in ADRs 0040-0044. Every transition is one transaction: row lock, guard,
update, `activity_log`, a queued message (`MessageQueue`, never sent inline), `audit_log`, ops events. Guard failures are
problem+json whose `title` and `detail` are the design's toast strings (curly apostrophes included). Success responses carry
the toast for the command (`toast: {title, detail}`) and the changed appointment (`appointment`, a compact core with
`version`, `status`, bays, `late`, `canDrag`); the dashboard refetches the board on the ops events.
## 21. Payments: invoices, ledger, store credit, reports

Code: `src/modules/payments/**` (routes in `http/`), migration `20261006190000_payments.sql`, seed `db/seeds/payments.ts`
(profile `parity-pay`), decisions [0050](decisions/0050-payments-ledger-and-calc.md) to
[0055](decisions/0055-payments-reports-and-csv.md). All amounts are integer cents; every money command needs an
`Idempotency-Key` (replays answer from the stored response with `Idempotent-Replayed: true`; same key, different body is
422 `IDEMPOTENCY_MISMATCH`), runs in one transaction that locks the invoice row, writes an audit row and publishes on the
`payments` SSE channel, and answers with the refreshed invoice detail.

### 20.1 Endpoints

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /ops/snapshot?window=next24\|today\|tomorrow\|week&q=` | `sched.view` | The whole board: `kpis[7]`, `alerts[]`, `timeline{count,groups[{divider,time,ampm,items[card]}]}`, `completed`, `queue` (Up Next: VIP first, top 6), `bays[]` (occupant elapsed, progress, estimated completion), `arrivals[]`, `staff[]` (derived columns plus Unassigned), `emergency`, `now`. `next24` = today + tomorrow, `week` = today through today + 6. `q` searches name, vehicle, plate, package, and the phone only with `cli.contact`. KPIs, alerts, bays and arrivals ignore `q` and `window`. |
| `GET /ops/kpis`, `GET /ops/alerts` | `sched.view` | The same values on their own. |
| `GET /calendar/summary?from&to` | `sched.view` | Up to 70 inclusive dates: `{date, weekday, count, closed, reduced, note, open{openMin,closeMin,from,to}, needsRebook, isToday}`. Real counts; closed days include today; `needsRebook` = active bookings on a closed day. |
| `GET /calendar/day?date` | `sched.view` | `dayInfo`, `sub` label, hour `rows[]`, and `outsideHours[]` (closed day, before opening, after closing) so nothing is dropped. |
| `GET /availability?date&serviceId&channel=desk\|online&customerId&excludeAppointmentId` | `sched.view` | Slots with `state` (`available`, `blocked`, `vip_held` + `releasesAt`, `closed`, `past`, `cutoff`, `outside_window`), `baysFree`, `overridable`, `overrideKind`, `sameDayEligible`. `customerId` makes VIP holds and windows apply to that client. |
| `GET /bays`, `PATCH /bays/:id {status}` | `sched.view` / `sched.override` | Maintenance or blocked bays count as zero capacity; a bay with a car in it cannot leave service (409 `BAY_BUSY`). |
| `GET /staff` | `sched.view` | Assignable employees (Crew role, or a custom role granting `jobs.status`, or a per-person Allow; no Deny; active). |
| `GET /appointments?from&to&status&customerId&q&cursor&limit` | `sched.view` | Cards, keyset paged by start. |
| `GET /appointments/:id` | `sched.view` | The file: overview, add-ons with the catalog, checklist sections, photo counts with presigned thumbnails (10 min), activity, invoice summary, membership, history. Phone and email masked without `cli.contact`. |
| `POST /appointments` | `sched.edit` (+ `sched.override` with `override`) | **Idempotency-Key required.** `{customer{id? name phone email smsOptIn}, vehicle{year make model color plate}, serviceId, addonIds[], start (ISO with offset) or walkIn:true, source, assignedEmployeeId, plannedBayId, notes, specialInstructions, override{reason}}`. Upserts the customer by phone and the vehicle by plate, validates the slot under an advisory lock, plans a bay, snapshots the checklist, creates the invoice through the gateway, queues `booking_thanks`. 201 `{appointment, customer, invoice, overrides[], messageQueued, toast}`. A walk-in starts at the next slot on the grid. |
| `PATCH /appointments/:id` | `sched.edit` | `{plannedBayId, assignedEmployeeId, notes, specialInstructions, version?}` (412 on a stale `version`). |
| `POST /appointments/:id/confirm` | `sched.edit` or `jobs.status` | booked to confirmed; queues `confirmed`. |
| `POST /appointments/:id/arrive {source?}` | `jobs.status` or `sched.edit` | booked or confirmed to arrived; `geofence` also records the check-in and queues `welcome`. |
| `POST /appointments/:id/start {bayId?}` | `jobs.status` | arrived to cleaning: `bayId`, else the planned bay, else the lowest free active bay. |
| `POST /appointments/:id/assign-bay {bayId}` | `jobs.status` | Drag onto a bay: booked, confirmed or arrived jobs of today; arrives implicitly. |
| `POST /appointments/:id/complete` | `jobs.status` | cleaning to completed; remaining tasks are checked, pickup pending, `ready` queued, the bay frees. |
| `POST /appointments/:id/advance {expectedStatus}` | `jobs.status` or `sched.edit` (per step) | The next step of the status the screen showed. A completed job has no next step (collect payment on the invoice). |
| `POST /appointments/:id/cancel {reason, notify?, deposit?}` | `sched.cancel` | **Idempotency-Key required.** Booked or confirmed only; the invoice is canceled through the gateway. `deposit` (`keep`, `refund_card`, `refund_credit`) is recorded and echoed (`depositPolicy`); refunding is a payments command. |
| `POST /appointments/:id/no-show` | `sched.cancel` | **Idempotency-Key required.** Only after start + `ops.late_grace_min`; cancels the invoice (`no_show`). |
| `POST /appointments/:id/reopen {start?, override?}` | `sched.cancel` | canceled or no-show back to booked; the slot is revalidated. |
| `POST /appointments/:id/reschedule {start, override?}` | `sched.edit` (+ `sched.override`) | Capacity-checked, may cross days; queues `reschedule`. |
| `POST /appointments/:id/prep-bay` | `jobs.status` or `sched.edit` | Not reversible; warns when the planned bay is occupied. |
| `POST /appointments/:id/pickup {state}` | `jobs.status` | `collected` or `pending`; not gated on payment; no SMS. |
| `POST /appointments/:id/notify-ready` | `msg.send` | Re-sends the ready SMS. |
| `PUT` / `DELETE /appointments/:id/addons/:serviceId` | `sched.edit` | Price from the catalog. `{added, changed, addon, invoice, checklist, toast}`; 409 `ADDON_REMOVE_OVERPAID`. |
| `PUT /appointments/:id/checklist/items/:itemId {done}` | `jobs.checklist` | Records who and when. |
| `POST /appointments/:id/checklist/bulk {itemIds, done}` | `jobs.checklist` | A section, or every id for "Check all". |
| `POST /appointments/:id/photos/presign {category, contentType, bytes, note?}` | `jobs.checklist` | Presigned POST (5 min, size policy). JPEG, PNG, WebP up to 15 MB; HEIC is 422. |
| `POST /appointments/:id/photos/:photoId/complete`, `POST .../photos/note {note}`, `DELETE .../photos/:photoId` | `jobs.checklist` | `complete` HEAD-verifies the object and queues the thumbnail job; a note is an issue with no file. |
| `GET /customers?q=` / `POST /customers` | `cli.view` / `sched.edit` | Search (a phone or email token cannot match without `cli.contact`; contact fields are null) and find-or-create by phone with a vehicle. |

### 20.2 Errors added

| Code | Status | Title / detail |
|---|---|---|
| `ALREADY_IN_BAY` | 409 | `Already in a bay` / `That vehicle is in Bay {n}` |
| `BAY_BUSY` (platform) | 409 | `Bay {n} is busy` / `Finish {First}’s vehicle first` |
| `BAY_UNAVAILABLE` | 409 | `Bay {n} is unavailable` / `It is out of service right now. Pick another bay` |
| `NO_BAY_FREE` (platform) | 409 | `No bay free` |
| `NOT_TODAY` | 409 | `Not today` / `Only jobs booked for today can go into a bay` |
| `CANT_MOVE_JOB` | 409 | `Can’t move this job` / `It’s already in progress or done` |
| `INVALID_TRANSITION` | 409 | `Can’t do that now` / `This job is {status}` (`meta.currentStatus`) |
| `STALE_STATE` (platform) | 409 | `meta.currentStatus`, `meta.expectedStatus`; the detail names the current status |
| `NO_NEXT_STEP` | 409 | `Nothing to advance` |
| `SLOT_UNAVAILABLE` (platform) | 409 | `Slot unavailable` / `Would overbook a bay — override required` |
| `SLOT_VIP_HELD` (platform) | 409 | `Held for VIP clients` / `Releases to everyone {release}h before · VIP clients can book it now` |
| `SLOT_CLOSED`, `SLOT_OUTSIDE_HOURS`, `SLOT_PAST`, `SLOT_OUTSIDE_WINDOW` | 409 | `Shop is closed`, `Outside opening hours`, `Time has passed`, `Too far ahead` |
| `OVERRIDE_NOT_ALLOWED` / `OVERRIDE_REASON_REQUIRED` | 403 / 422 | `Override not allowed` / `Reason required` |
| `TOO_EARLY_FOR_NO_SHOW` | 409 | `Too early` |
| `ADDON_REMOVE_OVERPAID` | 409 | `Can’t remove add-on` (one copy shared with the payments module) |
| `NOT_AN_ADDON` | 422 | |

### 20.3 Realtime (channel `ops`)

`appointment.updated {id, version, status, change}` (`change`: created, confirmed, arrived, cleaning, completed, canceled,
no_show, reopened, moved, prepped, pickup, notified, updated, addons, checklist, photo), `bay.changed {bayId}`,
`availability.changed {date}`, `kpi.dirty`, and `alerts.changed {count, added, removed}` from the per-minute scan
`appointments.late_scan`, which compares the alert set with the one it last announced (`ops_alert_state`) and publishes only
on a difference.

### 20.4 Ports and wiring

`src/modules/scheduling/ports.ts` holds the contracts the other verticals implement: `InvoiceGateway` (payments; the shared
contract), `MessageQueue` (messaging outbox), `MembershipPort`, `ExternalAlertSource` (alerts 10-12), `RevenueSource`
(cash-basis revenue). `createSchedulingModule({ invoices, messages, memberships, externalAlerts, revenue, storage })` takes
the real ones; the default `schedulingModule` in `src/http/modules.ts` uses in-memory implementations and logs a warning in
production. The worker wires the same ports for the scan with `configureSchedulingJobs(...)`. `syncChecklistTemplate` is
called by the Settings checklist route after `putChecklist`.

### 20.5 Tests and goldens

`pnpm test:ops` runs `test/scheduling` and `test/golden/ops`. The oracle values come from the original Operations bundle
(`test/golden/ops/original.json`, re-extract with `test/golden/ops/extract/extract-original.ts`, see
`test/golden/ops/DEVIATIONS.md` for every deliberate difference). The seed profile `parity-ops` (`db/seeds/scheduling.ts`)
is the design's day as data.
| `GET /payments/summary?range=today\|7d\|30d\|mtd` | `pay.reports` | Inclusive business days ending today (business tz). `{range{key,from,to,label}, kpis{grossSales,netRevenue,refunds,adjustments,creditsIssued,outstanding,counts{invoices,refunded,adjusted,creditInvoices,creditClients,openBalances}}, chart{granularity,buckets[{key,label,title,netCents,lossCents}],maxCents}, byMethod{card,applePay,cash,storeCredit,other}, filterCounts{all,unpaid,refunds,adjusted,credits}, pendingApprovals{count,text,first,all[]}, awaitingProcessor{count,cents}}`. An invoice belongs to a range by `biz_date`. |
| `GET /payments/invoices?range&filter&q&limit&cursor` | `pay.reports` | Sorted `bizDate desc, invoiceNo desc`; keyset `nextCursor`. `filter`: `all`, `unpaid` (balance > 0), `refunds` (refunded or pending), `adjusted`, `credits` (issued or applied). `q` matches the joined text of invoice id, client, vehicle and item names, case-insensitive. Rows: `{id,invoiceNo,label,bizDate,date,time,client,vehicle,staff,items{first,more},totalCents,paidCents,balanceCents,status,statusLabel,refundPending,awaiting,adjusted}` (`awaiting` is `payment`, `refund` or null: card money recorded by staff and not yet confirmed in Squarespace, a refund wins). |
| `GET /invoices/:id` | `pay.reports` | Items (with `refunded` flag), adjustment lines, full `calc`, `clientCredit{balanceCents,nextExpiry}`, `ledger[]` newest first (`occurredAt desc, seq desc`, `atLabel` Today / Yesterday / `Jun 11 · 9:12 AM`), per pending refund `canApprove` and `approveBlock` (`permission`, `limit`, `self`) for the caller, `caller{canCollect,canRefund,...,refundLimitCents}`. |
| `GET /payments/approvals` | `pay.reports` | Pending refunds oldest first with the caller's approval rights. |
| `GET /payments/export.csv?range&filter&q` | `pay.reports` | UTF-8 BOM, CRLF, RFC 4180, plain decimals, dates in the business tz, text cells starting with `= + - @` get a leading apostrophe (numeric columns never). Scope = range and filter and search. `oasis-invoices_{from}_{to}.csv`, at most 20,000 rows (422 `EXPORT_TOO_LARGE`). Columns: `Invoice, Date, Time, Client, Vehicle, Staff, Items, Tip, Adjustments, Subtotal, Tax, Total, Paid, Credit applied, Refunded, Refund pending, Balance, Credits issued, Net revenue, Status`. |
| `GET /payments/reconciliation` | `pay.reports` or `set.billing` | `awaitingProcessor[]` (card money older than 2 h), `unmatchedOrders[]` and `unmatchedTransactions[]` (from the sync's queues through `UnmatchedSource`; empty until wired), `overpaid[]` (last 90 days). |
| `GET /clients/:id/credit` | `pay.reports` | Balance, next expiry and the lots (`state` active / used / expired). |
| `POST /invoices/:id/payments` `{method: card\|cash\|payment_link, url?}` | `pay.collect` | Collects the full balance. Cash: `pay` event, `processorState na`. Card: `pay` event that counts immediately with `processorState awaiting_processor`; label is the card brand only (`Card`, or `Visa` from a `CardHintProvider`), never invented digits. `payment_link`: needs an https URL on an allowed host (`PAYMENT_LINK_HOST`), creates a `payment_links` row, queues the SMS, no ledger event. 422 `PAY_NOTHING_TO_COLLECT`. |
| `POST /invoices/:id/credit-applications` | `pay.collect` | `min(usable credit, balance)`; FIFO allocation. 422 `PAY_NOTHING_TO_APPLY`. |
| `POST /invoices/:id/refunds` `{mode: full\|items\|custom, itemIds?, amountCents?, dest: card\|credit\|cash, reason?, note?}` | `pay.refund` | Value: full = refundable; items = selected lines plus tax at the invoice rate, capped at refundable, each item at most once (`ITEM_ALREADY_REFUNDED`); custom = amount. Checks in the design's order: `REFUND_EXCEEDS_CARD` (`Only $X was paid by card — refund the rest to store credit.`), `REFUND_EXCEEDS_REFUNDABLE`. **Pending exactly when the amount is strictly greater than the caller's refund limit**, else done; a done card refund is `awaiting_processor`. |
| `POST /invoices/:id/refunds/:eventId/approve` | `pay.refund` | Limit of at least the amount (403 `CANT_APPROVE`, title `Your role can’t approve $80.00`); the requester cannot approve their own request unless unlimited or `approvals.allow_self` (403 `SELF_APPROVAL`); refundable and card cap are re-validated without the request's own reservation; 409 `REFUND_NOT_PENDING`. The event keeps its time; `approvedBy` is `Name · Roles`. |
| `POST /invoices/:id/refunds/:eventId/deny` `{note?}` | `pay.refund` | The requester may withdraw. |
| `POST /invoices/:id/adjustments` `{kind, unit: $\|%, value, reason?, note?, settle?}` | `pay.adjust` | `value` is cents for `$`, basis points of the items subtotal for `%` (1000 = 10%); applied before tax. Over the limit: 422 `OVER_LIMIT` with `Over your $25 limit as Customer Support. Ask Management or a Super Admin.` (no approval path). `ADJUST_EXCEEDS_INVOICE`, 409 `INVOICE_CANCELED`. A discount that leaves a paid invoice overpaid adds a settlement **refund event** (`settle` credit by default or card) under the normal refund rules (pending above the caller's refund limit, card settlements await Squarespace); `{event, settlement, invoice}`. |
| `POST /invoices/:id/credits` `{amountCents, reason?, note?, expiry: none\|d30\|d90 (or the design labels)}` | `pay.credit` | Expires at the end of the business day 30 or 90 days out. Over the limit: 422 `OVER_LIMIT` (`Over your $50 limit as Customer Support.`). |
| `POST /invoices/:id/void` `{eventId, note?}` | `pay.void` | Cash, or card still awaiting Squarespace; 422 `VOID_NOT_ALLOWED`, 409 `PAYMENT_ALREADY_VOIDED`. |
| `PUT /invoices/:id/tip` `{tipCents}` | `pay.collect` | Untaxed; reopens a balance when the invoice was settled. |
| `POST /invoices/:id/receipt` | `msg.send` or `pay.collect` | SMS to opted-in clients and email, through the `PaymentMessenger` port; audited; not a ledger event. |
| `POST /invoices/:id/payment-links` `{kind: balance\|deposit, amountCents?, url?}` | `pay.collect` | Attach and text a Squarespace checkout or invoice link. |
| `POST /ledger-events/:id/confirm-processor` `{processorRef?, sqspOrderId?}` | `pay.collect` for a payment, `pay.refund` for a refund | `awaiting_processor` to `confirmed`; 409 `EVENT_NOT_AWAITING`. |

Limits and roles: the limit of a kind is the highest among the roles that grant the permission (`null` unlimited, no row 2500
cents); ledger `by` is the real person and `byRole` the names of the granting roles (`Management + Accounting`); under
view-as the real user is recorded with `view_as_role_id` and the viewed role decides permission and limit.

### 20.2 Realtime (`payments` channel)

`invoice.updated {invoiceId, version}`, `ledger.event {invoiceId, eventId, type}`, `refund.pending`, `refund.resolved`
(`{invoiceId, eventId}`), `reconciliation.stale {count, cents, oldestMinutes}` (job `payments.lag-scan`, every 15 minutes).

### 20.3 InvoiceGateway (for scheduling)

`createGatewayFor({clock, newId})` / `createInvoiceGateway()` in `src/modules/payments/gateway.ts` implement the shared
contract (`ensureForAppointment`, `syncItems`, `cancelForAppointment`, `summariesFor`) plus `freezeDate(tx, appointmentId, at)`.
Numbers are INV-20611 upward, gap-free (the counter row is incremented in the caller's transaction). `biz_date` follows the
appointment's service date until `freezeDate` (call it on completion); a deposit at booking never moves it. `syncItems` keeps
the ids of lines that stay and answers 409 `ADDON_REMOVE_OVERPAID` when a removal would leave `paid - refunded > total`.
Canceling or a no-show cancels the invoice: `canceled` (nothing paid), `canceled_kept` (a deposit stays), `canceled_refunded`.

### 20.4 Wiring and configuration

* `src/http/modules.ts` registers `paymentsModule()`; pass `paymentsModule({ports: {messenger, cardHints, unmatched, linkHosts}})`
  to wire the Messaging outbox (`createPaymentMessenger(outbox)` with a real `PaymentOutbox`), the Squarespace card-brand hint
  and the sync's unmatched queues. Outside production the default outbox is in memory (`devOutbox`); **in production the
  default fails with 503 until a real outbox is passed**, so a receipt or payment link is never reported as sent when it was not.
* `PAYMENT_LINK_HOSTS` (optional, comma separated, default `squarespace.com`; a host matches itself and its subdomains) is the
  allow-list for payment link URLs. It is read directly from the environment (it is not part of `loadEnv`).
* Settings used: `tax.rate_bp` (snapshotted on each invoice), `approvals.allow_self`.
* Job `payments.lag-scan` (every 15 minutes) is registered in `src/platform/job-registry.ts`.

### 20.5 Seeds, oracle and tests

`pnpm seed -- --profile parity-pay` (depends on `domain`) loads the design's 105 invoices (16 explicit, 89 generated with
`mulberry32(987654)` in the design's RNG call order, generated ids renumbered down from 20608 skipping used ids; the lowest
is INV-20506), ledger events with real instants relative to the clock, store credit with allocations, and the pending refund
INV-20579. Oracle values come from the ORIGINAL bundle (`test/golden/pay/extract-oracle.mjs`, see `test/golden/pay/README.md`);
intentional differences are in `test/golden/pay/DEVIATIONS.md`. Tests: `test/payments/*` (`pnpm vitest run test/payments`).

## 22. Messaging: SMS over the SMS Gate tablet

Code: `src/modules/messaging/` (pure policy, dispatcher and router from the first wave, plus `db/`, `http/`, `jobs/`, `adapters/`),
`src/integrations/{sms,smsgate}` (provider port, adapter, simulators). Tables: migration `20261006200000_messaging.sql`.
Decisions: ADRs 0060 to 0063. Device and tablet runbook: `docs/integrations/smsgate.md`.

### 23.1 How a text moves

```
scheduling / payments / settings / people          DbMessageQueue.enqueue(tx, ...)   (the CALLER's transaction)
        render template -> canSendSms (opt-in, STOP, synthetic, SMS_ALLOWLIST, quiet hours) -> GSM-7 + segments + STOP footer
        -> messages row (queued) + sms_outbox row + thread + SSE message.out
dispatcher (job sms.dispatch or inline loop)       claim (FOR UPDATE SKIP LOCKED) -> SmsProvider.send(our message id)
        -> outbox accepted -> message sent                 sliding window 30 segments / 30 min, lane 0 may use the reserved 6
device webhooks (hooks listener only)              sms:sent / delivered / failed / cancelled / received / system:ping / app:started
        -> webhook_log (persist) -> 2xx -> one transaction: outbox + message state, inbound router, device health
```

A booking that rolls back takes its text with it. Nothing is sent inline. A text the policy refuses is **not** persisted: the
caller learns `skipped` (`opted_out`, `not_opted_in`, `no_valid_phone`, `synthetic_number`, `not_allowlisted`, `too_long`,
`template_error`) and scheduling writes it on the activity log ("... (not sent: customer opted out of SMS)").

### 23.2 Endpoints (`/api/v1`)

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /appointments/:id/messages` | `cli.view` | The Messages tab. `{items: Message[], customer: {id, name, smsOptedIn, optedOut, hasPhone, canMessage}, unread}`, oldest first. Outbound texts of the appointment and inbound replies attributed to it. No phone number in the payload. `?markRead=true` clears unread (needs `msg.send` to take effect); `?limit` (default 200). |
| `GET /customers/:id/messages` | `cli.view` | The customer-level thread across appointments (B31). Same shape. |
| `POST /appointments/:id/messages` | `msg.send`, **Idempotency-Key required** | Body `{text}` (free text, class `staff_message`) or `{templateKey, vars?}` (a quick reply key `qr_*` or an automation: `booking_thanks confirm_request confirmed reminder welcome in_progress ready reschedule review late_nudge payment_link addon_approval`; `first`, `time`, `when`, `bay` are filled from the appointment). 201 `{message, queued: true, held, holdUntil, segments}`. Sending also marks the customer's replies read and writes the activity line "Staff message sent". 422 `SMS_OPTED_OUT`, `SMS_NOT_OPTED_IN`, `SMS_NO_PHONE`, `SMS_BLOCKED` (synthetic number or off the allow-list), `SMS_TOO_LONG` (over `SMSGATE_MAX_SEGMENTS`), `SMS_EMPTY`, `SMS_TEMPLATE_INVALID`. |
| `POST /customers/:id/messages/read` | `msg.send` | Marks the customer's unread replies read. `{marked}`. |
| `GET /messages/templates` | `msg.send` | `{quickReplies[], templates[]}` with class, lane, TTL, quiet-hours behaviour, variables, `staffSendable`. The code registry is the source; there is no per-shop template editing yet (ADR 0063). |
| `GET /messages/outbox?state=failed` | `msg.send` | `state` is `pending failed expired cancelled delivered all`; keyset paging (`limit`, `cursor`). Number masked without `cli.contact`; invite and reset links are never shown. |
| `POST /messages/:id/retry` | `msg.send` | A failed or expired text goes back to pending under a new device id with a fresh TTL (409 `MESSAGE_NOT_RETRYABLE`; never for invites and resets). Audited. |
| `POST /messages/:id/cancel` | `msg.send` | Only while pending (409 `MESSAGE_NOT_CANCELABLE`). Audited. |
| `GET /messages/inbox` | `msg.send` | The quarantine: texts from numbers that are not customers (strangers, carrier notices, short codes). `POST /messages/inbox/:id/review` marks one reviewed. |
| `GET /customers/:id/sms-consent` | `cli.view` | `{smsOptedIn, optInSource, optedOut, optOutSource keyword/manual, staffCanClearOptOut, hasPhone, ...}` |
| `PUT /customers/:id/sms-consent` | `cli.edit` | `{optedIn?, optedOut?}`. `optedIn: true` records staff-attested consent; `optedOut: true` records a manual opt-out; `optedOut: false` lifts a MANUAL opt-out only. A STOP the customer texted is refused with 422 `SMS_STOP_ACTIVE`: they reply START. Audited. |
| `GET /integrations/sms/devices` | `set.billing` | Devices with health, counters and the webhook URL to configure. Never a secret. |
| `POST /integrations/sms/devices` | `set.billing` | `{label, provider: smsgate|sim, baseUrl, username, password, webhookSecret?, limits...}`. 201 `{device, webhookSecret}`: the signing secret (generated when omitted) is returned ONCE; credentials are stored AES-256-GCM encrypted with `SECRETS_KEY`. |
| `PATCH /integrations/sms/devices/:id` | `set.billing` | Label, credentials (a sent secret replaces the stored one), `enabled`, `simSlotDefault`, `minIntervalMs`, `maxPerWindow`, `windowMinutes`. |
| `POST /integrations/sms/devices/:id/test` | `set.billing` | Health poll plus a credentials probe; nothing is sent. `{reachable, credentials: ok/rejected/unknown, healthStatus, battery, error}`. |
| `POST /integrations/sms/devices/:id/register-webhooks` | `set.billing` | Registers the seven `oasis-*` webhooks (idempotent; stale `oasis-*` ones removed). Needs `SMSGATE_WEBHOOK_PUBLIC_URL` (HTTPS) except for loopback and simulators. |
| `GET /integrations/sms/devices/:id/health?refresh=` | `set.billing` | Device state plus the dispatcher: `state` (idle, sending, rate_limited, quiet_hours, device_offline), the sliding-window budget, queue depth by lane with ETAs, quiet hours, failures in 24 h. |
| `POST /dev/sms/inbound`, `GET /dev/mail` | `set.billing`, only with `ALLOW_DEV_ENDPOINTS=true` | Inject a text into the simulated device (handled by the same code path; returns once applied); read the console mailbox. |

`Message` = `{id, direction in|out, from staff|system|customer, senderName, text, time "10:36 AM", at, channel, status, error, templateKey, appointmentId, customerId, segments, read}`.
`status` is `queued sending sent delivered failed received canceled expired`; the outbox states `accepted` and `sent` both read as `sent`.
The dashboard's `MessagesPort.thread` is typed as a bare array today; the live wave must read `.items`.

### 23.3 Realtime

Channel `messages` (needs `cli.view`), full payload (the message as above): `message.out` (queued), `message.in` (received),
`message.status {id, status, error, customerId, appointmentId, threadId}` on every state change. Channel `notifications`
(targeted at each manager's user): `notification.new {id, kind}` for `sms.device_offline`, `sms.device_recovered`,
`sms.cancel_request`, `sms.unattributed_reply`, and `sms.device.health {deviceId, label, from, to}` on every device state change.
Channel `ops`: `alerts.changed {source: 'sms'}` when a reply arrives or is read, a device changes state. Managers are active
employees with a login who hold `set.billing` or `sched.override` (Super Admin, Management, Accounting, plus any per-person Allow).

Needs Attention (alerts 10 and 11 of design 4.4, `src/modules/messaging/adapters/alerts.ts`): `new_reply` (one per appointment, or
per customer when a reply could not be attributed; a customer's CANCEL is red) and `sms_device_down` (managers only).

### 23.4 Policy summary

Every text has a class (`src/modules/messaging/policy/classes.ts`): lane 0 `welcome ready addon_approval staff_invite password_reset` and the keyword replies,
lane 1 confirmations, receipts, payment links, `staff_message`, `quick_reply`, lane 2 `confirm_request reminder review late_nudge`,
lane 3 `emergency closure_notice broadcast`. Quiet hours (`SMS_QUIET_HOURS`, default 21:00-08:00 in `BUSINESS_TZ`) hold only
`confirm_request reminder review late_nudge closure_notice broadcast`; the TTL clock starts when the hold ends. The emergency
fan-out is lane 3, not lane 0 (review B15): the blast can use at most 24 of the 30 segments in a window, so a ready-for-pickup
text is never starved. Outside production only `SMS_ALLOWLIST` numbers are texted; synthetic (seed) numbers never in production.

### 23.5 Webhook and listeners

`POST /hooks/smsgate/:deviceKey` exists **only** on the second listener (`HOOKS_HOST:HOOKS_PORT`, default 127.0.0.1:3002, started by
`src/server.ts`; `HOOKS_PORT=0` disables it; an occupied port is logged as an error and the process keeps running). The public
listener has no such route and answers 404. Verification is HMAC-SHA256 over the raw body plus `X-Timestamp` with the device's own
secret (24 h tolerance, `SMSGATE_WEBHOOK_TOLERANCE_SECONDS`): 401 for a missing header, bad or stale signature, 400 for a signed body
that is not an envelope, 404 for an unknown device key, 200 for everything accepted (a repeat, an event type Oasis ignores).
The envelope is persisted in `webhook_log` (unique `(provider, external_id)` = envelope id) before the answer; applying it
(`sms_processed_events`, outbox, message, inbound routing, device health) happens in one transaction afterwards, and a sweep every
30 s applies envelopes that were persisted but never applied (and abandons them after 24 h).

### 23.6 Jobs and dispatch modes

`SMS_DISPATCH_MODE` decides who drains the outbox: `jobs` (default; the pg-boss worker), `inline` (the API process runs the
loop; single-process deployments and the live-stack harness), `off`. Jobs (all in `src/platform/job-registry.ts`): `sms.dispatch`
(every minute, a ~55 s window ticking every `SMS_TICK_INTERVAL_MS`, under the leader advisory lock), `sms.reconcile` (every 2
minutes, plus housekeeping), `sms.device.healthcheck` (every minute), `sms.webhooks.register` (hourly, and once at boot from
`src/server.ts`; also on every `app:started`), `email.send` (every minute). A session advisory lock per database schema keeps
the worker and the inline runner from overlapping; the atomic claim keeps two dispatchers from sending one message twice anyway.

### 23.7 Environment

New in `src/config/env.ts` (all optional): `SMS_DISPATCH_MODE`, `SMS_TICK_INTERVAL_MS` (2000), `SMS_QUIET_HOURS`, `SMSGATE_WEBHOOK_PUBLIC_URL`,
`SMSGATE_API_PATH`, `SMSGATE_TIMEOUT_MS`, `SMSGATE_WEBHOOK_TOLERANCE_SECONDS`, `SMSGATE_RESEND_ATTEMPTS`, `SMSGATE_SIM_NUMBER`,
`SMSGATE_LEGACY_MESSAGE_FIELD`, `SMSGATE_SYNC_SIGNING_KEY`, `SMSGATE_ALLOW_INSECURE_WEBHOOK_URL`, `SMSGATE_RESERVED_P0`,
`SMSGATE_SAFETY_MARGIN`, `SMSGATE_MIN_INTERVAL_MS`, `SMSGATE_MAX_SEGMENTS`, `SMSGATE_HEARTBEAT_STALE_SECONDS`,
`SMSGATE_ONLINE_WITHIN_SECONDS`, `BUSINESS_PHONE` (HELP reply), `HOOKS_HOST`, `HOOKS_PORT`, `SES_FROM_NAME`, `SES_REPLY_TO`,
`SES_CONFIGURATION_SET`, `EMAIL_CONSOLE_DIR`. `SECRETS_KEY` (base64, 32 bytes) is now used: required in production as soon as a
device credential is stored; outside production a fixed development key is used when it is unset. Devices live in `sms_devices`;
`SMSGATE_DEVICE_URL`, `SMSGATE_USERNAME`, `SMSGATE_PASSWORD`, `SMSGATE_WEBHOOK_SECRET` are not read by the runtime (add the tablet
through `POST /integrations/sms/devices`; the `design` seed adds a simulator device, key `sim-device-design`).

### 23.8 Wiring

`src/composition.ts`: `messagingRuntimeFor(deps)` (one runtime per `Env` object), `configureProductionSettings({clock, newId, messaging})`
(closure notices and the emergency fan-out queue real texts and emails), `configureProductionPayments(rt)` (receipts and payment links; until it is
called, as in the payments suite, the payments module keeps its own dev outbox; `src/server.ts` calls both). `src/http/modules.ts`: scheduling gets
`messages: rt.queue` and `externalAlerts: messagingAlertSource`, payments takes the messenger over `DbPaymentOutbox` from `configureProductionPayments`, and the messaging
routes are mounted. `src/server.ts`: `MessagingAccountNotifier` for invites and reset links (SMS when a usable device and number
exist, else email through the EmailProvider; `delivered` is true only for a real SMS Gate device or SES), the hooks listener, the inline runner.
Receipts go out as an SMS and an itemised email (`receipt` template built from the invoice and its ledger calc).

### 23.9 Tests

`test/messaging-db/*` (Postgres, the in-process simulator, the HTTP simulator server and the real `src/server.ts` process; run
`pnpm vitest run test/messaging-db`), `test/messaging/*` (pure units). Still to verify on the real tablet: the 20 items in section 2 of
`docs/integrations/smsgate.md` (route path, duplicate-id 409, `textMessage`, signature on a real delivery, HTTPS to the tailnet name,
Android's send limit, delivery reports, `sms:delivered` per multipart part, inbound sender format, RCS, reboot behaviour, the SIM slot
mapping). Nothing here was run against a physical device.
## 23. Squarespace sync and memberships

Decisions: ADR 0070 (persistence), 0071 (ledger wiring), 0072 (jobs, credentials, environment), 0073 (memberships). Squarespace
is read-only for payments; Oasis owns the ledger. Polling is the baseline; the webhook is an optional accelerator.

### 23.1 Squarespace endpoints (`/api/v1/integrations/squarespace`)

| Verb path | Permission | Notes |
|---|---|---|
| `GET /status` | `set.billing` | connection (never the key), per-resource sync state and lag, order and transaction counts by state, `manualQueueOpen`, `awaitingProcessor{count,cents}`, `deadLetters`, product map size, webhook state, open alerts. |
| `POST /sync-now` | `set.billing` | `{resume?, rematch?}`. `202 {mode:"queued"}` when there is a queue (singleton), `200 {mode:"inline", result}` otherwise; `409 SQSP_NOT_CONFIGURED` without a key. `resume` clears a dead-lettered resource; `rematch` re-offers the manual queue to the matcher. |
| `PUT /connection` | `set.billing` | `{apiKey, siteId?, verify=true}`: one read against Squarespace first (`422 SQSP_CONNECTION_FAILED`), then stored AES-256-GCM encrypted (`503` when `SECRETS_KEY` is unset). Returns the connection view; the key is never returned. `DELETE /connection` erases it and stops polling. |
| `GET /product-map`, `PUT /product-map` | `set.billing` | rows `{productId?, sku?, name?, kind: membership\|service, plan?, planLabel?, intervalMonths?, serviceId?, active?}`; `PUT` replaces the whole map (422 with per-row errors), re-opens orders ignored only for `unmapped_sku`. `GET` adds `seen` (products on the last 90 days of orders, `mapped` or not) and the plans. |
| `GET /orders?state=unmatched\|auto\|manual\|ignored\|membership\|all&limit&cursor` | `set.billing` or `pay.collect` | default `unmatched` = not yet matched or waiting in the manual queue. Each order carries its payments and refunds, the queue items (reason, scored suggestions), and `matches` (what was applied, confidence, variance). Contact details masked without `cli.contact`. Keyset pages (created time, id). |
| `POST /orders/:id/match` | `pay.collect`, **Idempotency-Key** | `{eventId}` confirms a staff-recorded card payment or refund waiting on Squarespace; `{invoiceId}` records the payment as a `squarespace` pay event (`409 SQSP_MATCH_DUPLICATE` when the invoice already shows a waiting or equal card payment, unless `force`). `404 SQSP_ORDER_NOT_FOUND`, `409 SQSP_NOTHING_TO_MATCH`, `409 SQSP_ORDER_NOT_MATCHABLE`, `422 SQSP_MATCH_TARGET_REQUIRED`. |
| `POST /orders/:id/ignore` | `pay.collect`, **Idempotency-Key** | `{reason?}`; idempotent; `409 SQSP_ORDER_ALREADY_MATCHED` once money is on an invoice. |
| `PUT /customer-links/:sqspCustomerId` | `set.billing` | `{customerId}`; links a Squarespace customer to an Oasis customer and runs the membership pass. |
| `POST /alerts/:id/resolve` | `set.billing` | closes a sync alert. |
| `POST /hooks/squarespace` | signature | `Squarespace-Signature` (hex HMAC-SHA256 over the raw body, secret decoded from hex); `401` bad signature, `400` malformed, `200` stale / duplicate / ignored topic, `202` accepted. |

`GET /payments/reconciliation` (Payments) now lists real `unmatchedOrders` (the manual queue) and `unmatchedTransactions`.

### 23.2 Membership endpoints

| Verb path | Permission | Notes |
|---|---|---|
| `GET /customers/:id/membership` | `cli.view` | `{membership, upgrade, history}`: plan (colours, tint, perks, percent perks as display data), status, renewal (`renewsAt`, `renewLabel`), months active, credits per rule (`left: null` = unlimited), retention, flags; for a non-member the upgrade candidacy (3 or more completed visits in 60 days); history (visits, lifetime spend, average days between visits, favourite package). |
| `GET /memberships?status&plan&q&limit&cursor` | `cli.member` | members by customer name with a count per status. |
| `POST /memberships` | `cli.member` | a member by hand (no subscription data): active, this cycle's credits granted. `409 MEMBERSHIP_EXISTS`. |
| `PATCH /memberships/:id` | `cli.member` | `{status?, planKey?, planLabel?, renewsOn?, autoApply?, note?, expectedVersion?}`; holds against the inference until a newer paid order; `412` on a stale version; audited. |
| `POST /appointments/:id/membership-perks/apply` | `cli.member`, **Idempotency-Key** | applies one credit as a system `adjust` (reason "Membership credit") equal to the package line. `404 MEMBERSHIP_NOT_FOUND`, `409 MEMBERSHIP_NOT_ACTIVE`, `MEMBERSHIP_NOT_ELIGIBLE`, `MEMBERSHIP_NO_CREDIT`, `MEMBERSHIP_CREDIT_APPLIED`, `MEMBERSHIP_NO_BALANCE`, `MEMBERSHIP_NO_INVOICE`, `MEMBERSHIP_APPOINTMENT_CLOSED`. |

The Operations appointment file's `membership` (and the board's member badge) now come from the real port: `plan` is the label sold,
`creditsLeft` (null = unlimited), `creditAvailable`, and additively `planKey`, `renewsAt`, `renewLabel`, `creditsUsed`, `perks`,
`color`, `bgColor`, `tint`, `memberMonths`, `retention{label, desc, tone}`.

### 23.3 Realtime and alerts

`payments` channel: `squarespace.order_synced` `{orderId, orderNumber, matchState, invoiceId?}` whenever an order is stored or its match
state changes; matches and confirmations also publish `invoice.updated` and `ledger.event` like a staff command. Operations alert 12
(`awaiting_processor`: card money not confirmed after 2 hours; `unmatched_order`: orders waiting in the manual queue, managers only)
is served by the alert source in `src/modules/payments-sync/db/queries.ts`.

### 23.4 Jobs, environment, seeds, tests

Jobs `sqsp.sync`, `sqsp.contacts`, `sqsp.reconcile`, `sqsp.webhook.process`, `membership.cycle` (ADR 0072). Environment: the
`SQSP_*` variables in `src/config/env.ts` (all optional) and `SECRETS_KEY` (required to store the API key). Seed profile
`memberships` (depends on `design`): plans, credit rules and the design's members (manual, no Squarespace ids). Run the simulator
with `pnpm sim:squarespace`; the tests are `test/payments-sync-db/*` and `test/memberships/*`.
