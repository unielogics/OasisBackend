<!-- Reference material generated during planning (2026-10-06) from the three Claude Design prototypes. Source of truth for the build; see docs/plan.md. -->

# Oasis Auto Spa: Backend Design (Node + TypeScript + Postgres)

Scope is the dashboard backend only. The fixed decisions are Squarespace as the card processor and the SMS Gate tablet over Tailscale for SMS, with SES and S3. "P1" means build now. "P2" means schema and plumbing now, and the full feature later. Items marked **[DECISION]** are collected in section 11.2.

Verification caveat: the exact field names and routes of the Squarespace and SMS Gate APIs are written from the verified limits in the brief plus my recollection of their docs. Each is marked "verify" and must be confirmed against live docs or a sandbox during adapter build. Contract tests are specified for each.

---

## 1. Architecture and stack decisions

### 1.1 Decisions

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node 22 LTS (`dnf nodejs22`), pnpm, TypeScript 5 strict, ESM | Available on AL2023 aarch64. |
| HTTP | **Fastify 5** | Schema-first, encapsulated plugins, pino built in, fast on 2 vCPU. The raw body is easy to capture for webhook HMAC. SSE is trivial via `reply.raw`. Express has no native schema layer. |
| Validation and OpenAPI | **Zod** with `fastify-type-provider-zod` and `@fastify/swagger` | One schema gives runtime validation, TS types and the OpenAPI doc. The doc is served at `/api/v1/openapi.json`. The dashboard generates its client with `openapi-typescript`. |
| DB | **PostgreSQL 15** (`dnf postgresql15-server postgresql15-contrib`) | Extensions: `btree_gist`, `citext`, `pg_trgm`. `pgcrypto` is not needed, because UUIDs are generated in the app. |
| Query layer | **Kysely** with the `pg` driver and `kysely-codegen` | Pure TS, no native engine. The report queries are CTE- and window-heavy and use `FOR UPDATE`, partial indexes and views. Raw `sql` templates are first class. Prisma is rejected because it has a native engine and fits views, partial indexes and exclusion constraints poorly. Drizzle is viable but weaker for raw-SQL reporting. |
| Migrations | Kysely `Migrator`, forward-only. Each migration is a `.ts` file that executes a sibling `.sql` file. | Plain SQL stays reviewable. CI checks that `pg_dump --schema-only` after migrating an empty DB equals the committed snapshot. |
| Job queue and cron | **pg-boss v10** (Postgres only, no Redis) | Handles cron, delayed jobs (`sendAfter`), retries, dead letters and singleton keys. The SMS dispatcher is not a pg-boss job (see 7.2). |
| Realtime | **SSE** | Server-to-client only, which is enough. Events are persisted in `realtime_events` and fanned out with `LISTEN/NOTIFY`. This gives `Last-Event-ID` replay and is multi-process safe later. |
| Passwords | `@node-rs/argon2` (argon2id, prebuilt arm64-gnu binary, no gcc). Fallback is `node:crypto.scrypt`, stored as a PHC-style string with an algorithm prefix so the hash can be migrated. | The brief requires no gcc dependency. |
| IDs | **UUIDv7** generated in the app (the `uuidv7` package) | Time-ordered, so keyset pagination and index locality work. Human refs are separate: `invoice_no` and `appointments.seq`. |
| Time | `luxon`, behind an injected `Clock` interface | No bare `Date.now()` anywhere (lint-enforced). This makes freeze and time-travel in tests and parity seeds possible. |
| Phone | `libphonenumber-js` (pure JS) | E.164 normalization. |
| Logging | pino with redaction (`authorization`, `cookie`, `password`, tokens, phone numbers masked in info logs), a request id on every line | |
| Rate limit | `@fastify/rate-limit` with the in-memory store (single process) | A Postgres store is the later option if scaled out. |
| Testing | Vitest with a real Postgres | Docker is not available, so each worker uses `CREATE DATABASE … TEMPLATE oasis_test_template`. |
| Images | `sharp` (prebuilt arm64 binaries) for photo thumbnails, behind a try/fallback to the original | |
| Email and S3 | AWS SDK v3 (`client-sesv2`, `client-s3`, `s3-request-presigner`), pure JS | On EC2, use the instance profile. No keys are needed. |

### 1.2 Topology on the host (2 vCPU / 7.8 GB)

```
 Internet --443--> nginx (certbot) ──/api, /hooks/squarespace, /hooks/ses──> oasis-api :3001
                                    └──/ ──> oasis-web (Next.js) :3000
 Tailnet  --443--> `tailscale serve` (Tailscale-issued cert, tailnet-only)
                                    └──/hooks/smsgate/* ──> oasis-api :3001
 oasis-api --http over tailnet--> tablet (SMS Gate local server :8080)
 Postgres 15 on localhost; systemd units: postgresql, oasis-api, oasis-web, nginx, tailscaled
```

- The dashboard and API share one origin through nginx (`/api` proxied to the API). Cookies are therefore host-only and there is no CORS. The SSE location needs `proxy_buffering off` and `proxy_read_timeout 1h`.
- Squarespace webhooks need a public HTTPS URL. SMS Gate webhooks must be HTTPS with a valid certificate because the target is non-localhost. They are served only on the tailnet via `tailscale serve`, never Funnel, so they are not exposed publicly.
- The `/hooks/smsgate/*` routes are rejected on the public listener, using an nginx `location` deny plus an API check on the `Host` header.
- Memory budget: Postgres about 1 GB, API about 300 MB, Next about 500 MB. This leaves room for Playwright Chromium parity runs.

### 1.3 Project layout (`~/oasis/backend`, single package)

```
src/
  app.ts server.ts worker.ts            # api process; worker = same code with JOBS_ENABLED
  config/env.ts                         # zod-validated env, fails fast
  platform/  clock.ts db.ts errors.ts idempotency.ts audit.ts realtime.ts
             rbac.ts crypto.ts pagination.ts money.ts time.ts phone.ts csv.ts
  modules/
    auth/ people/(employees,roles) settings/(hours,closures,emergency,vip,arrival,business)
    catalog/(services,checklists) customers/ scheduling/(appointments,availability,bays,calendar,alerts,kpis)
    jobs/(checklist,photos,arrivals) payments/(invoices,ledger,credit,reports,csv,approvals)
    memberships/ messaging/(threads,templates,inbound-router,optouts)
    integrations/ squarespace/ smsgate/ ses/ s3/   # each = port + adapter + simulator
    notifications/ public/ dev/
  jobs/ registry.ts *.job.ts
  copy/en.ts                            # error titles/messages, default SMS templates
db/ migrations/ seeds/(base, design-parity, demo, genDay.ts, payFixtures.ts)
test/ unit/ integration/ contract/ fixtures/
```

Module rule: routes call services, and services call repositories. Only services open transactions. Cross-module calls go through service interfaces. Adapters are reachable only via ports (`SmsProvider`, `EmailProvider`, `ObjectStore`, `PaymentProcessor`, `SquarespaceSource`).

### 1.4 Conventions

- **Versioning:** URL prefix `/api/v1`. Changes are additive within a version, and a breaking change means `/v2`. The response carries `X-API-Version`.
- **Pagination:** keyset. Request `?limit=` (default 100, max 500) and `?cursor=` (opaque base64 of the sort key plus id). Response `{items, nextCursor}`. The Payments list has no pagination in the design, so the dashboard port auto-follows cursors. A 30-day range is about 100 to 300 rows.
- **Error model:** RFC 9457 `application/problem+json`: `{type, title, status, code, detail, errors?:[{path,message}], requestId, meta?}`.
  - `code` is machine-readable, for example `SLOT_UNAVAILABLE`, `BAY_BUSY`, `OVER_LIMIT`, `VERSION_CONFLICT`.
  - For guard failures, `title` and `detail` are exactly the design's toast strings (for example title `Slot unavailable`, detail `Would overbook a bay — override required`). The dashboard toasts them directly.
  - Status mapping: 400 malformed, 401 unauthenticated, 403 permission, 404, 409 state conflict, 412 version mismatch, 422 validation or business rule, 429 rate limit.
- **Idempotency:** the `Idempotency-Key` header (a UUID generated per user action by the dashboard).
  - It is mandatory on every money command (`/invoices/**` POST) and on `POST /appointments` and `POST /emergency/close`. It is optional elsewhere.
  - Store `(key, user_id, route, sha256(body), status, response, expires 48h)`.
  - A replay with the same body returns the stored response with `Idempotent-Replayed: true`. The same key with a different body returns 422 `IDEMPOTENCY_MISMATCH`. A request still in flight returns 409.
- **Optimistic concurrency:** `version int` on mutable aggregates (appointments, invoices, employees, services, settings rows).
  - Edits send `If-Match: "<version>"`, or `version` in the body for PUT settings. A mismatch returns 412 `VERSION_CONFLICT` with the current version.
  - Commands (advance, collect, and so on) use row locks instead of versions: `SELECT … FOR UPDATE` on the appointment or invoice row.
- **Soft delete:** `deleted_at` on customers, vehicles and closures. `retired_at` on checklist tasks. Services use `active=false`. Employees go `inactive` and are never deleted. Appointments move to `canceled` or `no_show`. Ledger, audit and activity rows are never deleted.
- **Audit:** `audit.record(tx, {...})` is called in the same transaction as every mutation: actor user and employee, the real actor, the `view_as` role, request id, entity, before and after JSON, and idempotency key. A DB trigger forbids `UPDATE` and `DELETE` on `audit_log`.
- **i18n of copy:**
  - Dashboard chrome and success toasts stay in the dashboard as a verbatim port of the design, with interpolated values taken from API responses.
  - Server-originated text is code and template driven: error `title`/`detail` from `copy/en.ts`, and SMS and email bodies from the `message_templates` table (editable with `msg.auto`).
  - Persisted human text, such as activity-log lines, is generated at write time from a typed catalog (`activity.confirmed`, and so on).
- **Money and time:** see section 2.

---

## 2. Cross-cutting conventions

### 2.1 Money (`platform/money.ts`)

- All amounts are integer cents. Columns are `integer`. Sums are cast to `bigint` in SQL and parsed to JS `number`, which is safe below 2^53. The pg `int8` type parser is set to `Number`.
- Rounding is half-up in integer math only:
  ```ts
  export const divHalfUp = (n: number, d: number) => Math.floor((n * 2 + d) / (2 * d)); // n >= 0
  export const taxCents = (subCents: number, taxBp: number) => divHalfUp(subCents * taxBp, 10_000);
  // taxBp = 700. The rate lives in settings (`tax.rate_bp`) and is snapshotted on each invoice (invoices.tax_bp).
  ```
- Tip is untaxed and added after tax. A percent discount is `divHalfUp(itemsCents * pctBp, 10_000)`, where `pctBp` is the percent in basis points (two decimals allowed).
- The design's amount parsing (`parseFloat(raw.replace(/[^0-9.]/g,''))||0`) is replaced by a shared `parseMoneyToCents(str)`.
  - The client uses it before calling the API, and the API accepts integer cents only.
  - It strips non-digits and dots, takes the first dot only (so `"1.2.3"` becomes 1.20), and rounds half-up at the third decimal.
- Display: Payments shows `$1,234.50` with `−$` (U+2212). The Operations screen shows whole dollars when cents are 0, else 2 decimals (user decision). The API never formats money. The dashboard's `money()` helpers do.

### 2.2 Time (`platform/time.ts`)

- All instants are `timestamptz` (UTC). The business tz is `locations.timezone` (America/New_York, a single Settings value). "Today", opening hours, closures (`YYYY-MM-DD`) and the weekday are computed in the business tz.
- The business tz is the one tz setting for every date or time of day, including SMS body times, calendar rows, CSV dates and the `Today/Yesterday` labels.
- Wall-clock strings the UI expects come from three helpers:
  - `fmtT(min)` gives `h:mm AM/PM` with no zero-pad hour.
  - `parseT(str)` gives minutes from midnight.
  - `atLabel(instant, now)` gives `Today h:mm AM`, `Yesterday h:mm AM`, else `Mon D · h:mm AM` (matches the design's `Jun 11 · 9:12 AM` and `Yesterday 4:40 PM`).
- Read models carry both ISO `…At` fields and, where the design shows a time string, a ready label (`time`, `atLabel`). This avoids client date math on screens that need it.
- `GET /meta/now` returns `{now, tz, bizDate, weekday, minutes, dateLabel}`. The dashboard replaces the frozen `BASE` and `NOW` with it and offsets its 1-second UI tick from the server time at load.
- Elapsed bay timers are client-side from `cleaning_started_at`, so there is no per-second polling.
- `business_hours.open_min` and `close_min` are minutes from midnight, on a 30-minute grid, 300 to 1410. Hours and rules sit in separate tables.
- Time-zone changes recompute `invoices.biz_date` via a migration job. The single tz makes this rare.

### 2.3 Other conventions

- **IDs:** UUIDv7 primary keys.
  - Short refs: `appointments.seq` (bigint identity) and `invoices.invoice_no` (per-location counter, display `INV-` plus the number zero-padded to at least 5 digits). The counter starts at 20611, because 20610 is the highest design id.
  - Reschedule tokens are 8-character base32.
  - Employee display name is `First L.` (for example `Marco R.`). On collision it extends the last-name prefix. Internal links always use ids, never names.
- **Multi-location readiness:**
  - Every location-scoped table has `location_id uuid not null`, and unique constraints and indexes lead with it. A request context resolves `ctx.locationId` (today the single seeded row).
  - Customers are brand-global. Employees link through `employee_locations`. SMS devices, the Squarespace connection, settings, hours, closures, bays, services, the invoice counter and VIP and arrival config are per location.
  - Adding a location is then rows plus a seed of defaults, not a schema change.
- **Realtime publish:** `realtime.publish(tx, channel, type, payload)` inserts a `realtime_events` row and `pg_notify`s on commit.

---

## 3. Data model

DDL is summarized as table, columns, constraints and indexes. `pk` is a UUIDv7. Every table has `created_at timestamptz default now()` unless noted. `…_cents` is `integer`. Enums are Postgres enums or `text` with a check.

### 3.1 Platform and configuration

| Table | Columns and constraints |
|---|---|
| `locations` | `id, name, slug unique, timezone text default 'America/New_York', address…, lat numeric(9,6), lng numeric(9,6)`. One seeded row. |
| `settings` | `(location_id, key) pk, value jsonb, version, updated_by, updated_at`. A typed registry in code validates each key: `tax.rate_bp`=700, `tax.label`, `currency`='USD', `federal_holidays.auto`, `ops.late_grace_min`=10, `ops.eta_visible_max_min`=30, `memberships.auto_apply`=false, `approvals.allow_self`=false, `reminders.offsets_min`=[1440,120], `reviews.enabled`, `sms.*`, `credit.default_expiry`. |
| `business_hours` | `(location_id, weekday 0-6) pk, is_open, open_min, close_min`. Check `open_min<close_min`, 300..1410, `%30=0`. |
| `booking_rules` | `location_id pk, slot_minutes in(15,30,60), buffer_minutes in(0,10,15,20), cutoff_minutes in(30,60,90), allow_overrun bool default true, auto_plan_bay bool default true, version`. Defaults 30/10/60. |
| `closures` | `id, location_id, date, name, type enum(closed,reduced), open_min null, close_min null, notify bool default true, source enum(manual,federal,emergency), federal_key text null, emergency_closure_id null, created_by, deleted_at`. Partial unique `(location_id,date) where deleted_at is null`. Also unique `(location_id, federal_key, year)` including soft-deleted rows, so a removed holiday is not regenerated. For `type=reduced`, `open_min`/`close_min` are the open window. |
| `federal_holiday_runs` | `(location_id, year) pk, ran_at`. |
| `emergency_closures` | `id, location_id, active bool, reason enum(severe_weather,power_outage,equipment_failure,staff_shortage,other), duration_kind enum(today,until,days), until_min, through_date, ends_at timestamptz, message text, notify, link, credits, pause, crew bool, summary text, started_at, started_by, reopened_at, reopened_by, auto_reopened bool, affected_count, notified_count, rebooked_count, detail text`. Partial unique `(location_id) where active`. History is the inactive rows. |
| `emergency_notifications` | `id, emergency_closure_id, appointment_id, customer_id, message_id null, channel, state enum(queued,sent,delivered,failed,skipped_opt_out,no_contact), reschedule_link_id, rebooked_at`. |
| `reschedule_links` | `id, code unique, appointment_id, emergency_closure_id null, closure_id null, expires_at, used_at, result_appointment_id`. |
| `vip_settings` | `location_id pk, release_hours in(24,48,72) default 48, window_vip_days default 30 (7–90), window_std_days default 14 (7–60), same_day_per_month default 2 (0–8), waitlist, offer_minutes in(10,15,30), standing, auto_confirm, cadences text[] ⊂ {weekly,biweekly,triweekly,monthly}`. |
| `vip_holds` | `id, location_id, weekday, time_min, unique(location_id,weekday,time_min)`. |
| `vip_clients` | `(location_id, customer_id) pk, added_by, added_at`. This replaces the name-string list and the per-appointment `vip` flag. |
| `arrival_settings` | `location_id pk, enabled, radius_m in(150,300,500), prep_at_min in(10,15,20), auto_arrive, welcome, alert_crew, vip_first`. |
| `bays` | `id, location_id, number smallint, name, status enum(active,maintenance,blocked), sort, unique(location_id,number)`. Two rows are seeded. |
| `idempotency_keys` | See 1.4. |
| `realtime_events` | `id bigserial, at, location_id, channel, type, payload jsonb`. |
| `user_preferences` | `user_id pk, theme text check in('light','dark')`. |
| `audit_log` | `id bigserial, at, location_id, actor_user_id, actor_employee_id, actor_name, actor_roles text, view_as_role_id, action, entity_type, entity_id, before jsonb, after jsonb, request_id, idempotency_key, ip`. Insert-only. |
| `webhook_log` | `id, provider enum(squarespace,smsgate,ses), external_id, headers jsonb, body text, signature_valid bool, received_at, processed_at, status, error`. Unique `(provider, external_id)` gives idempotency. Purged after 90 days. |
| `notifications` | `id, location_id, employee_id null, role_target text null, kind, title, body, entity_type, entity_id, created_at, read_at`. The bell dot is `exists unread`. |

### 3.2 People and auth

| Table | Columns and constraints |
|---|---|
| `employees` | `id, first, last, title, phone, email citext unique null, status enum(active,invited,inactive), employment_type enum(full_time,part_time,contractor), pay_type enum(hourly,commission,salary), rate_text, skills text[] check ⊂ SKILLS, bay_staff bool (appears in Operations staff columns and is assignable), avatar_color null, deactivated_at, version`. `display_name` is computed in code. |
| `employee_locations` | `(employee_id, location_id) pk`. |
| `employee_schedules` | `(employee_id, weekday) pk, is_on, from_min, to_min`. Validated inside business hours on save (2.3). |
| `roles` | `id, key text unique null ('super','mgmt','acct','support','crew'), name, description, is_locked, is_custom, version`. Super's unlimited default keys off `is_locked`, not the name. |
| `permissions` | `key pk, module, label, has_limit bool, sort`. Migration-seeded with the 27 keys. |
| `role_permissions` | `(role_id, permission_key) pk`. Presence means granted. |
| `role_limits` | `(role_id, kind in('refund','adjust','credit')) pk, limit_cents bigint null`. **A row with null means unlimited. No row means the default of 2500 (25 USD).** This removes the `Math.max(undefined)` quirk. |
| `employee_roles` | `(employee_id, role_id) pk`. |
| `employee_permission_overrides` | `(employee_id, permission_key) pk, effect enum(allow,deny)`. |
| `users` | `id, employee_id unique, email citext unique, password_hash, failed_attempts, locked_until, last_login_at, disabled_at`. |
| `invites` | `id, employee_id, token_hash, channel, expires_at (7d), accepted_at, created_by`. |
| `sessions` | `id (sha256 of token) pk, user_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at, ip, ua, csrf_secret, view_as_role_id null, revoked_at`. |
| `password_resets` | `id, user_id, token_hash, expires_at, used_at`. |

### 3.3 Catalog

| Table | Columns and constraints |
|---|---|
| `services` | `id, location_id, kind enum(package,addon), name, short_name null, price_cents, duration_min (add-ons: 0), tags text[], bookable_desk bool, sort, active, sqsp_sku null, version`. Unique `(location_id, kind, lower(name))`. The display short name is `name.split(' + ')[0]` unless overridden. |
| `checklist_tasks` | `id, service_id, label, position, retired_at`. **Stable ids.** Renaming updates `label` in place. Removing sets `retired_at`. |
| `message_templates` | `(location_id, key) pk, label, body, kind enum(quick_reply,automation,system), variables text[], enabled, sort`. See 7.2 for the key list. |

### 3.4 Customers and vehicles

| Table | Columns and constraints |
|---|---|
| `customers` | `id, full_name, phone_e164, phone_display, email citext, notes (standing), sms_opted_in bool, sms_opt_in_source, sms_opt_in_at, sms_opted_out_at, email_bounced_at, source enum(dashboard,walk_in,online,squarespace,inbound_sms,import), needs_details bool, merged_into, deleted_at, version`. Partial unique on `phone_e164 where phone_e164 is not null and merged_into is null and deleted_at is null`. Trigram index on name, phone and email for search. |
| `vehicles` | `id, customer_id, year, make, model, color, plate, deleted_at`. Unique `(customer_id, upper(plate))`. Lookup by plate. |

### 3.5 Scheduling and jobs

`appointments`:

| Column | Notes |
|---|---|
| `id, location_id, seq` | |
| `customer_id, vehicle_id, service_id` | |
| `package_name, price_cents, duration_min` | Snapshots. |
| `status` | enum `booked, confirmed, arrived, cleaning, completed, canceled, no_show`. |
| `scheduled_start timestamptz, scheduled_end timestamptz` | `end = start + duration`. |
| `assigned_employee_id` | Null means "Unassigned". |
| `planned_bay_id` | Advisory. |
| `bay_id` | The actual occupant, set when cleaning starts. |
| `source` | enum `dashboard, walk_in, online, phone, standing, reschedule_link`. |
| `eta_minutes, eta_at` | |
| `geo_checked_in_at, bay_prepped_at, arrived_at, cleaning_started_at, completed_at` | |
| `pickup_state` | enum `pending, collected`, null. |
| `picked_up_at, ready_notified_at, canceled_at, cancel_reason, no_show_at` | |
| `notes, special_instructions` | Job-level. |
| `membership_id` | |
| `emergency_closure_id` | Set when disrupted. |
| `standing_series_id` | |
| `arrival_token_hash` | |
| `version, created_by` | |

Indexes and constraints on `appointments`:

- Partial unique `uq_bay_occupied (bay_id) where status='cleaning'`. The DB enforces bay occupancy.
- `(location_id, scheduled_start)`, `(customer_id, scheduled_start desc)` and `(status) where status in ('booked','confirmed','arrived','cleaning')`.
- Check: `status='cleaning' → bay_id is not null`.

Other scheduling tables:

| Table | Columns and constraints |
|---|---|
| `appointment_addons` | `id, appointment_id, service_id, name, price_cents (snapshot), added_by, added_at, removed_at`. The source of truth for add-ons. |
| `appointment_overrides` | `id, appointment_id, kind enum(capacity,hours,closure,vip_hold,same_day_guarantee), reason, employee_id, created_at`. Audit of every override. |
| `job_checklist_items` | `id, appointment_id, section_kind enum(package,addon), section_title (snapshot), source_task_id null, appointment_addon_id null, label (snapshot), position, done, done_at, done_by_employee_id, removed_at`. Snapshotted at booking and when an add-on is added. Keys are never labels. |
| `appointment_photos` | `id, appointment_id, category enum(arrival,before,after,issue), s3_key null, thumb_key null, content_type, bytes, note text null, status enum(pending_upload,ready,deleted), taken_at, uploaded_by`. An `issue` row may be note-only (no `s3_key`), which matches the design's "N notes". |
| `activity_log` | `id, appointment_id, at, text, channels text[] (sms, email, internal, automation, system), actor_type, actor_name, meta jsonb`. Appointment-visible. This is distinct from `audit_log`. |
| `waitlist_entries` (P2) | `id, location_id, customer_id, vehicle_id, service_id, desired_date, window_start_min, window_end_min, is_vip, status enum(waiting,offered,booked,expired,canceled), offered_start, offer_expires_at`. |
| `standing_series` (P2) | `id, customer_id, vehicle_id, service_id, cadence, weekday, time_min, start_date, end_date, status, generated_through, auto_confirm`. |

### 3.6 Messaging (SMS)

| Table | Columns and constraints |
|---|---|
| `message_threads` | `id, location_id, customer_id, last_message_at, unread_count, unique(location_id, customer_id)`. **One thread per customer.** |
| `messages` | `id, thread_id, appointment_id null, direction enum(in,out), sender_kind enum(staff,system,customer), sender_employee_id, channel enum(sms,email,internal), body, template_key, status enum(queued,sending,sent,delivered,failed,received,canceled,expired), provider_message_id, error, queued_at, sent_at, delivered_at, received_at, device_id, idempotency_key unique`. |
| `sms_outbox` | `id, message_id, to_e164, body, priority smallint (0-3), attempts, next_attempt_at, locked_at, device_id, provider_message_id, last_error, ttl_at, state enum(pending,inflight,sent,failed,expired)`. Index `(state, priority, next_attempt_at)`. |
| `sms_inbox` | `id, device_id, provider_message_id, from_e164, body, device_received_at, raw jsonb, processed_at, message_id, unique(device_id, provider_message_id)`. |
| `sms_opt_outs` | `id, location_id, phone_e164, opted_out_at, source enum(keyword,manual,import), keyword, inbound_message_id, opted_in_again_at`. An active opt-out means a row exists with `opted_in_again_at is null`. |
| `sms_devices` | `id, location_id, label, base_url, username, password_enc, remote_device_id, webhook_secret_enc, sim_slot_default, min_interval_ms, max_per_hour, enabled, status enum(unknown,online,degraded,offline), last_seen_at, last_health jsonb, last_ping_at`. |
| `outbox_emails` | `id, to, template, subject, body, state, ses_message_id, error`. Also the console driver's mailbox. |

### 3.7 Payments

| Table | Columns and constraints |
|---|---|
| `invoices` | `id, invoice_no, location_id, appointment_id unique null, customer_id, client_name, vehicle_label, staff_label, occurred_at timestamptz, biz_date date, tax_bp, tip_cents default 0, canceled_at, canceled_by, payment_link_url, payment_link_sent_at, version`. Unique `(location_id, invoice_no)`. Counter table `invoice_counters(location_id pk, next_no)`. `occurred_at` follows the appointment start until the first ledger event, then freezes. |
| `invoice_items` | `id, invoice_id, position, kind enum(package,addon), service_id, name, price_cents >= 0, appointment_addon_id`. The package line plus one line per add-on. Kept in sync inside `AppointmentService`. |
| `ledger_events` | **Append-only.** See below. |
| `payment_links` | `id, invoice_id, kind enum(checkout,invoice), url, expected_cents, created_by, sent_message_id, sent_at, expires_at, state enum(active,paid,expired,canceled), matched_sqsp_order_id`. |
| `export_jobs` (P2) | `id, user_id, kind, params, state, row_count, s3_key`. Small exports stream synchronously. |

`ledger_events` columns:

- Identity: `id, invoice_id, customer_id` (denormalized), `seq bigserial`.
- Money: `type enum(pay, adjust, refund, credit_issue, credit_apply, void)`, `amount_cents integer`, and `status enum(pending,done,denied)`.
  - Non-refunds are always `done`.
  - `adjust` is signed. All other types are > 0.
- Payment detail: `method text` (display, for example `Visa ••4421`), `method_kind enum(card,apple_pay,cash,store_credit,other)`, `brand`, `last4`, `dest enum(card,credit,cash)` (refunds only), `deposit bool`.
- Descriptive: `reason, note`, `expiry enum(none,d90,d30)`, `expires_at`, `item_ids uuid[]` (by-item refunds), `parent_event_id` (a settlement refund points to its adjustment), `voids_event_id`.
- Actor: `actor_user_id, actor_employee_id, actor_name, actor_roles text` (the names of the roles that granted the permission, joined with ` + `, for example `Customer Support`).
- Approval: `approved_by_*` (user, name, roles), `approved_at, denied_by_*, denied_at`.
- Timing: `occurred_at` (not changed on approval) and `resolved_at`.
- Provenance: `source enum(oasis,squarespace,system,seed)`, `idempotency_key`.
- Processor: `processor_state enum(na,awaiting_processor,confirmed,failed)`, `processor_ref` (Squarespace transaction id), `sqsp_order_id`.

A trigger `ledger_guard` allows only these updates:

- `status` pending→done or pending→denied, plus the matching approver and resolved fields.
- `processor_state`, `processor_ref` and `sqsp_order_id`.

Everything else is rejected. There are no deletes.

### 3.8 Memberships and Squarespace

| Table | Columns and constraints |
|---|---|
| `membership_plans` | `id, location_id, key enum(essential,premium,executive,exotic), name, color, bg_color, tint, sort, perks text[] (verbatim marketing lines), addon_discount_bp, service_discount_bp, billing_interval_months default 1, sqsp_product_id null, sqsp_sku null, active`. |
| `plan_credit_rules` | `id, plan_id, include_tags text[], exclude_tags text[], per_cycle int null (null = unlimited)`. |
| `memberships` | `id, customer_id, plan_id, plan_label (for example "Premium Care"), status enum(pending,active,past_due,paused,canceled), source enum(squarespace,manual), sqsp_subscription_ref, sqsp_profile_id, started_at, current_period_start, current_period_end, canceled_at, cancel_reason, last_sqsp_order_id`. Partial unique `(customer_id) where status in ('active','past_due','paused','pending')`. |
| `membership_credit_events` | `id, membership_id, cycle_start, kind enum(grant,reserve,redeem,restore,protect,expire), qty smallint, rule_id, appointment_id, invoice_id, note, actor`. |
| `sqsp_connections` | `id, location_id, site_id, auth_kind enum(api_key,oauth), access_token_enc, refresh_token_enc, token_expires_at, scopes, status, last_error`. |
| `sqsp_sync_state` | `(location_id, resource enum(orders,transactions,profiles,products)) pk, modified_after, cursor, last_run_at, last_success_at, last_error`. |
| `sqsp_webhook_subscriptions` | `id, sqsp_subscription_id, topic, endpoint_url, secret_enc, created_at, last_delivery_at`. |
| `sqsp_orders` | `id, sqsp_order_id unique, order_number, created_on, modified_on, customer_email, customer_name, customer_phone, channel, fulfillment_status, is_subscription bool, subscription_ref, grand_total_cents, refunded_total_cents, currency, test_mode bool, line_items jsonb, raw jsonb, customer_id, matched_invoice_id, match_state enum(unmatched,auto,manual,ignored,membership), synced_at`. |
| `sqsp_transactions` | `id, sqsp_txn_id unique, sqsp_order_id, kind enum(payment,refund), created_on, amount_cents, currency, brand, last4 null, provider, refunds jsonb, raw jsonb, matched_event_id, state`. |
| `sqsp_profiles` | `sqsp_profile_id pk, email, name, phone, customer_id`. |
| `sqsp_products` | `sqsp_product_id pk, sku, name, type, is_subscription, price_cents, mapped_service_id, mapped_plan_id`. |
| `customer_card_hint` (view) | The latest card transaction per customer: brand and last4 when present. |

### 3.9 Computed values: the invoice calc view (exact port, in cents)

```sql
create view invoice_calc as
with it as (select invoice_id, sum(price_cents)::bigint items from invoice_items group by 1),
e as (select invoice_id,
  coalesce(sum(amount_cents) filter (where type='adjust'),0) adj,
  coalesce(sum(amount_cents) filter (where type='pay'),0)
    - coalesce(sum(amount_cents) filter (where type='void'),0) paid_orig,
  coalesce(sum(amount_cents) filter (where type='credit_apply'),0) credit_applied,
  coalesce(sum(amount_cents) filter (where type='refund' and status='done'),0) refunded,
  coalesce(sum(amount_cents) filter (where type='refund' and status='done' and dest<>'credit'),0) ref_orig,
  coalesce(sum(amount_cents) filter (where type='refund' and status='pending'),0) pending_amt,
  count(*) filter (where type='refund' and status='pending') pending_n,
  coalesce(sum(amount_cents) filter (where type='credit_issue'),0) issued
  from ledger_events group by 1),
b as (select i.id invoice_id, i.tax_bp, i.tip_cents, i.canceled_at,
  coalesce(it.items,0) items, coalesce(e.adj,0) adj,
  greatest(coalesce(it.items,0)+coalesce(e.adj,0),0) sub,
  coalesce(e.paid_orig,0) paid_orig, coalesce(e.credit_applied,0) credit_applied,
  coalesce(e.refunded,0) refunded, coalesce(e.ref_orig,0) ref_orig,
  coalesce(e.pending_amt,0) pending_amt, coalesce(e.pending_n,0) pending_n, coalesce(e.issued,0) issued
  from invoices i left join it on it.invoice_id=i.id left join e on e.invoice_id=i.id),
c as (select *, ((sub*tax_bp + 5000)/10000) tax from b),          -- half-up; sub >= 0
d as (select *, sub + tax + tip_cents total, paid_orig + credit_applied paid from c)
select invoice_id, items, adj, sub, tax, total, paid_orig, credit_applied, paid, refunded, ref_orig,
  pending_amt, pending_n, issued,
  case when canceled_at is not null then 0 else greatest(0, total - paid) end            balance,
  greatest(0, paid - refunded - pending_amt)                                              refundable,
  greatest(0, paid_orig - ref_orig)                                                       to_orig_max,
  items + adj - ((refunded*10000 + (10000+tax_bp)/2) / (10000+tax_bp))                   net,
  greatest(0, paid - refunded - total)                                                    overpaid,
  case
    when canceled_at is not null and paid=0 and refunded=0 then 'canceled'               -- fixes the design quirk
    when canceled_at is not null and refunded >= paid         then 'canceled_refunded'
    when refunded > 0 and refunded >= paid - 1                then 'refunded'            -- 1 cent
    when paid = 0                                             then 'unpaid'
    when (case when canceled_at is not null then 0 else greatest(0,total-paid) end) > 0 then 'partially_paid'
    when refunded > 0                                         then 'partially_refunded'
    else 'paid' end                                                                       status
from d;
```

- A TS twin, `calcInvoice(items, events, taxBp, tip, canceled)` in `payments/calc.ts`, is used by the by-item refund and adjust previews, and must equal the view. A test asserts equality over every seed invoice.
- `refund_pending` is `pending_n>0`. The display status becomes "Refund pending" (amber pill) per the design.
- Status labels: `paid` Paid, `unpaid` Unpaid, `partially_paid` Partially paid, `refunded` Refunded, `canceled_refunded` Canceled · refunded, `partially_refunded` Partially refunded, `canceled` Canceled (new, same pill style as Canceled · refunded).
- **Client store credit** is FIFO over lots. A lot is one `credit_issue` or one done `refund` with `dest='credit'`. Expired lots (`expires_at < now`) are excluded.
  - Lots are ordered by `expires_at nulls last, occurred_at`.
  - `credit_apply` consumption is allocated FIFO over the lot sequence. The available balance is the sum of the non-expired remaining of each lot.
  - This is implemented as the view `customer_credit_lots` with running-sum windows, plus `customer_credit_balance`.
  - **[DECISION: expiry]** The design never enforces expiry. We enforce it, with the clock starting at issue.
- **KPI summary** (service code, `payments/reports.ts`, all in cents):
  - `gross = Σ items`, `adj = Σ adj`, `refunds = Σ refunded`, `credits = Σ issued`, `outstanding = Σ balance`.
  - `net = gross + adj − divHalfUp(refunds*10000, 10000+tax_bp)`, rounded once on the aggregate.
  - Per-invoice `net` is rounded individually for the chart bars and CSV.
  - Counts: `invoices` (all in range), `refunded` (invoices with `refunded>0`), `adjusted` (`adj≠0`), `creditInvoices` (`issued>0`), `openBalances`.
  - **The design's "N clients" for credits is relabelled as distinct customers (a fix).**
  - Pending refunds are excluded from the refund count. Refund-to-credit and cash refunds are included.
- **Chart buckets** use `occurred_at` in the business tz (not payment time), as in the design.
  - Hourly 8a–5p for `today`, extended only if data falls outside, so rows are never silently dropped.
  - Daily otherwise.
  - Per bucket, `net = Σ per-invoice net` and `loss = Σ (refunded + max(0, −adj))`.
- **By method:** sum `pay` amounts by `method_kind` plus `credit_apply` into store credit. The response has five keys (`card, apple_pay, cash, store_credit, other`). The dashboard shows the fixed four rows and adds "Other" only when non-zero (a small addition, to flag).

### 3.10 Design entity to table map

| Design entity | Table(s) |
|---|---|
| cc appointment `a` | `appointments` plus customer, vehicle, add-ons, checklist items, photos, activity, invoice |
| `a.cust`, `a.veh` | `customers`, `vehicles` |
| `a.vip` | `vip_clients` |
| `a.member` | `memberships` plus `membership_plans` |
| `a.messages`, `a.log` | `messages` (thread by customer, optional `appointment_id`), `activity_log` |
| `a.checks` (label keys) | `job_checklist_items` (stable `source_task_id`) |
| `a.photos` counts | `appointment_photos` |
| `a.pay`, `a.deposit`, `a.tip` | Derived from `invoice_calc`; `invoices.tip_cents` |
| pay `tx` | `invoices` plus `invoice_items` plus `ledger_events` |
| pay `oasis-roles` | `roles`, `role_permissions`, `role_limits`, `employee_*` |
| `oasis-hours`, `oasis-closures`, `oasis-emergency`, `oasis-checklists`, `oasis-vip` | `business_hours`/`booking_rules`, `closures`, `emergency_closures`, `checklist_tasks`, `vip_*`/`arrival_settings` |
| `oasis-theme` | `user_preferences` |
| `staffNames` | `employees` where `bay_staff` |

---

## 4. Domain services and state machines

### 4.1 Appointment lifecycle

States: `booked → confirmed → arrived → cleaning → completed`, with terminals `canceled` and `no_show`. Every transition runs in one transaction that:

1. locks the appointment row,
2. validates the guard,
3. updates the row,
4. writes `activity_log`,
5. queues any message into `sms_outbox` (never sent inline),
6. writes `audit_log`,
7. publishes realtime events.

| Command | From → to | Guard and side effects | Perm |
|---|---|---|---|
| `confirm` | booked → confirmed | Queue template `confirmed` ("Your appointment is confirmed for {time}."). Activity: `Confirmation + reminder sent` (sms). The same command is triggered by an inbound "C" reply, standing-visit auto-confirm, and the unconfirmed alert's "Send reminder", which only re-sends the reminder (does not confirm). **Deviation:** the design's `Send reminder` confirms, which is confusing. | `sched.edit` or `jobs.status` |
| `arrive` | booked, confirmed → arrived | Sets `arrived_at`, clears `eta_minutes`. From a geofence: sets `geo_checked_in_at` and template `welcome` ("Welcome to Oasis! You're checked in — pull into Bay {bay}." with the bay segment omitted if none). Activity `Arrival logged` (internal) or `Auto check-in · geofence` (automation). | `jobs.status` or `sched.edit`; geofence ingest is system |
| `start` | arrived → cleaning | Choose the bay: the request `bayId`, else `planned_bay_id`, else the lowest-numbered free active bay. If none is free, 409 `BAY_BUSY` (title `Bay {n} is busy`, detail `Finish {FirstName}'s vehicle first`; if no bay at all, `NO_BAY_FREE`). Sets `bay_id`, `cleaning_started_at`. Template `in_progress`. **Fixes the design's missing bay guard.** | `jobs.status` |
| `assign-bay` (drag-drop) | booked, confirmed, arrived → cleaning | Same as `start` with an explicit bay. Implicitly arrives, logging both steps. Guards: not already cleaning (`Already in a bay` / `That vehicle is in Bay {n}`), the target bay is free, the appointment is dated today (new guard; the design lacks it), and the bay is active. | `jobs.status` |
| `complete` | cleaning → completed | Remaining checklist items are auto-checked (`done_by` = system, count logged). Sets `pickup_state='pending'`, `ready_notified_at`, `completed_at`. Queue template `ready`. Activity `Ready-for-pickup sent`. The DB frees the bay automatically (the occupancy index is status-scoped). | `jobs.status` |
| `collect` (pseudo-step) | completed, balance>0 | Delegates to the invoice command (4.3) with the default method. | `pay.collect` |
| `pickup` | completed: pending ⇄ collected | `Vehicle released to customer` or `Pickup reopened`. The release SMS is not sent (matches the design). Not blocked by payment (decision stays as designed). | `jobs.status` |
| `cancel` | booked, confirmed → canceled | Reason required. Optional `notify`. Deposit policy `keep` / `refund_card` / `refund_credit` (the refund creates a normal refund request using the actor's `pay.refund` and limit, so it may become pending). The invoice is flagged `canceled_at`. Frees capacity and fires the waitlist matcher. | `sched.cancel` |
| `no_show` | booked, confirmed → no_show | Only after start + grace. No automatic message. Membership credits are not auto-consumed. | `sched.cancel` |
| `reopen` | canceled, no_show → booked | Revalidates the slot (override rules apply). | `sched.cancel` |
| `reschedule` | booked, confirmed, arrived* → new start | Not cleaning or completed (`Can't move this job` / `It's already in progress or done`). Full slot validation (4.2), excluding itself, including the day. Updates the invoice date if not yet frozen, clears the late state, and queues template `reschedule`. | `sched.edit`; override needs `sched.override` |
| `prep-bay` | any with ETA | Sets `bay_prepped_at`. Activity `Bay {n} prepped for arrival`. Not reversible. No availability check, but warns if the planned bay is occupied. | `jobs.status` or `sched.edit` |
| `notify-ready` | completed | Re-sends the ready SMS. Sets `ready_notified_at`. | `msg.send` |

\* An arrived appointment can be reschedule-blocked in the UI, because `canDrag` is "not cleaning and not completed". Whether `arrived` jobs may move is a flagged default, kept as the design has it.

- **Late rule (computed, never stored):** `late = status in (booked, confirmed) AND now > scheduled_start + ops.late_grace_min` (default 10). It auto-clears on arrive or reschedule. A job `appointments.late_scan` every minute emits an alert-changed event and a one-time notification. An optional automatic `late_nudge` SMS is off by default.
- **Bay occupancy** is derived. A bay is occupied iff an appointment has `status='cleaning' AND bay_id=bay`. The bay card fields are:
  - `elapsed` from `cleaning_started_at`.
  - `pct = min(100, elapsedMin/duration*100)`.
  - **Est. completion = `cleaning_started_at + duration`** (fixes the design's scheduled-start-plus-duration bug), with a floor of `now` when overrunning.
  - `nextUp` = the first appointment with `planned_bay_id = bay`, not cleaning or completed, ordered by start.
  - Maintenance and blocked bays are supported by `bays.status`. Blocked bays count as zero capacity.

### 4.2 Availability and slot engine (`scheduling/availability.ts`)

```ts
type SlotState = 'available'|'blocked'|'vip_held'|'closed'|'past'|'cutoff'|'outside_window';
interface SlotQuery { date: string; serviceId: string; addonIds?: string[]; channel: 'desk'|'online';
  customerId?: string; isVip?: boolean; excludeAppointmentId?: string; now: Instant }
interface Slot { start: Instant; label: string; endsAt: Instant; state: SlotState; reason?: string;
  baysFree: number; overridable: boolean; releasesAt?: Instant; sameDayEligible?: boolean }
```

Algorithm:

1. **Day info** (also used by the calendar, and now closes today correctly):
   - A non-deleted `closures` row gives closed for `type=closed` (reason is the name), or the reduced window `[open_min, close_min]` (note `name · reduced hours`).
   - Else the weekly row: `!is_open` gives `Regular day off`.
   - An active emergency makes the dates `[today..through]` closed. `pause=true` also closes **online** booking even for hours not covered by closure rows.
2. **Candidate starts** every `slot_minutes` aligned from `open_min`, with `start ≤ close − cutoff_minutes`. **The cutoff applies to the start time.** If `allow_overrun` is true, the end may pass closing (the design's a11 does exactly this). Past starts today are `past`. The desk allows `start ≥ now`. Online adds `lead_min` of 30.
3. **Capacity** is count-based. Active bays N = non-maintenance bays.
   - Existing intervals for the day: every non-canceled, non-no-show appointment as `[start, start + duration + buffer)`. For a cleaning job, `[cleaning_started_at, max(started + duration, now) + buffer)`. For non-VIP callers, unreleased VIP holds count as virtual 1-bay intervals `[S, S + slot_minutes)`, unless a real VIP booking already sits at S (the real one counts).
   - A candidate `[c, c + d + buffer)` is available iff the sweep-line maximum concurrency of existing intervals clipped to it is ≤ N−1.
   - `bay_id` and `planned_bay_id` are not used in the count. Planned bay is advisory, because the design's fixtures already overlap within a bay.
4. **VIP hold:** a hold `(weekday, time_min)` applies to the slot starting exactly then. For a non-VIP caller, `state='vip_held'` while `now < S − release_hours`, with `releasesAt = S − release_hours`. VIP callers ignore holds. Release is computed at query time. The job `vip.hold_release_scan` only emits events and notifies the waitlist.
5. **Windows (online only):** VIP up to `window_vip_days`, others up to `window_std_days`. The desk ignores windows.
6. **Override and same-day guarantee:**
   - A `blocked` desk slot can be created with `override:{reason}`. The server requires an effective `sched.override` and a non-empty reason, writes `appointment_overrides` and audit, and rejects otherwise.
   - A closed day or a time outside reduced hours also needs `sched.override`. VIP-held also needs `sched.override` for non-VIP.
   - **Same-day guarantee:** a VIP booking today on a `blocked` slot is allowed without the permission while that VIP has used fewer than `same_day_per_month` guarantees in the business-tz calendar month. It records an override of kind `same_day_guarantee`.
7. **Booking guards:** `POST /appointments` recomputes the slot state inside the transaction under `pg_advisory_xact_lock(hash(location_id, biz_date))`. Failures:
   - `SLOT_UNAVAILABLE`: title `Slot unavailable`, detail `Would overbook a bay — override required`.
   - `SLOT_VIP_HELD`: title `Held for VIP clients`, detail `Releases to everyone {release}h before · VIP clients can book it now`. This uses the configured hours, replacing the hard-coded 48.
8. **Drag and reschedule** run the same check, excluding the appointment itself. **Drag-to-bay** checks only physical bay occupancy. **[DECISION: capacity on reschedule]**
9. Auto-planned bay: if `auto_plan_bay`, creation picks the active bay with the fewest overlapping planned intervals. This is why "Needs bay assignment" is rare.

### 4.3 Invoice and ledger commands (all in one tx, row-locked on the invoice, idempotent)

Common rules:

- The actor, effective roles and limits are resolved server-side. Each event stores the actor name, employee id and `actor_roles` (the role names that granted the permission), and the real actor when in view-as.
- Return `{event, invoice: {calc…}}`.

| Command | Rules (from pay-domain) |
|---|---|
| **Collect** `{method: card\|cash\|payment_link}` | Needs `pay.collect`. Collects the full balance (no partial; deposits arrive via links). `cash` creates a `pay` event. `card` creates a `pay` event with `processor_state='awaiting_processor'` (it counts, and is flagged complete in Squarespace; see 7.1). `payment_link` creates no ledger event, only a `payment_links` row and an SMS, matching the design. The cc "Mark Paid · $X" maps to `card` by default **[DECISION]**. The `method` label comes from `customer_card_hint` (`Visa ••4421`) else `Card`. |
| **Apply credit** | Needs `pay.collect`. `use = min(creditBalance, balance)`. 422 if either is 0. Creates a `credit_apply` event, consuming FIFO lots. |
| **Refund** `{mode: full\|items\|custom, itemIds?, amountCents?, dest, reason, note?}` | Needs `pay.refund`. `val`: full = `refundable`. Items = `min(refundable, divHalfUp(Σ selected item cents * 10700, 10000))`, tip excluded as in the design, and each item may not already be in a done or pending item refund (422; new validation). Custom = amount. 422 if `val<=0`, `val>refundable`, or `dest=card && val>to_orig_max`. Message `Only $<toOrigMax> was paid by card — refund the rest to store credit.` **Status is `pending` iff `val > actor.limit.refund` (strictly greater), else `done`.** A `done` card refund gets `processor_state='awaiting_processor'`. |
| **Approve** | Needs `pay.refund`, and `limit ≥ amount`. Self-approval is blocked unless the approver has an unlimited limit or `approvals.allow_self` is true **[DECISION]**. Revalidates `refundable` and `to_orig_max` excluding this pending event. Sets done, the approver fields, `resolved_at`, and `processor_state` for card. 409 if not pending. Error text: `Your role can't approve $X`. |
| **Deny** | Needs `pay.refund`. The requester can withdraw their own request. Sets `denied` (amount shown greyed). The design has no permission check here, which is a gap fixed by requiring `pay.refund`. |
| **Adjust** `{kind, unit $/%, value, reason, note?, settle?}` | Needs `pay.adjust`. 403 on a canceled invoice. `pre` = amount, or `divHalfUp(items*pctBp,10000)` for percent (percent applies to the `items` subtotal, not to existing adjustments or tip). `signed = ±pre`. `newSub = sub + signed` and must be ≥ 0. `over = pre > limit.adjust` is **blocked**, with text `Over your {limit} as {Role}. Ask Management or a Super Admin.` The settlement refund is auto-created (`done`, `reason 'Adjustment settlement'`, bypasses limits) when `diff = paid − refunded − newTotal > 0 && paid>0`. `newTotal` here uses the same half-up tax as the view, which resolves the design's one-cent difference (A9). |
| **Issue credit** `{amountCents, reason, note?, expiry}` | Needs `pay.credit`. `over = amount > limit.credit` is blocked. Stores `expires_at` (end of business day in the business tz, plus 30 or 90 days). |
| **Void** | Needs `pay.void` (no design UI; this maps to cc's "Mark unpaid"). Allowed only for a `pay` event that is cash or card still `awaiting_processor`, because confirmed card money must be refunded. Appends a `void` event. The dashboard must render the `void` type, a small addition to flag. |
| **Tip** `PUT /invoices/:id/tip` | Needs `pay.collect`. Untaxed. |
| **Receipt** | Queues SMS and SES email, honoring SMS opt-out (email only if opted out). Writes an audit event and activity (not a ledger event). |
| **Confirm processor** | Staff confirms an `awaiting_processor` event. Sets `confirmed`. Needs the same permission as the original action (`pay.collect` or `pay.refund`). |

**Limit resolution** (`platform/rbac.ts`, mirrors Settings `eff()`):

```ts
// per request: effective(userId) cached by (employeeId, rbacVersion)
function effective(perm, roles, overrides) {
  const granting = roles.filter(r => r.perms.has(perm));
  const limitKind = LIMITED[perm];              // refund|adjust|credit or undefined
  const lims = limitKind ? granting.map(r => r.limit(limitKind)) : []; // r.limit: row null => null, no row => 2500
  const limit = !limitKind ? undefined
              : lims.length ? (lims.includes(null) ? null : Math.max(...lims)) : 2500;
  if (overrides[perm]==='deny') return { on:false };
  if (overrides[perm]==='allow') return { on:true, limit };  // allow with no granting roles => 2500 default
  return granting.length ? { on:true, limit, via: granting.map(r=>r.name) } : { on:false };
}
```

### 4.4 Alerts ("Needs attention") (`scheduling/alerts.ts`)

Computed on read, with the real clock, and returned as structured data: `{key, kind, tone, appointmentId, priority, params, action}`. The dashboard maps `kind` to copy, using the design's strings (WhatsApp becomes SMS). Order is generation order, then a **stable sort** by `priority` desc, where `priority=1` for a VIP appointment. Arrival-type alerts are boosted only if `arrival_settings.vip_first`.

| # | Kind | Condition (today's rows unless noted) | Action |
|---|---|---|---|
| 1 | `ready_for_pickup` | completed and `pickup_state != collected`; `paymentDue` if balance>0 | Mark picked up |
| 2 | `running_late` | late rule (4.1) | Message customer (sends template `late_nudge`) |
| 3 | `needs_bay` | status booked/confirmed/arrived, dated today, `planned_bay_id` null (was "any non-completed", which flagged every future job) | Assign bay |
| 4 | `arriving_soon` | confirmed, no ETA, `0 < start − now ≤ prep_at_min` | Prep bay |
| 5 | `unconfirmed` | booked | Send reminder (does not confirm) |
| 6 | `special_instructions` | `special_instructions` set (the ellipsis only when truncated) | View file |
| 7 | `arriving_eta` | ETA set, status booked/confirmed, `eta ≤ ops.eta_visible_max_min` (30). VIP uses the VIP wording. | Prep bay or `Bay ready ✓` |
| 8 | `auto_checked_in` | `geo_checked_in_at` set and status arrived | Start cleaning |
| 8b | `confirm_checkin` | geo check-in but `auto_arrive` is off (new) | Mark arrived |
| 9 | `member_credit` | The first completed, unpaid appointment whose membership has an unused eligible credit (a real check, which fixes the exact-string `Premium` bug) | Apply credit |
| 10 | `new_reply` | Unread inbound SMS linked to an active appointment (new) | Open |
| 11 | `sms_device_down` | Device offline (new, manager role) | Open health |
| 12 | `awaiting_processor` / `unmatched_order` | Card events older than 24h not confirmed; Squarespace orders unmatched | Open |

### 4.5 KPI queries (every number computed, `scheduling/kpis.ts`)

The window for the "24h" scope is **today plus tomorrow in the business tz**, which is the design's "Next 24h" semantics **[DECISION]**. KPIs ignore search and range, as in the design.

| KPI | Value | Sub |
|---|---|---|
| Appointments 24h | Non-canceled, non-no-show appointments in the window | `{n} booked` where n = status in (booked, confirmed) (replaces the hard-coded `12 booked`) |
| Active jobs | `status='cleaning'` | `in bays` |
| Ready for pickup | completed with `pickup_state != 'collected'` | `notify` if >0 else `clear` |
| Pending payments | Today's appointments with invoice `balance>0` and not canceled/no-show | `money(Σ balance)` |
| Bay time free | `max(0, Σ_active_bays remainingOpenMin − Σ remaining committed minutes)` (see below) | `today` |
| Members today | Today's appointments with an active membership | `of {today count}` |
| Revenue today | `Σ over invoices with biz_date=today of max(0, paid − refunded)` (collected, incl. tip and tax) | `paid` |

Bay time free: `remainingOpenMin = max(0, close − max(now, open))` per active bay (0 if closed today). Committed minutes = Σ over today's booked, confirmed, arrived and cleaning jobs of `clamp(end + buffer − max(start, now), 0, …)`; for a cleaning job, `end = max(cleaning_started_at + duration, now)`. The value is shown as `Math.round(min/6)/10 + 'h'`. Because these now come from the same invoice calc, cc Pending payments and pay Outstanding reconcile for the today range.

### 4.6 Membership logic (Squarespace-driven)

- **Plan mapping:** `sqsp_products.mapped_plan_id` (admin maps each subscription product to Essential/Premium/Executive/Exotic; "Premium Care" is a Premium product with `plan_label='Premium Care'`).
- **Ingest** (from the Orders sync): a subscription order with a mapped product upserts `memberships`:
  - `status='active'` when the order is paid and not fully refunded.
  - `current_period_start = order.createdOn`, `current_period_end = +billing_interval_months`.
  - The renewal date shown is `current_period_end`.
  - A customer is matched or created via the profile email and phone.
- **Status transitions:**
  - `past_due` if no renewal order by `period_end + 3 days`.
  - `canceled` on a full refund, or by a manual `PATCH` (the API may not expose subscription cancels; see the gap list).
  - `paused` is manual.
- **Credits:** at each cycle (job `membership.cycle`) `plan_credit_rules` generate `grant` events per rule (`per_cycle null` means unlimited, shown as ∞).
  - `creditsLeft` = grants − redeems for the current cycle, and `creditsUsed` likewise.
  - `redeem` is an explicit command `POST /appointments/:id/membership-perks/apply`, which creates a system `adjust` event (reason `Membership credit`, limit-exempt) equal to the package line. Because adjustments are pre-tax, tax falls too, as in the design's never-applied `credit`.
  - Percent perks (`addon_discount_bp`, `service_discount_bp`) apply as a system `adjust` on the matching lines.
  - **[DECISION: auto-apply]** `memberships.auto_apply` defaults to false.
- **Retention:** compare completed visits in the last 30 days (cur) and the 30 days before (prev). Loyal if `cur ≥ 1 && cur ≥ prev` (`Loyal · low risk` / `Consistent monthly usage — strong retention`). Else `Watch · {max(1,prev−cur)} missed visit(s)` with `Down from {prev} to {cur} visit(s) last month`.
- **Upgrade candidate** (non-member): at least 3 completed visits in the last 60 days. The copy uses the real number. **[DECISION: thresholds]**
- **History stats:** `visitCount` = completed appointments. `lifetimeSpend` = Σ collected over the customer's invoices. `avgFreq` = mean days between completed visits (`—` if fewer than 2). `fav` marks the customer's most-used package.
- **Emergency "protect credits":** for each affected appointment with a reserved or redeemed credit, a `restore` event is written (kind `protect`), and no missed-visit or retention penalty is recorded.

### 4.7 Emergency closure (`settings/emergency.ts`)

`POST /emergency/close` (needs `set.emergency`, idempotent) runs in one transaction:

1. Reject if an emergency is already active.
2. Compute `ends_at`. `today` is today's closing time. `until` is today at `until_min`, which must be after now. `days` is the closing time of `through_date`.
3. **Affected** = non-arrived, non-canceled appointments (booked or confirmed) with a start inside the window:
   - `today` = start in today ≥ day start.
   - `until` = start < until today.
   - `days` = start date in [today, through] (this fixes the design gap).
   - Late bookings earlier today that have not arrived are included (as the design's Marcus Webb at 10:15 is).
   - Vehicles already on site are reported separately and are not touched.
4. Create the `emergency_closures` row and `closures` rows with `source='emergency'`: `closed` for each full date, or `reduced` with the open window for `until`/`today`. These upsert over an existing planned closure, remembering the replaced one for restore.
5. `pause` makes online booking return closed immediately (checked at query time from the active row).
6. For each affected appointment: mark `emergency_closure_id`, create a reschedule link if `link`, and render the message. The variables are `{first} {reason} {until} {link}`. **If `link` is off, the sentence containing `{link}` is stripped** (resolves Q6). Reason text: `severe weather`, `a power outage`, `an equipment failure`, `a staffing issue`, `unforeseen circumstances`. `untilText`: `for the rest of today`, `until {time} today`, or `through {weekday, Mon D}`.
7. Queue SMS at priority 0 (throttled). Opted-out or no-phone customers are recorded as `skipped_opt_out` or `no_contact`, and fall back to email if one exists.
8. `credits` restores reserved credits (4.6). `crew` creates notifications for on-shift employees (schedule includes now, active, with a user) plus an SSE `emergency.started`.
9. Return `{summary, notifiedCount, skipped, affected[]}`. The summary is `{reason} · closed {untilText}{ · online booking paused}`. Counters: **notified** = real queued or sent, **rebooked** = real count from reschedule links used, **booking** = Paused or Open.

`POST /emergency/reopen` sets `reopened_*`, deletes the future or today emergency closure rows (restoring any replaced rows), and writes the history detail `Reopened by {user} · {n} notified` using the real count. Booking resumes. `emergency.auto_reopen` is scheduled at `ends_at` with a backstop `emergency.sweep`. Customers who did not rebook stay as `emergency_closure_id`-flagged appointments in the "needs rebooking" queue (`GET /emergency/:id/affected`). They are not auto-canceled.

`GET /emergency` returns the banner state (visible to any authenticated user) and the idle strip data computed live: open or closed, today's hours, appointments remaining, and vehicles on site. It also returns `canClose` (true if the caller has `set.emergency`) and `closeRoleNames`, so the static "Requires Management or Super Admin" copy becomes dynamic.

### 4.8 Closures, hours and federal holidays

- `POST /closures/preview` and the list return a **real** affected count. For `closed`, count non-canceled appointments that day. For `reduced`, count those outside the reduced window.
- `POST /closures` validates a date and a trimmed name, enforces date uniqueness, then (if `notify`) messages the affected customers with a reschedule link. Errors use the design's strings (`Add a date and a name.`, `There's already a closure on that date.`).
- `PATCH /closures/:id` also allows editing `type/from/to/name` (resolves Q2, how Labor Day became reduced).
- Federal holidays: the job `federal_holidays.generate` runs yearly on Jan 1, on enabling the toggle (current and next year), and at startup for catch-up. It inserts missing rows with `source='federal'` and a unique `federal_key`, so a deleted holiday stays deleted. Dates use the **actual date with no weekend observed-shift** (matches the design's Jul 4 on Saturday). **[DECISION: which holidays]** The default is all 11 US federal holidays, with Christmas Eve remaining a manual entry.
- `PUT /settings/hours` saves hours and rules together with the `version`, and returns warnings: `employeeScheduleConflicts[]` and `appointmentsOutsideHours[]`. It does not auto-move anything.
- Employee schedule validation on save is a **hard 422**: `{Day}: availability must sit inside business hours ({from} – {to}).`

### 4.9 Other domain services

- **Checklist generation:** at booking, snapshot the package's active tasks as the package section. On add-on add, append the add-on section (an add-on with no tasks yields one task equal to its name). On add-on removal, set `removed_at` (kept and restored on re-add). **Template edits propagate only to jobs not yet started** (booked, confirmed, arrived) via `ChecklistSync`, matching by `source_task_id` (rename, add, remove if not done). Jobs in cleaning or completed are never touched.
- **Add-on mutability:** allowed on any status. If the invoice already has payments, removing an item that would make `paid_orig + credit_applied > new total` is a 409 `ADDON_REMOVE_OVERPAID` (refund or adjust instead). Adding after payment simply re-opens a balance. The price is always taken from the catalog on the server. The toast direction bug is fixed because the server returns `added: boolean`.
- **Waitlist (P2):** on cancel or no-show, find waiting entries whose window matches. VIPs get an offer first for `offer_minutes`, via SMS with a reschedule-style link. After expiry (`waitlist.offer_expiry`), offer to everyone.
- **Standing appointments (P2):** tables, settings plumbing and the job `standing.materialize` (creates occurrences 4 weeks ahead per cadence) plus `standing.autoconfirm` (confirms at 48h without a reply when `auto_confirm`). The materializer ships behind a feature flag. The designs only have Settings toggles, so no dashboard UI is required yet. **[DECISION: scope]**
- **Arrival and geofence ingest** (contract now, customer app later): `POST /arrivals/ping` `{appointmentId, lat, lng, accuracy, etaMinutes?}` authenticated by a per-appointment arrival token (a `/a/<token>` link in the confirmation SMS).
  - The server computes the haversine distance to the location coordinates. ETA falls back to `distance / 25 km/h` if the client gives none.
  - It stores `eta_minutes`. When ETA first crosses `prep_at_min`, it sends a crew notification and SSE `arrival.eta`.
  - When `distance ≤ radius_m` and `enabled`: if `auto_arrive`, run `arrive` (source geofence, with the welcome SMS if `welcome`). Otherwise set `geo_checked_in_at` and raise alert 8b.
  - **Background geofencing is not possible from an SMS link page**, so true geofence needs the later customer app.
- **Photos:** flow in 7.4.

---

## 5. API surface

Base `/api/v1`. All routes need an authenticated session unless noted. Money fields are cents. Times are ISO. "Perm" lists the effective permission or any-of. `H` = needs `Idempotency-Key`. `S` = also publishes realtime.

### 5.1 Auth, Me, Meta

| Verb path | Perm | Request → response |
|---|---|---|
| `POST /auth/login` | public (rate-limited 5/min per IP+email) | `{email,password}` → sets session cookie, `{user, csrfToken}` |
| `POST /auth/logout` | auth | revokes the session |
| `GET /auth/csrf` | auth | `{csrfToken}` |
| `POST /auth/invite/accept` | public (token) | `{token,password}` → activates the user and employee |
| `POST /auth/password/forgot` / `/reset` / `/change` | public / token / auth | standard; forgot always returns 202 |
| `GET /me` | auth | `{employee, roles, displayRole, permissions:{key:{on,limit?}}, limits, rbacVersion, preferences, viewAs}` |
| `PUT /me/preferences` | auth | `{theme}` (replaces the localStorage key) |
| `POST /me/view-as` | the real user holds the locked Super role | `{roleId\|null}`; sets or clears `sessions.view_as_role_id` |
| `GET /meta/now` | auth | `{now, tz, bizDate, weekday, minutes, dateLabel}` |
| `GET /events` | auth (SSE) | `?channels=ops,payments,settings,messages,notifications`, `Last-Event-ID` replay, 20 s heartbeat; each channel is permission-checked |
| `GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all` | auth | the bell data |

### 5.2 Settings

| Verb path | Perm | Notes |
|---|---|---|
| `GET /settings/hours` | auth | `{days:[{weekday,open,from,to}], rules:{slot,buffer,cutoff}, weekHours, version}` |
| `PUT /settings/hours` | `set.hours` | Saves hours and rules, with `version` and warnings S |
| `GET /closures?from=&to=` | auth | Items include `affectedCount`, `type`, `source`, `notify` |
| `POST /closures/preview` | `set.hours` | `{date,type,from?,to?}` → `{affected}` |
| `POST /closures` | `set.hours` | Creates, notifies affected, S |
| `PATCH /closures/:id` | `set.hours` | `{notify?,name?,type?,from?,to?}` |
| `DELETE /closures/:id` | `set.hours` | Soft delete |
| `PUT /settings/auto-federal-holidays` | `set.hours` | `{enabled}` and generates on enable |
| `GET /emergency` | auth | Banner and idle-strip data (4.7) |
| `GET /emergency/preview` | `set.emergency` | `?reason&dur&until&through` → `{affected[], count, renderedMessage}` |
| `POST /emergency/close` | `set.emergency` | H S. Described in 4.7 |
| `POST /emergency/reopen` | `set.emergency` | S |
| `GET /emergency/history`, `GET /emergency/:id/affected` | `set.emergency` | |
| `GET /employees?q=&role=` | `team.view` | Search: first, last, phone, title, role name (not email, matching the design) |
| `GET /employees/:id` | `team.view` | Includes schedule, overrides and effective permissions |
| `POST /employees` | `team.edit` (`team.roles` if roles or overrides are set) | Creates as `invited`, sends the invite (SMS, email fallback) |
| `PUT /employees/:id` | `team.edit` (+ `team.roles` for roles and overrides) | `If-Match` |
| `POST /employees/:id/deactivate` / `reactivate` | `team.edit` | Reactivate restores `invited` if never accepted (fixes Q17) |
| `POST /employees/:id/invite/resend` | `team.edit` | |
| `GET /employees/:id/effective-permissions` | `team.view` | Per-key `{on, src, ov, limit}` |
| `GET /roles` | `team.view` | Roles, permission catalog, matrix, limits, people counts |
| `POST /roles` | `team.roles` | `{name?,description?}`. Default name `Shift Lead` (uniquified). Copies Crew plus `sched.edit`, limits 25/25/25. |
| `PATCH /roles/:id` | `team.roles` | Rename or describe (fixes Q9). Rejected for locked roles. |
| `PUT /roles/:id/permissions/:key` | `team.roles` | `{granted}`. Locked roles are rejected. Bumps `rbac_version`, S `rbac.changed`. |
| `PUT /roles/:id/limits/:kind` | `team.roles` | `{value: 25\|50\|100\|250\|500\|1000\|null}` |
| `DELETE /roles/:id` | `team.roles` | Custom only. Strips the role from employees. Any employee left with no role is assigned `crew`. Returns the affected count. |
| `GET /vip` | auth | Settings, holds and counts |
| `PUT /vip` | `cli.member` | `{release, windowVip, windowStd, sameDay, waitlist, standing, autoConfirm, offerMin, cadences}` |
| `POST /vip/holds`, `DELETE /vip/holds/:id` | `cli.member` | Duplicate returns 409 `That slot is already held` |
| `GET /vip/clients`, `POST /vip/clients`, `DELETE /vip/clients/:customerId` | `cli.member` | POST accepts `{customerId}` or `{name}`. The name resolves to an exact case-insensitive match, else creates a stub customer. If there are several matches, the most recent is used and an audit note is written. |
| `GET /arrival-settings`, `PUT /arrival-settings` | auth / `cli.member` | |
| `GET /services` | auth | Packages and add-ons with tasks (ids) |
| `PUT /services/:id/checklist` | `set.services` | `{tasks:[{id?,label}]}` ordered, trimmed, empty dropped → tasks with ids. Triggers `ChecklistSync`. This unifies the design's package and add-on PUTs. |
| `POST /services`, `PATCH /services/:id` | `set.services` | Price, duration, name, `bookable_desk`, `active`. No UI yet. |
| `GET/PUT /settings/business` | `set.billing` | Tax rate, tz, name (no UI) |
| `GET/PUT /membership-plans` | `set.billing` | |

### 5.3 Operations

| Verb path | Perm | Notes |
|---|---|---|
| `GET /ops/snapshot?window=next24\|today\|tomorrow\|week&q=` | `sched.view` | One call for the board: `{now, kpis[], appointments[] (cards), bays[], arrivals[], alerts[], emergency}`. Search `q` applies to the list, not KPIs, bays or alerts. |
| `GET /ops/kpis`, `GET /ops/alerts` | `sched.view` | |
| `GET /calendar/summary?from&to` | `sched.view` | Per date: `{date, count, closed?:reason, reduced?, open:{from,to}}`. Real counts, so today closes correctly. |
| `GET /calendar/day?date` | `sched.view` | `dayInfo`, appointments, and `outsideHours[]` so nothing is silently dropped |
| `GET /appointments` | `sched.view` | `?from&to&status&customerId&q&cursor` |
| `GET /appointments/:id` | `sched.view` (+ `cli.view`) | The file: overview, add-ons with catalog, checklist sections, photos with presigned thumbs, messages, activity, invoice summary, membership, history. Phone and email masked without `cli.contact`. |
| `POST /appointments` | `sched.edit` | H S. `{customer:{name,phone,smsOptIn,id?}, vehicle:{year,make,model,color,plate}, serviceId, addonIds?, start (or walkIn:true → start=now), source, override?:{reason}, depositCents?}`. Upserts the customer by phone and the vehicle by plate, creates the invoice, snapshots the checklist, auto-plans a bay, queues the booking-thanks SMS, and creates a deposit link if requested. |
| `PATCH /appointments/:id` | `sched.edit` | `{plannedBayId?, assignedEmployeeId?, notes?, specialInstructions?}` |
| `POST /appointments/:id/{confirm,arrive,start,assign-bay,complete,advance,cancel,no-show,reopen,reschedule,prep-bay,pickup,notify-ready}` | See 4.1 | `advance` is the convenience wrapper over the next valid step (the design's single button). `assign-bay {bayId}`, `reschedule {start, override?}`, `cancel {reason, notify, deposit}`, `pickup {state}`. S |
| `PUT /appointments/:id/addons/:serviceId` / `DELETE` | `sched.edit` | Returns `{added, invoice}` |
| `PUT /appointments/:id/checklist/items/:itemId` | `jobs.checklist` | `{done}`, `done_by` recorded |
| `POST /appointments/:id/checklist/bulk` | `jobs.checklist` | `{itemIds, done}`; the global "check all" is the full id list |
| `POST /appointments/:id/photos/presign`, `.../:photoId/complete`, `DELETE .../:photoId`, `POST .../photos/note` | `jobs.checklist` | See 7.4 |
| `GET /appointments/:id/messages` | `cli.view` | |
| `POST /appointments/:id/messages` | `msg.send` | `{text}` or `{templateKey}`. Free text goes out as SMS. 422 if the customer is opted out. Internal notes use `channel:'internal'`. S |
| `GET /appointments/:id/invoice` | `sched.view` plus any `pay.*` | Compact calc and ledger lines (the Payments tab, and how Support acts without `pay.reports`) |
| `POST /appointments/:id/membership-perks/apply` | `cli.member` | `{credit?:bool, discounts?:bool}` |
| `GET /availability` | `sched.view` | See 4.2 |
| `GET /bays`, `PATCH /bays/:id` | `sched.view` / `sched.override` | Bay status (maintenance) |
| `GET /staff` | `sched.view` | Assignable employees (`bay_staff`), plus the Unassigned pseudo-column |
| `GET /customers?q=`, `GET /customers/:id`, `POST /customers`, `PATCH /customers/:id` | `cli.view` / `cli.view` / `sched.edit` / `cli.edit` | Contact fields masked without `cli.contact` |
| `GET /customers/:id/{vehicles,messages,credit,membership}` | `cli.view` (credit: `pay.reports` or `pay.collect`) | |
| `GET /customers/export.csv` | `cli.export` | |
| `GET /memberships`, `PATCH /memberships/:id` | `cli.member` | |
| `POST /arrivals/ping` | arrival token | See 4.9 |
| `POST /waitlist`, `GET /waitlist`, `DELETE /waitlist/:id` (P2) | `sched.edit` | |
| `POST /dev/appointments/:id/simulate-arrival` | dev only | Demo equivalent of the geofence event |

### 5.4 Payments

| Verb path | Perm | Notes |
|---|---|---|
| `GET /payments/summary?range=today\|7d\|30d\|mtd` | `pay.reports` | KPIs, counts, chart buckets, `byMethod`, `filterCounts`, `pendingApprovals{count, first, all[]}`. Ranges are inclusive calendar days ending today in the business tz, with labels (`Saturday, June 13`, `Jun 7 – Jun 13`, …). |
| `GET /payments/invoices?range&filter&q&cursor&limit` | `pay.reports` | Sort `biz_date desc, invoice_no desc`. Filters: all, `unpaid` (balance>0), `refunds` (refunded>0 or pending), `adjusted`, `credits` (issued>0 or credit applied). Search over invoice id, client, vehicle and item names. |
| `GET /invoices/:id` | `pay.reports` | Items, adjust lines, the full calc, ledger newest first with `atLabel`, `clientCredit`, and per-event `canApprove` for the caller |
| `GET /payments/approvals?status=pending` | `pay.reports` | |
| `GET /payments/export.csv?range&filter&q` | `pay.reports` | Spec in 5.7 |
| `GET /payments/ledger.csv` | `pay.reports` | One row per event |
| `POST /invoices/:id/payments` | `pay.collect` | H S |
| `POST /invoices/:id/credit-applications` | `pay.collect` | H S |
| `POST /invoices/:id/refunds` | `pay.refund` | H S |
| `POST /invoices/:id/refunds/:eventId/approve` and `/deny` | `pay.refund` | H S |
| `POST /invoices/:id/adjustments` | `pay.adjust` | H S |
| `POST /invoices/:id/credits` | `pay.credit` | H S |
| `POST /invoices/:id/void` | `pay.void` | H S. `{eventId}` |
| `PUT /invoices/:id/tip` | `pay.collect` | |
| `POST /invoices/:id/receipt` | `msg.send` or `pay.collect` | SMS and email |
| `POST /invoices/:id/payment-links` | `pay.collect` | `{kind:'balance'\|'deposit', amountCents?, url?}`; see 7.1 |
| `POST /ledger-events/:id/confirm-processor` | the original action's perm | |
| `GET /payments/reconciliation` | `pay.reports` or `set.billing` | `awaitingProcessor[]`, `unmatchedOrders[]`, `unmatchedTransactions[]`, `overpaid[]` |
| `POST /integrations/squarespace/orders/:id/match` / `ignore` | `pay.collect` | |

### 5.5 Messaging

| Verb path | Perm | Notes |
|---|---|---|
| `GET /messages/templates` | `msg.send` | Quick replies and automations |
| `PUT /messages/templates/:key` | `msg.auto` | Edit body and enabled |
| `POST /messages/broadcast` (P2) | `msg.broadcast` | Honors opt-outs |
| `GET /messages/outbox?state=failed`, `POST /messages/:id/retry`, `POST /messages/:id/cancel` | `msg.send` | |
| `POST /hooks/smsgate/:deviceKey` | HMAC (no session) | Tailnet listener only |
| `GET/POST/PATCH /integrations/sms/devices`, `POST .../:id/test`, `POST .../:id/register-webhooks`, `GET .../:id/health` | `set.billing` | Device admin; also feeds the device-health alert |

### 5.6 Integrations, public and ops

| Verb path | Perm | Notes |
|---|---|---|
| `POST /hooks/squarespace` | `Squarespace-Signature` HMAC | Public listener |
| `POST /hooks/ses` | SNS signature verification | Bounces and complaints |
| `GET /integrations/squarespace/status`, `POST .../connect`, `GET .../oauth/callback`, `POST .../sync-now`, `GET .../products`, `PUT .../product-map`, `POST .../webhooks/register`, `GET .../orders?state=unmatched` | `set.billing` | |
| `GET /public/reschedule/:code`, `POST /public/reschedule/:code` | token, rate-limited 20/min | Contract for the later customer site: summary and slots, then move or rebook. Marks the emergency notification rebooked. |
| `GET /public/availability?date&serviceId` | public, rate-limited | Contract only (online channel). VIP detection awaits customer identity. |
| `GET /healthz`, `GET /readyz` | none | DB, jobs, and integration status in `/readyz`; `/metrics` internal |
| `GET /ops/integrations/health` | `set.billing` | SMS device, Squarespace sync lag, SES, S3 |
| `POST /dev/seed {profile}`, `POST /dev/clock {freeze}`, `POST /dev/squarespace/inject`, `POST /dev/sms/inbound`, `GET /dev/mail` | dev flag **and** Super | Disabled unless `ALLOW_DEV_ENDPOINTS=true` |

### 5.7 Realtime

SSE channels and events. Payloads are ids plus a `version`, and the client refetches the affected resource (except messages, which carry a full payload).

- `ops` (needs `sched.view`): `appointment.created|updated|status_changed|moved`, `bay.changed`, `arrival.eta`, `arrival.checked_in`, `alerts.changed`, `kpi.dirty`, `availability.changed`, `photo.added`, `emergency.started|reopened`.
- `payments` (needs `pay.reports`): `invoice.updated`, `ledger.event`, `refund.pending|resolved`, `squarespace.order_synced`.
- `messages` (needs `cli.view`): `message.in|out|status`.
- `settings` (any): `settings.changed{section}`, `rbac.changed` (forces a `/me` refresh).
- `notifications` (self): `notification.new`, `sms.device.health`.

**CSV spec:**

- UTF-8 with BOM, CRLF, RFC 4180 quoting. Money is plain decimals with no `$`. Dates are business-tz ISO local. Text cells starting with `= + - @` are prefixed with `'` to prevent formula injection (numeric columns are exempt).
- Filename `oasis-invoices_{from}_{to}.csv`.
- Scope is the range **and** the active filter and search. This is a flagged improvement, since the design's toast count ignored filter and search.
- Columns: `Invoice, Date, Time, Client, Vehicle, Staff, Items, Tip, Adjustments, Subtotal, Tax, Total, Paid, Credit applied, Refunded, Refund pending, Balance, Credits issued, Net revenue, Status`.
- Large exports above 20,000 rows go through `export_jobs` (P2).

---

## 6. Permission enforcement and security

### 6.1 Permission matrix (27 keys)

| Key | Gates | Default roles |
|---|---|---|
| `sched.view` | All Operations reads, availability, calendar, bays, staff, appointment file | super, mgmt, acct, support, crew |
| `sched.edit` | Create or edit appointments, add-ons, reschedule, confirm, arrive, prep-bay | super, mgmt, support |
| `sched.cancel` | Cancel, no-show, reopen | super, mgmt, support |
| `sched.override` | Slot, hours and closure overrides, bay maintenance | super, mgmt (Sofia via exception) |
| `jobs.status` | start, assign-bay, complete, pickup, arrive, confirm, prep-bay | super, mgmt, crew |
| `jobs.checklist` | Checklist toggles, photos | super, mgmt, crew |
| `cli.view` | Customer, vehicle, message and history reads | all five |
| `cli.contact` | Unmasks phone and email | super, mgmt, acct, support |
| `cli.edit` | Edit customer, vehicle, opt-in | super, mgmt, support |
| `cli.export` | Customer CSV | super, mgmt, acct |
| `cli.member` | Memberships, membership perks, VIP and arrival settings | super, mgmt, acct, support |
| `pay.collect` | Collect, apply credit, tip, payment link, receipt, confirm processor (collect) | super, mgmt, acct, support |
| `pay.refund` (limit) | Refund request, approve, deny | same |
| `pay.adjust` (limit) | Adjust | same |
| `pay.credit` (limit) | Issue credit | same |
| `pay.void` | Void | super, mgmt, acct |
| `pay.reports` | All Payments reads and CSV | super, mgmt, acct |
| `msg.send` | Send messages, outbox retry, receipt | super, mgmt, support |
| `msg.auto` | Edit templates and automations | super, mgmt |
| `msg.broadcast` | Broadcast (P2) | super, mgmt |
| `team.view` | Employee and role reads | super, mgmt, acct, support |
| `team.edit` | Employee create, edit, deactivate | super, mgmt |
| `team.roles` | Roles, matrix, limits, employee roles and overrides | super, mgmt |
| `set.hours` | Hours, rules, closures, federal toggle | super, mgmt |
| `set.emergency` | Emergency close, reopen, history | super, mgmt |
| `set.services` | Services, pricing, checklists | super, mgmt |
| `set.billing` | Integrations (Squarespace, SMS devices), plan mapping, business settings | super, acct |

The default role grants are exactly those in set-domain (mgmt is all except `set.billing`). The table shows only the main gate, and 5.x lists any-of cases.

### 6.2 Resolution and view-as

- Fastify `preHandler` `requirePerm('x'|[any-of])` reads the cached effective set. The cache key is `(employee_id, rbacVersion)`. The `rbacVersion` is bumped by any role, limit, override or employee-role change, and an SSE `rbac.changed` forces clients to refresh `/me`.
- **View-as:** if `sessions.view_as_role_id` is set, effective permissions and limits come from **only that role** (no per-person exceptions), mirroring "Preview as". It is permitted only when the real user holds the locked Super role. Writes are allowed, because the Payments design needs them to demonstrate the approval flow, and cannot escalate beyond Super. Ledger and audit rows record both the real actor and the viewed role. The dashboard shows a persistent banner.
- Side-effecting authorization is re-checked server-side. Read models mask `phone`/`email` without `cli.contact`.

### 6.3 Security

- **Sessions:** an opaque 256-bit token in a `HttpOnly; Secure; SameSite=Lax; Path=/` cookie (`__Host-` prefixed in production). Server-side rows with an idle expiry of 12h and an absolute expiry of 14d. Login rotates the session id. A password change revokes all other sessions.
- **CSRF:** Origin and Referer check on all unsafe methods plus a synchronizer token in `X-CSRF-Token` (from `GET /auth/csrf`), tied to the session. Webhook routes are exempt but signed.
- **Brute force:** login is rate-limited 5/min per IP+email. After 10 failures the account is locked for 15 min (counter in `users`). Responses are generic.
- **Rate limits:** a global default of 300/min per user, a stricter limit on `/public/*`, and none on the signed webhooks beyond a body size cap (1 MB).
- **Webhooks:** raw-body capture, timing-safe HMAC compare, and `webhook_log` unique `(provider, external_id)` for idempotency. Replays are rejected by dedupe.
- **Secrets:** env file `/etc/oasis/backend.env` (mode 600). Integration credentials in the DB (`password_enc`, tokens, webhook secrets) are AES-256-GCM encrypted with `SECRETS_KEY` (key-id prefixed for rotation). Pino redaction. No secrets in OpenAPI or responses.
- **Other:** `helmet` headers, strict JSON body limit, zod `.strict()` bodies, SQL only through Kysely parameters, S3 bucket with block-public-access, presigned URLs of at most 10 minutes. Audit on all permission and role changes.

---

## 7. Integration adapters

Each integration is a **port with a real adapter and a simulator**, chosen by env (`*_DRIVER`). Contract tests run against the simulator, and opt-in tests run against the real service.

### 7.1 Squarespace (payments and memberships)

**Port:**

```ts
interface SquarespaceSource {                    // read-only
  listOrders(p:{modifiedAfter:Date, modifiedBefore?:Date, cursor?:string}): Page<SqspOrder>;
  getOrder(id:string): SqspOrder;
  listTransactions(p:{modifiedAfter:Date, modifiedBefore?:Date, cursor?:string}): Page<SqspTransaction>;
  listProfiles(p:{cursor?:string}): Page<SqspProfile>;
  listProducts(p:{cursor?:string}): Page<SqspProduct>;
  ensureWebhookSubscriptions(topics:string[], endpoint:string): Subscription[];
}
interface PaymentProcessor {                     // what Oasis wants; capabilities are honest
  capabilities: { chargeCard:boolean; refundCard:boolean; paymentLink:'api'|'manual'; savedCards:'api'|'hint'|'none' };
  charge?(…); refund?(…); createPaymentLink?(…); savedCards?(…);
}
// v1: SquarespaceProcessor => { chargeCard:false, refundCard:false, paymentLink:'manual', savedCards:'hint' }
```

The command layer branches on `capabilities`. This is the seam for a later Stripe adapter, which would be added without changing the dashboard.

**Config (verify):** `SQSP_API_BASE=https://api.squarespace.com`, a required `User-Agent`, `Authorization: Bearer <API key or OAuth token>`. The Orders, Transactions and Profiles endpoints are under `/1.0/commerce/…` and `/1.0/profiles`. Webhook subscriptions are under `/1.0/webhook_subscriptions`. **Verify whether the Webhook Subscriptions API accepts an API key or requires OAuth.** If OAuth is required, register a private Squarespace developer app, and polling remains the baseline either way. There is no Squarespace sandbox: use a trial or dev site with Commerce Payments in test mode (test cards), and the order field `testMode` is stored.

**Sync strategy:**

- **Poll (baseline):** the jobs `sqsp.sync.orders` and `sqsp.sync.transactions` run every 2 minutes, reading from `modified_after = last_success − 5 min overlap`, paging until done, upserting by `sqsp_order_id` and `sqsp_txn_id` (idempotent), and advancing the cursor in the same transaction. A nightly `sqsp.reconcile.full` re-reads the last 45 days and diffs. Profiles sync hourly and products daily.
- **Webhooks (accelerator):** `order.create` and `order.update` land in `webhook_log`, are verified (`Squarespace-Signature`, HMAC-SHA256 of the raw body with the subscription secret; verify header and encoding), and enqueue `sqsp.webhook.process`, which fetches the full order and runs the same upsert. There is no transaction webhook topic, so transactions are always polled.
- **Rate limits and failures:** the client throttles (a token bucket well under the documented per-site rate limit; verify) and honors `429 Retry-After`. pg-boss retries with exponential backoff. After the final failure the job goes to a dead-letter queue and surfaces in `/ops/integrations/health` and a notification. `sqsp_sync_state.last_error` is shown.

**Mapping orders to invoices and ledger:**

1. **Payment links.** `POST /invoices/:id/payment-links` stores a `payment_links` row and SMSes the URL (template `payment_link`). Because the API cannot create links, the URL comes from `url` supplied by staff (a Squarespace invoice or checkout link), or from a configured template (`SQSP_PAYMENT_LINK_TEMPLATE`, mode `manual_attach` or `template`). The Collect sheet's Payment link option has no URL field in the design, so a small optional "Attach Squarespace link" input is needed (to flag).
2. **Matching an incoming order** (job `sqsp.match.orders`), in priority order:
   - A staff-attached order reference or `payment_links.matched`.
   - A scoring match: same customer (email or phone, normalized) and `grandTotal` equals the link's `expected_cents` (±1 cent), within `[link.sent_at, +14 days]`, with exactly one candidate invoice. A unique, high-confidence match is applied automatically (`match_state=auto`).
   - Otherwise it goes to the unmatched queue for a one-click manual match.
3. **A matched payment creates a `pay` ledger event:** `source='squarespace'`, `processor_state='confirmed'`, `method_kind` from brand (`card`, or `apple_pay` for that wallet, else `other`), `method` `Visa ••4421` when `last4` is provided else `Visa`, `deposit=true` if paid < total. An overpayment is recorded in full and appears in the `overpaid` exception list.
4. **Staff-recorded card payments and refunds** (`awaiting_processor`) are matched when a transaction of equal amount appears on the invoice's linked order, setting `confirmed` and `processor_ref`. They can also be confirmed by hand. Anything awaiting more than 24h raises an alert.
5. **External refunds** that appear in the Transactions feed with no matching Oasis event are ingested as a `refund` event (`source='squarespace'`, `by` Squarespace, `done`, `confirmed`) and listed for review, since they bypass Oasis limits.
6. **Memberships:** see 4.6. Subscription orders drive membership status, renewals and credits.
7. **Card on file** is derived from `customer_card_hint` (the latest card transaction's brand and last4 if provided), else the UI shows "managed in Squarespace".

**Verified limits and fallbacks:**

| Gap | Behavior now | Fallback options |
|---|---|---|
| Cannot charge a card | Card collection is recorded and flagged `awaiting_processor` until staff confirm or the Transactions feed confirms it | Connect the user's own Stripe account to Squarespace and call Stripe directly later (the `PaymentProcessor` seam), or take payment in Squarespace and confirm |
| Cannot refund | Refund recorded and approved in Oasis, flagged "complete in Squarespace", closed on feed match | Same Stripe route |
| Cannot create links or invoices | Link is attached manually or template-based and sent by SMS | Stripe Payment Links |
| No saved cards or card-on-file | Derived hint from the latest transaction, else "managed in Squarespace" | Stripe customer and payment methods |
| No Member Areas billing management | Memberships are mapped subscription products. Status is inferred from subscription orders, with a manual override | Stripe Billing |
| No transaction webhook; possibly OAuth-only webhooks | Polling every 2 min | Lower the interval, or add Stripe webhooks |
| Tip is not a native concept | Tip stays an Oasis invoice attribute | |
| Cancellation of subscriptions may not be exposed | Detect missed renewals, plus a manual cancel | |

### 7.2 SMS Gate over Tailscale

**Port:**

```ts
interface SmsProvider {
  send(m:{id:string; to:string; body:string; simSlot?:number; ttlSec?:number; priority?:number}): Promise<{providerId:string; state:string}>;
  status(providerId:string): Promise<{state:'Pending'|'Processed'|'Sent'|'Delivered'|'Failed'; reason?:string}>;
  health(): Promise<{ok:boolean; battery?:number; details?:unknown}>;
  registerWebhooks(urlBase:string, secret:string): Promise<void>;
  verifyAndParseWebhook(headers, rawBody): SmsEvent;     // HMAC + parse
}
// Adapters: SmsGateProvider (HTTP over tailnet), SimulatorProvider (in-process; /dev/sms/inbound injects replies, auto-delivers)
```

**Outbound (verify against the installed app version):** `POST {base}/messages` with Basic auth. Body `{id, message, phoneNumbers:[e164], simNumber?, withDeliveryReport:true, ttl?}`. We pass our `messages.id` as the SMS Gate `id`, so an ambiguous timeout is resolved by `GET /messages/{id}` before any re-POST, and no duplicate texts occur. The tablet's local server is plain HTTP over the encrypted tailnet (`http://<tailnet-ip>:8080`), which is acceptable because WireGuard encrypts it.

**Inbound and status:** the device calls our webhook for `sms:received`, `sms:sent`, `sms:delivered`, `sms:failed`, `system:ping` and `app:started`. The payload carries `deviceId`, `messageId`, `sender`, `recipient`, message text and timestamps. Verification: `X-Signature` is HMAC-SHA256 with the shared secret over the raw body concatenated with `X-Timestamp` (**verify the exact concatenation** and cover it with signed-fixture tests). We must return 2xx within 30 s (so we persist to `webhook_log` and `sms_inbox`, then process asynchronously). The device retries with exponential backoff (default 14 attempts), so dedupe by event id, and use a configurable timestamp tolerance (default 24 h, because retries can arrive late) rather than a strict 5-minute window.

**HTTPS requirement:** the device requires HTTPS with a valid certificate for non-localhost targets. `tailscale serve --bg --https=443 http://127.0.0.1:3001` provides a tailnet-only `https://<host>.<tailnet>.ts.net` with a Tailscale-issued certificate (MagicDNS and HTTPS must be enabled in the tailnet admin). The registered webhook URL is `https://<host>.<tailnet>.ts.net/hooks/smsgate/<deviceKey>`.

**Dispatcher and throttling (single physical device):** a leader process (guarded by `pg_try_advisory_lock`) drains `sms_outbox`, woken by `LISTEN` and a timer.

- **Priority lanes:** P0 invites, arrival welcome, ready-for-pickup and emergency notices. P1 confirmations, receipts and replies. P2 reminders and review requests. P3 broadcasts.
- **Token bucket:** a minimum interval between sends (default 4 s, `SMSGATE_MIN_INTERVAL_MS`) and an hourly cap (default 120, `SMSGATE_MAX_PER_HOUR`), per device. Dual SIM is handled by `sim_slot_default`.
- **Retry:** transport errors and 5xx retry with exponential backoff (15 s doubling, 6 attempts). A device-reported `Failed` with a transient reason gets one retry after 2 minutes. After the retries the message is `failed` and visible in `/messages/outbox?state=failed`. A message past its `ttl_at` becomes `expired` (default 6 h, reminders 2 h).
- **Reconciliation:** a job every 2 minutes asks the device about messages `sent` for more than 5 minutes with no delivery confirmation.
- **Device health:** `sms.device.healthcheck` calls `health()` every minute (`system:ping` also updates `last_ping_at`). `online` means a success in the last 3 minutes. `offline` raises a notification to managers and the `sms_device_down` alert, and the queue holds. P0 staff messages fall back to email.
- **Inbound router** (STOP and START live in Oasis, because a personal-SIM gateway gets no carrier filtering):
  1. Normalize the sender to E.164 and look up the customer. An unknown sender gets a stub customer and thread.
  2. Opt-out keywords (exact, case-insensitive, trimmed, punctuation stripped): `STOP, STOPALL, UNSUBSCRIBE, END, QUIT`. This writes an `sms_opt_outs` row, sets `customers.sms_opted_out_at`, sends one confirmation, and blocks all later SMS to that number, including emergency.
  3. Opt-in: `START, UNSTOP` (always); `YES` only if currently opted out.
  4. `HELP` sends an auto-reply.
  5. `C`, `CONFIRM` (and `YES` when not opted out and there is an unconfirmed upcoming booking) confirms the next unconfirmed appointment.
  6. `CANCEL` is **not** treated as an opt-out. It raises a staff alert as an inbound cancel request.
  7. Everything else is stored as an inbound message, attributed to the customer's active appointment, with an unread alert and an SSE event.
- **Compliance notes:** the first SMS to a number and every confirmation or reminder include `Reply STOP to opt out`. The design's review template contains an emoji, which forces UCS-2 and halves the segment size. A consumer SIM sending business volume risks carrier filtering, so keep volumes low and consider a business SMS provider later. **[DECISION: volume and number]**
- **Templates (keys, from the design with WhatsApp changed to SMS):** `booking_thanks`, `confirm_request` ("…confirmed for {time}. Reply C to confirm."), `confirmed`, `welcome` (with `{bay}`), `in_progress`, `ready`, `receipt`, `reschedule`, `review`, `late_nudge` (new), `payment_link`, `closure_notice`, `emergency` (editable in Settings), `staff_invite`, `addon_approval`, plus the seven quick replies. The design had two copy sets (seeded history versus live advance), which are unified here.

### 7.3 SES (email)

- **Port:** `EmailProvider { send({to, template, vars, replyTo}) }`. Adapters: `SesProvider` (`@aws-sdk/client-sesv2`) and `ConsoleProvider` (writes `outbox_emails`, viewable at `/dev/mail`).
- Uses: receipts, staff invites, password resets, emergency or closure fallback for customers who are opted out of SMS, and failed-SMS fallback for staff.
- SES starts in **sandbox**: sending works only to verified addresses until production access is granted. Bounces and complaints arrive over an SNS topic to `/hooks/ses` (SNS signature verified) and set `customers.email_bounced_at`.
- Config below. On EC2 the instance profile supplies credentials.

### 7.4 S3 (photos and documents)

- Private bucket with block-public-access, SSE-S3 (or KMS), and CORS allowing `PUT` from the dashboard origin. Key `loc/{locationId}/appt/{apptId}/{category}/{photoId}.{ext}`. Optional lifecycle retention (**[DECISION]**, recommended 24 months).
- **Upload:** `photos/presign {category, contentType, bytes, note?}` returns a row in `pending_upload` and a presigned `PUT` (5 min). Allowed types are jpeg, png, webp and heic, up to 15 MB. The client uploads directly to S3 and calls `complete`, which does a `HEAD` verification (size and type) and enqueues a thumbnail job. `photos.finalize` deletes pending rows older than 15 minutes.
- **Read:** `GET` of the appointment file returns presigned `GET` thumbnail and original URLs valid for 10 minutes. Delete is a soft delete plus an S3 deletion job.
- **Simulator:** `STORAGE_DRIVER=fs` stores locally and signs `/dev-storage/…` URLs.

---

## 8. Background jobs and scheduling

pg-boss queues in the `pgboss` schema. All times are in the business tz. Jobs are idempotent and use singleton keys.

| Job | Trigger | Purpose |
|---|---|---|
| `sms.dispatch` | Leader loop, `LISTEN` wake plus 5 s timer | Drain `sms_outbox` with throttling (7.2) |
| `sms.reconcile` | Every 2 min | Confirm `sent` messages with the device; expire past TTL |
| `sms.device.healthcheck` | Every 1 min | Device health, alert on offline |
| `sqsp.sync.orders` / `.transactions` | Every 2 min | Poll with overlap |
| `sqsp.sync.profiles` / `.products` | Hourly / daily | |
| `sqsp.webhook.process` | Queue (from webhook) | Fetch and upsert an order |
| `sqsp.match.orders` | After each sync | Match to invoices and memberships |
| `sqsp.reconcile.full` | Nightly 02:30 | Re-read 45 days and diff |
| `sqsp.webhooks.ensure`, `sqsp.token.refresh` | Boot and daily / before expiry | Subscriptions and OAuth tokens |
| `appointments.reminders` | Every 5 min | Send `confirm_request` at the configured offsets (default 24 h and 2 h) to opted-in, unconfirmed bookings |
| `appointments.late_scan` | Every 1 min | Emit alerts and optional nudge |
| `appointments.no_show_scan` | Every 15 min | Surface possible no-shows (no auto-action) |
| `appointments.review_request` | 2 h after completion, if enabled | Send `review` once |
| `vip.hold_release_scan` | Every 5 min | Emit `availability.changed` and notify the waitlist |
| `waitlist.offer_expiry`, `waitlist.match_on_cancel` (P2) | Every 1 min / event | |
| `standing.materialize`, `standing.autoconfirm` (P2) | Daily 04:00 / hourly | Behind a feature flag |
| `federal_holidays.generate` | Jan 1, toggle on, boot | Catch-up |
| `emergency.auto_reopen`, `emergency.sweep` | At `ends_at` (delayed job) / hourly | |
| `membership.cycle` | Daily 03:00 | Roll cycles, grant credits, past-due detection |
| `photos.finalize`, `photos.thumbnail` | Every 15 min / queue | |
| `ledger.integrity_check` | Nightly | The view equals `calcInvoice`; credit lot sums; unmatched counts |
| `maintenance.purge` | Daily | Idempotency keys (48 h), realtime events (10 min), sessions, webhook log (90 d) |
| `notifications.alerts_refresh` | Every 5 min | Awaiting-processor over 24 h, unmatched orders, device down |
| Host cron | Nightly | `pg_dump` to S3 |

---

## 9. Seed and fixtures strategy

Three composable profiles, all deterministic (a seeded PRNG plus the injected `Clock`). Seeds write directly to tables and **bypass booking rules**, because the design's fixtures overlap within a bay.

1. **`base`** (always): the location, one Super user, the 27 permissions, the 5 roles with the exact default grants and limits (including role-limit rows and absent-row semantics), the 7 employees (with schedules, skills, the Sofia `sched.override` allow exception, Kevin as `invited`), hours, rules (30/10/60), closures, the 9 packages and 10 add-ons with their tasks (after the inspection filter), tags and prices, the 4 plans with perks and credit rules, VIP settings (holds, release 48, windows 30/14, same-day 2, waitlist, standing, cadences), arrival settings, tax 700 bp, 2 bays, message templates, an SMS simulator device, and the invoice counter at 20611.
2. **`design-parity`**: the clock frozen at `2026-06-13T10:36:00-04:00`.
   - The 12 appointments a1–a12 with the design's times, statuses, staff, bays, members, pay, add-ons, tips, ETAs and notes. Customers and vehicles are de-duplicated, and VIP flags are expressed as `vip_clients` (including Aisha, which resolves cross-design #28).
   - Seeded activity and messages follow the `ensureActivity` rules (message counts 1/2/2/3/4 by status, log counts 1/2/3/4/5), with WhatsApp changed to SMS, and placeholder photo rows with the design's counts (rows with no object key).
   - The cc generated days (`genDay`) and `dayCount`, ported with `mulberry32(o*7919+104729)`, so the calendar week and month counts match the design.
   - The 16 explicit invoices and the 89 generated ones (PRNG seed 987654, the exact RNG call order in pay-domain 6.2), with their ledger events and the explicit post-events. Invoices for the 8 matching customers link to their appointments (invoice times keep the pay fixture times). Pending refund INV-20579 and the canceled INV-20571 are included.
   - **Id collisions fixed:** explicit and auto-id invoices keep their ids (20548–20610). Generated invoices take ids descending from 20608, **skipping used ids**, until all 89 are assigned (lowest 20506).
   - Federal-holiday run for 2026 is pre-marked so only the design's closures exist. Membership rows and emergency history (Jun 3, Feb 18) are included.
   - The three unpaid cc customers (Grace, Tom, Elena) get no invoice in this profile, so the golden vectors in 10.1 remain valid (on the **105-invoice set**).
3. **`demo`**: the same shapes expressed as day offsets relative to the real now, with invoices created at booking for all appointments (so cc Pending payments equals pay Outstanding), plus ±30 days of generated appointments that respect business hours, closures and employee schedules, and avoid the design's closed-day and off-hours generated rows.

Seed fixtures are generated by TS ports (`seeds/payFixtures.ts`, `seeds/genDay.ts`), and a test asserts the parity vectors (section 10.1) against them. `POST /dev/seed {profile}` resets and re-seeds in dev only.

---

## 10. Testing strategy

- **Unit (Vitest):** money (`taxCents`, `divHalfUp`, `parseMoneyToCents`), `calcInvoice` versus the SQL view over all seed invoices, limit and effective-permission resolution, slot engine (sweep, VIP release, cutoff, closures, reduced hours, emergency), `genDay` and `dayCount`, STOP/START/C command parsing, template rendering (emergency variables, `link` off), `atLabel`, retention and bay-time-free formulas. Property tests with fast-check: invoice invariants (`balance ≥ 0`, `refundable ≤ paid`, `net` formula), and slot results never exceeding capacity.
- **Integration (real Postgres):**
  - Appointment lifecycle and guards, including `uq_bay_occupied` under concurrency (two simultaneous starts on one bay), and capacity under concurrent bookings (advisory lock).
  - Ledger append-only trigger, idempotency replay and mismatch, the limit and approval flows (the full pending → approve path), FIFO credit with expiry, add-on removal guards, emergency close and reopen end to end (rows, messages queued, counts, history, auto-reopen with a controlled clock).
  - RBAC union and overrides over HTTP, session and CSRF, view-as, audit rows.
- **Contract:**
  - OpenAPI response validation for every route, and an OpenAPI diff in CI to catch breaking changes.
  - Adapter conformance suites run against the simulators on every run, and against a real tablet or Squarespace trial site as an opt-in.
  - Signed-fixture webhook tests: valid, bad signature, stale timestamp, replay (dedupe), retry after 5xx.
- **Parity data:** a test loads `design-parity` and compares API summaries to the golden vectors; the dashboard repo compares `renderVals` outputs in its own parity suite.

### 10.1 Golden test vectors

**Rounding and calc (cents):**

- `taxCents(50)=4`, `taxCents(150)=11`, `taxCents(250)=18` (half-up at .5), `taxCents(1000)=70`.
- INV-20604: items 18400, tax 1288, total 19688. INV-20608: items 54000, tax 3780, total 57780. INV-20603: items 15400, tax 1078, total 16478, unpaid, balance 16478, credit 2000.
- INV-20602: items 37500, adj −2500, sub 35000, tax 2450, tip 2000, total 39450.
- INV-20605 total 27820 (deposit 5000, balance 22820). INV-20607 total 13375 (deposit 2000, balance 11375).
- INV-20560: credit applied 2500, pay 2315, total 4815, `to_orig_max=2315`, a full card refund is blocked (refundable 4815 > 2315).
- INV-20579: pending 8000, refundable 19820, display "Refund pending". INV-20571: canceled and refunded, status `canceled_refunded`, `net = 32000 − divHalfUp(5000*10000, 10700) = 27327`. INV-20566: total 18548, refunded 3745, status `partially_refunded`.
- Percent discount: 10 percent of items 15400 is 1540 (half-up).
- Status ladder: canceled, paid=0, refunded=0 gives `canceled` (the fix).

**Summary vectors** (all 105 invoices, mgmt role; from the pay-domain port, to be re-verified by running against the original design, which was derived by port and not run in a browser):

| Range | Invoices | Gross | Net | Refunds (n) | Adj (n) | Credits (n) | Outstanding (n) | Card / Apple Pay / Cash / Store credit |
|---|---|---|---|---|---|---|---|---|
| today | 8 | $1,903 | $1,878 | $0 (0) | −$25 (1) | $0 (0) | $507 (3) | 1333.85 / 196.88 / 0 / 0 |
| 7d | 32 | $7,166 | $7,069 (7,069.27) | $87 (87.45, 2) | −$15 (4) | $25 (1) | $507 (506.73, 3) | 4739.10 / 1674.94 / 571.40 / 25.00 |
| 30d | 105 | $27,149 | $26,970 | $127 (127.45, 4) | −$60 (7) | $70 (3) | $507 (3) | 14296.74 / 10919.32 / 3718.04 / 25.00 |
| mtd | 49 | $12,034 | $11,937 | $87 (2) | −$15 (4) | $25 (1) | $507 (3) | 6542.52 / 4440.62 / 1371.06 / 25.00 |

- Filter chip counts at `7d`: All 32, Open balance 3, Refunds 3, Adjusted 4, Credits 2. At `30d`: 105, 3, 5, 7, 4.
- Note the "Credits issued" sub-label counts invoices in the design. The vectors compare counts and amounts, not the corrected distinct-customer label.
- Initial banner text: `1 refund awaiting approval — $80.00 · Chloe Bennett · requested by Sofia D.`

**RBAC:**

- Rafael (mgmt + acct) refund limit 100000 (max 1000 and 500). Sofia (support + crew) refund limit 5000 (crew grants none). Super unlimited (null).
- A role with the permission and no limit row gives 2500. A role with a null row plus another role gives null. Deny override gives off. Allow override with no granting role gives 2500. An allow override with a granting role keeps the role limit.

**Slots and others:**

- Hold release: a Sat 8:00 hold with `release=48` is `vip_held` for non-VIP at Thursday 8:01, and `available` at Thursday 8:00 or later.
- Cutoff: close 5:00 PM, cutoff 60 gives the last start 4:00 PM.
- Emergency message render: `link` off strips the `Pick a new time here:` sentence.
- Credit FIFO: issue 25 (30d) and 20 (no expiry); apply 30 consumes the 25 lot, then 5 of the 20; after 31 days the 25 lot's unused remainder is excluded.
- Idempotency: the same key and body replays the stored response; the same key with a different body gives 422.

---

## 11. Resolutions and decisions

### 11.1 Resolutions (cross-design §2)

Numbers refer to cross §2.

| # | Resolution |
|---|---|
| 1, 8 | Integer cents, half-up, 7 percent (setting), tax per invoice snapshot. |
| 2 | Operations shows cents only when not whole. |
| 3 | cc totals come from `invoice_calc` (includes adjustments). |
| 4 | Real membership credits and perks (4.6); explicit apply by default. |
| 5 | KPIs defined once (4.5). cc Revenue today = collected; pay Net revenue is a different, documented measure. |
| 6 | Invoices exist from booking, so Pending payments and Outstanding reconcile. |
| 7 | Keep the design's refund formulas (full includes tip, by-item excludes tip). |
| 9, 10, 11 | One injectable Clock, real dates, `timestamptz` plus `atLabel`. |
| 12, 13 | Parity seed replicates the design's artifacts. Demo seed does not. Availability does not require staff, and assignment warns if off-shift. |
| 14 | Cutoff applies to the start time. |
| 15, 16 | Slots are computed, and VIP release uses the setting. |
| 17 | ETA alert shows when `eta ≤ 30` (constant). `prep_at_min` drives "Arriving soon" and crew notifications. |
| 18, 25 | Real actor and `displayRole` from roles. |
| 19, 23 | Union of roles plus overrides. Staff columns come from employees with `bay_staff`. |
| 20 | Support acts via `GET /appointments/:id/invoice` and the invoice command routes, no `pay.reports` needed. Dashboard addition required in the cc Payments tab. |
| 21 | `bay_staff` flag. |
| 22 | Ids everywhere. Display names unique. |
| 24 | Each screen keeps its own avatar palette. |
| 26 | `canClose` and role names are computed dynamically. |
| 27 | Over-limit adjust and credit stay blocked **[DECISION]**. |
| 28 | VIP from `vip_clients` only. |
| 29 | `Premium Care` maps to Premium via `plan_label`. The credit alert uses real credits. |
| 30, 31 | Method comes from the actual event or card hint. |
| 32 | The un-pay toggle becomes `void` (`pay.void`, cash or unconfirmed card only). |
| 33 | `bookable_desk` flag (first 5 true in parity). |
| 34 | cc "Mark Paid" maps to the invoice collect command. |
| 35, 36, 37, 38 | Renumbering algorithm, `appointment_id` link, UUIDv7, customer ids. |
| 39, 40, 41, 42 | Everything persisted. Operations is driven by API for VIP, hours, arrival and emergency. Emergency creates closure rows and history. |
| 43, 44 | Real counts and live idle strip. |
| 45 | Four allowed cadences enforced. |
| 46 | `welcome` template with `{bay}`. |
| 47 | KPI formulas defined. |
| 48 | Late computed, grace configurable. |
| 49, 50 | Catalog CRUD endpoints (no UI yet). `set.billing` gates integration admin. |
| 2.7 | Parity seed links the 8 matched pairs. |

Other resolved ambiguities:

- Bay vs start (cc §8-1, 2): planned versus actual bay, and `start` auto-picks a free bay.
- Customer-versus-job notes: appointment `notes` shown if set, else `customers.notes`, else the design default text.
- Message threading: per customer, attributed to the active appointment.
- Money limit semantics: per transaction, not cumulative (the design says only "≤ $N").
- Tax on tip: untaxed.
- Deposits arrive via a Squarespace link or staff record.
- `pay.void` is wired (no design UI).
- Reschedule can cross days.
- Emergency unrebooked appointments are not auto-canceled.

### 11.2 Decisions needed from the user (with recommendation)

1. **Hosting topology:** is the staff UI public or tailnet-only? **Rec:** public HTTPS behind nginx, SMS hooks tailnet-only.
2. **Squarespace auth and plan:** API key or OAuth (webhooks may require OAuth). **Rec:** start polling-only with an API key, add OAuth for webhooks if confirmed.
3. **Payment link mechanism:** manual attach versus template, and approve the small "Attach Squarespace link" UI addition. **Rec:** manual attach.
4. **cc "Mark Paid" default method.** **Rec:** card, flagged awaiting processor.
5. **Invoice creation at booking.** **Rec:** yes.
6. **Enforce store-credit expiry (FIFO).** **Rec:** yes.
7. **Block self-approval of refunds.** **Rec:** yes, except unlimited Super.
8. **Route over-limit adjust and credit to approval instead of blocking.** **Rec:** keep blocked.
9. **Which federal holidays.** **Rec:** all 11 on actual dates.
10. **Membership perks auto-apply.** **Rec:** credits explicit, discounts manual first.
11. **Capacity check on reschedule and drag.** **Rec:** reschedule checked, drag-to-bay physical only.
12. **Late grace.** **Rec:** 10 min.
13. **"24h" window meaning and KPI sub-labels.** **Rec:** today plus tomorrow.
14. **VIP-by-name ambiguity handling.** **Rec:** the most recent match with an audit note.
15. **Retention and upgrade thresholds.** **Rec:** 30/30-day comparison, ≥3 visits in 60 days.
16. **Who enters tips and where** (no design UI). **Rec:** `PUT /invoices/:id/tip`, add a field later.
17. **Reminder cadence, review request on or off, and SMS volume or number type.** **Rec:** 24h and 2h reminders, reviews off, low volume.
18. **Photo retention and HEIC.** **Rec:** 24 months, accept HEIC.
19. **Cancel-with-deposit policy.** **Rec:** manual choice at cancel.
20. **Standing appointments timing.** **Rec:** P2.
21. **Void semantics.** **Rec:** cash and unconfirmed card only.
22. **Customer identity and merging** (phone as the key). **Rec:** unique phone, stubs for unknown, manual merge later.
23. **Spare SMS tablet.** **Rec:** the schema supports multi-device, and failover is a later add.
24. **Message and audit retention.** **Rec:** keep audit forever, messages 24 months.
25. **Emergency "protect credits" definition and unrebooked handling.** **Rec:** as in 4.6 and 4.7.
26. **ETA source and shop coordinates.** **Rec:** customer-app ETA when available, haversine fallback, coordinates entered once.
27. **Invoice number continuation** (INV-20611+). **Rec:** yes.
28. **Dashboard additions flagged for fidelity review:** `void` ledger line, "Awaiting Squarespace" ledger tag, "Other" payment-method row, bay selector for "Assign bay", and "Attach Squarespace link".

### 11.3 Credentials and env vars the user must supply

- **Core:** `NODE_ENV`, `PORT`, `APP_BASE_URL`, `PUBLIC_RESCHEDULE_BASE`, `DATABASE_URL`, `COOKIE_SECURE`, `SECRETS_KEY` (base64 32 bytes), `TRUST_PROXY`, `LOG_LEVEL`, `ALLOW_DEV_ENDPOINTS`, `JOBS_ENABLED`, `SEED_PROFILE`.
- **Drivers:** `SMS_DRIVER=smsgate|sim`, `EMAIL_DRIVER=ses|console`, `STORAGE_DRIVER=s3|fs`, `SQSP_DRIVER=live|sim`.
- **AWS (instance role preferred):** `AWS_REGION`, `S3_BUCKET`, `S3_PRESIGN_TTL`, `SES_FROM_ADDRESS`, `SES_REPLY_TO`, `SES_CONFIGURATION_SET`, `SES_SNS_TOPIC_ARN`, or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` if not on an instance role.
- **SMS Gate:** `SMSGATE_BASE_URL` (device tailnet address), `SMSGATE_USERNAME`, `SMSGATE_PASSWORD`, `SMSGATE_WEBHOOK_SECRET`, `SMSGATE_PUBLIC_WEBHOOK_URL`, `SMSGATE_SIM_SLOT`, `SMSGATE_MIN_INTERVAL_MS`, `SMSGATE_MAX_PER_HOUR`. Host-level (not app): a Tailscale auth key (`tailscale up --authkey`), and HTTPS and MagicDNS enabled in the tailnet admin.
- **Squarespace:** `SQSP_AUTH_KIND`, `SQSP_API_KEY` or `SQSP_OAUTH_CLIENT_ID`/`SQSP_OAUTH_CLIENT_SECRET`/`SQSP_OAUTH_REDIRECT_URI`, `SQSP_SITE_ID`, `SQSP_WEBHOOK_PUBLIC_URL`, `SQSP_PAYMENT_LINK_MODE`, `SQSP_PAYMENT_LINK_TEMPLATE`, `SQSP_POLL_INTERVAL_S`, and the product mapping for the four membership tiers and the packages (set in the admin UI or seeded).

### 11.4 Delivery phases

- **P1:** platform (config, auth, RBAC, audit, idempotency, realtime), settings, catalog, customers, scheduling (appointments, availability, calendar, alerts, KPIs), jobs (checklist, photos), the payments ledger and reports, messaging (SMS simulator, then SMS Gate), Squarespace sync and matching (simulator, then live), memberships, emergency closure, seeds, and tests.
- **P2:** waitlist and standing appointments, broadcasts, async exports, web push, and customer-facing public endpoints beyond the contracts.

### Critical Files for Implementation

- /home/ec2-user/oasis/backend/db/migrations/0001_init.sql (full schema: tables, enums, `invoice_calc` view, ledger guard trigger, `uq_bay_occupied`)
- /home/ec2-user/oasis/backend/src/modules/payments/calc.ts (cents math, `calcInvoice`, limit resolution, ledger commands)
- /home/ec2-user/oasis/backend/src/modules/scheduling/availability.ts (slot engine, VIP holds, override rules, emergency and closure integration)
- /home/ec2-user/oasis/backend/src/modules/integrations/smsgate/ (SmsProvider port, SMS Gate adapter, simulator, dispatcher, inbound router) together with /home/ec2-user/oasis/backend/src/modules/integrations/squarespace/ (source port, sync, matching, `PaymentProcessor` seam)
- /home/ec2-user/oasis/backend/db/seeds/ (base, design-parity, demo, `payFixtures.ts`, `genDay.ts`)