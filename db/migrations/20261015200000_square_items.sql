-- The Square item library sync (ADR 0172, design k-design-square-items.md section 2): every active priced service is a Square ITEM
-- with one ITEM_VARIATION per vehicle size, in an Oasis category and the "Oasis" marker category, taxed by the shop's Square tax.
-- square_catalog_links is the ONLY set of Square ids Oasis writes (per Square environment: sim and sandbox ids never reach
-- production); square_items_state keeps the tax decision, the last sync and the read-back watermark per location and environment.
-- Nothing here does anything by itself: no row is written while SQUARE_ITEMS_SYNC_ENABLED is false (the default), except the
-- read-only preview and tax check kept in square_items_state.

create table square_catalog_links (
  id uuid primary key,
  location_id uuid not null references locations(id) on delete cascade,
  environment text not null check (environment in ('sim', 'sandbox', 'production')),
  kind text not null check (kind in ('item', 'variation', 'category', 'tax')),
  -- item and variation: the service (services are never deleted)
  service_id uuid references services(id),
  -- variation: the vehicle size; null = the "Regular" variation of a service without prices by size
  class_key text check (class_key is null or class_key ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- category: the Oasis category key, or '_oasis' for the marker category (cannot clash: keys start with a letter)
  category_key text check (category_key is null or category_key ~ '^(_oasis|[a-z][a-z0-9_]{0,31})$'),
  square_object_id text check (square_object_id is null or length(square_object_id) <= 64),
  -- variation: the Square item it belongs to
  square_item_id text check (square_item_id is null or length(square_item_id) <= 64),
  square_version bigint,
  -- what Oasis wants now (planner) and what Square last confirmed; they differ = waiting for Square
  desired_hash text check (desired_hash is null or length(desired_hash) <= 64),
  content_hash text check (content_hash is null or length(content_hash) <= 64),
  state text not null default 'pending' check (state in ('pending', 'synced', 'failed', 'archived', 'hidden', 'gone')),
  -- the shop's own tax or category: referenced by Oasis items, never written
  adopted boolean not null default false,
  error text check (error is null or length(error) <= 300),
  -- the outbox of a create in flight: the idempotency key and the exact request body as JSON text (text, not jsonb: jsonb would
  -- reorder the keys, and Square answers a key sent again with another body IDEMPOTENCY_KEY_REUSED), re-sent unchanged after a crash
  pending_key text check (pending_key is null or length(pending_key) <= 45),
  pending_body text check (pending_body is null or length(pending_body) <= 200000),
  pending_at timestamptz,
  synced_at timestamptz,
  checked_at timestamptz,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  check ((kind in ('item', 'variation')) = (service_id is not null)),
  check (kind = 'variation' or class_key is null),
  check ((kind = 'category') = (category_key is not null)),
  check (kind <> 'variation' or square_object_id is null or square_item_id is not null),
  check ((pending_key is null) = (pending_body is null))
);

create unique index uq_square_catalog_links_item on square_catalog_links (location_id, environment, service_id) where kind = 'item';
create unique index uq_square_catalog_links_variation on square_catalog_links (location_id, environment, service_id, coalesce(class_key, ''))
  where kind = 'variation';
create unique index uq_square_catalog_links_category on square_catalog_links (location_id, environment, category_key) where kind = 'category';
create unique index uq_square_catalog_links_tax on square_catalog_links (location_id, environment) where kind = 'tax';
create unique index uq_square_catalog_links_object on square_catalog_links (environment, square_object_id) where square_object_id is not null;
create index ix_square_catalog_links_open on square_catalog_links (location_id, environment, state) where state in ('pending', 'failed');

create table square_items_state (
  location_id uuid not null references locations(id) on delete cascade,
  environment text not null check (environment in ('sim', 'sandbox', 'production')),
  -- auto: adopt the one matching tax, create one when the location has none, else blocked; adopt: the tax staff chose; create: Oasis's own
  tax_mode text not null default 'auto' check (tax_mode in ('auto', 'adopt', 'create')),
  tax_object_id text check (tax_object_id is null or length(tax_object_id) <= 64),
  -- the last tax check (status ok | create | blocked | error, the tax, the detail, warnings) and when it ran
  tax_check jsonb,
  tax_checked_at timestamptz,
  -- the fingerprint of the whole desired library at the last complete sync (a run with the same one and nothing open sends nothing)
  fingerprint text check (fingerprint is null or length(fingerprint) <= 64),
  -- the begin_time of the next read-back of Square's changes
  watermark timestamptz,
  last_write_at timestamptz,
  last_sync_at timestamptz,
  last_sync jsonb,
  last_drift_at timestamptz,
  last_drift jsonb,
  -- the read-only preview (observe-only): what the sync would create and change
  last_preview jsonb,
  last_preview_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 300),
  last_error_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default app_now(),
  updated_at timestamptz not null default app_now(),
  primary key (location_id, environment)
);
