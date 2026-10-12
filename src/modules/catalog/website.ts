// A service's website fields (ADR 0160, plan A; ADR 0170): what the website, the assistant and the booking flows show for a package
// or an add-on: its category, public name and description, quote-only, whether it is listed online, and its order. Saved as one
// version-checked replace (PUT /catalog/services/{id}); a category change re-derives the categories of the visits not yet finished
// that hold the service. Prices are not website fields any more: a service has one regular price per vehicle size (Settings →
// Prices by size, class-prices.ts), what a member pays follows from the tier's % off, and what VIP members get is the VIP tier's
// inclusions. The member/guest price and VIP columns stay, read only, until a later release drops them.
//
// services.price_cents (what a booking charged before sizes, and the base price of a service without size prices) follows the
// starting price: syncBookingPrices keeps it equal to the lowest price over the active sizes whenever the sizes change.
import type { Tx } from '../../platform/db.js'
import * as audit from '../../platform/audit.js'
import { AppError } from '../../platform/errors.js'
import { refreshCategoriesForService } from './appointment-categories.js'
import { requireCategory } from './categories.js'
import { startingPrice } from './class-prices.js'
import { lockService, publishServiceChange, requireService, type CatalogService } from './service.js'

export interface WebsiteFields {
  category: string
  publicName: string | null
  description: string | null
  quoteOnly: boolean
  visibleOnline: boolean
  sort: number
}

export const websiteFieldsOf = (s: CatalogService): WebsiteFields => ({
  category: s.category,
  publicName: s.publicName,
  description: s.description,
  quoteOnly: s.quoteOnly,
  visibleOnline: s.visibleOnline,
  sort: s.sort,
})

const invalid = (path: string, message: string): AppError =>
  new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path, message }] })

const text = (s: string | null): string | null => {
  const t = s?.trim()
  return t ? t : null
}

/** Trims the texts (blank = none) and checks every rule but the category's existence; throws 422 on the first broken rule. */
export function normalizeWebsiteFields(f: WebsiteFields): WebsiteFields {
  const out: WebsiteFields = { ...f, publicName: text(f.publicName), description: text(f.description) }
  if (out.publicName !== null && out.publicName.length > 80) throw invalid('publicName', 'The public name can be at most 80 characters.')
  if (out.description !== null && out.description.length > 1000)
    throw invalid('description', 'The description can be at most 1000 characters.')
  if (!Number.isInteger(out.sort) || out.sort < -100_000 || out.sort > 100_000)
    throw invalid('sort', 'Enter an order from -100000 to 100000.')
  return out
}

const same = (a: WebsiteFields, b: WebsiteFields): boolean =>
  (Object.keys(a) as (keyof WebsiteFields)[]).every((k) => a[k] === b[k])

export interface PutWebsiteFieldsInput {
  locationId: string
  serviceId: string
  fields: WebsiteFields
  expectedVersion?: number
  audit?: audit.AuditContext
}

export interface PutWebsiteFieldsResult {
  service: CatalogService
  changed: boolean
  /** Open visits whose categories were re-derived (a category change). */
  appointmentsUpdated: number
}

export async function putWebsiteFields(tx: Tx, input: PutWebsiteFieldsInput): Promise<PutWebsiteFieldsResult> {
  const row = await lockService(tx, input.locationId, input.serviceId, input.expectedVersion)
  const next = normalizeWebsiteFields(input.fields)
  const before = await requireService(tx, input.locationId, row.id)
  const prev = websiteFieldsOf(before)
  if (same(prev, next)) return { service: before, changed: false, appointmentsUpdated: 0 }
  // a category that is turned off may stay on the services that already have it, but nothing moves into it
  if (next.category !== prev.category) await requireCategory(tx, input.locationId, next.category, { active: true })
  await tx
    .updateTable('services')
    .set((eb) => ({
      category: next.category,
      public_name: next.publicName,
      description: next.description,
      quote_only: next.quoteOnly,
      visible_online: next.visibleOnline,
      sort: next.sort,
      version: eb('version', '+', 1),
      updated_at: eb.fn('app_now', []),
    }))
    .where('id', '=', row.id)
    .execute()
  const after = await requireService(tx, input.locationId, row.id)
  const appointmentsUpdated =
    next.category !== prev.category ? await refreshCategoriesForService(tx, input.locationId, row.id) : 0
  await audit.record(tx, {
    locationId: input.locationId,
    action: 'catalog.website.update',
    entityType: 'service',
    entityId: row.id,
    before: prev,
    after: { ...websiteFieldsOf(after), ...(appointmentsUpdated > 0 ? { appointmentsUpdated } : {}) },
    ctx: input.audit,
  })
  await publishServiceChange(tx, input.locationId, row.id)
  return { service: after, changed: true, appointmentsUpdated }
}

/**
 * Keeps services.price_cents equal to the starting price (the lowest price over the active sizes) of every service that has a price
 * on an active size, after the sizes changed (`reason`: a size turned on or off, or the grid). Quote-only services and services
 * without size prices keep theirs. Rows already right are not written; each moved row is versioned, audited (catalog.price.sync)
 * and published. Returns the ids of the moved rows.
 */
export async function syncBookingPrices(
  tx: Tx,
  input: { locationId: string; reason: 'catalog.prices' | 'catalog.vehicle_classes'; audit?: audit.AuditContext },
): Promise<string[]> {
  const rows = await tx
    .selectFrom('services')
    .select(['id', 'price_cents', 'quote_only'])
    .where('location_id', '=', input.locationId)
    .orderBy('id')
    .forUpdate()
    .execute()
  const moved: string[] = []
  for (const r of rows) {
    if (r.quote_only) continue
    const price = await startingPrice(tx, input.locationId, r.id)
    if (price === null || price === r.price_cents) continue
    await tx
      .updateTable('services')
      .set((eb) => ({ price_cents: price, version: eb('version', '+', 1), updated_at: eb.fn('app_now', []) }))
      .where('id', '=', r.id)
      .execute()
    await audit.record(tx, {
      locationId: input.locationId,
      action: 'catalog.price.sync',
      entityType: 'service',
      entityId: r.id,
      before: { priceCents: r.price_cents },
      after: { priceCents: price, reason: input.reason },
      ctx: input.audit,
    })
    await publishServiceChange(tx, input.locationId, r.id)
    moved.push(r.id)
  }
  return moved
}
