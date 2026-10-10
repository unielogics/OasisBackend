-- Status texts as the car moves through the shop (ADR 0160, design section 6). The "checked in" text is queued 3 minutes after a
-- manual arrival and dropped if the wash starts first (then "wash started" goes instead): pending_checkin_texts is that durable
-- queue, one row per appointment, settled once. Running-late texts (at most two per visit) are recorded per appointment so the job
-- that sends them (every 2 minutes) never repeats one.

create table pending_checkin_texts (
  appointment_id uuid primary key references appointments(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  -- arrived_at + status_texts.checked_in_delay_min
  due_at timestamptz not null,
  state text not null default 'pending' check (state in ('pending', 'sent', 'dropped')),
  -- why it was dropped (cleaning started first, canceled, texts off) or the message it became
  drop_reason text check (drop_reason is null or drop_reason in ('cleaning_started', 'canceled', 'disabled', 'not_sendable')),
  message_id uuid references messages(id) on delete set null,
  created_at timestamptz not null default app_now(),
  settled_at timestamptz,
  check ((state = 'pending') = (settled_at is null)),
  check ((state = 'dropped') = (drop_reason is not null))
);
create index pending_checkin_texts_due_idx on pending_checkin_texts (due_at) where state = 'pending';

create table appointment_late_texts (
  appointment_id uuid not null references appointments(id) on delete cascade,
  seq smallint not null check (seq between 1 and 2),
  -- the new estimate the text gave (now + 15 minutes, rounded to 5)
  eta_at timestamptz not null,
  message_id uuid references messages(id) on delete set null,
  created_at timestamptz not null default app_now(),
  primary key (appointment_id, seq)
);
