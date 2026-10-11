-- The identity core (ADR 0160, design sections 1 "Identity" and 5; wave W2b). The 30-day phone trust records the links epoch it was
-- granted in, so bumping links.epoch ends every trust as well as every link and session; and wrong PIN entries are kept one row
-- each for the rolling limits (at most 10 a day per client, 20 an hour per client address), which a fixed window cannot give.

alter table phone_trust
  -- the links.epoch setting when the trust was granted: any other value makes it void (the incident switch)
  add column epoch integer not null default 1 check (epoch >= 1);

create table identity_pin_failures (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  -- null when the number has no client or the client has no PIN: such a try still counts against the address and the session
  customer_id uuid references customers(id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  -- the client address that tried (never returned)
  ip text,
  at timestamptz not null default app_now()
);
create index identity_pin_failures_customer_idx on identity_pin_failures (customer_id, at desc) where customer_id is not null;
create index identity_pin_failures_ip_idx on identity_pin_failures (location_id, ip, at desc) where ip is not null;
create index identity_pin_failures_at_idx on identity_pin_failures (at);
