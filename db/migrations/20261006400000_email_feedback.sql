-- SES feedback (ADR 0110): the suppression list fed by /hooks/ses (hard bounces and complaints), and per-message feedback on the
-- email queue. The list is account-wide, not per location: SES suppresses an address for the whole sending account, and so do we.

create table email_suppressions (
  -- lowercased and trimmed; the key every send is checked against
  address text primary key check (address <> '' and address = lower(btrim(address))),
  -- the strongest reason seen so far: a complaint outranks a bounce
  reason text not null check (reason in ('bounce', 'complaint')),
  bounce_type text,
  bounce_subtype text,
  complaint_feedback_type text,
  -- the remote server's answer to the last bounce (truncated); never shown to customers
  diagnostic text,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  count integer not null default 1 check (count >= 1),
  -- SES message ids of the notifications that suppressed it (newest last, at most 20 kept)
  source_message_ids text[] not null default '{}',
  -- a person lifted the suppression (DELETE /api/v1/system/email-suppressions/:address); a new bounce re-suppresses
  cleared_at timestamptz,
  cleared_by uuid references users(id) on delete set null,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now()
);
create index email_suppressions_active_idx on email_suppressions (last_seen_at desc) where cleared_at is null;

-- What SES said about each sent message, matched on provider_message_id; appointment_id ties a receipt to the job whose activity
-- log shows the bounce; error_at is when `error` was last written (GET /system/integrations reports it).
alter table outbox_emails
  add column appointment_id uuid references appointments(id) on delete set null,
  add column error_at timestamptz,
  add column delivered_at timestamptz,
  add column feedback text check (feedback is null or feedback in ('soft_bounce', 'hard_bounce', 'complaint')),
  add column feedback_at timestamptz,
  add column feedback_detail text;
create index outbox_emails_provider_message_idx on outbox_emails (provider_message_id) where provider_message_id is not null;
