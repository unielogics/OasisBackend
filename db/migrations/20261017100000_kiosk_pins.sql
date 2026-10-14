-- Kiosk unlock by per-employee PINs at the shop's network (ADR 0180 amendment, owner 2026-10-14). The shared shop code and the
-- "Make this a kiosk" registration go away:
--   - every employee may get their own 8-digit PIN, set only by a manager; any listed active or invited employee's PIN opens the
--     tablet for everyone until the lock time, recorded as "Opened by Marco R.";
--   - a PIN works only from the shop's internet connection: an address in kiosk_networks (IPv4 exact, IPv6 by its /64), added or
--     approved only by a Super Admin; tries from anywhere else are refused before any PIN work and listed (capped) for approval;
--   - a browser gets its device cookie at its first successful unlock (kiosk_devices, "Shop browser N");
--   - kiosk mode is on by default (the keypad is the sign-in page).

-- 1. The shop code goes away -------------------------------------------------------------------------------------------------------

-- Every kiosk session was opened with the shop code; they all end (production has none: no code was ever set). The sessions now
-- record who opened them instead of the code.
delete from kiosk_sessions;
alter table kiosk_sessions drop column code_id;
drop table kiosk_codes;
alter table kiosk_sessions
  add column opened_by_employee_id uuid references employees(id) on delete set null,
  add column opened_by_name text not null check (btrim(opened_by_name) <> '');
alter table kiosk_sessions drop constraint kiosk_sessions_revoked_reason_check;
alter table kiosk_sessions add constraint kiosk_sessions_revoked_reason_check check (revoked_reason in
  ('lock', 'lock_device', 'lock_all', 'device_revoked', 'kiosk_off', 'unlock_again'));

-- 2. Per-employee PINs ---------------------------------------------------------------------------------------------------------------

-- One PIN per employee. pin_lookup = hex HMAC-SHA256(kiosk PIN key, "<location id>:<pin>"), the key derived from SESSION_SECRET (no
-- new secret): deterministic, so a PIN is found by its lookup and is unique within the shop, and a database copy alone cannot be
-- brute-forced over the 10^8 space. The PIN itself is never stored or logged.
create table employee_kiosk_pins (
  employee_id uuid primary key references employees(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  pin_lookup text not null check (pin_lookup ~ '^[0-9a-f]{64}$'),
  set_at timestamptz not null default app_now(),
  set_by uuid references users(id) on delete set null,
  set_by_name text,
  constraint employee_kiosk_pins_lookup_uq unique (location_id, pin_lookup)
);

-- The employee's previous PINs (their lookups), newest first: a new PIN may not be one of their last 3 (the current one and the two
-- before it). Only the newest few are kept.
create table employee_kiosk_pin_history (
  id bigint generated always as identity primary key,
  employee_id uuid not null references employees(id) on delete cascade,
  pin_lookup text not null check (pin_lookup ~ '^[0-9a-f]{64}$'),
  set_at timestamptz not null,
  retired_at timestamptz not null default app_now()
);
create index employee_kiosk_pin_history_emp_idx on employee_kiosk_pin_history (employee_id, id desc);

-- Deactivating an employee removes their PIN (whichever path deactivates them); it joins their history.
create function employee_kiosk_pin_drop() returns trigger
language plpgsql
as $$
begin
  with gone as (delete from employee_kiosk_pins where employee_id = new.id returning employee_id, pin_lookup, set_at)
  insert into employee_kiosk_pin_history (employee_id, pin_lookup, set_at) select employee_id, pin_lookup, set_at from gone;
  return null;
end
$$;

create trigger employees_kiosk_pin_drop
  after update of status on employees
  for each row when (new.status = 'inactive' and old.status is distinct from 'inactive')
  execute function employee_kiosk_pin_drop();

-- 3. The shop's networks -------------------------------------------------------------------------------------------------------------

-- The addresses PINs work from: an IPv4 address as a /32, an IPv6 address as its /64 prefix. Added or approved by a Super Admin only.
-- failed_attempts / last_failed_at / locked_out_at are the persisted per-address unlock throttle (shared by every browser at the
-- shop): a few free wrong PINs, then a doubling wait, then a lockout a manager clears.
create table kiosk_networks (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  cidr cidr not null check ((family(cidr) = 4 and masklen(cidr) = 32) or (family(cidr) = 6 and masklen(cidr) = 64)),
  label text check (label is null or (btrim(label) <> '' and length(label) <= 60)),
  added_by uuid references users(id) on delete set null,
  added_by_name text,
  added_at timestamptz not null default app_now(),
  last_seen_at timestamptz,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  last_failed_at timestamptz,
  locked_out_at timestamptz,
  constraint kiosk_networks_cidr_uq unique (location_id, cidr)
);

-- PINs tried from an address that is not a shop network ("PIN tried from an unknown network"), one row per address (/32 or /64),
-- for the Super Admin to approve. known_device_id: a try carried the device cookie of a browser that unlocked at the shop before (the
-- internet provider probably changed the shop's address). Capped and pruned by the service (30 days, 50 rows; rows of unknown browsers
-- go first), and written at most once a minute per address.
create table kiosk_refused_networks (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  cidr cidr not null check ((family(cidr) = 4 and masklen(cidr) = 32) or (family(cidr) = 6 and masklen(cidr) = 64)),
  first_seen_at timestamptz not null default app_now(),
  last_seen_at timestamptz not null default app_now(),
  attempts integer not null default 1 check (attempts >= 1),
  known_device_id uuid references kiosk_devices(id) on delete set null,
  known_device_name text,
  constraint kiosk_refused_networks_cidr_uq unique (location_id, cidr)
);
create index kiosk_refused_networks_seen_idx on kiosk_refused_networks (location_id, last_seen_at desc);

-- 4. Who opened the tablet is a staff event --------------------------------------------------------------------------------------------

alter table staff_events drop constraint staff_events_kind_check;
alter table staff_events add constraint staff_events_kind_check check (kind in ('confirm', 'arrive', 'assign_bay', 'start',
  'complete', 'notify_ready', 'pickup', 'pickup_reopen', 'prep_bay', 'reschedule', 'update', 'book', 'walk_in', 'customer_create',
  'addon_add', 'addon_remove', 'size_change', 'checklist', 'photo', 'payment', 'tip', 'receipt', 'payment_link', 'text',
  'arrival_link', 'worker_set', 'kiosk_unlock'));

-- 5. Kiosk mode on by default ----------------------------------------------------------------------------------------------------------

-- The setting's default is now true. The row the server wrote at boot with the old default (false, version 1, nobody's change, never
-- audited) follows the new default; a value somebody set stays as it is.
update settings set value = 'true'::jsonb
where key = 'kiosk.enabled'
  and value = 'false'::jsonb
  and version = 1
  and updated_by is null
  and not exists (
    select 1 from audit_log a
    where a.location_id = settings.location_id and a.entity_type = 'setting' and a.entity_id = 'kiosk.enabled');
