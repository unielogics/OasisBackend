-- Messaging (SMS): devices, one thread per customer, messages, the outbound outbox, the inbound inbox with quarantine,
-- opt-outs, the send-window usage log, processed webhook envelopes and the email outbox.
-- Location-scoped parents carry location_id. Every default reads app_now(), never now(). Secrets (device password, webhook
-- signing key) are stored encrypted by the application (AES-256-GCM, SECRETS_KEY); this file never sees plaintext.

create table sms_devices (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  -- the opaque path segment of this device's webhook URL: /hooks/smsgate/<device_key>
  device_key text not null unique check (device_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  label text not null check (btrim(label) <> ''),
  provider text not null default 'smsgate' check (provider in ('sim', 'smsgate')),
  base_url text check (base_url is null or base_url ~ '^https?://'),
  username text,
  password_enc text,
  webhook_secret_enc text not null,
  -- the device's own id as it appears in webhook envelopes (learned from the first event)
  remote_device_id text,
  sim_slot_default smallint check (sim_slot_default is null or sim_slot_default between 1 and 3),
  -- per-device overrides of the environment defaults (null = use SMSGATE_MIN_INTERVAL_MS / MAX_PER_WINDOW / WINDOW_MINUTES)
  min_interval_ms integer check (min_interval_ms is null or min_interval_ms >= 0),
  max_per_window integer check (max_per_window is null or max_per_window > 0),
  window_minutes integer check (window_minutes is null or window_minutes > 0),
  enabled boolean not null default true,
  status text not null default 'unknown' check (status in ('unknown', 'online', 'degraded', 'offline')),
  state_changed_at timestamptz,
  last_seen_at timestamptz,
  last_ping_at timestamptz,
  last_app_started_at timestamptz,
  last_poll_ok_at timestamptz,
  consecutive_poll_failures integer not null default 0 check (consecutive_poll_failures >= 0),
  health_status text check (health_status is null or health_status in ('pass', 'warn', 'fail')),
  battery smallint check (battery is null or battery between 0 and 100),
  charging boolean,
  last_health jsonb,
  last_error text,
  webhooks_url text,
  webhooks_registered_at timestamptz,
  sent_count bigint not null default 0,
  delivered_count bigint not null default 0,
  failed_count bigint not null default 0,
  received_count bigint not null default 0,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  check (provider = 'sim' or (base_url is not null and username is not null and password_enc is not null))
);
create index sms_devices_location_idx on sms_devices (location_id, enabled, created_at);

-- One thread per customer; the appointment a message belongs to is a column on the message, not a thread.
create table message_threads (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  customer_id uuid not null references customers(id),
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  unread_count integer not null default 0 check (unread_count >= 0),
  created_at timestamptz not null default app_now(),
  unique (location_id, customer_id)
);
create index message_threads_unread_idx on message_threads (location_id, last_inbound_at desc) where unread_count > 0;

create table messages (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  -- null for messages that are not part of a customer conversation (staff invites, replies to a stranger's STOP)
  thread_id uuid references message_threads(id) on delete cascade,
  customer_id uuid references customers(id),
  employee_id uuid references employees(id) on delete set null,
  appointment_id uuid references appointments(id) on delete set null,
  direction text not null check (direction in ('in', 'out')),
  sender_kind text not null check (sender_kind in ('staff', 'system', 'customer')),
  sender_employee_id uuid references employees(id) on delete set null,
  channel text not null default 'sms' check (channel in ('sms', 'email', 'internal')),
  -- sensitive classes (staff invite, password reset) store a redacted body here; the live text exists only in sms_outbox
  body text not null,
  template_key text,
  -- why the message exists ("confirm", "arrive", "staff", "inbound-reply", ...), and the SMS class it was queued under
  purpose text,
  klass text,
  status text not null check (status in ('queued', 'sending', 'sent', 'delivered', 'failed', 'received', 'canceled', 'expired')),
  -- the other party's number: the recipient of an outbound text, the sender of an inbound one
  peer_e164 text,
  provider_message_id text,
  device_id uuid references sms_devices(id) on delete set null,
  error text,
  segments smallint not null default 1 check (segments >= 1),
  encoding text check (encoding is null or encoding in ('GSM-7', 'UCS-2')),
  idempotency_key text unique,
  queued_at timestamptz not null default app_now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  received_at timestamptz,
  -- inbound only: set when staff opened the thread or replied
  read_at timestamptz,
  created_at timestamptz not null default app_now(),
  check ((direction = 'in') = (sender_kind = 'customer')),
  check ((direction = 'in') = (status = 'received'))
);
create index messages_thread_idx on messages (thread_id, queued_at, id) where thread_id is not null;
create index messages_appointment_idx on messages (appointment_id, queued_at, id) where appointment_id is not null;
create index messages_customer_idx on messages (customer_id, queued_at desc) where customer_id is not null;
create index messages_unread_idx on messages (customer_id) where direction = 'in' and read_at is null;
create index messages_provider_idx on messages (provider_message_id) where provider_message_id is not null;
create index messages_in_flight_idx on messages (status) where status in ('queued', 'sending');

-- The queue the dispatcher drains. id = messages.id = the SMS Gate message id of the first device attempt.
create table sms_outbox (
  id uuid primary key,
  message_id uuid not null unique references messages(id) on delete cascade,
  to_e164 text not null check (to_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  body text not null,
  encoding text not null check (encoding in ('GSM-7', 'UCS-2')),
  segments smallint not null check (segments >= 1),
  klass text not null,
  priority smallint not null check (priority between 0 and 3),
  state text not null default 'pending'
    check (state in ('pending', 'inflight', 'accepted', 'sent', 'delivered', 'failed', 'expired', 'cancelled')),
  attempts integer not null default 0,
  device_failures integer not null default 0,
  reconcile_resends integer not null default 0,
  next_attempt_at timestamptz,
  locked_at timestamptz,
  provider_message_id text,
  device_id uuid references sms_devices(id) on delete set null,
  sim_slot smallint check (sim_slot is null or sim_slot between 1 and 3),
  last_error text,
  queued_at timestamptz not null default app_now(),
  ttl_at timestamptz not null,
  hold_until timestamptz,
  accepted_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  last_reconciled_at timestamptz,
  -- a lane-0 message that waited too long was e-mailed instead (once)
  fallback_emailed_at timestamptz
);
create index sms_outbox_drain_idx on sms_outbox (state, priority, next_attempt_at);
create index sms_outbox_provider_idx on sms_outbox (provider_message_id) where provider_message_id is not null;
create index sms_outbox_to_idx on sms_outbox (to_e164);
create index sms_outbox_unconfirmed_idx on sms_outbox (accepted_at) where state in ('accepted', 'sent');

-- Segments handed to the device, the input of the sliding send window (Android's own SMS limit).
create table sms_usage (
  id bigint generated always as identity primary key,
  device_id uuid references sms_devices(id) on delete cascade,
  provider_message_id text not null,
  segments smallint not null check (segments >= 1),
  accepted_at timestamptz not null,
  sent_at timestamptz
);
create index sms_usage_window_idx on sms_usage (device_id, coalesce(sent_at, accepted_at));
create index sms_usage_provider_idx on sms_usage (provider_message_id);

-- Envelope ids already applied by the event ingestor. Rows live in the same transaction as the event's effects, so a
-- failed handler leaves no row and the device's retry is processed again.
create table sms_processed_events (
  event_id text primary key,
  processed_at timestamptz not null default app_now()
);

-- Every text the device received. Unknown senders stay here (quarantined): no customer row is ever created for them.
create table sms_inbox (
  id uuid primary key,
  device_id uuid not null references sms_devices(id) on delete cascade,
  provider_message_id text not null,
  from_raw text not null,
  from_e164 text,
  body text not null,
  device_received_at timestamptz not null,
  received_at timestamptz not null default app_now(),
  processed_at timestamptz,
  decision text check (
    decision is null
    or decision in ('opt_out', 'opt_in', 'help', 'confirm', 'confirm_nothing', 'cancel_request', 'message', 'quarantined')
  ),
  quarantined boolean not null default false,
  customer_id uuid references customers(id),
  appointment_id uuid references appointments(id) on delete set null,
  message_id uuid references messages(id) on delete set null,
  reviewed_at timestamptz,
  unique (device_id, provider_message_id)
);
create index sms_inbox_quarantine_idx on sms_inbox (received_at desc) where quarantined and reviewed_at is null;
create index sms_inbox_from_idx on sms_inbox (from_e164) where from_e164 is not null;

-- Opt-outs are about a phone number, not a customer: a STOP from a number we have no customer for still counts.
-- An active opt-out is a row with opted_in_again_at null.
create table sms_opt_outs (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  opted_out_at timestamptz not null,
  source text not null check (source in ('keyword', 'manual', 'import')),
  keyword text,
  inbound_message_id uuid references sms_inbox(id) on delete set null,
  opted_out_by uuid references users(id) on delete set null,
  opted_in_again_at timestamptz,
  check (opted_in_again_at is null or opted_in_again_at >= opted_out_at)
);
create unique index uq_sms_opt_outs_active on sms_opt_outs (location_id, phone_e164) where opted_in_again_at is null;
create index sms_opt_outs_phone_idx on sms_opt_outs (phone_e164, opted_out_at desc);

-- Email queue and the console driver's mailbox. Sensitive templates (invite, password reset) lose their variables once
-- the row is terminal, because the variables carry the one-time link.
create table outbox_emails (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  customer_id uuid references customers(id),
  employee_id uuid references employees(id) on delete set null,
  to_email text not null check (btrim(to_email) <> ''),
  template text not null,
  vars jsonb not null default '{}'::jsonb,
  purpose text,
  subject text,
  body text,
  state text not null default 'pending' check (state in ('pending', 'sending', 'sent', 'failed', 'suppressed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  locked_at timestamptz,
  provider_message_id text,
  error text,
  dedupe_key text unique,
  created_at timestamptz not null default app_now(),
  sent_at timestamptz
);
create index outbox_emails_drain_idx on outbox_emails (state, next_attempt_at) where state in ('pending', 'sending');

-- emergency_notifications.message_id and payment_links.sent_message_id stay plain uuid columns holding messages.id, as the
-- earlier migrations left them: the payments module's dev outbox hands out random uuids that are not messages (ADR 0060).
