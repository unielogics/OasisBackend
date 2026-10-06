# Data model: domain core (migration `20261006150000_domain_core.sql`)

The domain core is the data the Settings and Operations screens share: catalog, customers and vehicles, bays, hours and
booking rules, closures and emergencies, VIP and arrival configuration, and appointments with their job records. The
platform tables (`locations`, `settings`, `audit_log`, `realtime_events`, ...) come from `platform_core`; people, auth and
RBAC arrive in the people branch; invoices, the ledger, memberships and messages belong to the Payments, Memberships and
Messaging verticals and are **not** created here.

Conventions: UUIDv7 ids supplied by the application (`createIdGenerator(clock)`), money as integer cents, every default
reads `app_now()` (never `now()`), enums are `text` with a `check`, business dates are `date` (read as `'YYYY-MM-DD'`
strings), wall-clock times are minutes from midnight (`smallint`), `version` is the optimistic-concurrency token.
Location scoping: parents carry `location_id` and every unique key leads with it; child tables (`checklist_tasks`,
`appointment_*`, `job_checklist_items`, `activity_log`, `emergency_notifications`, `reschedule_links`) inherit the
location through their parent FK. `customers` and `vehicles` are brand-global (a second location shares them).

Kysely types are registered by module augmentation (`declare module '../../platform/schema.js'`):
`src/modules/catalog/schema.ts` (services, checklist_tasks), `src/modules/customers/schema.ts` (customers, vehicles and the
appointment tables, until a scheduling module exists), `src/modules/settings/schema.ts` (everything else).

## Tables

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

## Intentionally missing foreign keys

These columns are plain `uuid` because the referenced tables arrive in other branches. A later **links** migration (for
example `20261006170000_domain_links.sql`, after the people/auth and verticals migrations) should add each constraint
`not valid`, then `validate constraint`, so it is safe on a populated database:

| Column                                                                               | Will reference        | Source      |
| ------------------------------------------------------------------------------------ | --------------------- | ----------- |
| `appointments.assigned_employee_id`                                                  | `employees(id)`       | people      |
| `appointment_overrides.employee_id`                                                  | `employees(id)`       | people      |
| `job_checklist_items.done_by_employee_id`                                            | `employees(id)`       | people      |
| `appointments.created_by`                                                            | `users(id)`           | people/auth |
| `appointment_addons.added_by`                                                        | `users(id)`           | people/auth |
| `appointment_photos.uploaded_by`                                                     | `users(id)`           | people/auth |
| `closures.created_by`                                                                | `users(id)`           | people/auth |
| `emergency_closures.started_by`, `emergency_closures.reopened_by`                    | `users(id)`           | people/auth |
| `vip_clients.added_by`                                                               | `users(id)`           | people/auth |
| `booking_rules.updated_by`, `vip_settings.updated_by`, `arrival_settings.updated_by` | `users(id)`           | people/auth |
| `appointments.membership_id`                                                         | `memberships(id)`     | Memberships |
| `appointments.standing_series_id`                                                    | `standing_series(id)` | VIP P2      |
| `emergency_notifications.message_id`                                                 | `messages(id)`        | Messaging   |

(`emergency_closures.started_by_name` and `reopened_by_name` keep the display name so history survives an employee being
deactivated.) Platform columns such as `settings.updated_by` and `audit_log.actor_*` follow the platform's own convention.

```sql
alter table appointments
  add constraint appointments_assigned_employee_fk foreign key (assigned_employee_id) references employees(id) not valid;
alter table appointments validate constraint appointments_assigned_employee_fk;
-- ... one pair per row of the table above
```

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

## Snapshot

`db/schema.sql` is generated by `pnpm db:schema` from the migrations (a test checks it is current). Regenerate it after
merging migrations from other branches.
