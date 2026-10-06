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
| GET | `/api/v1/events` | authenticated |  |
| GET | `/api/v1/meta/now` | public |  |
| GET | `/api/v1/openapi.json` | public |  |
<!-- openapi:end -->
