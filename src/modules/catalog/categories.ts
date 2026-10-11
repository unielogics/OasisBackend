// The catalog's categories (ADR 0160, plan K): Wash, Add-ons, Tint, Detail, Quote by default, in the website's palette. Every
// service names one; every appointment keeps the categories it holds. Migration 20261011000000 seeded these rows for the locations
// that existed; ensureCatalogCategories gives a new location the same rows (idempotent, never overwrites an edited row). The services
// insert trigger (services_default_category) carries a copy of the first four, to add the one a new service needs when a location
// lacks it: test/ai-foundation/schema.test.ts holds the two together.
import type { Executor } from '../../platform/db.js'
import './schema.js'

export interface CategoryDefault {
  key: string
  label: string
  colour: string
  sort: number
}

export const DEFAULT_CATEGORIES: readonly CategoryDefault[] = [
  { key: 'wash', label: 'Wash', colour: '#1FB6FF', sort: 10 },
  { key: 'addons', label: 'Add-ons', colour: '#7FD6FF', sort: 20 },
  { key: 'tint', label: 'Tint', colour: '#2EE59D', sort: 30 },
  { key: 'detail', label: 'Detail', colour: '#FFB547', sort: 40 },
  { key: 'quote', label: 'Quote', colour: '#8C97A1', sort: 50 },
]

/** Inserts any missing default category row for the location. */
export async function ensureCatalogCategories(db: Executor, locationId: string): Promise<void> {
  await db
    .insertInto('catalog_categories')
    .values(DEFAULT_CATEGORIES.map((c) => ({ location_id: locationId, key: c.key, label: c.label, colour: c.colour, sort: c.sort })))
    .onConflict((oc) => oc.columns(['location_id', 'key']).doNothing())
    .execute()
}
