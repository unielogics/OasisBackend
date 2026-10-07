-- Arrival pings (b6 gap 2): the customer's phone reports where it is, authenticated by a per-appointment link token. The token's
-- SHA-256 is stored in appointments.arrival_token_hash (the plain token exists only in the response that issued it); every
-- accepted ping is a row here, which is also what the per-appointment throttle and the pingId replay read.

alter table appointments add column arrival_token_expires_at timestamptz;
create unique index uq_appointments_arrival_token on appointments (arrival_token_hash) where arrival_token_hash is not null;

create table arrival_pings (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  appointment_id uuid not null references appointments(id) on delete cascade,
  at timestamptz not null default app_now(),
  lat numeric(9,6) not null check (lat between -90 and 90),
  lng numeric(9,6) not null check (lng between -180 and 180),
  accuracy_m integer check (accuracy_m is null or accuracy_m >= 0),
  distance_m integer not null check (distance_m >= 0),
  eta_min integer check (eta_min is null or eta_min >= 0),
  -- the customer tapped "I'm here" rather than the page reporting in the background
  declared boolean not null default false,
  outcome text not null check (outcome in ('outside', 'inconclusive', 'checked_in', 'confirm_needed', 'already_arrived')),
  -- the client's own id for this ping; a repeat returns the stored answer
  ping_key text,
  -- the answer given, replayed verbatim for a repeated ping_key
  reply jsonb not null
);
create index arrival_pings_appointment_idx on arrival_pings (appointment_id, at desc);
create unique index uq_arrival_ping_key on arrival_pings (appointment_id, ping_key) where ping_key is not null;
