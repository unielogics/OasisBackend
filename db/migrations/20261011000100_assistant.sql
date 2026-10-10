-- The AI text assistant (ADR 0160, design sections 1 "Assistant" and 3). One conversation per (location, phone): the durable marker
-- the webhook sets inside its transaction (pending_since), the lease a running turn holds (running_since), the handoff state; one
-- row per turn with its usage, cost and redacted transcript; one row per tool call. Inbound texts point at the conversation and
-- turn that answered them; messages gain the sender kind 'ai'; a staff reply pauses the AI on the thread; the AI books with
-- appointments.source 'sms_ai'; a client the AI creates records the transactional-only opt-in source 'inbound_text'.

create table assistant_conversations (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  -- the client the number belongs to, once known (null for a stranger until create_client)
  customer_id uuid references customers(id) on delete set null,
  -- durable "texts waiting for an answer" marker, set in the webhook transaction and cleared by the turn that answers them
  pending_since timestamptz,
  last_inbound_at timestamptz,
  -- the lease of the running turn; a sweep fails leases older than 3 minutes
  running_since timestamptz,
  handoff_state text check (handoff_state is null or handoff_state in ('open', 'resolved')),
  handoff_reason text check (handoff_reason is null or length(handoff_reason) <= 500),
  handoff_at timestamptz,
  -- the fixed fallback text goes at most once per 2 hours per conversation
  last_fallback_at timestamptz,
  -- when the "automated assistant" disclosure was sent (the first AI text of the conversation carries it)
  disclosed_at timestamptz,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  unique (location_id, phone_e164),
  check ((handoff_state is null) = (handoff_at is null))
);
create index assistant_conversations_customer_idx on assistant_conversations (customer_id) where customer_id is not null;
-- the sweep: markers older than 30 seconds, leases older than 3 minutes
create index assistant_conversations_pending_idx on assistant_conversations (pending_since) where pending_since is not null;
create index assistant_conversations_running_idx on assistant_conversations (running_since) where running_since is not null;
create index assistant_conversations_handoff_idx on assistant_conversations (location_id, handoff_at) where handoff_state = 'open';

create table assistant_turns (
  id uuid primary key,
  conversation_id uuid not null references assistant_conversations(id) on delete cascade,
  status text not null default 'running' check (status in ('running', 'replied', 'handed_off', 'skipped', 'failed')),
  -- what the caller was known as when the turn started: a stranger, a known client, a client whose phone is trusted (30 days)
  trust text not null check (trust in ('unknown', 'known', 'trusted')),
  provider text not null check (provider in ('sim', 'bedrock')),
  model text,
  prompt_version text,
  rounds smallint not null default 0 check (rounds >= 0),
  tokens_in integer not null default 0 check (tokens_in >= 0),
  tokens_out integer not null default 0 check (tokens_out >= 0),
  tokens_cache_read integer not null default 0 check (tokens_cache_read >= 0),
  tokens_cache_write integer not null default 0 check (tokens_cache_write >= 0),
  -- USD millionths, from the AI_PRICE_* settings at the time of the turn
  cost_micros bigint not null default 0 check (cost_micros >= 0),
  stop_reason text,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  reply_message_id uuid references messages(id) on delete set null,
  -- append-only, redacted (no phone numbers, ids, tokens or codes): system/context digest, messages, tool calls, reasoning blocks
  transcript jsonb not null default '[]' check (jsonb_typeof(transcript) = 'array'),
  error text check (error is null or length(error) <= 2000),
  started_at timestamptz not null default app_now(),
  finished_at timestamptz,
  check ((status = 'running') = (finished_at is null))
);
create index assistant_turns_conversation_idx on assistant_turns (conversation_id, started_at desc);
-- global caps (turns per hour/day), the daily budget and retention purges read by time
create index assistant_turns_started_idx on assistant_turns (started_at);
-- one running turn per conversation
create unique index uq_assistant_turns_running on assistant_turns (conversation_id) where status = 'running';

create table assistant_tool_calls (
  id uuid primary key,
  turn_id uuid not null references assistant_turns(id) on delete cascade,
  seq smallint not null check (seq >= 1),
  round smallint not null check (round >= 0),
  tool text not null check (tool ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- the provider's id of the tool-use block
  tool_use_id text,
  input jsonb not null check (jsonb_typeof(input) = 'object'),
  output jsonb,
  outcome text not null check (outcome in ('ok', 'error', 'denied')),
  error text check (error is null or length(error) <= 2000),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  created_at timestamptz not null default app_now(),
  unique (turn_id, seq)
);
create index assistant_tool_calls_tool_idx on assistant_tool_calls (tool, created_at);

-- Inbound texts: which conversation and turn took them. Decisions gain 'assistant' (handed to the AI), 'handoff' (AGENT: a person,
-- no AI) and 'action_code' (a digits-only reply checked against a pending action's reply number, no model).
alter table sms_inbox
  add column assistant_conversation_id uuid references assistant_conversations(id) on delete set null,
  add column assistant_turn_id uuid references assistant_turns(id) on delete set null;
create index sms_inbox_assistant_conversation_idx on sms_inbox (assistant_conversation_id, received_at)
  where assistant_conversation_id is not null;
alter table sms_inbox drop constraint sms_inbox_decision_check;
alter table sms_inbox add constraint sms_inbox_decision_check check (
  decision is null or decision in ('opt_out', 'opt_in', 'help', 'confirm', 'confirm_nothing', 'cancel_request', 'message',
    'quarantined', 'assistant', 'handoff', 'action_code')
);

-- Messages the assistant wrote (shown as "Oasis AI"); still outbound, so the direction/sender rule holds.
alter table messages drop constraint messages_sender_kind_check;
alter table messages add constraint messages_sender_kind_check check (sender_kind in ('staff', 'system', 'customer', 'ai'));

-- A staff reply pauses the AI on the thread (assistant.staff_pause_hours, 12 by default).
alter table message_threads
  add column ai_paused_until timestamptz,
  add column ai_paused_by uuid references employees(id) on delete set null;

alter table appointments drop constraint appointments_source_check;
alter table appointments add constraint appointments_source_check check (
  source in ('dashboard', 'walk_in', 'online', 'phone', 'standing', 'reschedule_link', 'sms_ai')
);

-- Consent of a client the assistant creates: transactional texts only, never marketing (src/modules/messaging/db/recipients.ts).
alter table customers drop constraint customers_sms_opt_in_source_check;
alter table customers add constraint customers_sms_opt_in_source_check check (
  sms_opt_in_source is null
  or sms_opt_in_source in ('dashboard', 'walk_in', 'online', 'squarespace', 'inbound_sms', 'import', 'keyword', 'inbound_text')
);
