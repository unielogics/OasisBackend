// GET /public/catalog: the one catalog the website and the assistant read (ADR 0160, plan A; ADR 0150 before it). Everything comes
// from Settings: the active categories with their colours, the packages and add-ons listed online (category active, not quote-only)
// with member and guest prices and what VIP members get, the quote-only items, the tint price matrix, the guest markup and booking
// fee, and the two plans the website sells with their monthly price and perks. Keys are the slug of the service name over every
// active package (or add-on), exactly as the availability and booking routes key them, so a key read here is a key they accept.
// Nothing internal: no ids, versions, checklists, Squarespace SKUs or checkout URLs, desk flags or inactive rows.
import { z } from '../../http/zod.js'
import type { Executor } from '../../platform/db.js'
import { getSetting } from '../../platform/settings.js'
import { listCategories } from '../catalog/categories.js'
import { listPlanPublic } from '../catalog/plans.js'
import { effectivePrices } from '../catalog/pricing.js'
import type { CatalogService } from '../catalog/service.js'
import { loadBoardServices } from './availability-loader.js'
import { PUBLIC_TIERS } from './tiers.js'

const Cents = z.number().int()
const VipInclusion = z.enum(['included', 'allowance', 'none'])

const ItemFields = {
  key: z.string(),
  /** The public name (the service's public name, else its name). */
  name: z.string(),
  category: z.string(),
  description: z.string().nullable(),
  /** What a booking charges today (the plain price). */
  priceCents: Cents,
  memberPriceCents: Cents,
  guestPriceCents: Cents,
  vipInclusion: VipInclusion,
  vipNote: z.string().nullable(),
  tags: z.array(z.string()),
}

export const PublicCatalogView = z.object({
  generatedAt: z.iso.datetime(),
  currency: z.literal('USD'),
  guestMarkupPct: z.number().int(),
  guestBookingFeeCents: Cents,
  categories: z.array(z.object({ key: z.string(), label: z.string(), colour: z.string(), sort: z.number().int() })),
  services: z.array(
    z.object({
      ...ItemFields,
      shortName: z.string(),
      durationMin: z.number().int(),
      /** The tint film whose matrix row prices this package ("from" prices), or null. */
      tintFilm: z.string().nullable(),
    }),
  ),
  addons: z.array(z.object(ItemFields)),
  quotes: z.array(
    z.object({ key: z.string(), name: z.string(), kind: z.enum(['package', 'addon']), category: z.string(), description: z.string().nullable() }),
  ),
  tint: z.object({
    vehicleTypes: z.array(z.object({ key: z.string(), label: z.string() })),
    films: z.array(z.object({ key: z.string(), label: z.string(), vlt: z.array(z.number().int()) })),
    prices: z.array(
      z.object({
        vehicle: z.string(),
        film: z.string(),
        memberMinCents: Cents,
        memberMaxCents: Cents,
        guestMinCents: Cents,
        guestMaxCents: Cents,
      }),
    ),
  }),
  plans: z.array(
    z.object({
      key: z.enum(['gold', 'vip']),
      name: z.string(),
      planKey: z.string(),
      /** The dashboard plan's name, when the plans are set up. */
      planName: z.string().nullable(),
      perks: z.array(z.string()),
      /** The monthly price, when Settings has one. */
      priceCents: Cents.nullable(),
    }),
  ),
})

export type PublicCatalog = z.infer<typeof PublicCatalogView>

const publicName = (s: CatalogService): string => s.publicName ?? s.name

export async function loadPublicCatalog(db: Executor, locationId: string, now: Date): Promise<PublicCatalog> {
  const [services, plans, categories, markup, tint, fee] = await Promise.all([
    loadBoardServices(db, locationId),
    listPlanPublic(db, locationId),
    listCategories(db, locationId, { activeOnly: true }),
    getSetting(db, locationId, 'catalog.guest_markup_pct'),
    getSetting(db, locationId, 'catalog.tint_matrix'),
    getSetting(db, locationId, 'booking.guest_fee'),
  ])
  const live = new Set(categories.map((c) => c.key))
  const listed = (s: CatalogService): boolean => s.visibleOnline && live.has(s.category)
  const pricing = { markupPct: markup.value, tint: tint.value }
  const item = (s: CatalogService & { key: string }) => {
    const p = effectivePrices(s, pricing)
    return {
      key: s.key,
      name: publicName(s),
      category: s.category,
      description: s.description,
      priceCents: s.priceCents,
      memberPriceCents: p.memberPriceCents,
      guestPriceCents: p.guestPriceCents,
      vipInclusion: s.vipInclusion,
      vipNote: s.vipNote,
      tags: s.tags,
      tintFilm: p.tintFilm,
    }
  }
  const quote = (kind: 'package' | 'addon') => (s: CatalogService & { key: string }) => ({
    key: s.key,
    name: publicName(s),
    kind,
    category: s.category,
    description: s.description,
  })
  return {
    generatedAt: now.toISOString(),
    currency: 'USD',
    guestMarkupPct: markup.value,
    guestBookingFeeCents: fee.value.cents,
    categories: categories.map((c) => ({ key: c.key, label: c.label, colour: c.colour, sort: c.sort })),
    services: services.packages
      .filter((s) => listed(s) && !s.quoteOnly)
      .map((s) => ({
        ...item(s),
        shortName: s.publicName ? s.publicName.split(' + ')[0]!.trim() : s.shortName,
        durationMin: s.durationMin,
      })),
    addons: services.addons
      .filter((s) => listed(s) && !s.quoteOnly)
      .map((s) => {
        const it: Partial<ReturnType<typeof item>> = item(s)
        delete it.tintFilm
        return it as Omit<ReturnType<typeof item>, 'tintFilm'>
      }),
    quotes: [
      ...services.packages.filter((s) => listed(s) && s.quoteOnly).map(quote('package')),
      ...services.addons.filter((s) => listed(s) && s.quoteOnly).map(quote('addon')),
    ],
    tint: tint.value,
    plans: PUBLIC_TIERS.map((t) => {
      const plan = plans.find((p) => p.key === t.planKey)
      return {
        key: t.key,
        name: plan?.publicLabel ?? t.label,
        planKey: t.planKey,
        planName: plan?.name ?? null,
        perks: plan?.perks ?? [],
        priceCents: plan?.monthlyPriceCents ?? null,
      }
    }),
  }
}
