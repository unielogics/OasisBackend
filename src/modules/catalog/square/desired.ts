// What Oasis wants in Square's item library (ADR 0172), pure: one REGULAR item per service, one variation per vehicle size priced
// by the same rule Oasis charges by (classPrice: a size's own price, the starting price for a size without one, a range as Square's
// VARIABLE pricing named "Compact car · $229–$279"), or one "Regular" variation for a service priced without sizes. Services that are
// off, quote-only or have no price at all are wanted ARCHIVED (an item that was never made is not made); sizes that are off are
// wanted HIDDEN (present nowhere, the same id when the size comes back). Every item is in its Oasis category and in the fixed
// "Oasis" marker category; every Oasis variation carries the marker user_data "oasis:v1:<service id>:<size key or base>", so Oasis
// finds its own items again after a crash or a database restore. Member prices and coverage are never in Square.
import { createHash } from 'node:crypto'
import { classPrice, type PriceBook } from '../price-book.js'
import type { ServiceKind } from '../schema.js'

/** The key of the fixed marker category ("Oasis"): cannot clash with a category key (those start with a letter). */
export const OASIS_CATEGORY_KEY = '_oasis'
export const OASIS_CATEGORY_NAME = 'Oasis'
export const REGULAR_VARIATION_NAME = 'Regular'
export const MARKER_PREFIX = 'oasis:v1:'
/** Square's limits: item names 512 characters, variation and category names 255. */
const ITEM_NAME_MAX = 512
const NAME_MAX = 255

export const markerOf = (serviceId: string, classKey: string | null): string => `${MARKER_PREFIX}${serviceId}:${classKey ?? 'base'}`

/** The service and size a variation's user_data names, or null when it is not an Oasis marker. */
export function parseMarker(userData: string | null | undefined): { serviceId: string; classKey: string | null } | null {
  if (!userData?.startsWith(MARKER_PREFIX)) return null
  const m = /^oasis:v1:([0-9a-f-]{36}):(base|[a-z][a-z0-9_]{0,31})$/.exec(userData)
  if (!m) return null
  return { serviceId: m[1]!, classKey: m[2] === 'base' ? null : m[2]! }
}

export interface LibraryClass {
  key: string
  label: string
  sort: number
  active: boolean
}

export interface LibraryService {
  id: string
  kind: ServiceKind
  name: string
  publicName: string | null
  sort: number
  category: string
  active: boolean
  quoteOnly: boolean
  priceCents: number
}

export interface LibraryCategory {
  key: string
  label: string
  sort: number
}

export interface LibraryInput {
  /** Every size, turned-off ones included. */
  classes: readonly LibraryClass[]
  services: readonly LibraryService[]
  categories: readonly LibraryCategory[]
  /** The price book (loadPriceBook): its classes are the active sizes. */
  book: PriceBook
}

export type DesiredPricing = { type: 'FIXED'; cents: number } | { type: 'VARIABLE'; cents: number; maxCents: number }

export interface DesiredVariation {
  /** null = the "Regular" variation of a service without prices by size. */
  classKey: string | null
  name: string
  pricing: DesiredPricing
  /** false = hidden (present nowhere): a size that is off, or the other kind of variation of the service. */
  present: boolean
  marker: string
}

/** Why an item is archived (null: it is sold). */
export type ArchiveReason = 'off' | 'quote_only' | 'unpriced'

export interface DesiredItem {
  serviceId: string
  kind: ServiceKind
  name: string
  buyerFacingName: string | null
  categoryKey: string
  archived: boolean
  archiveReason: ArchiveReason | null
  /** The present variations in size order, then the hidden ones. */
  variations: DesiredVariation[]
  /** Dense rank by (kind, sort, name): the order the planner sends new items in. */
  rank: number
}

export interface DesiredCategory {
  key: string
  name: string
}

export interface DesiredLibrary {
  /** One per service (sold or archived). */
  items: DesiredItem[]
  /** The categories of the sold items, then the marker category (absent when nothing is sold). */
  categories: DesiredCategory[]
}

const dollars = (cents: number): string => (cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`)

/** "Compact car · $229–$279" for a range, else the size's label. */
export function variationName(label: string, pricing: DesiredPricing): string {
  const name = pricing.type === 'VARIABLE' ? `${label} · ${dollars(pricing.cents)}–${dollars(pricing.maxCents)}` : label
  return name.slice(0, NAME_MAX)
}

const pricingOf = (cents: number, maxCents: number | null): DesiredPricing =>
  maxCents !== null && maxCents > cents ? { type: 'VARIABLE', cents, maxCents } : { type: 'FIXED', cents }

/** Oasis prices the service by vehicle size (at least one active size has a price). */
const pricedBySize = (book: PriceBook, serviceId: string): boolean => {
  const cells = book.cells.get(serviceId)
  return !!cells && book.classes.some((c) => cells.has(c.key))
}

export function desiredLibrary(input: LibraryInput): DesiredLibrary {
  const classes = [...input.classes].sort((a, b) => a.sort - b.sort || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const categoryLabel = new Map(input.categories.map((c) => [c.key, c.label]))
  const ordered = [...input.services].sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === 'package' ? -1 : 1) || a.sort - b.sort || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1),
  )
  const items: DesiredItem[] = ordered.map((s, rank) => {
    const sized = pricedBySize(input.book, s.id)
    const unpriced = !sized && s.priceCents <= 0
    const archiveReason: ArchiveReason | null = !s.active ? 'off' : s.quoteOnly ? 'quote_only' : unpriced ? 'unpriced' : null
    const variations: DesiredVariation[] = []
    const regularPricing: DesiredPricing = { type: 'FIXED', cents: Math.max(0, s.priceCents) }
    const regular: DesiredVariation = {
      classKey: null,
      name: REGULAR_VARIATION_NAME,
      pricing: regularPricing,
      present: !sized,
      marker: markerOf(s.id, null),
    }
    const sizeVariations = classes.map((c): DesiredVariation => {
      // an active size: the price Oasis charges at it; a size that is off: its own cell, else the starting price (hidden anyway)
      const own = input.book.cells.get(s.id)?.get(c.key)
      const p = c.active || !own ? classPrice(input.book, s.id, c.active ? c.key : null) : { cents: own.cents, maxCents: own.maxCents }
      const pricing = sized ? pricingOf(p.cents, p.maxCents) : regularPricing
      return { classKey: c.key, name: variationName(c.label, pricing), pricing, present: sized && c.active, marker: markerOf(s.id, c.key) }
    })
    variations.push(...sizeVariations.filter((v) => v.present))
    if (regular.present) variations.push(regular)
    variations.push(...sizeVariations.filter((v) => !v.present))
    if (!regular.present) variations.push(regular)
    return {
      serviceId: s.id,
      kind: s.kind,
      name: s.name.slice(0, ITEM_NAME_MAX),
      buyerFacingName: s.publicName?.trim() ? s.publicName.trim().slice(0, ITEM_NAME_MAX) : null,
      categoryKey: s.category,
      archived: archiveReason !== null,
      archiveReason,
      variations,
      rank,
    }
  })
  const used = [...new Set(items.filter((i) => !i.archived).map((i) => i.categoryKey))]
  const sortOf = new Map(input.categories.map((c) => [c.key, c.sort]))
  used.sort((a, b) => (sortOf.get(a) ?? 999) - (sortOf.get(b) ?? 999) || (a < b ? -1 : 1))
  const categories: DesiredCategory[] = used.map((key) => ({ key, name: (categoryLabel.get(key) ?? key).slice(0, NAME_MAX) }))
  if (categories.length) categories.push({ key: OASIS_CATEGORY_KEY, name: OASIS_CATEGORY_NAME })
  return { items, categories }
}

/** A stable short hash of a JSON value (keys sorted). */
export function hashOf(v: unknown): string {
  return createHash('sha256').update(stableJson(v)).digest('hex').slice(0, 32)
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${stableJson(x)}`)
      .join(',')}}`
  return JSON.stringify(v ?? null)
}

/** The Square ids an item's owned fields point at: its tax and its categories. */
export interface ItemRefs {
  taxId: string | null
  categoryId: string | null
  oasisCategoryId: string | null
}

/**
 * The hash of every field Oasis owns on an item (with the ids it points at): what Square must hold. A link whose content_hash is this
 * hash is in step; anything else is sent.
 */
export function itemHash(item: DesiredItem, refs: ItemRefs): string {
  return hashOf({
    name: item.name,
    buyerFacingName: item.buyerFacingName,
    archived: item.archived,
    refs,
    variations: item.variations.map((v) => ({ classKey: v.classKey, name: v.name, pricing: v.pricing, present: v.present })),
  })
}

/** The fingerprint of the whole library as it would be sent (the fast path compares it with the last complete sync's). */
export function libraryFingerprint(lib: DesiredLibrary, refsOf: (item: DesiredItem) => ItemRefs, extra: unknown): string {
  return hashOf({ items: lib.items.map((i) => [i.serviceId, itemHash(i, refsOf(i))]), categories: lib.categories, extra })
}
