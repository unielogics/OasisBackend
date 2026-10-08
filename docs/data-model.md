# Data model

The schema of the Oasis backend, in the order the migrations build it. **This document cannot go stale:** the schema reference at
the end is generated from `db/schema.sql` by `pnpm data-model` (which `pnpm db:schema` derives from the migrations), and
`test/unit/data-model.test.ts` fails when a table or a migration is missing from the sections below, when a documented table does
not exist, when the generated reference differs from `db/schema.sql`, or when `db/schema.sql` differs from the live migrated
database. After a migration: `pnpm db:schema`, add the table's row to the right section here, `pnpm data-model`.

## Migrations

| Migration                              | Adds                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `20261006130000_platform_core.sql`     | extensions, `app_now()`, locations, settings, idempotency keys, the realtime log, the audit log, the webhook log, notifications                        |
| `20261006140000_people_auth.sql`       | employees, schedules, roles, the 27 permissions, money limits, per-person exceptions, users, invites, sessions, password resets, preferences           |
| `20261006150000_domain_core.sql`       | catalog, customers, vehicles, bays, hours, booking rules, closures, emergencies, VIP and arrival configuration, appointments and their job records     |
| `20261006160000_domain_links.sql`      | the foreign keys from the domain tables to employees and users that the domain core could not declare yet                                              |
| `20261006180000_scheduling_ops.sql`    | the alert-set change detector of the per-minute scan and the indexes the board, calendar and availability reads use                                    |
| `20261006190000_payments.sql`          | invoices, the append-only ledger, store-credit allocations, payment links, the gap-free invoice counter, `invoice_calc_of` and the `invoice_calc` view |
| `20261006200000_messaging.sql`         | SMS devices, threads, messages, the outbox, inbox, opt-outs, usage log, processed webhook envelopes, the email outbox                                  |
| `20261006210000_memberships.sql`       | membership plans, credit rules, members and the credit ledger                                                                                          |
| `20261006210100_sqsp_sync.sql`         | the Squarespace read side: connection, sync state, orders, transactions, contacts, customer links, product map, dead letters, matches, manual queue    |
| `20261006300000_arrival_ping.sql`      | arrival pings and the expiry of the customer check-in link (ADR 0083)                                                                                  |
| `20261006300100_membership_gaps.sql`   | `plan_credit_rules.auto_apply` (ADR 0084)                                                                                                              |
| `20261006300200_standing_waitlist.sql` | standing (recurring) series and their occurrences, the waitlist and its offers (ADR 0086; behind a feature setting, off by default)                    |
| `20261006310000_jobs_runtime.sql`      | the per-job run record behind `GET /system/jobs`, and the once-only markers of the VIP-release and credit-expiry scans (ADR 0090 to 0093)              |
| `20261006400000_email_feedback.sql`    | the SES suppression list, and SES feedback, error time and the job of a receipt on the email outbox (ADR 0110)                                         |
| `20261006410000_notices_and_ledger_integrity.sql` | the debounce record of manager notices that can repeat (SMS device flapping, app restarts, no device) and the nightly ledger integrity results (ADR 0122, 0123) |

Conventions: UUIDv7 ids supplied by the application (`createIdGenerator(clock)`), money as integer cents, every default reads
`app_now()` (never `now()`), enums are `text` with a `check`, business dates are `date` (read as `'YYYY-MM-DD'` strings),
wall-clock times are minutes from midnight (`smallint`), `version` is the optimistic-concurrency token. Location scoping: parents
carry `location_id` and every unique key leads with it; child tables inherit the location through their parent FK. `customers`,
`vehicles`, `employees`, `roles` and `permissions` are brand-global (a second location shares them). Kysely types are registered by
module augmentation (`declare module '../../platform/schema.js'`) in each module's `schema.ts`.

## Platform

| Table               | Key columns and rules                                                                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `locations`         | `slug` (unique), `timezone` (America/New_York), `address`, `lat`/`lng` (the centre of the arrival geofence; `PUT /settings/location`). One seeded row.                                                                                |
| `settings`          | pk `(location_id, key)`, `value jsonb`, `version`. The typed registry in `src/platform/settings.ts` is the only source of keys, validation and defaults (tax, grace minutes, approvals, reminders, quiet hours, cancellation policy). |
| `idempotency_keys`  | pk `(key, actor)`; `request_hash`, `state in_flight\|done`, the stored response, `lock_expires_at`, `expires_at`. A replay returns the stored response; the same key with another body is 422.                                        |
| `realtime_events`   | The durable SSE log (`bigserial` id used as `Last-Event-ID`): `channel` (ops, payments, messages, settings, notifications), `type`, `payload`, `target_user_id`. An insert trigger NOTIFYs listeners on commit.                       |
| `realtime_state`    | One row: `purged_through`, the highest purged event id, so a stale `Last-Event-ID` is told to resync.                                                                                                                                 |
| `audit_log`         | Insert-only (trigger): actor, roles, `view_as_role_id`, `action`, entity, `before`/`after`, request id, idempotency key, ip. Kept forever.                                                                                            |
| `webhook_log`       | One row per received webhook, unique `(provider, external_id)`; `signature_valid`, `status received\|processed\|ignored\|failed`.                                                                                                     |
| `notifications`     | The bell: per employee or role target, `kind` (emergency, arrival, ...), `title`, `body`, entity, `read_at`.                                                                                                                          |
| `schema_migrations` | The migration runner's record: `name`, `checksum`, `applied_at`. An applied migration is never edited.                                                                                                                                |

## People, auth and RBAC

| Table                           | Key columns and rules                                                                                                                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rbac_state`                    | One counter bumped in the same transaction as any change that can alter effective permissions; per-process caches compare it on every request.                                                           |
| `employees`                     | `first`, `last`, `title`, `phone`/`phone_e164`, `email citext`, `status active\|invited\|inactive`, employment and pay fields, `skills`, `avatar_color`, `version`, `deactivated_at` (set iff inactive). |
| `employee_locations`            | pk `(employee_id, location_id)`: who works where.                                                                                                                                                        |
| `employee_schedules`            | pk `(employee_id, weekday)`, Sunday = 0; `is_on`, `from_min`, `to_min`. Drives "on shift" (crew alerts) and the hours-conflict warnings.                                                                 |
| `roles`                         | The five seeded roles (`key` super, mgmt, acct, support, crew) plus custom ones; `is_locked` marks the single Super Admin role.                                                                          |
| `permissions`                   | The 27 permission keys with `module`, `label`, `sort` and `has_limit` for the three money ones (refund, adjust, credit).                                                                                 |
| `role_permissions`              | pk `(role_id, permission_key)`.                                                                                                                                                                          |
| `role_limits`                   | pk `(role_id, kind)`; `unlimited` or `limit_cents` (cents). **No row means the default of 2500 cents.** The API takes the chip in dollars and stores cents (ADR 0081).                                   |
| `employee_roles`                | pk `(employee_id, role_id)`: a person's roles; permissions are the union.                                                                                                                                |
| `employee_permission_overrides` | pk `(employee_id, permission_key)`, `effect allow\|deny`: the per-person exceptions (deny beats allow beats role).                                                                                       |
| `users`                         | The login of an employee (`employee_id` unique), `email citext`, scrypt `password_hash`, `failed_attempts`, `disabled_at`.                                                                               |
| `invites`                       | `token_hash` (unique), `channel sms\|email\|link`, `expires_at`, `accepted_at`, `revoked_at`.                                                                                                            |
| `sessions`                      | `id` is the hex SHA-256 of the cookie token; idle and absolute expiry, `csrf_secret`, `view_as_role_id`, `revoked_at`.                                                                                   |
| `password_resets`               | `token_hash` (unique), `expires_at`, `used_at`.                                                                                                                                                          |
| `user_preferences`              | pk `user_id`; the theme.                                                                                                                                                                                 |

## Domain core (migration `20261006150000_domain_core.sql`)

The data the Settings and Operations screens share: catalog, customers and vehicles, bays, hours and booking rules, closures and
emergencies, VIP and arrival configuration, and appointments with their job records.

### Catalog

| Table             | Key columns and rules                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services`        | `kind package\|addon`, `name`, `short_name` (null = derive `name.split(' + ')[0]`), `price_cents`, `duration_min` (add-ons are exactly 0, packages 1-720), `tags text[]`, `bookable_desk`, `sort`, `active`, `sqsp_sku`, `version`. Unique `(location_id, kind, lower(name))`. Retired services stay (`active=false`); appointments snapshot name, price and duration. |
| `checklist_tasks` | `service_id`, `label`, `position`, `retired_at`. **Stable ids**: rename updates the label in place, reorder updates `position`, removal sets `retired_at`; rows are never deleted. Index on active tasks `(service_id, position)`.                                                                                                                                     |

### Customers and vehicles

| Table       | Key columns and rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `customers` | `full_name`, `phone_e164` (check `^\+[1-9][0-9]{6,14}$`) + `phone_display`, `email citext`, `notes`, `sms_opted_in`, `sms_opt_in_source`, `sms_opt_in_at`, `sms_opted_out_at`, `email_bounced_at`, `source`, `synthetic`, `needs_details`, `merged_into` (self FK), `deleted_at`, `version`. Partial unique on `phone_e164` for live rows (not merged, not deleted). `synthetic` rows must use `+1 AAA 555 01xx` (check), so a seed can never text a stranger. Trigram GIN indexes on name, phone and email. |
| `vehicles`  | `customer_id`, `year`, `make`, `model`, `color`, `plate` (stored upper-case), `deleted_at`. Unique `(customer_id, upper(plate))`, including soft-deleted rows (the upsert revives them). Index on `upper(plate)` for lookup.                                                                                                                                                                                                                                                                                 |

### Bays, hours, rules

| Table            | Key columns and rules                                                                                                                                                                                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bays`           | `number`, `name`, `status active\|maintenance\|blocked`, `sort`. Unique `(location_id, number)`. Two seeded.                                                                                                                                                                                                     |
| `business_hours` | pk `(location_id, weekday 0-6)`, Sunday = 0; `is_open`, `open_min`, `close_min`. Checks `open < close`, `300 <= open`, `close <= 1410`, both on the 30-minute grid. A closed day keeps valid hours.                                                                                                              |
| `booking_rules`  | pk `location_id`; `slot_minutes 15\|30\|60` (30), `buffer_minutes 0\|10\|15\|20` (10), `cutoff_minutes 30\|60\|90` (60), `online_lead_minutes` (30; resolves review C10, `lead_min` was undefined), `allow_overrun`, `auto_plan_bay`, `version`. **`version` is the single token for the hours + rules screen.** |

### Closures and emergencies

| Table                     | Key columns and rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `closures`                | `date`, `name`, `type closed\|reduced`, `open_min`/`close_min` (the open window; required for `reduced`, null for `closed`), `notify`, `source manual\|federal\|emergency`, `federal_key`, `federal_year` (added per review C5), `emergency_closure_id`, `created_by`, `deleted_at`. Partial unique `(location_id, date)` for live rows. `unique (location_id, federal_key, federal_year)` **including soft-deleted rows**, so a removed holiday is never regenerated. Checks: key and year are set together, only `source=federal` carries a key, `source=emergency` iff `emergency_closure_id` is set. |
| `federal_holiday_runs`    | pk `(location_id, year)`, `ran_at`. Catch-up runs skip a recorded year.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `emergency_closures`      | One row per closure; history is the inactive rows. `reason`, `duration_kind today\|until\|days`, `until_min`, `through_date` (always set: the start date for today/until), `ends_at`, `message` (template), switches `notify`, `link`, `credits`, `pause`, `crew`, `summary`, `started_at/by/by_name`, `reopened_at/by/by_name`, `auto_reopened`, frozen counters `affected_count`, `notified_count`, `rebooked_count`, `detail`, `replaced_closure_ids uuid[]` (planned closures it soft-deleted, restored on reopen). Partial unique `(location_id) where active`.                                     |
| `emergency_notifications` | `(emergency_closure_id, appointment_id)` unique; `channel sms\|email\|none`, `state queued\|sent\|delivered\|failed\|skipped_opt_out\|no_contact`, `reschedule_link_id`, `rebooked_at`, `message_id`.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `reschedule_links`        | `code` (unique, 8+ chars), `appointment_id`, `emergency_closure_id`/`closure_id`, `expires_at`, `used_at`, `result_appointment_id`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### VIP and arrival

| Table              | Key columns and rules                                                                                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vip_settings`     | pk `location_id`; `release_hours 24\|48\|72`, `window_vip_days 7-90` (30), `window_std_days 7-60` (14), `same_day_per_month 0-8` (2), `waitlist`, `offer_minutes 10\|15\|30`, `standing`, `auto_confirm`, `cadences` (subset of weekly, biweekly, triweekly, monthly), `version`. |
| `vip_holds`        | `weekday`, `time_min` (300-1410, 30-minute grid). Unique `(location_id, weekday, time_min)`.                                                                                                                                                                                      |
| `vip_clients`      | pk `(location_id, customer_id)`, `added_by`, `added_at`. Replaces the design's name-string list and the per-appointment `vip` flag.                                                                                                                                               |
| `arrival_settings` | pk `location_id`; `enabled`, `radius_m 150\|300\|500`, `prep_at_min 10\|15\|20`, `auto_arrive`, `welcome`, `alert_crew`, `vip_first`, `version`.                                                                                                                                  |

### Appointments and jobs

| Table                   | Key columns and rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `appointments`          | `seq` (identity, unique), `customer_id`, `vehicle_id`, `service_id`, snapshots `package_name`/`price_cents`/`duration_min`, `status booked\|confirmed\|arrived\|cleaning\|completed\|canceled\|no_show`, `scheduled_start/end` (end > start), `assigned_employee_id`, `planned_bay_id` (advisory), `bay_id` (actual occupant), `source`, `eta_minutes/eta_at`, `geo_checked_in_at`, `bay_prepped_at`, `arrived_at`, `cleaning_started_at`, `completed_at`, `pickup_state`, `picked_up_at`, `ready_notified_at`, `canceled_at`, `cancel_reason`, `no_show_at`, `notes`, `special_instructions`, `membership_id`, `emergency_closure_id`, `standing_series_id`, `arrival_token_hash`, `version`, `created_by`. **`uq_bay_occupied (bay_id) where status='cleaning'`** is the database's guarantee of one cleaning job per bay; `check (status <> 'cleaning' or bay_id is not null)`. Indexes `(location_id, scheduled_start)`, `(customer_id, scheduled_start desc)`, active statuses. |
| `appointment_addons`    | Price snapshot, `removed_at`. Partial unique `(appointment_id, service_id) where removed_at is null`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `appointment_overrides` | `kind capacity\|hours\|closure\|vip_hold\|same_day_guarantee`, non-empty `reason`, `employee_id`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `job_checklist_items`   | Snapshot labels and section titles; `source_task_id` (FK to `checklist_tasks`, set null on delete, which never happens), `appointment_addon_id`, `position`, `done`, `done_at`, `done_by_employee_id`, `removed_at`. Keys are ids, never labels.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `appointment_photos`    | `category arrival\|before\|after\|issue`, `s3_key`, `thumb_key`, `bytes`, `note`, `status`. A file is required unless it is an `issue` with a non-blank note.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `activity_log`          | Appointment-visible log (distinct from `audit_log`): `text`, `channels` (sms, email, internal, automation, system), `actor_type`, `actor_name`, `meta`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### Scheduling operations and arrival

| Table             | Key columns and rules                                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ops_alert_state` | pk `location_id`; `alerts_hash`, `alert_keys`. The set of "Needs attention" alerts last announced over SSE, so the per-minute scan emits `alerts.changed` only when the set changes.                                                                                |
| `arrival_pings`   | One accepted customer location ping per row (ADR 0083): `lat`/`lng`, `accuracy_m`, `distance_m` to the shop, `eta_min`, `declared` ("I'm here"), `outcome`, the client's `ping_key` (unique per appointment) and the `reply` that was given, replayed for a repeat. |

`appointments.arrival_token_hash` (unique, SHA-256 of the customer check-in link token) and `arrival_token_expires_at` belong to the
check-in link; the plain token exists only in the response that issued it.

## Payments (migration `20261006190000_payments.sql`)

| Table                | Key columns and rules                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoice_counters`   | pk `location_id`; `next_no` (starts at 20611), incremented under a row lock in the booking transaction: gap-free.                                                                                                                                                                                                                                                     |
| `invoices`           | One per appointment (`appointment_id` unique), `invoice_no` unique per location, label snapshots, `occurred_at`/`biz_date` (frozen by `date_frozen_at` at completion), `tax_bp`, `tip_cents`, `canceled_at` + `cancel_reason canceled\|no_show`, `payment_link_url`, `version`.                                                                                       |
| `invoice_items`      | Price snapshots (`package` or `addon`), `position`, `appointment_addon_id`; refund-by-item claims item ids.                                                                                                                                                                                                                                                           |
| `ledger_events`      | Append-only (trigger): `type pay\|adjust\|refund\|credit_issue\|credit_apply\|void`, `amount_cents` (adjust signed), refund `status pending\|done\|denied` and `dest card\|credit\|cash`, method fields, actor and approver fields, `source oasis\|squarespace\|system\|seed`, `processor_state na\|awaiting_processor\|confirmed\|failed`, `idempotency_key` unique. |
| `credit_allocations` | Append-only: which store-credit lot a `credit_apply` consumed (FIFO by expiry, skipping lots already expired).                                                                                                                                                                                                                                                        |
| `payment_links`      | A staff-attached Squarespace checkout or invoice URL (https): `purpose balance\|deposit`, `expected_cents`, `state`, `matched_sqsp_order_id`. No ledger event until money actually arrives.                                                                                                                                                                           |

`invoice_calc_of(invoice)` and the `invoice_calc` view compute items, adjustments, tax (half-up), paid, refunded, balance, refundable
and the status ladder in integer cents; `src/modules/payments/calc.ts` is the TypeScript twin.

## Messaging (migration `20261006200000_messaging.sql`)

| Table                  | Key columns and rules                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sms_devices`          | The SMS Gate tablet(s): `device_key`, `provider smsgate\|sim`, encrypted `password_enc`/`webhook_secret_enc`, rate limits (`max_per_window`, `window_minutes`), health fields and `status`. |
| `message_threads`      | One per customer: `last_message_at`, `last_inbound_at`, `unread_count`.                                                                                                                     |
| `messages`             | Every in- and outbound message: `direction`, `sender_kind`, `appointment_id`, `template_key`, `klass` (SMS class), `status`, `peer_e164`, `segments`, `encoding`, `idempotency_key` unique. |
| `sms_outbox`           | The queue the dispatcher drains (`id` = `messages.id`): `priority`, `state`, `attempts`, `next_attempt_at`, `ttl_at`, `hold_until` (quiet hours), device acceptance and delivery times.     |
| `sms_usage`            | Segments handed to the device: the input of the sliding send window (Android's own SMS limit).                                                                                              |
| `sms_processed_events` | Webhook envelope ids already applied; written in the same transaction as the event's effects.                                                                                               |
| `sms_inbox`            | Every text the device received, with the router's `decision`; unknown senders stay here (`quarantined`), no customer row is created for them.                                               |
| `sms_opt_outs`         | By phone number: STOP/START history; an active opt-out has `opted_in_again_at` null.                                                                                                        |
| `outbox_emails`        | The email queue and the console driver's mailbox; sensitive templates lose their variables once terminal.                                                                                   |

## Memberships (migration `20261006210000_memberships.sql`, ADR 0073 and 0084)

| Table                      | Key columns and rules                                                                                                                                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `membership_plans`         | Essential, Premium, Executive, Exotic per location: display colours, `perks`, discount basis points (display only), `billing_interval_months`.                                                                                                            |
| `plan_credit_rules`        | A credit covers a service whose `services.tags` include any `include_tags` and none of `exclude_tags`; `per_cycle` null = unlimited; **`auto_apply`** (default false) redeems the credit when a covered visit is completed.                               |
| `memberships`              | One live membership per customer (partial unique); `plan_label`, `status`, `source squarespace\|manual`, the current cycle, grace and review flags, the member's own `auto_apply`, `manual_status_at`.                                                    |
| `membership_credit_events` | Append-only credit ledger: `grant` per rule per cycle, `redeem` (names the appointment, one per appointment), `restore` (gives a credit back), `protect` (a marker an emergency closure leaves; moves no count), `reserve` and `expire` (reserved kinds). |

## Squarespace sync (migration `20261006210100_sqsp_sync.sql`, ADR 0070 to 0072)

Squarespace is read-only for payments; these tables mirror what it reports and record every decision the matcher takes.

| Table                        | Key columns and rules                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sqsp_connections`           | Credentials encrypted with `SECRETS_KEY` (`api_key_enc`, OAuth tokens), `auth_kind`, `status`, `last_verified_at`.                                               |
| `sqsp_sync_state`            | pk `(location_id, resource)`: watermark, window, run and failure bookkeeping per polled resource.                                                                |
| `sqsp_orders`                | Synced orders: totals in cents, `is_subscription`, `test_mode`, `line_items`, `match_state`, `matched_invoice_id`, `customer_id`.                                |
| `sqsp_transactions`          | The Transactions feed: `kind payment\|refund`, `amount_cents`, card `brand` (last4 only if a payload ever has it), `state`, `matched_event_id`.                  |
| `sqsp_contacts`              | The Contacts API mirror (email, name, phone).                                                                                                                    |
| `sqsp_customer_links`        | Squarespace customer id to an Oasis customer (unique match by email, then phone, or by hand).                                                                    |
| `sqsp_products`              | Product or SKU to meaning: a membership tier (`plan_id`, `plan_label`, `interval_months`) or a service; the only source of "this order is a membership payment". |
| `sqsp_webhook_subscriptions` | Registered order webhooks and their last delivery.                                                                                                               |
| `sqsp_sync_errors`           | Dead letters: an item that cannot be mapped or persisted, with attempts and `dead_lettered_at`.                                                                  |
| `sqsp_matches`               | Every applied match decision and the idempotency record of the ledger commands the sync issues.                                                                  |
| `sqsp_manual_queue`          | Arrivals the matcher would not decide alone (no candidate, ambiguous, below the confidence threshold, possible double count).                                    |
| `sqsp_alerts`                | Sync and matching alerts (variance, external refund, empty product map, dead letters, members without a customer); `dedupe_key` makes raising idempotent.        |

## Standing appointments and the waitlist (migration `20261006300200_standing_waitlist.sql`, ADR 0086)

Behind the setting `features.standing_waitlist` (default off) and the VIP toggles; no UI yet.

| Table                  | Key columns and rules                                                                                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `standing_series`      | A VIP client's repeating slot: `cadence weekly\|biweekly\|triweekly\|monthly`, `weekday` (of `start_date`), `time_min`, `start_date`/`end_date`, `status active\|paused\|ended`, `generated_through` (the materializer's watermark), `auto_confirm`. |
| `standing_occurrences` | One row per date the materializer decided, unique `(series_id, occurrence_date)`: `booked` with its `appointment_id`, or `skipped` with the `reason` (an error code such as `SLOT_CLOSED`).                                                          |
| `waitlist_entries`     | A client waiting for a date and a start-time window (`window_start_min`..`window_end_min`) for a package; `is_vip` at joining; `status waiting\|offered\|booked\|expired\|canceled`; `appointment_id` once booked.                                   |
| `waitlist_offers`      | A freed slot offered to an entry: `slot_start`/`slot_end`, `phase vip\|everyone`, `status open\|accepted\|expired\|canceled`, `expires_at`; unique `(entry_id, slot_start)`.                                                                         |

## Background jobs (migration `20261006310000_jobs_runtime.sql`, ADR 0090 to 0093)

Written by the worker only; the request path never touches them.

| Table               | Key columns and rules                                                                                                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job_runs`          | One row per job name, updated at the start and the finish of every run: `runs`, `failures`, `consecutive_failures`, `last_outcome running\|completed\|failed`, last start/finish/success/error times, masked `last_error`, `last_duration_ms`. Feeds `GET /system/jobs` and `/readyz`. |
| `vip_hold_releases` | Primary key `(hold_id, slot_start)`: a weekly VIP hold whose release for one concrete slot has been announced, so a rerun or a second worker announces it once; purged a week after the slot.                                                                                          |
| `credit_expiries`   | Primary key `lot_event_id` (the store-credit lot in `ledger_events`): the unspent remainder that expired and was announced once to staff (`expired_cents`, `expires_at`). The ledger itself is untouched.                                                                              |

## Notices and ledger checks (migration `20261006410000_notices_and_ledger_integrity.sql`, ADR 0122 and 0123)

Written by the messaging runtime and the worker; neither holds business data.

| Table                   | Key columns and rules |
| ----------------------- | --------------------- |
| `notice_debounce`       | Primary key `(location_id, key)`: the last time a repeatable manager notice was sent (`last_sent_at`), what it announced (`state`) and how many repeats were held back since (`suppressed`). Keys `sms.device:<id>:offline` / `:online` / `:state`, `sms.app_restarted:<id>`, `sms.no_device`. |
| `ledger_integrity_runs` | One row per `(location_id, check_date)`: the night's `ledger.integrity_check` result (`ok`, `invoices_checked`, `findings` jsonb of `{code, detail, invoiceNo?}`, `job_id`). A re-run with the same result leaves the row alone. |

## Email feedback (migration `20261006400000_email_feedback.sql`, ADR 0110)

Written by `POST /hooks/ses` (SNS-signed SES events); read before every send.

| Table                | Key columns and rules                                                                                                                                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email_suppressions` | Primary key `address` (lowercased, trimmed); account-wide, no `location_id`. `reason bounce\|complaint` (a complaint outranks a bounce), bounce type/subtype, complaint feedback type, diagnostic, `first_seen_at`, `last_seen_at`, `count` of distinct SES messages, the last 20 `source_message_ids`; `cleared_at`/`cleared_by` when a person lifted it. |

The same migration adds to `outbox_emails`: `appointment_id` (a receipt's job, for the activity line), `error_at`, `delivered_at`,
`feedback soft_bounce|hard_bounce|complaint`, `feedback_at`, `feedback_detail`, and an index on `provider_message_id`.

## Foreign keys

`domain_links` added the keys from the domain tables to `employees` and `users`. Two columns stay plain `uuid` on purpose, and a
test (`test/domain-schema/migration.test.ts`) keeps the domain tables from referencing the later verticals:

| Column                               | Would reference       | Why it stays a plain uuid                                                                                        |
| ------------------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `appointments.membership_id`         | `memberships(id)`     | the domain tables must not depend on Memberships (the link is read through `MembershipPort`)                     |
| `appointments.standing_series_id`    | `standing_series(id)` | same, for the standing-appointment feature (off by default)                                                      |
| `emergency_notifications.message_id` | `messages(id)`        | the payments dev outbox hands out ids that are not messages (ADR 0060); `payment_links.sent_message_id` likewise |

(`emergency_closures.started_by_name` and `reopened_by_name` keep the display name so history survives an employee being
deactivated.) Platform columns such as `settings.updated_by` and `audit_log.actor_*` follow the platform's own convention.

## Seed contents (`db/seeds/domain.ts`)

Profiles: `domain` (reference data), `domain-design` (design fixtures, depends on `domain`), and the compositions `base`
(depends on `domain`) and `design` (depends on `base` and `domain-design`); other seed files extend `base`/`design`
through `dependsOn`. Every profile is idempotent: natural keys, `do nothing` on conflict, never an update, so a second
run changes nothing and edits made after seeding survive (a retired task, a changed price, a removed closure).

`domain`:

- Two bays (Bay 1, Bay 2), hours Sun 9-3, Mon-Fri 8-6, Sat 8-5, rules 30/10/60 (lead 30).
- The seven design closures: Memorial Day (May 25), **Weather closure (Jun 3, emergency)**, Independence Day (Jul 4),
  **Labor Day (Sep 7, reduced 10:00 AM-2:00 PM)**, Thanksgiving (Nov 26), **Christmas Eve (Dec 24, reduced 8:00 AM-1:00 PM)**,
  Christmas Day (Dec 25). The five federal ones carry `federal_key`/`federal_year=2026`; `federal_holiday_runs` has 2026,
  so the generator adds nothing. All have `notify=true` (the design's default for hand-entered rows).
- Emergency history: Jun 3, 2026 severe weather, full day, 7 notified, 6 rebooked (the Jun 3 closure points at it); Feb 18,
  2026 power outage, 11:20 AM-3:00 PM, 4 notified.
- The 9 packages and 10 add-ons with the design's prices and durations (add-ons 0). Task lists come from the design's source
  lists with `/inspection/i` tasks removed at seed time (nine "Final/pre-inspection" tasks), giving 5, 7, 8, 10, 9, 10, 7,
  9, 7 package tasks and 3, 3, 3, 2, 3, 2, 3, 2, 2, 3 add-on tasks. `bookable_desk` is true for the first five packages (the
  new-appointment picker shows `slice(0, 5)`). Tags (express, premium, executive, ceramic, handwash, detail, exotic,
  family) feed the later membership credit rules.
- VIP settings (release 48, windows 30/14, same-day 2, waitlist on, offer 15, standing on, auto-confirm on, cadences weekly,
  biweekly, monthly), holds Sat 8/9/10 AM, Fri 4 PM, Sun 9 AM, arrival settings (on, 300 m, prep 15, every toggle on).

`domain-design`:

- Twelve customers (the design's a1-a12 people) with `synthetic=true` numbers `+1 305/786 555 0102-0113` (clear of the
  employees' 555-01xx numbers), SMS opted in (source `import`), and their vehicles (plates as in the design).
- VIP clients: Jonathan Franco, Liam Chen, Aisha Rahman, Elena Volkov (resolved to customers by exact name).
- No appointments, invoices, memberships or messages: the verticals that own them seed those.

`demo` (`db/seeds/demo.ts`, depends on `design`, `memberships` and `geofence`; `pnpm seed -- --profile design,demo`): the
Operations design day re-anchored on **today** in the business time zone with the real clock, for a live link. Details in
`db/seeds/README.md`.

- `appointments`: a1-a11 at their design times today and a12 tomorrow, in the state their day (`DEMO_PLAN`) has reached at
  the seed's clock (10:36 AM gives the design board exactly; one car per bay at any moment); the Payments history's jobs of the
  last 29 days (completed, one canceled); the design's procedural days 30-60 back (completed) and from tomorrow to 60 ahead
  (booked or confirmed), closed days skipped. `appointment_addons`, `job_checklist_items` (ticks only for work done),
  `appointment_photos` (rows without objects), `activity_log` and delivered `messages` follow the same timeline.
- `invoices`: exactly one per appointment. INV-20601..20608 on the eight jobs the Payments design names, the history's own
  numbers (20506-20610 without today's eight), the past procedural days from 20505 downward, everything else from
  `invoice_counters` (today's other four first, then the future days in date order). No number is used twice.
- `ledger_events` (`source='seed'`): yesterday's deposits and Nathan's prepayment, today's prepayments at the Payments design's
  times, counter payments when a car is finished, David's loyalty adjustment, the history's events (pending refund INV-20579,
  canceled INV-20571, store credit with `credit_allocations`), the past procedural payments. Exactly one card payment is
  `processor_state='awaiting_processor'`: the day's latest counter card payment, or yesterday's last card payment before
  the first one of the day.
- Customers: the twenty design pool names (`+1 305/786 555 0114-0133`) and the history's extra people (`+1 954 555 01xx`), all
  `synthetic`.

## Schema reference (generated)

<!-- schema-reference:start -->
Generated from `db/schema.sql` by `pnpm data-model` (89 tables, 1 view, 9 functions). Do not edit by hand: change a migration, run `pnpm db:schema` then `pnpm data-model`.

#### `activity_log`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | bigint | no |  |
| `appointment_id` | uuid | no |  |
| `at` | timestamp with time zone | no | `app_now()` |
| `text` | text | no |  |
| `channels` | text[] | no | `'{}'::text[]` |
| `actor_type` | text | no | `'staff'::text` |
| `actor_name` | text | yes |  |
| `meta` | jsonb | no | `'{}'::jsonb` |

Primary key `(id)`. `(appointment_id)` references `appointments(id)` on delete cascade. 3 check constraints. Index `activity_log_appointment_idx` `(appointment_id, at, id)`.

#### `appointment_addons`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `appointment_id` | uuid | no |  |
| `service_id` | uuid | no |  |
| `name` | text | no |  |
| `price_cents` | integer | no |  |
| `added_by` | uuid | yes |  |
| `added_at` | timestamp with time zone | no | `app_now()` |
| `removed_at` | timestamp with time zone | yes |  |

Primary key `(id)`. `(added_by)` references `users(id)` on delete set null. `(appointment_id)` references `appointments(id)` on delete cascade. `(service_id)` references `services(id)`. 2 check constraints. Index `appointment_addons_appointment_idx` `(appointment_id)`. Unique index `uq_appointment_addons_live` `(appointment_id, service_id)` where `removed_at IS NULL`.

#### `appointment_overrides`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `appointment_id` | uuid | no |  |
| `kind` | text | no |  |
| `reason` | text | no |  |
| `employee_id` | uuid | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. `(appointment_id)` references `appointments(id)` on delete cascade. `(employee_id)` references `employees(id)` on delete set null. 2 check constraints. Index `appointment_overrides_appointment_idx` `(appointment_id)`. Index `appointment_overrides_kind_idx` `(kind, created_at)`.

#### `appointment_photos`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `appointment_id` | uuid | no |  |
| `category` | text | no |  |
| `s3_key` | text | yes |  |
| `thumb_key` | text | yes |  |
| `content_type` | text | yes |  |
| `bytes` | integer | yes |  |
| `note` | text | yes |  |
| `status` | text | no |  |
| `taken_at` | timestamp with time zone | no | `app_now()` |
| `uploaded_by` | uuid | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. `(appointment_id)` references `appointments(id)` on delete cascade. `(uploaded_by)` references `users(id)` on delete set null. 4 check constraints. Index `appointment_photos_appointment_idx` `(appointment_id, category)`.

#### `appointments`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `seq` | bigint | no |  |
| `customer_id` | uuid | no |  |
| `vehicle_id` | uuid | yes |  |
| `service_id` | uuid | no |  |
| `package_name` | text | no |  |
| `price_cents` | integer | no |  |
| `duration_min` | integer | no |  |
| `status` | text | no | `'booked'::text` |
| `scheduled_start` | timestamp with time zone | no |  |
| `scheduled_end` | timestamp with time zone | no |  |
| `assigned_employee_id` | uuid | yes |  |
| `planned_bay_id` | uuid | yes |  |
| `bay_id` | uuid | yes |  |
| `source` | text | no | `'dashboard'::text` |
| `eta_minutes` | integer | yes |  |
| `eta_at` | timestamp with time zone | yes |  |
| `geo_checked_in_at` | timestamp with time zone | yes |  |
| `bay_prepped_at` | timestamp with time zone | yes |  |
| `arrived_at` | timestamp with time zone | yes |  |
| `cleaning_started_at` | timestamp with time zone | yes |  |
| `completed_at` | timestamp with time zone | yes |  |
| `pickup_state` | text | yes |  |
| `picked_up_at` | timestamp with time zone | yes |  |
| `ready_notified_at` | timestamp with time zone | yes |  |
| `canceled_at` | timestamp with time zone | yes |  |
| `cancel_reason` | text | yes |  |
| `no_show_at` | timestamp with time zone | yes |  |
| `notes` | text | yes |  |
| `special_instructions` | text | yes |  |
| `membership_id` | uuid | yes |  |
| `emergency_closure_id` | uuid | yes |  |
| `standing_series_id` | uuid | yes |  |
| `arrival_token_hash` | text | yes |  |
| `version` | integer | no | `1` |
| `created_by` | uuid | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |
| `arrival_token_expires_at` | timestamp with time zone | yes |  |

Primary key `(id)`. Unique `(seq)`. `(assigned_employee_id)` references `employees(id)` on delete set null. `(bay_id)` references `bays(id)`. `(created_by)` references `users(id)` on delete set null. `(customer_id)` references `customers(id)`. `(emergency_closure_id)` references `emergency_closures(id)`. `(location_id)` references `locations(id)` on delete cascade. `(planned_bay_id)` references `bays(id)`. `(service_id)` references `services(id)`. `(vehicle_id)` references `vehicles(id)`. 9 check constraints. Index `appointments_active_idx` `(status)` where `status = ANY (ARRAY['booked'::text, 'confirmed'::text, 'arrived'::text, 'cleaning'::text])`. Index `appointments_customer_idx` `(customer_id, scheduled_start DESC)`. Index `appointments_emergency_idx` `(emergency_closure_id)` where `emergency_closure_id IS NOT NULL`. Index `appointments_location_start_idx` `(location_id, scheduled_start)`. Index `appointments_location_status_start_idx` `(location_id, status, scheduled_start)`. Index `appointments_planned_bay_idx` `(planned_bay_id, scheduled_start)` where `planned_bay_id IS NOT NULL`. Unique index `uq_appointments_arrival_token` `(arrival_token_hash)` where `arrival_token_hash IS NOT NULL`. Unique index `uq_bay_occupied` `(bay_id)` where `status = 'cleaning'::text`.

#### `arrival_pings`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `appointment_id` | uuid | no |  |
| `at` | timestamp with time zone | no | `app_now()` |
| `lat` | numeric(9,6) | no |  |
| `lng` | numeric(9,6) | no |  |
| `accuracy_m` | integer | yes |  |
| `distance_m` | integer | no |  |
| `eta_min` | integer | yes |  |
| `declared` | boolean | no | `false` |
| `outcome` | text | no |  |
| `ping_key` | text | yes |  |
| `reply` | jsonb | no |  |

Primary key `(id)`. `(appointment_id)` references `appointments(id)` on delete cascade. `(location_id)` references `locations(id)` on delete cascade. 6 check constraints. Index `arrival_pings_appointment_idx` `(appointment_id, at DESC)`. Unique index `uq_arrival_ping_key` `(appointment_id, ping_key)` where `ping_key IS NOT NULL`.

#### `arrival_settings`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `location_id` | uuid | no |  |
| `enabled` | boolean | no | `true` |
| `radius_m` | smallint | no | `300` |
| `prep_at_min` | smallint | no | `15` |
| `auto_arrive` | boolean | no | `true` |
| `welcome` | boolean | no | `true` |
| `alert_crew` | boolean | no | `true` |
| `vip_first` | boolean | no | `true` |
| `version` | integer | no | `1` |
| `updated_by` | uuid | yes |  |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(location_id)`. `(location_id)` references `locations(id)` on delete cascade. `(updated_by)` references `users(id)` on delete set null. 2 check constraints.

#### `audit_log`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | bigint | no |  |
| `at` | timestamp with time zone | no | `app_now()` |
| `location_id` | uuid | no |  |
| `actor_user_id` | uuid | yes |  |
| `actor_employee_id` | uuid | yes |  |
| `actor_name` | text | yes |  |
| `actor_roles` | text | yes |  |
| `view_as_role_id` | uuid | yes |  |
| `action` | text | no |  |
| `entity_type` | text | no |  |
| `entity_id` | text | yes |  |
| `before` | jsonb | yes |  |
| `after` | jsonb | yes |  |
| `request_id` | text | yes |  |
| `idempotency_key` | text | yes |  |
| `ip` | inet | yes |  |

Primary key `(id)`. `(location_id)` references `locations(id)`. Index `audit_log_actor_idx` `(actor_user_id, id DESC)`. Index `audit_log_entity_idx` `(entity_type, entity_id, id DESC)`. Index `audit_log_location_at_idx` `(location_id, at DESC)`. Trigger: `audit_log_no_update_delete`.

#### `bays`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `number` | smallint | no |  |
| `name` | text | no |  |
| `status` | text | no | `'active'::text` |
| `sort` | integer | no | `0` |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(location_id, number)`. `(location_id)` references `locations(id)` on delete cascade. 3 check constraints.

#### `booking_rules`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `location_id` | uuid | no |  |
| `slot_minutes` | smallint | no | `30` |
| `buffer_minutes` | smallint | no | `10` |
| `cutoff_minutes` | smallint | no | `60` |
| `online_lead_minutes` | smallint | no | `30` |
| `allow_overrun` | boolean | no | `true` |
| `auto_plan_bay` | boolean | no | `true` |
| `version` | integer | no | `1` |
| `updated_by` | uuid | yes |  |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(location_id)`. `(location_id)` references `locations(id)` on delete cascade. `(updated_by)` references `users(id)` on delete set null. 4 check constraints.

#### `business_hours`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `location_id` | uuid | no |  |
| `weekday` | smallint | no |  |
| `is_open` | boolean | no |  |
| `open_min` | smallint | no |  |
| `close_min` | smallint | no |  |

Primary key `(location_id, weekday)`. `(location_id)` references `locations(id)` on delete cascade. 4 check constraints.

#### `checklist_tasks`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `service_id` | uuid | no |  |
| `label` | text | no |  |
| `position` | integer | no |  |
| `retired_at` | timestamp with time zone | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. `(service_id)` references `services(id)` on delete cascade. 2 check constraints. Index `checklist_tasks_service_idx` `(service_id, "position")` where `retired_at IS NULL`.

#### `closures`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `date` | date | no |  |
| `name` | text | no |  |
| `type` | text | no |  |
| `open_min` | smallint | yes |  |
| `close_min` | smallint | yes |  |
| `notify` | boolean | no | `true` |
| `source` | text | no | `'manual'::text` |
| `federal_key` | text | yes |  |
| `federal_year` | smallint | yes |  |
| `emergency_closure_id` | uuid | yes |  |
| `created_by` | uuid | yes |  |
| `deleted_at` | timestamp with time zone | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(location_id, federal_key, federal_year)`. `(created_by)` references `users(id)` on delete set null. `(emergency_closure_id)` references `emergency_closures(id)`. `(location_id)` references `locations(id)` on delete cascade. 7 check constraints. Index `closures_emergency_idx` `(emergency_closure_id)` where `emergency_closure_id IS NOT NULL`. Unique index `uq_closures_date_live` `(location_id, date)` where `deleted_at IS NULL`.

#### `credit_allocations`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `apply_event_id` | uuid | no |  |
| `lot_event_id` | uuid | no |  |
| `customer_id` | uuid | no |  |
| `cents` | integer | no |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(apply_event_id, lot_event_id)`. `(apply_event_id)` references `ledger_events(id)`. `(customer_id)` references `customers(id)`. `(lot_event_id)` references `ledger_events(id)`. 1 check constraint. Index `credit_allocations_customer_idx` `(customer_id)`. Index `credit_allocations_lot_idx` `(lot_event_id)`. Trigger: `credit_allocations_guard`.

#### `credit_expiries`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `lot_event_id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `customer_id` | uuid | no |  |
| `expired_cents` | integer | no |  |
| `expires_at` | timestamp with time zone | no |  |
| `recorded_at` | timestamp with time zone | no | `app_now()` |

Primary key `(lot_event_id)`. `(customer_id)` references `customers(id)`. `(location_id)` references `locations(id)` on delete cascade. `(lot_event_id)` references `ledger_events(id)`. 1 check constraint. Index `credit_expiries_customer_idx` `(customer_id)`.

#### `customers`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `full_name` | text | no |  |
| `phone_e164` | text | yes |  |
| `phone_display` | text | yes |  |
| `email` | citext | yes |  |
| `notes` | text | yes |  |
| `sms_opted_in` | boolean | no | `false` |
| `sms_opt_in_source` | text | yes |  |
| `sms_opt_in_at` | timestamp with time zone | yes |  |
| `sms_opted_out_at` | timestamp with time zone | yes |  |
| `email_bounced_at` | timestamp with time zone | yes |  |
| `source` | text | no | `'dashboard'::text` |
| `synthetic` | boolean | no | `false` |
| `needs_details` | boolean | no | `false` |
| `merged_into` | uuid | yes |  |
| `deleted_at` | timestamp with time zone | yes |  |
| `version` | integer | no | `1` |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. `(merged_into)` references `customers(id)`. 7 check constraints. Index `customers_email_trgm` `(((email)::text) public.gin_trgm_ops)`. Index `customers_full_name_trgm` `(full_name public.gin_trgm_ops)`. Index `customers_merged_into_idx` `(merged_into)` where `merged_into IS NOT NULL`. Index `customers_phone_trgm` `(phone_e164 public.gin_trgm_ops)`. Unique index `uq_customers_phone` `(phone_e164)` where `(phone_e164 IS NOT NULL) AND (merged_into IS NULL) AND (deleted_at IS NULL)`.

#### `email_suppressions`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `address` | text | no |  |
| `reason` | text | no |  |
| `bounce_type` | text | yes |  |
| `bounce_subtype` | text | yes |  |
| `complaint_feedback_type` | text | yes |  |
| `diagnostic` | text | yes |  |
| `first_seen_at` | timestamp with time zone | no |  |
| `last_seen_at` | timestamp with time zone | no |  |
| `count` | integer | no | `1` |
| `source_message_ids` | text[] | no | `'{}'::text[]` |
| `cleared_at` | timestamp with time zone | yes |  |
| `cleared_by` | uuid | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(address)`. `(cleared_by)` references `users(id)` on delete set null. 3 check constraints. Index `email_suppressions_active_idx` `(last_seen_at DESC)` where `cleared_at IS NULL`.

#### `emergency_closures`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `active` | boolean | no | `true` |
| `reason` | text | no |  |
| `duration_kind` | text | no |  |
| `until_min` | smallint | yes |  |
| `through_date` | date | yes |  |
| `ends_at` | timestamp with time zone | yes |  |
| `message` | text | no | `''::text` |
| `notify` | boolean | no | `true` |
| `link` | boolean | no | `true` |
| `credits` | boolean | no | `true` |
| `pause` | boolean | no | `true` |
| `crew` | boolean | no | `true` |
| `summary` | text | no | `''::text` |
| `started_at` | timestamp with time zone | no | `app_now()` |
| `started_by` | uuid | yes |  |
| `started_by_name` | text | yes |  |
| `reopened_at` | timestamp with time zone | yes |  |
| `reopened_by` | uuid | yes |  |
| `reopened_by_name` | text | yes |  |
| `auto_reopened` | boolean | no | `false` |
| `affected_count` | integer | no | `0` |
| `notified_count` | integer | no | `0` |
| `rebooked_count` | integer | no | `0` |
| `detail` | text | yes |  |
| `replaced_closure_ids` | uuid[] | no | `'{}'::uuid[]` |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. `(location_id)` references `locations(id)` on delete cascade. `(reopened_by)` references `users(id)` on delete set null. `(started_by)` references `users(id)` on delete set null. 8 check constraints. Index `emergency_closures_history_idx` `(location_id, started_at DESC)`. Unique index `uq_emergency_one_active` `(location_id)` where `active`.

#### `emergency_notifications`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `emergency_closure_id` | uuid | no |  |
| `appointment_id` | uuid | no |  |
| `customer_id` | uuid | no |  |
| `message_id` | uuid | yes |  |
| `channel` | text | no |  |
| `state` | text | no |  |
| `reschedule_link_id` | uuid | yes |  |
| `rebooked_at` | timestamp with time zone | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(emergency_closure_id, appointment_id)`. `(appointment_id)` references `appointments(id)` on delete cascade. `(customer_id)` references `customers(id)`. `(emergency_closure_id)` references `emergency_closures(id)` on delete cascade. `(reschedule_link_id)` references `reschedule_links(id)`. 2 check constraints. Index `emergency_notifications_state_idx` `(emergency_closure_id, state)`.

#### `employee_locations`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `employee_id` | uuid | no |  |
| `location_id` | uuid | no |  |

Primary key `(employee_id, location_id)`. `(employee_id)` references `employees(id)` on delete cascade. `(location_id)` references `locations(id)` on delete cascade. Index `employee_locations_location_idx` `(location_id)`.

#### `employee_permission_overrides`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `employee_id` | uuid | no |  |
| `permission_key` | text | no |  |
| `effect` | text | no |  |

Primary key `(employee_id, permission_key)`. `(employee_id)` references `employees(id)` on delete cascade. `(permission_key)` references `permissions(key)`. 1 check constraint.

#### `employee_roles`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `employee_id` | uuid | no |  |
| `role_id` | uuid | no |  |

Primary key `(employee_id, role_id)`. `(employee_id)` references `employees(id)` on delete cascade. `(role_id)` references `roles(id)` on delete cascade. Index `employee_roles_role_idx` `(role_id)`.

#### `employee_schedules`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `employee_id` | uuid | no |  |
| `weekday` | smallint | no |  |
| `is_on` | boolean | no | `false` |
| `from_min` | smallint | no |  |
| `to_min` | smallint | no |  |

Primary key `(employee_id, weekday)`. `(employee_id)` references `employees(id)` on delete cascade. 4 check constraints.

#### `employees`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `first` | text | no |  |
| `last` | text | no | `''::text` |
| `title` | text | no | `''::text` |
| `phone` | text | no | `''::text` |
| `phone_e164` | text | yes |  |
| `email` | citext | yes |  |
| `status` | text | no | `'invited'::text` |
| `employment_type` | text | no | `'full_time'::text` |
| `pay_type` | text | no | `'hourly'::text` |
| `rate_text` | text | no | `''::text` |
| `skills` | text[] | no | `'{}'::text[]` |
| `avatar_color` | text | yes |  |
| `version` | integer | no | `1` |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |
| `deactivated_at` | timestamp with time zone | yes |  |

Primary key `(id)`. Unique `(email)`. 6 check constraints. Index `employees_phone_e164_idx` `(phone_e164)` where `phone_e164 IS NOT NULL`. Index `employees_status_idx` `(status)`.

#### `federal_holiday_runs`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `location_id` | uuid | no |  |
| `year` | smallint | no |  |
| `ran_at` | timestamp with time zone | no | `app_now()` |

Primary key `(location_id, year)`. `(location_id)` references `locations(id)` on delete cascade.

#### `idempotency_keys`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `key` | text | no |  |
| `actor` | text | no |  |
| `method` | text | no |  |
| `route` | text | no |  |
| `request_hash` | text | no |  |
| `state` | text | no |  |
| `response_status` | smallint | yes |  |
| `response_body` | jsonb | yes |  |
| `response_headers` | jsonb | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `lock_expires_at` | timestamp with time zone | no |  |
| `expires_at` | timestamp with time zone | no |  |

Primary key `(key, actor)`. 1 check constraint. Index `idempotency_keys_expires_idx` `(expires_at)`.

#### `invites`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `employee_id` | uuid | no |  |
| `token_hash` | text | no |  |
| `channel` | text | no | `'sms'::text` |
| `expires_at` | timestamp with time zone | no |  |
| `accepted_at` | timestamp with time zone | yes |  |
| `revoked_at` | timestamp with time zone | yes |  |
| `created_by` | uuid | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(token_hash)`. `(employee_id)` references `employees(id)` on delete cascade. 1 check constraint. Index `invites_employee_idx` `(employee_id)`.

#### `invoice_counters`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `location_id` | uuid | no |  |
| `next_no` | integer | no | `20611` |

Primary key `(location_id)`. `(location_id)` references `locations(id)` on delete cascade. 1 check constraint.

#### `invoice_items`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `invoice_id` | uuid | no |  |
| `position` | integer | no |  |
| `kind` | text | no |  |
| `service_id` | uuid | yes |  |
| `name` | text | no |  |
| `price_cents` | integer | no |  |
| `appointment_addon_id` | uuid | yes |  |

Primary key `(id)`. `(appointment_addon_id)` references `appointment_addons(id)`. `(invoice_id)` references `invoices(id)` on delete cascade. `(service_id)` references `services(id)`. 4 check constraints. Index `invoice_items_invoice_idx` `(invoice_id, "position")`.

#### `invoices`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `invoice_no` | integer | no |  |
| `appointment_id` | uuid | yes |  |
| `customer_id` | uuid | no |  |
| `client_name` | text | no |  |
| `vehicle_label` | text | no | `''::text` |
| `staff_label` | text | no | `'Unassigned'::text` |
| `occurred_at` | timestamp with time zone | no |  |
| `biz_date` | date | no |  |
| `date_frozen_at` | timestamp with time zone | yes |  |
| `tax_bp` | integer | no |  |
| `tip_cents` | integer | no | `0` |
| `canceled_at` | timestamp with time zone | yes |  |
| `canceled_by` | uuid | yes |  |
| `canceled_by_name` | text | yes |  |
| `cancel_reason` | text | yes |  |
| `payment_link_url` | text | yes |  |
| `payment_link_sent_at` | timestamp with time zone | yes |  |
| `version` | integer | no | `1` |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(appointment_id)`. Unique `(location_id, invoice_no)`. `(appointment_id)` references `appointments(id)`. `(canceled_by)` references `users(id)` on delete set null. `(customer_id)` references `customers(id)`. `(location_id)` references `locations(id)` on delete cascade. 6 check constraints. Index `invoices_biz_date_idx` `(location_id, biz_date DESC, invoice_no DESC)`. Index `invoices_customer_idx` `(customer_id, biz_date DESC)`.

#### `job_checklist_items`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `appointment_id` | uuid | no |  |
| `section_kind` | text | no |  |
| `section_title` | text | no |  |
| `source_task_id` | uuid | yes |  |
| `appointment_addon_id` | uuid | yes |  |
| `label` | text | no |  |
| `position` | integer | no |  |
| `done` | boolean | no | `false` |
| `done_at` | timestamp with time zone | yes |  |
| `done_by_employee_id` | uuid | yes |  |
| `removed_at` | timestamp with time zone | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. `(appointment_addon_id)` references `appointment_addons(id)` on delete set null. `(appointment_id)` references `appointments(id)` on delete cascade. `(done_by_employee_id)` references `employees(id)` on delete set null. `(source_task_id)` references `checklist_tasks(id)` on delete set null. 5 check constraints. Index `job_checklist_items_appointment_idx` `(appointment_id, "position")`. Index `job_checklist_items_task_idx` `(source_task_id)` where `source_task_id IS NOT NULL`.

#### `job_runs`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `name` | text | no |  |
| `runs` | bigint | no | `0` |
| `failures` | bigint | no | `0` |
| `consecutive_failures` | integer | no | `0` |
| `last_job_id` | text | yes |  |
| `last_attempt` | integer | no | `1` |
| `last_outcome` | text | no |  |
| `last_started_at` | timestamp with time zone | no |  |
| `last_finished_at` | timestamp with time zone | yes |  |
| `last_success_at` | timestamp with time zone | yes |  |
| `last_error_at` | timestamp with time zone | yes |  |
| `last_error` | text | yes |  |
| `last_duration_ms` | integer | yes |  |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(name)`. 1 check constraint.

#### `ledger_events`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `seq` | bigint | no |  |
| `location_id` | uuid | no |  |
| `invoice_id` | uuid | no |  |
| `customer_id` | uuid | no |  |
| `type` | text | no |  |
| `amount_cents` | integer | no |  |
| `status` | text | no | `'done'::text` |
| `method` | text | yes |  |
| `method_kind` | text | yes |  |
| `brand` | text | yes |  |
| `last4` | text | yes |  |
| `dest` | text | yes |  |
| `deposit` | boolean | no | `false` |
| `reason` | text | yes |  |
| `note` | text | yes |  |
| `expiry` | text | yes |  |
| `expires_at` | timestamp with time zone | yes |  |
| `item_ids` | uuid[] | no | `'{}'::uuid[]` |
| `parent_event_id` | uuid | yes |  |
| `voids_event_id` | uuid | yes |  |
| `actor_user_id` | uuid | yes |  |
| `actor_employee_id` | uuid | yes |  |
| `actor_name` | text | yes |  |
| `actor_roles` | text | yes |  |
| `view_as_role_id` | uuid | yes |  |
| `approved_by_user_id` | uuid | yes |  |
| `approved_by_employee_id` | uuid | yes |  |
| `approved_by_name` | text | yes |  |
| `approved_by_roles` | text | yes |  |
| `approved_at` | timestamp with time zone | yes |  |
| `denied_by_user_id` | uuid | yes |  |
| `denied_by_employee_id` | uuid | yes |  |
| `denied_by_name` | text | yes |  |
| `denied_by_roles` | text | yes |  |
| `denied_at` | timestamp with time zone | yes |  |
| `denied_note` | text | yes |  |
| `occurred_at` | timestamp with time zone | no |  |
| `resolved_at` | timestamp with time zone | yes |  |
| `source` | text | no | `'oasis'::text` |
| `processor_state` | text | no | `'na'::text` |
| `processor_ref` | text | yes |  |
| `sqsp_order_id` | text | yes |  |
| `processor_confirmed_at` | timestamp with time zone | yes |  |
| `processor_confirmed_by` | text | yes |  |
| `needs_review` | boolean | no | `false` |
| `idempotency_key` | text | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(idempotency_key)`. Unique `(seq)`. `(actor_employee_id)` references `employees(id)` on delete set null. `(actor_user_id)` references `users(id)` on delete set null. `(approved_by_employee_id)` references `employees(id)` on delete set null. `(approved_by_user_id)` references `users(id)` on delete set null. `(customer_id)` references `customers(id)`. `(denied_by_employee_id)` references `employees(id)` on delete set null. `(denied_by_user_id)` references `users(id)` on delete set null. `(invoice_id)` references `invoices(id)`. `(location_id)` references `locations(id)` on delete cascade. `(parent_event_id)` references `ledger_events(id)`. `(voids_event_id)` references `ledger_events(id)`. 19 check constraints. Index `ledger_events_awaiting_idx` `(location_id, occurred_at)` where `processor_state = 'awaiting_processor'::text`. Index `ledger_events_customer_idx` `(customer_id, type, occurred_at)`. Index `ledger_events_invoice_idx` `(invoice_id, occurred_at DESC, seq DESC)`. Index `ledger_events_pending_idx` `(location_id, occurred_at)` where `status = 'pending'::text`. Index `ledger_events_sqsp_order_idx` `(sqsp_order_id)` where `sqsp_order_id IS NOT NULL`. Trigger: `ledger_events_guard`.

#### `ledger_integrity_runs`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `check_date` | date | no |  |
| `started_at` | timestamp with time zone | no |  |
| `finished_at` | timestamp with time zone | no |  |
| `ok` | boolean | no |  |
| `invoices_checked` | integer | no |  |
| `findings` | jsonb | no | `'[]'::jsonb` |
| `job_id` | text | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(location_id, check_date)`. `(location_id)` references `locations(id)` on delete cascade. 1 check constraint.

#### `locations`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `name` | text | no |  |
| `slug` | text | no |  |
| `timezone` | text | no | `'America/New_York'::text` |
| `address` | text | yes |  |
| `lat` | numeric(9,6) | yes |  |
| `lng` | numeric(9,6) | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(slug)`. 3 check constraints.

#### `membership_credit_events`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `membership_id` | uuid | no |  |
| `cycle_start` | timestamp with time zone | no |  |
| `kind` | text | no |  |
| `qty` | smallint | yes |  |
| `rule_id` | uuid | yes |  |
| `appointment_id` | uuid | yes |  |
| `invoice_id` | uuid | yes |  |
| `ledger_event_id` | uuid | yes |  |
| `note` | text | yes |  |
| `actor` | text | yes |  |
| `actor_user_id` | uuid | yes |  |
| `idempotency_key` | text | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(idempotency_key)`. `(actor_user_id)` references `users(id)` on delete set null. `(appointment_id)` references `appointments(id)`. `(invoice_id)` references `invoices(id)`. `(ledger_event_id)` references `ledger_events(id)`. `(membership_id)` references `memberships(id)` on delete cascade. `(rule_id)` references `plan_credit_rules(id)` on delete set null. 3 check constraints. Index `membership_credit_events_cycle_idx` `(membership_id, cycle_start)`. Unique index `uq_credit_redeem_appointment` `(appointment_id)` where `(kind = 'redeem'::text) AND (appointment_id IS NOT NULL)`.

#### `membership_plans`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `key` | text | no |  |
| `name` | text | no |  |
| `color` | text | no |  |
| `bg_color` | text | no |  |
| `tint` | text | no |  |
| `sort` | integer | no | `0` |
| `perks` | text[] | no | `'{}'::text[]` |
| `addon_discount_bp` | integer | no | `0` |
| `service_discount_bp` | integer | no | `0` |
| `billing_interval_months` | integer | no | `1` |
| `active` | boolean | no | `true` |
| `version` | integer | no | `1` |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(location_id, key)`. `(location_id)` references `locations(id)` on delete cascade. 5 check constraints.

#### `memberships`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `customer_id` | uuid | no |  |
| `plan_id` | uuid | no |  |
| `plan_label` | text | no |  |
| `status` | text | no |  |
| `source` | text | no |  |
| `sqsp_subscription_ref` | text | yes |  |
| `sqsp_customer_id` | text | yes |  |
| `sqsp_product_key` | text | yes |  |
| `started_at` | timestamp with time zone | no |  |
| `current_period_start` | timestamp with time zone | yes |  |
| `current_period_end` | timestamp with time zone | yes |  |
| `canceled_at` | timestamp with time zone | yes |  |
| `cancel_reason` | text | yes |  |
| `last_sqsp_order_id` | text | yes |  |
| `last_paid_at` | timestamp with time zone | yes |  |
| `paid_order_count` | integer | no | `0` |
| `in_grace` | boolean | no | `false` |
| `manual_status_at` | timestamp with time zone | yes |  |
| `review_flags` | jsonb | no | `'[]'::jsonb` |
| `inference_reason` | text | yes |  |
| `auto_apply` | boolean | no | `false` |
| `last_synced_at` | timestamp with time zone | yes |  |
| `version` | integer | no | `1` |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. `(customer_id)` references `customers(id)`. `(location_id)` references `locations(id)` on delete cascade. `(plan_id)` references `membership_plans(id)`. 4 check constraints. Index `memberships_plan_idx` `(plan_id)`. Index `memberships_status_idx` `(location_id, status)`. Unique index `uq_memberships_customer_live` `(customer_id)` where `status = ANY (ARRAY['pending'::text, 'active'::text, 'past_due'::text, 'paused'::text])`.

#### `message_threads`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `customer_id` | uuid | no |  |
| `last_message_at` | timestamp with time zone | yes |  |
| `last_inbound_at` | timestamp with time zone | yes |  |
| `unread_count` | integer | no | `0` |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(location_id, customer_id)`. `(customer_id)` references `customers(id)`. `(location_id)` references `locations(id)` on delete cascade. 1 check constraint. Index `message_threads_unread_idx` `(location_id, last_inbound_at DESC)` where `unread_count > 0`.

#### `messages`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `thread_id` | uuid | yes |  |
| `customer_id` | uuid | yes |  |
| `employee_id` | uuid | yes |  |
| `appointment_id` | uuid | yes |  |
| `direction` | text | no |  |
| `sender_kind` | text | no |  |
| `sender_employee_id` | uuid | yes |  |
| `channel` | text | no | `'sms'::text` |
| `body` | text | no |  |
| `template_key` | text | yes |  |
| `purpose` | text | yes |  |
| `klass` | text | yes |  |
| `status` | text | no |  |
| `peer_e164` | text | yes |  |
| `provider_message_id` | text | yes |  |
| `device_id` | uuid | yes |  |
| `error` | text | yes |  |
| `segments` | smallint | no | `1` |
| `encoding` | text | yes |  |
| `idempotency_key` | text | yes |  |
| `queued_at` | timestamp with time zone | no | `app_now()` |
| `sent_at` | timestamp with time zone | yes |  |
| `delivered_at` | timestamp with time zone | yes |  |
| `received_at` | timestamp with time zone | yes |  |
| `read_at` | timestamp with time zone | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(idempotency_key)`. `(appointment_id)` references `appointments(id)` on delete set null. `(customer_id)` references `customers(id)`. `(device_id)` references `sms_devices(id)` on delete set null. `(employee_id)` references `employees(id)` on delete set null. `(location_id)` references `locations(id)` on delete cascade. `(sender_employee_id)` references `employees(id)` on delete set null. `(thread_id)` references `message_threads(id)` on delete cascade. 8 check constraints. Index `messages_appointment_idx` `(appointment_id, queued_at, id)` where `appointment_id IS NOT NULL`. Index `messages_customer_idx` `(customer_id, queued_at DESC)` where `customer_id IS NOT NULL`. Index `messages_in_flight_idx` `(status)` where `status = ANY (ARRAY['queued'::text, 'sending'::text])`. Index `messages_provider_idx` `(provider_message_id)` where `provider_message_id IS NOT NULL`. Index `messages_thread_idx` `(thread_id, queued_at, id)` where `thread_id IS NOT NULL`. Index `messages_unread_idx` `(customer_id)` where `(direction = 'in'::text) AND (read_at IS NULL)`.

#### `notice_debounce`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `location_id` | uuid | no |  |
| `key` | text | no |  |
| `state` | text | yes |  |
| `last_sent_at` | timestamp with time zone | yes |  |
| `suppressed` | integer | no | `0` |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(location_id, key)`. `(location_id)` references `locations(id)` on delete cascade. 1 check constraint.

#### `notifications`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `employee_id` | uuid | yes |  |
| `role_target` | text | yes |  |
| `kind` | text | no |  |
| `title` | text | no |  |
| `body` | text | yes |  |
| `entity_type` | text | yes |  |
| `entity_id` | text | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `read_at` | timestamp with time zone | yes |  |

Primary key `(id)`. `(location_id)` references `locations(id)` on delete cascade. 1 check constraint. Index `notifications_location_idx` `(location_id, created_at DESC)`. Index `notifications_unread_idx` `(employee_id)` where `read_at IS NULL`.

#### `ops_alert_state`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `location_id` | uuid | no |  |
| `alerts_hash` | text | no |  |
| `alert_keys` | text[] | no | `'{}'::text[]` |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(location_id)`. `(location_id)` references `locations(id)` on delete cascade.

#### `outbox_emails`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `customer_id` | uuid | yes |  |
| `employee_id` | uuid | yes |  |
| `to_email` | text | no |  |
| `template` | text | no |  |
| `vars` | jsonb | no | `'{}'::jsonb` |
| `purpose` | text | yes |  |
| `subject` | text | yes |  |
| `body` | text | yes |  |
| `state` | text | no | `'pending'::text` |
| `attempts` | integer | no | `0` |
| `next_attempt_at` | timestamp with time zone | yes |  |
| `locked_at` | timestamp with time zone | yes |  |
| `provider_message_id` | text | yes |  |
| `error` | text | yes |  |
| `dedupe_key` | text | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `sent_at` | timestamp with time zone | yes |  |
| `appointment_id` | uuid | yes |  |
| `error_at` | timestamp with time zone | yes |  |
| `delivered_at` | timestamp with time zone | yes |  |
| `feedback` | text | yes |  |
| `feedback_at` | timestamp with time zone | yes |  |
| `feedback_detail` | text | yes |  |

Primary key `(id)`. Unique `(dedupe_key)`. `(appointment_id)` references `appointments(id)` on delete set null. `(customer_id)` references `customers(id)`. `(employee_id)` references `employees(id)` on delete set null. `(location_id)` references `locations(id)` on delete cascade. 3 check constraints. Index `outbox_emails_drain_idx` `(state, next_attempt_at)` where `state = ANY (ARRAY['pending'::text, 'sending'::text])`. Index `outbox_emails_provider_message_idx` `(provider_message_id)` where `provider_message_id IS NOT NULL`.

#### `password_resets`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `user_id` | uuid | no |  |
| `token_hash` | text | no |  |
| `expires_at` | timestamp with time zone | no |  |
| `used_at` | timestamp with time zone | yes |  |
| `requested_by` | uuid | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(token_hash)`. `(user_id)` references `users(id)` on delete cascade. Index `password_resets_user_idx` `(user_id, created_at DESC)`.

#### `payment_links`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `invoice_id` | uuid | no |  |
| `kind` | text | no | `'checkout'::text` |
| `purpose` | text | no | `'balance'::text` |
| `url` | text | no |  |
| `expected_cents` | integer | no |  |
| `created_by` | uuid | yes |  |
| `sent_message_id` | uuid | yes |  |
| `sent_at` | timestamp with time zone | yes |  |
| `expires_at` | timestamp with time zone | yes |  |
| `state` | text | no | `'active'::text` |
| `matched_sqsp_order_id` | text | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. `(created_by)` references `users(id)` on delete set null. `(invoice_id)` references `invoices(id)`. `(location_id)` references `locations(id)` on delete cascade. 5 check constraints. Index `payment_links_active_idx` `(location_id, created_at)` where `state = 'active'::text`. Index `payment_links_invoice_idx` `(invoice_id, created_at DESC)`.

#### `permissions`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `key` | text | no |  |
| `module` | text | no |  |
| `label` | text | no |  |
| `has_limit` | boolean | no | `false` |
| `sort` | smallint | no |  |

Primary key `(key)`. Unique `(sort)`.

#### `plan_credit_rules`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `plan_id` | uuid | no |  |
| `label` | text | no |  |
| `include_tags` | text[] | no |  |
| `exclude_tags` | text[] | no | `'{}'::text[]` |
| `per_cycle` | integer | yes |  |
| `sort` | integer | no | `0` |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `auto_apply` | boolean | no | `false` |

Primary key `(id)`. `(plan_id)` references `membership_plans(id)` on delete cascade. 3 check constraints. Index `plan_credit_rules_plan_idx` `(plan_id, sort)`.

#### `rbac_state`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | boolean | no | `true` |
| `version` | bigint | no | `1` |

Primary key `(id)`. 1 check constraint.

#### `realtime_events`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | bigint | no |  |
| `at` | timestamp with time zone | no | `app_now()` |
| `location_id` | uuid | no |  |
| `channel` | text | no |  |
| `type` | text | no |  |
| `payload` | jsonb | no | `'{}'::jsonb` |
| `target_user_id` | uuid | yes |  |

Primary key `(id)`. `(location_id)` references `locations(id)` on delete cascade. Index `realtime_events_at_idx` `(at)`. Index `realtime_events_location_idx` `(location_id, id)`. Trigger: `realtime_events_notify`.

#### `realtime_state`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | boolean | no | `true` |
| `purged_through` | bigint | no | `0` |

Primary key `(id)`. 1 check constraint.

#### `reschedule_links`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `code` | text | no |  |
| `appointment_id` | uuid | no |  |
| `emergency_closure_id` | uuid | yes |  |
| `closure_id` | uuid | yes |  |
| `expires_at` | timestamp with time zone | no |  |
| `used_at` | timestamp with time zone | yes |  |
| `result_appointment_id` | uuid | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(code)`. `(appointment_id)` references `appointments(id)` on delete cascade. `(closure_id)` references `closures(id)`. `(emergency_closure_id)` references `emergency_closures(id)`. `(result_appointment_id)` references `appointments(id)`. 1 check constraint. Index `reschedule_links_appointment_idx` `(appointment_id)`. Index `reschedule_links_emergency_idx` `(emergency_closure_id)` where `emergency_closure_id IS NOT NULL`.

#### `role_limits`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `role_id` | uuid | no |  |
| `kind` | text | no |  |
| `unlimited` | boolean | no | `false` |
| `limit_cents` | bigint | yes |  |

Primary key `(role_id, kind)`. `(role_id)` references `roles(id)` on delete cascade. 2 check constraints.

#### `role_permissions`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `role_id` | uuid | no |  |
| `permission_key` | text | no |  |

Primary key `(role_id, permission_key)`. `(permission_key)` references `permissions(key)`. `(role_id)` references `roles(id)` on delete cascade. Index `role_permissions_key_idx` `(permission_key)`.

#### `roles`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `key` | text | yes |  |
| `name` | text | no |  |
| `description` | text | no | `''::text` |
| `is_locked` | boolean | no | `false` |
| `is_custom` | boolean | no | `false` |
| `version` | integer | no | `1` |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(key)`. 4 check constraints. Unique index `roles_name_lower_idx` `(lower(name))`. Unique index `roles_one_locked_idx` `(is_locked)` where `is_locked`.

#### `schema_migrations`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `name` | text | no |  |
| `checksum` | text | no |  |
| `applied_at` | timestamp with time zone | no |  |

Primary key `(name)`.

#### `services`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `kind` | text | no |  |
| `name` | text | no |  |
| `short_name` | text | yes |  |
| `price_cents` | integer | no |  |
| `duration_min` | integer | no |  |
| `tags` | text[] | no | `'{}'::text[]` |
| `bookable_desk` | boolean | no | `true` |
| `sort` | integer | no | `0` |
| `active` | boolean | no | `true` |
| `sqsp_sku` | text | yes |  |
| `version` | integer | no | `1` |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. `(location_id)` references `locations(id)` on delete cascade. 5 check constraints. Index `services_listing_idx` `(location_id, kind, sort, id)`. Unique index `uq_services_name` `(location_id, kind, lower(name))`.

#### `sessions`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | text | no |  |
| `user_id` | uuid | no |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `last_seen_at` | timestamp with time zone | no | `app_now()` |
| `idle_expires_at` | timestamp with time zone | no |  |
| `absolute_expires_at` | timestamp with time zone | no |  |
| `ip` | inet | yes |  |
| `ua` | text | yes |  |
| `csrf_secret` | text | no |  |
| `view_as_role_id` | uuid | yes |  |
| `revoked_at` | timestamp with time zone | yes |  |

Primary key `(id)`. `(user_id)` references `users(id)` on delete cascade. `(view_as_role_id)` references `roles(id)` on delete set null. 2 check constraints. Index `sessions_absolute_idx` `(absolute_expires_at)`. Index `sessions_user_idx` `(user_id)` where `revoked_at IS NULL`.

#### `settings`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `location_id` | uuid | no |  |
| `key` | text | no |  |
| `value` | jsonb | no |  |
| `version` | integer | no | `1` |
| `updated_by` | uuid | yes |  |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(location_id, key)`. `(location_id)` references `locations(id)` on delete cascade.

#### `sms_devices`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `device_key` | text | no |  |
| `label` | text | no |  |
| `provider` | text | no | `'smsgate'::text` |
| `base_url` | text | yes |  |
| `username` | text | yes |  |
| `password_enc` | text | yes |  |
| `webhook_secret_enc` | text | no |  |
| `remote_device_id` | text | yes |  |
| `sim_slot_default` | smallint | yes |  |
| `min_interval_ms` | integer | yes |  |
| `max_per_window` | integer | yes |  |
| `window_minutes` | integer | yes |  |
| `enabled` | boolean | no | `true` |
| `status` | text | no | `'unknown'::text` |
| `state_changed_at` | timestamp with time zone | yes |  |
| `last_seen_at` | timestamp with time zone | yes |  |
| `last_ping_at` | timestamp with time zone | yes |  |
| `last_app_started_at` | timestamp with time zone | yes |  |
| `last_poll_ok_at` | timestamp with time zone | yes |  |
| `consecutive_poll_failures` | integer | no | `0` |
| `health_status` | text | yes |  |
| `battery` | smallint | yes |  |
| `charging` | boolean | yes |  |
| `last_health` | jsonb | yes |  |
| `last_error` | text | yes |  |
| `webhooks_url` | text | yes |  |
| `webhooks_registered_at` | timestamp with time zone | yes |  |
| `sent_count` | bigint | no | `0` |
| `delivered_count` | bigint | no | `0` |
| `failed_count` | bigint | no | `0` |
| `received_count` | bigint | no | `0` |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(device_key)`. `(location_id)` references `locations(id)` on delete cascade. 13 check constraints. Index `sms_devices_location_idx` `(location_id, enabled, created_at)`.

#### `sms_inbox`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `device_id` | uuid | no |  |
| `provider_message_id` | text | no |  |
| `from_raw` | text | no |  |
| `from_e164` | text | yes |  |
| `body` | text | no |  |
| `device_received_at` | timestamp with time zone | no |  |
| `received_at` | timestamp with time zone | no | `app_now()` |
| `processed_at` | timestamp with time zone | yes |  |
| `decision` | text | yes |  |
| `quarantined` | boolean | no | `false` |
| `customer_id` | uuid | yes |  |
| `appointment_id` | uuid | yes |  |
| `message_id` | uuid | yes |  |
| `reviewed_at` | timestamp with time zone | yes |  |

Primary key `(id)`. Unique `(device_id, provider_message_id)`. `(appointment_id)` references `appointments(id)` on delete set null. `(customer_id)` references `customers(id)`. `(device_id)` references `sms_devices(id)` on delete cascade. `(message_id)` references `messages(id)` on delete set null. 1 check constraint. Index `sms_inbox_from_idx` `(from_e164)` where `from_e164 IS NOT NULL`. Index `sms_inbox_quarantine_idx` `(received_at DESC)` where `quarantined AND (reviewed_at IS NULL)`.

#### `sms_opt_outs`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `phone_e164` | text | no |  |
| `opted_out_at` | timestamp with time zone | no |  |
| `source` | text | no |  |
| `keyword` | text | yes |  |
| `inbound_message_id` | uuid | yes |  |
| `opted_out_by` | uuid | yes |  |
| `opted_in_again_at` | timestamp with time zone | yes |  |

Primary key `(id)`. `(inbound_message_id)` references `sms_inbox(id)` on delete set null. `(location_id)` references `locations(id)` on delete cascade. `(opted_out_by)` references `users(id)` on delete set null. 3 check constraints. Index `sms_opt_outs_phone_idx` `(phone_e164, opted_out_at DESC)`. Unique index `uq_sms_opt_outs_active` `(location_id, phone_e164)` where `opted_in_again_at IS NULL`.

#### `sms_outbox`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `message_id` | uuid | no |  |
| `to_e164` | text | no |  |
| `body` | text | no |  |
| `encoding` | text | no |  |
| `segments` | smallint | no |  |
| `klass` | text | no |  |
| `priority` | smallint | no |  |
| `state` | text | no | `'pending'::text` |
| `attempts` | integer | no | `0` |
| `device_failures` | integer | no | `0` |
| `reconcile_resends` | integer | no | `0` |
| `next_attempt_at` | timestamp with time zone | yes |  |
| `locked_at` | timestamp with time zone | yes |  |
| `provider_message_id` | text | yes |  |
| `device_id` | uuid | yes |  |
| `sim_slot` | smallint | yes |  |
| `last_error` | text | yes |  |
| `queued_at` | timestamp with time zone | no | `app_now()` |
| `ttl_at` | timestamp with time zone | no |  |
| `hold_until` | timestamp with time zone | yes |  |
| `accepted_at` | timestamp with time zone | yes |  |
| `sent_at` | timestamp with time zone | yes |  |
| `delivered_at` | timestamp with time zone | yes |  |
| `failed_at` | timestamp with time zone | yes |  |
| `last_reconciled_at` | timestamp with time zone | yes |  |
| `fallback_emailed_at` | timestamp with time zone | yes |  |

Primary key `(id)`. Unique `(message_id)`. `(device_id)` references `sms_devices(id)` on delete set null. `(message_id)` references `messages(id)` on delete cascade. 6 check constraints. Index `sms_outbox_drain_idx` `(state, priority, next_attempt_at)`. Index `sms_outbox_provider_idx` `(provider_message_id)` where `provider_message_id IS NOT NULL`. Index `sms_outbox_to_idx` `(to_e164)`. Index `sms_outbox_unconfirmed_idx` `(accepted_at)` where `state = ANY (ARRAY['accepted'::text, 'sent'::text])`.

#### `sms_processed_events`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `event_id` | text | no |  |
| `processed_at` | timestamp with time zone | no | `app_now()` |

Primary key `(event_id)`.

#### `sms_usage`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | bigint | no |  |
| `device_id` | uuid | yes |  |
| `provider_message_id` | text | no |  |
| `segments` | smallint | no |  |
| `accepted_at` | timestamp with time zone | no |  |
| `sent_at` | timestamp with time zone | yes |  |

Primary key `(id)`. `(device_id)` references `sms_devices(id)` on delete cascade. 1 check constraint. Index `sms_usage_provider_idx` `(provider_message_id)`. Index `sms_usage_window_idx` `(device_id, COALESCE(sent_at, accepted_at))`.

#### `sqsp_alerts`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `dedupe_key` | text | no |  |
| `code` | text | no |  |
| `sqsp_order_id` | text | yes |  |
| `sqsp_txn_id` | text | yes |  |
| `invoice_id` | uuid | yes |  |
| `message` | text | no |  |
| `variance` | jsonb | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `resolved_at` | timestamp with time zone | yes |  |
| `resolved_by` | uuid | yes |  |

Primary key `(id)`. Unique `(location_id, dedupe_key)`. `(invoice_id)` references `invoices(id)`. `(location_id)` references `locations(id)` on delete cascade. `(resolved_by)` references `users(id)` on delete set null. Index `sqsp_alerts_open_idx` `(location_id, created_at DESC)` where `resolved_at IS NULL`.

#### `sqsp_connections`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `auth_kind` | text | no | `'api_key'::text` |
| `api_key_enc` | text | yes |  |
| `site_id` | text | yes |  |
| `client_id` | text | yes |  |
| `client_secret_enc` | text | yes |  |
| `access_token_enc` | text | yes |  |
| `refresh_token_enc` | text | yes |  |
| `token_expires_at` | timestamp with time zone | yes |  |
| `scopes` | text[] | no | `'{}'::text[]` |
| `status` | text | no | `'connected'::text` |
| `last_error` | text | yes |  |
| `last_verified_at` | timestamp with time zone | yes |  |
| `created_by` | uuid | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(location_id)`. `(created_by)` references `users(id)` on delete set null. `(location_id)` references `locations(id)` on delete cascade. 2 check constraints.

#### `sqsp_contacts`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `sqsp_contact_id` | text | no |  |
| `email` | text | yes |  |
| `name` | text | yes |  |
| `phone` | text | yes |  |
| `created_on` | timestamp with time zone | yes |  |
| `payload_hash` | text | no |  |
| `synced_at` | timestamp with time zone | no |  |

Primary key `(id)`. Unique `(location_id, sqsp_contact_id)`. `(location_id)` references `locations(id)` on delete cascade. Index `sqsp_contacts_email_idx` `(location_id, lower(email))` where `email IS NOT NULL`.

#### `sqsp_customer_links`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `location_id` | uuid | no |  |
| `sqsp_customer_id` | text | no |  |
| `customer_id` | uuid | no |  |
| `source` | text | no |  |
| `linked_by` | uuid | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(location_id, sqsp_customer_id)`. `(customer_id)` references `customers(id)`. `(linked_by)` references `users(id)` on delete set null. `(location_id)` references `locations(id)` on delete cascade. 1 check constraint. Index `sqsp_customer_links_customer_idx` `(customer_id)`.

#### `sqsp_manual_queue`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `idempotency_key` | text | no |  |
| `sqsp_order_id` | text | no |  |
| `sqsp_txn_id` | text | yes |  |
| `reason` | text | no |  |
| `candidates` | jsonb | no | `'[]'::jsonb` |
| `arrival` | jsonb | no |  |
| `variance` | jsonb | yes |  |
| `state` | text | no | `'open'::text` |
| `resolution` | text | yes |  |
| `resolved_at` | timestamp with time zone | yes |  |
| `resolved_by` | uuid | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(idempotency_key)`. `(location_id)` references `locations(id)` on delete cascade. `(resolved_by)` references `users(id)` on delete set null. 1 check constraint. Index `sqsp_manual_queue_open_idx` `(location_id, created_at)` where `state = 'open'::text`. Index `sqsp_manual_queue_order_idx` `(location_id, sqsp_order_id)`.

#### `sqsp_matches`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `idempotency_key` | text | no |  |
| `kind` | text | no |  |
| `sqsp_order_id` | text | yes |  |
| `sqsp_txn_id` | text | yes |  |
| `event_id` | uuid | yes |  |
| `invoice_id` | uuid | yes |  |
| `rule` | text | yes |  |
| `confidence` | numeric(4,3) | yes |  |
| `variance` | jsonb | yes |  |
| `manual` | boolean | no | `false` |
| `actor_user_id` | uuid | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(idempotency_key)`. `(actor_user_id)` references `users(id)` on delete set null. `(event_id)` references `ledger_events(id)`. `(invoice_id)` references `invoices(id)`. `(location_id)` references `locations(id)` on delete cascade. 1 check constraint. Index `sqsp_matches_event_idx` `(event_id)` where `event_id IS NOT NULL`. Index `sqsp_matches_order_idx` `(location_id, sqsp_order_id)`.

#### `sqsp_orders`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `sqsp_order_id` | text | no |  |
| `order_number` | text | no |  |
| `created_on` | timestamp with time zone | no |  |
| `modified_on` | timestamp with time zone | no |  |
| `customer_email` | text | yes |  |
| `customer_name` | text | yes |  |
| `customer_phone` | text | yes |  |
| `sqsp_customer_id` | text | yes |  |
| `channel` | text | yes |  |
| `fulfillment_status` | text | yes |  |
| `payment_state` | text | yes |  |
| `is_subscription` | boolean | no | `false` |
| `grand_total_cents` | integer | no |  |
| `refunded_total_cents` | integer | no | `0` |
| `subtotal_cents` | integer | yes |  |
| `tax_cents` | integer | yes |  |
| `currency` | text | no |  |
| `test_mode` | boolean | no | `false` |
| `line_items` | jsonb | no | `'[]'::jsonb` |
| `order_json` | jsonb | no |  |
| `raw` | jsonb | yes |  |
| `payload_hash` | text | no |  |
| `customer_id` | uuid | yes |  |
| `matched_invoice_id` | uuid | yes |  |
| `match_state` | text | no | `'unmatched'::text` |
| `ignore_reason` | text | yes |  |
| `first_seen_at` | timestamp with time zone | no |  |
| `synced_at` | timestamp with time zone | no |  |
| `matched_at` | timestamp with time zone | yes |  |

Primary key `(id)`. Unique `(location_id, sqsp_order_id)`. `(customer_id)` references `customers(id)`. `(location_id)` references `locations(id)` on delete cascade. `(matched_invoice_id)` references `invoices(id)`. 1 check constraint. Index `sqsp_orders_customer_idx` `(location_id, sqsp_customer_id)` where `sqsp_customer_id IS NOT NULL`. Index `sqsp_orders_email_idx` `(location_id, lower(customer_email))` where `customer_email IS NOT NULL`. Index `sqsp_orders_modified_idx` `(location_id, modified_on)`. Index `sqsp_orders_state_idx` `(location_id, match_state, created_on)`.

#### `sqsp_products`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `sqsp_product_id` | text | yes |  |
| `sku` | text | yes |  |
| `name` | text | yes |  |
| `kind` | text | no |  |
| `plan_id` | uuid | yes |  |
| `plan_label` | text | yes |  |
| `interval_months` | integer | no | `1` |
| `service_id` | uuid | yes |  |
| `active` | boolean | no | `true` |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. `(location_id)` references `locations(id)` on delete cascade. `(plan_id)` references `membership_plans(id)`. `(service_id)` references `services(id)`. 4 check constraints. Unique index `uq_sqsp_products_product` `(location_id, sqsp_product_id)` where `sqsp_product_id IS NOT NULL`. Unique index `uq_sqsp_products_sku` `(location_id, lower(sku))` where `sku IS NOT NULL`.

#### `sqsp_sync_errors`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `resource` | text | no |  |
| `key` | text | no |  |
| `kind` | text | no |  |
| `message` | text | no |  |
| `raw` | jsonb | yes |  |
| `attempts` | integer | no | `1` |
| `first_at` | timestamp with time zone | no |  |
| `last_at` | timestamp with time zone | no |  |
| `dead_lettered_at` | timestamp with time zone | yes |  |
| `resolved_at` | timestamp with time zone | yes |  |

Primary key `(id)`. Unique `(location_id, resource, key)`. `(location_id)` references `locations(id)` on delete cascade. 2 check constraints. Index `sqsp_sync_errors_open_idx` `(location_id, resource)` where `resolved_at IS NULL`.

#### `sqsp_sync_state`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `location_id` | uuid | no |  |
| `resource` | text | no |  |
| `watermark` | timestamp with time zone | yes |  |
| `in_flight` | jsonb | yes |  |
| `phase` | text | yes |  |
| `window_start` | timestamp with time zone | yes |  |
| `last_run_at` | timestamp with time zone | yes |  |
| `last_success_at` | timestamp with time zone | yes |  |
| `status` | text | no | `'idle'::text` |
| `last_error` | text | yes |  |
| `consecutive_failures` | integer | no | `0` |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(location_id, resource)`. `(location_id)` references `locations(id)` on delete cascade. 3 check constraints.

#### `sqsp_transactions`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `sqsp_txn_id` | text | no |  |
| `sqsp_order_id` | text | yes |  |
| `kind` | text | no |  |
| `created_on` | timestamp with time zone | no |  |
| `amount_cents` | integer | no |  |
| `currency` | text | no |  |
| `brand` | text | yes |  |
| `last4` | text | yes |  |
| `provider` | text | yes |  |
| `document_id` | text | yes |  |
| `payment_id` | text | yes |  |
| `external_transaction_id` | text | yes |  |
| `voided` | boolean | no | `false` |
| `document_modified_on` | timestamp with time zone | yes |  |
| `effective_modified_on` | timestamp with time zone | no |  |
| `customer_email` | text | yes |  |
| `txn_json` | jsonb | no |  |
| `raw` | jsonb | yes |  |
| `payload_hash` | text | no |  |
| `state` | text | no | `'new'::text` |
| `ignore_reason` | text | yes |  |
| `matched_event_id` | uuid | yes |  |
| `first_seen_at` | timestamp with time zone | no |  |
| `synced_at` | timestamp with time zone | no |  |

Primary key `(id)`. Unique `(location_id, sqsp_txn_id)`. `(location_id)` references `locations(id)` on delete cascade. `(matched_event_id)` references `ledger_events(id)`. 3 check constraints. Index `sqsp_transactions_order_idx` `(location_id, sqsp_order_id)`. Index `sqsp_transactions_state_idx` `(location_id, state, created_on)` where `state = ANY (ARRAY['new'::text, 'deferred'::text, 'manual'::text])`.

#### `sqsp_webhook_subscriptions`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `sqsp_subscription_id` | text | no |  |
| `topic` | text | no |  |
| `endpoint_url` | text | no |  |
| `secret_enc` | text | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `last_delivery_at` | timestamp with time zone | yes |  |

Primary key `(id)`. Unique `(location_id, sqsp_subscription_id)`. `(location_id)` references `locations(id)` on delete cascade. 1 check constraint.

#### `standing_occurrences`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `series_id` | uuid | no |  |
| `occurrence_date` | date | no |  |
| `status` | text | no |  |
| `appointment_id` | uuid | yes |  |
| `reason` | text | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(series_id, occurrence_date)`. `(appointment_id)` references `appointments(id)`. `(series_id)` references `standing_series(id)` on delete cascade. 2 check constraints. Index `standing_occurrences_appointment_idx` `(appointment_id)` where `appointment_id IS NOT NULL`.

#### `standing_series`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `customer_id` | uuid | no |  |
| `vehicle_id` | uuid | yes |  |
| `service_id` | uuid | no |  |
| `cadence` | text | no |  |
| `weekday` | smallint | no |  |
| `time_min` | smallint | no |  |
| `start_date` | date | no |  |
| `end_date` | date | yes |  |
| `status` | text | no | `'active'::text` |
| `generated_through` | date | yes |  |
| `auto_confirm` | boolean | no | `true` |
| `notes` | text | yes |  |
| `created_by` | uuid | yes |  |
| `version` | integer | no | `1` |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. `(created_by)` references `users(id)` on delete set null. `(customer_id)` references `customers(id)`. `(location_id)` references `locations(id)` on delete cascade. `(service_id)` references `services(id)`. `(vehicle_id)` references `vehicles(id)`. 5 check constraints. Index `standing_series_live_idx` `(location_id, customer_id)` where `status <> 'ended'::text`.

#### `user_preferences`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `user_id` | uuid | no |  |
| `theme` | text | yes |  |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(user_id)`. `(user_id)` references `users(id)` on delete cascade. 1 check constraint.

#### `users`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `employee_id` | uuid | no |  |
| `email` | citext | no |  |
| `password_hash` | text | no |  |
| `failed_attempts` | integer | no | `0` |
| `last_login_at` | timestamp with time zone | yes |  |
| `password_changed_at` | timestamp with time zone | no | `app_now()` |
| `disabled_at` | timestamp with time zone | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(email)`. Unique `(employee_id)`. `(employee_id)` references `employees(id)` on delete cascade.

#### `vehicles`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `customer_id` | uuid | no |  |
| `year` | smallint | yes |  |
| `make` | text | yes |  |
| `model` | text | yes |  |
| `color` | text | yes |  |
| `plate` | text | yes |  |
| `deleted_at` | timestamp with time zone | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. `(customer_id)` references `customers(id)`. 2 check constraints. Unique index `uq_vehicles_customer_plate` `(customer_id, upper(plate))`. Index `vehicles_customer_idx` `(customer_id)`. Index `vehicles_plate_idx` `(upper(plate))` where `plate IS NOT NULL`.

#### `vip_clients`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `location_id` | uuid | no |  |
| `customer_id` | uuid | no |  |
| `added_by` | uuid | yes |  |
| `added_at` | timestamp with time zone | no | `app_now()` |

Primary key `(location_id, customer_id)`. `(added_by)` references `users(id)` on delete set null. `(customer_id)` references `customers(id)`. `(location_id)` references `locations(id)` on delete cascade. Index `vip_clients_customer_idx` `(customer_id)`.

#### `vip_hold_releases`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `hold_id` | uuid | no |  |
| `slot_start` | timestamp with time zone | no |  |
| `location_id` | uuid | no |  |
| `released_at` | timestamp with time zone | no | `app_now()` |

Primary key `(hold_id, slot_start)`. `(hold_id)` references `vip_holds(id)` on delete cascade. `(location_id)` references `locations(id)` on delete cascade. Index `vip_hold_releases_slot_idx` `(slot_start)`.

#### `vip_holds`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `weekday` | smallint | no |  |
| `time_min` | smallint | no |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(location_id, weekday, time_min)`. `(location_id)` references `locations(id)` on delete cascade. 2 check constraints.

#### `vip_settings`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `location_id` | uuid | no |  |
| `release_hours` | smallint | no | `48` |
| `window_vip_days` | smallint | no | `30` |
| `window_std_days` | smallint | no | `14` |
| `same_day_per_month` | smallint | no | `2` |
| `waitlist` | boolean | no | `true` |
| `offer_minutes` | smallint | no | `15` |
| `standing` | boolean | no | `true` |
| `auto_confirm` | boolean | no | `true` |
| `cadences` | text[] | no | `'{weekly,biweekly,monthly}'::text[]` |
| `version` | integer | no | `1` |
| `updated_by` | uuid | yes |  |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(location_id)`. `(location_id)` references `locations(id)` on delete cascade. `(updated_by)` references `users(id)` on delete set null. 6 check constraints.

#### `waitlist_entries`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `customer_id` | uuid | no |  |
| `vehicle_id` | uuid | yes |  |
| `service_id` | uuid | no |  |
| `desired_date` | date | no |  |
| `window_start_min` | smallint | no |  |
| `window_end_min` | smallint | no |  |
| `is_vip` | boolean | no | `false` |
| `status` | text | no | `'waiting'::text` |
| `appointment_id` | uuid | yes |  |
| `notes` | text | yes |  |
| `created_by` | uuid | yes |  |
| `version` | integer | no | `1` |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. `(appointment_id)` references `appointments(id)`. `(created_by)` references `users(id)` on delete set null. `(customer_id)` references `customers(id)`. `(location_id)` references `locations(id)` on delete cascade. `(service_id)` references `services(id)`. `(vehicle_id)` references `vehicles(id)`. 5 check constraints. Index `waitlist_entries_match_idx` `(location_id, desired_date)` where `status = ANY (ARRAY['waiting'::text, 'offered'::text])`.

#### `waitlist_offers`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `entry_id` | uuid | no |  |
| `slot_start` | timestamp with time zone | no |  |
| `slot_end` | timestamp with time zone | no |  |
| `phase` | text | no |  |
| `status` | text | no | `'open'::text` |
| `offered_at` | timestamp with time zone | no | `app_now()` |
| `expires_at` | timestamp with time zone | no |  |
| `resolved_at` | timestamp with time zone | yes |  |
| `message_id` | uuid | yes |  |

Primary key `(id)`. Unique `(entry_id, slot_start)`. `(entry_id)` references `waitlist_entries(id)` on delete cascade. `(location_id)` references `locations(id)` on delete cascade. 4 check constraints. Index `waitlist_offers_open_idx` `(expires_at)` where `status = 'open'::text`. Index `waitlist_offers_slot_idx` `(location_id, slot_start)`.

#### `webhook_log`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `provider` | text | no |  |
| `external_id` | text | no |  |
| `headers` | jsonb | no | `'{}'::jsonb` |
| `body` | text | yes |  |
| `signature_valid` | boolean | no |  |
| `received_at` | timestamp with time zone | no | `app_now()` |
| `processed_at` | timestamp with time zone | yes |  |
| `status` | text | no | `'received'::text` |
| `error` | text | yes |  |

Primary key `(id)`. Unique `(provider, external_id)`. 2 check constraints. Index `webhook_log_received_idx` `(received_at)`.

#### Views and functions

- view `invoice_calc`
- function `app_now() returns timestamp with time zone`
- function `audit_log_immutable() returns trigger`
- function `credit_allocations_guard() returns trigger`
- function `ensure_location(p_id uuid, p_slug text, p_name text, p_timezone text DEFAULT 'America/New_York'::text) returns uuid`
- function `invoice_calc_of(p_invoice uuid) returns TABLE(invoice_id uuid, items bigint, adj bigint, sub bigint, tax bigint, tip bigint, total bigint, paid_orig bigint, credit_applied bigint, paid bigint, refunded bigint, ref_orig bigint, pending_amt bigint, pending_n bigint, issued bigint, balance bigint, refundable bigint, to_orig_max bigint, net bigint, overpaid bigint, status text)`
- function `ledger_events_guard() returns trigger`
- function `realtime_channel_name() returns text`
- function `realtime_events_notify() returns trigger`
- function `realtime_purge(p_before timestamp with time zone) returns bigint`
<!-- schema-reference:end -->
