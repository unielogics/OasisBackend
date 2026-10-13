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
| Rate limit | 300 requests/minute per user (per IP when anonymous), in memory, `RATE_LIMIT_PER_MIN`, charged before the 401/403 decision so rejected floods are throttled too; ahead of the session lookup each address is also capped at 4 x `RATE_LIMIT_PER_MIN` (SEC-14, ADR 0120). Routes with their own limit (sign-in, password reset, `/events`, the arrival ping) keep only that limit. The IP is the socket peer unless `TRUST_PROXY` names the proxies in front (`true` = one hop: nginx on the same host, whose appended `X-Forwarded-For` entry is the client; a number = hops; or an address list); entries further left are client-supplied and ignored. 429 `RATE_LIMITED` with `Retry-After`. Probes and `/hooks/*` are exempt; `/events` allows 30 connects/minute. |
| Body limits | JSON bodies up to 1 MB (413 `PAYLOAD_TOO_LARGE`); `/hooks/*` also 1 MB, except `POST /hooks/smsgate/:deviceKey` on the hooks listener: 16 MB (an MMS carries its pictures base64-encoded), 413 above it (ADR 0151). Request schemas should be `.strict()`. |
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
(401 everywhere non-public); `DEV_AUTH_BYPASS=true` gives local development a permissive user (refused in production). `NODE_ENV=production` also refuses to boot without `SESSION_SECRET`, `COOKIE_SECURE=true`, a `SECRETS_KEY` that is base64 of 32 bytes, and https `PUBLIC_DASHBOARD_URL` / `PUBLIC_API_URL`.
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
| `messages` | `cli.view` | `message.in`, `message.status`, `message.removed` |
| `settings` | any user | `settings.changed`, `rbac.changed` |
| `notifications` | self only (events carry `targetUserId`) | `notification.new`, `notification.updated` |

The Authorizer's `canSubscribe` overrides the table. Channels the caller may not read are dropped, not errors, and
listed in `ready.denied`. Frames:

* default (unnamed) message, one per event: `id: <n>`, `data: {"channel","type","payload","at"}` (payloads are ids plus
  `version`; the client refetches, except messages which carry the full payload);
* `event: ready` first on every connection, data `{channels, denied, cursor, heartbeatMs}`; it carries an `id` only on
  fresh connections;
* `event: resync` when `Last-Event-ID` can no longer be replayed (events older than the 10-minute retention were purged,
  the cursor is ahead of the log after a restore, or it is not a number; or the replay would exceed 5,000 events,
  reason `replay_too_large`, sent after the events already written): data `{reason, latestId}`, `id: latestId`.
  The client must refetch everything; on `cursor_expired` no events are replayed;
* `: hb` comment every 20 s (`SSE_HEARTBEAT_MS`) so proxies keep the stream open;
* `retry: 3000` once at the start.

Resuming replays `id > Last-Event-ID` (same permission filters), then continues live with no gaps or duplicates.
The log is in Postgres (`realtime_events`, ids from a database sequence), so an API restart, graceful or killed, loses
nothing: a client that reconnects with its last id gets everything committed while the API was down, in order, once
(`test/jobs/sse-restart.test.ts` restarts a real API process with SIGTERM and SIGKILL). A gap longer than the 10-minute
retention gets `resync`.
Delivery is at least once across reconnects; clients treat events as "refetch this" hints. Clients should also refetch on
reconnect and on tab visibility and keep a 30-60 s fallback poll. At most 8 concurrent streams per user (429 beyond);
a consumer that falls more than 1 MiB behind is disconnected and resumes with `Last-Event-ID`.
An open stream is re-authorised at most every 15 s (`min(SSE_HEARTBEAT_MS, 15 s)`) and at once on any `rbac.changed`: when the session is gone (sign-out,
deactivation, password change, expiry) the stream is closed, and a channel whose permission was lost stops being delivered. A permission that is
gained applies from the next connection. The re-check does not slide the session's idle expiry.

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
| `GET /healthz` | Liveness: always 200 while the process answers. The body reports the database and queue state, `{status: 'ok' \| 'degraded', checks: {db, jobs}}`, where `jobs` carries `detail`, `queue {queued, scheduled, active, failed, deadLetter, oldestQueuedAgeSeconds}` and `worker {state, lastRunAt}` (`ok`, `stale` after 10 minutes without a finished job, `unknown`) |
| `GET /readyz` | 200 only when the database answers, every migration on disk is applied and unmodified, and the job queue is reachable; otherwise 503 with per-check detail (`checks.jobs` has the same queue and worker fields as `/healthz`). A stale worker or failed jobs are reported but do not make the API unready, so a proxy health check cannot turn a late reminder into an outage. Point the external uptime monitor and nginx upstream check here. Both probes answer the `checks` detail only to the server itself (loopback socket peer and no proxy header naming another address); anyone else gets `{status}` with the same status code (ADR 0120) |
| `GET /api/v1/openapi.json` | The OpenAPI 3.1 contract |
| `GET`, `POST /dev-storage/*` | The simulator object store behind `STORAGE_PROVIDER=fs` (not mounted in production or for S3): the presigned photo POST (`/dev-storage/upload`, CORS for `PUBLIC_DASHBOARD_URL`) and the signed thumbnail and download URLs. Public routes: every URL carries its own signature, like S3 |

Logging: pino JSON, redacting `authorization`, `cookie`, `set-cookie`, passwords, tokens and secrets everywhere, masking
phone numbers and emails at `info` and above (including inside error text), redacting sensitive query parameters in
logged URLs (credentials and search terms: `token`, `code`, `q`, `search`, `phone`, `email`, `name`, `plate` and the like) and link tokens
in their paths (`/a/<token>`, invite and reset pages, any 32+ character opaque segment), truncating strings above 8 KiB. The request
and reply reach their serializers (method, redacted URL, host, address; status code), never the raw objects (ADR 0120).

## 10. Webhooks (`/hooks/*`)

Mounted by `hookModules` under `/hooks`; exempt from Origin, CSRF, idempotency and rate limiting; 1 MB body cap; JSON
(`application/json` and `text/plain`, which SNS uses) is parsed into `req.body` and the exact bytes are kept in
`req.rawBody` for signature checks. Register with `webhookRoute(scope, { provider, path, handler })` and verify with
`hmacSha256Hex` + `safeEqual` (constant time). De-duplicate through `webhook_log (provider, external_id)`.
SMS Gate (verified against its docs): `X-Signature` is a hex HMAC-SHA256 over the raw body concatenated with the
`X-Timestamp` value (Unix seconds); non-localhost endpoints must be HTTPS with a valid certificate. The SMS routes must
only be reachable on the tailnet listener, whose SMS Gate route takes bodies up to 16 MB (section 23.5).

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
* Jobs (`src/platform/jobs.ts`, `job-registry.ts`, catalogue in `docs/jobs.md`): pg-boss schema `pgboss`, a dead-letter queue
  `<job>.dead` per job, run records in `job_runs`. `maintenance.purge` runs every 10 minutes (expired idempotency keys,
  realtime events older than 10 min, webhook log older than 90 days) and `maintenance.retention` daily (sessions, 24-month
  messages, bookkeeping); the audit log is never purged. `JOBS_ENABLED=false` makes the queue inert. The worker is
  `src/worker.ts` (`startWorker`); the API process only produces jobs.

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
| POST | `/api/v1/appointments/:id/arrival-link` | sched.edit |  |
| POST | `/api/v1/appointments/:id/arrive` | jobs.status | sched.edit |  |
| POST | `/api/v1/appointments/:id/assign-bay` | jobs.status |  |
| POST | `/api/v1/appointments/:id/cancel` | sched.cancel | required |
| POST | `/api/v1/appointments/:id/checklist/bulk` | jobs.checklist |  |
| PUT | `/api/v1/appointments/:id/checklist/items/:itemId` | jobs.checklist |  |
| POST | `/api/v1/appointments/:id/complete` | jobs.status |  |
| POST | `/api/v1/appointments/:id/confirm` | sched.edit | jobs.status |  |
| GET | `/api/v1/appointments/:id/fee-charges` | pay.collect | sched.cancel |  |
| POST | `/api/v1/appointments/:id/fee-charges/:chargeId/charge` | pay.collect | required |
| POST | `/api/v1/appointments/:id/fee-charges/:chargeId/waive` | pay.collect | required |
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
| PUT | `/api/v1/appointments/:id/vehicle-class` | sched.edit |  |
| POST | `/api/v1/appointments/quote` | sched.edit |  |
| GET | `/api/v1/arrival-settings` | authenticated |  |
| PUT | `/api/v1/arrival-settings` | cli.member |  |
| POST | `/api/v1/arrivals/ping` | public |  |
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
| GET | `/api/v1/catalog` | authenticated |  |
| GET | `/api/v1/catalog/categories` | authenticated |  |
| POST | `/api/v1/catalog/categories` | set.services | optional |
| DELETE | `/api/v1/catalog/categories/:key` | set.services |  |
| PATCH | `/api/v1/catalog/categories/:key` | set.services |  |
| GET | `/api/v1/catalog/guest-fee` | authenticated |  |
| PUT | `/api/v1/catalog/guest-fee` | set.services |  |
| GET | `/api/v1/catalog/guest-markup` | authenticated |  |
| PUT | `/api/v1/catalog/guest-markup` | set.services |  |
| GET | `/api/v1/catalog/plans` | authenticated |  |
| PUT | `/api/v1/catalog/plans/:key` | set.services |  |
| PUT | `/api/v1/catalog/prices` | set.services |  |
| GET | `/api/v1/catalog/services/:id` | authenticated |  |
| PUT | `/api/v1/catalog/services/:id` | set.services |  |
| PUT | `/api/v1/catalog/tier-prices` | set.services |  |
| GET | `/api/v1/catalog/tiers` | authenticated |  |
| POST | `/api/v1/catalog/tiers` | set.services | optional |
| DELETE | `/api/v1/catalog/tiers/:key` | set.services |  |
| PUT | `/api/v1/catalog/tiers/:key` | set.services |  |
| POST | `/api/v1/catalog/tiers/:key/move-members` | set.billing |  |
| GET | `/api/v1/catalog/tint-matrix` | authenticated |  |
| PUT | `/api/v1/catalog/tint-matrix` | set.services |  |
| GET | `/api/v1/catalog/vehicle-classes` | authenticated |  |
| POST | `/api/v1/catalog/vehicle-classes` | set.services | optional |
| DELETE | `/api/v1/catalog/vehicle-classes/:key` | set.services |  |
| PATCH | `/api/v1/catalog/vehicle-classes/:key` | set.services |  |
| GET | `/api/v1/clients/:id/credit` | pay.reports |  |
| GET | `/api/v1/closures` | authenticated |  |
| POST | `/api/v1/closures` | set.hours | optional |
| DELETE | `/api/v1/closures/:id` | set.hours |  |
| PATCH | `/api/v1/closures/:id` | set.hours |  |
| POST | `/api/v1/closures/preview` | set.hours |  |
| GET | `/api/v1/customers` | cli.view |  |
| POST | `/api/v1/customers` | sched.edit |  |
| POST | `/api/v1/customers/:id/card-link` | cli.edit |  |
| GET | `/api/v1/customers/:id/cards` | cli.view |  |
| DELETE | `/api/v1/customers/:id/cards/:cardId` | cli.edit |  |
| GET | `/api/v1/customers/:id/identity` | cli.view |  |
| POST | `/api/v1/customers/:id/identity/confirm` | cli.edit |  |
| POST | `/api/v1/customers/:id/identity/pin/clear` | cli.edit |  |
| POST | `/api/v1/customers/:id/identity/trust/revoke` | cli.edit |  |
| GET | `/api/v1/customers/:id/membership` | cli.view |  |
| GET | `/api/v1/customers/:id/messages` | cli.view |  |
| POST | `/api/v1/customers/:id/messages/read` | msg.send |  |
| GET | `/api/v1/customers/:id/sms-consent` | cli.view |  |
| PUT | `/api/v1/customers/:id/sms-consent` | cli.edit |  |
| PATCH | `/api/v1/customers/:id/vehicles/:vehicleId` | cli.edit |  |
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
| POST | `/api/v1/identity/links/kill` | set.billing + team.roles |  |
| GET | `/api/v1/integrations/sms/devices` | set.billing |  |
| POST | `/api/v1/integrations/sms/devices` | set.billing |  |
| PATCH | `/api/v1/integrations/sms/devices/:id` | set.billing |  |
| GET | `/api/v1/integrations/sms/devices/:id/health` | set.billing |  |
| POST | `/api/v1/integrations/sms/devices/:id/register-webhooks` | set.billing |  |
| POST | `/api/v1/integrations/sms/devices/:id/test` | set.billing |  |
| GET | `/api/v1/integrations/square` | set.billing | pay.reports |  |
| POST | `/api/v1/integrations/square/catalog/sync` | set.billing |  |
| POST | `/api/v1/integrations/square/test` | set.billing |  |
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
| GET | `/api/v1/invoices/:id/card-charges` | pay.collect | pay.reports |  |
| POST | `/api/v1/invoices/:id/card-charges` | pay.collect | required |
| POST | `/api/v1/invoices/:id/card-charges/:chargeId/not-charged` | pay.collect | required |
| POST | `/api/v1/invoices/:id/credit-applications` | pay.collect | required |
| POST | `/api/v1/invoices/:id/credits` | pay.credit | required |
| POST | `/api/v1/invoices/:id/payment-links` | pay.collect | required |
| POST | `/api/v1/invoices/:id/payments` | pay.collect | required |
| POST | `/api/v1/invoices/:id/receipt` | msg.send | pay.collect | required |
| POST | `/api/v1/invoices/:id/refunds` | pay.refund | required |
| POST | `/api/v1/invoices/:id/refunds/:eventId/approve` | pay.refund | required |
| POST | `/api/v1/invoices/:id/refunds/:eventId/deny` | pay.refund | required |
| POST | `/api/v1/invoices/:id/square-pos-intents` | pay.collect | required |
| PUT | `/api/v1/invoices/:id/tip` | pay.collect | required |
| POST | `/api/v1/invoices/:id/void` | pay.void | required |
| GET | `/api/v1/leads` | cli.view |  |
| POST | `/api/v1/ledger-events/:id/confirm-processor` | pay.collect | pay.refund | required |
| GET | `/api/v1/me` | authenticated |  |
| PUT | `/api/v1/me/preferences` | authenticated |  |
| POST | `/api/v1/me/view-as` | authenticated |  |
| GET | `/api/v1/membership-checkouts` | cli.member |  |
| POST | `/api/v1/membership-checkouts/:id/match` | cli.member |  |
| POST | `/api/v1/membership-checkouts/:id/reject` | cli.member |  |
| GET | `/api/v1/membership-plans` | cli.view |  |
| PATCH | `/api/v1/membership-plans/rules/:id` | cli.member |  |
| GET | `/api/v1/memberships` | cli.member |  |
| POST | `/api/v1/memberships` | cli.member |  |
| PATCH | `/api/v1/memberships/:id` | cli.member |  |
| POST | `/api/v1/memberships/:id/billing/cancel` | cli.member | optional |
| POST | `/api/v1/memberships/:id/billing/cancel/undo` | cli.member | optional |
| POST | `/api/v1/memberships/:id/billing/card-link` | cli.member |  |
| POST | `/api/v1/memberships/:id/billing/change` | cli.member | optional |
| POST | `/api/v1/memberships/:id/billing/change/undo` | cli.member | optional |
| POST | `/api/v1/memberships/:id/billing/pause` | cli.member | optional |
| POST | `/api/v1/memberships/:id/billing/refund-last` | pay.refund | required |
| POST | `/api/v1/memberships/:id/billing/resume` | cli.member | optional |
| POST | `/api/v1/memberships/:id/household` | cli.member |  |
| DELETE | `/api/v1/memberships/:id/household/:customerId` | cli.member |  |
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
| POST | `/api/v1/payments/square/:paymentId/apply` | pay.collect | required |
| POST | `/api/v1/payments/square/:paymentId/ignore` | pay.collect | required |
| POST | `/api/v1/payments/square/:paymentId/reassign` | pay.void | required |
| POST | `/api/v1/payments/square/pos-callback` | pay.collect | required |
| GET | `/api/v1/payments/square/unmatched` | pay.reports |  |
| GET | `/api/v1/payments/summary` | pay.reports |  |
| GET | `/api/v1/public/availability` | public |  |
| POST | `/api/v1/public/bookings` | public | required |
| GET | `/api/v1/public/catalog` | public |  |
| GET | `/api/v1/public/catalog/v2` | public |  |
| GET | `/api/v1/public/hours` | public |  |
| POST | `/api/v1/public/links/appointments/:ref/reschedule` | public |  |
| GET | `/api/v1/public/links/availability` | public |  |
| POST | `/api/v1/public/links/bookings` | public | required |
| POST | `/api/v1/public/links/cards` | public | required |
| DELETE | `/api/v1/public/links/cards/:cardId` | public |  |
| POST | `/api/v1/public/links/deposit/start` | public |  |
| POST | `/api/v1/public/links/exchange` | public |  |
| GET | `/api/v1/public/links/me` | public |  |
| POST | `/api/v1/public/links/membership/start` | public |  |
| GET | `/api/v1/public/links/membership/status` | public |  |
| POST | `/api/v1/public/links/membership/subscribe` | public |  |
| POST | `/api/v1/public/links/pay/start` | public |  |
| POST | `/api/v1/public/links/pin` | public |  |
| POST | `/api/v1/public/links/pin/reset` | public |  |
| POST | `/api/v1/public/links/verify/code` | public |  |
| POST | `/api/v1/public/links/verify/code/confirm` | public |  |
| POST | `/api/v1/public/links/verify/pin` | public |  |
| POST | `/api/v1/public/memberships` | public | required |
| POST | `/api/v1/public/otp` | public |  |
| POST | `/api/v1/public/otp/verify` | public |  |
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
| GET | `/api/v1/settings/assistant` | authenticated |  |
| PUT | `/api/v1/settings/assistant` | set.assistant |  |
| PUT | `/api/v1/settings/auto-federal-holidays` | set.hours |  |
| GET | `/api/v1/settings/billing` | set.billing |  |
| PUT | `/api/v1/settings/billing/link-tipping` | set.billing |  |
| PUT | `/api/v1/settings/billing/price-change-notice` | set.billing |  |
| PUT | `/api/v1/settings/billing/renewal-policy` | set.billing |  |
| GET | `/api/v1/settings/bundle` | authenticated |  |
| GET | `/api/v1/settings/cancellation-policy` | authenticated |  |
| PUT | `/api/v1/settings/cancellation-policy` | set.hours |  |
| GET | `/api/v1/settings/card-fees` | set.billing | pay.reports |  |
| PUT | `/api/v1/settings/card-fees` | set.billing |  |
| GET | `/api/v1/settings/features` | authenticated |  |
| PUT | `/api/v1/settings/features` | set.billing |  |
| GET | `/api/v1/settings/hours` | authenticated |  |
| PUT | `/api/v1/settings/hours` | set.hours |  |
| GET | `/api/v1/settings/location` | authenticated |  |
| PUT | `/api/v1/settings/location` | set.hours |  |
| GET | `/api/v1/settings/reminders` | authenticated |  |
| PUT | `/api/v1/settings/reminders` | set.hours |  |
| POST | `/api/v1/settings/reminders/preview` | authenticated |  |
| GET | `/api/v1/settings/rules` | authenticated |  |
| PUT | `/api/v1/settings/rules` | set.hours |  |
| GET | `/api/v1/staff` | sched.view |  |
| GET | `/api/v1/standing-series` | sched.view |  |
| POST | `/api/v1/standing-series` | sched.edit | required |
| GET | `/api/v1/standing-series/:id` | sched.view |  |
| PATCH | `/api/v1/standing-series/:id` | sched.edit | required |
| POST | `/api/v1/standing-series/:id/materialize` | sched.edit |  |
| POST | `/api/v1/standing-series/materialize` | sched.edit |  |
| GET | `/api/v1/system/email-suppressions` | set.billing |  |
| DELETE | `/api/v1/system/email-suppressions/:address` | set.billing + cli.contact |  |
| GET | `/api/v1/system/integrations` | set.billing |  |
| GET | `/api/v1/system/jobs` | set.billing |  |
| GET | `/api/v1/vip` | authenticated |  |
| PUT | `/api/v1/vip` | cli.member |  |
| GET | `/api/v1/vip/clients` | cli.member |  |
| POST | `/api/v1/vip/clients` | cli.member |  |
| DELETE | `/api/v1/vip/clients/:customerId` | cli.member |  |
| POST | `/api/v1/vip/holds` | cli.member |  |
| DELETE | `/api/v1/vip/holds/:id` | cli.member |  |
| GET | `/api/v1/waitlist` | sched.view |  |
| POST | `/api/v1/waitlist` | sched.edit |  |
| POST | `/api/v1/waitlist/:id/accept` | sched.edit | required |
| POST | `/api/v1/waitlist/:id/cancel` | sched.edit |  |
| GET | `/dev-storage/*` | public |  |
| POST | `/dev-storage/*` | public |  |
| POST | `/hooks/ses` | webhook:ses |  |
| POST | `/hooks/square` | webhook:square |  |
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
| `POST /auth/password/forgot` `{email}` | Always 202 `{accepted:true}`; a known active account gets a 1-hour link through the NotificationPort (at most one per minute and three per hour per account; further requests are answered the same and send nothing). The answer takes at least 150 ms and never waits for the SMS or email hop, so its timing does not reveal whether the address has an account. |
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

Role money limits: the request is dollars, everything returned is cents. `PUT /roles/:id/limits/:kind` takes the chip in dollars; `GET /roles` (`limits`, `limitChoicesCents`), `GET /me` (`permissions.*.limit`, `limits`) and the PUT response (`limitCents`) are integer cents with `null` for No limit. `test/scheduling-gaps/role-limit-units.test.ts` fails if the behaviour, the OpenAPI descriptions or this paragraph disagree.

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
| `PUT /roles/:id/limits/:kind` `{value}` | `team.roles` + Super Admin | `value` is **dollars, not cents**: one of 25, 50, 100, 250, 500, 1000 or `null` (No limit), the design's chips; anything else is 422 `Choose 25, 50, 100, 250, 500, 1000 or No limit` (so `2500` is refused). Stored in cents; the response is `{roleId, kind, limitCents}` in **cents** (`25` becomes `2500`). 403 `SUPER_ONLY` for anyone else, 409 `ROLE_LOCKED` for the locked role. |
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
| `POST /emergency/reopen` | Soft-deletes today's and future emergency closure rows (days already over stay), restores replaced planned closures, writes history `"Reopened by {name} · {n} notified"` with real counters. 409 `EMERGENCY_NOT_ACTIVE` when nothing is active. One event on `ops` per transition: `emergency.started` on close, `emergency.reopened` `{id, auto}` on reopen (person or end-time job); there is no `emergency.ended` (ADR 0080). |
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
| `GET /services` | Packages and add-ons with `tasks[{id, label, position}]`, `version`, `taskCount`, `category` (the website fields are section 15.8's). |
| `PUT /services/{id}/checklist` | `{tasks: [{id?, label} | string], version?}`: the whole ordered list, trimmed, blanks dropped; ids are stable (rename and reorder keep them; see ADR 0021 for the tie-break); removed tasks are retired. Calls the `ChecklistSync` port (default no-op). |
| `POST /services`, `PATCH /services/{id}` | Name, price (cents), duration (packages only), `bookableDesk`, `active`, tags, sort; `POST` also takes `category` (an active category; without it the default rule: add-ons → `addons`, tag tint → `tint`, detail/ceramic/exotic/executive → `detail`, else `wash`). Appointments keep their own snapshot. |
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

### 15.6a Reminders, status texts and the lead follow-up: `/settings/reminders` (ADR 0160, plan I)

`GET /settings/reminders` (any session) answers `{reminders{offsetsMin, confirmRequest, categoryPrep{categoryKey: text},
reviewRequest}, statusTexts{checkedIn, checkedInDelayMin, runningLate, lateGraceMin, lateMax, ready, pickedUp, bookAgainLink},
leads{followUpEnabled, followUpDelayMin, businessHoursOnly, withinHours}, categories[{key, label, colour, active}] (read-only),
quietHours{enabled, start, end} (read-only), version}` with `ETag: "<version>"`. The values are the registry settings
`reminders.offsets_min`, `reminders.confirm_request`, `reminders.category_prep`, `reviews.enabled`, `status_texts.*` and `leads.*`;
`version` is the sum of their versions, which any write to any of them raises.

`PUT /settings/reminders` (`set.hours`): any group and any field (strict), `version` or `If-Match` required (428 without, 412
`VERSION_CONFLICT {currentVersion}` when stale; saves take a per-location advisory lock so two never both pass). Each value is
validated by its registry schema, then the section's rules: offsets listed once (stored longest first, at most 5, 1..10080 minutes;
`[]` turns appointment reminders off), a preparation line only for an existing category (`There is no category "x".`), at most 160
characters and plain SMS characters (a line that would make the text UCS-2 is refused), an emptied line removes it; 422 with every
field named (`reminders.offsetsMin`, `statusTexts.lateMax`, ...), and nothing is written. Only changed keys are written, each audited
(`settings.update`, before/after) and published as `settings.changed {section: reminders | reviews | status_texts | leads, key,
version}`. The answer is the view plus `changed` (the keys written). A loaded view may be sent back as it is (the read-only fields are
accepted and ignored).

`POST /settings/reminders/preview` (any session; changes nothing): `{draft?: <the PUT shape without version>, sample?: {firstName?,
date?, startMin?, categories?}}` → `{sample{firstName, startsAt, date, time, categories}, texts[{id, group, label, timing,
templateKey, klass, enabled, text, segments, encoding}]}`: per offset a booked and a confirmed reminder, the review request, the
status texts (checked in = `welcome` without the bay, wash started = `in_progress`, running late = `job_delay`, ready, picked up =
`picked_up`, or `picked_up_link` in class `personal_link` when `bookAgainLink` is on) and the lead follow-up, rendered through the
template registry exactly as sent (GSM-7, the STOP line of automated classes, the segment count; a link is a placeholder as long as a
real personal link). The status texts come from the status-texts module's own composition (`src/modules/status-texts/compose.ts`,
section 23.4b); the picked-up sample is a $45.00 visit paid in full ("Paid in full: $45.00."). The sample visit is tomorrow 10:00 AM
with the categories that have a preparation line (else wash), in catalog order. A draft is validated like a save (422).

The reminders job reads these settings: with `reminders.confirm_request` off a booked visit gets the plain `reminder` instead of the
"Reply C to confirm" request; the preparation lines of the appointment's `categories` (in their order, each text once) are appended
as `{prep}` to both templates ("... at 2:00 PM. Plan for 2–3 hours. Reply C to confirm."). The preview uses the same composition
(`reminderMessage()` in `src/modules/messaging/jobs/reminders.ts`). Tests: `test/settings-http/reminders.test.ts`,
`test/jobs/reminders.test.ts`.

### 15.6b The AI text assistant: `/settings/assistant` (ADR 0160, design section 8, plan G)

`GET /settings/assistant` (any session) answers `{enabled, actionsEnabled, stage allowlist|customers|everyone, allowlist[E.164],
staffPauseHours, faq[{q, a}], capabilities{availability, bookingLinks, membershipLinks, paymentLinks, accountInfo}, behavior{tone
friendly|professional|warm|concise, length short|standard, styleNotes, spanish on|english|handoff, avoidWords[], avoidTopics[],
handoffTopics[], signOff}, server{aiEnabled, actionsEnabled} (read-only), active (read-only), version}` with `ETag: "<version>"`.
The values are the registry settings `assistant.enabled`, `assistant.actions_enabled`, `assistant.stage`, `assistant.allowlist`,
`assistant.staff_pause_hours`, `assistant.faq` and (ADR 0174) `assistant.capabilities` and `assistant.behavior` (all off / empty by
default: `enabled` and `actionsEnabled` false, stage `allowlist`, 12 hours; every capability on, tone friendly, length standard,
Spanish on, no lists, no sign-off: today's behaviour); `version` is the sum of their versions, which any write to any of them raises. `server` are the environment
switches `AI_ENABLED` and `AI_ACTIONS_ENABLED`, which this section cannot change: with `AI_ENABLED=false` the assistant answers nobody
whatever the section says. `active` = `AI_ENABLED` and `enabled`. The allowlist holds the owner's and staff's own mobile numbers,
so a reader without `set.assistant` gets them masked to the last four digits (`+1******0142`); `set.assistant` sees them in full. The
welcome flow's hourly ceiling of new provisional clients, `assistant.new_texters_per_hour` (1..1000, default 30; W4c fixes), is a
registry setting outside this section (section 23.4a, "Welcome flow").

`PUT /settings/assistant` (`set.assistant`, ADR 0174: the section's own permission, given by migration 20261016200000 to every
role that held `set.hours`, the permission it used before): any field (strict; `allowlist` and
`faq` replace the whole list), `version` or `If-Match` required (428 without, 412 `VERSION_CONFLICT {currentVersion}` when stale;
saves take a per-location advisory lock). Each value is validated by its registry schema, then the section's rules: allowlist numbers
are read as E.164 (`(201) 555-0142` becomes `+12015550142`), must be textable US/Canadian numbers, the check the assistant's gate
uses (`normalizeTextableNanp`: no area code 000, no toll-free, premium or other +1 country; `The assistant texts US and Canadian
mobile numbers only.`), each listed once, at most 50; the FAQ holds at most 40 pairs of 1..500 characters each (trimmed), plain text
(no HTML tag and no character a reader cannot see: control characters but a tab or line break, format characters such as zero-width,
direction marks, the soft hyphen and the Unicode tag block, line/paragraph separators, private-use, unassigned and default-ignorable
code points such as variation selectors and Hangul fillers; only the emoji presentation selector after an emoji and the zero-width
joiner between two emoji pass), each question once (case and spaces ignored). `capabilities` and `behavior` are whole objects
(strict; ADR 0174 §3a): style notes at most 400 characters, words 2..40 characters (at most 30), topics 3..80 (at most 15 per
list), every text plain (the FAQ's rules), each list without repeats (case and spaces ignored), a topic either avoided or handed to
the team, and a sign-off of at most 24 characters with no amount, number, link or promise word (`The sign-off cannot hold an amount, a
number, a link or a promise.`). They are stored and validated from this wave on; the turn applies them from the policy wave (K2c)
on, so until then they change nothing. A FAQ that grows the shared knowledge budget past `AI_KNOWLEDGE_MAX_CHARS` is refused with 422
`KNOWLEDGE_BUDGET {usedChars, maxChars, needed}` (section 15.6c); a save that shrinks it always passes. 422
names every field (`allowlist.1`, `faq.0.a`, `staffPauseHours`; a stage outside the enum is the request schema's `body.stage`), and
nothing is written. Only changed keys are written, each audited (`settings.update`, before/after) and published as
`settings.changed {section: assistant, key, version}`. The answer is the view plus `changed`. A loaded view may be sent back as it
is (`server` and `active` are accepted and ignored). Tests: `test/settings-http/assistant.test.ts`.

### 15.7 The public website's hours: `GET /api/v1/public/hours`

The first route of the API that answered without a session (`access.public`, listed in the authz matrix's `PUBLIC_ROUTES`; ADR 0145;
the website's booking routes of section 26 and ADR 0150 followed). It exists for the marketing website, whose nginx host proxies it
to the API with cookies stripped both ways and a 60-second cache in front (`deploy/nginx/oasis-site.conf.template`); the site also
reads it at build time (`site-deploy.sh`).
Code: `src/modules/settings/http/public-routes.ts` over the pure `publicHoursView()` in `src/modules/settings/public-hours.ts`, which
uses the same `dayInfo()` as the dashboard, so the website never disagrees with the shop.

| Topic | Rule |
|---|---|
| Shape | `{tz, generatedAt, today, next, week[7], closures[]}`. `today`/`next`: `{date, weekday, day, closed, openMin, closeMin, opensAt, closesAt, reason, reduced, emergency}`; `today` adds `openNow` and `state` (`open` between the day's times, `opens_later` before them, `closed` on a closed day or after closing). `next` is the next day the shop opens after today within 14 days, or null. `week` is the stored weekly hours, Sunday first (`{weekday, day, open, from, to, fromMin, toMin}`, times null on a closed day). `closures` lists the days of the next 14 that differ from the week: `{date, dateLabel "Monday, Sep 7", name, type closed\|reduced, from?, to?}` (planned closures and emergency days; a regular day off is not a closure). |
| Sources | Weekly hours, live closures of today..+13 days, the active emergency (`emergencySnapshot`), the default location's timezone; computed at the moment of the call with the app clock. A "rest of today" emergency makes today a reduced day that is over (`state: closed`, `reason` the emergency closure name, `emergency: true`). |
| No PII or operations data | No names of people, appointment or vehicle counts, message text, ids or history. Closure `name` is the closure's own name, the one customers are told. Tests walk every key. |
| Caching and limits | `Cache-Control: public, max-age=60`; 60 requests a minute per address (429 `RATE_LIMITED` with `Retry-After`); no cookie is read or set. |
| Tests | `test/settings/public-hours.test.ts` (pure: open, before and after hours, Sunday closed, week boundary, planned closed and reduced days, emergency variants, forbidden keys), `test/settings-http/public-hours.test.ts` (no session, bogus cookie, cache header, forbidden keys before and after an emergency, state flips with close and reopen, Settings changes, 429), the settings contract and the authz matrix. |

### 15.8 Catalog: one source for the website, the bookings and the AI (ADR 0160, plan A and K)

Settings → Catalog. Code: `src/modules/settings/http/catalog-routes.ts` (registered by `registerCatalogRoutes`) over
`src/modules/catalog/{website,categories,plans,appointment-categories}.ts` (and, since ADR 0170, `vehicle-classes`, `class-prices`,
`tiers` and the price book `price-book.ts`: sections 15.9 and 15.10); the seeds are `db/seeds/website-catalog.ts` and
`db/seeds/pricing-defaults.ts`.

**ADR 0170 (vehicle sizes, prices and tiers) changed this section:** prices are per vehicle size (15.9), tiers are editable (15.10);
`PUT /catalog/services/{id}` no longer takes `memberPriceCents`, `guestPriceCents`, `vipInclusion` or `vipNote` (422: unknown
field); `PUT /catalog/tint-matrix`, `PUT /catalog/guest-markup` and `PUT /catalog/plans/{key}` answer **410
`CATALOG_ROUTE_RETIRED`** (their GETs stay, read only, as the deprecated pre-size data); `GET /catalog` gains `vehicleClasses`,
`prices`, `missingPrices`, `tiers` and `guestFee`. The rows below describe the routes as they stand; the pre-size paragraphs
("Prices", "Seed website-catalog") are kept for the history and marked so.
Reads: any signed-in user (`includeInactive=true` on `GET /catalog` needs `set.services`). Writes: `set.services`, one transaction,
an `audit_log` row, `settings.changed`. The `PUT`s are whole-object saves and **require** the version they edited (body `version` or
`If-Match`; 428 `PRECONDITION_REQUIRED` without, 412 `VERSION_CONFLICT` with `meta.currentVersion` when stale); `PATCH` and
`DELETE` enforce it when sent. Every GET of one object sets `ETag: "<version>"`.

| Endpoint | Behaviour |
|---|---|
| `GET /catalog` | The screen in one call: `{categories[], packages[], addons[], vehicleClasses[], prices[], missingPrices, tiers[], guestFee {cents, collect, version}, guestBookingFeeCents}` plus the deprecated pre-size data `tintMatrix {vehicleTypes, films, prices, version}`, `guestMarkup {pct, version}` and `plans[]` (read only); services are the website view below, `prices` one row per listed service (15.9), `tiers` as 15.10 (Square fields to `set.services` holders only). |
| `GET/PUT /catalog/services/{id}` | A package's or add-on's website fields `{category, publicName, description, quoteOnly, visibleOnline, sort}` plus read-only `{id, kind, name, active, priceCents, durationMin, tags, memberPriceCents, guestPriceCents, vipInclusion, vipNote (the four deprecated, stored pre-size values), effective {memberPriceCents, guestPriceCents, tintFilm}, version}`. `effective` is the starting price (the lowest over the active sizes, else the base price) and the member one at the lowest % off of the public tiers that have a price. `PUT` replaces the six fields (texts trimmed, blank = none; the service's version, shared with checklist, price and catalog edits) and answers `changed` and `appointmentsUpdated`; it never changes a price. 422: unknown or turned-off category (a service may keep a category turned off later), texts over 80/1000, an unknown field. A category change re-derives `categories` on the visits not yet finished that hold the service; publishes `{section: "services", key: id}`. |
| `GET /catalog/categories`, `POST`, `PATCH /{key}`, `DELETE /{key}` | `{key, label, colour #RRGGBB, sort, active, builtin, version}` in display order. `key` (lowercase letter, then letters, digits, underscore; up to 32; `mixed` is reserved, 422, being the word `visitCategory` returns) is set at creation and never changes (services, appointments and leads refer to it). 409 `CATEGORY_KEY_TAKEN`; 422 `CATEGORY_LIMIT` past 20. A turned-off category leaves the public catalog with its services and takes no new service. `DELETE`: 409 `CATEGORY_BUILTIN` for the five defaults (turn them off), 409 `CATEGORY_IN_USE` while any service (active or retired) names it. Publishes `{section: "catalog", key: "categories"}`. |
| `GET/PUT /catalog/tint-matrix` | **`PUT` retired (410, ADR 0170); `GET` reads the stored pre-size matrix.** The `catalog.tint_matrix` setting: `vehicleTypes[{key, label}]`, `films[{key, label, vlt[1..100]}]`, `prices[{vehicle, film, memberMinCents, memberMaxCents, guestMinCents, guestMaxCents}]`; each pair once, known keys, ranges not ending below their start (422 with body paths, e.g. `prices.0.vehicle`). A save moves what each tint package charges at booking to its film's lowest guest price (`catalog.price.sync` audit rows). |
| `GET/PUT /catalog/guest-markup` | **`PUT` retired (410, ADR 0170); `GET` reads the stored pre-size markup.** `{pct}` 0..200, the `catalog.guest_markup_pct` setting. A save moves what every item priced by the markup (a member price, no guest price) charges at booking to its new guest price (`catalog.price.sync` audit rows). |
| `GET /catalog/plans`, `PUT /catalog/plans/{key}` | **`PUT` retired (410, ADR 0170): tiers are saved by `PUT /catalog/tiers/{key}` and `PUT /catalog/tier-prices`; `GET` reads the tiers' public fields: `monthlyPriceCents` is the tier's starting price over the sizes, `websiteTier` the key of a public tier.** The plans' public fields `{publicLabel, monthlyPriceCents, perks[], checkoutUrl}` with read-only `{key, name, active, websiteTier gold\|vip\|null, version}`. Perks: up to 12, 120 characters each, trimmed, blanks dropped, no duplicates (also what the Membership tab lists). `checkoutUrl`: https on `squarespace.com` or a subdomain, lowercase host, no user, password or port, up to 2048 (422 otherwise; blank = none); it never appears in the public catalog. Publishes `{section: "catalog", key: "plans"}`. |

**Prices before ADR 0170 (history; `src/modules/catalog/pricing.ts` is gone, section 15.9 replaces it).** Member price = `member_price_cents`, else the plain price (`price_cents`,
what a booking charges). Guest price = `guest_price_cents` (only next to a member price, never below it), else member × (100 +
markup) / 100 rounded half up to whole dollars (the website's `Math.round(m * 1.2)`: $45 → $54, $39 → $47). A tint package (category
`tint`, a tag naming a matrix film) shows the film's lowest member and guest prices ("from") and `tintFilm`. These member and guest
prices are the **starting prices** (design §3b): the only service prices the website and the assistant state. For an item priced on
the website (a member price, or a tint film; not quote-only) `price_cents` is kept equal to the guest price (`bookingPriceOf`): by the
website-fields save, the markup save and the tint matrix save, so a booking never charges other than the guest price shown; an item
without website prices keeps its plain price, which is then also its member price. Charging members their price at booking is a
later wave's.

**Appointment categories.** `appointments.categories` holds the category keys of the package and the live add-ons in category
order. `createAppointment` (every booking path: dashboard, website, standing, assistant), add-on add and remove, and a service's
category change (visits booked, confirmed, arrived or cleaning) keep it; seeds that write appointments directly call
`refreshAllAppointmentCategories`. `visitCategory(categories)` is the one word for a chip or KPI: the category ignoring add-ons,
`mixed` for two or more others (a wash with a tint), `addons` for add-ons alone.

**Seed `website-catalog` (reworked by ADR 0170).** Since ADR 0170 the seed writes **no price**: no member or guest price, no
markup, no tint matrix, no plan price (an adopted row keeps its price, a new row starts at $0 with no price by size and stays off the
public catalog until priced); it sets `catalog.tint_films` when empty, the Gold and VIP tiers' name, perks and `public`, and logs a
`WARNING website-catalog: inclusion "<tier>: <label>" covers no active service` line per inclusion of an active tier that covers no
active service (align them in Settings → Memberships). Run it with `pricing-defaults` (15.9). What follows is the pre-size
description, kept for the history: `pnpm seed -- --profile website-catalog` (production: after `catalog`) makes the website's services the
catalog: Signature Hand Wash ($45 member / $54 guest, 45 min) and Exterior Hand Wash ($32 / $38, 30 min); Carbon and Ceramic window
tint (priced by the matrix, 180 min); Interior detail ($149 / $179, 150 min) and Full detail ($249 / $299, 240 min); the quote-only
Windshield replacement, Rim powder coating, Chrome delete, Car key copies (price 0, 120 / 480 / 300 / 30 min); the nine add-ons with
their VIP inclusion (Hand wax and Engine bay wash included, Leather conditioning 2× / mo, Stain removal 1× / mo); the tint matrix,
markup 20, Gold (premium, $99/mo) and VIP (executive, $169/mo) with the website's perks. It adopts a same-named row (or the design's
Wax, Engine bay cleaning, Rain repellent), deactivates every other active service (never deletes), re-derives the open visits'
categories, audits under "Seed (website-catalog)" and is idempotent; a re-run resets edited fields to the website's content.
Members' credits redeem on service tags and the seed keeps what each plan redeemed: Signature carries `premium` (it replaces the
Premium Hand Wash + Interior), Exterior `express` (it replaces the Express Hand Wash), both `handwash`. It does not change the credit
rules (the memberships module's): the website's perks ("4 hand washes a month") differ from the rules' counts and the executive
"Executive detail" credit covers no website service, so every run logs `WARNING website-catalog: credit rule "<plan>: <label>"
covers no active package`. **Do not run it in production until the owner has decided the Gold/VIP credit rules** (ADR 0160 W2a).
### 15.9 Vehicle sizes and prices by size (ADR 0170)

Code: `src/modules/catalog/{vehicle-classes,class-prices,price-book}.ts`, routes in `src/modules/settings/http/catalog-routes.ts`.
Same rules as 15.8: reads for any signed-in user, writes `set.services`, one transaction, audited, `settings.changed`.

| Endpoint | Behaviour |
|---|---|
| `GET /catalog/vehicle-classes` | `{vehicleClasses[{key, label, sort, active, version}]}` in size order (smallest first), turned-off ones included. Defaults `compact_car` "Compact car", `large_car` "Large car", `compact_suv` "Compact SUV", `large_suv` "Large SUV", `truck` "Truck". |
| `POST /catalog/vehicle-classes` | `{key, label, sort?, active?}` (Idempotency-Key optional) → 201. `key` immutable (lowercase slug up to 32); `label` up to 40, unique case-insensitively (422 `label`); `sort` defaults after the last. 409 `CLASS_KEY_TAKEN`; 422 `CLASS_LIMIT` past **12** sizes. A new size has no prices. Audited `catalog.vehicle_class.create`; publishes `{section: "catalog", key: "vehicle_classes"}`. |
| `PATCH /catalog/vehicle-classes/{key}` | `{label?, sort?, active?, version?}` (version or If-Match enforced when sent) → the size + `changed`. The last size that is on cannot be turned off (422 `active`). Turning a size on or off moves `services.price_cents` of the services priced on it to their new starting price (audited `catalog.price.sync`, reason `catalog.vehicle_classes`). |
| `DELETE /catalog/vehicle-classes/{key}` | Only a size nothing uses: 409 `CLASS_IN_USE` with `meta {key, prices?, tierPrices?, memberships?, checkouts?, creditEvents?, appointments?, vehicles?}` (counts of what uses it; turn it off instead). Never the last active size (422). |
| `PUT /catalog/prices` | `{rows[{serviceId, version, cells[{class, cents \| null, maxCents?}]}]}` (up to 200 rows, 24 cells each) → `{rows[{serviceId, version, cells[], fromCents, missing, changed}], missingPrices}`. **All or nothing:** every row is locked (id order) and its `version` (the service's version) checked before anything is written; a stale row answers 412 `VERSION_CONFLICT` with `meta {row, serviceId, currentVersion}`, a row without a version 428 with `meta {row, serviceId}`, an unknown service 404 with `meta.row`; nothing is saved. A cell sets the regular price in cents (0..$100,000) of a size, `maxCents` an "up to" price (a range, tint; not below `cents`), `cents: null` clears it (not set). Sizes a row does not list keep their cell. 422 with body paths: unknown size (`rows.0.cells.0.class`), a size twice, a service twice, a bad amount. A changed row bumps the service's version, sets `services.price_cents` to its new starting price (unchanged when it has no price left; quote-only services keep theirs), is audited `catalog.price.update` (`before`/`after` `{cells {class: cents \| [cents, max]}, priceCents?}`) and publishes `{section: "services", key}`; the save publishes `{section: "catalog", key: "prices", services[]}`. |

**The price book (`price-book.ts`, pure; loaders `loadPriceBook`, `loadTierCells`, `loadMemberContext`).**

* *Price at a size* (`classPrice`): the size's own cell (`basis class`); no size known, or one unknown or turned off: the first
  active size's cell, else the starting price (`unknown_class`); a known size without a cell: the starting price (`estimated`,
  "confirm the price at the shop"); a service without any cell on an active size: `services.price_cents` (`base`). The
  **starting price** (`fromPrice`) is the lowest cell over the active sizes.
* *Member price* = price × (1 − tier %), rounded **half up to whole dollars** (`memberCents`; never above the price; 0% leaves the
  price as it is): computed, never stored.
* *Coverage* (`priceLine`, `quoteVisit`): the first active inclusion of the member's tier that names the service and can still cover
  it (every_visit, or per_cycle with a credit left or unlimited) covers **min(price at the visit size, price at the plan size)**
  (the plan size's own cell even when that size was turned off later, else the rule above); the line is charged the regular price, the size difference (line − covered) stays due, and neither gets the % off. A whole-visit
  quote spends one credit per covered line. `loadMemberContext` finds the ACTIVE membership a customer holds **or shares as a live
  household member** (`membership_household`), with the tier's % off, VIP flag, plan size and the inclusions' credits left.
  `MembershipPort.pricingFor` exposes it to scheduling (ADR 0040); wave Q2's booking paths, size change and quote use it.

**Seed `pricing-defaults`** (`db/seeds/pricing-defaults.ts`, idempotent, fills only empty cells, audited "Seed (pricing-defaults)"):
Signature Hand Wash (else the cheapest active wash) at `compact_car` (else the smallest active size) **$40**, the Gold tier at
`compact_car` **$129/month**; member % off stays 0; every other cell stays empty. Run it in production after the deploy and read
its log: when the migration already copied an old price into that wash's Compact car cell, the seed keeps it (its log names the kept
price) and the $40 is set in Settings instead.

### 15.10 Membership tiers, inclusions, tier prices and the booking fee (ADR 0170)

Code: `src/modules/catalog/tiers.ts` (tiers, inclusions, tier prices), `src/modules/memberships/plans.ts` (the tier model,
`planByKey` resolving old keys), `src/modules/memberships/credits.ts` (credits by inclusion).

| Endpoint | Behaviour |
|---|---|
| `GET /catalog/tiers` | `{tiers[{key, name, colour, bgColour, sort, active, public, vipBooking, memberDiscountBp, maxVehicles, perks[], checkoutUrl, legacyKey, priceVersion, version, squarePlanId?, inclusions[{id, label, mode per_cycle\|every_visit, perCycle, autoApply, active, serviceIds[]}], prices[{class, monthlyCents, priceVersion, effectiveFrom, squareState?}], fromMonthlyCents, sold}]}` in tier order. `squarePlanId` and `squareState` only for `set.services` holders. `fromMonthlyCents` is the lowest current price over the active sizes (null: no price, not sold online); `sold`: a membership, a personal link or a checkout names the tier. The design's four by default: `essential` and `exotic` (not public), `gold` (legacy key `premium`) and `vip` (legacy key `executive`, `vipBooking`). |
| `POST /catalog/tiers` | `{key, ...the PUT body}` (Idempotency-Key optional) → 201. `key` a lowercase slug, immutable; 409 `TIER_KEY_TAKEN` when a tier holds it as its key **or old key**; at most 12 tiers (422). Starts without prices. Audited `catalog.tier.create`. |
| `PUT /catalog/tiers/{key}` | The whole tier `{name, colour, bgColour?, sort, active, public, vipBooking, memberDiscountBp, maxVehicles, perks[], checkoutUrl, inclusions[], version}`; `version` (or If-Match) required: 428 / 412. `name` up to 40; `colour` #RRGGBB (`bgColour` derived when omitted); `memberDiscountBp` 0..10000; `maxVehicles` 1..20 or null; perks as 15.8 (up to 12, 120 each, no duplicates); `checkoutUrl` a Squarespace checkout or null. `inclusions` replace the tier's list in order: an `id` keeps an existing inclusion of this tier (its credits follow it; another tier's id is 422), no `id` adds one; one left out is deleted, or turned off when credit events name it (then listed after the others). Each: `label` up to 80, `mode`, `perCycle` 1..100 or null (unlimited; must be null for every_visit), `autoApply`, `active?`, `serviceIds` (1..100 services of the catalog). The same tier again answers `changed: false`. Audited `catalog.tier.update`; publishes `{section: "catalog", key: "tiers", tier}`. |
| `DELETE /catalog/tiers/{key}` | Only a tier never sold: 409 `TIER_IN_USE` when a membership (any status), a personal link, a checkout or a Squarespace product names it (turn it off instead). Its price history goes with it. |
| `PUT /catalog/tier-prices` | `{rows[{tierKey, priceVersion, cells[{class, monthlyCents \| null}]}]}` → `{tiers[], changed[]}`. All or nothing as `PUT /catalog/prices`: 412 `VERSION_CONFLICT` `meta {row, tierKey, currentVersion}` when a row's `priceVersion` is stale, 428 without it, 404 for an unknown tier. Prices are **append-only** (`membership_tier_prices`, guard trigger): a changed size supersedes its current price (`superseded_at`) and, unless cleared, adds a new row at the tier's next `priceVersion` with `squareState pending` (wave Q3b syncs it to a Square plan variation); the tier's `priceVersion` moves once per changed row; sizes a row does not list keep their price; members keep the price they joined at (`memberships.tier_price_id`, wave Q3b moves them). Audited `catalog.tier_price.update` (`{priceVersion, prices {class: cents}}` before and after); publishes `{section: "catalog", key: "tier_prices", tiers[]}`. |
| `GET/PUT /catalog/guest-fee` | `{cents, collect counter\|link, version}`: the booking fee guests pay toward the visit (members pay none; ADR 0150), the `booking.guest_fee` setting. `PUT` requires the version (0 before the first save): 428 / 412; `cents` 0..100,000 (422). Audited `settings.update`; publishes `settings.changed {key: "booking.guest_fee"}`. |

**Tier keys are slugs.** Every schema that took the four fixed plan keys takes a validated slug (`^[a-z][a-z0-9_]{0,31}$`): the
membership routes (`planKey`, `plan` filter), the Squarespace product map (`plan`), the public join (`tier`), the link schemas, the
assistant's `send_link {tier}`. An **old key** (`premium`, `executive`) still names its tier wherever a tier is looked up by key
(`planByKey`: staff memberships, the product map, Squarespace product names, the bootstrap `SQSP_PRODUCT_MAP`), so old product
mappings keep working; a resolved tier is always reported under its current key. The website, personal links and the assistant sell
the **active public** tiers by key; the **VIP slot rules** come from the tier's `vipBooking` flag (not from its key).

**Credits by inclusion (`memberships/credits.ts`).** A cycle grants one event per active per_cycle inclusion (none for
every_visit); credits left are counted per inclusion (`coalesce(inclusion_id, rule_id)`, so events written before ADR 0170 count
through the inclusion the migration made from their rule); a visit is covered by the first inclusion naming its package. Since wave
Q2a a visit holds one redeem per covered line (section 24.3); a redeem given back has a `restore` keyed `restore:<redeem id>`. `GET /membership-plans` lists each tier's `inclusions` (and the same list as `rules`, its
old name); `PATCH /membership-plans/rules/{id}` turns an inclusion's auto-apply on or off.

## 20. Operations: appointments, availability, board, calendar

Code: `src/modules/scheduling` (routes in `http/`), customer search and create in `src/modules/customers/http`. Design: backend
design 4.1, 4.2, 4.4, 4.5, 5.3, 7.4; decisions in ADRs 0040-0044. Every transition is one transaction: row lock, guard,
update, `activity_log`, a queued message (`MessageQueue`, never sent inline), `audit_log`, ops events. Guard failures are
problem+json whose `title` and `detail` are the design's toast strings (curly apostrophes included). Success responses carry
the toast for the command (`toast: {title, detail}`) and the changed appointment (`appointment`, a compact core with
`version`, `status`, bays, `late`, `canDrag`); the dashboard refetches the board on the ops events.

Categories (ADR 0160, plan K): every card (`/ops/snapshot`, `/appointments`, `/calendar/day`), the file (`GET /appointments/:id`)
and each visit of its `history.recent`, the command core (`appointment` of every command result, booking included) and the add-on
change carry `categories` (the category keys of the package and live add-ons in the categories' order: `appointments.categories`)
and `category` (`visitCategory()`: the category ignoring add-ons, `mixed` for two or more, `addons` for add-ons alone, null for none).
`GET /ops/snapshot` and `GET /ops/kpis` add `categoryCounts {bizDate, total, items[{key, label, colour, count}]}`: today's jobs that
are not canceled or no-show, each counted once under its `category`; every active category (zero included) in the categories'
order, then `mixed` (colour null); an inactive or unknown category and `_none` (no category) only when something counts under them.
Search and window never affect it; the seven `kpis` are unchanged. Tests: `test/scheduling/categories-dto.test.ts`.

Pay views (`pay` on a card and in the file): `kind` is `paid`, `deposit`, `due`, `pending` or `none`. `pending` (label `Payment pending`, or
`Payment pending · $X due` while the invoice is not fully funded) means card money staff recorded and Squarespace has not confirmed;
`awaitingCents` says how much. It is `paid` only once confirmed (ADR 0074). The invoice summary also carries `taxBp`. Payment changes
also publish `ops` `appointment.updated {change: "payment"}` and `kpi.dirty`.
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
| `POST /appointments` | `sched.edit` (+ `sched.override` with `override`) | **Idempotency-Key required.** `{customer{id? name phone email smsOptIn}, vehicle{year make model color plate}, vehicleId?, vehicleClass?, serviceId, addonIds[], start (ISO with offset) or walkIn:true, source, assignedEmployeeId, plannedBayId, notes, specialInstructions, override{reason}}`. Upserts the customer by phone and the vehicle by plate (or books the client's car `vehicleId`: 422 `vehicleId` for a car that is not theirs), prices the visit at its size (section 20.2a: `vehicleClass`, else the car's size, else unknown; a size named is recorded on the car, source staff), validates the slot under an advisory lock, plans a bay, snapshots the checklist, creates the invoice through the gateway, queues `booking_thanks`. 201 `{appointment, customer, invoice, overrides[], messageQueued, toast, pricing}`. A walk-in starts at the next slot on the grid. |
| `POST /appointments/quote` | `sched.edit` | The booking sheet's price preview, nothing written (section 20.2a): `{customerId?, serviceId, addonIds[]?, vehicleId?, vehicleClass?}` → `{pricing, member \| null, lines[{serviceId, name, kind, listCents, listMaxCents, chargeCents, memberDiscountCents, discountBp, basis, coverage \| null, dueCents}]}`. |
| `PUT /appointments/:id/vehicle-class` | `sched.edit` | `{vehicleClass, version}`: staff set or confirm the size at the shop (section 20.2a). The visit is priced again, the invoice follows, the badges go away; 409 `PRICE_CHANGE_OVERPAID` (nothing changes), 412 `VERSION_CONFLICT`, 409 `INVALID_TRANSITION` (canceled, no-show). The command result with `invoice`. |
| `PATCH /customers/:id/vehicles/:vehicleId` | `cli.edit` | `{vehicleClass \| null}`: a car's size (a size of the shop that is on; 422 otherwise), source staff; 404 for a car that is not the client's. 200 `{vehicle}`; audited `customer.vehicle.update`. |
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
| `PUT` / `DELETE /appointments/:id/addons/:serviceId` | `sched.edit` | Priced at the visit's size for the client (section 20.2a). On a visit the membership already covered the visit is settled again (section 24.3): an add-on an inclusion names is covered, a covered add-on removed gives its coverage and credit back. `{added, changed, addon, invoice, checklist, toast}`; 409 `ADDON_REMOVE_OVERPAID`. |
| `PUT /appointments/:id/checklist/items/:itemId {done}` | `jobs.checklist` | Records who and when. |
| `POST /appointments/:id/checklist/bulk {itemIds, done}` | `jobs.checklist` | A section, or every id for "Check all". |
| `POST /appointments/:id/photos/presign {category, contentType, bytes, note?}` | `jobs.checklist` | Presigned POST (5 min, size policy). JPEG, PNG, WebP up to 15 MB; HEIC is 422. |
| `POST /appointments/:id/photos/:photoId/complete`, `POST .../photos/note {note}`, `DELETE .../photos/:photoId` | `jobs.checklist` | `complete` HEAD-verifies the object and queues the thumbnail job; a note is an issue with no file. |
| `GET /customers?q=` / `POST /customers` | `cli.view` / `sched.edit` | Search (a phone or email token cannot match without `cli.contact`; contact fields are null) and find-or-create by phone with a vehicle, 201 `{customer, created, masked}`. Without `cli.contact` a number that already belongs to someone answers a masked match (SEC-10, ADR 0120): `created: false, masked: true`, `customer.fullName` the initials ("L. C."), `id` null, no contact, vehicles or VIP flag, and the record is not touched; such a caller finds the customer by name. |

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
| `PRICE_CHANGE_OVERPAID` | 409 | `Can’t change the size` / `Refund or adjust the invoice first — the new price would leave the invoice overpaid` (ADR 0170: a size change, or a membership settlement's reprice, that would leave paid above the new total) |
| `ADDON_REMOVE_OVERPAID` | 409 | `Can’t remove add-on` (one copy shared with the payments module) |
| `NOT_AN_ADDON` | 422 | |

### 20.2a Vehicle sizes on a visit (ADR 0170, wave Q2a)

Code: `src/modules/scheduling/{visit-pricing,sizing,booking,addons,invoicing}.ts`, the engine `src/modules/catalog/price-book.ts`.

* **The size of a visit**, in order: the `vehicleClass` the caller names (a size of the shop that is on; 422 `vehicleClass`
  otherwise), then the size on file of the visit's car (when that size is on), else **none**: the visit is priced at the smallest
  size (`unknown_class`, the "starts at" price). Every booking path names it the same way: the staff sheet (`vehicleClass`,
  `vehicleId`), the website and personal links (`vehicleClass`, or a size label sent as the car, section 26.3), the assistant
  (the car named on file), the standing series (the series' car).
* **The snapshot.** The appointment keeps `price_cents` (the charge), `list_price_cents` (the regular price at the size),
  `discount_bp` (the member % off applied), `price_basis` (`class`, `unknown_class`, `estimated` = the size has no price: the starting
  price, `base` = the service has no prices by size, `legacy` = booked before sizes), `vehicle_class`, `vehicle_class_label` and
  `membership_id` (the membership that priced it); each add-on keeps the same price columns; each invoice line `list_cents`,
  `discount_bp`, `price_basis`; the invoice `vehicle_class_label`. A client who holds or shares (household) an active membership is
  charged the member price (price × (1 − tier %), whole dollars, half up) on every line no inclusion covers, and the regular price
  on a line an inclusion will cover (the coverage itself is written when the visit is completed, section 24.3). Only an inclusion that
  applies by itself (`autoApply`, or every inclusion for a member with `autoApply`) is priced and shown as covered by a booking, an
  add-on, a size change or `POST /appointments/quote`; one staff apply by hand is priced as a member line until "Apply credit" covers
  it, so completion never drops a coverage the client was shown (sandbox run F1). `invoice_calc_of` and
  `calcInvoice` do not change.
* **Badges.** `needsSizeConfirm` (no size known) and `needsPriceConfirm` (the package or a live add-on was charged a price the owner
  has not set for the size: its starting price, `estimated`, or the service's one price because it has no prices by size, `base`,
  unless the service is priced on a quote; review Q4 pricing:F2) are on every card, the file and the command core until staff set the
  size (`class_confirmed_at`); never on a visit booked before sizes. The client is not told about a `base` line (`confirmAtShop`). A booking answer's
  `pricing {vehicleClass, vehicleClassLabel, basis, needsSizeConfirm, needsPriceConfirm, member, confirmAtShop, totals {listCents,
  discountCents, coveredCents, dueCents}}`; `confirmAtShop`: a price depends on a size not known yet or without a price (the website's
  and the assistant's confirmations then add "We’ll confirm the exact price at the shop.").
* **Changing the size at the shop** (`PUT /appointments/:id/vehicle-class`): the package and the live add-ons are priced again at the
  size for the client, the invoice is synced (a repriced line is a removed line plus an added one), `class_confirmed_at` is stamped,
  the visit's car gets the size (source staff), activity "Size changed · Large SUV · $70 → $105", audit `appointment.vehicle_class.set`,
  ops `appointment.updated {change: "pricing"}`. A visit the membership already covered is **settled again** at the new size (its own
  credits count as still there, section 24.3): a covered line stays covered, up to the plan size's price, so a Large SUV plan's member
  whose visit was booked with no size owes nothing once the size is confirmed; activity "Membership coverage updated · $40 → $60".
  Refused whole with 409 `PRICE_CHANGE_OVERPAID` when it would leave the invoice overpaid.
* **Reads.** The file adds `vehicleClass`, `vehicleClassLabel`, `needsSizeConfirm`, `needsPriceConfirm`, `priceBasis`,
  `classConfirmedAt`, and `vehicle.vehicleClass` / `vehicleClassSource`; its add-on catalog shows each add-on's regular price at the
  visit's size. The invoice summary (cards, file, command results) adds per item `listCents`, `discountBp`, `memberDiscountCents`,
  `classLabel`, and `vehicleClassLabel` and `coverage[{serviceName, coveredCents, lineCents, differenceCents, planClassLabel}]`
  ("Covered $40 · $20 size difference due"). The invoice detail (`GET /invoices/:id`, section 21) adds the same per item, and
  `coverage` on each adjustment line (null for any other adjustment). Customer search and `POST /customers` vehicles add
  `vehicleClass`, `vehicleClassSource`.
* Tests: `test/scheduling/vehicle-sizes.test.ts`, `test/memberships/settle.test.ts`, `test/public-http/sizes.test.ts`,
  `test/public-links/sizes.test.ts`, `test/assistant-tools/booking-size.test.ts`, `test/standing/sizes.test.ts`.

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
| `GET /payments/summary?range=today\|7d\|30d\|mtd` | `pay.reports` | Inclusive business days ending today (business tz). `{range{key,from,to,label}, kpis{grossSales,netRevenue,refunds,adjustments,creditsIssued,outstanding,counts{invoices,refunded,adjusted,creditInvoices,creditClients,openBalances}}, chart{granularity,buckets[{key,label,title,netCents,lossCents}],maxCents}, byMethod{card,applePay,cash,storeCredit,other}, filterCounts{all,unpaid,refunds,adjusted,credits}, pendingApprovals{count,text,first,all[]}, awaitingProcessor{count,cents}, byCategory[{key,label,colour,count,grossCents,netCents,outstandingCents}]}`. An invoice belongs to a range by `biz_date`. `byCategory` (ADR 0160, plan K) splits the range's invoices by visit category, each invoice once (`mixed` for a multi-category visit, `_none` for none), every active category listed (zero included), then `mixed`; the amounts are the invoices' items (gross), net and balance, so the entries add up to `grossSales` and `outstanding`. |
| `GET /payments/invoices?range&filter&q&limit&cursor` | `pay.reports` | Sorted `bizDate desc, invoiceNo desc`; keyset `nextCursor`. `filter`: `all`, `unpaid` (balance > 0), `refunds` (refunded or pending), `adjusted`, `credits` (issued or applied). `q` matches the joined text of invoice id, client, vehicle and item names, case-insensitive. Rows: `{id,invoiceNo,label,bizDate,date,time,client,vehicle,staff,items{first,more},totalCents,paidCents,balanceCents,status,statusLabel,refundPending,awaiting,adjusted,categories,category}` (`categories`: the appointment's, else those of the invoiced services; `category` as on the board; `awaiting` is `payment`, `refund` or null: card money recorded by staff and not yet confirmed in Squarespace, a refund wins). |
| `GET /invoices/:id` | `pay.reports` | Items (with `refunded` flag), adjustment lines, full `calc`, `refundCaps{cardCents,otherCents,totalCents}` (the refund command's own caps after done and pending refunds: card checks `cardCents` then `totalCents`, cash `totalCents` then `otherCents`, store credit `totalCents`), `clientCredit{balanceCents,nextExpiry}`, `ledger[]` newest first (`occurredAt desc, seq desc`, `atLabel` Today / Yesterday / `Jun 11 · 9:12 AM`), per pending refund `canApprove` and `approveBlock` (`permission`, `limit`, `self`) for the caller, `caller{canCollect,canRefund,...,refundLimitCents}`. |
| `GET /payments/approvals` | `pay.reports` | Pending refunds oldest first with the caller's approval rights. |
| `GET /payments/export.csv?range&filter&q` | `pay.reports` | UTF-8 BOM, CRLF, RFC 4180, plain decimals, dates in the business tz, text cells starting with `= + - @` get a leading apostrophe (numeric columns never). Scope = range and filter and search. `oasis-invoices_{from}_{to}.csv`, at most 20,000 rows (422 `EXPORT_TOO_LARGE`). Columns: `Invoice, Date, Time, Client, Vehicle, Staff, Items, Tip, Adjustments, Subtotal, Tax, Total, Paid, Credit applied, Refunded, Refund pending, Balance, Credits issued, Net revenue, Status`. |
| `GET /payments/reconciliation` | `pay.reports` or `set.billing` | `awaitingProcessor[]` (card money older than 2 h), `unmatchedOrders[]` and `unmatchedTransactions[]` (from the sync's queues through `UnmatchedSource`; empty until wired), `overpaid[]` (last 90 days), `square{paymentsToMatch[], failedRefunds[], refundsInFlight}` (ADR 0171, section 30.7: the Square payments a person has to match, card refunds Square refused in the last 90 days, or with a leg already refused, with what did go back `refundedCents` and what did not `uncoveredCents`, refund legs on their way). |
| `GET /clients/:id/credit` | `pay.reports` | Balance, next expiry and the lots (`state` active / used / expired). |
| `POST /invoices/:id/payments` `{method: card\|cash\|payment_link, url?}` | `pay.collect` | Collects the full balance. Cash: `pay` event, `processorState na`. Card (the "Square reader" tender): `pay` event that counts immediately with `processorState awaiting_processor` until the processor confirms it (Square: the counter matcher, rule R3, fills `Visa ••4242`; Squarespace: the sync or staff); label is the card brand only (`Card`, or `Visa` from a `CardHintProvider`), never invented digits. `payment_link`: before the Square cutover needs an https URL on an allowed host (`PAYMENT_LINK_HOST`), creates a `payment_links` row, queues the SMS, no ledger event; with `PAYMENT_PROCESSOR=square` see `payment-links` below (`url` ignored). 422 `PAY_NOTHING_TO_COLLECT`. |
| `POST /invoices/:id/credit-applications` | `pay.collect` | `min(usable credit, balance)`; FIFO allocation. 422 `PAY_NOTHING_TO_APPLY`. |
| `POST /invoices/:id/refunds` `{mode: full\|items\|custom, itemIds?, amountCents?, dest: card\|credit\|cash, reason?, note?}` | `pay.refund` | Value: full = refundable; items = selected lines plus tax at the invoice rate, capped at refundable, each item at most once (`ITEM_ALREADY_REFUNDED`); custom = amount. Checks in the design's order: `REFUND_EXCEEDS_CARD` (`Only $X was paid by card — refund the rest to store credit.`; $X is the smaller of the non-credit money still there to give back and the card and wallet money still there, pending requests reserving both), `REFUND_EXCEEDS_REFUNDABLE`, then for `dest: cash` `REFUND_EXCEEDS_ORIGINAL` (`Only $X was paid by card or cash — refund the rest to store credit.`: store credit never comes back as cash). An amount above 2,147,483,647 cents is `422 PAY_AMOUNT_INVALID`. **Pending exactly when the amount is strictly greater than the caller's refund limit**, else done; a done card refund is `awaiting_processor`. With `PAYMENT_PROCESSOR=square` a card refund on an invoice holding Square card money is written with `processor: square`: the job `square.refunds.submit` sends it through the Square API (section 30.9); a refund Square refuses becomes `processorState failed` and **no longer counts as refunded**. |
| `POST /invoices/:id/refunds/:eventId/approve` | `pay.refund` | Limit of at least the amount (403 `CANT_APPROVE`, title `Your role can’t approve $80.00`); the requester cannot approve their own request unless unlimited or `approvals.allow_self` (403 `SELF_APPROVAL`); refundable and card cap are re-validated without the request's own reservation; 409 `REFUND_NOT_PENDING`. The event keeps its time; `approvedBy` is `Name · Roles`. |
| `POST /invoices/:id/refunds/:eventId/deny` `{note?}` | `pay.refund` | The requester may withdraw. |
| `POST /invoices/:id/adjustments` `{kind, unit: $\|%, value, reason?, note?, settle?}` | `pay.adjust` | `value` is cents for `$`, basis points of the items subtotal for `%` (1000 = 10%); applied before tax. Over the limit: 422 `OVER_LIMIT` with `Over your $25 limit as Customer Support. Ask Management or a Super Admin.` (no approval path). `ADJUST_EXCEEDS_INVOICE`, 409 `INVOICE_CANCELED`. A discount that leaves a paid invoice overpaid adds a settlement **refund event** (`settle` credit by default or card) under the normal refund rules (pending above the caller's refund limit, card settlements await Squarespace); `{event, settlement, invoice}`. |
| `POST /invoices/:id/credits` `{amountCents, reason?, note?, expiry: none\|d30\|d90 (or the design labels)}` | `pay.credit` | Expires at the end of the business day 30 or 90 days out. Over the limit: 422 `OVER_LIMIT` (`Over your $50 limit as Customer Support.`). |
| `POST /invoices/:id/void` `{eventId, note?}` | `pay.void` | Cash, or card still awaiting its processor; 422 `VOID_NOT_ALLOWED` (the detail names the processor: Square, Squarespace or "the card processor"), 409 `PAYMENT_ALREADY_VOIDED`. |
| `PUT /invoices/:id/tip` `{tipCents}` | `pay.collect` | Untaxed; reopens a balance when the invoice was settled. |
| `POST /invoices/:id/receipt` | `msg.send` or `pay.collect` | SMS to opted-in clients and email, through the `PaymentMessenger` port; audited; not a ledger event. |
| `POST /invoices/:id/payment-links` `{kind: balance\|deposit, amountCents?, url?}` | `pay.collect` | Before the Square cutover: attach and text a Squarespace checkout or invoice link. With `PAYMENT_PROCESSOR=square` (ADR 0171 D3): a `balance` link is the client's personal pay page while `PUBLIC_LINKS_ENABLED` (template `payment_link_personal`, the link masked in the message row; `paymentLink.url` null, `provider personal`), else a Square link made now for exactly the balance (its lines, a "Sales tax" line and a "Tip" line, or one "Balance due" line; asserted to add up exactly); a `deposit` is a Square quick-pay link for `amountCents`. The Square call runs before the transaction (idempotency `prepare`); the link becomes active under the invoice lock (409 `CONCURRENT_UPDATE` if the amount changed meanwhile), older active links of the purpose are superseded (and deleted at Square by `square.links.sweep`). 409 `SQUARE_WRITES_OFF` (watch-only), 503 `SQUARE_UNAVAILABLE`. `paymentLink{id,url,expectedCents,purpose,sms,provider}`. |
| `POST /ledger-events/:id/confirm-processor` `{processorRef?, sqspOrderId?}` | `pay.collect` for a payment, `pay.refund` for a refund | `awaiting_processor` to `confirmed` by hand; 409 `EVENT_NOT_AWAITING` (names the processor); 409 `REFUND_SENT_TO_SQUARE` for a refund sent through the Square API, or one the Square job will send (`processor square` while `PAYMENT_PROCESSOR=square` and Square writes are on; its legs settle it; the "Card refund not confirmed" alert then offers Review, not Confirm). Observe-only: confirmed by hand as before. |

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
* `PAYMENT_LINK_HOSTS` (optional, comma separated; a host matches itself and its subdomains; `=host` matches that host only) is the
  allow-list for payment link URLs. Default: `squarespace.com` (until `PAYMENT_PROCESSOR=square` retires it), `=square.link`,
  `=checkout.square.site`, and the Square sandbox's `=sandbox.square.link` and `squareupsandbox.com` outside production (ADR 0171;
  review Q4: never `square.site` as a whole, any Square Online seller's store is on it). A sandbox host never passes in production,
  whatever the list says. It is read directly from the environment (it is not part of `loadEnv`).
* While a saved-card charge of the invoice waits for Square (`charging` or `unknown`), `POST /invoices/:id/payments`,
  `POST /invoices/:id/payment-links`, a Square link made for the staff or the pay page, and `POST /public/links/pay/start` answer
  409 `CARD_CHARGE_IN_PROGRESS` (ADR 0171 Q4 H1).
* Invoice detail and ledger rows (ADR 0171): each ledger event carries `processor` (`squarespace|square|null`) and
  `processorOrderId`, `source` may be `square`, and (wave Q3 dashapi) `receiptNumber` / `receiptUrl` for a Square payment; the
  detail carries `processing{processor, squarePosAppSwitch, squareTenders{reader, link, savedCard}}` (section 30.13).
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
                                                   / mms:received (recorded only) / mms:downloaded (routed like sms:received)
        -> webhook_log (persist) -> 2xx -> one transaction: outbox + message state, inbound router, device health
```

A booking that rolls back takes its text with it. Nothing is sent inline. A text the policy refuses is **not** persisted: the
caller learns `skipped` (`opted_out`, `not_opted_in`, `no_valid_phone`, `synthetic_number`, `not_allowlisted`, `too_long`,
`template_error`) and scheduling writes it on the activity log ("... (not sent: customer opted out of SMS)").

### 23.2 Endpoints (`/api/v1`)

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /appointments/:id/messages` | `cli.view` | The Messages tab. `{items: Message[], customer: {id, name, smsOptedIn, optedOut, hasPhone, canMessage}, unread, assistantActive, aiPausedUntil, handoff{open, since, reason}}`, oldest first. The AI state (ADR 0160): `assistantActive` = `AI_ENABLED` and Settings → Assistant on (show the "AI paused" line only then); `aiPausedUntil` = `message_threads.ai_paused_until` while it lies ahead (a staff reply pauses the AI `assistant.staff_pause_hours`), else null; `handoff` = the open handoff of the client's number (`assistant_conversations` by client or phone: `since` = `handoff_at`, `reason`), `{open: false, since: null, reason: null}` when none. Outbound texts of the appointment and inbound replies attributed to it. No phone number in the payload. `?markRead=true` clears unread (needs `msg.send` to take effect); `?limit` (default 200). |
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
| `POST /integrations/sms/devices/:id/register-webhooks` | `set.billing` | Registers the nine `oasis-*` webhooks: the seven SMS events plus `mms:received` and `mms:downloaded` (idempotent; stale `oasis-*` ones removed). Needs `SMSGATE_WEBHOOK_PUBLIC_URL` (HTTPS) except for loopback and simulators. |
| `GET /integrations/sms/devices/:id/health?refresh=` | `set.billing` | Device state plus the dispatcher: `state` (idle, sending, rate_limited, quiet_hours, device_offline), the sliding-window budget, queue depth by lane with ETAs, quiet hours, failures in 24 h. |
| `POST /dev/sms/inbound`, `GET /dev/mail` | `set.billing`, only with `ALLOW_DEV_ENDPOINTS=true` | Inject a text into the simulated device (handled by the same code path; returns once applied); read the console mailbox. |

`Message` = `{id, direction in|out, from staff|system|customer, author staff|system|customer|ai, senderName, text, time "10:36 AM", at, channel, status, error, templateKey, appointmentId, customerId, segments, read, kind sms|mms, attachments}`.
`kind` is `mms` for an inbound text that arrived as MMS (`channel` stays `sms`: same thread). `attachments` lists its parts
(`[]` for an SMS): `{index, name, contentType, size, status stored|listed|unavailable|skipped}`; `stored` pictures are in the
photos store (no URL or key is exposed yet). The text of an MMS is its body, else the text of its `text/plain` parts, else its
subject. An MMS with no text reads `[Picture message]`, or `[Picture message — content unavailable]` when the device could not
download it; when the complete delivery of such an incomplete MMS arrives later, it is filed normally and the placeholder message is
removed (`message.removed`).
The assistant's own texts (`sender_kind` `ai`) read `from: system`, `author: ai`, `senderName: "Oasis AI"` (the "Oasis AI" tag).
`status` is `queued sending sent delivered failed received canceled expired`; the outbox states `accepted` and `sent` both read as `sent`.
The dashboard's `MessagesPort.thread` is typed as a bare array today; the live wave must read `.items`.

### 23.3 Realtime

Channel `messages` (needs `cli.view`), full payload (the message as above): `message.out` (queued), `message.in` (received),
`message.status {id, status, error, customerId, appointmentId, threadId}` on every state change, `message.removed {id, customerId,
appointmentId, threadId, reason: "superseded"}` when an incomplete-MMS placeholder gives way to the complete message. Channel `notifications`
(targeted at each manager's user): `notification.new {id, kind}` for `sms.device_offline`, `sms.device_recovered` (each at
most once per device per 30 minutes, ADR 0122), `sms.app_restarted`, `sms.no_device`, `sms.cancel_request`,
`sms.unattributed_reply`, `sms.picture_message` (an MMS with no text, from anyone: "Picture message from <name or masked number> —
check the tablet / dashboard"; entity the appointment, else the customer, else none; once the complete delivery of an incomplete
MMS arrives, its alert is marked read and reads "The full message arrived later and was filed in its place.", announced as
`notification.updated {ids, reason: "superseded"}`), and `sms.device.health {deviceId, label, from, to}` on every device state change.
Channel `ops`: `alerts.changed {source: 'sms'}` when a reply arrives or is read, a device changes state. Managers are active
employees with a login who hold `set.billing` or `sched.override` (Super Admin, Management, Accounting, plus any per-person Allow).

Needs Attention (alerts 10 and 11 of design 4.4, `src/modules/messaging/adapters/alerts.ts`): `new_reply` (one per appointment, or
per customer when a reply could not be attributed; a customer's CANCEL is red) and `sms_device_down` (managers only: a device
offline, or key `sms_no_device` "No SMS device" while texts are queued and no device is enabled).

### 23.4 Policy summary

Every text has a class (`src/modules/messaging/policy/classes.ts`): lane 0 `welcome ready addon_approval staff_invite password_reset` and the keyword replies,
lane 1 confirmations, receipts, payment links, `staff_message`, `quick_reply` and the website's `otp_code` (never lane 0: a stranger asking for
codes must not spend the reserve, review 2026-10-10), lane 2 `confirm_request reminder review late_nudge`,
lane 3 `emergency closure_notice broadcast`. Quiet hours (`SMS_QUIET_HOURS`, default 21:00-08:00 in `BUSINESS_TZ`) hold only
`confirm_request reminder review late_nudge closure_notice broadcast`; the TTL clock starts when the hold ends. The emergency
fan-out is lane 3, not lane 0 (review B15): the blast can use at most 24 of the 30 segments in a window, so a ready-for-pickup
text is never starved. Outside production only `SMS_ALLOWLIST` numbers are texted; synthetic (seed) numbers never in production.

Inbound keywords (`src/modules/messaging/inbound/keywords.ts`; the whole message, any case, edge punctuation ignored): opt-out
STOP, STOPALL / STOP ALL, UNSUBSCRIBE, END, QUIT, REVOKE, OPTOUT / OPT OUT (two-word forms also with a hyphen, underscore or dot);
opt-in START, UNSTOP, YES when opted out; HELP; confirm C, CONFIRM, YES with a booking waiting. CANCEL is a cancel request to
staff, not an opt-out, and Spanish words are not keywords: both are open decisions for the owner (ADR 0124).
AGENT asks for a person while the AI assistant serves the number (23.4a); otherwise it is an ordinary message.

### 23.4a The AI assistant's inbound and dispatch plumbing (ADR 0160, wave W2d)

All of it is inert while `AI_ENABLED=false` (default) or settings `assistant.enabled=false` (default): every text then routes exactly
as described above (the existing inbound suites run unchanged).

- **Gate** (`src/modules/assistant/ports.ts` `AssistantGate`; Postgres implementation `src/modules/messaging/assistant/gate.ts`),
  consulted by the inbound service before routing. `active` needs, in order: `AI_ENABLED`, `assistant.enabled`, a real sender that is
  not ours (no alphanumeric id or short code, not `BUSINESS_PHONE`, not the number the device reports the text was sent to: the payload's `recipient`; the parser's
  `phoneNumber` fallback is the sender on `sms:received` and is never taken for it, so a delivery without `recipient` is judged on
  `BUSINESS_PHONE` alone, while a stated `recipient` equal to the sender is a device texting itself and is held back), a US/CA
  mobile number (`normalizeTextableNanp`), the stage (`allowlist`: in `assistant.allowlist`; `customers`: a client the stale-record rule does not hold; `everyone`), no
  opt-out (the number's or the client's). `allow` needs `active` plus: the thread not paused by staff
  (`message_threads.ai_paused_until`), no open handoff on the number's conversation, and the loop breakers
  (`src/modules/messaging/assistant/loop-breakers.ts`: the 3rd identical text within 30 min, more than 5 texts within 1 min).
- **Routing** (`inbound/router.ts`): keywords keep priority (STOP, START/UNSTOP/YES-opt-in, HELP, C/CONFIRM, CANCEL). New keyword
  **AGENT** (whole message, any case): while `active`, a handoff (decision `handoff`): the number's conversation gets
  `handoff_state='open'` (`handoff_reason='agent_keyword'`, its pending marker cleared), the text is filed unread (a stranger's stays in
  the quarantine list), managers get a notification `assistant.handoff` (`source_ref` `assistant_handoff:<conversation>`; only when
  the handoff opens: AGENT again on a handoff that is still open, from a client or a stranger, pages nobody again) and the
  Needs-attention list an `ai_handoff` alert (it replaces that client's `new_reply` alert). When `allow`: plain texts (SMS and an MMS's
  text, never a picture placeholder) go to the assistant (decision `assistant`): a client's is filed **read** (no new-reply alert), a
  stranger's stays in `sms_inbox` unquarantined (non-E.164 senders are still quarantined); a picture message routes as before.
- **Welcome flow** (owner 2026-10-11; port `NewTexters.adopt`, default: no client): a stranger's plain text that the gate admits is
  offered to the port inside the webhook transaction, before the marker. When wave 3 returns a client (the provisional "New texter
  ••NNNN", source `inbound_sms`, consent `inbound_text`, `needs_details`, plus its lead), the text is filed **read** in that client's
  thread (`sms_inbox.customer_id`/`message_id` set) and the conversation carries the client; the next text comes from a client. Codes,
  AGENT, picture-only texts and a closed gate never adopt. The hourly ceiling (settings `assistant.new_texters_per_hour`, default 30;
  W4c fixes): beyond it the port refuses (`{refused: 'ceiling'}`) and the first text is stored quarantined as an unknown sender's (no
  client, no lead, no marker, no AI reply); the managers get one `assistant.new_texters_ceiling` notice per clock hour. A returning
  texter's archived record is restored whatever the count (one the stale-record rule holds is not restored: below).
- **Codes**: a digits-only text (4-8 digits, spaces and dashes between them ignored, `parseReplyCode`) while an in-chat action waits
  for its reply number from that phone (`assistant_pending_actions` pending and unexpired) is decision `action_code`: the digits go only
  to the `ActionCodeHandler` port (wave 3), never to the model. The handler applies the turn's gate first (W4c fixes: the switches,
  then `stageAndConsent`: the stage, a non-stale client in stage customers, no opt-out); refused, the action is canceled unanswered.
  Every handoff (`AssistantInbox.openHandoff`: AGENT, the fallback, the guard, a cap, `handoff_to_staff`) and a staff takeover cancel
  the number's pending action. With no action waiting and `allow`: a canned `code_on_link_page` reply
  (class `ai_reply`, at most one per number per 30 min). Either way the text is stored as `[code]` in `sms_inbox`, the thread, the
  event stream and `webhook_log` (the payload's `message`/`body` fields are masked once the row is final; a repeat of the same
  device message in another envelope is masked when the first delivery was, and a row that is final without being routed, an unknown
  device or an envelope the sweep gives up on after 24 h, is masked whenever its text is digits-only 4-8).
- **Durable marker** (`AssistantInbox.markPending`, in the webhook transaction): `assistant_conversations` upserted on
  `(location, phone)` with `pending_since` (the oldest unanswered text of a burst), `last_inbound_at`, `customer_id`;
  `sms_inbox.assistant_conversation_id` linked. After the transaction commits the webhook calls `AssistantKick.kick(conversationIds)`
  (default: nothing; wave 3 sends `ai.respond`). A failed kick is logged and left to wave 3's sweep.
- **Staff takeover** (`DbMessageQueue.enqueueFor` with `senderKind: 'staff'` on a client's thread): `ai_paused_until = now +
  assistant.staff_pause_hours` (never earlier than it was), `ai_paused_by` the employee, open handoffs of the client's conversations
  resolved, their pending markers cleared and their `assistant.handoff` notifications marked read, and a pending in-chat action of the
  client or the number canceled (W3b). Recorded even while the AI is off.
- **Dispatcher sub-cap**: `ai_reply`, `ai_fallback`, `personal_link`, `action_confirm` and `lead_follow_up` (W4c fixes: a spoofed first
  text also triggers a follow-up) together never spend more than
  `AI_SMS_SEGMENTS_PER_30MIN` (default 12) of a device's 30-minute window (`sms_usage.klass` records the class of each send); they are
  lane 1, so they never touch lane 0's reserve. An AI text over the cap waits (`TickReport.aiCapped`) and expires with its TTL.

### 23.4b Status texts as the car moves (ADR 0160, design section 6, wave W3d)

`src/modules/status-texts/**` implements the scheduling `StatusTextsPort`, which `lifecycle.finish()` calls inside every transition's
transaction (wired in `src/http/modules.ts` and `src/composition.ts schedulingPortsFor`; absent = `noStatusTexts`). The texts read
Settings → Reminders (`status_texts.*`, section 15.6a). **Checked in, running late and picked up are off by default** (nothing
switches on by itself in production); ready for pickup was sent before and stays on.

| Text | When | Template / class | Dedupe key |
|---|---|---|---|
| Checked in | a **manual** arrival queues a `pending_checkin_texts` row due `checked_in_delay_min` (3) later; job `appointments.checkin_texts` (every minute) sends it. Dropped (`drop_reason`) when the wash starts first (`cleaning_started`: the existing "wash started" text goes instead), the visit is canceled / a no-show (`canceled`), the setting is off at send time (`disabled`), or the text cannot go or is over 15 minutes late (`not_sendable`). A geofence arrival already got its welcome text (with the bay): no row. | `welcome` without the bay ("Welcome to Oasis! You’re checked in.") / `welcome` | `status:checked_in:<appointment>` |
| Wash started | unchanged (`in_progress` at start / assign-bay) | `in_progress` | none |
| Running late | job `appointments.late_texts` (every 2 minutes): a visit still `cleaning` past its promised end (the booked end, or cleaning start + duration when the wash began later) + `late_grace_min` (10); the next one only past the estimate it gave + the grace; at most `late_max` (2; 0 = none); never more than 30 minutes after its moment (a visit left "cleaning" after the car went home gets no stale text). New estimate = now + 15 minutes rounded up to 5 ("New estimate: 11:05 AM."). An attempt that could not go (opted out) still uses its `seq`. | `job_delay` / `job_delay` (lane 1, TTL 20 min) | `status:running_late:<appointment>:<seq>` + `appointment_late_texts (appointment, seq)` |
| Ready for pickup | unchanged at completion, but only while `status_texts.ready` is on (default on); off: no text, `ready_notified_at` stays null, activity "Ready-for-pickup text is off in Settings", toast "Moved to pickup". The staff's own "notify ready" button always sends. | `ready` | none (as before) |
| Picked up | pickup `collected`, at once: "Thanks for visiting Oasis Auto Spa, Maria!" + "Paid in full: $54.00." when the visit's invoice owes nothing, was not free and no `receipt` text went to the client in the last 2 hours; a placeholder name (`needs_details`) is never used. With `book_again_link` on, the link pages on (`PUBLIC_LINKS_ENABLED`) and **marketing-grade consent** (`hasMarketingConsent`: opted in from `web_form` / `inbound_reply`, not opted out) a `book_again` personal link (issued by `system`, 14 days, one booking) is added: then the text is `picked_up_link` in class `personal_link` (the message row shows `[private link]`, only the outbox carries the URL, the link row exists only if the text was queued). A reopened and re-collected pickup sends nothing more. | `picked_up` / `picked_up` (lane 1), or `picked_up_link` / `personal_link` | `status:picked_up:<appointment>` |

Every text goes through `DbMessageQueue.enqueueFor` under its class policy: normal consent (opted in; STOP refuses it at enqueue), and
all of them are transactional, so quiet hours never hold them. A text that cannot go leaves an activity line ("Checked-in text not sent
(customer opted out of SMS)"); a sent one "Checked-in text sent", "Running-late text sent · new estimate 11:05 AM", "Picked-up text
sent" (actor `automation`). The port's work runs in a savepoint: an unexpected error is rolled back to it and logged, and the staff's
transition still commits. Tests: `test/status-texts/*` (compose, the port and jobs on Postgres with the real queue, the worker, the
production HTTP composition), `test/settings-http/reminders.test.ts` (the preview).

### 23.4c The AI assistant's turn (ADR 0160, wave W3a)

No route: the turn runs in the worker (`src/modules/assistant/**`). Inert with the defaults: nothing is marked while the gate is
closed (23.4a), and `ai.respond` / `ai.sweep` return at once while `AI_ENABLED=false`.

- **Jobs**: the webhook's kick sends `ai.respond {conversationId}` (stately, `singletonKey` = the conversation, `startAfter`
  `AI_DEBOUNCE_MS`, 8 s). The job defers itself while the newest text is younger than that, at most 45 s after the first text of the
  burst, then runs one turn. `ai.sweep` (every minute) re-kicks markers older than 30 s that no turn holds and fails leases
  (`running_since`) older than 3 minutes: the turn row `failed` (`lease_timeout`), the fallback text and a handoff.
- **Turn** (`turn.ts`): the gate again (a closed gate clears the marker and marks the client's thread unread, except after an
  opt-out); the caps (per number 8 an hour and 25 a business day, a number with no client or a stale record 10 a day; shop-wide 100 an
  hour and 600 a day, counting turns that called the model; `AI_DAILY_BUDGET_USD` against today's summed `cost_micros`; while a
  shop-wide cap or the budget holds, a stopped conversation gets no fallback text and no `assistant.handoff` notice of its own: the
  managers get one `assistant.cap` notice per cap window, the hourly cap once a clock hour, the others once a business day); the claim
  (conversation row lock, lease, `assistant_turns` row `running` with trust `unknown`|`known`|`trusted` and `prompt_version`); the
  context; the Converse loop; the output guard; the reply; `audit_log` `assistant.reply` (actor "Oasis AI (SMS)"); the marker cleared,
  or kept from the oldest newer text and kicked again when texts arrived meanwhile. A staff text or AGENT during the model call wins:
  the reply is not sent (turn `skipped`, `superseded`).
- **What the model reads** (never a client's phone number, an id, a token, a URL or a code): system blocks = the static rules, the
  SHOP FACTS (cache point after them), the turn context (now, first name or "new client, name unknown, first contact", verified phone
  and until when, in-chat booking on/off, membership, vehicles, appointments as A1..A3, the next intake step: name, intent,
  memberships, vehicle); the tools with a cache point (`toolChoice` auto, action tools only while `AI_ACTIONS_ENABLED` and
  `assistant.actions_enabled`); one user message with the texts of the last 48 h (at most 20; "(staff)" lines, numbers masked,
  the unanswered ones marked NEW). At most 4 tool rounds, then one "reply now without tools" call; `AI_TIMEOUT_MS` per call,
  `AI_TURN_DEADLINE_MS` per turn. Tool calls run through the W3 contract (unknown tool, actions off, trust below `minTrust`, a
  strict-schema miss and an exception never run or never leak) and are recorded in `assistant_tool_calls`.
- **Shop facts** (`facts.ts`, design 3b): every setting as one read-only document (business, texting and calling numbers, email,
  hours, closures of the next 30 days, today, booking rules, guest fee, cancellation, VIP, arrival, automatic texts, the catalog with
  member/guest STARTING prices, tint "from" prices and quote-only items, the plans, the FAQ), cached per location by a hash of the
  source rows, the business date and the env values; byte-stable; Settings free text flattened to one line.
- **Output guard v4** (`guard.ts`, `judge.ts`; design 3c, ADR 0160 W3a notes): three layers. (1) Amounts are SERVER-RENDERED as
  self-contained phrases that name their own subject: `{price:<itemKey>}` "Signature Hand Wash starts at $45 for members, $54
  otherwise" (quote-only "<name> is priced by quote - text us a photo"), `{price:tint:<vehicle>:<film>}` "Carbon tint for a
  sedan/coupe starts at $229 ...", `{plan:<key>}` "Gold is $99 a month", `{fee}` "Guests pay a $25 booking fee" ("There is no
  booking fee"), `{balance}` "Your open balance is $12.50" (only after `get_balance` in the turn), and `{linkN}`. The facts and the
  prompt name keys, never figures. A placeholder must stand as its own clause: it starts the text or follows `. ! ? ; :`, a spaced
  dash or a line break, and ends the text or is followed by `. ! ? ; : ,` or a spaced dash (`placement`). (2) A small deterministic
  layer on the RAW text: an unknown placeholder (`unknown_placeholder`); a currency sign or money word (dollar(s), dólar(es),
  cent(s), centavo(s), peso(s), USD, buck(s) but not the name "Buck") (`money`); a code or phone number: 5+ digits in a row, 7+
  digits in one group split by spaces, dashes, dots, slashes or underscores, 3+ numeric tokens holding 7+ digits, every digit
  counted (clock-time and duration disguises; only an ascending list of appointment times inside the opening window passes:
  "Openings: 9:10, 9:40, 10:20"), 5+ spelled digits, an extension, a vanity number, look-alike letters for digits (`digits`; the
  shop's own numbers, address, catalog and plan names excepted, punctuation and the state name normalised; client-entered text such
  as a vehicle never is); anything host-shaped incl. "period com", "punto com", "-dot-", ";com",
  "<word> com slash", an IP, "http", "hxxp", "www", "://" but `{linkN}` and the shop's own host as plain text (`url`); an
  unambiguous secret REQUEST only (W4a): a request verb (send, reply, text, tell, type, give, share, read, provide, confirm, "let
  me know"; envía, manda, dime, dame, pasa, escribe, responde, ...), "what is your", "cuál es tu" or "need your", then in the same
  clause a PIN, passcode, password, OTP, CVV, card number/details, a verification/security/one-time code, "the/your code", "the 6
  digits", "the digits on your card" (contraseña, clave, código but not código postal/promocional, número de tu tarjeta), or such
  a secret followed by "please" (`secret`), on the plain text and a skeleton; the shop's own sending ("we'll text you a code") is
  no request, and a mention ("I lost the code", "ZIP code", a quoted PIN, a security notice of the model's own) is the judge's.
  There is no promise word list (W4a): promises are the judge's. The client's own first name and vehicles are skipped by the
  secret request check only (the money, digit and host rules read them; the judge never trusts them). Ordinary numbers pass ("2
  to 3 days", "open 8 to 6", "bay 2", "October 12, 2026"). Each problem gets one rewrite call, then the fallback (`guard`). (3) The POLICY
  JUDGE: every reply that passed is read once more, rendered, by one extra model call (`AI_GUARD_MODEL_ID`, default
  `AI_BEDROCK_MODEL_ID`; temperature 0, at most 120 tokens, 8 s) with a fixed, cached rubric; the server's segments (rendered
  placeholders, links as "[link]", the safety line, the shop's phone numbers, address and website; never client-entered text) are
  marked trusted with markers keyed per message (`<message key trusted-parts>`, `⟦K⟧…⟦/K⟧`, then the model's own text alone in
  `<own-text>`; stored unkeyed); it never sees the client's phone, an id, a token or a URL. It answers strict JSON, the reason
  first, `{reason, category: none|price|promise|secret|link_or_phone|other, ok}` on one line, and stops after it (stop sequence;
  W4a, ADR 0160). A fail gets one rewrite with the category's hint, then the guard and the judge again, then the
  fallback (`policy_judge`); a judge error, timeout or an answer that is not the JSON fails closed (fallback, `judge_error`). A
  model or judge call that was throttled (ThrottlingException, 429), timed out or met an outage is retried ONCE after 800-1500 ms
  (jitter) when the turn deadline leaves the wait plus 3 s (a `retry` transcript entry and a log line each; the judge's tool-call
  row and transcript entry carry `attempts: 2`); the Bedrock client makes one attempt (no SDK retry under it). Each
  judgement is an `assistant_tool_calls` row (tool `policy_judge`, redacted) and its cost is in the turn's `cost_micros` (the
  daily budget). `AI_GUARD_JUDGE` (default: on whenever `AI_ENABLED`; false is refused in production while `AI_ENABLED=true`). Markdown stripped, look-alike letters made Latin (NFKC; Greek, Cyrillic and small-capital letters
  that imitate a Latin one: "Ρ1Ν" reads and goes out as "P1N"), GSM-7, at most 320 characters after
  rendering (one shorten call, else cut at a sentence), at most one question (one rewrite, else cut after the first). A refusal,
  a cut answer, an unknown stop, a provider error or a timeout hand off too. A reply with a `verify`, `pin`, `membership` or
  `pay` link gets the server's line "For your security, enter codes and your PIN only on the secure page, never by text." after
  it. Phone numbers (any dash or an underscore as separator too) are masked for the model and in the stored transcript by one
  shared pattern set (`transcript.ts PHONE_PATTERNS`). `pnpm eval:guard` runs the whole guard over
  `test/assistant/fixtures/guard-eval.json` and prints recall per category and the false-block rate (W4: against Bedrock).
- **Reply**: free text through `enqueueFor` with `senderKind: 'ai'`, rendered from the `ai_reply` template (the first AI text of a
  conversation: "Oasis Auto Spa’s automated assistant here." + the STOP footer, never the AGENT offer; `disclosed_at`), class
  `ai_reply`, or `personal_link` with the links as `secretVars` (the thread shows `[private link]`); a registered link the reply
  left out is appended, then the safety line when one is due.
- **Fallback and handoff** (`handoff.ts`): `ai_fallback` ("Thanks — a team member will text you back shortly.", at most one per
  conversation every 2 hours), `AssistantInbox.openHandoff` (no AI until staff answer), notification `assistant.handoff` once per
  open handoff, the thread unread, `alerts.changed`. A shop-wide cap or the budget also notifies the managers once a day
  (`assistant.cap`, `source_ref` `assistant_cap:<kind>:<date>`). Six answered turns in a row (24 h) without a successful tool call
  hand off (`no_progress`); texts older than 15 minutes when the turn starts go to staff without a fallback (`stale`).
- **Opt-out in words**: a turn whose `opt_out` tool call succeeded ends right after that tool round: no further model call, no
  reply, no judge, no fallback and no handoff (turn `skipped`, error `opted_out`, the marker cleared); the tool's `opt_out_confirm`
  is the only text.
- **The assistant's actor** (`assistantActor`): permissions `sched.edit` + `jobs.status`, audit name "Oasis AI (SMS)", user id
  `assistant` (no user: like the website's and the link pages' actors, so `appointments.created_by` stays null on an in-chat booking).

### 23.5 Webhook and listeners

`POST /hooks/smsgate/:deviceKey` exists **only** on the second listener (`HOOKS_HOST:HOOKS_PORT`, default 127.0.0.1:3002, started by
`src/server.ts`; `HOOKS_PORT=0` disables it; an occupied port is logged as an error and the process keeps running). The public
listener has no such route and answers 404. Verification is HMAC-SHA256 over the raw body plus `X-Timestamp` with the device's own
secret (24 h tolerance, `SMSGATE_WEBHOOK_TOLERANCE_SECONDS`): 401 for a missing header, bad or stale signature, 400 for a signed body
that is not an envelope or a payload it cannot read, 404 for an unknown device key, 200 for everything accepted (a repeat, an event
type Oasis ignores), 413 for a body over 16 MB. A signed delivery Oasis cannot use (the 400s and the ignored event types) is kept in
`webhook_log` with status `unparsed` (attachment bytes stripped, then the body cut to its first 4 KB, event name in `headers.x-event`,
purged after 7 days) and logged at warn by event name only. `mms:received` is recorded and applies nothing; `mms:downloaded` is routed
exactly like `sms:received` (ADR 0151; field names in `docs/integrations/smsgate.md` section 1). Every final row (processed, ignored,
failed: unknown device or given up after 24 hours, unparsed) keeps no attachment bytes.
The envelope is persisted in `webhook_log` (unique `(provider, external_id)` = envelope id) before the answer; applying it
(`sms_processed_events`, outbox, message, inbound routing, device health) happens in one transaction afterwards, and a sweep every
30 s applies envelopes that were persisted but never applied (and abandons them after 24 h).

### 23.6 Jobs and dispatch modes

`SMS_DISPATCH_MODE` decides who drains the outbox: `jobs` (default; the pg-boss worker), `inline` (the API process runs the
loop; single-process deployments and the live-stack harness), `off`. Jobs (all in `src/platform/job-registry.ts`): `sms.dispatch`
(every minute, a ~55 s window ticking every `SMS_TICK_INTERVAL_MS`, under the leader advisory lock), `sms.reconcile` (every 2
minutes, plus housekeeping), `sms.device.healthcheck` (every minute), `sms.webhooks.register` (hourly, and once at boot from
`src/server.ts`; also on every `app:started`), `email.send` (every minute), and the assistant's `ai.respond` / `ai.sweep` (23.4b). A session advisory lock per database schema keeps
the worker and the inline runner from overlapping; the atomic claim keeps two dispatchers from sending one message twice anyway.

### 23.7 Environment

New in `src/config/env.ts` (all optional): `SMS_DISPATCH_MODE`, `SMS_TICK_INTERVAL_MS` (2000), `SMS_QUIET_HOURS`, `SMSGATE_WEBHOOK_PUBLIC_URL`,
`SMSGATE_API_PATH`, `SMSGATE_TIMEOUT_MS`, `SMSGATE_WEBHOOK_TOLERANCE_SECONDS`, `SMSGATE_RESEND_ATTEMPTS`, `SMSGATE_SIM_NUMBER`,
`SMSGATE_LEGACY_MESSAGE_FIELD`, `SMSGATE_SYNC_SIGNING_KEY`, `SMSGATE_ALLOW_INSECURE_WEBHOOK_URL`, `SMSGATE_RESERVED_P0`,
`SMSGATE_SAFETY_MARGIN`, `SMSGATE_MIN_INTERVAL_MS`, `SMSGATE_MAX_SEGMENTS`, `SMSGATE_HEARTBEAT_STALE_SECONDS`,
`SMSGATE_ONLINE_WITHIN_SECONDS`, `BUSINESS_PHONE` (HELP reply; the number to call in the assistant's shop facts), `BUSINESS_TEXT_NUMBER` and
`BUSINESS_EMAIL` (the texting line, also one of the shop's own numbers for the gate, and the public email, both in the shop facts), `HOOKS_HOST`, `HOOKS_PORT`, `SES_FROM_NAME`, `SES_REPLY_TO`,
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
exist, else email through the EmailProvider; `delivered` is true only for a real SMS Gate device or SES), the hooks listener, the inline runner,
and `wireAssistant` (`src/modules/assistant/runtime.ts`: the assistant's gate with the texting line among the shop's own numbers, the
`ai.respond` kick, the welcome flow, and W3b's reply-number handler once it is not the contract stub). `src/worker.ts` hands its pg-boss
handle to the assistant (`configureAssistantJobs`) for deferrals and re-kicks.
Receipts go out as an SMS and an itemised email (`receipt` template built from the invoice and its ledger calc).

### 23.9 Tests

`test/assistant/*` (the turn, the shop facts, the guard, the jobs through the real worker, the deterministic conversations with the
SimAiProvider), `test/messaging-db/*` (Postgres, the in-process simulator, the HTTP simulator server and the real `src/server.ts` process; run
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
| `POST /orders/:id/match` | `pay.collect`, **Idempotency-Key** | `{eventId}` confirms a staff-recorded card payment or refund waiting on Squarespace; `{invoiceId}` records the payment as a `squarespace` pay event (`409 SQSP_MATCH_DUPLICATE` when the invoice already shows a waiting or equal card payment, or a refund arrival of the order equals a staff card refund still waiting or pending, unless `force`; `422 SQSP_MATCH_CURRENCY` for a non-USD order). `404 SQSP_ORDER_NOT_FOUND`, `409 SQSP_NOTHING_TO_MATCH`, `409 SQSP_ORDER_NOT_MATCHABLE`, `422 SQSP_MATCH_TARGET_REQUIRED`. |
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
| `POST /memberships` | `cli.member` | a member by hand (no subscription data): active, this cycle's credits granted. `409 MEMBERSHIP_EXISTS`. `409 MEMBERSHIP_CLIENT_UNCONFIRMED` "Confirm who this client is first" on a record the stale-record rule holds (a staff membership is proof of the client, so it would hand the record to whoever holds the number now; W4c re-review 3, D3): staff confirm the client (`POST /customers/:id/identity/confirm`, audited) or create a new client. |
| `PATCH /memberships/:id` | `cli.member` | `{status?, planKey?, planClass?, planLabel?, renewsOn?, autoApply?, note?, expectedVersion?}` (`planClass`: the size the membership is priced at, ADR 0170; a tier change keeps the size and points `tier_price_id` at the new tier's price there); holds against the inference until a newer paid order; `412` on a stale version; audited. An edit leaving the membership active, past due or paused on a stale record: `409 MEMBERSHIP_CLIENT_UNCONFIRMED` (canceling is allowed). |
| `POST /memberships/:id/household` | `cli.member` | `{customerId}`: the client shares the membership (ADR 0170): priced and covered as the member, the credits shared. 409 `MEMBERSHIP_HOUSEHOLD_TAKEN` (they hold a live membership or share another), 422 for the holder, 409 `MEMBERSHIP_CLIENT_UNCONFIRMED` on a stale record; adding one already in it changes nothing. 200 `{membership}`; audited `membership.household.add`. |
| `DELETE /memberships/:id/household/:customerId` | `cli.member` | Ends the sharing (visits already covered stay covered); 404 when not in the household. 200 `{membership}`; audited `membership.household.remove`. |
| `POST /appointments/:id/membership-perks/apply` | `cli.member`, **Idempotency-Key** | settles the visit (section 24.3, ADR 0170): one system `adjust` (reason "Membership credit") and one redeem per covered line, `lines[]`, `discountCents` the total covered, `repriced` (before wave Q2a: one credit equal to the package line). `404 MEMBERSHIP_NOT_FOUND`, `409 MEMBERSHIP_NOT_ACTIVE`, `MEMBERSHIP_NOT_ELIGIBLE`, `MEMBERSHIP_NO_CREDIT`, `MEMBERSHIP_CREDIT_APPLIED`, `MEMBERSHIP_NO_BALANCE`, `MEMBERSHIP_NO_INVOICE`, `MEMBERSHIP_APPOINTMENT_CLOSED`. |

Membership views (ADR 0170, wave Q2a) add `planClass`, `planClassLabel`, `plan.memberDiscountBp` and `household[{customerId, name,
addedAt}]`; `POST /memberships` takes `planClass` (a size of the shop that is on; absent: the tier's cheapest priced size, else the
smallest size; the tier's current price there becomes `tier_price_id`) and refuses a client who shares another membership (409
`MEMBERSHIP_HOUSEHOLD_TAKEN`); so do a personal link's `membership/start` (409 `LINK_ALREADY_MEMBER`) and the verified website join
(409 `PUBLIC_ALREADY_MEMBER`) for a client who shares a live membership. `GET /customers/:id/membership` of a client who shares a membership answers that membership with
`sharedFrom {customerId, name}` (null otherwise). The port's `membership` of a card or file is the holder's or the shared one.

The Operations appointment file's `membership` (and the board's member badge) now come from the real port: `plan` is the label sold,
`creditsLeft` (null = unlimited), `creditAvailable`, and additively `planKey`, `renewsAt`, `renewLabel`, `creditsUsed`, `perks`,
`color`, `bgColor`, `tint`, `memberMonths`, `retention{label, desc, tone}`.

### 23.2a Membership checkouts and order matching (ADR 0160, wave W2e)

Who a Squarespace membership order belongs to (`payments-sync/membership.ts linkCustomer`), in this order:

1. **Checkout intent** (`membership_checkouts`): the row a matched order is bound to; else an `open` intent whose `expected_email`
   and product (`product_key`, the product id or SKU, any letter case; any product of the plan when null) match the order and whose
   window (`started_at` .. `expires_at`, 72 hours) contains the order's time, which the sync then marks `matched`
   (`matched_order_id`, audit `membership.checkout.matched`); else the renewals of a `matched` intent: an order of the same
   Squarespace customer as the bound order (any email: Squarespace renews with the customer's current email) and product, or,
   when the bound order names no Squarespace customer, the same email and product. Two clients' intents for one order link
   nobody (ambiguous). An intent (open or a renewal) never takes an order another client holds: a `sqsp_customer_links` row of
   another client for the order's Squarespace customer (whatever its `source`, one the contacts job made by an unverified email
   included), that Squarespace customer on another client's `memberships` row, another client's email on file (verified **or
   not**: after the identity migration no member's email is verified), another client's phone, or another client's checkout row
   (matched or `awaiting_match`) for the same Squarespace customer or this order. Such an intent is ignored (not consumed, never
   making the order ambiguous): the order links through tiers 2-4 exactly as without it (its owner, `awaiting_match` for staff,
   or nobody: then review flag `ambiguous_customer` naming the order and a `membership_needs_customer` alert that says why). A
   matched intent never binds a Squarespace customer another client holds either: `loadIntentRefs` marks a row an intent matched
   by itself (origin `link`) whose order's Squarespace customer is on another client's link or membership row
   (`orderHeldByAnother`), and that row binds neither its order nor renewals; a row staff matched is never second-guessed. An
   intent only names an email the client typed, so it can never take a member's renewals.
2. The Squarespace customer id (`sqsp_customer_links`; a link the contacts job made **by email** counts only while that client's
   email is verified). A staff link (`PUT /customer-links/:sqspCustomerId`, source `manual`) always wins: no other client's
   record takes that Squarespace customer's orders or holds it, whatever it paid on before (ADR 0160, W4c re-review 4, E1).
3. An email the client **verified** (`customers.email_verified`; trigger `customers_email_unverify` drops the flag whenever the
   email changes, letter case aside, even when the statement also sets it; the only way to store a new verified email is
   `setVerifiedEmail(tx, customerId, email)` in `src/modules/memberships/verified-email.ts`, which names the address in the
   transaction-local setting `oasis.verified_email` for that one statement).
4. The phone.

Tiers 4 and the unverified-email candidate skip a record that already has a **different** Squarespace customer (linked by any
source, on a membership row, or on a paid order linked to it) when the order names its Squarespace customer: such an order is
`second_account`, "needs a customer", and the `membership_needs_customer` alert says "a second Squarespace account is using
<client>'s number … the number may have a new holder"; the contacts job likewise links no such contact by phone or an unverified
email (W4c re-review 4, E2). An order an intent named but another client holds (tier 1's refusal above) raises one
`membership_intent_conflict` alert per order naming both clients, raised once ("paid from <holder>'s Squarespace account for
<client>'s checkout … check who it belongs to"; none when staff linked that Squarespace customer to the holder; E3).

An email nobody verified never links. A **paid** order whose email matches exactly one client only that way waits for staff: the
sync opens a `membership_checkouts` row `awaiting_match` (origin `sync`, the order in `matched_order_id`, no checkout URL) on that
client's live membership, creating a `pending` one (source `squarespace`) when they have none; managers get one notification
(`membership.awaiting_match`, "Confirm Ana’s membership payment") and an open `membership_awaiting_match` alert; nothing activates.
A second paid order of the **same plan** placed while the paid period still runs (more than 3 days before its end) is a duplicate:
review flag `duplicate_payment` on the membership, one `membership_duplicate_payment` alert per order, and the period, renewal date
and paid-order count are the first order's (a newer payment, duplicate or not, still releases a hand-set status). Another plan
mid-period stays a tier change (`tier_changed`). The pass report gains `awaitingMatch`, `intentsMatched` and `duplicates`.

| Verb path | Permission | Notes |
|---|---|---|
| `GET /membership-checkouts?state&limit` | `cli.member` | newest first: `{items[{id, membershipId, customer{id,name}, state, origin link \| sync, planKey, productKey, expectedEmail, startedAt, expiresAt, matchedAt, order{id, number, createdOn, email, totalCents} \| null, version}], awaitingMatch}`. |
| `POST /membership-checkouts/:id/match` | `cli.member` | `{note?}`; staff confirmed the order is the client's: `awaiting_match` → `matched`, the membership pass runs at once (the order links through the row, so the membership activates when paid; the same email's renewals follow), the alert closes, audit `membership.checkout.confirmed`. `{checkout, membership}`. |
| `POST /membership-checkouts/:id/reject` | `cli.member` | `{note?}`; not the client's: `awaiting_match` → `rejected` (the order is never offered for that client again and goes back to `membership_needs_customer`); a pending membership the sync opened only for it is canceled; the alert closes; audit `membership.checkout.rejected`. |

Errors: 404 `MEMBERSHIP_CHECKOUT_NOT_FOUND`, 409 `MEMBERSHIP_CHECKOUT_NOT_WAITING` (the row is not `awaiting_match`). The membership
view (`GET /customers/:id/membership`, `GET /memberships`, the PATCH/POST answers) gains `checkout`: the live row (`open` or
`awaiting_match`: `{id, state, expectedEmail, startedAt, expiresAt, order{id, number, createdOn} | null}`) or null.

For wave W3 (the link API's `POST membership/start`), `openCheckoutIntent(tx, ctx, {customerId, planKey, email, linkId?,
envProductMap?, planLabel?}, audit)` in `src/modules/memberships/checkouts.ts`: 409 `MEMBERSHIP_EXISTS` for an active, past-due or
paused member, 409 `MEMBERSHIP_CHECKOUT_UNAVAILABLE` when the plan has no `checkout_url`; otherwise it reuses the client's pending
membership (switching its plan if another was chosen) or creates one (source `manual`), supersedes its earlier open intent, opens a
new one for 72 hours with the normalised email and the plan's product key, audits `membership.checkout.started`, and returns
`{membershipId, checkoutId, checkoutUrl, expiresAt, membershipCreated}` for the redirect.

Job `membership.checkouts` (every 15 minutes): open intents past `expires_at` become `expired`; a pending membership of source
`manual` (a website join or a personal-link checkout) that staff never made or edited (`manual_status_at` null: a staff-made
membership, or one staff put on pending by hand, is never closed), with no paid order, 7 days after its last checkout attempt
(`started_at` and every checkout row's `started_at` are 7 days old: a client who restarts the checkout gets the full window
again), with no intent still open and no order waiting for staff, is canceled (`cancel_reason` `checkout_abandoned`, `manual_status_at` set so a later paid order still reactivates it), its
open or expired intents `abandoned`, audit `membership.canceled` (actor "Membership checkouts"). It changes nothing when there are
none. Tests: `test/payments-sync/membership-intents.test.ts` (pure), `test/memberships/checkouts.test.ts` (over the simulator: the legacy
member, the member known only by their membership row and the honest new client of F1),
`test/jobs/matrix-sqsp.test.ts`.

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

## 24. Gap closers: deposit policy, arrival ping, membership credits, standing appointments and the waitlist

Decisions: ADR 0080 (one emergency event per transition), 0081 (role limit units), 0082 (cancel and no-show execute the deposit policy),
0083 (arrival ping), 0084 (memberships), 0085 (data-model document), 0086 (standing appointments and waitlist). Tests: `test/scheduling-gaps/*`,
`test/memberships-gaps/*`, `test/standing/*`.

### 24.1 Cancel and no-show settle the money held (ADR 0082)

| Verb path | Permission | Notes |
|---|---|---|
| `GET /settings/cancellation-policy` | any signed-in user | `{policy:{freeCancelHours, lateRetainBp, noShowRetainBp, refundTo: original\|credit}, version}`. Defaults: 24, 10000, 10000, original. |
| `PUT /settings/cancellation-policy` | `set.hours` | the same fields plus `version`; `412` when stale; `422` outside 0..720 hours or 0..10000 bp. Audited. |
| `POST /appointments/:id/cancel` | `sched.cancel`, **Idempotency-Key** | `{reason, notify?, deposit?: policy\|keep\|refund_card\|refund_credit}` (default `policy`). Response adds `settlement {policy, heldCents, refundedCents, retainedCents, refunds[{amountCents, dest, state, awaitingProcessor}], rule}`; `depositPolicy` echoes the choice. `refund_*` needs `pay.refund` (403 `required:["pay.refund"]`) and the caller's own limit (over it the refund is `pending`). |
| `POST /appointments/:id/no-show` | `sched.cancel`, **Idempotency-Key** | optional body `{deposit?}`; settles by `noShowRetainBp`; sends no text. |
| `POST /appointments/:id/reopen` | `sched.cancel` | now revives the invoice; `409 REOPEN_REFUNDED` when a refund was issued ("The deposit was refunded. Book a new appointment instead"). |

Policy refunds are `ledger_events` with `source = system`, reason "Cancellation policy" / "No-show policy", `actor_roles = "Cancellation policy"`,
exempt from the actor's refund limit; a card refund is `processor_state = awaiting_processor`. The invoice ends `canceled_refunded`, `canceled_kept`
or `canceled`. The cancellation text (with `notify`) states what happens to the deposit.

### 24.2 Arrival ping (ADR 0083)

| Verb path | Permission | Notes |
|---|---|---|
| `POST /appointments/:id/arrival-link` | `sched.edit` | `201 {token, path:"/a/<token>", url, expiresAt}`; rotates any earlier link; `409` for a finished job. Only the SHA-256 of the token is stored. |
| `POST /arrivals/ping` | public, authenticated by the token | `{token, lat, lng, accuracyM?, etaMinutes?, declared?, pingId?}` -> `{state: outside\|inconclusive\|checked_in\|confirm_needed\|already_arrived\|disabled, distanceM, radiusM, etaMinutes, message}`. `401 ARRIVAL_LINK_INVALID`, `410 ARRIVAL_LINK_EXPIRED`, `409 ARRIVAL_NOT_CONFIGURED`, `429 ARRIVAL_PING_TOO_FAST` (Retry-After; spacing 5 s per appointment) or `RATE_LIMITED` (60/min per address). |
| `GET /settings/location`, `PUT /settings/location` | signed-in / `set.hours` | `{lat, lng}`, the centre of the geofence. |
| `POST /dev/appointments/:id/simulate-arrival` | `jobs.status`, only with `ALLOW_DEV_ENDPOINTS` | `{mode?: arrive\|eta, etaMinutes?}`: behaves as a ping from the door or from N minutes away. |

SSE on `ops`: `arrival.eta {appointmentId, etaMinutes, distanceM, crossed}` and `arrival.checked_in {appointmentId, auto, distanceM}`; one crew bell
notification (`kind arrival`) when the ETA first reaches the prep time and one at check-in (both only with "Alert the crew"). A browser page on another
origin must be in `ALLOWED_ORIGINS`.

### 24.3 Membership credits (ADR 0084)

| Verb path | Permission | Notes |
|---|---|---|
| `GET /membership-plans` | `cli.view` | plans with their credit rules `{id, label, includeTags, excludeTags, perCycle, autoApply}`. |
| `PATCH /membership-plans/rules/:id` | `cli.member` | `{autoApply}`; audited (`membership.rule.update`). |

**Settling a visit (ADR 0170, wave Q2a: `settleMembershipVisit`, `src/modules/memberships/apply.ts`).** The membership the client
holds or shares as a household member (active; one membership row locked, so a household spends its credits one visit at a time)
covers each line one of its inclusions names: an every-visit inclusion, or a per-cycle one with a credit left (or unlimited); an
inclusion covers every line of the visit it names while it can ("Wax and rain repellent every wash" covers both). The covered amount is min(price at the visit size, price at the plan size), so a larger car's
size difference stays due, with no % off. First the lines are priced again from the regular price each was booked at (a covered line
at the regular price, every other line at the member price: an included line the allowance no longer covers gets the member price, a
newly covered line goes back to the regular price) through the invoice item sync (409 `PRICE_CHANGE_OVERPAID` when that would leave
the invoice overpaid); then ONE system adjust (reason "Membership credit", note "Express Hand Wash · Gold (Compact car plan) · covers
$40 of $60") and ONE redeem (`covered_cents`, `line_cents`, `plan_class`, `visit_class`, `service_id`; key
`redeem:<appointment>:<inclusion>`, then `…:<n>` for the inclusion's n-th line or replacement) per covered line. **The coverage follows
the visit**: when a settled visit changes (the size set at the shop, an add-on added or removed) it is settled again with its own
credits counted as still there: a redeem whose line is gone, no longer covered, or changed price or plan size is given back (a
reversing system adjust, reason "Membership credit", note "Wax · Gold · coverage of $30 given back (the visit changed)", and a
`restore` keyed `restore:<redeem id>` whose `ledger_event_id` is that adjust, in the redeem's own cycle), then each covered line
without a redeem gets one (a replacement keeps the cycle of the redeem it replaces); the invoice's `coverage` lists only the redeems in
force. A settled visit is never left overpaid by its settlement: the end state is projected before anything is written, and a change
that would leave a paid invoice above its new total (a member's paid size difference, then a smaller size; a covered add-on removed
so another paid line becomes covered) is refused whole, 409 `PRICE_CHANGE_OVERPAID` for a size change, `ADDON_REMOVE_OVERPAID` for an
add-on, `MEMBERSHIP_NO_BALANCE` for an apply: staff choose how to give the money back (refund or adjust the invoice first), the
settlement never refunds to store credit on its own. An apply with nothing new to cover answers 409 `MEMBERSHIP_CREDIT_APPLIED`; one that finds a newly covered line (an inclusion
that does not apply itself) covers it. Auto-apply: the inclusions with `autoApply` (the default tiers' inclusions and every new one
by default, plan decision 2; all of them for a member with `autoApply`, `PATCH /memberships/:id`) settle when the visit is **completed** (no payments permission needed; under
a savepoint: anything that stops it is a quiet skip, the completion never fails; a skip keeps the repricing). `GET /appointments/:id` gains `membershipUpgrade {candidate, visits60, copy} | null` (non-members only; real
completed visits in 60 days, 3 or more = candidate). An emergency closure with "Protect member credits" marks held credits (`protect`) and a later cancel or
no-show of such a visit restores every credit it held (one `restore` per redeem, ADR 0170); a reschedule keeps them. `GET /customers/:id/membership` credit rules carry `autoApply`.

### 24.4 Emergency events (ADR 0080)

One ops event per transition: `emergency.started` on close, `emergency.reopened {id, auto}` on reopen. `emergency.ended` no longer exists.

### 24.5 Standing appointments and the waitlist (ADR 0086), behind `features.standing_waitlist` (default off)

| Verb path | Permission | Notes |
|---|---|---|
| `GET /settings/features`, `PUT /settings/features` | signed-in / `set.billing` | `{standingWaitlist, version}`. While off everything below answers `409 FEATURE_DISABLED`. |
| `POST /standing-series` | `sched.edit`, **Idempotency-Key** | `{customerId, vehicleId?, serviceId, cadence: weekly\|biweekly\|triweekly\|monthly, startDate, endDate?, time:"HH:MM", autoConfirm?, notes?}` -> `201 {series, materialized{booked, skipped, through}}`. VIP clients only (`422 STANDING_VIP_ONLY`), cadence must be offered (`422 STANDING_CADENCE_NOT_OFFERED`), VIP toggle on (`409 STANDING_OFF`). |
| `GET /standing-series[?customerId&includeEnded]`, `GET /standing-series/:id` | `sched.view` | the series; the detail adds every decided date (`booked` with the appointment, or `skipped` with the reason). |
| `PATCH /standing-series/:id` | `sched.edit`, **Idempotency-Key** | `{status?: active\|paused\|ended, endDate?, autoConfirm?, notes?, cancelUpcoming?, version?}`. Ended is final. |
| `POST /standing-series/:id/materialize`, `POST /standing-series/materialize` | `sched.edit` | run the materializer now (the daily job does it for all). |
| `POST /waitlist` | `sched.edit` | `{customerId, vehicleId?, serviceId, desiredDate, windowStart:"HH:MM", windowEnd:"HH:MM", notes?}` -> `201` the entry (with `isVip`). |
| `GET /waitlist[?status&date]` | `sched.view` | entries with their `openOffer`. |
| `POST /waitlist/:id/cancel` | `sched.edit` | withdraws the entry and its offer. |
| `POST /waitlist/:id/accept` | `sched.edit`, **Idempotency-Key** | books the offered slot: `201 {entry, booking}`; `409 WAITLIST_NO_OFFER` or `SLOT_UNAVAILABLE`. |

Jobs: `standing.materialize` (daily 04:00), `standing.autoconfirm` (hourly), `waitlist.offer_expiry` (every minute), all no-ops while the switch is off.
## 25. System: background jobs

Background jobs, their schedules, retention and the daylight-saving rules are catalogued in `docs/jobs.md` (generated from
the registry and checked by `test/jobs/registry.test.ts`). ADRs 0090 to 0093.

### 25.1 `GET /api/v1/system/jobs`

Permission `set.billing` (Super Admin holds every key). Read-only; one row per registered job, sorted by name; never a job
payload.

```
{ enabled, generatedAt,
  queue:  { queued, scheduled, active, failed, deadLetter, oldestQueuedAgeSeconds },
  worker: { state: 'ok' | 'stale' | 'unknown', lastRunAt },
  jobs: [{ name, cron, tz, policy, retryLimit, retryDelaySeconds, expireInSeconds, nextRunAt,
           lastStartedAt, lastFinishedAt, lastSuccessAt, lastErrorAt, lastError, lastDurationMs,
           lastOutcome: 'running' | 'completed' | 'failed' | null,
           runs, failures, consecutiveFailures, queued, scheduled, active, failed, deadLetter }] }
```

`queued` is waiting and due, `scheduled` is delayed (a delayed emergency reopen, a retry backing off), `failed` counts the
retained rows whose retries are exhausted, `deadLetter` the rows in the job's `<name>.dead` queue (kept 30 days).
`nextRunAt` is the next cron fire in the business timezone or the earliest delayed run. `lastError` is masked (phone numbers
and emails) and cut at 500 characters. `worker.state` is `stale` when no job finished in the last 10 minutes and `unknown`
when none ever ran. With `JOBS_ENABLED=false` the answer is `{enabled: false, jobs: []}`.

### 25.2 Notifications and events the jobs produce

| Source | What |
|---|---|
| any job, retries exhausted | notification `job.failed` to the managers (once per failure streak) |
| `appointments.reminders`, `appointments.review_request` | SMS through the messaging queue (templates `confirm_request`, `reminder`, `review`), activity-log line "Reminder sent" / "Review request sent" |
| `vip.hold_release_scan` | `ops` event `availability.changed {date}` when a held slot is released |
| `credit.expire` | notification `credit.expired` to the managers and `payments` event `credit.expired {customerId, cents}` |
| `payments.lag-scan` | `payments` event `reconciliation.stale` while card money waits for Squarespace |
| `ledger.integrity_check` | a `ledger_integrity_runs` row per business date; notification `ledger.integrity_failed` to the managers when it finds a new set of problems (ADR 0123) |
| `sms.device.healthcheck`, `sms.dispatch` | notifications `sms.device_offline` / `sms.device_recovered` debounced per 30-minute flap window with the end state announced when it closes, `sms.no_device` once per episode (ADR 0122) |

### 25.3 `GET /api/v1/system/integrations`: the `ai` row (ADR 0160)

Besides `email`, `storage`, `sms` and `squarespace` (ADR 0112) the answer has a fifth row, `key: 'ai'`: `provider` is
`AI_PROVIDER` (`sim` | `bedrock`), `live` is `bedrock`, `missing` is `AI_PROVIDER=bedrock` while simulated (and the AWS
credentials when live and none is available), `warnings` say why the assistant answers nothing (`AI_ENABLED=false`, Settings,
Assistant off), the rollout stage when it is not `everyone`, the simulator answering while enabled, a live
`AI_BEDROCK_MODEL_ID` outside the models the app role is granted (`src/integrations/ai/models.ts`), and a reached daily
budget. `lastSuccessAt` is the last `replied` turn, `lastErrorAt` / `lastError` the last `failed` turn (error masked, 300
characters). `details`:

```
{ model ('sim' or AI_BEDROCK_MODEL_ID), modelLabel ('Claude Sonnet 4.6' ..., null while simulated or for an unlisted model),
  region (null while simulated), enabled (AI_ENABLED and assistant.enabled),
  envEnabled, settingEnabled, stage, actionsEnabled, effortMode (AI_BEDROCK_EFFORT_MODE),
  turnsToday, spendTodayUsd (sum of cost_micros since the location's midnight), dailyBudgetUsd,
  priceSource ('env' | 'model' | 'mixed' | 'highest': where the AI_PRICE_* of cost_micros come from), credentials }
```


## 26. Public website API: `/api/v1/public/*`

The marketing website (oasisautospanj.com, ADR 0145) books real appointments and signs members up through six routes that answer
without a session (ADR 0150). Code: `src/modules/public/**` (routes in `http/`, the pure board projection in `availability.ts`,
the durable limits in `limits.ts`, codes and tokens in `otp.ts`), registered in `src/http/modules.ts` with the same invoice gateway,
membership port and messaging queue the dashboard's modules use, so a web booking is exactly a dashboard booking made by "Website".
Every route is `access.public(reason)` and listed in the authz matrix's `PUBLIC_ROUTES`; both nginx hosts (the website's and the
dashboard's) proxy the whole `/api/v1/public/` prefix under the same rules: cookies stripped both ways, GETs cached 60 s under a fixed
key, POSTs never cached, in the `oasis_public_post` zone with a 16k body limit (`deploy/nginx/oasis-site.conf.template`,
`oasis.conf.template`); the personal-link routes under `/api/v1/public/links/` have their own location and zone (section 28). Problem copy is the design's where it has one (`src/modules/public/problems.ts`); nothing in an answer names a
person, an id or a job, and nothing in an answer to a caller who has not verified the number differs by what the shop knows about that
number (the public-surface review of 2026-10-10, ADR 0150).

**Numbers.** The public routes take US and Canadian numbers that can take a text only: a valid +1 number of the US or Canada (not
another +1 country), type mobile or fixed-line-or-mobile, never a premium-rate (900, 976) or toll-free area code
(`normalizeTextableNanp`, `src/platform/phone.ts`). Anything else is 422 on `body.phone` before any limit or record: "Enter a valid
mobile number." (not a number) or "We can text US and Canadian mobile numbers only.".

**Limits.** Durable fixed-window counters in `public_rate_limits` (shared by every API process), charged in order and stopping at the
first refusal, so a call refused for its address charges nothing to the number it names; each per-number rule has a smaller
per-number-per-address twin over the same window, so no single address can use up a number's allowance:

| Action | per address | per number from one address | per number |
|---|---|---|---|
| `POST otp` | 10 / 10 min | 3 / 10 min | 5 / 10 min |
| `POST otp/verify` | 30 / 10 min | | |
| `POST bookings` | 10 / hour | 3 / hour | 5 / hour |
| `POST memberships` | 10 / hour | 2 / day | 3 / day |

429 `PUBLIC_RATE_LIMITED` "Too many requests from this number or device. Try again in N min." with `Retry-After`. The in-memory
per-route limit (10 a minute per address for the writes, 60 for the reads) is in front of these.

**Verified callers.** A `memberToken` (section 26.2) issued for the customer who owns the number is the only proof the caller can read
that number's texts. Only with it may a booking or a join change that customer's record (name, email, consent, vehicles, a membership)
or use a member's or a VIP's privileges; without it the shop's existing customer is linked by id and left as it is.

### 26.1 Reads (cacheable, `Cache-Control: public, max-age=60`, 60 a minute per address)

| Route | Answer |
|---|---|
| `GET /public/hours` | section 15.7; takes no query (422). |
| `GET /public/availability?days=5&service=<key>&addons=a,b` | The query has exactly one spelling (`src/http/canonical-query.ts` before the strict schema): `days` 1..14 without a leading zero, `service` a catalog key, `addons` up to 12 keys separated by `,` (or `%2C`, as the site encodes it); an unknown or repeated parameter, a percent-encoded name or value, `014` or `1.0` is 422, so nothing can make the 60-second cache miss.  `{tz, generatedAt, serviceKey, durationMin, now {open, baysFree, baysTotal}, days[]}`; each day `{date, label "Today" \| "Tomorrow" \| "Sat", dateLabel "Saturday, Jun 13", weekday, closed, reason, openCount, slots[{startMin, start "8:30 AM", state open \| last \| vip \| booked, bays}]}`. The slot engine's answer (`computeSlots`, channel online, not VIP) on the shop's 30-minute grid from opening to the last start the cutoff allows, reduced to the board's four states: `available` with 2+ free bays is `open`, with one `last`; `vip_held` is `vip` (inside a hold's release window); `blocked` is `booked` (`bays` 0); today's starts before now + the online lead time (30 min) are not listed, nor are cutoff or closed starts. Closed days (a regular day off, a closure, an emergency, "pause online booking") have no slots and carry the `reason` the customer may be told. `now` is the "N of 3 bays open now" pill: active bays minus the jobs occupying one at this instant, `open: false` outside the hours. `days` default 5; `service` defaults to the first package; `addons` is accepted and ignored (add-ons never change the duration). 422 for an unknown service key. |
| `GET /public/catalog` | **Since ADR 0170 built from the prices by size** (the shape stays until the website switches to v2 in wave Q3c): `memberPriceCents`/`guestPriceCents` are the regular starting price (the lowest over the active sizes, else the base price) and the member one at the lowest % off of the public tiers that have a price; `priceCents` the starting price; an item with no price by size and a $0 base price (a new row nobody priced) is left out; `guestMarkupPct` is always 0; `tint` is the tint packages' prices in the matrix shape (`vehicleTypes` the active sizes, `films` the `catalog.tint_films` setting, one row per film and priced size); `plans` the active public tiers by key (`planKey` the same key, `priceCents` the tier's starting monthly price, null without one). What follows is the pre-size wording. Takes no query (422). The one catalog the website and the assistant read, from Settings (section 15.8, ADR 0160): `{generatedAt, currency "USD", guestMarkupPct, guestBookingFeeCents, categories[{key, label, colour, sort}] (active), services[{key, name, shortName, category, description, durationMin, priceCents, memberPriceCents, guestPriceCents, vipInclusion, vipNote, tags, tintFilm}], addons[{key, name, category, description, priceCents, memberPriceCents, guestPriceCents, vipInclusion, vipNote, tags}], quotes[{key, name, kind, category, description}], tint {vehicleTypes, films, prices}, plans[{key gold \| vip, name, planKey, planName, perks, priceCents}]}` in cents. Listed: active, `visibleOnline`, category active; quote-only items go to `quotes` (no price). `name` is the public name (else the name); `memberPriceCents`/`guestPriceCents` (section 15.8 rule) and a tint row's `memberMinCents`/`guestMinCents` are the **starting prices** (design §3b) the website and the assistant state; `priceCents` is what a booking charges (kept for the booking flow: the guest price for an item priced on the website), never a price to state; a plan's `name` is its public label and `priceCents` its monthly price (null until set). **Keys** are the slug of the service name over every active package (or add-on), as availability and bookings key them (`signature-hand-wash`, `tire-shine-and-dressing`); a second live service with the same slug carries six characters of its id. The two plans are the website's tiers over the dashboard's plans (`gold` = `premium`, `vip` = `executive`, `src/modules/public/tiers.ts`). No ids, versions, checklists, SKUs, desk flags or checkout URLs (tests walk every key). |
| `GET /public/catalog/v2` | **The catalog by vehicle size (ADR 0170, wave Q3d; design q-design-pricing §9)**; the website switches to it in wave Q3c, the assistant's facts-v4 read it now; v1 above is unchanged. Takes no query (422); same cache header, limits and nginx treatment as v1 (its own exact location on both hosts). `{version 2, generatedAt, currency "USD", guestBookingFeeCents, guestFeeCollect counter \| link (as a booking answer says it: card_hold is the counter until wave Q3a), vehicleClasses[{key, label, sort}] (the active sizes, smallest first), categories[{key, label, colour, sort}], memberDisplay {discountBp} (the lowest member % off of the tiers listed below; 0 without any), services[{key, name, shortName, category, description, durationMin, prices[{class, cents, maxCents, memberCents, memberMaxCents}], fromCents, fromClass, memberFromCents, tintFilm {key, label, vlt} \| null, includedIn[{tier, mode, perCycle}]}], addons[{key, name, category, description, prices, fromCents, fromClass, memberFromCents, includedIn}], quotes[{key, name, kind, category, description}], tiers[{key, name, colour, sort, perks, memberDiscountBp, vipBooking, householdCars, prices[{class, monthlyCents}], fromMonthlyCents, fromClass, inclusions[{serviceKey, mode, perCycle, group}]}]}` in cents. **`prices` lists only the sizes that HAVE a price** (active sizes, size order; a size left out is "priced at the shop"); `maxCents` is the top of a range (tint), else null; `memberCents`/`memberMaxCents` = the price less `memberDisplay.discountBp`, rounded half up to whole dollars (never above the price). `fromCents` is the lowest price over the sizes at `fromClass` (an item without prices by size: its base price, `fromClass` null); an item without any price (no cell and a $0 base) is left out, as in v1. `includedIn` names the listed tiers whose active inclusions cover the item. **`tiers` are the active public tiers WITH a current price at an active size** (plan decision 3: a tier without one is not listed; v1 `plans` still lists it with `priceCents` null); `householdCars` is the tier's car cap (null: none); `inclusions` one row per covered listed item (`perCycle` null = unlimited, or every_visit); `group` numbers the tier's inclusions (1, 2, ... in order, only those covering a listed item): rows with the same `group` share ONE allowance (one inclusion of 4 a month over two items is 4 in all, two inclusions of 4 a month are 4 each). Listed items, keys and quote rules as v1. **Nothing internal**: no ids, versions, price versions, Square ids or states, checkout URLs, tags, desk or online flags (tests walk every key). |

### 26.2 Member identification: `POST /public/otp`, `POST /public/otp/verify`

| Route | Behaviour |
|---|---|
| `POST /public/otp {phone}` | 202 `{challengeId, expiresInSec: 600}` whether or not the number is known or the text could go out (nothing about the number leaks). The six-digit code goes through the messaging queue as class `otp_code` (transactional, consent-exempt, sent even to a number that texted STOP, never held by quiet hours, no STOP footer; the body is redacted in the Messages tab like a password reset); outside production it is suppressed for a number off `SMS_ALLOWLIST` as every text is. The class is lane 1, beside the confirmations and payment links. Stored: `sha256(challengeId:code)`, 10-minute expiry, 3 tries, one active code per number (a new request supersedes the earlier one). 422 for a number the website does not text (above). Limits above. **Hourly ceiling:** at most `PUBLIC_OTP_TEXTS_PER_HOUR` (default 12) codes handed to the queue in any rolling hour, for every caller together (a code the policy suppresses does not count), decided under one advisory lock; past it every code request answers 429 `PUBLIC_CODES_PAUSED` "We can’t text a code right now. Try again in N min, or text us." with `Retry-After` (when the oldest counted code leaves the hour), nothing is stored or texted, and the managers get one `public.otp_cap_reached` notification an hour. The tablet sends about 60 texts an hour for the whole shop; the ceiling keeps most of them for the shop's own texts. |
| `POST /public/otp/verify {challengeId, code}` | 200 `{memberToken, expiresInSec: 1800, member {firstName, tier gold \| vip \| null, washesLeft, plan, active, tierName, planClass, memberDiscountBp}}` (ADR 0170: the tier's name, the size the membership is priced at, the member % off; a household member is shown the shared membership). The token is opaque (43 characters), stored as its sha256, bound to the number and to the customer owning it at that moment (null when nobody did), 30 minutes. `member`: the first name (empty when the number belongs to nobody or to a placeholder; all of `member` is empty, as for nobody, when the stale-record rule holds the number's record: a code proves the number, not the client, ADR 0160 W4c re-review), the website tier of the plan (null for a plan the site does not sell), the washes left this cycle (null = unlimited or not a member), the plan label as sold, `active` (an active membership: no booking fee). 401 `PUBLIC_OTP_INVALID` "That code didn’t match. 2 more tries before you need a new one." (`meta.attemptsLeft`); the third wrong code locks it: 429 `PUBLIC_OTP_LOCKED` "Too many tries. Request a new code." (also for the right code afterwards); 410 `PUBLIC_OTP_EXPIRED` "That code expired. Request a new one." for an expired, used, superseded or unknown code, and for a link page's step-up code (ADR 0160: purposes `link_verify`, `pin_set`, `pin_reset` are redeemed only on their own page; no try is counted). 30 calls per address every 10 minutes. |

### 26.3 `POST /public/bookings` (Idempotency-Key required)

Body `{name, phone, email?, vehicle? {year?, make?, model?, label?, plate?}, vehicleClass?, serviceKey, addonKeys[], date "YYYY-MM-DD", startMin,
smsConsent, memberToken?, website: ""}` (strict; `date` a real calendar day, 422 otherwise, never a 500). `vehicle.label` is free text ("2021 Tesla Model 3": year, make, model are parsed when
make and model are absent). **Sizes (ADR 0170, wave Q2a):** `vehicleClass` (the size chip; 422 `body.vehicleClass` unless a size of
the shop that is on) prices the visit (section 20.2a). A `vehicle.label` that names a size — one of the shop's labels or keys, or the
old site's "Sedan / Coupe", "SUV / Crossover", "Truck / Van" (Compact car, Compact SUV, Truck) — is the size, never a car: no vehicle
"Sedan" is made. The size is recorded on the car (source client) only for a new client or the verified owner of the record; a guest's
size prices the visit and never reaches someone else's record. Member prices only with a `memberToken` issued for the customer on
file (an unverified member's number is priced as a guest's). The answer adds `pricing {vehicleClass, vehicleClassLabel,
confirmAtShop, listCents, discountCents, coveredCents, dueCents}`; with `confirmAtShop` the confirmation text adds "We’ll confirm
the exact price at the shop.". A non-empty `website` (the honeypot) answers **202** with a plausible, fake `bookingRef` and writes nothing
(its `pricing` is a guest's price at the size, from the price book, as a real booking's).

| Step | Rule |
|---|---|
| Limits | Section 26 above (10 an hour per address, 3 per number from one address, 5 per number), charged before the booking runs and outside its transaction (a booking refused for its slot still counts). |
| Customer | A **new** number creates the customer (`upsertCustomerByPhone`, source `online`, `synthetic = false`, name, email, vehicle); `smsConsent` records the SMS opt-in with source `online`, which the policy reads as consent kind `web_booking`: the texts about the booking (confirmation, reminders, receipts), never marketing. The number of a customer the shop **already has**, without a `memberToken` issued for that customer: the booking is linked to them by id and their record is left exactly as it is (no name, placeholder or not, no email, no consent, no vehicle; the appointment has no vehicle); what was typed goes on the appointment's internal log ("Booked on the website with the number of this customer, not verified by a code ... Typed: name ..., email ..., vehicle ..., texts yes"). With that token the person may correct their own email, and consent and the vehicle are recorded; the name on file is only filled when it is a placeholder (needs_details, "Walk-in guest", the assistant's "New texter ••1234"): a different typed name never replaces it (a shorter "Maria" must not overwrite "Maria Lopez", W2 review leftover) and goes on the appointment's internal log instead ("Booked on the website as \"Maria\"; the name on file (\"Maria Lopez\") was kept. ..."). A token for another number is 422 `PUBLIC_TOKEN_PHONE_MISMATCH`; an unknown or expired token 401 `PUBLIC_TOKEN_INVALID`. A token for a number whose client has a PIN (stale record or not) is 409 `IDENTITY_PIN_REQUIRED`: a PIN outranks a texted code, as on the link pages (ADR 0160 W4c re-review); nothing is booked or moved. |
| Booking | The start must be on the board's grid (opening time plus whole slots of an open day): 422 `body.startMin` "Pick one of the times on the board." otherwise. `createAppointment()` with `source: 'online'`, `channel: 'online'` (lead time, booking window, paused days; no overrides: there is nobody to grant one), `vip` as proven (below), the package and add-ons by catalog key (422 otherwise), the slot guard under the per-date advisory lock, the invoice through the payments gateway, the checklist snapshot, the audit row (actor "Website"), the `ops` events (`appointment.updated {change: created}`, `availability.changed`, `kpi.dirty`): the dashboard's board updates live. |
| Privileges | Only with a `memberToken` issued for the customer on file. Then an **active** membership waives the fee (`member: true`), and a VIP client (the staff's list) or an active member of a tier with `vipBooking` (ADR 0170; the `vip` tier by default) gets the VIP slot rules (VIP-held times, the VIP online window of `vip.windowVipDays`). Without the token the booking is evaluated as a guest's and a non-VIP's, whatever the number's record says: the fee is due and `PUBLIC_SLOT_VIP` / `PUBLIC_SLOT_TOO_FAR` (with the standard window's days) answer as for anyone. |
| Fee | Settings key `booking.guest_fee {cents: 2500, collect: counter \| link}`. A verified active member owes nothing (`member: true`); anyone else owes `cents`, collected at the counter or through a Squarespace payment link staff text afterwards (the dashboard's payment-link flow, kind deposit). Nothing is charged online: there is no card capture anywhere. The answer says `deposit {dueCents, how}` and the activity log records "Booked on the website · $25 booking fee due at the counter". |
| Confirmation | Template `booking_confirmed_web` queued in the booking's transaction (class transactional): "Booked: Express Hand Wash, today at 1:00 PM. $25 booking fee due at the shop. Reply here to change it." for a guest; "... Members never pay a booking fee. Reply here to change it." for a member (the design's SMS demo, with "Reply C to change" rewritten because a C reply means confirm). Without consent, or off the allowlist outside production, the policy skips it. `confirmationBy` is the policy's outcome (`sms` when queued) for a caller with a member token; for anyone else it is what they asked for (`sms` when `smsConsent`), so an opt-out or a missing opt-in on a known number never shows. An unverified booking for an existing customer is texted to that customer's number only under the consent they gave the shop before (their record is not changed). The usual reminders follow from `appointments.reminders`. |
| Answer | 201 `{bookingRef "OAS-00042" (the appointment's seq), status: "booked", start, end, bayCount (bays still free for that time), deposit {dueCents, how}, confirmationBy sms \| none, service {key, name}, addons[], when "Today · 1:00 PM", member}`; without a member token, the same for a member's, a VIP's, an opted-out or an unknown number. Same key, same body: the stored answer with `Idempotent-Replayed: true`; same key, other body: 422 `IDEMPOTENCY_MISMATCH`; no key: 400. |
| Slot refusals | 409 in the design's words, never the dashboard's override hints: `PUBLIC_SLOT_TAKEN` "That time was just taken. Pick another." (no bay free, also the loser of two simultaneous bookings for the last bay), `PUBLIC_SLOT_VIP` "4:00 PM is held for VIP members. Join to book it with no fee.", `PUBLIC_SLOT_PAST` "That time has passed. Pick another." (also inside the lead time), `PUBLIC_SLOT_CLOSED` "We’re closed at that time. Pick another.", `PUBLIC_SLOT_TOO_FAR` "Online booking opens 14 days ahead. Pick a sooner time.". |

### 26.4 `POST /public/memberships` (Idempotency-Key required)

Body `{tier, planClass?, name, phone, email, vehicles[{car, plate?}] (1..5), smsConsent, agree: true, memberToken?, website: ""}` (strict; `tier` the key
of an active public tier, `gold` or `vip` by default, ADR 0170: 422 `body.tier` otherwise; `planClass` the size the membership is
priced at, a size the tier has a current price for: 422 `TIER_CLASS_UNPRICED` otherwise; absent (older pages): the tier's cheapest
priced size, else the smallest size; the answer adds `planClass`, `planClassLabel`, `monthlyCents` (null without a price);
no card fields exist). Limits: section 26 (10 an hour per address, 2 a day per number from one address, 3 a day per number).

* **A new number** (or the number of an existing customer with a `memberToken` issued for that customer): creates or links the
  customer by phone (source `online`, consent kind `web_booking` as above; with the token the person may correct their own name and
  email) and the vehicles (`car` parsed like `vehicle.label`), then a `memberships` row in the **pending** state (source `manual`,
  `plan_label` "Gold" / "VIP", `manual_status_at` null so the Squarespace inference may take it over, `sqsp_product_key` the mapped
  product's id or SKU when the product map has a membership product for the plan). Staff get a notification (`membership.web_join`)
  asking them to text the Squarespace checkout link, naming the product; when the map has none the notification says so and an open
  `product_map_empty` alert is raised, and nothing fails. The person gets `membership_welcome_web` ("Hi Jo, thanks for joining Oasis
  Auto Spa Gold. We’ll text your secure checkout link shortly; your membership starts once it’s paid."). The membership activates when
  the existing sync sees the paid subscription order. With a token, 409 `PUBLIC_ALREADY_MEMBER` "This number already has a
  membership. Text us to change your plan." for a live membership (held, or shared as a household member: ADR 0170), and 409 `IDENTITY_PIN_REQUIRED` when the number's client has a PIN
  (a PIN outranks a texted code; ADR 0160 W4c re-review).
* **The number of an existing customer without that token:** nothing is written to the customer's record (no name, email, consent,
  vehicle or membership) and nothing is texted; the managers get `membership.web_join` "Website join to confirm: <customer> (Gold)"
  with the reference, what was typed and either "Call or text them to confirm; if they did join, add the Gold membership on their
  record and text them the Squarespace checkout link" or "They already have a Gold membership (active): check with them before
  changing anything", or, on a record the stale-record rule holds (W4c re-review 3, D3), "Careful: this number's record has been
  quiet for N days — the texter may be a new holder of the number: confirm who they are before adding a membership; if they are
  new, create a new client" (staff memberships on such a record answer 409 `MEMBERSHIP_CLIENT_UNCONFIRMED` until staff confirm
  the client); an audit row `membership.web_join_unverified` (`after.staleRecord`). The answer is the same 201 as any join's, so a join can not tell
  whether a number is known or a member.

201 `{memberRef "OAS-M-1A2B3C4D", status: "pending_payment", next: "checkout_link_by_sms", tier, plan, confirmationBy}`
(`confirmationBy` as for a booking: the policy's outcome with a token, what was asked for otherwise); the honeypot answers 202 with a
fake reference, after the same tier and size checks, with the size, label and monthly price a real join would answer.

### 26.5 Origin, environment, retention, tests

The public POSTs carry the website's `Origin`: it must be allowed, so the API lists `PUBLIC_SITE_URL` (`https://oasisautospanj.com`)
beside the dashboard's origins (a request without `Origin` and without a cookie is still allowed, as before). The four POSTs
answer the same 404 as an unknown route (before validation) while `PUBLIC_WRITES_ENABLED` is false, the default: they open
together with the website's `SITE_BOOKING=live` once the SMS tablet sends texts; the reads are always open. The two record-creating
POSTs do their pool work (the location, the limits) before the idempotency transaction opens and only use the transaction inside it
(`idempotentHandler`'s `prepare` step), so a burst never holds one connection while waiting for another; a full pool fails a checkout
with 503 after `DB_CONNECT_TIMEOUT_MS` (10 s) instead of queueing without limit. `maintenance.purge`
drops codes and tokens a day past their expiry and limit windows two days old. Tests: `test/public/availability.test.ts` (pure),
`test/public/limits.test.ts` (the limit order and pairs), `test/public-http/*.test.ts` (the real app over the design seed: contract,
reads and their strict queries, codes and the hourly ceiling, bookings including the last-bay race, the ops snapshot, unverified
callers and verified privileges, joins, and `pool.test.ts`: bookings and joins at once on a 2-connection pool), the authz matrix, `test/ops-kit/deploy-site.test.ts` (the nginx host, in a real nginx when installed).
Deviations from the first contract are noted in ADR 0150 (source `online` rather than `web`; `bayCount` is the bays left; the grid
ends at the cutoff; plans carry no price; the OTP text is suppressed off the allowlist outside production like every text).

## 27. Phone identity core (ADR 0160, wave W2b)

The services behind personal links, PINs and the 30-day phone trust (`src/modules/identity/**`; design
`docs/design/ai-assistant-and-phone-identity.md` sections 1 and 5). The link pages reach them through the link API
(`/api/v1/public/links/*`, section 28, behind `PUBLIC_LINKS_ENABLED`); nothing here runs on its own.

### 27.1 Staff routes (`/api/v1`)

| Route | Access | What it does |
|---|---|---|
| `GET /customers/:id/identity` | `cli.view` | The client file's "Website PIN: Set · trusted to Nov 9": PIN status (`none`, `set`, `locked`, `disabled`, `cleared`), set time, lock end, the 72-hour reset hold; the number's trust (`until`, `verifiedBy`, why it ended: `none`, `expired`, `revoked`, `epoch`, `owner_changed`, `opted_out`, `stale`); live links by kind and live link sessions; a pending in-chat action; the stale-record verdict; `numberReassigned {at, toCustomerId}` when someone who verified only this number booked while the record was stale and the number moved to a new client (merge the two if it is the same person). The number is masked (`+1******0142`); no token, hash or code. 404 for an unknown, merged or deleted client. |
| `POST /customers/:id/identity/pin/clear` | `cli.edit` | Removes the PIN (its version moves on, so every earlier link is dead) and ends the client's links, link sessions, the trust and a pending in-chat action (reason `pin_cleared`). Idempotent; audited `identity.pin.cleared` once. Returns the state. |
| `POST /customers/:id/identity/trust/revoke` | `cli.edit` | Ends the number's trust (reason `staff`), the client's live link sessions and a pending in-chat action; links stay usable to verify again. Audited `identity.trust.revoked`. Returns the state. |
| `POST /customers/:id/identity/confirm` | `cli.edit` | Staff confirmed with the client that the number on file is still theirs (W4c fixes): a staff action is proof of the client, so `customers.identity_confirmed_at` is stamped and the stale-record rule no longer holds the record (a texted code never does this). 422 `IDENTITY_NO_PHONE` without a number. Audited `identity.client.confirmed`. Returns the state. |
| `POST /identity/links/kill` | `set.billing` + `team.roles` (owner level: a Super Admin) | The links kill switch (W4c fixes): `{reason}` (3..300 characters, strict). Bumps `links.epoch`, so every personal link, link page and 30-day phone trust issued before ends at its next use (a reply number in chat stops running too); clients verify again on a new link. 200 `{epochBefore, epoch}`. Audited `identity.links.killed` (with the reason) beside the `settings.update` of `links.epoch`. The break-glass CLI `deploy/scripts/links-kill.sh "<reason>"` does the same (docs/runbook.md "Personal links"). |

### 27.2 The services W3 builds on

| Service | Rule |
|---|---|
| `issueClientLink(tx, {newId, now, siteUrl?}, {locationId, kind, customerId, phone?, appointmentId?, invoiceId?, planKey?, issuedBy, expiresAt?})` | 32 random bytes (base64url, 43 characters), only the SHA-256 stored; URL `https://oasisautospanj.com/#/c\|m\|p\|pin\|v/<token>` (book-again uses `c`). The number is the client's on file (a stranger's only for calendar / book-again). Bound to the client's PIN version, phone version and `links.epoch`. Lifetime / uses / exchanges: verify and pin 15 min, 1, 5; calendar 72 h, 3, 30; book_again 14 d, 1, 30; membership 24 h, 3, 20; pay 7 d (or the earlier `expiresAt`), 3, 30. A pay link needs an open invoice of the client (422 for a void or already paid one). Supersedes the live link of the same kind to the number (same invoice for pay). `issuedBy: 'assistant'`: one per kind an hour, three a day per number (429 `IDENTITY_LINK_LIMIT`). The caller texts `url` as a `secretVar` of class `personal_link`. |
| `resolveLink` / `consumeLink` / `revokeLink` / `revokeLinks` | A link is dead when revoked, superseded, expired, used up, issued in another epoch, its client merged / deleted / on another number or phone version / at another PIN version, or the number opted out (STOP, staff, the client's own mark) after it was issued, START notwithstanding; a pay link also once its invoice is voided (revoked) or paid (used: nothing left on the balance, money awaiting the processor included), and its sessions with it. Opening uses nothing; `consumeLink` counts a completion (409 `IDENTITY_LINK_USED` when spent or paid). |
| `exchangeLink(db, {token, ip, now})` → `{session, view, numberTrust}` | A new bearer session (only its SHA-256 stored): 15 min idle, 1 h at most; re-exchange while the link can be opened. Starts `verified` when the number's trust is live for the link's client (no step-up), else `link`. 401 `IDENTITY_LINK_INVALID` with `meta.reason` `not_found\|expired\|used\|revoked`. |
| `resolveSession(db, token, now)` | 401 `IDENTITY_SESSION_INVALID` when unknown, revoked, idle, past its hour, after 5 wrong entries, or its link was revoked / its PIN, phone or epoch binding changed. `requireFreshStepUp` (403 `IDENTITY_STEP_UP_REQUIRED`): memberships and payments need a PIN or code within 5 minutes. |
| `requestStepUpCode(d, {session, purpose, ip})` / `confirmStepUpCode(d, {session, challengeId, code, ip})` | The code (the website's: six digits, 10 minutes, 3 tries, one active per number) goes to the link's number only (no phone input); limits 10 / 10 min per address (an IPv6 address by its /64), 3 per page, 5 per number; the shared `PUBLIC_OTP_TEXTS_PER_HOUR` ceiling (429 `PUBLIC_CODES_PAUSED`). Purposes: `link_verify` (refused once a PIN exists, 409 `IDENTITY_PIN_REQUIRED`), `pin_set`, `pin_reset` (only with a PIN; verifies nothing by itself); `pin_set` and `pin_reset` on a record the stale-record rule holds: 409 `IDENTITY_RECORD_UNCONFIRMED` (a code proves the number, not the client). A confirmed verify / set code verifies the page by code and trusts the number 30 days; it never ends the stale-record rule. |
| `verifySessionPin(d, {session, pin, ip})` | scrypt over HMAC(`PIN_PEPPER`, `customerId:pin`); the same work and the same answer (401 `IDENTITY_PIN_INVALID`, `meta.attemptsLeft` of the page) when no PIN exists. 5 wrong per page (429 `IDENTITY_SESSION_LOCKED`), 20 wrong an hour per address (an IPv6 address by its /64, which is what `identity_pin_failures.ip` stores; 429 `IDENTITY_TOO_MANY_TRIES`), 10 wrong in 24 hours per client and the schedule 5 → 15 min, +3 → 1 h (429 `IDENTITY_PIN_LOCKED`, Retry-After), +3 → disabled (423 `IDENTITY_PIN_DISABLED`, managers notified `identity.pin_disabled`). A right PIN verifies the page by PIN (step-up now), trusts the number 30 days and is proof of the client (`customers.identity_confirmed_at`: it ends the stale-record rule). |
| `setSessionPin` / `resetSessionPin` | 4-6 digits, blocklist (top-100 common, one digit repeated, runs, years 1940-2015, the end of the client's number: 422 `IDENTITY_PIN_REJECTED`). Set: after a code confirmed on the same page within 10 minutes (403 `IDENTITY_CODE_REQUIRED`), only without a PIN (409 `IDENTITY_PIN_EXISTS`); every other link and page of the client ends (`pin_set`), the page's own link is re-bound. Reset: after a `pin_reset` code of the page; every other link, page, the trust and a pending action end (`pin_reset`), the page is verified by code and the number trusted again, member privileges wait 72 hours (`memberPrivilegesHeldUntil`), the client gets the `pin_reset_notice` email (when an address is on file) and the managers `identity.pin_reset`. |
| `grantTrust` / `evaluateTrust` / `revokeTrust` | One row per (location, number): 30 days from a verification, in the current epoch. Evaluated on every read: revoked, expired, another epoch, the number now owned by another client (or nobody), an opt-out since the verification, the stale-record rule. |
| `createPendingAction` / `confirmPendingAction` / `completePendingAction` / `failPendingAction` / `findPendingAction` / `staffHoldsChat` | Only inside the number's trust (403 `IDENTITY_NOT_TRUSTED`), and never while staff hold the chat: an open handoff of the number's conversation or a staff pause of the client's thread (`message_threads.ai_paused_until` ahead), 409 `IDENTITY_STAFF_HOLDS_CHAT` (the propose tools answer `unavailable`; the reply-number handler cancels an action it finds under such a hold, unanswered; W4c re-review). A 4-digit reply number returned once (text it as a `secretVar` of `action_confirm`), stored as sha256(id:code); one pending per number (a new proposal supersedes); 15 minutes; 3 wrong replies lock it. The right reply re-checks the trust, claims the action and returns its payload for the caller to execute in the same transaction. |
| `staleRecord` | No proof of the client for 180 days, or the number's newest final text failed as an invalid number after the record's newest proof (its creation included): treat the client as unknown. Proof (W4c fixes): the record's creation; their PIN (`customers.identity_confirmed_at`, or a trust granted by PIN); staff confirming the number (`POST /customers/:id/identity/confirm`); an appointment staff created (`dashboard`, `walk_in`, `phone`, `standing`) or one a link page or the assistant created for a session verified with this client's PIN (`appointments.booked_with_pin`), its time once passed; a visit staff served (the wash started or finished; an arrival alone can come from the client's phone), unless the website booked it (counted from the wash: the crew served the client in person); a membership payment matched to the client (`memberships.last_paid_at`, whatever the status now) or staff setting a membership (`manual_status_at` of an active, past_due or paused row; a checkout the system canceled is none), each from its own time, never "live now" (W4c re-review). Never a texted code, a link or website booking by itself, or a text from the number (a recycled number's new holder sends those too). |
| `bindPartyToNumber` / `reassignNumber` (`identity/rebind.ts`) | The client a party who verified only the number books as (a link page, a website member token): nobody holds the number → a new client; the holder's record is not stale, or the party entered the holder's PIN → the holder; the holder's record is stale → a NEW client, and the number moves to it: the old record keeps its history, loses the phone (a phone change: its links, link sessions, trust and pending action end; the page doing it keeps a stranger's link), gets `phone_reassigned_at` / `phone_reassigned_to`, and the managers get `identity.number_reassigned` "Number reassigned: <name>"; the number's assistant conversation and lead follow the number; audited `customer.phone_reassigned`. |
| `revokeIdentity`, `revokeForPhoneChange` (called by `updateCustomer`), `revokeForMerge`, `revokeForOptOut` | End links, link sessions, trust and a pending action with the reason. A phone change also bumps `customers.phone_version`. STOP and the epoch are enforced on read as well. |

Retention: `maintenance.retention` task `identity` (see `docs/jobs.md`). Tests: `test/identity/*.test.ts`, the authz matrix.

## 28. Personal-link API: `/api/v1/public/links/*` (ADR 0160, wave W3c)

The website's personal link pages (`https://oasisautospanj.com/#/c|m|p|pin|v/<token>`, design section 5 and 7) talk to these twelve
routes. Code: `src/modules/public/links/**` (routes and schemas in `http/`, the services in `service.ts`, the per-client board in
`board.ts`), registered in `src/http/modules.ts` with the website's wiring (the same invoice gateway, membership port and messaging
queue), on the identity core of section 27. Every route is `access.public(reason)` with the tag `public-links`, listed in the authz
matrix's `PUBLIC_ROUTES`; tests in `test/public-links/*.test.ts`.

### 28.1 Rules every route follows

| Rule | What it means for the page |
|---|---|
| **Closed by default** | While `PUBLIC_LINKS_ENABLED` is false (the default everywhere) every route answers exactly what an unknown route answers: 404 `ROUTE_NOT_FOUND`, before validation, any limit, session lookup or record, with the same headers (no `X-API-Version`, no `Cache-Control` header below), so a prober cannot tell which paths exist. (An `Origin` outside the allowlist is refused 403 by the platform first, as on every public POST.) With it true the API needs `PIN_PEPPER` (the Secrets Manager secret in production). |
| **The token** | Only the exchange takes the link's token, in its JSON body. The page reads it from the URL fragment (never sent to a server, never in a Referer) and scrubs it from the address bar before anything else runs. It is never logged (the request log has the path only; `test/public-links/exchange.test.ts` scans the logs, the message, outbox, audit, idempotency and session rows for it). Only its SHA-256 is stored. |
| **The session** | The exchange returns `session`, a 43-character bearer token: keep it in memory only (no cookie, no storage) and send `Authorization: Bearer <session>` on every other call. 15 minutes idle (every call slides it), 1 hour at most; re-open the link for a new one while the link lives. Any other header, scheme or shape is 401 `IDENTITY_SESSION_INVALID`. |
| **No cache** | Every answer carries `Cache-Control: no-store` (nginx also replaces whatever the API sends with `no-store`, its own errors included, and caches nothing under the prefix). |
| **JSON only** | A POST needs `Content-Type: application/json` (415 `UNSUPPORTED_MEDIA_TYPE` otherwise) and a JSON body (`{}` when there is nothing to send). Answers are `application/json` (problems `application/problem+json`) with `X-Content-Type-Options: nosniff` and the API's `Content-Security-Policy: default-src 'none'`; `<`, `>` and `&` inside strings are sent as `<`, `>`, `&` (still the same JSON once parsed), so no answer can be read as markup. |
| **Origin** | When an `Origin` header is present it must be an allowed origin (`PUBLIC_SITE_URL`, the dashboard's, `ALLOWED_ORIGINS`), on GETs as well as POSTs: 403 `ORIGIN_NOT_ALLOWED` otherwise. No `Origin` (a server-side caller) is allowed. No cookie is read or set. |
| **Limits** | An IPv6 client counts as one address per /64 (in memory and durable; `platform/ip.ts` `ipLimitKey`). In memory per address per minute: exchange 20, me / availability 60, code confirm and PIN 20, code request, PIN set/reset, bookings, reschedule, membership and pay 10 (429 `RATE_LIMITED`). Durable (`public_rate_limits`, shared by every API process; 429 `PUBLIC_RATE_LIMITED` "Too many requests from this number or device. Try again in N min." with `Retry-After`): exchange 30 / 10 min per address; code requests 10 per address, 3 per page and 5 per number every 10 minutes; code confirms 30 / 10 min per address; PIN entries 30 / 10 min per address and choosing a PIN 10 per page (plus the PIN rules of section 27.2); bookings 10 an hour per address, 5 per link, 5 per number; reschedules 10 an hour per address, 5 per number; membership starts 10 an hour per address, 5 a day per number; pay starts 20 an hour per address, 10 per number; saving a card 10 an hour per address, 5 a day per number, 3 per page (and a
number with 3 declined cards in a day is locked for the day: 429 `CARD_SAVE_LOCKED`). nginx: zone `oasis_public_links`, 60 a minute per address with a burst of 20, bodies up to 4k. |
| **Dead links and pages** | 401 `IDENTITY_LINK_INVALID` (exchange; `meta.reason` `not_found` \| `expired` \| `used` \| `revoked`) "This link no longer works" and 401 `IDENTITY_SESSION_INVALID` (every other route) "Open the link from our text again." A link or page dies when it expires, is used up, superseded by a newer link of its kind, the number texts STOP (START does not bring it back), the client's PIN or number changes, staff clear the PIN or revoke the trust, the links epoch is bumped (`links.epoch`, the incident switch), or (a payment link) its invoice is paid or voided. Five wrong PINs or codes on a page end it (429 `IDENTITY_SESSION_LOCKED`). |
| **Wrong purpose** | A page asking for another kind of link's action (a calendar page paying, a payment page booking) is 401 `LINK_WRONG_PURPOSE` "This link is for something else. Text us and we’ll send you the right one." |

**Kinds and what each page may do.** `calendar` (`#/c`, 72 h): availability, bookings (3), reschedule. `book_again` (`#/c`, 14 days):
availability, bookings (1). `verify` (`#/v`, 15 min, single use): verification only (the step that verifies the page uses it up).
`pin` (`#/pin`, 15 min): verification and choosing / resetting the PIN (the PIN step uses it up). `membership` (`#/m`, 24 h, the plan
it was sent for): `membership/start` (3). `pay` (`#/p`, until paid or void, at most 7 days, the invoice it was sent for):
`pay/start` (3). `card` (`#/k`, 24 h, ADR 0171 D7, migration `20261014500000_square_cards.sql`): saving a card with Square
(`cards`, 3) and removing one. Opening a link uses nothing; the numbers in brackets are its completions.

**Verified and fresh.** A page is **verified** when its session started inside the number's live 30-day trust, or once a PIN or a
texted code was entered on it. Bookings and reschedules need verified. Memberships, payments and saving or removing a card need **fresh**: a PIN or
code entered on this page in the last 5 minutes (the trust alone is not enough). Both refusals are 403 `IDENTITY_STEP_UP_REQUIRED` "Enter your PIN
or a texted code to continue." with `meta.need` `verified` or `fresh`. A PIN outranks a code: once the client has a PIN, a code only
resets it. **A code proves the number, not the client** (W4c fixes): on a record the stale-record rule holds, a page verified by code
shows nothing of the client (no name, visits, invoice or PIN window), moves none of their visits (404 `LINK_APPOINTMENT_NOT_FOUND`),
starts no membership or payment and sets or resets no PIN (409 `IDENTITY_RECORD_UNCONFIRMED` "We could not confirm this number is
still yours. Enter your PIN, or call or text us and we’ll sort it out."), and its booking makes a new client (`bindPartyToNumber`,
section 27.2); the client's own PIN proves them and ends the rule. Within 72 hours of a PIN reset the client's member privileges wait: no member fee waiver or VIP rules on bookings,
and 403 `LINK_PRIVILEGES_HELD` (`meta.until`) on membership and pay starts.

### 28.2 The page state (`LinkState`)

The exchange (with `session` added), `GET me` and every verification step answer the page's state:

```
{
  kind: calendar | verify | pin | membership | pay | book_again | card,
  expiresAt,            // the session's hard end (1 hour after the exchange)
  idleExpiresAt,        // the session's idle end (15 minutes after the last call)
  link: { expiresAt },
  client: { firstName, last2, tier: gold | vip | null },
  trust: { verified, by: pin | code | null, until },      // until: the number's 30-day trust, when there is one
  stepUp: { method: pin | code, freshUntil, canSetPinUntil },
  appointments: [ { ref, start, end, when, service, addons[], status, canReschedule } ] | null,
  invoice: { number, date, items[{name, priceCents}], subtotalCents, taxCents, tipCents, totalCents, paidCents, balanceCents } | null,
  plan: { tier, planKey, name, monthlyPriceCents, perks[], billing: square | squarespace,
          prices: [ { class, label, monthlyCents, joinable } ] } | null,
  cards: [ { id, brand, last4, expMonth, expYear, purposes[] } ] | null,          // ADR 0171 D7, wave Q3a
  cardSetup: { consent: { version, text, purposes[{key, words}], checkedByDefault: false },
               square: { applicationId, locationId, environment: sandbox | production, sdkUrl } | null } | null
}
```

* `client.firstName` is the first word of the name on file ("BOOKING FOR MARIA ••21": `last2` is the last two digits of the number the
  link was texted to). It is empty for a stranger's link, a name the shop does not have yet (a placeholder, the assistant's "New
  texter ••1234"), and a record the stale-record rule hides (no activity for 180 days, or the last text bounced as an invalid number:
  the number may have a new owner) until the client's own PIN proves them (a texted code does not). `tier` is the website tier of an active membership (null during a reset
  hold).
* `stepUp.method`: `pin` when the client has a PIN (show the PIN entry, with "forgot? reset with a code"), else `code`. `freshUntil`:
  until when the last PIN or code entered here counts as fresh (null when none). `canSetPinUntil`: a code confirmed here opens 10
  minutes to choose a PIN (a reset code: a new PIN).
* `appointments` (null until verified): the client's visits that can still happen, soonest first, at most 5 (a calendar link sent
  for one visit lists only that one); `ref` is the booking reference (`OAS-00042`), `when` "Sat, Jun 20 · 1:00 PM" in shop time,
  `canReschedule` for a booked or confirmed visit that has not started.
* `invoice`: a payment link's invoice (ADR 0170: each item adds `listCents`, `discountBp`, `memberDiscountCents`, `classLabel`, and
  `coverage[{serviceName, coveredCents, lineCents, differenceCents, planClassLabel}]`; amounts in cents; hidden while the stale rule hides the client). `plan`: a membership link's plan
  from the Settings catalog (public label, monthly price, perks); `billing` says how the page joins (wave Q3b: `square` = a card and
  consent on this page, `POST membership/subscribe`; `squarespace` = the checkout, `POST membership/start`), and `prices` the tier's
  monthly price at each size it is sold at, `joinable` when that price is set up at Square (always true for squarespace).
* `cards` (wave Q3a): the client's active saved cards with what their live consents allow (`membership_billing`, `no_show_fee`,
  `late_cancel_fee`, `balance`), newest first; only on a verified card or membership page whose client is proven, null otherwise.
  `cardSetup`: on card and membership pages while saved cards are on (PAYMENT_PROCESSOR=square), null otherwise: the current consent
  wording (`text` with `{purposes}` where the ticked purposes go, joined "a, b and c" in `purposes` order; send `version` back as
  `consentVersion`; the box starts unchecked) and Square's Web Payments SDK settings (no secret; `square` null when Square is not
  configured). The page loads the SDK from `sdkUrl` only when it shows the card form.
* All instants are ISO-8601 UTC strings.

### 28.3 Routes

| Route | Body / query | Answer and errors |
|---|---|---|
| `POST /public/links/exchange` | `{token}` (strict) | 200 `{session, ...LinkState}`. 401 `IDENTITY_LINK_INVALID` with `meta.reason`; the exchanges of a link are limited (verify and pin 5, membership 20, others 30: `used`). |
| `GET /public/links/me` | none | 200 `LinkState` (slides the idle window). |
| `GET /public/links/availability?days=5&service=<key>` | the website's query (section 26.1: `days` 1..14, `service` a catalog key, `addons` accepted and ignored; unknown or malformed 422) | 200 the website's board `{tz, generatedAt, serviceKey, durationMin, now, days[]}` plus `vip`: `true` when the VIP rules were applied (verified page whose client is a VIP client or an active member of the VIP plan, no reset hold): VIP-held times are then open. Calendar and book-again pages only. Never cached. |
| `POST /public/links/verify/code` | `{purpose?: verify \| pin_set \| pin_reset}` (default `verify`; unknown fields such as `phone` are ignored) | 202 `{challengeId, expiresInSec: 600, purpose, to}` (`to`: the last two digits of the link's number). The six-digit code goes to the link's number only. 409 `IDENTITY_PIN_REQUIRED` ("Enter your PIN to continue, or reset it with a texted code.") for `verify` once a PIN exists, `IDENTITY_PIN_EXISTS` for `pin_set`, `IDENTITY_PIN_NOT_SET` for `pin_reset`, `IDENTITY_UNKNOWN_CLIENT` for a PIN purpose on a stranger's link; 429 `PUBLIC_RATE_LIMITED`, 429 `PUBLIC_CODES_PAUSED` "We can’t text a code right now. Try again in N min, or text us." (the hourly ceiling `PUBLIC_OTP_TEXTS_PER_HOUR` is shared with the website's codes). |
| `POST /public/links/verify/code/confirm` | `{challengeId, code}` (strict) | 200 `{verified, ...LinkState}`: `verify` / `pin_set` verify the page by code (fresh now), trust the number 30 days (a client's link) and use up a verify link; `pin_reset` verifies nothing (`verified: false`) and opens 10 minutes for `pin/reset`. 401 `PUBLIC_OTP_INVALID` "That code didn’t match. 2 more tries before you need a new one." (`meta.attemptsLeft`), 429 `PUBLIC_OTP_LOCKED` after the code's third wrong try, 429 `IDENTITY_SESSION_LOCKED` after the page's fifth wrong PIN or code, 410 `PUBLIC_OTP_EXPIRED` (expired, used, or another page's code), 409 `IDENTITY_PIN_REQUIRED` when a PIN was set meanwhile. |
| `POST /public/links/verify/pin` | `{pin}` (strict) | 200 `{verified: true, ...LinkState}` (verified by PIN, fresh now, the number trusted 30 days). 401 `IDENTITY_PIN_INVALID` "That PIN didn’t match. 4 more tries on this page." (`meta.attemptsLeft`; the same answer and the same work when the client has no PIN), 429 `IDENTITY_SESSION_LOCKED`, 429 `IDENTITY_PIN_LOCKED` "Too many wrong PINs. Try again in N min, or reset your PIN with a texted code." (Retry-After), 423 `IDENTITY_PIN_DISABLED` "Your PIN is locked after too many wrong tries. Reset it with a texted code.", 429 `IDENTITY_TOO_MANY_TRIES` (this address). |
| `POST /public/links/pin` | `{pin}` (strict) | Choose a first PIN, after a `verify` or `pin_set` code confirmed on this page in the last 10 minutes. 200 `{verified: true, ...LinkState}`; every other link and page of the client stops working (this one goes on). 403 `IDENTITY_CODE_REQUIRED`, 409 `IDENTITY_PIN_EXISTS`, 409 `IDENTITY_UNKNOWN_CLIENT`, 422 `IDENTITY_PIN_REJECTED` with the reason in `detail`: "Use 4 to 6 digits." / "Don’t use one digit over and over." / "Don’t use digits in a row like 1234." / "That PIN is too common. Choose another." / "Don’t use a year. Choose another PIN." / "Don’t use the end of your phone number.". |
| `POST /public/links/pin/reset` | `{pin}` (strict) | A new PIN after a `pin_reset` code confirmed on this page in the last 10 minutes: 200 `{verified: true, ...LinkState}`; every other link, page and the old trust end, the number is trusted again, the client is emailed (when an address is on file) and the managers notified; memberships and payments wait 72 hours. 403 `IDENTITY_CODE_REQUIRED`, 409 `IDENTITY_PIN_NOT_SET`, 422 `IDENTITY_PIN_REJECTED`. |
| `POST /public/links/bookings` (Idempotency-Key required) | `{serviceKey, addonKeys[] (≤12), date "YYYY-MM-DD", startMin, vehicle? {year?, make?, model?, color?, label?, plate?}, vehicleClass?, name?, email?, smsConsent?}` (strict) | 201 `{bookingRef, status: "booked", start, end, deposit {dueCents, how counter \| link}, confirmationBy sms \| none, service {key, name}, addons[{key, name}], when "Today · 1:00 PM", member, bayCount, pricing}`. Sizes (ADR 0170): `vehicleClass` (or a size label sent as the car, as on the website) prices the visit and is recorded on the page's client's car (source client); 422 `body.vehicleClass` before the link is used; `pricing` as on the website (section 26.3). Verified calendar or book-again pages. Books through the dashboard's `createAppointment` with channel `online` (lead time, windows, paused days, no overrides), source **`link`**, on the board's grid (422 `body.startMin` "Pick one of the times on the board."), the categories of the package and add-ons, the invoice, the `booking_confirmed_web` text ("Booked: Express Hand Wash, today at 1:00 PM. $25 booking fee due at the shop. Reply here to change it.") and the activity line "Booked on a personal link · …". The fee and VIP rules follow the page's own client (active member: no fee, `member: true`; VIP client or VIP-plan member: VIP rules), never during a reset hold. On a client's link `name` only fills a placeholder name (a real name is never replaced) and `email` only fills an empty one (never as a verified email; the email on file is never replaced from a link page, so a page trusted by the number alone cannot move the address a PIN reset's notice goes to — staff change it); on a stranger's link `name` is required (422 `body.name` "Enter your name.") and creates the client (source online; `smsConsent` their consent to the texts about the booking), or books for the number's client when one holds it (only their PIN verifies such a page once they have one: 409 `IDENTITY_PIN_REQUIRED`). A page verified by code on a record the stale-record rule holds (a stranger's link or the client's own) books a **new client** and the number moves to it (section 27.2 `bindPartyToNumber`; `name` fills the new record, a placeholder when empty; no member privileges). A booking made with the client's PIN records `booked_with_pin`. The Idempotency-Key belongs to the **link** (resolved from the session before the key is claimed): the same key and body from a re-opened page of the same link answers the stored booking with `Idempotent-Replayed: true`, and two links (behind one address or not) never share a key. 409 `IDENTITY_LINK_USED` once the link's bookings are spent; slot refusals in the website's words (409 `PUBLIC_SLOT_TAKEN`, `PUBLIC_SLOT_VIP`, `PUBLIC_SLOT_PAST`, `PUBLIC_SLOT_CLOSED`, `PUBLIC_SLOT_TOO_FAR`); 422 for an unknown service or add-on key. |
| `POST /public/links/appointments/:ref/reschedule` | `:ref` `OAS-00042`; `{date, startMin}` (strict) | 200 `{bookingRef, status, start, end, when}`. Verified calendar pages; only the page's own client's visits (a calendar link sent for one visit: only that one), 404 `LINK_APPOINTMENT_NOT_FOUND` "We can’t find that visit. Text us and we’ll help." otherwise; a visit that started, ended or was canceled: 409 `LINK_CANT_RESCHEDULE` "This visit can’t be moved online. Text us and we’ll help.". The online rules (the page's VIP privileges included) and the grid as for a booking, then the dashboard's reschedule (the client is texted the new time). Uses nothing of the link. A stale record's visits are not found by a page verified only by code. |
| `POST /public/links/membership/start` | `{email, planClass?, vehicles? [{car, plate?}] (≤5)}` (strict; `planClass` as in section 26.4: 422 `TIER_CLASS_UNPRICED`, stored on the membership and the checkout) | 200 `{redirectUrl, membershipRef "OAS-M-1A2B3C4D", checkoutExpiresAt}`: send the browser to `redirectUrl`, the plan's Squarespace checkout (https on squarespace.com only, checked again on the way out). Membership pages with a **fresh** step-up. A pending membership of the link's plan (reused when one is pending) and a checkout intent (W2e `openCheckoutIntent`): the typed email, the plan's product, 72 hours; the membership activates when the Squarespace sync matches the paid order to the intent. The page should say the email must be the one they pay with: it is stored only on the intent, never as the client's email or a verified email, so an email alone never links an order (design section 10); an order that matches only the intent's email but carries another phone or name waits for staff (`awaiting_match`, W4c fixes). `vehicles` are added to the client (`car` like "2021 Tesla Model 3"). One completion of the link. 409 `IDENTITY_RECORD_UNCONFIRMED` on a stale record proven only by a code, 409 `LINK_ALREADY_MEMBER` "You already have a membership. Text us to change your plan." (a live membership held, or shared as a household member), 409 `LINK_CHECKOUT_UNAVAILABLE` "Joining online isn’t open right now. Text us and we’ll help you join." (no checkout link in Settings yet; also with `PAYMENT_PROCESSOR=square`, where the page joins with `membership/subscribe`), 403 `LINK_PRIVILEGES_HELD`, 422 `body.email` "Enter a valid email.". |
| `POST /public/links/membership/subscribe` | `{email, planClass?, vehicles? [{car, plate?}] (≤5), sourceId, verificationToken?, consentVersion, cardholderName?, postalCode?}` (strict; Idempotency-Key optional, owned by the link) | (ADR 0171 D8, wave Q3b; section 30.11) With `PAYMENT_PROCESSOR=square` (else 501 `LINK_ACTION_NOT_READY`). Membership pages with a **fresh** step-up; the same guards as membership/start (403 `LINK_PRIVILEGES_HELD`, 409 `IDENTITY_RECORD_UNCONFIRMED`, 409 `LINK_ALREADY_MEMBER` for a live membership held or shared as a household member). The size must be priced (422 `TIER_CLASS_UNPRICED`) and that price set up at Square (409 `LINK_CHECKOUT_UNAVAILABLE`, also while Square is watch-only or `SQUARE_MEMBERSHIPS_ENABLED=false`); the email must look deliverable (422 `body.email` "Use an email you check: Square sends your membership receipts there." for example and test domains: Square ends a subscription whose email bounces); the consent the page showed must be the current version (409 `CARD_CONSENT_OUTDATED`). One completion of the link; a pending membership (source `square`; a pending one is reused unless an earlier attempt left a subscription or a cleanup at Square, in which case it is closed and a new one starts, so each subscription has its own membership) and an enrollment; the client's Square customer with the email; the card saved with the consent `membership_billing` (422 `CARD_DECLINED`, the reason in `detail`); the Square subscription from today. 202 `{status: "pending", membershipRef}`: poll `membership/status`. A second submit while an attempt is past its card answers its status and sends nothing. 503 `SQUARE_UNAVAILABLE` when Square does not answer before the card is saved. Limits: 10 an hour per address, 5 a day per number (shared with membership/start). |
| `GET /public/links/membership/status` | none | 200 `{status: none \| pending \| active \| failed, membershipRef}`: this page's own enrollment (`active` once Square's first invoice is paid; `failed`: the card refused, the first payment failed, Square ended the subscription, or not finished within an hour). Membership pages only (401 `LINK_WRONG_PURPOSE`). |
| `POST /public/links/pay/start` | `{}` | 200 `{status: "redirect", redirectUrl}`: the payment URL staff attached to the invoice, only https on a `PAYMENT_LINK_HOSTS` host (default squarespace.com and its subdomains, exactly square.link and checkout.square.site) with no user, password or port; one completion of the link. With `PAYMENT_PROCESSOR=square` (ADR 0171 D3): a Square link for exactly the current balance, reused while it is active for that amount, else made now in two transactions around the Square call (409 `CONCURRENT_UPDATE` if the balance changed during the call; 422 `PAY_NOTHING_TO_COLLECT`); `link_pending` only when Square does not answer or is watch-only. 200 `{status: "link_pending", redirectUrl: null}`: the invoice has no allowed URL; tell the client the shop will text a payment link (the managers get one `payments.link_requested` notice "Text Maria a payment link", not repeated while unread). Payment pages with a **fresh** step-up; 403 `LINK_PRIVILEGES_HELD`; 409 `IDENTITY_RECORD_UNCONFIRMED` on a stale record proven only by a code. A paid or voided invoice has already ended the page (401 `IDENTITY_SESSION_INVALID`). |
| `POST /public/links/deposit/start` | `{bookingRef}` | (ADR 0171 D2, `PAYMENT_PROCESSOR=square`) A verified calendar or book-again page pays the deposit of one of its client's upcoming visits (booked or confirmed) whose booking asked for a deposit link (`booking.guest_fee.collect` `link`): 200 `{status: "redirect", redirectUrl, amountCents}` a Square quick-pay link for exactly the deposit (an active one reused); `paid`; `none` (no deposit link owed for that visit, or Squarespace is still the processor); `link_pending` (Square did not answer). 404 for a booking that is not the page client's. Uses no completion of the link. Limits as pay/start. |

**Cards on file (wave Q3a, ADR 0171 D7 and D12; `src/modules/public/links/http/card-routes.ts`).**

| Route | Body | Answer and errors |
|---|---|---|
| `POST /public/links/cards` (Idempotency-Key required, the key belongs to the link) | `{sourceId, verificationToken?, consentVersion, purposes[] (membership_billing \| no_show_fee \| late_cancel_fee \| balance, at least one), cardholderName?, postalCode?}` (strict) | 201 `{card: {id, brand, last4, expMonth, expYear, state}, consent: {version, purposes}}`. Card pages with a **fresh** step-up, the client proven (409 `IDENTITY_RECORD_UNCONFIRMED`), no PIN-reset hold (403 `LINK_PRIVILEGES_HELD`); 401 `LINK_WRONG_PURPOSE` on another kind of link. `sourceId` is the Web Payments SDK's one-time token (never stored, never logged). The consent must be the current wording (409 `CARD_CONSENT_OUTDATED` "The card terms were updated. Reload the page, read them and try again.") with at least one purpose ticked (422). The card is saved with Square (CreateCard outside any transaction, key from the link and the token) under the client's Square customer, then the card and the consent (version, SHA-256 and text, time, address, browser, link, page) are stored (audit `card.saved`); one completion of the link per card saved (3); the same key and body replay the stored answer. 422 `CARD_DECLINED` with the reason the client may read in `detail` ("This card number is not valid. Please check it and try again."); after 3 declined cards in a day on the number: 429 `CARD_SAVE_LOCKED` "Too many cards were declined on this number today. Try again tomorrow, or pay at the shop." Limits: 10 an hour per address, 5 a day per number, 3 per page (429 `PUBLIC_RATE_LIMITED`). 501 `LINK_ACTION_NOT_READY` while saved cards are off (PAYMENT_PROCESSOR is not square); 409 `SQUARE_WRITES_OFF`; 503 `SQUARE_UNAVAILABLE`. |
| `DELETE /public/links/cards/:cardId` | none | 200 `{cardId, state}`: one of the page client's own cards (404 `CARD_NOT_FOUND` otherwise) is disabled at Square (DisableCard first: 503 / 409 change nothing) and its consents revoked (audit `card.disabled`); removing a removed card answers its state. A fresh step-up on a card page. 20 an hour per address. Uses no completion. |

The membership routes (`membership/subscribe`, `membership/status`) are built by wave Q3b (section 30.12).

### 28.4 Flows the website builds

1. **Open**: capture and scrub the fragment, `POST exchange {token}`; on 401 show the dead-link state for `meta.reason`.
2. **Step-up** when `trust.verified` is false (or `stepUp.freshUntil` is null for a membership or payment): `stepUp.method` `pin` →
   PIN entry (`verify/pin`), with "forgot your PIN?" → `verify/code {purpose: pin_reset}` → `verify/code/confirm` → `pin/reset`;
   `code` → `verify/code` → `verify/code/confirm`, then optionally "create a PIN" (`pin`, while `canSetPinUntil` is ahead).
3. **Calendar / book again**: `availability` → `bookings` (one Idempotency-Key per attempt) → the confirmation; `me.appointments` →
   `appointments/:ref/reschedule`.
4. **Membership**: plan (from `plan`) → vehicles → step-up → email → `membership/start` → redirect.
5. **Payment**: invoice review (from `invoice`) → step-up → `pay/start` → redirect or "we’ll text you a payment link".

## 29. The assistant's tools, in-chat actions, welcome flow and leads (ADR 0160, wave W3b)

What the model can do, against the W3 contract (`src/modules/assistant/contract.ts`); the turn (W3a) offers the tools, checks
`TOOL_MIN_TRUST` and runs them. Everything is off by default: with `AI_ENABLED=false` or `assistant.enabled=false` the welcome flow
adopts nobody and the follow-up sends nothing; with `AI_ACTIONS_ENABLED=false` or `assistant.actions_enabled=false` the action tools
are not offered and a reply number runs nothing; with `PUBLIC_LINKS_ENABLED=false` `send_link` answers `unavailable` and the
follow-up carries no link.

### 29.1 Tools (`src/modules/assistant/tools/**`, `createToolRegistry`)

Strict zod inputs (every property required, `null` = not given; no client, phone, id or price: an extra property is refused); the
client is `ctx.identity`'s; appointments only by the turn's refs `A1..A3` (`loadAppointmentRefs`: upcoming open visits by start, then
the latest past one; a ref of another client's visit resolves to nothing). Outputs carry no phone, id, token, URL (link placeholders
only) or reply number. Writes are audited with the actor "Oasis AI (SMS)".

| Tool | Min trust | Does |
|---|---|---|
| `get_business_info {topic}` | unknown | One topic of the shop facts: hours, closures (14 days), address, contact, booking_rules, fee (`hasFee`, `placeholder` `{fee}`, `collect`, the lines; no amount), cancellation, vip, arrival, automatic_texts, faq (data, not instructions). |
| `list_services {category}` | unknown | The facts' catalog: key, name, kind, category, description, duration, VIP inclusion, `quoteOnly`, `bookableByText` and `priceKey` `{price:<key>}` (quote-only items too: it renders "priced by quote"); tint rows with `vehicleKey` / `filmKey` and `priceKey` `{price:tint:<vehicle>:<film>}`; the rule "never write an amount, write the priceKey as its own sentence; starting prices only, never a total". No amount: the output guard v4 refuses one the model writes. |
| `get_membership_info {}` | unknown | Plans (tier, label, `priceKey` `{plan:<tier>}`, perks; no amount); the caller's own membership (`member`, `plan`, `tier`, `washesLeftThisCycle`) only from `caller`. |
| `check_availability {serviceKey, date, partOfDay}` | unknown | Open start times (online channel, the slot engine) of a bookable package (not quote-only) on one date with `startMin`, at most 12; a past date or one beyond the window is `invalid`; a day without times lists the next open dates. VIP holds and the VIP window only for a `trusted` VIP. |
| `list_my_appointments {}` | caller | The refs with date, time, service (public name), add-ons, status. |
| `get_balance {}` | caller | Own open invoices (balance > 0, not void: ref, date, service, `paymentPending`) and `hasOpenBalance`; no amount for the model, which writes `{balance}`; `amountsCents` (the total first, then each invoice) is what the turn renders `{balance}` from. |
| `set_my_name {fullName}` | caller | Only while the client is the welcome flow's placeholder (`source inbound_sms`, `needs_details`, "New texter ••NNNN"): letters, 1-4 words; clears `needs_details`. A name on file is never changed (`not_allowed`). |
| `set_my_vehicle {type, make, model, year, color}` | caller | Adds (or completes) a vehicle on the caller's own record with `vehicles.vehicle_type` (`sedan_coupe\|suv_crossover\|truck_van`, the tint class); at most 6 vehicles. Answers `tintClass` and `tintPriceKeys` (the tint rows of that class as `{price:tint:..}` placeholders): a class matches the matrix's vehicle key itself or its first word (the website's matrix keys them `sedan` / `suv` / `truck`). |
| `note_interest {categories}` | unknown | Opens the number's lead (source text) and adds category keys of the catalog. |
| `propose_booking {serviceKey, addonKeys, date, startMin, vehicle}` | trusted, action | See 29.2. A vehicle names one of the client's own; at most 2 future bookings made by text per client (`rate_limited`). |
| `propose_reschedule {appointmentRef, date, startMin}` | trusted, action | An own upcoming booked/confirmed visit to a new open time. |
| `propose_cancel {appointmentRef, reason}` | trusted, action | Only outside the free-cancellation window (`cancellation.policy.freeCancelHours`) and with no money on the visit (paid, awaiting the processor or store credit); otherwise `not_allowed` + handoff `late_cancel`. |
| `send_link {kind, appointmentRef, tier}` | unknown | `issueClientLink` (`issuedBy assistant`: 1 of a kind an hour, 3 a day) to the number that texts; returns the placeholder `{linkN}` (the URL goes to `ctx.addLink` after commit). verify needs a client; calendar for a stranger or from `caller`; pin / membership / pay from `caller`; membership needs the tier's plan; pay needs an open invoice with a payment URL (else handoff `no_payment_link`). |
| `opt_out {}` | unknown | Records the opt-out like STOP (`sms_opt_outs` source `keyword`, the client's mark, `revokeForOptOut`) and sends `opt_out_confirm` once. |
| `handoff_to_staff {reason, summary}` | unknown | `ctx.handoff` (digit runs masked in the summary); a pending in-chat action of the number is canceled. |

### 29.2 In-chat actions and the reply number (`actions/handler.ts`, the W2d `ActionCodeHandler`)

A proposal checks the slot with the online rules (the same check runs again at the confirmation), records
`assistant_pending_actions` (the trust checked again by `createPendingAction`; payload: service keys, date and start, or the
appointment id, never shown to the model) and queues `action_confirm` "<summary>. Reply NNNN to confirm." (`secretVars`: the message
row shows `[code]`; summaries "Express Hand Wash, Mon Jun 15 at 10:00 AM", "Move your … to …", "Cancel your … on …"). When the text
cannot be queued (opted out, no text from them in 15 minutes) nothing is kept. The model is told only to say it texted the details
to confirm, never to mention, ask for or repeat a number (the policy judge fails a reply that asks for a number the client received).

The reply number (a digits-only text routed as `action_code`, inside the webhook transaction): assistant off: the action is canceled,
no answer; actions off: canceled, answer `action_unavailable`; `confirmPendingAction` for that phone only (wrong: `action_code_wrong`,
the third locks: `action_code_locked`, expired: `action_code_expired`, trust ended: `action_needs_verify`); confirmed: executed in a
savepoint as the assistant's actor (`sched.edit` + `jobs.status`): `createAppointment` (channel `online`, source `sms_ai`, the
client's privileges, no booking-thanks text) answered by `action_booked` (with the guest fee written like `{fee}`: "$25", or "members never pay"), the lead closed
as booked; `rescheduleAppointment` (its `reschedule` text is the confirmation); `cancelAppointment` with `notify` (its notice is the
confirmation). A refusal (the time was taken meanwhile, the visit changed) fails the action and answers `action_failed`. Answers are
class `ai_reply`, sender "Oasis AI", one per received text. A STOP (any opt-out: `PgOptOutRepository.optOut` calls
`revokeForOptOut`) and a staff text on the thread cancel the pending action.

### 29.3 Welcome flow (`welcome/new-texters.ts`, `welcome/provisional.ts`)

`NewTexters.adopt` (inside the webhook transaction, under an advisory lock per number): restores the number's archived provisional
client unless the stale-record rule holds it (W4c re-review: the number may have changed hands; then a new provisional client is
created, and the archived record stays archived, loses the number, gets `phone_reassigned_at` / `_to` and the audit
`customer.phone_reassigned`), or creates "New texter ••NNNN" (source `inbound_sms`, `sms_opt_in_source inbound_text` unless the number is opted out,
`needs_details`, audit `assistant.client.created`), or returns the live owner; and opens the lead (source text). `isProvisional` /
`isProvisionalClient` tell the turn whether the client is still the placeholder.

### 29.4 Leads (`src/modules/leads/**`)

| Route | Access | What it does |
|---|---|---|
| `GET /leads?status=open\|all\|new\|followed_up\|booked\|closed&limit=1..200` | `cli.view` | Leads newest contact first (default `open` = new + followed up): client and name (`needsName` while the placeholder stands), source, interests with the category label and colour, status, contact times, `followUpAt` (planned) / `followedUpAt` (queued), the booking that closed it. `phone` only with `cli.contact`. |

`createLeads(deps)`: `open` (idempotent per number; a closed lead opens again, a booked one stays booked; the follow-up planned at the
last contact + `leads.follow_up_delay_min` while none was sent), `noteInterest`, `markBooked`. Jobs (`docs/jobs.md`):
`leads.follow_up` every 5 minutes: bookings since the first contact close leads first (also while the follow-up or the assistant is
off: it sends nothing); then each due lead once, under a row lock:
dropped after `leads.within_hours` from their last text or after any opt-out since the lead began (a later START notwithstanding),
dropped outside the rollout stage (`assistant.stage` `allowlist`: listed numbers only; `customers`: clients the stale-record rule does not hold, the turn's `stageAndConsent`), waits for the delay after their last text and, with `leads.business_hours_only`, for the next opening inside the window; the text is
template `lead_follow_up` (sender "Oasis AI", idempotency key `lead-follow-up:<lead>`) with a personal calendar link (`issuedBy
system`) as a `secretVar` when `PUBLIC_LINKS_ENABLED` (a stale record gets the stranger's text: no first name, a link bound to the number
only, the message on no client; `note_interest` with the turn's `unknown` trust leaves the lead's client empty): the thread shows `[private link]`, without a link the text stays readable
(`lead_follow_up` is a masked class). `leads.provisional_archive` nightly: see 29.3 and ADR 0160.

New SMS templates (class `ai_reply`, not editable, never staff-sendable): `action_booked`, `action_code_wrong`, `action_code_locked`,
`action_code_expired`, `action_needs_verify`, `action_failed`, `action_unavailable`.

Tests: `test/assistant-tools/*.test.ts`, `test/leads/*.test.ts`, the authz matrix and the contact sweep (the route registry);
`test/assistant/runtime-e2e.test.ts` runs the tools, the welcome flow, the reply number, the leads and the status texts through the
real turn, guard and judge (ADR 0160, W3 integration).

## 30. Square (ADR 0171): foundation (wave Q1b), core (wave Q2b) and cards on file (wave Q3a)

Everything here is off by default (`SQUARE_PROVIDER=sim`: an in-process simulator answers, nothing reaches Square;
`SQUARE_WRITES_ENABLED=false`: nothing is created or changed at Square; `PAYMENT_PROCESSOR=squarespace`: links, refunds and deposits
stay as before). Cards on file come with wave Q3a, memberships with Q3b (ADR 0171, "What the later waves add"); their shared
foundation (the cards tables, the client's Square customer, saving and removing a card with the client's consent) is section 30.10.

### 30.1 `POST /hooks/square` (webhook, public through nginx: POST only, zone `oasis_hooks`, 1 MB)

| Case | Answer |
|---|---|
| `x-square-hmacsha256-signature` is not base64 HMAC-SHA256(key, `SQUARE_WEBHOOK_URL` + raw body) for the current key or `SQUARE_WEBHOOK_SIGNATURE_KEY_PREVIOUS`; no key or URL configured | `401 WEBHOOK_SIGNATURE_INVALID`, nothing kept |
| Signed, but not a Square event envelope (`merchant_id`, `type`, `event_id`, `created_at`, `data.type`) | `400 MALFORMED_REQUEST` |
| An event of a merchant other than the one Test connection learned (in the configured Square environment) | `200 {status: "ignored"}`, nothing kept |
| An `event_id` already in `webhook_log` (provider `square`; a Square retry, a replay, or the catch-up was first) | `200 {status: "duplicate"}` |
| Accepted: claimed in `webhook_log` (body, headers without the signature), `square_state.last_webhook_at` set, `square.event.process {eventId}` queued (singleton key = the event id) | `200 {status: "accepted"}` |
| The queue refuses the job | the claim is released; `503 SERVICE_UNAVAILABLE` (Square's retry is accepted) |
| No queue (single process) | processed inline; a failure releases the claim and answers `503` |

The job re-fetches the object (payment, refund, invoice, subscription, card, customer) by id, ignores another location, and runs the
ingest handler under an advisory lock per object (payments and refunds since wave Q2b, sections 30.6 and 30.9; the others log until
Q3a and Q3b); the row is closed `processed`, or `ignored` with the reason in
`error`, or `failed` (retried 5 times, 30 s apart).

### 30.2 `GET /api/v1/integrations/square` (`set.billing` or `pay.reports`)

`{status, eventTypes, lastTest, catchup, reconcile}`: `status` is the `square` row of `GET /system/integrations` (below); `eventTypes`
the 18 types our webhook subscription must carry; `lastTest` the last Test connection (`ok`, `at`, `checks`); `catchup` the Events API
watermark, last run and events read; `reconcile` the counts of the last nightly read (payments and refunds of 72 hours by status, source
and product), or `null`. Never a token or a signature key.

### 30.3 `POST /api/v1/integrations/square/test` (`set.billing`, audited `square.test_connection`)

Body `{}`. Calls ListLocations, EnableEvents and ListWebhookSubscriptions (against the simulator with `SQUARE_PROVIDER=sim`) and answers
`200 {ok, environment: sandbox|production|sim, locationId, merchantId, webhookSubscriptionId, checks[], testedAt}` with one check each:

| `key` | Passes when |
|---|---|
| `token` | ListLocations answers (a 401 reads "Square refused the access token") |
| `location` | `SQUARE_LOCATION_ID` is among them, `ACTIVE`, in `USD`, with `CREDIT_CARD_PROCESSING` |
| `events` | EnableEvents succeeded (the 10-minute catch-up can read) |
| `webhook` | a subscription for exactly `SQUARE_WEBHOOK_URL` exists, is enabled and carries every event type (`pnpm square:webhooks --apply` fixes it) |

A failing check is still `200` with `ok: false` and a plain reason. The merchant id, the location, `events_enabled_at` and the verified
subscription are kept in `square_state` for the configured Square environment (sim, sandbox or production); the hook drops events of
any other merchant from then on. A row learned in another environment counts as none (switching environment starts it afresh).
The connection point `connected_at` (sandbox run F2) is stamped by the first read of a real Square environment, whichever comes
first: a successful test, the first catch-up page, the first reconcile listing, or the first webhook (10 minutes before its event: a
webhook is live). A counter payment Square made before it (the first catch-up reads a day back, the reconcile 72 hours) is the shop's
history, mirrored as `ignored` (reason `other`, note "before connection: ..."), never queued in "Square payments to match" nor
alerted. Later reads and tests keep the stamp, a change of environment starts it afresh, a stack that already read events before the
stamp existed gets none (nothing is cut), and the simulator is stamped only by a successful test.

### 30.4 `GET /api/v1/system/integrations`: the `square` row

`provider` `sim|live`; `missing`: `SQUARE_PROVIDER=live`, each of `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, `SQUARE_APPLICATION_ID`,
`SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_WEBHOOK_URL` that is unset, and "Events API not enabled" until Test connection enabled it;
`warnings`: no verified webhook subscription (live), the sandbox, observe-only, Squarespace still the processor, the simulator, a host
override, the POS switch outside production, a catch-up that has not run for 30 minutes (live), a watermark older than 27 days, no
webhook in 24 hours while the catch-up found events. `details`: environment, location, merchant, API version, writes, processor, POS
switch, `token` and `webhookKey` as `set`/`not set`, events enabled, subscription verified, last webhook, catch-up and reconcile times,
the last test result; `unmatched` (Square payments to match) and `failedRefunds` (card refunds Square refused in the last 14 days; both
also warnings when not zero); `pendingEnrollments` (membership-page enrollments under way, wave Q3b).

### 30.5 Jobs and environment

`square.event.process` (queue), `square.events.catchup` (every 10 minutes), `square.reconcile` (03:45), and since wave Q2b
`square.payments.match`, `square.links.sweep`, `square.deposit-link` and `square.refunds.submit` (every minute) are in `docs/jobs.md`;
the variables in `docs/integrations/square.md` section 2 (wave Q2b adds `SQUARE_POS_AUTOMATCH`). Scripts: `pnpm sim:square`,
`pnpm square:webhooks [--apply|--rotate-key]` (in production it accepts only `https://<domain>/hooks/square`), `pnpm verify:square`
(also in `pnpm verify:all` and `verify.sh square`).

### 30.6 Square payments into the ledger (wave Q2b)

Every Square payment of our location is mirrored in `square_payments` (re-fetched, never from a payload) and decided once, whichever
path brings it (webhook job, catch-up, reconcile, `square.payments.match`, a POS callback, a person): advisory lock
`square:payment:<id>`, the mirror row, ledger keys `square:pay:<id>` and `square:tip:<id>`, and never a second live `pay` of one payment.
Classification (first rule wins): another location ignored; already in the ledger; its order is one of our payment links (`link`:
recorded at once, `deposit` per the link's purpose, the link `paid`); a card-on-file charge (Q3a); a subscription invoice (Q3b); a POS
intent; else `counter` (one made before the connection point, section 30.3, is ignored as history), matched after
`SQUARE_MATCH_DELAY_SECONDS` (90): R1 the invoice number in the note or reference id (record, or
confirm its awaiting card entry of that amount); R2 a POS intent (confirm its entry); R3 exactly one staff "Square reader" (awaiting
card) entry of the amount, tip excluded (narrowed by the payer's identity); R4 exactly one open invoice of the day whose balance is the
amount, backed by the payer's identity (buyer email, the Square customer's email or phone); R4a amount only with
`SQUARE_POS_AUTOMATCH=amount`; else R5 `unmatched` with up to 5 ranked candidates. A recorded payment is a `pay` (source and processor
`square`, `processor_state confirmed`, `processor_ref` the payment id, `processor_order_id`, `Visa ••4242` / `Cash` / `Square`); a tip
is its own `pay` "Tip" and raises `invoices.tip_cents` by it. A POS cash payment of the amount of a staff cash entry only attaches its
references. Audit actions `square.record_payment`, `square.confirm_awaiting`, `square.record_tip`, `square.attach_cash`.

### 30.7 Square payments to match (`pay.reports` / `pay.collect` / `pay.void`; commands need an Idempotency-Key)

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /payments/square/unmatched` | `pay.reports` | `{items[{paymentId, matchState pending\|unmatched, classification, amountCents (tip excluded), tipCents, totalCents, refundedCents, method, sourceType, brand, last4, note, receiptNumber, product, createdAt, ageMinutes, candidates[{invoiceId, invoiceNo, client, balanceCents, awaitingEventId, score, why[]}]}]}`, oldest first. |
| `POST /payments/square/:paymentId/apply` `{invoiceId, confirmEventId?}` | `pay.collect` | Records it on the invoice (rule `manual`), or confirms the named awaiting card entry of that amount there. `{paymentId, matchState, invoiceId, eventId, invoice}`. 404 `SQUARE_PAYMENT_NOT_FOUND`, 409 `SQUARE_PAYMENT_DECIDED`, 422 `SQUARE_CONFIRM_MISMATCH`. |
| `POST /payments/square/:paymentId/ignore` `{reason: not_oasis_sale\|duplicate\|test\|other, note?}` | `pay.collect` | Sets it aside (no ledger event); audited `square.payment_ignored`. 409 `SQUARE_PAYMENT_DECIDED`. |
| `POST /payments/square/:paymentId/reassign` `{toInvoiceId}` | `pay.void` | A `void` of what it wrote on the wrong invoice (its tip too, which leaves that invoice's tip), then recorded on the right one (rule `reassign`). 409 `SQUARE_PAYMENT_NOT_MATCHED`, 409 `SQUARE_REASSIGN_REFUNDED`. |

"Needs attention" (ExternalAlertSource, `squareExternalAlerts`): `square_unmatched` (managers; payments waiting more than 30 minutes),
`square_refund_failed` (red, 14 days), `square_overpaid` ("Overpaid via Square", refund the difference; "a card charge went through
after it was closed" when a saved-card charge closed as not charged completed at Square later), `square_problem` (managers,
live only: the access token refused, the catch-up behind, webhooks silent).

### 30.8 POS app switch (`SQUARE_POS_API_ENABLED`, live production Square only)

| Endpoint | Permission | Notes |
|---|---|---|
| `POST /invoices/:id/square-pos-intents` `{}` | `pay.collect` | 404 `SQUARE_POS_DISABLED` unless on. Records the staff card entry for the balance (as the Card tender) and an intent: random `state`, note `INV-20640 · OAS-PI-xxxxxx`, 30 minutes. 201 `{intent{id, code, amountCents, note, expiresAt, appSwitch{ios, android}}, invoice}`: `ios` is `square-commerce-v1://payment/create?data=...` (version 1.3, callback `PUBLIC_DASHBOARD_URL/payments/square-callback`), `android` the `com.squareup.pos.action.CHARGE` intent URL. |
| `POST /payments/square/pos-callback` `{state, transactionId?, clientTransactionId?, errorCode?}` | `pay.collect` | From the dashboard's callback page. 404 `SQUARE_POS_INTENT_UNKNOWN`; `{status: error}` keeps the error (the entry stays waiting: void it if nothing was charged); with a `transactionId` the order's payments are fetched and recorded on the intent's entry at once (rule R2): `{status: recorded, invoiceId, payments}`; `waiting` when Square cannot be read now (the webhook brings them). |

### 30.9 Payment links, the booking deposit and refunds (`PAYMENT_PROCESSOR=square`, `SQUARE_WRITES_ENABLED=true`)

* Links: section 21 `payment-links` and `payments`, section 28 `pay/start` and `deposit/start`. A link row is written `pending` before
  the Square call (key `pl_<row id>`), made `active` by the command; `square.links.sweep` (every minute) cancels an active link whose
  invoice is canceled, paid elsewhere, changed, whose deposit is paid, or older than 7 days, gives up on pending rows (10 minutes; a
  booking's request after a day) and deletes canceled links at Square. A payment on a link canceled a moment too late is still recorded.
* Deposit (D2: a deposit toward the visit): with `booking.guest_fee.collect` `link`, the website, personal-link and assistant booking
  paths write a deposit request (a `pending` row, origin `booking`); `square.deposit-link` makes the quick-pay link and texts it
  (template `payment_link`). The payment is a `pay` with `deposit: true`; the cancel and no-show settlement keeps or refunds it unchanged.
  `card_hold` (wave Q3a) is accepted by `PUT /catalog/guest-fee` and collected at the counter until then (bookings answer `how: counter`).
* Refunds (D4): `square.refunds.submit` plans legs under the invoice lock (newest Square payment first, each capped by its total less
  its live legs) and sends RefundPayment with key `rf_<leg id>`; `refund.*` events move the legs (also when the webhook arrives before
  the job recorded Square's answer); the refund settles once every leg has: all completed, it is `confirmed` (`processor_ref` the
  refund id); any leg failed or rejected, or Square money that cannot cover it: `processor_state failed`, no longer counted
  (`invoice_calc_of`, `calc.ts`, `jobs-integrity.ts`), and an alert for the part that did not go back (`failedRefunds[].uncoveredCents`;
  shown as soon as a leg fails). What the completed legs gave back is written as its own confirmed card refund (`parentEventId` the
  failed one, key `square:refund-part:<event id>`, audit `square.refund_failed` names it), so the ledger counts exactly the money that
  went back; it keeps the original's `itemIds` (the items stay refunded; the rest goes back as an amount). A refund sent to Square, or
  waiting for the job to send it, is not confirmed by hand (409 `REFUND_SENT_TO_SQUARE`). A refund made in the Square app is attached
  to the staff's awaiting card refund of that amount, or to one they already confirmed by hand without a reference on an invoice whose
  card money is all Square's (it takes the Square refund id, audit `square.attach_refund`), or recorded as an external refund (`needs_review`, key `square:refund:<id>`, reason
  "Refunded in Square").

### 30.10 Cards on file: the shared foundation (waves Q3a and Q3b build on it)

No route of its own yet (the link routes are declared in section 28); the services the next waves call:

* `src/modules/square/customers.ts` `ensureSquareCustomer(deps, {customerId, email?})`: the client's Square customer from
  `square_customer_links`, else SearchCustomers by `reference_id` = the client's uuid (linked `found`), else CreateCustomer with key
  `cu_<client id>` (name and number only, so a retry is the same request; linked `created`); a given email is set at Square when it is
  missing or different. 404 `NOT_FOUND` for an unknown, merged or deleted client; 409 `SQUARE_CUSTOMER_TAKEN` when the Square customer
  is already another client's.
* `src/modules/square/consents.ts`: the versioned consent wording (v1: "Save this card with Square so Oasis Auto Spa can charge it for:
  <purposes>. Charges are made only after the shop confirms them, except your membership’s monthly payment. You can remove the card
  any time from your link or by asking us."), unchecked by default on the page, with its SHA-256. 422 `CARD_CONSENT_INVALID` (no or
  an unknown purpose), 409 `CARD_CONSENT_OUTDATED` (not the current version: reload).
* `src/modules/square/cards.ts` `saveCardOnFile`: the consent is checked first, then the Square customer, then CreateCard with key
  `cd_<keyBase>` outside any transaction, then one transaction writing `customer_cards` and `card_consents` (audit `card.saved`); a
  retry of the same attempt answers the same card and consent. 422 `CARD_DECLINED` with the client-readable reason in `detail`, 409
  `SQUARE_WRITES_OFF` (watch-only), 503 `SQUARE_UNAVAILABLE`. `disableCard`: DisableCard at Square, the card `disabled` and its live
  consents revoked (audit `card.disabled`); 404 `CARD_NOT_FOUND` for another client's or location's card; idempotent.
* Nothing calls them while `PUBLIC_LINKS_ENABLED=false` (the routes are closed) and `SQUARE_WRITES_ENABLED=false` (nothing is created
  at Square).

### 30.11 Cards on file and fees (wave Q3a; `src/modules/square/http/card-routes.ts`)

A saved card is charged only after a staff member confirms (ADR 0171 D7, plan decision 6). Every charge is sent to Square in the
idempotency `prepare` hook (after the key is claimed, before the command's transaction) and never while the invoice is locked; a replay
answers the stored result. `ChargeDto`: `{id, purpose: no_show_fee | late_cancel_fee | balance, state: proposed | charging | charged |
declined | unknown | waived, amountCents, reason, card {id, label "Visa ••4242", brand, last4} | null, invoiceId, appointmentId,
squarePaymentId, error, declineCode, attempts, proposedBy, decidedBy, decidedAt, chargedAt, waiveReason, createdAt}`.

| Route | Permission | Body | Answer and errors |
|---|---|---|---|
| `GET /customers/:id/cards` | cli.view | | `{cards[{id, brand, last4, label, expMonth, expYear, state, createdVia, createdAt, disabledAt, disabledReason, purposes[], consents[{id, version, purposes[], acceptedAt, revokedAt, revokeReason, via: link \| staff}]}], charge}`: active cards first; `charge` true when the "Saved card" tender may be offered (PAYMENT_PROCESSOR=square). |
| `DELETE /customers/:id/cards/:cardId` | cli.edit | | `{cardId, state, revokedConsents}`: DisableCard at Square first (503 `SQUARE_UNAVAILABLE` / 409 `SQUARE_WRITES_OFF` change nothing), then the card disabled and its consents revoked by staff (audit `card.disabled`). 404 `CARD_NOT_FOUND`. |
| `POST /customers/:id/card-link` | cli.edit | `{}` | `{sent, reason, linkId, expiresAt}`: a card link (`#/k`, 24 h, 3 cards) texted with `personal_link_card` (the link stored masked); `sent: false` with the reason when the text could not go (opted out, no number). 409 `CARD_LINK_UNAVAILABLE` while PUBLIC_LINKS_ENABLED=false, 409 `CARD_PAYMENTS_OFF` before the cutover. Audited `card.link_sent`. |
| `GET /invoices/:id/card-charges` | pay.collect or pay.reports | | `{items: ChargeDto[]}`, newest first. |
| `POST /invoices/:id/card-charges` (Idempotency-Key) | pay.collect | `{cardId, amountCents}` | A balance on a saved card with the client's OK: the card's live consent must cover `balance` (422 `CARD_NOT_USABLE` otherwise, or a removed or expired card), at most the balance (422 `PAY_AMOUNT_INVALID`), one charge at a time per invoice (409 `CARD_CHARGE_IN_PROGRESS`). 201 `{charge, invoice}` charged (a Square `pay`, rule `charge`, ledger reason "Balance"); 202 `{charge (state unknown), invoice}` when Square did not answer (`square.charges.resolve` finishes it; nothing is charged twice); 422 `CARD_DECLINED` (title "Card declined", the plain reason in `detail`, `meta.chargeId`; the charge stays `declined`, the key is released; the same key sent again is a new attempt on that charge after the same checks as a new charge, so a paid or canceled invoice answers 422 `PAY_NOTHING_TO_COLLECT`, a smaller balance 422 `PAY_AMOUNT_INVALID`, another waiting charge 409 `CARD_CHARGE_IN_PROGRESS`). 409 `CARD_PAYMENTS_OFF`, 409 `SQUARE_WRITES_OFF`, 422 `PAY_NOTHING_TO_COLLECT`. |
| `GET /appointments/:id/fee-charges` | pay.collect or sched.cancel | | `{items: ChargeDto[]}`: the visit's no-show and late-cancel fees. |
| `POST /invoices/:id/card-charges/:chargeId/not-charged` (Idempotency-Key) | pay.collect | `{}` | "Not charged (checked Square)", the way out of a charge stuck `unknown` (review Q4 H1-R1; a balance or a fee): Oasis looks the payment up at Square, read-only (GetPayment, or ListPayments by the charge's `reference_id`), so it works with Square watch-only too. Square has it: recorded as usual, 200 `{charge (charged), invoice}`, never closed as not charged. None: 200 `{charge, invoice}` with the charge `declined`, `declineCode` NOT_SENT, `error` "Nothing was charged: Square has no payment for it. Checked by <name>." (audit `card.charge_not_charged`, an activity line); the invoice can be collected again. 409 `CARD_CHARGE_NOT_WAITING` (charged, declined or waived), 409 `CARD_CHARGE_IN_PROGRESS` (its request went out less than 5 minutes ago, Square shows the payment pending, or Square has none yet but the last request, the job's re-send included, is under 15 minutes old: it may still land; review Q4FIX-N1), 503 `SQUARE_UNAVAILABLE` (nothing changes), 404 `CARD_CHARGE_NOT_FOUND`. A payment Square completes after the charge was closed is still recorded (`charged_after_close_at`), and the invoice's "Overpaid via Square" alert says a card charge went through after it was closed. |
| `POST /appointments/:id/fee-charges/:chargeId/charge` (Idempotency-Key) | pay.collect | `{cardId?}` | Charges a proposed (or declined: a new attempt, a new key) fee on its card or `cardId` (another of the client's cards whose consent covers that fee). 201 / 202 / 422 `CARD_DECLINED` as above; the payment lands on the visit's canceled invoice (ledger reason "No-show fee" / "Late-cancel fee"; the invoice reads canceled, kept) and the client is texted `card_fee_charged`. 409 `CARD_CHARGE_DECIDED` (charged or waived), 409 `CARD_CHARGE_IN_PROGRESS`, 404 `CARD_CHARGE_NOT_FOUND`, 422 `CARD_NOT_USABLE`. |
| `POST /appointments/:id/fee-charges/:chargeId/waive` (Idempotency-Key) | pay.collect | `{reason}` | 200 `{charge}` waived (audit `card.fee_waived`, an activity line). 409 `CARD_CHARGE_DECIDED`, 409 `CARD_CHARGE_IN_PROGRESS`, 404. |
| `GET /settings/card-fees` | set.billing or pay.reports | | `{fees: {enabled, noShowCents, lateCancelCents}, version, active}` (`fees.card_on_file`; off and $0 by default; `active`: enabled and Square the processor). |
| `PUT /settings/card-fees` | set.billing | `{enabled, noShowCents, lateCancelCents, version}` | The same answer; 412 `VERSION_CONFLICT` on a stale version. Audited `settings.update`. |

**The fee proposal.** With the fees on and Square the processor, a no-show (or a cancel inside the free-cancellation window) proposes,
never charges, the fee beyond the deposit kept, on the client's newest card whose consent covers that fee (none: nothing proposed; a
staff refund of the deposit: nothing proposed). The cancel and no-show answers carry it as `settlement.cardFee {chargeId, purpose,
amountCents, cardLabel}`, the activity log says "No-show fee proposed · $15.00 on Visa ••4242 (charge or waive it)", and reopening the
visit waives it.

**Jobs.** `square.charges.resolve` (every minute): charges Square did not answer are looked up (GetPayment, or ListPayments by
`reference_id`) and, within 23 hours and with Square writes on, sent again with the same key; past the 23 hours or with Square
watch-only nothing is sent, and a charge Square has no payment for 15 minutes after its last request is closed `declined` (NOT_SENT),
so no charge blocks its invoice for good (review Q4 H1-R1). One still unanswered after 10 minutes is a "Needs attention" alert
(`square_charge_unknown`, amber, "Saved-card charge not confirmed · Maria Delgado", "... if it is not in the Square dashboard, press
Not charged on the invoice"). `square.cards.nightly` (04:20): a card link for each membership card that expires within 30
days (once per expiry), and the cards of deleted clients disabled at Square. The webhook's `card.*` and `customer.deleted` events keep
the saved cards in step (ADR 0171, "Cards on file and fees").

### 30.12 Memberships billed by Square (wave Q3b)

Off by default: nothing is synced, enrolled or billed while `SQUARE_WRITES_ENABLED=false`, `PAYMENT_PROCESSOR=squarespace` and
`PUBLIC_LINKS_ENABLED=false`. ADR 0171 "Memberships on Square"; `docs/integrations/square.md` section 13.

**Catalog sync.** Each current tier price (`membership_tier_prices`, append-only: ADR 0170) becomes one Square
SUBSCRIPTION_PLAN_VARIATION (one phase, MONTHLY, STATIC price) of the tier's SUBSCRIPTION_PLAN (`membership_plans.square_plan_id`); a
price edit writes a new row, so a new variation, and the members keep the variation they are billed at until "Move members". The tier
views of `/catalog` carry each price's `squareState` (`pending`, `synced`, `failed`, `retired` = a superseded price nobody used,
deleted at Square). Jobs `square.catalog.sync` (every 5 minutes) and `square.catalog.drift` (nightly: Square's catalog read back,
a difference reported, never overwritten).

| Route | Access | Body | Answer |
|---|---|---|---|
| `POST /integrations/square/catalog/sync` | `set.billing` | `{}` | 200 `{status: done \| skipped, reason?, plansCreated, plansRenamed, variationsCreated, retired, kept, drift, recreated, failed}`; `skipped` while Square writes or memberships on Square (`SQUARE_MEMBERSHIPS_ENABLED`) are off. A failure stays on the row (`squareState: failed`) and the managers are told (`square.catalog_sync_failed`) once per set of failures, again a day later while it lasts. Audited `square.catalog.sync`. |
| `POST /catalog/tiers/:key/move-members` | `set.billing` | `{notice?: 0..90}` (days, default setting `memberships.price_change_notice_days`, 30) | 200 `{tierKey, moving, skipped, swapAfter}`: every member billed by Square at an older price of their size gets a scheduled move (`billing.change.kind: move`) and a notice by text (`membership_price_change`) and email; after the notice the job `square.plans.swap` sends SwapPlan, which Square applies at the next billing date. A member with a staff change scheduled is left alone (`skipped`). 409 `TIER_PRICE_NOT_SYNCED` until the current prices are at Square; 404 for an unknown tier. Audited `catalog.tier.move_members`. |

**Enrollment** on a membership page: `POST /public/links/membership/subscribe` and `GET /public/links/membership/status` (section
28.3). The attempt (`square_enrollments`) moves `started -> customer_ready -> card_saved -> subscribed -> active` (or `failed`,
`abandoned`); its Square keys are its own (`cd_<enrollment>` the card, `sb_<enrollment>` the subscription), so the job
`square.enrollments.resume` (every 5 minutes) repeats a step after a lost answer and reads a late first invoice back; an attempt not
finished within an hour is abandoned; a failed or abandoned one is cleaned up at Square (subscription and open invoice canceled, card
disabled with reason `membership_failed`) and its membership canceled; after a first payment that failed the client is texted a new
membership page (`membership_join_retry`). The website join (`POST /public/memberships`) with Square as the processor and personal
links open texts the client a membership page (`personal_link_membership`) instead of asking staff for a Squarespace link (no pending
membership until they submit there).

**Billing by events.** `invoice.*` and `subscription.*` (section 30.1) drive the membership: a paid invoice applies its cycle once
(the period from the due date to the subscription's charged-through date in shop-local midnights, the membership active, the cycle's
credits), a failed charge starts the failure policy, Square's status maps (PAUSED paused, CANCELED or DEACTIVATED canceled), and a plan
swap that took effect moves the membership to that price row (tier, size). The Squarespace inference leaves Square memberships alone.
A subscription invoice's payment is mirrored as a `membership` payment (`square_payments.match_state ignored`), never matched to an
Oasis invoice.

**Failure policy** (plan decision 7; setting `memberships.billing_policy` `{graceDays: 7, cancelDays: 21}`): day 0 `billing.status
failed`, in grace (perks on), the client texted their card page and Square's invoice page (`membership_payment_failed`) and emailed
Square's page, the managers told (`membership.payment_failed`); day 7 (job `membership.billing`, daily 09:30) `past_due` (perks off);
day 21 the subscription and the open invoice canceled at Square, the membership `canceled` with `cancel_reason payment_failed`. A
payment at any point restores it. There is no Oasis retry of the charge: Square cannot be paid through the invoice's order (sandbox).

**Staff actions** (`cli.member`; the Square call runs in the idempotency prepare hook, an Idempotency-Key is optional except for the
refund). Each answers 200 `{membership}` (the membership view, section 23) and is audited `membership.billing.<action>`. 409
`MEMBERSHIP_NOT_BILLED_BY_SQUARE` for another membership, 409 `MEMBERSHIP_BILLING_STATE` when the state does not fit, 409
`SQUARE_WRITES_OFF`, 503 `SQUARE_UNAVAILABLE`, 404 `MEMBERSHIP_NOT_FOUND`.

| Route | Body | What Square does |
|---|---|---|
| `POST /memberships/:id/billing/pause` | `{}` | PauseSubscription from the next billing date (`billing.pauseAt`). |
| `POST /memberships/:id/billing/resume` | `{}` | A paused subscription resumes now; a pause still to come is removed (DeleteSubscriptionAction). |
| `POST /memberships/:id/billing/cancel` | `{}` | CancelSubscription at the period end (`billing.cancelAt`); perks until then. |
| `POST /memberships/:id/billing/cancel/undo` | `{}` | DeleteSubscriptionAction on the scheduled cancel. |
| `POST /memberships/:id/billing/change` | `{planKey, planClass?}` | SwapPlan to the current price of the tier at the size (default the membership's) at the next billing date (`billing.change`); 409 `TIER_PRICE_NOT_SYNCED`. |
| `POST /memberships/:id/billing/change/undo` | `{}` | DeleteSubscriptionAction on the scheduled swap. |
| `POST /memberships/:id/billing/card-link` | `{}` | Nothing at Square: the client's card page (personal link `card`) texted (`personal_link_card`); 200 adds `sms: queued \| skipped`. A card saved there for membership billing is put on the subscription by `square.enrollments.resume` (Square then retries a failed payment with it). 409 `MEMBERSHIP_BILLING_STATE` while personal links are closed. |
| `POST /memberships/:id/billing/refund-last` (`pay.refund`, Idempotency-Key required) | `{}` | RefundPayment of the latest paid subscription invoice in full (key `rf_<invoice>`; after a refund Square failed or rejected, a new key); 200 adds `refund {amountCents, status}`. The membership is not changed. The invoice row keeps Square's `refund_status` from the `refund.*` events; a refund Square fails or rejects is cleared (409 no longer applies) and the managers are told (`membership.refund_failed`). 409 `MEMBERSHIP_BILLING_STATE` when nothing is left to refund or Square refused the refund at once. |

`PATCH /memberships/:id` on a Square membership changes only `autoApply` and `note`; `status`, `planKey`, `planClass`, `planLabel`
or `renewsOn` answer 409 `MEMBERSHIP_BILLED_BY_SQUARE`. The membership view gains `source: square` and `billing` (null for any other
membership): `{status ok|failed, squareStatus, failedAt, notifiedAt, pastDueOn, cancelOn, monthlyCents, planClassLabel, nextChargeOn,
card {brand, last4, label, expMonth, expYear, state}, cancelAt, pauseAt, change {kind change|move, planKey, planName, planClass,
planClassLabel, monthlyCents, effectiveDate, swapAfter}, lastInvoice {status, amountCents, dueDate, paidAt, refundedCents, payUrl},
lastPaid {amountCents, paidAt, dueDate, refundedCents}, lastFailed {amountCents, failedAt, dueDate, paid, payUrl}, enrollment {state,
failure}}` (`planClassLabel`, `nextChargeOn`, `card.label`, the change's names, `lastPaid` and `lastFailed`: wave Q3 dashapi, section
30.13).

Jobs: `square.catalog.sync`, `square.catalog.drift`, `square.enrollments.resume`, `membership.billing`, `square.plans.swap`
(`docs/jobs.md`). The integrations status row counts `pendingEnrollments`.

### 30.13 What the dashboard reads before the cutover (wave Q3 dashapi)

Read models only (no migration, no job, no new switch); every Square tender is off with the defaults. ADR 0171 "Dashboard data".

**The processor and the Square tenders for every role** (dashboard review Q2c F3). The invoice summary (the appointment file's
`invoice`, every command answer's `invoice`, `POST /appointments` and the add-on answers), the board and file `pay` view (`OpsCard.pay`,
`overview.pay`; absent without an invoice) and `GET /invoices/:id` carry the same block, so a role with `pay.collect` but without
`pay.reports` sees the right Collect options before its first collect:

```
processing: {
  processor: 'squarespace' | 'square',      // PAYMENT_PROCESSOR
  squarePosAppSwitch: boolean,              // SQUARE_POS_API_ENABLED
  squareTenders: {
    reader: boolean,                        // Square the processor ("Square reader"; works observe-only)
    link: boolean,                          // Square the processor and SQUARE_WRITES_ENABLED
    savedCard: {cardId, label, brand, last4} | null
  }
}
```

`savedCard` is the card `POST /invoices/:id/card-charges` would charge: the client's newest active, unexpired card whose live consent
covers `balance`; null when there is none, the invoice is canceled, Square is not the processor or writes are off (no card query is
made then). The summary also adds `refundedCents` (refunds done; a failed card refund and one waiting for approval are not counted).

**The deposit of a visit** (Q2c N1). The invoice summary adds `deposit` (null when there is no deposit to speak of):
`{state, requestedCents, paidCents, refundedCents, pendingRefundCents, keptCents, refundFailed, refundSending, link {state, sentAt,
expiresAt, createdAt} | null}`. `state`: `requested` (a deposit link asked for: being made, or made and not texted), `link_sent`,
`link_expired` (lapsed or withdrawn unpaid; withdrawn because the deposit was paid some other way gives null), `paid` (deposit
payments, less voids, on an open visit; a deposit paid by link and then voided gives null; a partial refund shows in
`refundedCents`); on an open visit also `refund_pending` (a refund waiting for approval would leave the invoice holding less than the
deposit) and `refunded` (the invoice holds nothing any more; refunds are kept per invoice, not per payment); for a canceled visit holding money: `refund_pending` (a refund waits for approval: no longer
read as kept), `refunded` (all of it given back; `refundSending` while a card refund is still on its way), `kept` (some or all stays;
`keptCents`, partial refunds in `refundedCents`, `refundFailed` when a card refund failed). The link's URL is never in it.

**Board cards** add the tier colours: `member {plan, label, color?, bgColor?}` (as the file's `membership.color` / `bgColor`).

**Square receipts on ledger rows.** A `pay` row of a Square payment (`processor: square`) adds `receiptNumber` and `receiptUrl` from the
Square mirror (`square_payments`); the URL only when it is an https page on `squareup.com` or `squareupsandbox.com` (or a subdomain), no
user, password or port; null for anything else and for every other row.

**Settings, Billing & integrations** (`src/modules/square/http/billing-routes.ts`; `set.billing`). Each editable block carries its own
`version`; a PUT takes it in the body or If-Match (428 `PRECONDITION_REQUIRED` without, 412 `VERSION_CONFLICT` stale), answers with an
`ETag`, is audited `settings.update` and publishes `settings.changed {key}`.

| Route | Body | Answer |
|---|---|---|
| `GET /settings/billing` | | `{square, processing, guestFee, linkTipping, cardFees, renewalPolicy, priceChangeNotice, consent}`: `square` is the body of `GET /integrations/square`; `processing {processor, squareProvider, squareEnvironment, writesEnabled, membershipsEnabled, posAppSwitch, posAutomatch, publicLinksEnabled, cardsOn}` is read only (server switches); `guestFee {cents, collect, version}` (saved with `PUT /catalog/guest-fee`, `set.services`); `linkTipping {enabled, version}`; `cardFees {fees, version, active}` (saved with `PUT /settings/card-fees`); `renewalPolicy {graceDays, cancelDays, version}`; `priceChangeNotice {days, version}`; `consent {version, checkedByDefault: false, purposes, text}` (read only). Never a token or a key. |
| `PUT /settings/billing/link-tipping` | `{enabled, version?}` | `{enabled, version}` (`payments.link_tipping`, off by default). |
| `PUT /settings/billing/renewal-policy` | `{graceDays 0..60, cancelDays 1..90, version?}` | `{graceDays, cancelDays, version}` (`memberships.billing_policy`, default 7 / 21); 422 `VALIDATION_FAILED` unless cancelDays > graceDays. |
| `PUT /settings/billing/price-change-notice` | `{days 0..90, version?}` | `{days, version}` (`memberships.price_change_notice_days`, default 30). |

Reused, not copied: `POST /integrations/square/test` (Test connection), `PUT /catalog/guest-fee` (the fee and its collect mode),
`PUT /settings/card-fees`, `POST /integrations/square/catalog/sync` ("Sync to Square").

**The membership billing block** (section 30.12) adds `planClassLabel`, `nextChargeOn` (the shop-local date Square charges next: the end
of the paid period; null when no charge is due on a known date: not ACTIVE at Square, not an active membership, a failed renewal, or a
cancel or pause on or before it), `card.label` ("Visa ••4242"), `change.planName` / `change.planClassLabel`, `lastPaid {amountCents,
paidAt, dueDate, refundedCents}` and `lastFailed {amountCents, failedAt, dueDate, paid, payUrl}`.

**The tier price grid** (`GET /catalog/tiers`, the tiers of `GET /catalog`, every tier answer; `set.services` holders only) adds to each
price `squareError` (the last sync problem in plain words: why it failed when `failed`, or, on a `pending` price, why it is being made
again because Square lost its plan variation; null once synced and when there was none) and `squareSyncedAt`; `squareState` is the real state the catalog
sync keeps (`pending` until synced, always while `SQUARE_MEMBERSHIPS_ENABLED` is off).

**Saved cards** (`GET /customers/:id/cards`, section 30.11) already carry each consent's `version`, `acceptedAt` and `purposes`
(confirmed, no change).

Tests: `test/square-db/dashboard-gaps.test.ts`, `test/square-db/billing-settings.test.ts`, `test/square-members/billing-view.test.ts`,
`test/square/dashboard-gaps-pure.test.ts`.
