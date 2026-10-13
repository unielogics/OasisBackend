-- ADR 0174 §4c (the AI assistant's practice chat; design k-design-assistant.md §4c): the owner texts Oasis AI as a client and sees
-- what it would answer. The real engine runs (the same prompt bytes, tools, guard and policy judge), but nothing is sent, booked or
-- written to a client record: the tools' effects only change the session's own state (a link becomes "[booking link]", a proposal
-- shows the confirmation it would text). These two tables are practice's own and the only ones it writes; the turns are answered
-- by the job ai.practice, and assistant.practice.retention deletes sessions after 30 days.
create table assistant_practice_sessions (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  -- the owner (or manager) who practises: a session is visible to its creator only
  user_id uuid not null references users(id) on delete cascade,
  -- new_texter: a synthetic new client (not in the database); client: a real client on file, read-only (needs cli.view)
  persona text not null check (persona in ('new_texter', 'client')),
  customer_id uuid references customers(id) on delete cascade,
  -- the phone counts as verified in this session (in-chat booking, with AI_ACTIONS_ENABLED and the setting)
  verified boolean not null default false,
  -- draft knowledge entries read as if they were on ("Try this draft"); no foreign key: an entry may be deleted meanwhile
  include_entry_ids uuid[] not null default '{}' check (cardinality(include_entry_ids) <= 20),
  language text not null default 'en' check (language in ('en', 'es')),
  -- what the tools' practice effects did: the name and vehicles saved, the interests, the links and the proposal, an opt-out
  state jsonb not null default '{}' check (jsonb_typeof(state) = 'object'),
  turns integer not null default 0 check (turns >= 0),
  -- USD millionths spent by this session (practice has its own daily budget, AI_PRACTICE_DAILY_BUDGET_USD)
  cost_micros bigint not null default 0 check (cost_micros >= 0),
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  check ((persona = 'client') = (customer_id is not null))
);
create index assistant_practice_sessions_user_idx on assistant_practice_sessions (user_id, created_at desc);
create index assistant_practice_sessions_created_idx on assistant_practice_sessions (created_at);

create table assistant_practice_turns (
  id uuid primary key,
  session_id uuid not null references assistant_practice_sessions(id) on delete cascade,
  -- the turn's place in the session; a re-run ("Try again", rerun_of) has its original's place
  seq integer not null check (seq >= 1),
  rerun_of uuid references assistant_practice_turns(id) on delete cascade,
  client_text text not null check (char_length(client_text) between 1 and 640),
  status text not null default 'running' check (status in ('running', 'replied', 'handed_off', 'failed', 'opted_out')),
  -- what the client would get (links as "[booking link]"), and the other texts the server would send (a proposal's confirmation)
  reply_text text check (reply_text is null or char_length(reply_text) <= 2000),
  extra_texts jsonb not null default '[]' check (jsonb_typeof(extra_texts) = 'array'),
  -- [{kind, label}]: rewritten, shortened, policy_rewrite, handed_off, fallback, link, proposal, opted_out, looked_up
  badges jsonb not null default '[]' check (jsonb_typeof(badges) = 'array'),
  error text check (error is null or char_length(error) <= 2000),
  model text,
  prompt_version text,
  facts_version text,
  tokens_in integer not null default 0 check (tokens_in >= 0),
  tokens_out integer not null default 0 check (tokens_out >= 0),
  tokens_cache_read integer not null default 0 check (tokens_cache_read >= 0),
  tokens_cache_write integer not null default 0 check (tokens_cache_write >= 0),
  cost_micros bigint not null default 0 check (cost_micros >= 0),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  -- the session's state when the turn began: a re-run starts from it (and never changes the session's own state)
  state_before jsonb not null default '{}' check (jsonb_typeof(state_before) = 'object'),
  -- redacted, like assistant_turns.transcript and assistant_tool_calls
  transcript jsonb,
  tool_calls jsonb not null default '[]' check (jsonb_typeof(tool_calls) = 'array'),
  started_at timestamptz not null default app_now(),
  finished_at timestamptz,
  check ((status = 'running') = (finished_at is null))
);
-- one place per turn of the main line; one running turn per session (409 PRACTICE_BUSY)
create unique index assistant_practice_turns_seq_idx on assistant_practice_turns (session_id, seq) where rerun_of is null;
create unique index assistant_practice_turns_running_idx on assistant_practice_turns (session_id) where status = 'running';
create index assistant_practice_turns_session_idx on assistant_practice_turns (session_id, started_at);
-- the day's practice spend (AI_PRACTICE_DAILY_BUDGET_USD)
create index assistant_practice_turns_started_idx on assistant_practice_turns (started_at);
