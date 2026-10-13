-- ADR 0174 (the AI assistant: knowledge, PDFs, practice, limits; design k-design-assistant.md §1 and §2): what the owner teaches
-- Oasis AI beyond Settings. A knowledge ENTRY is a note the owner wrote, the reviewed text of a PDF, or a correction (a client's
-- question and the right answer); only ACTIVE entries reach the prompt, as the SHOP KNOWLEDGE block (masked: amounts, links and
-- other numbers hidden), and the active entries plus the Settings Q&A share one character budget (AI_KNOWLEDGE_MAX_CHARS). A
-- DOCUMENT is an uploaded PDF (S3 kb/{location}/{id}.pdf, outside the photos' loc/ lifecycle rule): its extracted text becomes one
-- draft entry the owner reviews and edits before turning it on. Deleting a document clears its text and removes its object.
create table assistant_knowledge_documents (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  filename text not null check (char_length(filename) between 1 and 120),
  content_type text not null check (content_type = 'application/pdf'),
  bytes integer not null check (bytes between 1 and 10485760),
  -- the browser's hash at presign, then the server's own over the stored object at complete (authoritative)
  sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  s3_key text not null unique check (s3_key ~ '^kb/'),
  status text not null default 'pending_upload'
    check (status in ('pending_upload', 'extracting', 'ready', 'failed', 'deleted')),
  error_code text check (error_code in ('no_text', 'encrypted', 'corrupt', 'too_many_pages', 'timeout', 'not_pdf', 'too_large')),
  page_count integer check (page_count >= 0),
  -- cleaned text, at most 200,000 characters; null once deleted
  extracted_text text check (extracted_text is null or char_length(extracted_text) <= 200000),
  -- hidden, control, format, private-use and tag characters stripped from the text
  removed_chars integer not null default 0 check (removed_chars >= 0),
  attempts smallint not null default 0 check (attempts >= 0),
  uploaded_by uuid references users(id) on delete set null,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  deleted_at timestamptz,
  object_deleted_at timestamptz,
  check ((status = 'failed') = (error_code is not null)),
  check ((status = 'deleted') = (deleted_at is not null)),
  check (status <> 'deleted' or extracted_text is null)
);
-- one live copy of a file per location (sha256 duplicate check)
create unique index assistant_knowledge_documents_sha_idx
  on assistant_knowledge_documents (location_id, sha256) where status <> 'deleted' and sha256 is not null;
create index assistant_knowledge_documents_location_idx on assistant_knowledge_documents (location_id, created_at);
-- the cleanup job: abandoned uploads, stuck extractions, objects still to delete
create index assistant_knowledge_documents_cleanup_idx on assistant_knowledge_documents (status, updated_at)
  where status in ('pending_upload', 'extracting') or (status = 'deleted' and object_deleted_at is null);

create table assistant_knowledge (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  kind text not null check (kind in ('note', 'document', 'correction')),
  title text not null check (char_length(title) between 1 and 120),
  -- note: at most 4,000; document: stores at most 60,000 (20,000 to turn on); correction: the right answer, at most 500
  body text not null check (char_length(body) <= 60000),
  -- correction: the client's words (at most 300)
  question text check (question is null or char_length(question) <= 300),
  -- correction: what Oasis AI said (redacted); NEVER shown to the model
  wrong_reply text check (wrong_reply is null or char_length(wrong_reply) <= 2000),
  source text not null default 'manual' check (source in ('manual', 'practice', 'live')),
  assistant_turn_id uuid references assistant_turns(id) on delete set null,
  -- no foreign key: practice rows expire after 30 days
  practice_turn_id uuid,
  document_id uuid unique references assistant_knowledge_documents(id) on delete cascade,
  active boolean not null default false,
  -- document: the owner read the extracted text (needed before it can be turned on)
  reviewed_at timestamptz,
  -- [{kind: amount|link|phone|email|instruction|promise|hidden|markup|long, sample, line}]
  warnings jsonb not null default '[]' check (jsonb_typeof(warnings) = 'array'),
  -- title + question + body: what counts against the budget
  chars integer not null check (chars >= 0),
  sort integer not null default 0,
  version integer not null default 1 check (version >= 1),
  created_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  check ((kind = 'document') = (document_id is not null)),
  check (kind <> 'correction' or question is not null),
  check (kind = 'correction' or (question is null and wrong_reply is null)),
  check (kind <> 'document' or not active or reviewed_at is not null)
);
create index assistant_knowledge_active_idx on assistant_knowledge (location_id) where active;
create index assistant_knowledge_location_idx on assistant_knowledge (location_id, kind, sort, created_at);
