-- People, roles/permissions (RBAC), users, sessions, invites and password resets.
-- Roles, permissions and employees are brand-global (employee_locations links people to a location); no table here has a
-- foreign key to a table owned by another migration except locations.

-- One counter bumped (in the same transaction) by every change that can alter someone's effective permissions;
-- per-process caches compare it on each request.
create table rbac_state (
  id boolean primary key default true check (id),
  version bigint not null default 1
);
insert into rbac_state (id, version) values (true, 1);

create table employees (
  id uuid primary key,
  first text not null check (btrim(first) <> ''),
  last text not null default '',
  title text not null default '',
  phone text not null default '',
  phone_e164 text,
  email citext unique,
  status text not null default 'invited' check (status in ('active', 'invited', 'inactive')),
  employment_type text not null default 'full_time' check (employment_type in ('full_time', 'part_time', 'contractor')),
  pay_type text not null default 'hourly' check (pay_type in ('hourly', 'commission', 'salary')),
  rate_text text not null default '',
  skills text[] not null default '{}'
    check (skills <@ array['Interior detailing', 'Paint correction', 'Ceramic coating', 'Exotic vehicles', 'Front desk', 'Mobile service']::text[]),
  avatar_color text,
  version integer not null default 1,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  deactivated_at timestamptz,
  check ((status = 'inactive') = (deactivated_at is not null))
);
create index employees_status_idx on employees (status);
create index employees_phone_e164_idx on employees (phone_e164) where phone_e164 is not null;

create table employee_locations (
  employee_id uuid not null references employees(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  primary key (employee_id, location_id)
);
create index employee_locations_location_idx on employee_locations (location_id);

-- weekday 0 = Sunday ... 6 = Saturday; times are minutes from midnight in the business timezone.
create table employee_schedules (
  employee_id uuid not null references employees(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  is_on boolean not null default false,
  from_min smallint not null check (from_min between 0 and 1439),
  to_min smallint not null check (to_min between 1 and 1440),
  primary key (employee_id, weekday),
  check (not is_on or from_min < to_min)
);

create table roles (
  id uuid primary key,
  key text unique check (key in ('super', 'mgmt', 'acct', 'support', 'crew')),
  name text not null check (btrim(name) <> ''),
  description text not null default '',
  is_locked boolean not null default false,
  is_custom boolean not null default false,
  version integer not null default 1,
  created_at timestamptz not null default app_now(),
  check (not (is_locked and is_custom)),
  check (key is null or not is_custom)
);
create unique index roles_name_lower_idx on roles (lower(name));
-- at most one locked (Super Admin) role
create unique index roles_one_locked_idx on roles (is_locked) where is_locked;

create table permissions (
  key text primary key,
  module text not null,
  label text not null,
  has_limit boolean not null default false,
  sort smallint not null unique
);

insert into permissions (key, module, label, has_limit, sort) values
  ('sched.view', 'Schedule & jobs', 'View schedule & calendar', false, 1),
  ('sched.edit', 'Schedule & jobs', 'Create & edit appointments', false, 2),
  ('sched.cancel', 'Schedule & jobs', 'Cancel & mark no-shows', false, 3),
  ('sched.override', 'Schedule & jobs', 'Override bay capacity', false, 4),
  ('jobs.status', 'Schedule & jobs', 'Move jobs between stages', false, 5),
  ('jobs.checklist', 'Schedule & jobs', 'Complete checklists & photos', false, 6),
  ('cli.view', 'Clients', 'View client files', false, 7),
  ('cli.contact', 'Clients', 'See phone & email', false, 8),
  ('cli.edit', 'Clients', 'Edit client & vehicle details', false, 9),
  ('cli.export', 'Clients', 'Export client data', false, 10),
  ('cli.member', 'Clients', 'Manage memberships & VIP', false, 11),
  ('pay.collect', 'Payments', 'Collect payments', false, 12),
  ('pay.refund', 'Payments', 'Issue refunds', true, 13),
  ('pay.adjust', 'Payments', 'Apply adjustments & discounts', true, 14),
  ('pay.credit', 'Payments', 'Issue account credits', true, 15),
  ('pay.void', 'Payments', 'Void transactions', false, 16),
  ('pay.reports', 'Payments', 'View payment reports', false, 17),
  ('msg.send', 'Messaging', 'Message customers', false, 18),
  ('msg.auto', 'Messaging', 'Edit automations & templates', false, 19),
  ('msg.broadcast', 'Messaging', 'Send offers & broadcasts', false, 20),
  ('team.view', 'Team', 'View team', false, 21),
  ('team.edit', 'Team', 'Add & edit employees', false, 22),
  ('team.roles', 'Team', 'Assign roles & permissions', false, 23),
  ('set.hours', 'Settings', 'Working hours & holidays', false, 24),
  ('set.emergency', 'Settings', 'Emergency closing', false, 25),
  ('set.services', 'Settings', 'Services, pricing & checklists', false, 26),
  ('set.billing', 'Settings', 'Billing & integrations', false, 27);

create table role_permissions (
  role_id uuid not null references roles(id) on delete cascade,
  permission_key text not null references permissions(key),
  primary key (role_id, permission_key)
);
create index role_permissions_key_idx on role_permissions (permission_key);

-- One row per (role, kind). unlimited = true means "No limit"; NO ROW means the default of 2500 cents ($25).
create table role_limits (
  role_id uuid not null references roles(id) on delete cascade,
  kind text not null check (kind in ('refund', 'adjust', 'credit')),
  unlimited boolean not null default false,
  limit_cents bigint,
  primary key (role_id, kind),
  check ((unlimited and limit_cents is null) or (not unlimited and limit_cents is not null and limit_cents >= 0))
);

create table employee_roles (
  employee_id uuid not null references employees(id) on delete cascade,
  role_id uuid not null references roles(id) on delete cascade,
  primary key (employee_id, role_id)
);
create index employee_roles_role_idx on employee_roles (role_id);

create table employee_permission_overrides (
  employee_id uuid not null references employees(id) on delete cascade,
  permission_key text not null references permissions(key),
  effect text not null check (effect in ('allow', 'deny')),
  primary key (employee_id, permission_key)
);

-- A user is the login of an employee; the row appears when an invite is accepted (or by bootstrap / the CLI).
create table users (
  id uuid primary key,
  employee_id uuid not null unique references employees(id) on delete cascade,
  email citext not null unique,
  password_hash text not null,
  failed_attempts integer not null default 0,
  last_login_at timestamptz,
  password_changed_at timestamptz not null default app_now(),
  disabled_at timestamptz,
  created_at timestamptz not null default app_now()
);

create table invites (
  id uuid primary key,
  employee_id uuid not null references employees(id) on delete cascade,
  token_hash text not null unique,
  channel text not null default 'sms' check (channel in ('sms', 'email', 'link')),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default app_now()
);
create index invites_employee_idx on invites (employee_id);

-- id is the hex sha256 of the opaque cookie token: a database leak does not yield usable sessions.
create table sessions (
  id text primary key check (id ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default app_now(),
  last_seen_at timestamptz not null default app_now(),
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  ip inet,
  ua text,
  csrf_secret text not null,
  view_as_role_id uuid references roles(id) on delete set null,
  revoked_at timestamptz,
  check (idle_expires_at <= absolute_expires_at)
);
create index sessions_user_idx on sessions (user_id) where revoked_at is null;
create index sessions_absolute_idx on sessions (absolute_expires_at);

create table password_resets (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  requested_by uuid,
  created_at timestamptz not null default app_now()
);
create index password_resets_user_idx on password_resets (user_id, created_at desc);

create table user_preferences (
  user_id uuid primary key references users(id) on delete cascade,
  theme text check (theme in ('light', 'dark')),
  updated_at timestamptz not null default app_now()
);
