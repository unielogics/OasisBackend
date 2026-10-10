-- The phone as the client's identity (ADR 0160, design sections 1 "Identity" and 5). Personal links (a 32-byte token, only its
-- SHA-256 stored) and the short sessions a link is exchanged for; the client's website PIN (scrypt over a peppered HMAC, never the
-- PIN); the 30-day trust a verified phone earns; the in-chat actions waiting for their reply number. The website's one-time codes
-- gain a purpose and the link session that asked; customers gain email_verified and a phone version (links name the version they
-- were issued for, so a phone change kills them even if the number later comes back).

alter table customers
  add column email_verified boolean not null default false,
  -- bumped on every phone change (and merge); client_links.phone_version must match it
  add column phone_version integer not null default 0 check (phone_version >= 0);

create table client_links (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  -- sha256 (hex) of the base64url token; the token itself exists only in the text that carried it
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('calendar', 'verify', 'pin', 'membership', 'pay', 'book_again')),
  -- null only for a stranger's calendar link (a lead's follow-up); PIN, membership and payment links always name the client
  customer_id uuid references customers(id) on delete cascade,
  -- the number the link was texted to: codes from the link go there and nowhere else
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  appointment_id uuid references appointments(id) on delete cascade,
  invoice_id uuid references invoices(id) on delete cascade,
  plan_key text check (plan_key is null or plan_key ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- customer_pins.version, customers.phone_version and the links.epoch setting when issued: any change makes the link dead
  pin_version integer not null default 0 check (pin_version >= 0),
  phone_version integer not null default 0 check (phone_version >= 0),
  epoch integer not null check (epoch >= 1),
  issued_by text not null check (issued_by in ('assistant', 'staff', 'system')),
  expires_at timestamptz not null,
  -- completions (a booking, a verification); opening a link uses nothing
  uses integer not null default 0 check (uses >= 0),
  max_uses integer not null check (max_uses >= 1),
  consumed_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text check (revoke_reason is null or revoke_reason in (
    'phone_change', 'pin_set', 'pin_reset', 'pin_cleared', 'merge', 'opt_out', 'staff', 'epoch', 'superseded')),
  created_at timestamptz not null default app_now(),
  check (uses <= max_uses),
  check ((revoked_at is null) = (revoke_reason is null)),
  constraint client_links_customer_check check (customer_id is not null or kind in ('calendar', 'book_again')),
  constraint client_links_pay_invoice_check check (kind <> 'pay' or invoice_id is not null),
  constraint client_links_membership_plan_check check (kind <> 'membership' or plan_key is not null)
);
-- revocation by client (phone change, PIN reset, merge, STOP, staff Clear PIN) touches the live links only
create index client_links_customer_live_idx on client_links (customer_id, kind)
  where consumed_at is null and revoked_at is null;
-- per-phone limits (<= 3 links a day, 1 per kind an hour) and revocation of a stranger's links
create index client_links_phone_idx on client_links (location_id, phone_e164, created_at desc);
create index client_links_expiry_idx on client_links (expires_at);

create table client_link_sessions (
  -- sha256 (hex) of the bearer session token the exchange returned (held in the page's memory only)
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  link_id uuid not null references client_links(id) on delete cascade,
  customer_id uuid references customers(id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  -- 'link': holding the link proves only access to the texted number's messages; 'verified': PIN or texted code entered
  trust text not null default 'link' check (trust in ('link', 'verified')),
  verified_by text check (verified_by is null or verified_by in ('pin', 'code')),
  -- the last fresh PIN/code entry (memberships and payments need one within 5 minutes)
  step_up_at timestamptz,
  -- wrong PIN/code entries in this session (5 kill it)
  failed_attempts smallint not null default 0 check (failed_attempts >= 0),
  idle_expires_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  ip text,
  created_at timestamptz not null default app_now(),
  last_used_at timestamptz,
  check ((trust = 'verified') = (verified_by is not null)),
  check (idle_expires_at <= expires_at)
);
create index client_link_sessions_link_idx on client_link_sessions (link_id);
create index client_link_sessions_customer_idx on client_link_sessions (customer_id) where customer_id is not null;
create index client_link_sessions_expiry_idx on client_link_sessions (expires_at);

create table customer_pins (
  customer_id uuid primary key references customers(id) on delete cascade,
  -- scrypt over HMAC(PIN_PEPPER, customerId:pin), in the encoded form of src/modules/auth/password.ts; null once cleared (the row
  -- stays so the version keeps counting and a link issued before the clear stays dead)
  pin_hash text check (pin_hash is null or length(pin_hash) between 20 and 512),
  -- bumped on every set, reset and clear
  version integer not null default 1 check (version >= 1),
  failed_attempts smallint not null default 0 check (failed_attempts >= 0),
  -- 0 none, 1 locked 15 minutes, 2 locked 1 hour, 3 disabled until reset (staff notified)
  lock_level smallint not null default 0 check (lock_level between 0 and 3),
  locked_until timestamptz,
  set_at timestamptz not null,
  -- after a reset by texted code, member privileges wait until then (72 hours)
  reset_hold_until timestamptz,
  cleared_at timestamptz,
  updated_at timestamptz not null default app_now(),
  check ((pin_hash is null) = (cleared_at is not null))
);

create table phone_trust (
  location_id uuid not null references locations(id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  customer_id uuid not null references customers(id) on delete cascade,
  verified_at timestamptz not null,
  verified_by text not null check (verified_by in ('pin', 'code')),
  -- verified_at + 30 days
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoke_reason text check (revoke_reason is null or revoke_reason in (
    'phone_change', 'pin_set', 'pin_reset', 'pin_cleared', 'merge', 'opt_out', 'staff', 'epoch', 'superseded')),
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  primary key (location_id, phone_e164),
  check (expires_at > verified_at),
  check ((revoked_at is null) = (revoke_reason is null))
);
create index phone_trust_customer_idx on phone_trust (customer_id);

-- An in-chat booking, reschedule or cancel the assistant proposed: the server texts "... Reply NNNN to confirm" (action_confirm) and
-- executes only on that reply. The model never sees the number; at most one pending action per phone.
create table assistant_pending_actions (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  conversation_id uuid not null references assistant_conversations(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  kind text not null check (kind in ('book', 'reschedule', 'cancel')),
  -- the validated proposal (service keys, date, start minute, appointment id for reschedule/cancel)
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  -- sha256(id || ':' || code), like the website's one-time codes
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  attempts smallint not null default 0 check (attempts >= 0),
  max_attempts smallint not null default 3 check (max_attempts >= 1),
  -- created_at + 15 minutes
  expires_at timestamptz not null,
  state text not null default 'pending'
    check (state in ('pending', 'executed', 'failed', 'expired', 'superseded', 'locked', 'canceled')),
  confirm_message_id uuid references messages(id) on delete set null,
  -- the appointment booked, moved or canceled
  appointment_id uuid references appointments(id) on delete set null,
  error text check (error is null or length(error) <= 2000),
  created_at timestamptz not null default app_now(),
  resolved_at timestamptz,
  check ((state = 'pending') = (resolved_at is null))
);
create unique index uq_assistant_pending_actions_phone on assistant_pending_actions (location_id, phone_e164) where state = 'pending';
create index assistant_pending_actions_expiry_idx on assistant_pending_actions (expires_at) where state = 'pending';
create index assistant_pending_actions_conversation_idx on assistant_pending_actions (conversation_id);

-- The website's one-time codes serve the link pages too: what the code is for, and the link session that asked (a code from a link
-- goes only to the link's phone).
alter table public_otp_challenges
  add column purpose text not null default 'website' check (purpose in ('website', 'link_verify', 'pin_set', 'pin_reset')),
  add column link_session_hash text references client_link_sessions(token_hash) on delete cascade,
  add constraint public_otp_challenges_link_purpose_check check (purpose = 'website' or link_session_hash is not null);
