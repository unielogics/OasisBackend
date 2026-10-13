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
| `20261006500000_public_website.sql`    | the public website's booking surface: one-time SMS codes, member tokens and the durable limit counters of the public routes (ADR 0150)                     |
| `20261010130000_mms_inbound.sql`       | inbound MMS: `kind` and `attachments` on `messages` and `sms_inbox`, and the `unparsed` status of `webhook_log` (ADR 0151)                                |
| `20261010140000_mms_supersede.sql`     | `sms_inbox.superseded_by` / `superseded_at` (an incomplete MMS replaced by its complete delivery) and `notifications.source_ref` (ADR 0151)                |
| `20261011000000_catalog_categories.sql` | catalog categories (Wash, Add-ons, Tint, Detail, Quote), the website/AI fields of services and plans, `appointments.categories` with its backfill (ADR 0160) |
| `20261011000100_assistant.sql`         | the AI assistant's conversations, turns and tool calls; inbox links and decisions, `sender_kind` `ai`, the staff pause, `source` `sms_ai`, opt-in `inbound_text` (ADR 0160) |
| `20261011000200_identity.sql`          | personal links and their sessions, website PINs, the 30-day phone trust, in-chat actions awaiting a reply number, code purposes, `email_verified` (ADR 0160) |
| `20261011000300_leads.sql`             | leads and their single automatic follow-up (ADR 0160)                                                                                                     |
| `20261011000400_status_texts.sql`      | the delayed "checked in" text queue and the running-late texts (ADR 0160)                                                                                |
| `20261011000500_membership_checkouts.sql` | the checkout intents of memberships started through a personal link (ADR 0160)                                                                         |
| `20261011020000_identity_core.sql`     | the identity core (wave W2b): `phone_trust.epoch` (a links-epoch bump voids the trust) and the wrong-PIN rows of the rolling limits (ADR 0160) |
| `20261011040000_sms_usage_class.sql` | the class of each send in `sms_usage` (`klass`), so the AI classes' sub-cap is counted in the dispatcher (ADR 0160, W2d)                               |
| `20261011050000_membership_matching.sql` | membership matching (ADR 0160 W2e): checkout row origin (link or sync), state rejected, nullable checkout_url, email_verified drops on an email change  |
| `20261012020000_assistant_tools.sql` | `vehicles.vehicle_type` (the tint price class `set_my_vehicle` records) and `customers.archived_at` (the welcome flow's 30-day archive of nameless, never-booked provisional clients) (ADR 0160, W3b) |
| `20261012030000_link_bookings.sql` | appointment `source` `link`: a visit booked on a personal link page (ADR 0160, W3c link API)                                                       |
| `20261012100000_location_address.sql` | the shop’s street address for the existing location when none is set (the assistant’s shop facts read it; ADR 0160, W4b) |
| `20261013010000_identity_rebinding.sql` | stale-record re-binding (ADR 0160, W4c fixes): `customers.identity_confirmed_at` (proof of the client: their PIN, staff), `customers.phone_reassigned_at` / `phone_reassigned_to` (the number moved to a new client), `appointments.booked_with_pin` |
| `20261013090000_assistant_language.sql` | `assistant_conversations.language` (`en`\|`es`): the client's language, detected from their texts; the server's own words in the conversation follow it (ADR 0160, W4b X5) |
| `20261014100000_vehicle_classes_and_prices.sql` | vehicle sizes (`vehicle_classes`, the five defaults for every location) and prices by size (`service_class_prices`) backfilled from today's guest prices and tint matrix; `catalog.tint_films`; `vehicles.vehicle_class` / `vehicle_class_source` from `vehicle_type` (ADR 0170) |
| `20261014100100_membership_tiers.sql` | editable tiers: slug keys (premium -> gold, executive -> vip, old key in `legacy_key`, cascaded to links and checkouts), `member_discount_bp`, `public`, `vip_booking`, `max_vehicles`, `price_version`; `membership_tier_prices` (append-only, guard trigger); `membership_inclusions` + `membership_inclusion_services` from `plan_credit_rules` (same ids); credit events gain `inclusion_id` and the coverage columns, one redeem per appointment and inclusion; `memberships.plan_class` (required) and `tier_price_id`; `membership_household`; `membership_checkouts.plan_class` (ADR 0170) |
| `20261014100200_class_price_snapshots.sql` | the size snapshot of a visit (written from wave Q2): `appointments.vehicle_class`, `vehicle_class_label`, `class_confirmed_at`, `list_price_cents`, `discount_bp`, `price_basis`; the same per add-on and invoice line; `invoices.vehicle_class_label` (ADR 0170) |
| `20261014200000_square_foundation.sql` | Square foundation (ADR 0171, wave Q1b): `webhook_log.provider` gains `square` (deliveries and Events API catch-up, deduplicated on Square's `event_id`), and `square_state` (merchant, events enabled, webhook subscription, catch-up watermark, last reconcile and test) |
| `20261014300000_redeem_per_line.sql` | membership coverage per line (ADR 0170, wave Q2a review): drops `uq_credit_redeem_appointment` (an inclusion may cover several lines of a visit, and a line changed after settlement is given back and redeemed again; the idempotency key names each redeem) and indexes `membership_credit_events (appointment_id)` |
| `20261014400000_square_core.sql` | Square core (ADR 0171, wave Q2b): `ledger_events.source` gains `square`, `processor` (`squarespace\|square`, backfilled for Squarespace rows) and `processor_order_id`; the guard trigger re-created (both mutable; `method`, `brand`, `last4` only on the move awaiting -> confirmed); `invoice_calc_of` leaves a refund the processor reported failed out of `refunded` and `ref_orig`; `payment_links` gain the Square columns, kinds `square_order\|square_quick_pay`, state `pending`, `origin`, a nullable `url`; `square_payments` (mirror and match), `square_refund_legs`, `square_pos_intents` |
| `20261014500000_square_cards.sql` | Cards on file, the shared foundation of waves Q3a and Q3b (ADR 0171 D7): `client_links.kind` gains `card` (#/k); `square_customer_links` (one Square customer per client and location), `customer_cards` (Square's card id, brand, last 4, expiry, postal, fingerprint, `state active\|disabled\|forgotten\|expired`, `created_via`), `card_consents` (purposes, versioned text with its SHA-256 and snapshot, time, IP, browser, link and page; append-only except the revoke columns, guard trigger `card_consents_guard`), `square_charges` (fees and balances on a saved card, `proposed` until staff confirm) |
| `20261014500100_card_charges.sql` | Cards on file and fees, wave Q3a (ADR 0171 D7): `square_charges.attempted_at` (the current CreatePayment attempt; the job square.charges.resolve re-sends an unanswered one with the same key within 23 hours), `decline_code`, `reason` ("No-show fee", "Late-cancel fee", "Balance"), `request_key` (the staff request of the current attempt, unique per location: the same request again finds its charge); `customer_cards.expiry_notice_for` (the expiry the nightly job texted a card link about); unique index `square_charges_open_fee_idx`: one open fee per visit and purpose |
| `20261014600000_square_memberships.sql` | Memberships on Square (ADR 0171, wave Q3b): `memberships.source` gains `square`; the membership's Square subscription, customer and card (`card_id`), `square_status`, `billing_status ok\|failed` with `payment_failed_at` and `failure_notified_at`, what Square scheduled (`cancel_effective_at`, `pause_effective_at`, `scheduled_change` jsonb, `swap_undone_variations`); `membership_tier_prices.square_state` gains `retired`, plus `square_error`, the variation id unique (the guard re-created with `square_error` mutable); `square_enrollments` (the membership page's attempt, a resumable state machine) and `square_subscription_invoices`; card and consent end reason `membership_failed` |
| `20261014700000_link_retext.sql` | re-texting a personal link (ADR 0160, wave Q3d): `client_links.retexted_at` (when the assistant texted the same link again: once per link, counted in the day's links; its token derives from the link id under a key from `PIN_PEPPER`) |
| `20261015100000_review_q4.sql` | review Q4 fixes (ADR 0171 wave Q4 notes): `square_refunds_waiting` (a refund made in the Square app before its payment was on an invoice, recorded on the invoice when the payment is); index `webhook_log_square_open_idx` (the catch-up runs the Square rows still received or failed outside its search window) |
| `20261015100100_review_q4_fix.sql` | review Q4 re-verification and the Square sandbox run (ADR 0170 and ADR 0171 wave Q4 fix notes): `membership_inclusions.auto_apply` turned on for the default tiers' inclusions nobody edited (inclusions apply by themselves, plan decision 2); `webhook_log.attempts` (failures so far: the Square catch-up backs failed rows off by it; failed rows start at 1); `square_state.connected_at` (the connection point: counter payments Square made before it are history, never queued) |
| `20261015100200_charge_after_close.sql` | review Q4FIX-N1 (ADR 0171 wave Q4 fix notes): `square_charges.charged_after_close_at` (Square completed the charge after Oasis closed it as not charged: recorded, and the invoice's "Overpaid via Square" alert says why) |
| `20261016100000_kiosk.sql` | Kiosk mode (ADR 0180, wave K1a): `kiosk_devices` (registered tablets: the sha256 of the device cookie token, the persisted unlock throttle `failed_attempts` / `last_failed_at` / `locked_out_at`, revoke), `kiosk_codes` (the shop's unlock codes: scrypt over HMAC(key from SESSION_SECRET, location:code), history, one current), `kiosk_sessions` (sha256 id, device, code, `expires_at` = the lock time, `lock_rule`, CSRF secret, revoke reason); `employees.kiosk_listed` ("Shows on the kiosk"), `sessions.kiosk_device_id` (a manager signed in on a kiosk: short timings), `audit_log.kiosk_device_id` |
| `20261016100100_staff_attribution.sql` | Kiosk mode (ADR 0180): the tapped employee next to the user columns, `activity_log.actor_employee_id` and `kiosk_device_id`, `appointments.created_by_employee_id`, `appointment_addons.added_by_employee_id`, `appointment_photos.uploaded_by_employee_id`, `payment_links.created_by_employee_id` (columns only in K1a; written from wave K1b) |
| `20261016100200_staff_events.sql` | Kiosk mode (ADR 0180): `staff_events`, one row per car step, booking, payment, text and so on by whoever did it (kiosk or signed in), the source of the Team activity report; the report's indexes on `ledger_events` (pay by actor) and `messages` (staff sender) |
| `20261016100300_staff_attribution_links.sql` | Kiosk mode, attribution (ADR 0180, wave K1b): `staff_events.audit_id` (the audit row the event was recorded with, unique when set, so the history backfill never doubles an event); `square_charges.decided_by_employee_id` and `decided_kiosk_device_id` (who confirmed a saved-card charge: its payment is recorded later in their name, and a kiosk has no user) |
| `20261016200000_assistant_set_permission.sql` | the permission `set.assistant` ("Oasis AI assistant", sort 28, appended last): granted to every role that holds `set.hours`, and a person's own `set.hours` exception copied to it (ADR 0174) |
| `20261016200100_assistant_knowledge.sql` | the assistant's knowledge (ADR 0174): `assistant_knowledge` (the owner's notes, the reviewed text of PDFs and corrections; only active entries reach the prompt, sharing one character budget with the Settings Q&A) and `assistant_knowledge_documents` (uploaded PDFs under the `kb/` key prefix, their status, extracted text and sha256) |
| `20261016200200_assistant_practice.sql` | the assistant's practice chat (ADR 0174 §4c): `assistant_practice_sessions` (the owner's practice chats, their creator's own, kept 30 days) and `assistant_practice_turns` (each practice text and what Oasis AI would answer); the only tables practice writes |

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
| `webhook_log`       | One row per received webhook, unique `(provider, external_id)`; `provider squarespace\|smsgate\|ses\|square` (Square: keyed on the event id, shared by `/hooks/square` and the Events API catch-up, ADR 0171); `signature_valid`, `status received\|processed\|ignored\|failed\|unparsed` (`unparsed`: a signed SMS Gate delivery Oasis does not handle or could not read, body cut to 4 KB, purged after 7 days; ADR 0151). |
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
| `permissions`                   | The 28 permission keys (27 from `people_auth`; `set.assistant` appended by ADR 0174) with `module`, `label`, `sort` and `has_limit` for the three money ones (refund, adjust, credit).                                                                                 |
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
| `customers` | `full_name`, `phone_e164` (check `^\+[1-9][0-9]{6,14}$`) + `phone_display`, `email citext`, `notes`, `sms_opted_in`, `sms_opt_in_source`, `sms_opt_in_at`, `sms_opted_out_at`, `email_bounced_at`, `source`, `synthetic`, `needs_details`, `merged_into` (self FK), `deleted_at`, `version`. Partial unique on `phone_e164` for live rows (not merged, not deleted). `synthetic` rows must use `+1 AAA 555 01xx` (check), so a seed can never text a stranger. Trigram GIN indexes on name, phone and email. ADR 0160 (W4c fixes): `identity_confirmed_at` (the last proof of the client: their PIN on a link page, staff confirming the number; the stale-record rule counts it, never a texted code), `phone_reassigned_at` + `phone_reassigned_to` (the number moved to a new client because a party who verified only the number booked while this record was stale; the staff flag). |
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
| `appointments`          | `seq` (identity, unique), `customer_id`, `vehicle_id`, `service_id`, snapshots `package_name`/`price_cents`/`duration_min`, `status booked\|confirmed\|arrived\|cleaning\|completed\|canceled\|no_show`, `scheduled_start/end` (end > start), `assigned_employee_id`, `planned_bay_id` (advisory), `bay_id` (actual occupant), `source`, `eta_minutes/eta_at`, `geo_checked_in_at`, `bay_prepped_at`, `arrived_at`, `cleaning_started_at`, `completed_at`, `pickup_state`, `picked_up_at`, `ready_notified_at`, `canceled_at`, `cancel_reason`, `no_show_at`, `notes`, `special_instructions`, `membership_id`, `emergency_closure_id`, `standing_series_id`, `arrival_token_hash`, `version`, `created_by`, `booked_with_pin` (a link page or the assistant booked it for a session verified with the client's PIN: activity for the stale-record rule; ADR 0160 W4c fixes). **`uq_bay_occupied (bay_id) where status='cleaning'`** is the database's guarantee of one cleaning job per bay; `check (status <> 'cleaning' or bay_id is not null)`. Indexes `(location_id, scheduled_start)`, `(customer_id, scheduled_start desc)`, active statuses. |
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
| `ledger_events`      | Append-only (trigger): `type pay\|adjust\|refund\|credit_issue\|credit_apply\|void`, `amount_cents` (adjust signed), refund `status pending\|done\|denied` and `dest card\|credit\|cash`, method fields, actor and approver fields, `source oasis\|squarespace\|system\|seed\|square`, `processor_state na\|awaiting_processor\|confirmed\|failed` (a card refund the processor reported `failed` no longer counts as refunded), `processor squarespace\|square` and `processor_order_id` (ADR 0171), `idempotency_key` unique. |
| `credit_allocations` | Append-only: which store-credit lot a `credit_apply` consumed (FIFO by expiry, skipping lots already expired).                                                                                                                                                                                                                                                        |
| `payment_links`      | A staff-attached Squarespace checkout or invoice URL (https), or a Square link made for an exact amount (ADR 0171 D3: `provider square`, `kind square_order\|square_quick_pay`, `square_payment_link_id`, `square_order_id`, `invoice_version`, `origin staff\|pay_page\|booking\|deposit_page`; `state pending` until its command commits, or a booking's deposit request with no URL yet; canceled with `cancel_reason` and deleted at Square, `square_deleted_at`; `paid_square_payment_id`): `purpose balance\|deposit`, `expected_cents`, `state`, `matched_sqsp_order_id`. No ledger event until money actually arrives. |

`invoice_calc_of(invoice)` and the `invoice_calc` view compute items, adjustments, tax (half-up), paid, refunded, balance, refundable
and the status ladder in integer cents; `src/modules/payments/calc.ts` is the TypeScript twin (and `jobs-integrity.ts` checks them
against each other nightly). Since `20261014400000_square_core.sql` a done card refund whose `processor_state` is `failed` (Square
refused it) counts neither as `refunded` nor as `ref_orig` (ADR 0171 D4); the dashboard's `src/lib/payments/cents.ts` follows.

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
| `membership_plans`         | The tiers (ADR 0170: editable, slug `key`; the design's Essential, Gold, VIP, Exotic by default): display colours, `perks`, discount basis points (display only), `billing_interval_months`; the tier fields of migration `20261014100100` below.            |
| `plan_credit_rules`        | History since ADR 0170 (read only; `membership_inclusions` replaced it with the same ids): a credit covered a service whose `services.tags` included any `include_tags` and none of `exclude_tags`; `per_cycle` null = unlimited; `auto_apply`. |
| `memberships`              | One live membership per customer (partial unique); `plan_label`, `status`, `source squarespace\|manual`, the current cycle, grace and review flags, the member's own `auto_apply`, `manual_status_at`.                                                    |
| `membership_credit_events` | Append-only credit ledger: `grant` per rule per cycle, `redeem` (names the appointment; one per covered line since ADR 0170, wave Q2a: a visit changed after it was settled gives a redeem back and writes a new one), `restore` (gives a credit back; keyed `restore:<redeem id>`, with the reversing adjust as `ledger_event_id` when a change of the visit gave the coverage back), `protect` (a marker an emergency closure leaves; moves no count), `reserve` and `expire` (reserved kinds). |

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

## Inbound MMS (migration `20261010130000_mms_inbound.sql`, ADR 0151)

A reply a phone sends as MMS (a picture, a long or group text, and on some phones a plain "OK") reaches Oasis through SMS Gate's
`mms:downloaded` webhook and is routed exactly like an SMS (keywords, quarantine, attribution). No new table: the inbound text and
the message are marked, and the parts are listed.

| Column                                    | Rules                                                                                                                                                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messages.kind`, `sms_inbox.kind`         | `sms` (default) or `mms`. `messages.channel` stays `sms`: an MMS is part of the same SMS thread.                                                                                                                              |
| `messages.attachments`, `sms_inbox.attachments` | JSON array (null for an SMS), one item per part in device order: `index`, `partId`, `name`, `contentType`, `size`, `status` (`stored` \| `listed` \| `unavailable` \| `skipped`), `reason` (`missing`, `decode_failed`, `too_large`, `limit`, `unsupported_type`, `storage_error`) and `key`: the object key in the photos store, `messaging/mms/<location>/<device message id>/<index>.<ext>`, for a saved picture (image/jpeg, png or webp by their bytes, at most five of 5 MB each). The key never leaves the server. |
| `messages.body` of an MMS with no text    | `[Picture message]` when it had parts, `[Picture message — content unavailable]` when it had none; managers get an `sms.picture_message` notification either way. The text of `text/plain` parts counts as text.         |
| `sms_inbox.superseded_by`, `superseded_at` (migration `20261010140000_mms_supersede.sql`) | Set together on an incomplete-MMS placeholder (`provider_message_id` `mms:<id>:incomplete`) when the complete delivery of the same message arrived: the id of that delivery's inbox row. The placeholder's message is deleted (`message_id` becomes null) and it leaves the quarantine list. |
| `notifications.source_ref`                | What a notification is about, for the code that must find it again; never shown. A picture-message alert carries `sms_inbox:<device id>:<provider message id>`, so the alert of a superseded placeholder is resolved. |
| Retention of saved pictures               | `maintenance.retention` deletes the photos-store objects a purged message lists, and those of a purged inbox row with no message (a quarantined stranger's, a superseded placeholder's), object first, row second; a row whose objects cannot be deleted stays for the next run. |

## Public website (migration `20261006500000_public_website.sql`, ADR 0150)

The website books real appointments and creates pending memberships through the public routes (`/api/v1/public/*`); those rows live in
the ordinary tables (`customers` with `source = 'online'`, `appointments` with `source = 'online'`, `memberships` in the `pending`
state). What is new is the identification of a member by phone and the abuse controls of a surface with no session.

| Table                   | Key columns and rules                                                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public_otp_challenges` | One six-digit code texted to a number: `code_hash` (sha256 of the challenge id and the code: the code is never stored), `attempts` of `max_attempts` (3, never more), `expires_at` (10 minutes), `consumed_at` with `consumed_reason` `verified` / `superseded` / `locked`, `requested_ip`, `delivery` (queued, or the SMS policy's reason it was not). One active row per number (`uq_public_otp_active_phone`): a new code supersedes the earlier one. |
| `public_member_tokens`  | The opaque token a verified code issued, by its sha256 (`token_hash`, pk); bound to the number and to `customer_id` (the customer owning the number at that moment, null when nobody did), 30 minutes (`expires_at`), `last_used_at`.                                                 |
| `public_rate_limits`    | Fixed-window counters shared by every API process: `(key, window_start)` with `count`, keys such as `otp:phone:+1201...`, `booking:ip:203.0.113.9`; one upsert per request. Purged two days past the window.                                                                          |

## AI assistant, phone identity, leads and status texts (migrations `20261011000000` to `20261011000500`, `20261011020000` and `20261012020000`, ADR 0160)

The foundation of the AI text assistant and the phone-centred identity (design: `docs/design/ai-assistant-and-phone-identity.md`).
Secrets are never stored: link and session tokens, reply numbers and codes are SHA-256 hashes, PINs scrypt hashes of a peppered
HMAC. Location-scoped tables lead their unique keys with `location_id`; a phone is E.164.

| Table                       | Key columns and rules                                                                                                                                                                                                                         |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog_categories`        | pk `(location_id, key)`: `label`, `colour` (#RRGGBB), `sort`, `active`, `version`. Defaults wash, addons, tint, detail, quote in the website palette (seeded for existing locations; `ensureDomainDefaults` for new ones).                    |
| `assistant_conversations`   | One per `(location_id, phone_e164)`: `customer_id` (null for a stranger), the durable marker `pending_since`, `last_inbound_at`, the turn lease `running_since`, `handoff_state open\|resolved` with reason and time, `last_fallback_at`, `disclosed_at`, the client's `language` (`en`\|`es`, the server's own words follow it). |
| `assistant_turns`           | One per answer: `status running\|replied\|handed_off\|skipped\|failed` (one running per conversation), `trust unknown\|known\|trusted`, `provider sim\|bedrock`, `model`, `prompt_version`, `rounds`, token counts, `cost_micros`, `stop_reason`, `latency_ms`, `reply_message_id`, redacted `transcript`, `error`. |
| `assistant_tool_calls`      | `(turn_id, seq)` unique: `round`, `tool`, provider `tool_use_id`, redacted `input`/`output`, `outcome ok\|error\|denied`, `latency_ms`.                                                                                                            |
| `assistant_knowledge`       | ADR 0174: one owner-taught entry, `kind note\|document\|correction`, `title`, `body` (note 4,000, document 60,000 stored and 20,000 to turn on, correction answer 500), a correction's `question` and redacted `wrong_reply` (never shown to the model), `source manual\|practice\|live`, `document_id` (unique; a document's entry), `active` (only active entries reach the prompt, masked; they and the Q&A share `AI_KNOWLEDGE_MAX_CHARS`), `reviewed_at` (a document is on only once reviewed), `warnings` jsonb, `chars` (title + question + body), `sort`, `version`. |
| `assistant_knowledge_documents` | ADR 0174: an uploaded PDF: `filename`, `content_type application/pdf`, `bytes` (at most 10 MB), `sha256` (one live copy per location), `s3_key` (`kb/{location}/{id}.pdf`, outside the photos' lifecycle rule), `status pending_upload\|extracting\|ready\|failed\|deleted` with `error_code` (no_text, encrypted, corrupt, too_many_pages, timeout, not_pdf, too_large), `page_count`, `extracted_text` (cleaned, at most 200,000 characters; null once deleted), `removed_chars`, `attempts`, `deleted_at`, `object_deleted_at`. |
| `assistant_practice_sessions` | ADR 0174 §4c: one practice chat of one user (`user_id`; another user never sees it): `persona new_texter\|client` (a synthetic new texter whose id and fictional 555-01xx number are kept in `state`, never in a prompt; or a real client on file, `customer_id`, read-only, needs `cli.view`), `verified`, `include_entry_ids` (draft knowledge read as if on, at most 20), `language`, `state` jsonb (what the practice effects did: the name and vehicles saved, interests, links, the proposal, an opt-out), `turns`, `cost_micros` (practice's own spend, never in `AI_DAILY_BUDGET_USD`). Deleted after 30 days (job `assistant.practice.retention`). |
| `assistant_practice_turns`    | ADR 0174 §4c: one practice text and its answer (job `ai.practice`): `seq` (a re-run, `rerun_of`, has its original's), `client_text`, `status running\|replied\|handed_off\|failed\|opted_out` (one running per session), `reply_text` (what the client would get, links as "[booking link]"), `extra_texts` (a proposal's confirmation it would text), `badges`, `error`, the model, prompt and facts versions, tokens, `cost_micros`, `latency_ms`, `state_before` (the session's state when the text came; a re-run starts from it), the redacted `transcript` and `tool_calls`. |
| `client_links`              | A personal link: `token_hash` unique (sha256 of a 32-byte base64url token), `kind calendar\|verify\|pin\|membership\|pay\|book_again\|card` (card since `20261014500000_square_cards.sql`), `customer_id` (null only for a stranger's calendar or book-again link), `phone_e164`, appointment/invoice/plan bindings (the plan: fk `(location_id, plan_key)` to the location's plans), `pin_version`, `phone_version`, `epoch`, `issued_by`, `expires_at` (after `created_at`), `uses` of `max_uses`, `consumed_at`, `revoked_at` + `revoke_reason`. |
| `client_links`              | A personal link: `token_hash` unique (sha256 of a 32-byte base64url token), `kind calendar\|verify\|pin\|membership\|pay\|book_again`, `customer_id` (null only for a stranger's calendar or book-again link), `phone_e164`, appointment/invoice/plan bindings (the plan: fk `(location_id, plan_key)` to the location's plans), `pin_version`, `phone_version`, `epoch`, `issued_by`, `expires_at` (after `created_at`), `uses` of `max_uses`, `consumed_at`, `revoked_at` + `revoke_reason`, `retexted_at` (the assistant texted this same link again, once; wave Q3d). |
| `client_link_sessions`      | The bearer session a link is exchanged for, by `token_hash`: `trust link\|verified`, `verified_by pin\|code`, `step_up_at`, `failed_attempts`, `idle_expires_at` (15 minutes) within `expires_at` (1 hour), `revoked_at`, `ip`.                    |
| `customer_pins`             | pk `customer_id`: `pin_hash` (null once cleared, the row keeps counting), `version` (bumped on set, reset, clear), `failed_attempts`, `lock_level` 0-3, `locked_until`, `set_at`, `reset_hold_until`, `cleared_at`.                            |
| `phone_trust`               | pk `(location_id, phone_e164)`: the client, `verified_at`, `verified_by pin\|code`, `expires_at` (+30 days at most, an hour of slack), `revoked_at` + `revoke_reason`, `epoch` (the links epoch it was granted in, migration `20261011020000`).                                                                                                 |
| `identity_pin_failures`     | One wrong PIN entry on a link page: `customer_id` (null when the number has no client or no PIN: the try still counts against the address and the page), `phone_e164`, `ip` (the address as the per-address limit keys it: an IPv6 address by its /64, W4c fixes), `at`. The rolling limits count these rows: 10 a day per client, 20 an hour per client address. Purged after two days. |
| `assistant_pending_actions` | An in-chat `book\|reschedule\|cancel` proposal waiting for its reply number: `payload`, `code_hash`, `attempts` of `max_attempts` (3), `expires_at` (+15 minutes), `state` (one `pending` per phone), `confirm_message_id`, `appointment_id`, `resolved_at`. |
| `leads`                     | One per `(location_id, phone_e164)`: `customer_id`, `source text\|website\|walk_in`, `interests` (category keys), `status new\|followed_up\|booked\|closed` (`closed_at` iff booked or closed), contact times, `follow_up_at` (due index), `follow_up_message_id`, `booked_appointment_id`. |
| `pending_checkin_texts`     | pk `appointment_id`: the "checked in" text due 3 minutes after a manual arrival, `state pending\|sent\|dropped` (with `drop_reason`), `message_id`, `settled_at`.                                                                              |
| `appointment_late_texts`    | pk `(appointment_id, seq)`, `seq` 1 or 2: the running-late texts of a visit, `eta_at`, `message_id`.                                                                                                                                        |
| `membership_checkouts`      | A link-started membership's checkout intent: `membership_id` (one `open` each), `customer_id` (the membership's own: fk `(membership_id, customer_id)`), `plan_key` (fk to the location's plans), `link_id`, `product_key`, `expected_email`, `checkout_url` (squarespace.com), `started_at`, `expires_at` (+72 hours), `state open\|matched\|awaiting_match\|expired\|superseded\|abandoned`, `matched_order_id`. |

Columns added to existing tables:

| Column                                                                                         | Meaning                                                                                                                       |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `services.category`                                                                            | NOT NULL, fk `(location_id, category)` to `catalog_categories`; backfill and default for a new row without one (`catalog_default_category`, insert trigger): add-ons: addons; tint: tint; detail/ceramic/exotic/executive: detail; any other package: wash |
| `services.public_name`, `.description`, `.member_price_cents`, `.guest_price_cents`             | the website/AI copy and prices (null prices: the plain `price_cents`)                                                         |
| `services.vip_inclusion`, `.vip_note`, `.quote_only`, `.visible_online`                         | `included\|allowance\|none`; quote-only services show no price and are never booked online; `visible_online` defaults true    |
| `appointments.categories`                                                                      | the category keys of the package and live add-ons, in category order (GIN index); backfilled                                |
| `appointments.source`                                                                          | gains `sms_ai`; `link` (a visit booked on a personal link page, migration `20261012030000`)                                   |
| `membership_plans.monthly_price_cents`, `.checkout_url`, `.public_label`                        | the plan's price, Squarespace checkout (https, squarespace.com only) and website name (Gold, VIP)                             |
| `customers.email_verified`, `.phone_version`                                                   | an email confirmed on a link page; bumped on every phone change (links carry the version)                                    |
| `customers.sms_opt_in_source`                                                                  | gains `inbound_text` (a client the assistant created: transactional consent only)                                            |
| `public_otp_challenges.purpose`, `.link_session_hash`                                          | `website\|link_verify\|pin_set\|pin_reset`; a link page's code names its session (set null when the session goes: the row stays for the hourly ceiling); a website code never names one |
| `sms_inbox.assistant_conversation_id`, `.assistant_turn_id`, `.decision`                        | the conversation and turn that took the text; decisions gain `assistant`, `handoff`, `action_code`                             |
| `messages.sender_kind`                                                                         | gains `ai` (shown as "Oasis AI")                                                                                              |
| `message_threads.ai_paused_until`, `.ai_paused_by`                                             | a staff reply pauses the AI on the thread; `ai_paused_by` only with `ai_paused_until`                                         |
| `vehicles.vehicle_type`                                                                        | `sedan_coupe\|suv_crossover\|truck_van` (the tint matrix's vehicle types): what `set_my_vehicle` records (W3b, migration `20261012020000`) |
| `customers.archived_at`                                                                        | the welcome flow's archive (W3b): a provisional client ("New texter ••NNNN", `source inbound_sms`, `needs_details`) with no name and no booking 30 days after its last text is soft-deleted (`deleted_at`) and marked here (check: only with `deleted_at`); a new text from the number restores it. Partial indexes for the scan and the restore |

## Vehicle sizes, prices by size and tiers (migrations `20261014100000` to `20261014100200`, ADR 0170)

Prices per vehicle size and editable membership tiers. A service has one regular price per size; a member pays it less the tier's %
off (computed, never stored); a covered line is covered up to the price at the membership's plan size. Money is integer cents.

| Table                           | Key columns and rules                                                                                                                                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vehicle_classes`               | pk `(location_id, key)` (slug, never changes): `label` (40, unique per location in the API), `sort` (size order, smallest first), `active`, `version`. Defaults compact_car, large_car, compact_suv, large_suv, truck (seeded for existing locations; `ensureDomainDefaults` for new ones). |
| `service_class_prices`          | pk `(service_id, class_key)`: the regular `price_cents` (0 to $100,000) of a service at a size, `max_cents` (null, or at least the price: a range), `updated_at`, `updated_by`; fk `(location_id, class_key)` to `vehicle_classes`. A missing row = not set. |
| `membership_tier_prices`        | Append-only (guard trigger: only `superseded_at`, once, and the `square_*` fields change; deleted only with its tier): a tier's `monthly_cents` at a size from `effective_from`; one current row (`superseded_at` null) per tier and size (partial unique); `price_version`; `square_variation_id` (unique: each row is one Square plan variation, the variation history), `square_state pending\|synced\|failed\|retired`, `square_synced_at`, `square_error` (wave Q3b); `created_by`. |
| `membership_inclusions`         | What a tier includes: `label`, `mode per_cycle\|every_visit`, `per_cycle` (null = unlimited; always null for every_visit), `auto_apply` (default true; the design tiers' false), `sort`, `active`. Made from `plan_credit_rules` with the same ids. |
| `membership_inclusion_services` | pk `(inclusion_id, service_id)`: the services an inclusion covers.                                                                                                                                                             |
| `membership_household`          | The other customers a membership covers (the holder is `memberships.customer_id`): `membership_id`, `customer_id` (one live household per customer: partial unique where `removed_at` is null), `added_at`, `added_by`, `removed_at`. Written by `POST` / `DELETE /memberships/:id/household` (wave Q2a); the holder or a live household member is priced and covered as the member, and the credits are shared. |

Columns added to existing tables:

| Column                                                                                                            | Meaning                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `vehicles.vehicle_class`, `.vehicle_class_source`                                                                 | the car's size (slug, no fk: vehicles carry no location) and who said it, `staff\|client\|ai\|legacy` (both or neither); backfilled from `vehicle_type` (sedan_coupe -> compact_car, suv_crossover -> compact_suv, truck_van -> truck) |
| `membership_plans.member_discount_bp`, `.public`, `.vip_booking`, `.max_vehicles`, `.price_version`, `.square_plan_id`, `.legacy_key` | the tier's member % off (0 to 10000), sold online, gives the VIP slot rules, car cap, the token of a tier-price save, the Square plan (wave Q3b), the old key (unique per location) |
| `membership_credit_events.inclusion_id`, `.service_id`, `.line_cents`, `.covered_cents`, `.plan_class`, `.visit_class` | the inclusion (backfilled from `rule_id`), the covered line, its regular price, the amount covered and both sizes; the redeem's idempotency key `redeem:<appointment>:<inclusion>`, then `…:<n>` (migration `20261014300000` dropped the per-inclusion unique index: an inclusion may cover several lines, and a line changed after settlement is redeemed again) |
| `memberships.plan_class`, `.tier_price_id`                                                                        | the size the membership is priced at (NOT NULL, fk to `vehicle_classes`; an insert without one gets the location's smallest active size: trigger `memberships_default_plan_class`); the tier price billed (wave Q3b) |
| `membership_checkouts.plan_class`                                                                                 | the size a link-started membership was chosen at (written since wave Q2a)                                                                                     |
| `appointments.vehicle_class`, `.vehicle_class_label`, `.class_confirmed_at`, `.list_price_cents`, `.discount_bp`, `.price_basis` | the size snapshot of a visit, written by every booking path, the add-on, the size change and the membership settlement since wave Q2a (`price_cents` stays the charge); `price_basis legacy\|class\|unknown_class\|estimated\|base`, `legacy` on visits booked before; `appointments.membership_id` (the membership that priced the visit) is written from wave Q2a too |
| `appointment_addons.list_price_cents`, `.discount_bp`, `.price_basis`                                             | the same per add-on                                                                                                                            |
| `invoice_items.list_cents`, `.discount_bp`, `.price_basis`; `invoices.vehicle_class_label`                          | the regular price of a line at the size (null, or at least `price_cents`), the member % off and the basis; the size on the invoice           |

## Square (migrations `20261014200000_square_foundation.sql`, `20261014400000_square_core.sql`, `20261014500000_square_cards.sql` and `20261014500100_card_charges.sql`, ADR 0171)

The foundation (Q1b) moves no money; the core (Q2b) adds the ledger columns (`ledger_events.processor`, `processor_order_id`), the
Square payment mirror, the refund legs and the POS intents. The cards tables (the Q3 shared foundation) hold the client's Square
customer, saved cards, consents and the charges on a saved card; Q3a fills them (the card page, staff charges of a balance, the
no-show and late-cancel fees, the card lifecycle) and Q3b will (subscriptions).

| Table          | Purpose                                                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `square_state` | One row per location, describing ONE Square `environment` (`sandbox\|production\|sim`): read only when it is the configured one, and a save from another environment resets every learned column it does not set. `square_location_id`; `merchant_id` learned by Test connection (a webhook of any other merchant is ignored); `events_enabled_at`; the verified `webhook_subscription_id` and when it was checked; `last_webhook_at`; the catch-up `watermark` (created_at of the newest event read, and after a complete run with no failure at least the run time minus 10 minutes; the next run reads from 10 minutes before it, never more than 28 days back), `last_catchup_at`, `last_catchup_events`, `last_catchup_claimed_at` (an event no webhook had delivered); `last_reconcile` (jsonb counts of the last 72 hours) and its time; `last_test` (jsonb checks) and its time; `last_error` and its time |

| `square_payments` | The mirror of every Square payment of our location as last re-fetched (`square_payment_id` unique; status, source type, product, order, reference, note, receipt, `amount_cents` (tip excluded), `tip_cents`, `total_cents`, `refunded_cents`, card brand and last four, Square customer, buyer email, Square times) and Oasis's decision: `classification link\|charge\|membership\|pos_intent\|counter\|ignored`, `match_state pending\|matched\|unmatched\|ignored` (matched = `invoice_id` and `event_id` set; ignored = an `ignore_reason`), `match_after` (a counter payment waits SQUARE_MATCH_DELAY_SECONDS), `tip_event_id`, `rule` (R1 to R4a, link, cash_entry, manual, reassign), `confidence`, ranked `candidates` (jsonb), `variance`, who decided and when |
| `square_refund_legs` | One Square refund of one Square payment for one ledger refund (the refund row is the outbox): `ledger_event_id`, `square_payment_id`, `amount_cents`, `origin api\|pos` (a refund made in the Square app that Oasis attached or recorded), `idempotency_key` (rf_<leg id>) and `square_refund_id` unique, `state to_submit\|pending\|completed\|failed\|rejected`, `error`, `attempts`, times |
| `square_refunds_waiting` | A refund made in the Square app while its payment was not on an invoice yet (the counter delay, the "payments to match" queue): `square_refund_id` (key), `square_payment_id`, `facts` (the refund as Square answered it), `received_at`; recorded on the invoice (a refund needing review) and deleted in the transaction that records the payment there (ADR 0171 Q4 SQ-SEM-1) |
| `square_pos_intents` | "Open Square POS" from the dashboard (SQUARE_POS_API_ENABLED): the invoice, the staff card entry it wrote (`ledger_event_id`), `amount_cents`, the random `callback_state` and the note `code` (OAS-PI-xxxxxx), both unique, `status open\|callback_ok\|callback_error\|matched\|expired`, the callback's transaction ids or error, the matched `square_payment_id`, `expires_at` |
| `square_customer_links` | The client's Square customer, one per client and location (`src/modules/square/customers.ts` ensureSquareCustomer: this row, else SearchCustomers by `reference_id` = the client's uuid, else CreateCustomer with key `cu_<client id>`): `customer_id`, `square_customer_id` (both unique per location), `linked_by created\|found\|staff` |
| `customer_cards` | A card saved with Square (`src/modules/square/cards.ts` saveCardOnFile, CreateCard key `cd_<attempt>`): the client, their Square customer, `square_card_id` (unique), `brand`, `last4`, `exp_month`, `exp_year`, `card_type`, `postal`, `fingerprint` (never a card number), `state active\|disabled\|forgotten\|expired` (`disabled_at` set exactly when not active, with `disabled_reason`), `created_via card_link\|membership_link\|staff\|square`, `expiry_notice_for` (the expiry, `YYYY-MM`, a card link was texted about: a card paying a membership, nightly) |
| `card_consents` | The client's OK to charge a saved card, one row per acceptance: `purposes` (a non-empty subset of `membership_billing`, `no_show_fee`, `late_cancel_fee`, `balance`), `text_version`, `text_sha256` and `text_snapshot` (the exact wording shown, `src/modules/square/consents.ts`), `accepted_at`, `ip`, `user_agent`, `link_id` (no foreign key: links are purged, the consent is kept), `session_hash` (the page's session token hash); `revoked_at`, `revoked_by`, `revoke_reason` set together, once. Append-only (trigger `card_consents_guard`: no delete, no other change) |
| `square_charges` | A charge on a saved card: `purpose no_show_fee\|late_cancel_fee\|balance`, `amount_cents`, `state proposed\|charging\|charged\|declined\|unknown\|waived` (charged only after staff confirm: any other state than proposed has `decided_at`; charged has the Square payment id), `idempotency_key` (`ch_<id>`, unique; `ch_<id:attempt>` for a new attempt after a decline), the invoice and/or appointment, the card and consent, `square_payment_id` (unique), the `ledger_event_id` it was recorded as, `error` (the plain reason of a decline) and `decline_code`, `attempts`, `attempted_at`, `reason`, `request_key` (the staff request of the current attempt: a retried request never charges twice), who proposed and decided, `waive_reason`, `charged_after_close_at` (Square completed it after Oasis closed it as not charged). One open fee per visit and purpose (unique index) |

| `square_enrollments` | One attempt to join on a membership page with a card (wave Q3b, `src/modules/memberships/square/enroll.ts`): the client, the pending membership, the link, tier, price row, `plan_class`, the Square `square_variation_id` and `monthly_cents` it joins at, the `email` Square bills to, `state started\|customer_ready\|card_saved\|subscribed\|active\|failed\|abandoned` (one live per membership; an attempt that left a subscription or a cleanup at Square keeps its membership to itself: a retry starts a new one), the Square customer, the saved card and consent, `square_subscription_id` (unique), `start_date`, `failure_code`, `failure_detail`, `cleanup none\|pending\|done` (what a failed attempt still owes at Square), `attempts`, times. Square keys from the row id: `cd_<id>`, `sb_<id>` |
| `square_subscription_invoices` | Every invoice Square makes for a membership's subscription (wave Q3b, `billing.ts`): `square_invoice_id` (unique), the subscription and order, `status`, `amount_cents`, `paid_cents`, `due_date`, the paid `period_start`/`period_end`, Square's `public_url`, `paid_at`, `applied_at` (the cycle applied once: period moved, credits granted), `failed_at` (the failure policy), `canceled_at`, `square_payment_id`, `refunded_cents` with `square_refund_id`, `refunded_at` and Square's `refund_status PENDING\|COMPLETED\|FAILED\|REJECTED` (staff "Refund last payment"; a failed or rejected refund sets `refunded_cents` back to 0 and keeps its id, so a new try uses a new key) |

Square deliveries and catch-up events share `webhook_log` (provider `square`, `external_id` = Square's `event_id`): whichever claims the
event first processes it; the raw body and the headers without the signature are kept for the 90-day trail.

## Kiosk mode (migrations `20261016100000_kiosk.sql`, `20261016100100_staff_attribution.sql`, `20261016100200_staff_events.sql` and `20261016100300_staff_attribution_links.sql`, ADR 0180)

The shop's shared tablet stays open all day without an email login: an admin registers it once ("Make this a kiosk"), and the 8-digit
shop code unlocks it into a kiosk session until closing + 2 hours. Everything is off until `kiosk.enabled` (setting, default false).
A kiosk request has no user (`AuthContext.userId` null): the employee tapped on the kiosk is the actor, so the attribution columns
sit next to the user columns. Only token hashes are stored; the code itself never is.

| Table | Purpose |
| ----- | ------- |
| `kiosk_devices` | A registered kiosk tablet of a location: `name` (≤ 40), `token_hash` (sha256 of the opaque `__Host-oasis_kdev` cookie token, unique), who registered it, `last_seen_at` / `last_ip` / `last_ua`, the persisted unlock throttle (`failed_attempts` consecutive wrong codes, `last_failed_at`; 20 sets `locked_out_at` until a manager clears it), `revoked_at` / `revoked_by` (the cookie stops working for good), `version` |
| `kiosk_codes` | The location's unlock codes: `code_hash` (PHC scrypt over HMAC-SHA256(kiosk key, "<location id>:<code>"), the key derived from `SESSION_SECRET`), who set it and when; every code ever set (a new code may not be one of the last 3), the current one has `retired_at` null (unique index `kiosk_codes_current_uq`) |
| `kiosk_sessions` | An unlocked kiosk: `id` = sha256 of the `__Host-oasis_ksid` cookie token, the device, location and code, `expires_at` (the lock time from `kioskLockTime`, absolute, no idle expiry), `lock_rule closing\|previous_day\|two_hours`, `csrf_secret`, address and browser, `last_seen_at`, `revoked_at` + `revoked_reason lock\|lock_device\|lock_all\|code_changed\|device_revoked\|kiosk_off\|unlock_again` (set together). Valid only with the cookie of its own live device and while kiosk mode is on |
| `staff_events` | One row per thing an employee did, the source of the Team activity report: `employee_id` and `employee_name` (snapshot "Marco R."), `kind` (a car step `confirm`, `arrive`, `assign_bay`, `start`, `complete`, `notify_ready`, `pickup`, `pickup_reopen`, `prep_bay`, `reschedule`, `update`; `book`, `walk_in`, `customer_create`, `addon_add`, `addon_remove`, `size_change`, `checklist`, `photo`, `payment`, `tip`, `receipt`, `payment_link`, `text`, `arrival_link`, `worker_set`), the appointment, client, `amount_cents`, `ledger_event_id`, `message_id`, `via kiosk\|signed_in` with the `kiosk_device_id` or the `user_id`, `request_id`, `meta`, `audit_id` (the audit row it was recorded with; unique). Written in the command's own transaction whenever the request has an acting employee (kiosk or signed in; `src/platform/staff-events.ts`, the exhaustive action map in `scheduling/audit-helper.ts`, `payments/staff-events.ts`); history rebuilt once by `pnpm staff-events:backfill` |

Columns added to existing tables: `employees.kiosk_listed` (default true: who the picker lists among active and invited
employees), `sessions.kiosk_device_id` (a manager signed in on a kiosk device: 15 minutes idle, 4 hours absolute), `audit_log.kiosk_device_id`
(no foreign key, like the other audit actor columns), and the employee beside each user column: `activity_log.actor_employee_id` and
`kiosk_device_id`, `appointments.created_by_employee_id`, `appointment_addons.added_by_employee_id`,
`appointment_photos.uploaded_by_employee_id`, `payment_links.created_by_employee_id`. Payments and texts already carried the employee
(`ledger_events.actor_employee_id`, `messages.sender_employee_id`). A saved-card charge records who confirmed it in
`square_charges.decided_by_employee_id` and `decided_kiosk_device_id`, beside `decided_by_user_id`.

Who is written where (wave K1b): every activity line of a staff actor carries `actor_employee_id` and, from a kiosk, `kiosk_device_id`;
a kiosk request writes null in every user column and the tapped employee in the employee column beside it; a kiosk putting a car in a
bay (assign-bay, start, advance to start) also makes the tapped employee the car's worker (`appointments.assigned_employee_id`, with
the activity line "Worker: Marco R." and a `worker_set` event when it changed), while a signed-in person leaves the worker as it was.

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
Generated from `db/schema.sql` by `pnpm data-model` (127 tables, 1 view, 15 functions). Do not edit by hand: change a migration, run `pnpm db:schema` then `pnpm data-model`.

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
| `actor_employee_id` | uuid | yes |  |
| `kiosk_device_id` | uuid | yes |  |

Primary key `(id)`. `(actor_employee_id)` references `employees(id)` on delete set null. `(appointment_id)` references `appointments(id)` on delete cascade. `(kiosk_device_id)` references `kiosk_devices(id)` on delete set null. 3 check constraints. Index `activity_log_appointment_idx` `(appointment_id, at, id)`.

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
| `list_price_cents` | integer | yes |  |
| `discount_bp` | integer | yes |  |
| `price_basis` | text | no | `'legacy'::text` |
| `added_by_employee_id` | uuid | yes |  |

Primary key `(id)`. `(added_by_employee_id)` references `employees(id)` on delete set null. `(added_by)` references `users(id)` on delete set null. `(appointment_id)` references `appointments(id)` on delete cascade. `(service_id)` references `services(id)`. 5 check constraints. Index `appointment_addons_appointment_idx` `(appointment_id)`. Unique index `uq_appointment_addons_live` `(appointment_id, service_id)` where `removed_at IS NULL`.

#### `appointment_late_texts`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `appointment_id` | uuid | no |  |
| `seq` | smallint | no |  |
| `eta_at` | timestamp with time zone | no |  |
| `message_id` | uuid | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(appointment_id, seq)`. `(appointment_id)` references `appointments(id)` on delete cascade. `(message_id)` references `messages(id)` on delete set null. 1 check constraint.

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
| `uploaded_by_employee_id` | uuid | yes |  |

Primary key `(id)`. `(appointment_id)` references `appointments(id)` on delete cascade. `(uploaded_by_employee_id)` references `employees(id)` on delete set null. `(uploaded_by)` references `users(id)` on delete set null. 4 check constraints. Index `appointment_photos_appointment_idx` `(appointment_id, category)`.

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
| `categories` | text[] | no | `'{}'::text[]` |
| `booked_with_pin` | boolean | no | `false` |
| `vehicle_class` | text | yes |  |
| `vehicle_class_label` | text | yes |  |
| `class_confirmed_at` | timestamp with time zone | yes |  |
| `list_price_cents` | integer | yes |  |
| `discount_bp` | integer | yes |  |
| `price_basis` | text | no | `'legacy'::text` |
| `created_by_employee_id` | uuid | yes |  |

Primary key `(id)`. Unique `(seq)`. `(assigned_employee_id)` references `employees(id)` on delete set null. `(bay_id)` references `bays(id)`. `(created_by_employee_id)` references `employees(id)` on delete set null. `(created_by)` references `users(id)` on delete set null. `(customer_id)` references `customers(id)`. `(emergency_closure_id)` references `emergency_closures(id)`. `(location_id)` references `locations(id)` on delete cascade. `(planned_bay_id)` references `bays(id)`. `(service_id)` references `services(id)`. `(vehicle_id)` references `vehicles(id)`. 15 check constraints. Index `appointments_active_idx` `(status)` where `status = ANY (ARRAY['booked'::text, 'confirmed'::text, 'arrived'::text, 'cleaning'::text])`. Index `appointments_categories_idx` `(categories)`. Index `appointments_customer_idx` `(customer_id, scheduled_start DESC)`. Index `appointments_emergency_idx` `(emergency_closure_id)` where `emergency_closure_id IS NOT NULL`. Index `appointments_location_start_idx` `(location_id, scheduled_start)`. Index `appointments_location_status_start_idx` `(location_id, status, scheduled_start)`. Index `appointments_planned_bay_idx` `(planned_bay_id, scheduled_start)` where `planned_bay_id IS NOT NULL`. Unique index `uq_appointments_arrival_token` `(arrival_token_hash)` where `arrival_token_hash IS NOT NULL`. Unique index `uq_bay_occupied` `(bay_id)` where `status = 'cleaning'::text`.

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

#### `assistant_conversations`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `phone_e164` | text | no |  |
| `customer_id` | uuid | yes |  |
| `pending_since` | timestamp with time zone | yes |  |
| `last_inbound_at` | timestamp with time zone | yes |  |
| `running_since` | timestamp with time zone | yes |  |
| `handoff_state` | text | yes |  |
| `handoff_reason` | text | yes |  |
| `handoff_at` | timestamp with time zone | yes |  |
| `last_fallback_at` | timestamp with time zone | yes |  |
| `disclosed_at` | timestamp with time zone | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |
| `language` | text | no | `'en'::text` |

Primary key `(id)`. Unique `(location_id, phone_e164)`. `(customer_id)` references `customers(id)` on delete set null. `(location_id)` references `locations(id)` on delete cascade. 5 check constraints. Index `assistant_conversations_customer_idx` `(customer_id)` where `customer_id IS NOT NULL`. Index `assistant_conversations_handoff_idx` `(location_id, handoff_at)` where `handoff_state = 'open'::text`. Index `assistant_conversations_pending_idx` `(pending_since)` where `pending_since IS NOT NULL`. Index `assistant_conversations_running_idx` `(running_since)` where `running_since IS NOT NULL`.

#### `assistant_knowledge`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `kind` | text | no |  |
| `title` | text | no |  |
| `body` | text | no |  |
| `question` | text | yes |  |
| `wrong_reply` | text | yes |  |
| `source` | text | no | `'manual'::text` |
| `assistant_turn_id` | uuid | yes |  |
| `practice_turn_id` | uuid | yes |  |
| `document_id` | uuid | yes |  |
| `active` | boolean | no | `false` |
| `reviewed_at` | timestamp with time zone | yes |  |
| `warnings` | jsonb | no | `'[]'::jsonb` |
| `chars` | integer | no |  |
| `sort` | integer | no | `0` |
| `version` | integer | no | `1` |
| `created_by` | uuid | yes |  |
| `updated_by` | uuid | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(document_id)`. `(assistant_turn_id)` references `assistant_turns(id)` on delete set null. `(created_by)` references `users(id)` on delete set null. `(document_id)` references `assistant_knowledge_documents(id)` on delete cascade. `(location_id)` references `locations(id)` on delete cascade. `(updated_by)` references `users(id)` on delete set null. 13 check constraints. Index `assistant_knowledge_active_idx` `(location_id)` where `active`. Index `assistant_knowledge_location_idx` `(location_id, kind, sort, created_at)`.

#### `assistant_knowledge_documents`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `filename` | text | no |  |
| `content_type` | text | no |  |
| `bytes` | integer | no |  |
| `sha256` | text | yes |  |
| `s3_key` | text | no |  |
| `status` | text | no | `'pending_upload'::text` |
| `error_code` | text | yes |  |
| `page_count` | integer | yes |  |
| `extracted_text` | text | yes |  |
| `removed_chars` | integer | no | `0` |
| `attempts` | smallint | no | `0` |
| `uploaded_by` | uuid | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |
| `deleted_at` | timestamp with time zone | yes |  |
| `object_deleted_at` | timestamp with time zone | yes |  |

Primary key `(id)`. Unique `(s3_key)`. `(location_id)` references `locations(id)` on delete cascade. `(uploaded_by)` references `users(id)` on delete set null. 14 check constraints. Index `assistant_knowledge_documents_cleanup_idx` `(status, updated_at)` where `(status = ANY (ARRAY['pending_upload'::text, 'extracting'::text])) OR ((status = 'deleted'::text) AND (object_deleted_at IS NULL))`. Index `assistant_knowledge_documents_location_idx` `(location_id, created_at)`. Unique index `assistant_knowledge_documents_sha_idx` `(location_id, sha256)` where `(status <> 'deleted'::text) AND (sha256 IS NOT NULL)`.

#### `assistant_pending_actions`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `conversation_id` | uuid | no |  |
| `customer_id` | uuid | no |  |
| `phone_e164` | text | no |  |
| `kind` | text | no |  |
| `payload` | jsonb | no |  |
| `code_hash` | text | no |  |
| `attempts` | smallint | no | `0` |
| `max_attempts` | smallint | no | `3` |
| `expires_at` | timestamp with time zone | no |  |
| `state` | text | no | `'pending'::text` |
| `confirm_message_id` | uuid | yes |  |
| `appointment_id` | uuid | yes |  |
| `error` | text | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `resolved_at` | timestamp with time zone | yes |  |

Primary key `(id)`. `(appointment_id)` references `appointments(id)` on delete set null. `(confirm_message_id)` references `messages(id)` on delete set null. `(conversation_id)` references `assistant_conversations(id)` on delete cascade. `(customer_id)` references `customers(id)` on delete cascade. `(location_id)` references `locations(id)` on delete cascade. 10 check constraints. Index `assistant_pending_actions_conversation_idx` `(conversation_id)`. Index `assistant_pending_actions_expiry_idx` `(expires_at)` where `state = 'pending'::text`. Unique index `uq_assistant_pending_actions_phone` `(location_id, phone_e164)` where `state = 'pending'::text`.

#### `assistant_practice_sessions`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `user_id` | uuid | no |  |
| `persona` | text | no |  |
| `customer_id` | uuid | yes |  |
| `verified` | boolean | no | `false` |
| `include_entry_ids` | uuid[] | no | `'{}'::uuid[]` |
| `language` | text | no | `'en'::text` |
| `state` | jsonb | no | `'{}'::jsonb` |
| `turns` | integer | no | `0` |
| `cost_micros` | bigint | no | `0` |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. `(customer_id)` references `customers(id)` on delete cascade. `(location_id)` references `locations(id)` on delete cascade. `(user_id)` references `users(id)` on delete cascade. 7 check constraints. Index `assistant_practice_sessions_created_idx` `(created_at)`. Index `assistant_practice_sessions_user_idx` `(user_id, created_at DESC)`.

#### `assistant_practice_turns`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `session_id` | uuid | no |  |
| `seq` | integer | no |  |
| `rerun_of` | uuid | yes |  |
| `client_text` | text | no |  |
| `status` | text | no | `'running'::text` |
| `reply_text` | text | yes |  |
| `extra_texts` | jsonb | no | `'[]'::jsonb` |
| `badges` | jsonb | no | `'[]'::jsonb` |
| `error` | text | yes |  |
| `model` | text | yes |  |
| `prompt_version` | text | yes |  |
| `facts_version` | text | yes |  |
| `tokens_in` | integer | no | `0` |
| `tokens_out` | integer | no | `0` |
| `tokens_cache_read` | integer | no | `0` |
| `tokens_cache_write` | integer | no | `0` |
| `cost_micros` | bigint | no | `0` |
| `latency_ms` | integer | yes |  |
| `state_before` | jsonb | no | `'{}'::jsonb` |
| `transcript` | jsonb | yes |  |
| `tool_calls` | jsonb | no | `'[]'::jsonb` |
| `started_at` | timestamp with time zone | no | `app_now()` |
| `finished_at` | timestamp with time zone | yes |  |

Primary key `(id)`. `(rerun_of)` references `assistant_practice_turns(id)` on delete cascade. `(session_id)` references `assistant_practice_sessions(id)` on delete cascade. 16 check constraints. Unique index `assistant_practice_turns_running_idx` `(session_id)` where `status = 'running'::text`. Unique index `assistant_practice_turns_seq_idx` `(session_id, seq)` where `rerun_of IS NULL`. Index `assistant_practice_turns_session_idx` `(session_id, started_at)`. Index `assistant_practice_turns_started_idx` `(started_at)`.

#### `assistant_tool_calls`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `turn_id` | uuid | no |  |
| `seq` | smallint | no |  |
| `round` | smallint | no |  |
| `tool` | text | no |  |
| `tool_use_id` | text | yes |  |
| `input` | jsonb | no |  |
| `output` | jsonb | yes |  |
| `outcome` | text | no |  |
| `error` | text | yes |  |
| `latency_ms` | integer | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(turn_id, seq)`. `(turn_id)` references `assistant_turns(id)` on delete cascade. 7 check constraints. Index `assistant_tool_calls_tool_idx` `(tool, created_at)`.

#### `assistant_turns`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `conversation_id` | uuid | no |  |
| `status` | text | no | `'running'::text` |
| `trust` | text | no |  |
| `provider` | text | no |  |
| `model` | text | yes |  |
| `prompt_version` | text | yes |  |
| `rounds` | smallint | no | `0` |
| `tokens_in` | integer | no | `0` |
| `tokens_out` | integer | no | `0` |
| `tokens_cache_read` | integer | no | `0` |
| `tokens_cache_write` | integer | no | `0` |
| `cost_micros` | bigint | no | `0` |
| `stop_reason` | text | yes |  |
| `latency_ms` | integer | yes |  |
| `reply_message_id` | uuid | yes |  |
| `transcript` | jsonb | no | `'[]'::jsonb` |
| `error` | text | yes |  |
| `started_at` | timestamp with time zone | no | `app_now()` |
| `finished_at` | timestamp with time zone | yes |  |

Primary key `(id)`. `(conversation_id)` references `assistant_conversations(id)` on delete cascade. `(reply_message_id)` references `messages(id)` on delete set null. 13 check constraints. Index `assistant_turns_conversation_idx` `(conversation_id, started_at DESC)`. Index `assistant_turns_started_idx` `(started_at)`. Unique index `uq_assistant_turns_running` `(conversation_id)` where `status = 'running'::text`.

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
| `kiosk_device_id` | uuid | yes |  |

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

#### `card_consents`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `customer_id` | uuid | no |  |
| `card_id` | uuid | no |  |
| `purposes` | text[] | no |  |
| `text_version` | text | no |  |
| `text_sha256` | text | no |  |
| `text_snapshot` | text | no |  |
| `accepted_at` | timestamp with time zone | no |  |
| `ip` | inet | yes |  |
| `user_agent` | text | yes |  |
| `link_id` | uuid | yes |  |
| `session_hash` | text | yes |  |
| `revoked_at` | timestamp with time zone | yes |  |
| `revoked_by` | text | yes |  |
| `revoke_reason` | text | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. `(card_id)` references `customer_cards(id)`. `(customer_id)` references `customers(id)`. `(location_id)` references `locations(id)` on delete cascade. 8 check constraints. Index `card_consents_card_idx` `(card_id)` where `revoked_at IS NULL`. Index `card_consents_customer_idx` `(customer_id, accepted_at)`. Trigger: `card_consents_guard`.

#### `catalog_categories`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `location_id` | uuid | no |  |
| `key` | text | no |  |
| `label` | text | no |  |
| `colour` | text | no |  |
| `sort` | integer | no | `0` |
| `active` | boolean | no | `true` |
| `version` | integer | no | `1` |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(location_id, key)`. `(location_id)` references `locations(id)` on delete cascade. 3 check constraints.

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

#### `client_link_sessions`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `token_hash` | text | no |  |
| `link_id` | uuid | no |  |
| `customer_id` | uuid | yes |  |
| `phone_e164` | text | no |  |
| `trust` | text | no | `'link'::text` |
| `verified_by` | text | yes |  |
| `step_up_at` | timestamp with time zone | yes |  |
| `failed_attempts` | smallint | no | `0` |
| `idle_expires_at` | timestamp with time zone | no |  |
| `expires_at` | timestamp with time zone | no |  |
| `revoked_at` | timestamp with time zone | yes |  |
| `ip` | text | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `last_used_at` | timestamp with time zone | yes |  |

Primary key `(token_hash)`. `(customer_id)` references `customers(id)` on delete cascade. `(link_id)` references `client_links(id)` on delete cascade. 7 check constraints. Index `client_link_sessions_customer_idx` `(customer_id)` where `customer_id IS NOT NULL`. Index `client_link_sessions_expiry_idx` `(expires_at)`. Index `client_link_sessions_link_idx` `(link_id)`.

#### `client_links`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `token_hash` | text | no |  |
| `kind` | text | no |  |
| `customer_id` | uuid | yes |  |
| `phone_e164` | text | no |  |
| `appointment_id` | uuid | yes |  |
| `invoice_id` | uuid | yes |  |
| `plan_key` | text | yes |  |
| `pin_version` | integer | no | `0` |
| `phone_version` | integer | no | `0` |
| `epoch` | integer | no |  |
| `issued_by` | text | no |  |
| `expires_at` | timestamp with time zone | no |  |
| `uses` | integer | no | `0` |
| `max_uses` | integer | no |  |
| `consumed_at` | timestamp with time zone | yes |  |
| `revoked_at` | timestamp with time zone | yes |  |
| `revoke_reason` | text | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `retexted_at` | timestamp with time zone | yes |  |

Primary key `(id)`. Unique `(token_hash)`. `(appointment_id)` references `appointments(id)` on delete cascade. `(customer_id)` references `customers(id)` on delete cascade. `(invoice_id)` references `invoices(id)` on delete cascade. `(location_id)` references `locations(id)` on delete cascade. `(location_id, plan_key)` references `membership_plans(location_id, key)`. 18 check constraints. Index `client_links_customer_live_idx` `(customer_id, kind)` where `(consumed_at IS NULL) AND (revoked_at IS NULL)`. Index `client_links_expiry_idx` `(expires_at)`. Index `client_links_phone_idx` `(location_id, phone_e164, created_at DESC)`.

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

#### `customer_cards`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `customer_id` | uuid | no |  |
| `square_customer_id` | text | no |  |
| `square_card_id` | text | no |  |
| `brand` | text | yes |  |
| `last4` | text | yes |  |
| `exp_month` | smallint | yes |  |
| `exp_year` | smallint | yes |  |
| `card_type` | text | yes |  |
| `postal` | text | yes |  |
| `fingerprint` | text | yes |  |
| `state` | text | no | `'active'::text` |
| `created_via` | text | no |  |
| `disabled_at` | timestamp with time zone | yes |  |
| `disabled_reason` | text | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |
| `expiry_notice_for` | text | yes |  |

Primary key `(id)`. Unique `(square_card_id)`. `(customer_id)` references `customers(id)`. `(location_id)` references `locations(id)` on delete cascade. 9 check constraints. Index `customer_cards_customer_idx` `(customer_id, created_at)`.

#### `customer_pins`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `customer_id` | uuid | no |  |
| `pin_hash` | text | yes |  |
| `version` | integer | no | `1` |
| `failed_attempts` | smallint | no | `0` |
| `lock_level` | smallint | no | `0` |
| `locked_until` | timestamp with time zone | yes |  |
| `set_at` | timestamp with time zone | no |  |
| `reset_hold_until` | timestamp with time zone | yes |  |
| `cleared_at` | timestamp with time zone | yes |  |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(customer_id)`. `(customer_id)` references `customers(id)` on delete cascade. 5 check constraints.

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
| `email_verified` | boolean | no | `false` |
| `phone_version` | integer | no | `0` |
| `archived_at` | timestamp with time zone | yes |  |
| `identity_confirmed_at` | timestamp with time zone | yes |  |
| `phone_reassigned_at` | timestamp with time zone | yes |  |
| `phone_reassigned_to` | uuid | yes |  |

Primary key `(id)`. `(merged_into)` references `customers(id)`. `(phone_reassigned_to)` references `customers(id)` on delete set null. 9 check constraints. Index `customers_archived_phone_idx` `(phone_e164)` where `archived_at IS NOT NULL`. Index `customers_email_trgm` `(((email)::text) public.gin_trgm_ops)`. Index `customers_full_name_trgm` `(full_name public.gin_trgm_ops)`. Index `customers_merged_into_idx` `(merged_into)` where `merged_into IS NOT NULL`. Index `customers_phone_trgm` `(phone_e164 public.gin_trgm_ops)`. Index `customers_provisional_idx` `(created_at)` where `(source = 'inbound_sms'::text) AND needs_details AND (deleted_at IS NULL) AND (merged_into IS NULL)`. Unique index `uq_customers_phone` `(phone_e164)` where `(phone_e164 IS NOT NULL) AND (merged_into IS NULL) AND (deleted_at IS NULL)`. Trigger: `customers_email_unverify`.

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
| `kiosk_listed` | boolean | no | `true` |

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

#### `identity_pin_failures`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `customer_id` | uuid | yes |  |
| `phone_e164` | text | no |  |
| `ip` | text | yes |  |
| `at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. `(customer_id)` references `customers(id)` on delete cascade. `(location_id)` references `locations(id)` on delete cascade. 1 check constraint. Index `identity_pin_failures_at_idx` `(at)`. Index `identity_pin_failures_customer_idx` `(customer_id, at DESC)` where `customer_id IS NOT NULL`. Index `identity_pin_failures_ip_idx` `(location_id, ip, at DESC)` where `ip IS NOT NULL`.

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
| `list_cents` | integer | yes |  |
| `discount_bp` | integer | yes |  |
| `price_basis` | text | no | `'legacy'::text` |

Primary key `(id)`. `(appointment_addon_id)` references `appointment_addons(id)`. `(invoice_id)` references `invoices(id)` on delete cascade. `(service_id)` references `services(id)`. 7 check constraints. Index `invoice_items_invoice_idx` `(invoice_id, "position")`.

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
| `vehicle_class_label` | text | yes |  |

Primary key `(id)`. Unique `(appointment_id)`. Unique `(location_id, invoice_no)`. `(appointment_id)` references `appointments(id)`. `(canceled_by)` references `users(id)` on delete set null. `(customer_id)` references `customers(id)`. `(location_id)` references `locations(id)` on delete cascade. 7 check constraints. Index `invoices_biz_date_idx` `(location_id, biz_date DESC, invoice_no DESC)`. Index `invoices_customer_idx` `(customer_id, biz_date DESC)`.

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

#### `kiosk_codes`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `code_hash` | text | no |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `created_by` | uuid | yes |  |
| `created_by_name` | text | yes |  |
| `retired_at` | timestamp with time zone | yes |  |

Primary key `(id)`. `(created_by)` references `users(id)` on delete set null. `(location_id)` references `locations(id)` on delete cascade. 1 check constraint. Unique index `kiosk_codes_current_uq` `(location_id)` where `retired_at IS NULL`. Index `kiosk_codes_history_idx` `(location_id, created_at DESC)`.

#### `kiosk_devices`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `name` | text | no |  |
| `token_hash` | text | no |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `created_by` | uuid | yes |  |
| `created_by_name` | text | yes |  |
| `last_seen_at` | timestamp with time zone | yes |  |
| `last_ip` | inet | yes |  |
| `last_ua` | text | yes |  |
| `failed_attempts` | integer | no | `0` |
| `last_failed_at` | timestamp with time zone | yes |  |
| `locked_out_at` | timestamp with time zone | yes |  |
| `revoked_at` | timestamp with time zone | yes |  |
| `revoked_by` | uuid | yes |  |
| `version` | integer | no | `1` |

Primary key `(id)`. Unique `(token_hash)`. `(created_by)` references `users(id)` on delete set null. `(location_id)` references `locations(id)` on delete cascade. `(revoked_by)` references `users(id)` on delete set null. 3 check constraints. Index `kiosk_devices_live_idx` `(location_id)` where `revoked_at IS NULL`.

#### `kiosk_sessions`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | text | no |  |
| `device_id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `code_id` | uuid | no |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `expires_at` | timestamp with time zone | no |  |
| `lock_rule` | text | no |  |
| `csrf_secret` | text | no |  |
| `ip` | inet | yes |  |
| `ua` | text | yes |  |
| `last_seen_at` | timestamp with time zone | no | `app_now()` |
| `revoked_at` | timestamp with time zone | yes |  |
| `revoked_reason` | text | yes |  |

Primary key `(id)`. `(code_id)` references `kiosk_codes(id)` on delete cascade. `(device_id)` references `kiosk_devices(id)` on delete cascade. `(location_id)` references `locations(id)` on delete cascade. 5 check constraints. Index `kiosk_sessions_live_idx` `(device_id)` where `revoked_at IS NULL`. Index `kiosk_sessions_location_live_idx` `(location_id)` where `revoked_at IS NULL`.

#### `leads`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `phone_e164` | text | no |  |
| `customer_id` | uuid | yes |  |
| `source` | text | no |  |
| `interests` | text[] | no | `'{}'::text[]` |
| `status` | text | no | `'new'::text` |
| `first_contact_at` | timestamp with time zone | no |  |
| `last_contact_at` | timestamp with time zone | no |  |
| `follow_up_at` | timestamp with time zone | yes |  |
| `follow_up_message_id` | uuid | yes |  |
| `booked_appointment_id` | uuid | yes |  |
| `closed_at` | timestamp with time zone | yes |  |
| `version` | integer | no | `1` |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(location_id, phone_e164)`. `(booked_appointment_id)` references `appointments(id)` on delete set null. `(customer_id)` references `customers(id)` on delete set null. `(follow_up_message_id)` references `messages(id)` on delete set null. `(location_id)` references `locations(id)` on delete cascade. 6 check constraints. Index `leads_customer_idx` `(customer_id)` where `customer_id IS NOT NULL`. Index `leads_follow_up_due_idx` `(follow_up_at)` where `(status = 'new'::text) AND (follow_up_at IS NOT NULL)`. Index `leads_open_idx` `(location_id, last_contact_at DESC)` where `status = ANY (ARRAY['new'::text, 'followed_up'::text])`.

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
| `processor` | text | yes |  |
| `processor_order_id` | text | yes |  |

Primary key `(id)`. Unique `(idempotency_key)`. Unique `(seq)`. `(actor_employee_id)` references `employees(id)` on delete set null. `(actor_user_id)` references `users(id)` on delete set null. `(approved_by_employee_id)` references `employees(id)` on delete set null. `(approved_by_user_id)` references `users(id)` on delete set null. `(customer_id)` references `customers(id)`. `(denied_by_employee_id)` references `employees(id)` on delete set null. `(denied_by_user_id)` references `users(id)` on delete set null. `(invoice_id)` references `invoices(id)`. `(location_id)` references `locations(id)` on delete cascade. `(parent_event_id)` references `ledger_events(id)`. `(voids_event_id)` references `ledger_events(id)`. 20 check constraints. Index `ledger_events_awaiting_idx` `(location_id, occurred_at)` where `processor_state = 'awaiting_processor'::text`. Index `ledger_events_customer_idx` `(customer_id, type, occurred_at)`. Index `ledger_events_invoice_idx` `(invoice_id, occurred_at DESC, seq DESC)`. Index `ledger_events_pay_actor_idx` `(actor_employee_id, occurred_at)` where `type = 'pay'::text`. Index `ledger_events_pending_idx` `(location_id, occurred_at)` where `status = 'pending'::text`. Index `ledger_events_processor_ref_idx` `(processor, processor_ref)` where `processor_ref IS NOT NULL`. Index `ledger_events_sqsp_order_idx` `(sqsp_order_id)` where `sqsp_order_id IS NOT NULL`. Trigger: `ledger_events_guard`.

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

#### `membership_checkouts`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `membership_id` | uuid | no |  |
| `customer_id` | uuid | no |  |
| `link_id` | uuid | yes |  |
| `plan_key` | text | no |  |
| `product_key` | text | yes |  |
| `expected_email` | citext | yes |  |
| `checkout_url` | text | yes |  |
| `started_at` | timestamp with time zone | no |  |
| `expires_at` | timestamp with time zone | no |  |
| `state` | text | no | `'open'::text` |
| `matched_order_id` | uuid | yes |  |
| `matched_at` | timestamp with time zone | yes |  |
| `version` | integer | no | `1` |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |
| `origin` | text | no | `'link'::text` |
| `plan_class` | text | yes |  |

Primary key `(id)`. `(customer_id)` references `customers(id)` on delete cascade. `(link_id)` references `client_links(id)` on delete set null. `(location_id)` references `locations(id)` on delete cascade. `(matched_order_id)` references `sqsp_orders(id)` on delete set null. `(membership_id, customer_id)` references `memberships(id, customer_id)`. `(membership_id)` references `memberships(id)` on delete cascade. `(location_id, plan_key)` references `membership_plans(location_id, key)`. 11 check constraints. Index `membership_checkouts_awaiting_idx` `(location_id, created_at DESC)` where `state = 'awaiting_match'::text`. Index `membership_checkouts_customer_idx` `(customer_id, started_at DESC)`. Index `membership_checkouts_email_idx` `(location_id, expected_email)` where `state = ANY (ARRAY['open'::text, 'awaiting_match'::text])`. Index `membership_checkouts_expiry_idx` `(expires_at)` where `state = 'open'::text`. Index `membership_checkouts_order_idx` `(matched_order_id)` where `matched_order_id IS NOT NULL`. Unique index `uq_membership_checkouts_open` `(membership_id)` where `state = 'open'::text`. Unique index `uq_membership_checkouts_sync_order` `(customer_id, matched_order_id)` where `origin = 'sync'::text`.

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
| `inclusion_id` | uuid | yes |  |
| `service_id` | uuid | yes |  |
| `line_cents` | integer | yes |  |
| `covered_cents` | integer | yes |  |
| `plan_class` | text | yes |  |
| `visit_class` | text | yes |  |

Primary key `(id)`. Unique `(idempotency_key)`. `(actor_user_id)` references `users(id)` on delete set null. `(appointment_id)` references `appointments(id)`. `(inclusion_id)` references `membership_inclusions(id)` on delete set null. `(invoice_id)` references `invoices(id)`. `(ledger_event_id)` references `ledger_events(id)`. `(membership_id)` references `memberships(id)` on delete cascade. `(rule_id)` references `plan_credit_rules(id)` on delete set null. `(service_id)` references `services(id)`. 7 check constraints. Index `membership_credit_events_appointment_idx` `(appointment_id)` where `appointment_id IS NOT NULL`. Index `membership_credit_events_cycle_idx` `(membership_id, cycle_start)`.

#### `membership_household`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `membership_id` | uuid | no |  |
| `customer_id` | uuid | no |  |
| `added_at` | timestamp with time zone | no | `app_now()` |
| `added_by` | uuid | yes |  |
| `removed_at` | timestamp with time zone | yes |  |

Primary key `(id)`. `(customer_id)` references `customers(id)`. `(membership_id)` references `memberships(id)` on delete cascade. 1 check constraint. Index `membership_household_membership_idx` `(membership_id)`. Unique index `uq_membership_household_customer_live` `(customer_id)` where `removed_at IS NULL`.

#### `membership_inclusion_services`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `inclusion_id` | uuid | no |  |
| `service_id` | uuid | no |  |

Primary key `(inclusion_id, service_id)`. `(inclusion_id)` references `membership_inclusions(id)` on delete cascade. `(service_id)` references `services(id)` on delete cascade. Index `membership_inclusion_services_service_idx` `(service_id)`.

#### `membership_inclusions`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `plan_id` | uuid | no |  |
| `label` | text | no |  |
| `mode` | text | no | `'per_cycle'::text` |
| `per_cycle` | integer | yes |  |
| `auto_apply` | boolean | no | `true` |
| `sort` | integer | no | `0` |
| `active` | boolean | no | `true` |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. `(plan_id)` references `membership_plans(id)` on delete cascade. 4 check constraints. Index `membership_inclusions_plan_idx` `(plan_id, sort)`.

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
| `monthly_price_cents` | integer | yes |  |
| `checkout_url` | text | yes |  |
| `public_label` | text | yes |  |
| `member_discount_bp` | integer | no | `0` |
| `public` | boolean | no | `false` |
| `vip_booking` | boolean | no | `false` |
| `max_vehicles` | integer | yes |  |
| `price_version` | integer | no | `1` |
| `square_plan_id` | text | yes |  |
| `legacy_key` | text | yes |  |

Primary key `(id)`. Unique `(location_id, key)`. `(location_id)` references `locations(id)` on delete cascade. 13 check constraints. Unique index `uq_membership_plans_legacy_key` `(location_id, legacy_key)` where `legacy_key IS NOT NULL`.

#### `membership_tier_prices`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `plan_id` | uuid | no |  |
| `class_key` | text | no |  |
| `monthly_cents` | integer | no |  |
| `effective_from` | timestamp with time zone | no | `app_now()` |
| `superseded_at` | timestamp with time zone | yes |  |
| `price_version` | integer | no |  |
| `square_variation_id` | text | yes |  |
| `square_state` | text | no | `'pending'::text` |
| `square_synced_at` | timestamp with time zone | yes |  |
| `created_by` | uuid | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `square_error` | text | yes |  |

Primary key `(id)`. `(location_id, class_key)` references `vehicle_classes(location_id, key)`. `(location_id)` references `locations(id)` on delete cascade. `(plan_id)` references `membership_plans(id)` on delete cascade. 6 check constraints. Index `membership_tier_prices_plan_idx` `(plan_id, class_key, effective_from)`. Unique index `uq_membership_tier_prices_current` `(plan_id, class_key)` where `superseded_at IS NULL`. Unique index `uq_membership_tier_prices_square_variation` `(square_variation_id)` where `square_variation_id IS NOT NULL`. Trigger: `membership_tier_prices_guard`.

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
| `plan_class` | text | no |  |
| `tier_price_id` | uuid | yes |  |
| `square_subscription_id` | text | yes |  |
| `square_customer_id` | text | yes |  |
| `card_id` | uuid | yes |  |
| `square_status` | text | yes |  |
| `billing_status` | text | no | `'ok'::text` |
| `payment_failed_at` | timestamp with time zone | yes |  |
| `failure_notified_at` | timestamp with time zone | yes |  |
| `cancel_effective_at` | date | yes |  |
| `pause_effective_at` | date | yes |  |
| `scheduled_change` | jsonb | yes |  |
| `swap_undone_variations` | text[] | no | `'{}'::text[]` |
| `square_synced_at` | timestamp with time zone | yes |  |

Primary key `(id)`. Unique `(id, customer_id)`. `(card_id)` references `customer_cards(id)`. `(customer_id)` references `customers(id)`. `(location_id)` references `locations(id)` on delete cascade. `(location_id, plan_class)` references `vehicle_classes(location_id, key)`. `(plan_id)` references `membership_plans(id)`. `(tier_price_id)` references `membership_tier_prices(id)`. 11 check constraints. Index `memberships_billing_failed_idx` `(location_id, payment_failed_at)` where `billing_status = 'failed'::text`. Index `memberships_plan_idx` `(plan_id)`. Index `memberships_status_idx` `(location_id, status)`. Unique index `uq_memberships_customer_live` `(customer_id)` where `status = ANY (ARRAY['pending'::text, 'active'::text, 'past_due'::text, 'paused'::text])`. Unique index `uq_memberships_square_subscription` `(square_subscription_id)` where `square_subscription_id IS NOT NULL`. Trigger: `memberships_default_plan_class`.

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
| `ai_paused_until` | timestamp with time zone | yes |  |
| `ai_paused_by` | uuid | yes |  |

Primary key `(id)`. Unique `(location_id, customer_id)`. `(ai_paused_by)` references `employees(id)` on delete set null. `(customer_id)` references `customers(id)`. `(location_id)` references `locations(id)` on delete cascade. 2 check constraints. Index `message_threads_unread_idx` `(location_id, last_inbound_at DESC)` where `unread_count > 0`.

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
| `kind` | text | no | `'sms'::text` |
| `attachments` | jsonb | yes |  |

Primary key `(id)`. Unique `(idempotency_key)`. `(appointment_id)` references `appointments(id)` on delete set null. `(customer_id)` references `customers(id)`. `(device_id)` references `sms_devices(id)` on delete set null. `(employee_id)` references `employees(id)` on delete set null. `(location_id)` references `locations(id)` on delete cascade. `(sender_employee_id)` references `employees(id)` on delete set null. `(thread_id)` references `message_threads(id)` on delete cascade. 10 check constraints. Index `messages_appointment_idx` `(appointment_id, queued_at, id)` where `appointment_id IS NOT NULL`. Index `messages_customer_idx` `(customer_id, queued_at DESC)` where `customer_id IS NOT NULL`. Index `messages_in_flight_idx` `(status)` where `status = ANY (ARRAY['queued'::text, 'sending'::text])`. Index `messages_provider_idx` `(provider_message_id)` where `provider_message_id IS NOT NULL`. Index `messages_staff_sender_idx` `(sender_employee_id, queued_at)` where `sender_kind = 'staff'::text`. Index `messages_thread_idx` `(thread_id, queued_at, id)` where `thread_id IS NOT NULL`. Index `messages_unread_idx` `(customer_id)` where `(direction = 'in'::text) AND (read_at IS NULL)`.

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
| `source_ref` | text | yes |  |

Primary key `(id)`. `(location_id)` references `locations(id)` on delete cascade. 1 check constraint. Index `notifications_location_idx` `(location_id, created_at DESC)`. Index `notifications_source_ref_idx` `(source_ref)` where `source_ref IS NOT NULL`. Index `notifications_unread_idx` `(employee_id)` where `read_at IS NULL`.

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
| `url` | text | yes |  |
| `expected_cents` | integer | no |  |
| `created_by` | uuid | yes |  |
| `sent_message_id` | uuid | yes |  |
| `sent_at` | timestamp with time zone | yes |  |
| `expires_at` | timestamp with time zone | yes |  |
| `state` | text | no | `'active'::text` |
| `matched_sqsp_order_id` | text | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `provider` | text | no | `'squarespace'::text` |
| `origin` | text | no | `'staff'::text` |
| `square_payment_link_id` | text | yes |  |
| `square_order_id` | text | yes |  |
| `square_version` | integer | yes |  |
| `invoice_version` | integer | yes |  |
| `canceled_at` | timestamp with time zone | yes |  |
| `cancel_reason` | text | yes |  |
| `square_deleted_at` | timestamp with time zone | yes |  |
| `paid_square_payment_id` | text | yes |  |
| `created_by_employee_id` | uuid | yes |  |

Primary key `(id)`. Unique `(square_order_id)`. Unique `(square_payment_link_id)`. `(created_by_employee_id)` references `employees(id)` on delete set null. `(created_by)` references `users(id)` on delete set null. `(invoice_id)` references `invoices(id)`. `(location_id)` references `locations(id)` on delete cascade. 9 check constraints. Index `payment_links_active_idx` `(location_id, created_at)` where `state = 'active'::text`. Index `payment_links_invoice_idx` `(invoice_id, created_at DESC)`. Index `payment_links_square_open_idx` `(location_id, created_at)` where `(provider = 'square'::text) AND (state = ANY (ARRAY['pending'::text, 'active'::text]))`.

#### `pending_checkin_texts`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `appointment_id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `due_at` | timestamp with time zone | no |  |
| `state` | text | no | `'pending'::text` |
| `drop_reason` | text | yes |  |
| `message_id` | uuid | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `settled_at` | timestamp with time zone | yes |  |

Primary key `(appointment_id)`. `(appointment_id)` references `appointments(id)` on delete cascade. `(location_id)` references `locations(id)` on delete cascade. `(message_id)` references `messages(id)` on delete set null. 4 check constraints. Index `pending_checkin_texts_due_idx` `(due_at)` where `state = 'pending'::text`.

#### `permissions`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `key` | text | no |  |
| `module` | text | no |  |
| `label` | text | no |  |
| `has_limit` | boolean | no | `false` |
| `sort` | smallint | no |  |

Primary key `(key)`. Unique `(sort)`.

#### `phone_trust`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `location_id` | uuid | no |  |
| `phone_e164` | text | no |  |
| `customer_id` | uuid | no |  |
| `verified_at` | timestamp with time zone | no |  |
| `verified_by` | text | no |  |
| `expires_at` | timestamp with time zone | no |  |
| `revoked_at` | timestamp with time zone | yes |  |
| `revoke_reason` | text | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |
| `epoch` | integer | no | `1` |

Primary key `(location_id, phone_e164)`. `(customer_id)` references `customers(id)` on delete cascade. `(location_id)` references `locations(id)` on delete cascade. 6 check constraints. Index `phone_trust_customer_idx` `(customer_id)`.

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

#### `public_member_tokens`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `token_hash` | text | no |  |
| `location_id` | uuid | no |  |
| `phone_e164` | text | no |  |
| `customer_id` | uuid | yes |  |
| `challenge_id` | uuid | yes |  |
| `expires_at` | timestamp with time zone | no |  |
| `last_used_at` | timestamp with time zone | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(token_hash)`. `(challenge_id)` references `public_otp_challenges(id)` on delete set null. `(customer_id)` references `customers(id)` on delete cascade. `(location_id)` references `locations(id)` on delete cascade. 1 check constraint. Index `public_member_tokens_expiry_idx` `(expires_at)`.

#### `public_otp_challenges`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `phone_e164` | text | no |  |
| `code_hash` | text | no |  |
| `attempts` | smallint | no | `0` |
| `max_attempts` | smallint | no | `3` |
| `expires_at` | timestamp with time zone | no |  |
| `consumed_at` | timestamp with time zone | yes |  |
| `consumed_reason` | text | yes |  |
| `requested_ip` | text | yes |  |
| `delivery` | text | no | `'queued'::text` |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `purpose` | text | no | `'website'::text` |
| `link_session_hash` | text | yes |  |

Primary key `(id)`. `(link_session_hash)` references `client_link_sessions(token_hash)` on delete set null. `(location_id)` references `locations(id)` on delete cascade. 6 check constraints. Index `public_otp_challenges_phone_idx` `(phone_e164, created_at DESC)`. Unique index `uq_public_otp_active_phone` `(location_id, phone_e164)` where `consumed_at IS NULL`.

#### `public_rate_limits`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `key` | text | no |  |
| `window_start` | timestamp with time zone | no |  |
| `count` | integer | no | `0` |

Primary key `(key, window_start)`. 1 check constraint. Index `public_rate_limits_window_idx` `(window_start)`.

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

#### `service_class_prices`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `service_id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `class_key` | text | no |  |
| `price_cents` | integer | no |  |
| `max_cents` | integer | yes |  |
| `updated_at` | timestamp with time zone | no | `app_now()` |
| `updated_by` | uuid | yes |  |

Primary key `(service_id, class_key)`. `(location_id, class_key)` references `vehicle_classes(location_id, key)`. `(location_id)` references `locations(id)` on delete cascade. `(service_id)` references `services(id)` on delete cascade. 2 check constraints. Index `service_class_prices_class_idx` `(location_id, class_key)`.

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
| `category` | text | no |  |
| `public_name` | text | yes |  |
| `description` | text | yes |  |
| `member_price_cents` | integer | yes |  |
| `guest_price_cents` | integer | yes |  |
| `vip_inclusion` | text | no | `'none'::text` |
| `vip_note` | text | yes |  |
| `quote_only` | boolean | no | `false` |
| `visible_online` | boolean | no | `true` |

Primary key `(id)`. `(location_id, category)` references `catalog_categories(location_id, key)`. `(location_id)` references `locations(id)` on delete cascade. 11 check constraints. Index `services_category_idx` `(location_id, category)` where `active`. Index `services_listing_idx` `(location_id, kind, sort, id)`. Unique index `uq_services_name` `(location_id, kind, lower(name))`. Trigger: `services_default_category`.

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
| `kiosk_device_id` | uuid | yes |  |

Primary key `(id)`. `(kiosk_device_id)` references `kiosk_devices(id)` on delete set null. `(user_id)` references `users(id)` on delete cascade. `(view_as_role_id)` references `roles(id)` on delete set null. 2 check constraints. Index `sessions_absolute_idx` `(absolute_expires_at)`. Index `sessions_user_idx` `(user_id)` where `revoked_at IS NULL`.

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
| `kind` | text | no | `'sms'::text` |
| `attachments` | jsonb | yes |  |
| `superseded_by` | uuid | yes |  |
| `superseded_at` | timestamp with time zone | yes |  |
| `assistant_conversation_id` | uuid | yes |  |
| `assistant_turn_id` | uuid | yes |  |

Primary key `(id)`. Unique `(device_id, provider_message_id)`. `(appointment_id)` references `appointments(id)` on delete set null. `(assistant_conversation_id)` references `assistant_conversations(id)` on delete set null. `(assistant_turn_id)` references `assistant_turns(id)` on delete set null. `(customer_id)` references `customers(id)`. `(device_id)` references `sms_devices(id)` on delete cascade. `(message_id)` references `messages(id)` on delete set null. `(superseded_by)` references `sms_inbox(id)` on delete set null. 4 check constraints. Index `sms_inbox_assistant_conversation_idx` `(assistant_conversation_id, received_at)` where `assistant_conversation_id IS NOT NULL`. Index `sms_inbox_from_idx` `(from_e164)` where `from_e164 IS NOT NULL`. Index `sms_inbox_quarantine_idx` `(received_at DESC)` where `quarantined AND (reviewed_at IS NULL)`.

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
| `klass` | text | yes |  |

Primary key `(id)`. `(device_id)` references `sms_devices(id)` on delete cascade. 2 check constraints. Index `sms_usage_provider_idx` `(provider_message_id)`. Index `sms_usage_window_idx` `(device_id, COALESCE(sent_at, accepted_at))`.

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

#### `square_charges`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `customer_id` | uuid | no |  |
| `card_id` | uuid | yes |  |
| `consent_id` | uuid | yes |  |
| `purpose` | text | no |  |
| `amount_cents` | integer | no |  |
| `state` | text | no | `'proposed'::text` |
| `idempotency_key` | text | no |  |
| `invoice_id` | uuid | yes |  |
| `appointment_id` | uuid | yes |  |
| `square_payment_id` | text | yes |  |
| `ledger_event_id` | uuid | yes |  |
| `error` | text | yes |  |
| `attempts` | integer | no | `0` |
| `proposed_by` | text | yes |  |
| `decided_by` | text | yes |  |
| `decided_by_user_id` | uuid | yes |  |
| `decided_at` | timestamp with time zone | yes |  |
| `charged_at` | timestamp with time zone | yes |  |
| `waive_reason` | text | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |
| `attempted_at` | timestamp with time zone | yes |  |
| `decline_code` | text | yes |  |
| `reason` | text | yes |  |
| `request_key` | text | yes |  |
| `charged_after_close_at` | timestamp with time zone | yes |  |
| `decided_by_employee_id` | uuid | yes |  |
| `decided_kiosk_device_id` | uuid | yes |  |

Primary key `(id)`. Unique `(idempotency_key)`. Unique `(square_payment_id)`. `(appointment_id)` references `appointments(id)`. `(card_id)` references `customer_cards(id)`. `(consent_id)` references `card_consents(id)`. `(customer_id)` references `customers(id)`. `(decided_by_employee_id)` references `employees(id)` on delete set null. `(decided_by_user_id)` references `users(id)` on delete set null. `(decided_kiosk_device_id)` references `kiosk_devices(id)` on delete set null. `(invoice_id)` references `invoices(id)`. `(ledger_event_id)` references `ledger_events(id)`. `(location_id)` references `locations(id)` on delete cascade. 11 check constraints. Index `square_charges_customer_idx` `(customer_id)`. Index `square_charges_invoice_idx` `(invoice_id)` where `invoice_id IS NOT NULL`. Unique index `square_charges_open_fee_idx` `(appointment_id, purpose)` where `(appointment_id IS NOT NULL) AND (purpose = ANY (ARRAY['no_show_fee'::text, 'late_cancel_fee'::text])) AND (state = ANY (ARRAY['proposed'::text, 'charging'::text, 'unknown'::text, 'declined'::text]))`. Index `square_charges_open_idx` `(location_id, created_at)` where `state = ANY (ARRAY['proposed'::text, 'charging'::text, 'unknown'::text])`. Unique index `square_charges_request_key_idx` `(location_id, request_key)` where `request_key IS NOT NULL`.

#### `square_customer_links`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `customer_id` | uuid | no |  |
| `square_customer_id` | text | no |  |
| `linked_by` | text | no |  |
| `created_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(location_id, customer_id)`. Unique `(location_id, square_customer_id)`. `(customer_id)` references `customers(id)`. `(location_id)` references `locations(id)` on delete cascade. 2 check constraints.

#### `square_enrollments`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `customer_id` | uuid | no |  |
| `membership_id` | uuid | no |  |
| `link_id` | uuid | yes |  |
| `plan_id` | uuid | no |  |
| `tier_price_id` | uuid | no |  |
| `plan_class` | text | no |  |
| `square_variation_id` | text | no |  |
| `monthly_cents` | integer | no |  |
| `email` | text | no |  |
| `state` | text | no | `'started'::text` |
| `square_customer_id` | text | yes |  |
| `card_id` | uuid | yes |  |
| `consent_id` | uuid | yes |  |
| `square_subscription_id` | text | yes |  |
| `start_date` | date | no |  |
| `failure_code` | text | yes |  |
| `failure_detail` | text | yes |  |
| `cleanup` | text | no | `'none'::text` |
| `attempts` | integer | no | `0` |
| `last_attempt_at` | timestamp with time zone | yes |  |
| `started_at` | timestamp with time zone | no |  |
| `finished_at` | timestamp with time zone | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. `(card_id)` references `customer_cards(id)`. `(consent_id)` references `card_consents(id)`. `(customer_id)` references `customers(id)`. `(location_id)` references `locations(id)` on delete cascade. `(membership_id)` references `memberships(id)`. `(plan_id)` references `membership_plans(id)`. `(tier_price_id)` references `membership_tier_prices(id)`. 14 check constraints. Index `square_enrollments_membership_idx` `(membership_id, started_at)`. Index `square_enrollments_open_idx` `(location_id, state, started_at)` where `(state = ANY (ARRAY['started'::text, 'customer_ready'::text, 'card_saved'::text, 'subscribed'::text])) OR (cleanup = 'pending'::text)`. Unique index `uq_square_enrollments_live` `(membership_id)` where `state = ANY (ARRAY['started'::text, 'customer_ready'::text, 'card_saved'::text, 'subscribed'::text])`. Unique index `uq_square_enrollments_subscription` `(square_subscription_id)` where `square_subscription_id IS NOT NULL`.

#### `square_payments`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `square_payment_id` | text | no |  |
| `square_location_id` | text | yes |  |
| `status` | text | no |  |
| `source_type` | text | yes |  |
| `square_product` | text | yes |  |
| `application_id` | text | yes |  |
| `square_order_id` | text | yes |  |
| `reference_id` | text | yes |  |
| `note` | text | yes |  |
| `receipt_number` | text | yes |  |
| `receipt_url` | text | yes |  |
| `amount_cents` | integer | no |  |
| `tip_cents` | integer | no | `0` |
| `total_cents` | integer | no |  |
| `refunded_cents` | integer | no | `0` |
| `card_brand` | text | yes |  |
| `last4` | text | yes |  |
| `entry_method` | text | yes |  |
| `square_customer_id` | text | yes |  |
| `buyer_email` | text | yes |  |
| `square_created_at` | timestamp with time zone | no |  |
| `square_updated_at` | timestamp with time zone | yes |  |
| `classification` | text | yes |  |
| `match_state` | text | no | `'pending'::text` |
| `match_after` | timestamp with time zone | yes |  |
| `invoice_id` | uuid | yes |  |
| `event_id` | uuid | yes |  |
| `tip_event_id` | uuid | yes |  |
| `rule` | text | yes |  |
| `confidence` | numeric(3,2) | yes |  |
| `candidates` | jsonb | no | `'[]'::jsonb` |
| `variance` | jsonb | yes |  |
| `decided_by` | text | yes |  |
| `decided_by_user_id` | uuid | yes |  |
| `decided_at` | timestamp with time zone | yes |  |
| `ignore_reason` | text | yes |  |
| `ignore_note` | text | yes |  |
| `first_seen_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(square_payment_id)`. `(decided_by_user_id)` references `users(id)` on delete set null. `(event_id)` references `ledger_events(id)`. `(invoice_id)` references `invoices(id)`. `(location_id)` references `locations(id)` on delete cascade. `(tip_event_id)` references `ledger_events(id)`. 10 check constraints. Index `square_payments_invoice_idx` `(invoice_id)` where `invoice_id IS NOT NULL`. Index `square_payments_open_idx` `(location_id, square_created_at)` where `match_state = ANY (ARRAY['pending'::text, 'unmatched'::text])`. Index `square_payments_order_idx` `(square_order_id)` where `square_order_id IS NOT NULL`.

#### `square_pos_intents`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `invoice_id` | uuid | no |  |
| `ledger_event_id` | uuid | yes |  |
| `amount_cents` | integer | no |  |
| `callback_state` | text | no |  |
| `code` | text | no |  |
| `note` | text | no |  |
| `status` | text | no | `'open'::text` |
| `transaction_id` | text | yes |  |
| `client_transaction_id` | text | yes |  |
| `error_code` | text | yes |  |
| `square_payment_id` | text | yes |  |
| `created_by` | uuid | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `expires_at` | timestamp with time zone | no |  |
| `callback_at` | timestamp with time zone | yes |  |

Primary key `(id)`. Unique `(callback_state)`. Unique `(code)`. `(created_by)` references `users(id)` on delete set null. `(invoice_id)` references `invoices(id)`. `(ledger_event_id)` references `ledger_events(id)`. `(location_id)` references `locations(id)` on delete cascade. 3 check constraints. Index `square_pos_intents_open_idx` `(location_id, created_at)` where `status = ANY (ARRAY['open'::text, 'callback_ok'::text])`.

#### `square_refund_legs`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `ledger_event_id` | uuid | no |  |
| `square_payment_id` | text | no |  |
| `amount_cents` | integer | no |  |
| `origin` | text | no | `'api'::text` |
| `idempotency_key` | text | yes |  |
| `square_refund_id` | text | yes |  |
| `state` | text | no | `'to_submit'::text` |
| `error` | text | yes |  |
| `attempts` | integer | no | `0` |
| `submitted_at` | timestamp with time zone | yes |  |
| `completed_at` | timestamp with time zone | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(idempotency_key)`. Unique `(square_refund_id)`. `(ledger_event_id)` references `ledger_events(id)`. `(location_id)` references `locations(id)` on delete cascade. 5 check constraints. Index `square_refund_legs_event_idx` `(ledger_event_id)`. Index `square_refund_legs_open_idx` `(location_id, created_at)` where `state = ANY (ARRAY['to_submit'::text, 'pending'::text])`. Index `square_refund_legs_payment_idx` `(square_payment_id)`.

#### `square_refunds_waiting`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `square_refund_id` | text | no |  |
| `location_id` | uuid | no |  |
| `square_payment_id` | text | no |  |
| `facts` | jsonb | no |  |
| `received_at` | timestamp with time zone | no | `app_now()` |

Primary key `(square_refund_id)`. `(location_id)` references `locations(id)` on delete cascade. Index `square_refunds_waiting_payment_idx` `(square_payment_id)`.

#### `square_state`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `location_id` | uuid | no |  |
| `environment` | text | no |  |
| `square_location_id` | text | yes |  |
| `merchant_id` | text | yes |  |
| `events_enabled_at` | timestamp with time zone | yes |  |
| `webhook_subscription_id` | text | yes |  |
| `webhook_checked_at` | timestamp with time zone | yes |  |
| `last_webhook_at` | timestamp with time zone | yes |  |
| `watermark` | timestamp with time zone | yes |  |
| `last_catchup_at` | timestamp with time zone | yes |  |
| `last_catchup_events` | integer | no | `0` |
| `last_catchup_claimed_at` | timestamp with time zone | yes |  |
| `last_reconcile_at` | timestamp with time zone | yes |  |
| `last_reconcile` | jsonb | yes |  |
| `last_test_at` | timestamp with time zone | yes |  |
| `last_test` | jsonb | yes |  |
| `last_error` | text | yes |  |
| `last_error_at` | timestamp with time zone | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |
| `connected_at` | timestamp with time zone | yes |  |

Primary key `(location_id)`. `(location_id)` references `locations(id)` on delete cascade. 2 check constraints.

#### `square_subscription_invoices`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | uuid | no |  |
| `location_id` | uuid | no |  |
| `membership_id` | uuid | no |  |
| `square_invoice_id` | text | no |  |
| `square_subscription_id` | text | no |  |
| `square_order_id` | text | yes |  |
| `status` | text | no |  |
| `amount_cents` | integer | no |  |
| `paid_cents` | integer | no | `0` |
| `due_date` | date | yes |  |
| `period_start` | timestamp with time zone | yes |  |
| `period_end` | timestamp with time zone | yes |  |
| `public_url` | text | yes |  |
| `paid_at` | timestamp with time zone | yes |  |
| `applied_at` | timestamp with time zone | yes |  |
| `failed_at` | timestamp with time zone | yes |  |
| `canceled_at` | timestamp with time zone | yes |  |
| `square_payment_id` | text | yes |  |
| `refunded_cents` | integer | no | `0` |
| `square_refund_id` | text | yes |  |
| `refunded_at` | timestamp with time zone | yes |  |
| `refund_status` | text | yes |  |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(id)`. Unique `(square_invoice_id)`. `(location_id)` references `locations(id)` on delete cascade. `(membership_id)` references `memberships(id)`. 13 check constraints. Index `square_subscription_invoices_membership_idx` `(membership_id, created_at)`. Index `square_subscription_invoices_order_idx` `(square_order_id)` where `square_order_id IS NOT NULL`.

#### `staff_events`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `id` | bigint | no |  |
| `location_id` | uuid | no |  |
| `at` | timestamp with time zone | no | `app_now()` |
| `employee_id` | uuid | yes |  |
| `employee_name` | text | no |  |
| `kind` | text | no |  |
| `appointment_id` | uuid | yes |  |
| `customer_id` | uuid | yes |  |
| `amount_cents` | integer | yes |  |
| `ledger_event_id` | uuid | yes |  |
| `message_id` | uuid | yes |  |
| `via` | text | no |  |
| `kiosk_device_id` | uuid | yes |  |
| `user_id` | uuid | yes |  |
| `request_id` | text | yes |  |
| `meta` | jsonb | no | `'{}'::jsonb` |
| `audit_id` | bigint | yes |  |

Primary key `(id)`. `(appointment_id)` references `appointments(id)` on delete set null. `(customer_id)` references `customers(id)` on delete set null. `(employee_id)` references `employees(id)` on delete set null. `(kiosk_device_id)` references `kiosk_devices(id)` on delete set null. `(ledger_event_id)` references `ledger_events(id)`. `(location_id)` references `locations(id)` on delete cascade. `(message_id)` references `messages(id)` on delete set null. `(user_id)` references `users(id)` on delete set null. 3 check constraints. Index `staff_events_appt_idx` `(appointment_id, at)`. Unique index `staff_events_audit_uq` `(audit_id)` where `audit_id IS NOT NULL`. Index `staff_events_emp_at_idx` `(employee_id, at)`. Index `staff_events_loc_at_idx` `(location_id, at)`.

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

#### `vehicle_classes`

| Column | Type | Null | Default |
| --- | --- | --- | --- |
| `location_id` | uuid | no |  |
| `key` | text | no |  |
| `label` | text | no |  |
| `sort` | integer | no | `0` |
| `active` | boolean | no | `true` |
| `version` | integer | no | `1` |
| `created_at` | timestamp with time zone | no | `app_now()` |
| `updated_at` | timestamp with time zone | no | `app_now()` |

Primary key `(location_id, key)`. `(location_id)` references `locations(id)` on delete cascade. 2 check constraints.

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
| `vehicle_type` | text | yes |  |
| `vehicle_class` | text | yes |  |
| `vehicle_class_source` | text | yes |  |

Primary key `(id)`. `(customer_id)` references `customers(id)`. 6 check constraints. Unique index `uq_vehicles_customer_plate` `(customer_id, upper(plate))`. Index `vehicles_customer_idx` `(customer_id)`. Index `vehicles_plate_idx` `(upper(plate))` where `plate IS NOT NULL`.

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
| `attempts` | integer | no | `0` |

Primary key `(id)`. Unique `(provider, external_id)`. 3 check constraints. Index `webhook_log_received_idx` `(received_at)`. Index `webhook_log_square_open_idx` `(received_at)` where `(provider = 'square'::text) AND (status = ANY (ARRAY['received'::text, 'failed'::text]))`.

#### Views and functions

- view `invoice_calc`
- function `app_now() returns timestamp with time zone`
- function `audit_log_immutable() returns trigger`
- function `card_consents_guard() returns trigger`
- function `catalog_default_category(p_kind text, p_tags text[]) returns text`
- function `credit_allocations_guard() returns trigger`
- function `customers_email_unverify() returns trigger`
- function `ensure_location(p_id uuid, p_slug text, p_name text, p_timezone text DEFAULT 'America/New_York'::text) returns uuid`
- function `invoice_calc_of(p_invoice uuid) returns TABLE(invoice_id uuid, items bigint, adj bigint, sub bigint, tax bigint, tip bigint, total bigint, paid_orig bigint, credit_applied bigint, paid bigint, refunded bigint, ref_orig bigint, pending_amt bigint, pending_n bigint, issued bigint, balance bigint, refundable bigint, to_orig_max bigint, net bigint, overpaid bigint, status text)`
- function `ledger_events_guard() returns trigger`
- function `membership_tier_prices_guard() returns trigger`
- function `memberships_default_plan_class() returns trigger`
- function `realtime_channel_name() returns text`
- function `realtime_events_notify() returns trigger`
- function `realtime_purge(p_before timestamp with time zone) returns bigint`
- function `services_default_category() returns trigger`
<!-- schema-reference:end -->
