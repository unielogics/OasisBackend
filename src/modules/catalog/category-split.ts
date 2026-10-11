// Visits split by category (ADR 0160, plan K): the per-category counts of the Operations KPI strip and the Payments summary's split.
// Each visit counts once, under visitCategory() of its categories: its category ignoring add-ons, "mixed" for two or more, the
// add-ons category for add-ons alone. The entries come in the categories' order: every active category (zero included, so the
// dashboard shows a stable row), then "mixed"; an inactive or unknown category (a finished visit keeps what it held) and "none"
// ("_none": a visit holding nothing) only when something counts under them.
import type { Executor } from '../../platform/db.js'
import { visitCategory } from './appointment-categories.js'
import { MIXED_CATEGORY } from './categories.js'
import './schema.js'

/** The key a visit holding no category counts under in a split (never a category key: those start with a letter). */
export const NO_CATEGORY = '_none'

export interface CategoryRef {
  key: string
  label: string
  colour: string
  sort: number
  active: boolean
}

export interface CategoryCount {
  key: string
  label: string
  /** #RRGGBB of the category; null for "mixed", "none" and an unknown key (the dashboard's neutral). */
  colour: string | null
  count: number
}

export async function loadCategoryRefs(db: Executor, locationId: string): Promise<CategoryRef[]> {
  return db
    .selectFrom('catalog_categories')
    .select(['key', 'label', 'colour', 'sort', 'active'])
    .where('location_id', '=', locationId)
    .orderBy('sort')
    .orderBy('key')
    .execute()
}

/**
 * Counts the items by visit category, summing the named amounts (cents) per entry; see the file header for the entries' order.
 */
export function splitByCategory<T, K extends string = never>(
  items: readonly T[],
  categoriesOf: (item: T) => readonly string[],
  refs: readonly CategoryRef[],
  amounts: { [P in K]: (item: T) => number } = {} as { [P in K]: (item: T) => number },
): (CategoryCount & Record<K, number>)[] {
  const keys = Object.keys(amounts) as K[]
  const zero = (): Record<K, number> => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>
  const tally = new Map<string, { count: number; sums: Record<K, number> }>()
  for (const item of items) {
    const word = visitCategory(categoriesOf(item)) ?? NO_CATEGORY
    let t = tally.get(word)
    if (!t) tally.set(word, (t = { count: 0, sums: zero() }))
    t.count++
    for (const k of keys) t.sums[k] += amounts[k](item)
  }
  const entry = (key: string, label: string, colour: string | null): CategoryCount & Record<K, number> => {
    const t = tally.get(key)
    tally.delete(key)
    return { key, label, colour, count: t?.count ?? 0, ...(t?.sums ?? zero()) } as CategoryCount & Record<K, number>
  }
  const out: (CategoryCount & Record<K, number>)[] = []
  for (const r of refs) if (r.active || tally.has(r.key)) out.push(entry(r.key, r.label, r.colour))
  out.push(entry(MIXED_CATEGORY, 'Mixed', null))
  const none = tally.has(NO_CATEGORY) ? entry(NO_CATEGORY, 'No category', null) : null
  for (const key of [...tally.keys()].sort()) out.push(entry(key, key, null))
  if (none) out.push(none)
  return out
}
