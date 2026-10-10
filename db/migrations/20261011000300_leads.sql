-- Leads (ADR 0160, design sections 1 "Leads" and plan J): one light record per phone that asked about something and has not
-- booked (strangers the assistant answered, website visitors, walk-ins), with the categories they asked about, and the single
-- automatic follow-up text (leads.follow_up_*) the job leads.follow_up sends once. A booking closes the lead.

create table leads (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  customer_id uuid references customers(id) on delete set null,
  source text not null check (source in ('text', 'website', 'walk_in')),
  -- catalog_categories keys (what they asked about, or the assistant's note_interest)
  interests text[] not null default '{}' check (array_position(interests, null) is null and cardinality(interests) <= 10),
  status text not null default 'new' check (status in ('new', 'followed_up', 'booked', 'closed')),
  first_contact_at timestamptz not null,
  last_contact_at timestamptz not null,
  -- when the one follow-up is due (null: none planned); cleared once it is sent or dropped
  follow_up_at timestamptz,
  follow_up_message_id uuid references messages(id) on delete set null,
  booked_appointment_id uuid references appointments(id) on delete set null,
  closed_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  unique (location_id, phone_e164),
  check (last_contact_at >= first_contact_at),
  check ((status in ('booked', 'closed')) = (closed_at is not null))
);
create index leads_customer_idx on leads (customer_id) where customer_id is not null;
-- the follow-up job: open leads whose follow-up is due
create index leads_follow_up_due_idx on leads (follow_up_at) where status = 'new' and follow_up_at is not null;
create index leads_open_idx on leads (location_id, last_contact_at desc) where status in ('new', 'followed_up');
