-- Kiosk mode, per-employee activity (ADR 0180): one row per car step, booking, payment, text and so on, by whoever did it (the
-- employee tapped on the kiosk, or the signed-in person). The source of the Team activity report. Table and indexes only (wave K1a);
-- the rows are written by the attribution package (wave K1b) and read by the report (wave K2b).
create table staff_events (
  id bigint generated always as identity primary key,
  location_id uuid not null references locations(id) on delete cascade,
  at timestamptz not null default app_now(),
  employee_id uuid references employees(id) on delete set null,
  employee_name text not null check (btrim(employee_name) <> ''),
  kind text not null check (kind in ('confirm', 'arrive', 'assign_bay', 'start', 'complete', 'notify_ready',
    'pickup', 'pickup_reopen', 'prep_bay', 'reschedule', 'update', 'book', 'walk_in', 'customer_create',
    'addon_add', 'addon_remove', 'size_change', 'checklist', 'photo', 'payment', 'tip', 'receipt',
    'payment_link', 'text', 'arrival_link', 'worker_set')),
  appointment_id uuid references appointments(id) on delete set null,
  customer_id uuid references customers(id) on delete set null,
  amount_cents integer,
  ledger_event_id uuid references ledger_events(id),
  message_id uuid references messages(id) on delete set null,
  via text not null check (via in ('kiosk', 'signed_in')),
  kiosk_device_id uuid references kiosk_devices(id) on delete set null,
  user_id uuid references users(id) on delete set null,
  request_id text,
  meta jsonb not null default '{}'::jsonb
);
create index staff_events_loc_at_idx on staff_events (location_id, at);
create index staff_events_emp_at_idx on staff_events (employee_id, at);
create index staff_events_appt_idx on staff_events (appointment_id, at);
-- the report's payment and text counts read the existing tables by employee
create index ledger_events_pay_actor_idx on ledger_events (actor_employee_id, occurred_at) where type = 'pay';
create index messages_staff_sender_idx on messages (sender_employee_id, queued_at) where sender_kind = 'staff';
