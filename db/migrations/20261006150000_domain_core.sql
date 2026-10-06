-- Domain core: catalog, customers, bays, hours/rules, closures, emergency, VIP/arrival config, appointments and jobs.
-- Location-scoped parents carry location_id (children inherit it through their parent FK); customers and vehicles are
-- brand-global. Columns that will point at employees, users, roles, memberships, messages or standing series are plain
-- uuid with NO foreign key here (those tables arrive in other branches); docs/data-model.md lists each one for the
-- later "links" migration. Money is integer cents; all defaults read app_now(), never now().

-- Catalog ---------------------------------------------------------------------------------------------------------

create table services (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  kind text not null check (kind in ('package', 'addon')),
  name text not null check (btrim(name) <> ''),
  short_name text check (short_name is null or btrim(short_name) <> ''),
  price_cents integer not null check (price_cents >= 0),
  duration_min integer not null,
  tags text[] not null default '{}',
  bookable_desk boolean not null default true,
  sort integer not null default 0,
  active boolean not null default true,
  sqsp_sku text,
  version integer not null default 1,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  check ((kind = 'addon' and duration_min = 0) or (kind = 'package' and duration_min between 1 and 720))
);
create unique index uq_services_name on services (location_id, kind, lower(name));
create index services_listing_idx on services (location_id, kind, sort, id);

-- Stable ids: renaming updates label in place, removing sets retired_at, nothing is ever deleted.
create table checklist_tasks (
  id uuid primary key,
  service_id uuid not null references services(id) on delete cascade,
  label text not null check (btrim(label) <> ''),
  position integer not null check (position >= 0),
  retired_at timestamptz,
  created_at timestamptz not null default app_now()
);
create index checklist_tasks_service_idx on checklist_tasks (service_id, position) where retired_at is null;

-- Customers and vehicles ------------------------------------------------------------------------------------------

create table customers (
  id uuid primary key,
  full_name text not null check (btrim(full_name) <> ''),
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  phone_display text,
  email citext check (email is null or btrim(email::text) <> ''),
  notes text,
  sms_opted_in boolean not null default false,
  sms_opt_in_source text check (
    sms_opt_in_source is null
    or sms_opt_in_source in ('dashboard', 'walk_in', 'online', 'squarespace', 'inbound_sms', 'import', 'keyword')
  ),
  sms_opt_in_at timestamptz,
  sms_opted_out_at timestamptz,
  email_bounced_at timestamptz,
  source text not null default 'dashboard'
    check (source in ('dashboard', 'walk_in', 'online', 'squarespace', 'inbound_sms', 'import')),
  -- Seeded or test people: their numbers must sit in the reserved 555-01xx range so nothing can text a stranger.
  synthetic boolean not null default false,
  needs_details boolean not null default false,
  merged_into uuid references customers(id),
  deleted_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  check (not synthetic or phone_e164 is null or phone_e164 ~ '^\+1[0-9]{3}55501[0-9]{2}$'),
  check (merged_into is null or merged_into <> id)
);
create unique index uq_customers_phone on customers (phone_e164)
  where phone_e164 is not null and merged_into is null and deleted_at is null;
create index customers_full_name_trgm on customers using gin (full_name gin_trgm_ops);
create index customers_phone_trgm on customers using gin (phone_e164 gin_trgm_ops);
create index customers_email_trgm on customers using gin ((email::text) gin_trgm_ops);
create index customers_merged_into_idx on customers (merged_into) where merged_into is not null;

create table vehicles (
  id uuid primary key,
  customer_id uuid not null references customers(id),
  year smallint check (year is null or year between 1900 and 2100),
  make text,
  model text,
  color text,
  plate text check (plate is null or btrim(plate) <> ''),
  deleted_at timestamptz,
  created_at timestamptz not null default app_now()
);
create unique index uq_vehicles_customer_plate on vehicles (customer_id, upper(plate));
create index vehicles_plate_idx on vehicles (upper(plate)) where plate is not null;
create index vehicles_customer_idx on vehicles (customer_id);

-- Bays, hours, rules ----------------------------------------------------------------------------------------------

create table bays (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  number smallint not null check (number > 0),
  name text not null check (btrim(name) <> ''),
  status text not null default 'active' check (status in ('active', 'maintenance', 'blocked')),
  sort integer not null default 0,
  created_at timestamptz not null default app_now(),
  unique (location_id, number)
);

create table business_hours (
  location_id uuid not null references locations(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  is_open boolean not null,
  open_min smallint not null,
  close_min smallint not null,
  primary key (location_id, weekday),
  check (open_min < close_min),
  check (open_min >= 300 and close_min <= 1410),
  check (open_min % 30 = 0 and close_min % 30 = 0)
);

-- version is shared by the hours and the rules: one optimistic-concurrency token for the Working hours screen.
create table booking_rules (
  location_id uuid primary key references locations(id) on delete cascade,
  slot_minutes smallint not null default 30 check (slot_minutes in (15, 30, 60)),
  buffer_minutes smallint not null default 10 check (buffer_minutes in (0, 10, 15, 20)),
  cutoff_minutes smallint not null default 60 check (cutoff_minutes in (30, 60, 90)),
  online_lead_minutes smallint not null default 30 check (online_lead_minutes between 0 and 240),
  allow_overrun boolean not null default true,
  auto_plan_bay boolean not null default true,
  version integer not null default 1,
  updated_by uuid,
  updated_at timestamptz not null default app_now()
);

-- Emergency closures and closures -----------------------------------------------------------------------------------

create table emergency_closures (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  active boolean not null default true,
  reason text not null
    check (reason in ('severe_weather', 'power_outage', 'equipment_failure', 'staff_shortage', 'other')),
  duration_kind text not null check (duration_kind in ('today', 'until', 'days')),
  until_min smallint check (until_min is null or until_min between 0 and 1439),
  through_date date,
  ends_at timestamptz,
  message text not null default '',
  notify boolean not null default true,
  link boolean not null default true,
  credits boolean not null default true,
  pause boolean not null default true,
  crew boolean not null default true,
  summary text not null default '',
  started_at timestamptz not null default app_now(),
  started_by uuid,
  started_by_name text,
  reopened_at timestamptz,
  reopened_by uuid,
  reopened_by_name text,
  auto_reopened boolean not null default false,
  affected_count integer not null default 0 check (affected_count >= 0),
  notified_count integer not null default 0 check (notified_count >= 0),
  rebooked_count integer not null default 0 check (rebooked_count >= 0),
  detail text,
  -- ids of planned closures this emergency soft-deleted so reopening can restore them.
  replaced_closure_ids uuid[] not null default '{}',
  created_at timestamptz not null default app_now(),
  check (duration_kind <> 'until' or until_min is not null),
  check (active or reopened_at is not null)
);
create unique index uq_emergency_one_active on emergency_closures (location_id) where active;
create index emergency_closures_history_idx on emergency_closures (location_id, started_at desc);

create table closures (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  date date not null,
  name text not null check (btrim(name) <> ''),
  type text not null check (type in ('closed', 'reduced')),
  open_min smallint,
  close_min smallint,
  notify boolean not null default true,
  source text not null default 'manual' check (source in ('manual', 'federal', 'emergency')),
  federal_key text,
  federal_year smallint,
  emergency_closure_id uuid references emergency_closures(id),
  created_by uuid,
  deleted_at timestamptz,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  check (
    (type = 'closed' and open_min is null and close_min is null)
    or (type = 'reduced' and open_min is not null and close_min is not null
        and open_min >= 0 and close_min <= 1440 and open_min < close_min)
  ),
  check ((federal_key is null) = (federal_year is null)),
  check (source = 'federal' or federal_key is null),
  check ((source = 'emergency') = (emergency_closure_id is not null))
);
-- One live closure per date; the federal key is unique even when soft-deleted so a removed holiday is not regenerated.
create unique index uq_closures_date_live on closures (location_id, date) where deleted_at is null;
alter table closures add constraint uq_closures_federal unique (location_id, federal_key, federal_year);
create index closures_emergency_idx on closures (emergency_closure_id) where emergency_closure_id is not null;

create table federal_holiday_runs (
  location_id uuid not null references locations(id) on delete cascade,
  year smallint not null,
  ran_at timestamptz not null default app_now(),
  primary key (location_id, year)
);

-- VIP and arrival configuration -------------------------------------------------------------------------------------

create table vip_settings (
  location_id uuid primary key references locations(id) on delete cascade,
  release_hours smallint not null default 48 check (release_hours in (24, 48, 72)),
  window_vip_days smallint not null default 30 check (window_vip_days between 7 and 90),
  window_std_days smallint not null default 14 check (window_std_days between 7 and 60),
  same_day_per_month smallint not null default 2 check (same_day_per_month between 0 and 8),
  waitlist boolean not null default true,
  offer_minutes smallint not null default 15 check (offer_minutes in (10, 15, 30)),
  standing boolean not null default true,
  auto_confirm boolean not null default true,
  cadences text[] not null default '{weekly,biweekly,monthly}'
    check (cadences <@ array['weekly', 'biweekly', 'triweekly', 'monthly']::text[]),
  version integer not null default 1,
  updated_by uuid,
  updated_at timestamptz not null default app_now()
);

create table vip_holds (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  time_min smallint not null check (time_min between 300 and 1410 and time_min % 30 = 0),
  created_at timestamptz not null default app_now(),
  unique (location_id, weekday, time_min)
);

create table vip_clients (
  location_id uuid not null references locations(id) on delete cascade,
  customer_id uuid not null references customers(id),
  added_by uuid,
  added_at timestamptz not null default app_now(),
  primary key (location_id, customer_id)
);
create index vip_clients_customer_idx on vip_clients (customer_id);

create table arrival_settings (
  location_id uuid primary key references locations(id) on delete cascade,
  enabled boolean not null default true,
  radius_m smallint not null default 300 check (radius_m in (150, 300, 500)),
  prep_at_min smallint not null default 15 check (prep_at_min in (10, 15, 20)),
  auto_arrive boolean not null default true,
  welcome boolean not null default true,
  alert_crew boolean not null default true,
  vip_first boolean not null default true,
  version integer not null default 1,
  updated_by uuid,
  updated_at timestamptz not null default app_now()
);

-- Appointments and jobs ---------------------------------------------------------------------------------------------

create table appointments (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  seq bigint generated always as identity unique,
  customer_id uuid not null references customers(id),
  vehicle_id uuid references vehicles(id),
  service_id uuid not null references services(id),
  package_name text not null check (btrim(package_name) <> ''),
  price_cents integer not null check (price_cents >= 0),
  duration_min integer not null check (duration_min > 0),
  status text not null default 'booked'
    check (status in ('booked', 'confirmed', 'arrived', 'cleaning', 'completed', 'canceled', 'no_show')),
  scheduled_start timestamptz not null,
  scheduled_end timestamptz not null,
  assigned_employee_id uuid,
  planned_bay_id uuid references bays(id),
  bay_id uuid references bays(id),
  source text not null default 'dashboard'
    check (source in ('dashboard', 'walk_in', 'online', 'phone', 'standing', 'reschedule_link')),
  eta_minutes integer check (eta_minutes is null or eta_minutes >= 0),
  eta_at timestamptz,
  geo_checked_in_at timestamptz,
  bay_prepped_at timestamptz,
  arrived_at timestamptz,
  cleaning_started_at timestamptz,
  completed_at timestamptz,
  pickup_state text check (pickup_state is null or pickup_state in ('pending', 'collected')),
  picked_up_at timestamptz,
  ready_notified_at timestamptz,
  canceled_at timestamptz,
  cancel_reason text,
  no_show_at timestamptz,
  notes text,
  special_instructions text,
  membership_id uuid,
  emergency_closure_id uuid references emergency_closures(id),
  standing_series_id uuid,
  arrival_token_hash text,
  version integer not null default 1,
  created_by uuid,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  check (scheduled_end > scheduled_start),
  check (status <> 'cleaning' or bay_id is not null)
);
-- The database, not the application, guarantees one cleaning job per bay.
create unique index uq_bay_occupied on appointments (bay_id) where status = 'cleaning';
create index appointments_location_start_idx on appointments (location_id, scheduled_start);
create index appointments_customer_idx on appointments (customer_id, scheduled_start desc);
create index appointments_active_idx on appointments (status)
  where status in ('booked', 'confirmed', 'arrived', 'cleaning');
create index appointments_emergency_idx on appointments (emergency_closure_id) where emergency_closure_id is not null;

create table appointment_addons (
  id uuid primary key,
  appointment_id uuid not null references appointments(id) on delete cascade,
  service_id uuid not null references services(id),
  name text not null check (btrim(name) <> ''),
  price_cents integer not null check (price_cents >= 0),
  added_by uuid,
  added_at timestamptz not null default app_now(),
  removed_at timestamptz
);
create unique index uq_appointment_addons_live on appointment_addons (appointment_id, service_id)
  where removed_at is null;
create index appointment_addons_appointment_idx on appointment_addons (appointment_id);

create table appointment_overrides (
  id uuid primary key,
  appointment_id uuid not null references appointments(id) on delete cascade,
  kind text not null check (kind in ('capacity', 'hours', 'closure', 'vip_hold', 'same_day_guarantee')),
  reason text not null check (btrim(reason) <> ''),
  employee_id uuid,
  created_at timestamptz not null default app_now()
);
create index appointment_overrides_appointment_idx on appointment_overrides (appointment_id);

-- Snapshotted at booking (and when an add-on is added); keys are task ids, never labels.
create table job_checklist_items (
  id uuid primary key,
  appointment_id uuid not null references appointments(id) on delete cascade,
  section_kind text not null check (section_kind in ('package', 'addon')),
  section_title text not null check (btrim(section_title) <> ''),
  source_task_id uuid references checklist_tasks(id) on delete set null,
  appointment_addon_id uuid references appointment_addons(id) on delete set null,
  label text not null check (btrim(label) <> ''),
  position integer not null check (position >= 0),
  done boolean not null default false,
  done_at timestamptz,
  done_by_employee_id uuid,
  removed_at timestamptz,
  created_at timestamptz not null default app_now(),
  check (done or done_at is null)
);
create index job_checklist_items_appointment_idx on job_checklist_items (appointment_id, position);
create index job_checklist_items_task_idx on job_checklist_items (source_task_id) where source_task_id is not null;

create table appointment_photos (
  id uuid primary key,
  appointment_id uuid not null references appointments(id) on delete cascade,
  category text not null check (category in ('arrival', 'before', 'after', 'issue')),
  s3_key text,
  thumb_key text,
  content_type text,
  bytes integer check (bytes is null or bytes >= 0),
  note text,
  status text not null check (status in ('pending_upload', 'ready', 'deleted')),
  taken_at timestamptz not null default app_now(),
  uploaded_by uuid,
  created_at timestamptz not null default app_now(),
  -- An issue may be a note with no file ("N notes" in the design); every other photo needs an object key.
  check (s3_key is not null or (category = 'issue' and note is not null and btrim(note) <> ''))
);
create index appointment_photos_appointment_idx on appointment_photos (appointment_id, category);

create table activity_log (
  id bigint generated always as identity primary key,
  appointment_id uuid not null references appointments(id) on delete cascade,
  at timestamptz not null default app_now(),
  text text not null check (btrim(text) <> ''),
  channels text[] not null default '{}'
    check (channels <@ array['sms', 'email', 'internal', 'automation', 'system']::text[]),
  actor_type text not null default 'staff' check (actor_type in ('staff', 'system', 'automation', 'customer')),
  actor_name text,
  meta jsonb not null default '{}'::jsonb
);
create index activity_log_appointment_idx on activity_log (appointment_id, at, id);

-- Emergency follow-up --------------------------------------------------------------------------------------------

create table reschedule_links (
  id uuid primary key,
  code text not null unique check (length(code) >= 8),
  appointment_id uuid not null references appointments(id) on delete cascade,
  emergency_closure_id uuid references emergency_closures(id),
  closure_id uuid references closures(id),
  expires_at timestamptz not null,
  used_at timestamptz,
  result_appointment_id uuid references appointments(id),
  created_at timestamptz not null default app_now()
);
create index reschedule_links_appointment_idx on reschedule_links (appointment_id);
create index reschedule_links_emergency_idx on reschedule_links (emergency_closure_id) where emergency_closure_id is not null;

create table emergency_notifications (
  id uuid primary key,
  emergency_closure_id uuid not null references emergency_closures(id) on delete cascade,
  appointment_id uuid not null references appointments(id) on delete cascade,
  customer_id uuid not null references customers(id),
  message_id uuid,
  channel text not null check (channel in ('sms', 'email', 'none')),
  state text not null
    check (state in ('queued', 'sent', 'delivered', 'failed', 'skipped_opt_out', 'no_contact')),
  reschedule_link_id uuid references reschedule_links(id),
  rebooked_at timestamptz,
  created_at timestamptz not null default app_now(),
  unique (emergency_closure_id, appointment_id)
);
create index emergency_notifications_state_idx on emergency_notifications (emergency_closure_id, state);
