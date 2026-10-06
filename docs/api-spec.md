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
| GET | `/api/v1/auth/csrf` | authenticated |  |
| POST | `/api/v1/auth/invite/accept` | public |  |
| POST | `/api/v1/auth/login` | public |  |
| POST | `/api/v1/auth/logout` | authenticated |  |
| POST | `/api/v1/auth/password/change` | authenticated |  |
| POST | `/api/v1/auth/password/forgot` | public |  |
| POST | `/api/v1/auth/password/reset` | public |  |
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
| GET | `/api/v1/me` | authenticated |  |
| PUT | `/api/v1/me/preferences` | authenticated |  |
| POST | `/api/v1/me/view-as` | authenticated |  |
| GET | `/api/v1/meta/now` | public |  |
| GET | `/api/v1/openapi.json` | public |  |
| GET | `/api/v1/roles` | team.view |  |
| POST | `/api/v1/roles` | team.roles |  |
| DELETE | `/api/v1/roles/:id` | team.roles |  |
| PATCH | `/api/v1/roles/:id` | team.roles |  |
| PUT | `/api/v1/roles/:id/limits/:kind` | team.roles |  |
| PUT | `/api/v1/roles/:id/permissions/:key` | team.roles |  |
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
| `PUT /employees/:id` | `team.edit` (+ `team.roles` when roles or exceptions change) | **`If-Match: "<version>"` required** (428 `PRECONDITION_REQUIRED`, 412 `VERSION_CONFLICT` with `meta.currentVersion`). Omitted fields are unchanged. |
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
