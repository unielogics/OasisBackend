-- Square cards on file (ADR 0171 D7 and D12, wave Q3 shared foundation, design q-design-square.md 4.2): the link between an Oasis
-- client and their Square customer, the cards saved with Square (Oasis keeps only Square's card id and what Square tells about the
-- card: brand, last 4, expiry; never a card number), the client's consent to each use (versioned text, its hash and snapshot, when,
-- from where; append-only except the revoke columns), the charges proposed on a saved card (a fee or a balance; charged only after
-- staff confirm), and the personal link kind `card` (#/k/, the page where a client saves a card).
-- Nothing here moves money and nothing writes these tables while SQUARE_WRITES_ENABLED=false / PUBLIC_LINKS_ENABLED=false (defaults).

-- Personal links: the card page ------------------------------------------------------------------------------------------------

alter table client_links drop constraint client_links_kind_check;
alter table client_links
  add constraint client_links_kind_check check (kind in ('calendar', 'verify', 'pin', 'membership', 'pay', 'book_again', 'card'));

-- Square customers --------------------------------------------------------------------------------------------------------------

-- One Square customer per client and location (ensureSquareCustomer: this row, else SearchCustomers by reference_id = the client's
-- uuid, else CreateCustomer with the key cu_<client id>). linked_by: created (we created it), found (Square already had a customer with
-- our reference_id: a retry after a crash), staff (linked by hand).
create table square_customer_links (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  customer_id uuid not null references customers(id),
  square_customer_id text not null check (btrim(square_customer_id) <> ''),
  linked_by text not null check (linked_by in ('created', 'found', 'staff')),
  created_at timestamptz not null default app_now(),
  unique (location_id, customer_id),
  unique (location_id, square_customer_id)
);

-- Saved cards -------------------------------------------------------------------------------------------------------------------

-- A card saved with Square for a client (CreateCard with the key cd_<...>). state: active (usable), disabled (removed by the client,
-- staff or DisableCard), forgotten (Square forgot it at the holder's request), expired. created_via: card_link (the #/k page),
-- membership_link (the enrollment on #/m), staff, square (seen at Square first).
create table customer_cards (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  customer_id uuid not null references customers(id),
  square_customer_id text not null,
  square_card_id text not null unique,
  brand text,
  last4 text check (last4 is null or last4 ~ '^[0-9]{4}$'),
  exp_month smallint check (exp_month is null or exp_month between 1 and 12),
  exp_year smallint check (exp_year is null or exp_year between 2000 and 2200),
  card_type text,
  postal text check (postal is null or length(postal) <= 12),
  fingerprint text,
  state text not null default 'active' check (state in ('active', 'disabled', 'forgotten', 'expired')),
  created_via text not null check (created_via in ('card_link', 'membership_link', 'staff', 'square')),
  disabled_at timestamptz,
  disabled_reason text check (disabled_reason is null or disabled_reason in
    ('client_removed', 'staff_removed', 'square_disabled', 'square_forgotten', 'expired', 'customer_deleted')),
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  check ((state = 'active') = (disabled_at is null))
);
create index customer_cards_customer_idx on customer_cards (customer_id, created_at);

-- Consents --------------------------------------------------------------------------------------------------------------------

-- The client's OK to charge a saved card, one row per acceptance: the purposes ticked, the exact text shown (version, SHA-256 and the
-- text itself, from src/modules/square/consents.ts), when, the address and browser, and the personal link and page (session token
-- hash) it was given on. Append-only: rows are never deleted and only the revoke columns may be set, once.
create table card_consents (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  customer_id uuid not null references customers(id),
  card_id uuid not null references customer_cards(id),
  purposes text[] not null check (
    cardinality(purposes) between 1 and 4
    and purposes <@ array['membership_billing', 'no_show_fee', 'late_cancel_fee', 'balance']::text[]),
  text_version text not null check (text_version ~ '^v[0-9]{1,4}$'),
  text_sha256 text not null check (text_sha256 ~ '^[0-9a-f]{64}$'),
  text_snapshot text not null check (btrim(text_snapshot) <> ''),
  accepted_at timestamptz not null,
  ip inet,
  user_agent text check (user_agent is null or length(user_agent) <= 512),
  -- the personal link (no foreign key: links are purged, the consent is kept) and the page's session token hash
  link_id uuid,
  session_hash text check (session_hash is null or session_hash ~ '^[0-9a-f]{64}$'),
  revoked_at timestamptz,
  revoked_by text,
  revoke_reason text check (revoke_reason is null or revoke_reason in
    ('client_removed', 'staff_removed', 'card_disabled', 'card_forgotten', 'card_expired', 'replaced', 'customer_deleted')),
  created_at timestamptz not null default app_now(),
  check ((revoked_at is null) = (revoke_reason is null) and (revoked_at is null) = (revoked_by is null))
);
create index card_consents_card_idx on card_consents (card_id) where revoked_at is null;
create index card_consents_customer_idx on card_consents (customer_id, accepted_at);

create function card_consents_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'card_consents is append-only: rows cannot be deleted' using errcode = 'restrict_violation';
  end if;
  if old.revoked_at is not null then
    raise exception 'card_consents: a revoked consent cannot change' using errcode = 'restrict_violation';
  end if;
  if (to_jsonb(new) - array['revoked_at', 'revoked_by', 'revoke_reason']) is distinct from
     (to_jsonb(old) - array['revoked_at', 'revoked_by', 'revoke_reason']) then
    raise exception 'card_consents is append-only: only the revoke columns can be set' using errcode = 'restrict_violation';
  end if;
  return new;
end $$;

create trigger card_consents_guard before update or delete on card_consents
  for each row execute function card_consents_guard();

-- Charges on a saved card -------------------------------------------------------------------------------------------------------

-- A charge on a saved card (a no-show or late-cancel fee, a balance with the client's OK). It starts `proposed` and is charged only
-- after a staff member confirms (D7): charging (the CreatePayment with `idempotency_key` ch_<id> is out), charged (Square's payment
-- id), declined (the card was declined: `error`), unknown (no answer: the job re-sends the same key), waived (staff waived it).
create table square_charges (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  customer_id uuid not null references customers(id),
  card_id uuid references customer_cards(id),
  consent_id uuid references card_consents(id),
  purpose text not null check (purpose in ('no_show_fee', 'late_cancel_fee', 'balance')),
  amount_cents integer not null check (amount_cents > 0),
  state text not null default 'proposed' check (state in ('proposed', 'charging', 'charged', 'declined', 'unknown', 'waived')),
  idempotency_key text not null unique check (length(idempotency_key) <= 45),
  invoice_id uuid references invoices(id),
  appointment_id uuid references appointments(id),
  square_payment_id text unique,
  ledger_event_id uuid references ledger_events(id),
  error text,
  attempts integer not null default 0 check (attempts >= 0),
  proposed_by text,
  decided_by text,
  decided_by_user_id uuid references users(id) on delete set null,
  decided_at timestamptz,
  charged_at timestamptz,
  waive_reason text,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  check (state <> 'charged' or square_payment_id is not null),
  check (state = 'proposed' or decided_at is not null),
  check (invoice_id is not null or appointment_id is not null)
);
create index square_charges_open_idx on square_charges (location_id, created_at) where state in ('proposed', 'charging', 'unknown');
create index square_charges_invoice_idx on square_charges (invoice_id) where invoice_id is not null;
create index square_charges_customer_idx on square_charges (customer_id);
