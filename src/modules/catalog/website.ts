// A service's website fields (ADR 0160, plan A): what the website, the assistant and the booking flows show for a package or an
// add-on: its category, public name and description, member and guest prices, what VIP members get, quote-only, whether it is
// listed online, and its order. Saved as one version-checked replace (PUT /catalog/services/{id}); a category change re-derives
// the categories of the visits not yet finished that hold the service.
//
// What a booking charges (price_cents) follows the website prices: for an item priced on the website it is the guest price
// (pricing.ts bookingPriceOf), set by the same save, and re-set for every such item when the guest markup or the tint matrix is
// saved (syncBookingPrices). So the public catalog's starting prices (design §3b) and a booking never disagree.
import type { Tx } from '../../platform/db.js'
import * as audit from '../../platform/audit.js'
import { AppError } from '../../platform/errors.js'
import { getSetting } from '../../platform/settings.js'
import { refreshCategoriesForService } from './appointment-categories.js'
import { requireCategory } from './categories.js'
import { bookingPriceOf, type TintMatrix } from './pricing.js'
import type { VipInclusion } from './schema.js'
import { lockService, publishServiceChange, requireService, type CatalogService } from './service.js'

export interface WebsiteFields {
  category: string
  publicName: string | null
  description: string | null
  memberPriceCents: number | null
  guestPriceCents: number | null
  vipInclusion: VipInclusion
  vipNote: string | null
  quoteOnly: boolean
  visibleOnline: boolean
  sort: number
}

export const websiteFieldsOf = (s: CatalogService): WebsiteFields => ({
  category: s.category,
  publicName: s.publicName,
  description: s.description,
  memberPriceCents: s.memberPriceCents,
  guestPriceCents: s.guestPriceCents,
  vipInclusion: s.vipInclusion,
  vipNote: s.vipNote,
  quoteOnly: s.quoteOnly,
  visibleOnline: s.visibleOnline,
  sort: s.sort,
})

const MAX_CENTS = 10_000_000

const invalid = (path: string, message: string): AppError =>
  new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path, message }] })

const text = (s: string | null): string | null => {
  const t = s?.trim()
  return t ? t : null
}

/** Trims the texts (blank = none) and checks every rule but the category's existence; throws 422 on the first broken rule. */
export function normalizeWebsiteFields(f: WebsiteFields): WebsiteFields {
  const out: WebsiteFields = { ...f, publicName: text(f.publicName), description: text(f.description), vipNote: text(f.vipNote) }
  if (out.publicName !== null && out.publicName.length > 80) throw invalid('publicName', 'The public name can be at most 80 characters.')
  if (out.description !== null && out.description.length > 1000)
    throw invalid('description', 'The description can be at most 1000 characters.')
  for (const k of ['memberPriceCents', 'guestPriceCents'] as const) {
    const v = out[k]
    if (v !== null && (!Number.isSafeInteger(v) || v < 0 || v > MAX_CENTS))
      throw invalid(k, 'Enter a price in whole cents, from 0 to $100,000.')
  }
  // a guest price is checked against (and only makes sense next to) a member price: without one the member price would be the
  // plain price, which follows the guest price (bookingPriceOf)
  if (out.guestPriceCents !== null && out.memberPriceCents === null)
    throw invalid('guestPriceCents', 'Set the member price first: the guest price cannot be below it.')
  if (out.memberPriceCents !== null && out.guestPriceCents !== null && out.guestPriceCents < out.memberPriceCents)
    throw invalid('guestPriceCents', 'The guest price cannot be below the member price.')
  if (out.vipNote !== null && out.vipNote.length > 200) throw invalid('vipNote', 'The VIP note can be at most 200 characters.')
  if (out.vipInclusion === 'allowance' && out.vipNote === null)
    throw invalid('vipNote', 'Say how much VIP members get, for example "2× / mo".')
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

interface Pricing {
  markupPct: number
  tint: TintMatrix
}

async function pricingOf(tx: Tx, locationId: string): Promise<Pricing> {
  const markup = await getSetting(tx, locationId, 'catalog.guest_markup_pct')
  const tint = await getSetting(tx, locationId, 'catalog.tint_matrix')
  return { markupPct: markup.value, tint: tint.value }
}

export async function putWebsiteFields(tx: Tx, input: PutWebsiteFieldsInput): Promise<PutWebsiteFieldsResult> {
  const row = await lockService(tx, input.locationId, input.serviceId, input.expectedVersion)
  const next = normalizeWebsiteFields(input.fields)
  const before = await requireService(tx, input.locationId, row.id)
  const prev = websiteFieldsOf(before)
  const price =
    bookingPriceOf({ ...before, ...next, priceCents: before.priceCents }, await pricingOf(tx, input.locationId)) ?? before.priceCents
  if (same(prev, next) && price === before.priceCents) return { service: before, changed: false, appointmentsUpdated: 0 }
  // a category that is turned off may stay on the services that already have it, but nothing moves into it
  if (next.category !== prev.category) await requireCategory(tx, input.locationId, next.category, { active: true })
  await tx
    .updateTable('services')
    .set((eb) => ({
      category: next.category,
      public_name: next.publicName,
      description: next.description,
      member_price_cents: next.memberPriceCents,
      guest_price_cents: next.guestPriceCents,
      vip_inclusion: next.vipInclusion,
      vip_note: next.vipNote,
      quote_only: next.quoteOnly,
      visible_online: next.visibleOnline,
      sort: next.sort,
      price_cents: price,
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
    before: { ...prev, ...(price !== before.priceCents ? { priceCents: before.priceCents } : {}) },
    after: {
      ...websiteFieldsOf(after),
      ...(price !== before.priceCents ? { priceCents: price } : {}),
      ...(appointmentsUpdated > 0 ? { appointmentsUpdated } : {}),
    },
    ctx: input.audit,
  })
  await publishServiceChange(tx, input.locationId, row.id)
  return { service: after, changed: true, appointmentsUpdated }
}

/**
 * Re-sets what a booking charges for every item priced on the website after the guest markup or the tint matrix changed (`reason`
 * names the setting). Rows already right are not written; each moved row is versioned, audited (catalog.price.sync) and published.
 * Returns the ids of the moved rows.
 */
export async function syncBookingPrices(
  tx: Tx,
  input: { locationId: string; reason: 'catalog.guest_markup_pct' | 'catalog.tint_matrix'; audit?: audit.AuditContext },
): Promise<string[]> {
  const pricing = await pricingOf(tx, input.locationId)
  const rows = await tx
    .selectFrom('services')
    .select(['id', 'price_cents', 'member_price_cents', 'guest_price_cents', 'category', 'tags', 'quote_only'])
    .where('location_id', '=', input.locationId)
    .orderBy('id')
    .forUpdate()
    .execute()
  const moved: string[] = []
  for (const r of rows) {
    const price = bookingPriceOf(
      {
        priceCents: r.price_cents,
        memberPriceCents: r.member_price_cents,
        guestPriceCents: r.guest_price_cents,
        category: r.category,
        tags: r.tags,
        quoteOnly: r.quote_only,
      },
      pricing,
    )
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
