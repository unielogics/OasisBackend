-- The public website's booking surface (ADR 0150): one-time SMS codes that identify a member by phone, the opaque member
-- tokens a verified code issues, and the durable counters behind the per-phone and per-address limits of the public routes.
-- Nothing here holds a plain secret: codes and tokens are stored as SHA-256 hashes; the plain values exist only in the SMS
-- and in the response that issued them. Rows are short-lived and purged by maintenance.purge.

create table public_otp_challenges (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  -- sha256(id || ':' || code): the challenge id salts the hash, so equal codes never hash alike
  code_hash text not null,
  attempts smallint not null default 0 check (attempts >= 0),
  max_attempts smallint not null default 3 check (max_attempts > 0),
  expires_at timestamptz not null,
  -- set when the code was verified, superseded by a newer code, or locked after too many wrong tries
  consumed_at timestamptz,
  consumed_reason text check (consumed_reason is null or consumed_reason in ('verified', 'superseded', 'locked')),
  -- the client address that asked, for the abuse log (never returned)
  requested_ip text,
  -- where the code went: queued as an SMS, or why it was not (the policy's reason), for diagnostics
  delivery text not null default 'queued',
  created_at timestamptz not null default app_now()
);
create index public_otp_challenges_phone_idx on public_otp_challenges (phone_e164, created_at desc);
-- one active challenge per phone: a new request supersedes the earlier one (consumed_reason 'superseded')
create unique index uq_public_otp_active_phone on public_otp_challenges (location_id, phone_e164) where consumed_at is null;

create table public_member_tokens (
  -- sha256 of the opaque token (base64url, 43 characters); the token itself is never stored
  token_hash text primary key,
  location_id uuid not null references locations(id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  -- the customer the number belonged to when the code was verified; null when nobody with that number existed yet
  customer_id uuid references customers(id) on delete cascade,
  challenge_id uuid references public_otp_challenges(id) on delete set null,
  expires_at timestamptz not null,
  last_used_at timestamptz,
  created_at timestamptz not null default app_now()
);
create index public_member_tokens_expiry_idx on public_member_tokens (expires_at);

-- Fixed-window counters shared by every API process: key such as 'otp:phone:+1201...' or 'booking:ip:203.0.113.9', the
-- window the count belongs to, and the count. One upsert per request; windows older than a day are purged.
create table public_rate_limits (
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0 check (count >= 0),
  primary key (key, window_start)
);
create index public_rate_limits_window_idx on public_rate_limits (window_start);
