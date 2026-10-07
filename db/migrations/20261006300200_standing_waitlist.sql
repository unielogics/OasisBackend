-- Standing (recurring) appointments and the waitlist (backend design 3.5 and 4.9, P2). Both ship behind the feature setting
-- features.standing_waitlist (default off) and the VIP toggles of vip_settings; there is no UI yet. appointments.standing_series_id
-- stays a plain uuid (the domain tables must not reference later verticals, test/domain-schema/migration.test.ts).

create table standing_series (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  customer_id uuid not null references customers(id),
  vehicle_id uuid references vehicles(id),
  service_id uuid not null references services(id),
  cadence text not null check (cadence in ('weekly', 'biweekly', 'triweekly', 'monthly')),
  -- 0 = Sunday ... 6 = Saturday; always the weekday of start_date
  weekday smallint not null check (weekday between 0 and 6),
  -- wall-clock start in the business timezone, minutes from midnight
  time_min smallint not null check (time_min between 0 and 1439),
  start_date date not null,
  end_date date,
  status text not null default 'active' check (status in ('active', 'paused', 'ended')),
  -- the last business date the materializer looked at; the next run starts the day after
  generated_through date,
  auto_confirm boolean not null default true,
  notes text,
  created_by uuid references users(id) on delete set null,
  version integer not null default 1,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  check (end_date is null or end_date >= start_date)
);
create index standing_series_live_idx on standing_series (location_id, customer_id) where status <> 'ended';

-- One row per date the materializer decided: an appointment was booked, or the date was skipped with the reason (closed day, full).
create table standing_occurrences (
  id uuid primary key,
  series_id uuid not null references standing_series(id) on delete cascade,
  occurrence_date date not null,
  status text not null check (status in ('booked', 'skipped')),
  appointment_id uuid references appointments(id),
  reason text,
  created_at timestamptz not null default app_now(),
  unique (series_id, occurrence_date),
  check ((status = 'booked') = (appointment_id is not null))
);
create index standing_occurrences_appointment_idx on standing_occurrences (appointment_id) where appointment_id is not null;

create table waitlist_entries (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  customer_id uuid not null references customers(id),
  vehicle_id uuid references vehicles(id),
  service_id uuid not null references services(id),
  desired_date date not null,
  -- a slot is a match when its start time (minutes from midnight, business tz) falls in [window_start_min, window_end_min]
  window_start_min smallint not null check (window_start_min between 0 and 1439),
  window_end_min smallint not null check (window_end_min between 1 and 1440),
  -- the customer's VIP standing when they joined; VIP entries get the first claim on a freed slot
  is_vip boolean not null default false,
  status text not null default 'waiting' check (status in ('waiting', 'offered', 'booked', 'expired', 'canceled')),
  appointment_id uuid references appointments(id),
  notes text,
  created_by uuid references users(id) on delete set null,
  version integer not null default 1,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  check (window_start_min < window_end_min),
  check ((status = 'booked') = (appointment_id is not null))
);
create index waitlist_entries_match_idx on waitlist_entries (location_id, desired_date) where status in ('waiting', 'offered');

-- A freed slot offered to an entry. phase vip = the VIP claim window, everyone = after it. One open offer per entry and slot.
create table waitlist_offers (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  entry_id uuid not null references waitlist_entries(id) on delete cascade,
  slot_start timestamptz not null,
  slot_end timestamptz not null,
  phase text not null check (phase in ('vip', 'everyone')),
  status text not null default 'open' check (status in ('open', 'accepted', 'expired', 'canceled')),
  offered_at timestamptz not null default app_now(),
  expires_at timestamptz not null,
  resolved_at timestamptz,
  -- messages.id of the SMS that carried the offer (plain uuid, like the other message references)
  message_id uuid,
  unique (entry_id, slot_start),
  check (slot_end > slot_start),
  check ((status = 'open') = (resolved_at is null))
);
create index waitlist_offers_open_idx on waitlist_offers (expires_at) where status = 'open';
create index waitlist_offers_slot_idx on waitlist_offers (location_id, slot_start);
