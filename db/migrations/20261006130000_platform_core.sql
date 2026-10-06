-- Platform core: extensions, app_now(), locations, settings, idempotency, realtime, audit, webhook log, notifications.
-- Bare now()/current_timestamp is banned: every default reads app_now() so a frozen clock reaches the database too.

create extension if not exists citext schema public;
create extension if not exists pg_trgm schema public;
create extension if not exists btree_gist schema public;
create extension if not exists pgcrypto schema public;

-- The SQL twin of the injectable Clock: the oasis.now GUC when set (frozen or parity runs), else the wall clock.
create function app_now() returns timestamptz
language sql volatile
as $$ select coalesce(nullif(current_setting('oasis.now', true), '')::timestamptz, clock_timestamp()) $$;

create table locations (
  id uuid primary key,
  name text not null,
  slug text not null unique,
  timezone text not null default 'America/New_York',
  address text,
  lat numeric(9,6) check (lat between -90 and 90),
  lng numeric(9,6) check (lng between -180 and 180),
  created_at timestamptz not null default app_now(),
  check (btrim(name) <> '' and btrim(timezone) <> '')
);

create table settings (
  location_id uuid not null references locations(id) on delete cascade,
  key text not null,
  value jsonb not null,
  version integer not null default 1,
  updated_by uuid,
  updated_at timestamptz not null default app_now(),
  primary key (location_id, key)
);

create table idempotency_keys (
  key text not null,
  actor text not null,
  method text not null,
  route text not null,
  request_hash text not null,
  state text not null check (state in ('in_flight', 'done')),
  response_status smallint,
  response_body jsonb,
  response_headers jsonb,
  created_at timestamptz not null default app_now(),
  lock_expires_at timestamptz not null,
  expires_at timestamptz not null,
  primary key (key, actor)
);
create index idempotency_keys_expires_idx on idempotency_keys (expires_at);

-- Realtime: rows are the durable event log (Last-Event-ID replay); the trigger wakes LISTENers on commit.
create table realtime_events (
  id bigserial primary key,
  at timestamptz not null default app_now(),
  location_id uuid not null references locations(id) on delete cascade,
  channel text not null,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  target_user_id uuid
);
create index realtime_events_location_idx on realtime_events (location_id, id);
create index realtime_events_at_idx on realtime_events (at);

create table realtime_state (
  id boolean primary key default true check (id),
  purged_through bigint not null default 0
);

-- One NOTIFY channel per schema ("oasis_rt" in production, "oasis_rt_<schema>" for per-worker test schemas).
create function realtime_channel_name() returns text
language sql stable
as $$ select 'oasis_rt' || case when current_schema() = 'public' then '' else '_' || current_schema() end $$;

create function realtime_events_notify() returns trigger
language plpgsql
as $$
begin
  perform pg_notify(
    realtime_channel_name(),
    json_build_object('id', new.id, 'l', new.location_id, 'c', new.channel)::text
  );
  return null;
end
$$;

create trigger realtime_events_notify
  after insert on realtime_events
  for each row execute function realtime_events_notify();

-- Deletes events older than p_before and remembers the highest purged id so a stale Last-Event-ID can be told to resync.
create function realtime_purge(p_before timestamptz) returns bigint
language plpgsql
as $$
declare
  v_max bigint;
  v_count bigint;
begin
  with d as (delete from realtime_events where at < p_before returning id)
  select max(id), count(*) into v_max, v_count from d;
  if v_max is not null then
    insert into realtime_state (id, purged_through) values (true, v_max)
    on conflict (id) do update set purged_through = greatest(realtime_state.purged_through, excluded.purged_through);
  end if;
  return v_count;
end
$$;

create table audit_log (
  id bigserial primary key,
  at timestamptz not null default app_now(),
  location_id uuid not null references locations(id),
  actor_user_id uuid,
  actor_employee_id uuid,
  actor_name text,
  actor_roles text,
  view_as_role_id uuid,
  action text not null,
  entity_type text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  request_id text,
  idempotency_key text,
  ip inet
);
create index audit_log_location_at_idx on audit_log (location_id, at desc);
create index audit_log_entity_idx on audit_log (entity_type, entity_id, id desc);
create index audit_log_actor_idx on audit_log (actor_user_id, id desc);

create function audit_log_immutable() returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is insert-only (% rejected)', tg_op using errcode = 'restrict_violation';
end
$$;

create trigger audit_log_no_update_delete
  before update or delete on audit_log
  for each row execute function audit_log_immutable();

create table webhook_log (
  id uuid primary key,
  provider text not null check (provider in ('squarespace', 'smsgate', 'ses')),
  external_id text not null,
  headers jsonb not null default '{}'::jsonb,
  body text,
  signature_valid boolean not null,
  received_at timestamptz not null default app_now(),
  processed_at timestamptz,
  status text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed')),
  error text,
  unique (provider, external_id)
);
create index webhook_log_received_idx on webhook_log (received_at);

create table notifications (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  employee_id uuid,
  role_target text,
  kind text not null,
  title text not null,
  body text,
  entity_type text,
  entity_id text,
  created_at timestamptz not null default app_now(),
  read_at timestamptz,
  check (employee_id is null or role_target is null)
);
create index notifications_location_idx on notifications (location_id, created_at desc);
create index notifications_unread_idx on notifications (employee_id) where read_at is null;

-- Idempotent seed of a location row (used by seeds, tests and server boot); returns the id of the existing or new row.
create function ensure_location(p_id uuid, p_slug text, p_name text, p_timezone text default 'America/New_York')
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  insert into locations (id, slug, name, timezone) values (p_id, p_slug, p_name, p_timezone)
  on conflict (slug) do nothing;
  select id into v_id from locations where slug = p_slug;
  return v_id;
end
$$;
