// Kysely types of the Square item library sync (db/migrations/20261015200000_square_items.sql, ADR 0172), registered by module
// augmentation: the links (the only Square ids Oasis writes, per environment) and the per-location state of the sync.
import type { ColumnType, Generated } from 'kysely'
import type { JsonValue } from '../../../platform/schema.js'

export type SquareEnvironmentName = 'sim' | 'sandbox' | 'production'
export type CatalogLinkKind = 'item' | 'variation' | 'category' | 'tax'
/**
 * pending: waiting for Square (new or changed); synced: Square has what Oasis wants; failed: the last try failed (error says why; the
 * next run tries again); archived: an item Oasis archived (service off, quote-only or unpriced); hidden: a variation of a size that is
 * off (present nowhere, same id when it comes back); gone: a category Oasis no longer uses (left in Square, reported once).
 */
export type CatalogLinkState = 'pending' | 'synced' | 'failed' | 'archived' | 'hidden' | 'gone'
export type ItemsTaxMode = 'auto' | 'adopt' | 'create'

type Json = ColumnType<JsonValue | null, string | null, string | null>

export interface SquareCatalogLinksTable {
  id: string
  location_id: string
  environment: SquareEnvironmentName
  kind: CatalogLinkKind
  service_id: string | null
  class_key: string | null
  category_key: string | null
  square_object_id: string | null
  square_item_id: string | null
  /** bigint: read as a string by pg; the code converts. */
  square_version: ColumnType<string | null, string | number | null, string | number | null>
  desired_hash: string | null
  content_hash: string | null
  state: Generated<CatalogLinkState>
  adopted: Generated<boolean>
  error: string | null
  pending_key: string | null
  /** The exact request body as JSON text (key order kept). */
  pending_body: string | null
  pending_at: Date | null
  synced_at: Date | null
  checked_at: Date | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface SquareItemsStateTable {
  location_id: string
  environment: SquareEnvironmentName
  tax_mode: Generated<ItemsTaxMode>
  tax_object_id: string | null
  tax_check: Json
  tax_checked_at: Date | null
  fingerprint: string | null
  watermark: Date | null
  last_write_at: Date | null
  last_sync_at: Date | null
  last_sync: Json
  last_drift_at: Date | null
  last_drift: Json
  last_preview: Json
  last_preview_at: Date | null
  last_error: string | null
  last_error_at: Date | null
  version: Generated<number>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

declare module '../../../platform/schema.js' {
  interface Database {
    square_catalog_links: SquareCatalogLinksTable
    square_items_state: SquareItemsStateTable
  }
}
