-- Kiosk mode (ADR 0180, wave K1a): the shop's shared tablet stays open all day without an email login. An admin registers the
-- tablet once ("Make this a kiosk": a device row and a long-lived HttpOnly device cookie, only its sha256 is stored); an 8-digit
-- shop code unlocks it into a kiosk session that lasts until closing + 2 hours (kioskLockTime). Off until Settings turns
-- `kiosk.enabled` on; nothing here changes behaviour while it is off.

-- Registered kiosk devices ------------------------------------------------------------------------------------------------------

-- One row per registered tablet. failed_attempts / last_failed_at / locked_out_at are the persisted per-device unlock throttle
-- (3 free tries, then a doubling delay up to 5 minutes; 20 consecutive failures lock the device out until a manager clears it).
create table kiosk_devices (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  name text not null check (btrim(name) <> '' and length(name) <= 40),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default app_now(),
  created_by uuid references users(id) on delete set null,
  created_by_name text,
  last_seen_at timestamptz,
  last_ip inet,
  last_ua text,
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  last_failed_at timestamptz,
  locked_out_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references users(id) on delete set null,
  version integer not null default 1
);
create index kiosk_devices_live_idx on kiosk_devices (location_id) where revoked_at is null;

-- The shop's unlock codes: every code ever set (the last 3 cannot be reused); the current one has retired_at null. code_hash is
-- the PHC scrypt string over HMAC-SHA256(kiosk key, "<location id>:<code>"), the kiosk key derived from SESSION_SECRET.
create table kiosk_codes (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  code_hash text not null check (code_hash like '$scrypt$%'),
  created_at timestamptz not null default app_now(),
  created_by uuid references users(id) on delete set null,
  created_by_name text,
  retired_at timestamptz
);
create unique index kiosk_codes_current_uq on kiosk_codes (location_id) where retired_at is null;
create index kiosk_codes_history_idx on kiosk_codes (location_id, created_at desc);

-- Kiosk sessions: the id is the sha256 of the session cookie token (like sessions). Absolute expiry only (the lock time), no idle
-- expiry. lock_rule says which rule of kioskLockTime set expires_at.
create table kiosk_sessions (
  id text primary key check (id ~ '^[0-9a-f]{64}$'),
  device_id uuid not null references kiosk_devices(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  code_id uuid not null references kiosk_codes(id) on delete cascade,
  created_at timestamptz not null default app_now(),
  expires_at timestamptz not null,
  lock_rule text not null check (lock_rule in ('closing', 'previous_day', 'two_hours')),
  csrf_secret text not null,
  ip inet,
  ua text,
  last_seen_at timestamptz not null default app_now(),
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason in
    ('lock', 'lock_device', 'lock_all', 'code_changed', 'device_revoked', 'kiosk_off', 'unlock_again')),
  check (expires_at > created_at),
  check ((revoked_at is null) = (revoked_reason is null))
);
create index kiosk_sessions_live_idx on kiosk_sessions (device_id) where revoked_at is null;
create index kiosk_sessions_location_live_idx on kiosk_sessions (location_id) where revoked_at is null;

-- "Shows on the kiosk": who the employee picker lists (active or invited employees of the location; on by default).
alter table employees add column kiosk_listed boolean not null default true;

-- An admin who signed in with email and password on a kiosk device: short timings (15 min idle, 4 h absolute) and a banner.
alter table sessions add column kiosk_device_id uuid references kiosk_devices(id) on delete set null;

-- The kiosk device behind an audited action (no foreign key, like the other audit actor columns: the audit log outlives devices).
alter table audit_log add column kiosk_device_id uuid;
