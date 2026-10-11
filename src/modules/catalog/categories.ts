// The catalog's categories (ADR 0160, plan K): Wash, Add-ons, Tint, Detail, Quote by default, in the website's palette. Every
// service names one; every appointment keeps the categories it holds. Migration 20261011000000 seeded these rows for the locations
// that existed; ensureCatalogCategories gives a new location the same rows (idempotent, never overwrites an edited row). The services
// insert trigger (services_default_category) carries a copy of the first four, to add the one a new service needs when a location
// lacks it: test/ai-foundation/schema.test.ts holds the two together.
//
// Wave 2 (Settings → Catalog): the categories are edited here: label, colour, order and active; the key is immutable (services,
// appointments and leads refer to it). A new category gets a key of its own; a default category can be turned off but never
// deleted (the insert trigger would bring it back), and a category any service names cannot be deleted either.
import type { Executor, Tx } from '../../platform/db.js'
import * as audit from '../../platform/audit.js'
import { AppError } from '../../platform/errors.js'
import * as realtime from '../../platform/realtime.js'
import './problems.js'
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

export const BUILTIN_CATEGORY_KEYS: ReadonlySet<string> = new Set(DEFAULT_CATEGORIES.map((c) => c.key))

export const CATEGORY_KEY = /^[a-z][a-z0-9_]{0,31}$/
export const COLOUR = /^#[0-9A-Fa-f]{6}$/
/** At most this many categories per location (the dashboard shows them as chips). */
export const MAX_CATEGORIES = 20
/** The word visitCategory() counts a visit with two or more categories under: reserved, never a category's key. */
export const MIXED_CATEGORY = 'mixed'

/** Inserts any missing default category row for the location. */
export async function ensureCatalogCategories(db: Executor, locationId: string): Promise<void> {
  await db
    .insertInto('catalog_categories')
    .values(DEFAULT_CATEGORIES.map((c) => ({ location_id: locationId, key: c.key, label: c.label, colour: c.colour, sort: c.sort })))
    .onConflict((oc) => oc.columns(['location_id', 'key']).doNothing())
    .execute()
}

export interface Category {
  key: string
  label: string
  /** #RRGGBB (stored as typed; compare case-insensitively) */
  colour: string
  sort: number
  active: boolean
  /** A default category: it can be turned off, never deleted. */
  builtin: boolean
  version: number
}

const COLUMNS = ['key', 'label', 'colour', 'sort', 'active', 'version'] as const

const toCategory = (r: { key: string; label: string; colour: string; sort: number; active: boolean; version: number }): Category => ({
  key: r.key,
  label: r.label,
  colour: r.colour,
  sort: r.sort,
  active: r.active,
  builtin: BUILTIN_CATEGORY_KEYS.has(r.key),
  version: r.version,
})

/** In display order (sort, then key). */
export async function listCategories(db: Executor, locationId: string, o: { activeOnly?: boolean } = {}): Promise<Category[]> {
  let q = db.selectFrom('catalog_categories').select([...COLUMNS]).where('location_id', '=', locationId)
  if (o.activeOnly) q = q.where('active', '=', true)
  return (await q.orderBy('sort').orderBy('key').execute()).map(toCategory)
}

export async function getCategory(db: Executor, locationId: string, key: string): Promise<Category | undefined> {
  if (!CATEGORY_KEY.test(key)) return undefined
  const r = await db
    .selectFrom('catalog_categories')
    .select([...COLUMNS])
    .where('location_id', '=', locationId)
    .where('key', '=', key)
    .executeTakeFirst()
  return r ? toCategory(r) : undefined
}

const invalid = (path: string, message: string): AppError =>
  new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path, message }] })

/** A category of the location (422 on `path` otherwise); `active` also refuses one that is turned off. */
export async function requireCategory(
  db: Executor,
  locationId: string,
  key: string,
  o: { active?: boolean; path?: string } = {},
): Promise<Category> {
  const c = await getCategory(db, locationId, key)
  if (!c || (o.active && !c.active)) throw invalid(o.path ?? 'category', 'Pick one of the catalog’s categories.')
  return c
}

export interface CategoryInput {
  label?: string
  colour?: string
  sort?: number
  active?: boolean
}

function checkInput(i: CategoryInput): void {
  if (i.label !== undefined && (i.label.trim() === '' || i.label.trim().length > 40))
    throw invalid('label', 'Enter a name of up to 40 characters.')
  if (i.colour !== undefined && !COLOUR.test(i.colour)) throw invalid('colour', 'Use a colour like #1FB6FF.')
  if (i.sort !== undefined && (!Number.isInteger(i.sort) || i.sort < -100_000 || i.sort > 100_000))
    throw invalid('sort', 'Enter an order from -100000 to 100000.')
}

const auditOf = (c: Category) => ({ label: c.label, colour: c.colour, sort: c.sort, active: c.active })

async function publish(tx: Tx, locationId: string, key: string): Promise<void> {
  await realtime.publish(tx, {
    locationId,
    channel: 'settings',
    type: 'settings.changed',
    payload: { section: 'catalog', key: 'categories', category: key },
  })
}

export async function createCategory(
  tx: Tx,
  input: { locationId: string; key: string; label: string; colour: string; sort?: number; active?: boolean; audit?: audit.AuditContext },
): Promise<Category> {
  if (!CATEGORY_KEY.test(input.key))
    throw invalid('key', 'Use a lowercase key: a letter, then letters, digits or underscores (up to 32).')
  if (input.key === MIXED_CATEGORY)
    throw invalid('key', 'The key "mixed" is reserved: it is what a visit with two categories is counted under.')
  checkInput(input)
  const count = await tx
    .selectFrom('catalog_categories')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('location_id', '=', input.locationId)
    .executeTakeFirstOrThrow()
  if (Number(count.n) >= MAX_CATEGORIES) throw new AppError('CATEGORY_LIMIT', { meta: { max: MAX_CATEGORIES } })
  const inserted = await tx
    .insertInto('catalog_categories')
    .values({
      location_id: input.locationId,
      key: input.key,
      label: input.label.trim(),
      colour: input.colour.toUpperCase(),
      sort: input.sort ?? (await nextSort(tx, input.locationId)),
      active: input.active ?? true,
    })
    .onConflict((oc) => oc.columns(['location_id', 'key']).doNothing())
    .returning([...COLUMNS])
    .executeTakeFirst()
  if (!inserted) throw new AppError('CATEGORY_KEY_TAKEN', { meta: { key: input.key } })
  const c = toCategory(inserted)
  await audit.record(tx, {
    locationId: input.locationId,
    action: 'catalog.category.create',
    entityType: 'catalog_category',
    entityId: c.key,
    after: auditOf(c),
    ctx: input.audit,
  })
  await publish(tx, input.locationId, c.key)
  return c
}

async function nextSort(tx: Tx, locationId: string): Promise<number> {
  const r = await tx
    .selectFrom('catalog_categories')
    .select((eb) => eb.fn.max('sort').as('max'))
    .where('location_id', '=', locationId)
    .executeTakeFirst()
  return Math.min(100_000, (r?.max ?? 0) + 10)
}

async function lockCategory(tx: Tx, locationId: string, key: string, expectedVersion?: number): Promise<Category> {
  const r = CATEGORY_KEY.test(key)
    ? await tx
        .selectFrom('catalog_categories')
        .select([...COLUMNS])
        .where('location_id', '=', locationId)
        .where('key', '=', key)
        .forUpdate()
        .executeTakeFirst()
    : undefined
  if (!r) throw new AppError('NOT_FOUND', { detail: 'That category does not exist' })
  if (expectedVersion !== undefined && expectedVersion !== r.version)
    throw new AppError('VERSION_CONFLICT', { meta: { currentVersion: r.version } })
  return toCategory(r)
}

/** Label, colour, order and active in one version-checked update; the key never changes. */
export async function updateCategory(
  tx: Tx,
  input: { locationId: string; key: string; patch: CategoryInput; expectedVersion?: number; audit?: audit.AuditContext },
): Promise<{ category: Category; changed: boolean }> {
  const before = await lockCategory(tx, input.locationId, input.key, input.expectedVersion)
  const p = input.patch
  checkInput(p)
  const next = {
    label: p.label === undefined ? before.label : p.label.trim(),
    colour: p.colour === undefined ? before.colour : p.colour.toUpperCase(),
    sort: p.sort ?? before.sort,
    active: p.active ?? before.active,
  }
  if (
    next.label === before.label &&
    next.colour.toUpperCase() === before.colour.toUpperCase() &&
    next.sort === before.sort &&
    next.active === before.active
  )
    return { category: before, changed: false }
  const row = await tx
    .updateTable('catalog_categories')
    .set((eb) => ({ ...next, version: eb('version', '+', 1), updated_at: eb.fn('app_now', []) }))
    .where('location_id', '=', input.locationId)
    .where('key', '=', input.key)
    .returning([...COLUMNS])
    .executeTakeFirstOrThrow()
  const after = toCategory(row)
  await audit.record(tx, {
    locationId: input.locationId,
    action: 'catalog.category.update',
    entityType: 'catalog_category',
    entityId: after.key,
    before: auditOf(before),
    after: auditOf(after),
    ctx: input.audit,
  })
  await publish(tx, input.locationId, after.key)
  return { category: after, changed: true }
}

/** Deletes a category nobody uses: never a default one (turn it off instead), never one a service names (move the services first). */
export async function deleteCategory(
  tx: Tx,
  input: { locationId: string; key: string; expectedVersion?: number; audit?: audit.AuditContext },
): Promise<Category> {
  const c = await lockCategory(tx, input.locationId, input.key, input.expectedVersion)
  if (c.builtin) throw new AppError('CATEGORY_BUILTIN', { meta: { key: c.key } })
  const used = await tx
    .selectFrom('services')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('location_id', '=', input.locationId)
    .where('category', '=', c.key)
    .executeTakeFirstOrThrow()
  if (Number(used.n) > 0) throw new AppError('CATEGORY_IN_USE', { meta: { key: c.key, services: Number(used.n) } })
  await tx.deleteFrom('catalog_categories').where('location_id', '=', input.locationId).where('key', '=', c.key).execute()
  await audit.record(tx, {
    locationId: input.locationId,
    action: 'catalog.category.delete',
    entityType: 'catalog_category',
    entityId: c.key,
    before: auditOf(c),
    ctx: input.audit,
  })
  await publish(tx, input.locationId, c.key)
  return c
}
