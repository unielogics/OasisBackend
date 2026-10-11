// A service's website fields (ADR 0160, plan A): what the website, the assistant and the booking flows show for a package or an
// add-on: its category, public name and description, member and guest prices, what VIP members get, quote-only, whether it is
// listed online, and its order. Saved as one version-checked replace (PUT /catalog/services/{id}); a category change re-derives
// the categories of the visits not yet finished that hold the service.
import type { Tx } from '../../platform/db.js'
import * as audit from '../../platform/audit.js'
import { AppError } from '../../platform/errors.js'
import { refreshCategoriesForService } from './appointment-categories.js'
import { requireCategory } from './categories.js'
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
      member_price_cents: next.memberPriceCents,
      guest_price_cents: next.guestPriceCents,
      vip_inclusion: next.vipInclusion,
      vip_note: next.vipNote,
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
    before: { ...prev },
    after: { ...websiteFieldsOf(after), ...(appointmentsUpdated > 0 ? { appointmentsUpdated } : {}) },
    ctx: input.audit,
  })
  await publishServiceChange(tx, input.locationId, row.id)
  return { service: after, changed: true, appointmentsUpdated }
}
