// GET /public/catalog: the one catalog the website and the assistant read (ADR 0160, plan A; ADR 0150 before it; ADR 0170: built from
// the prices by vehicle size). Everything comes from Settings: the active categories with their colours, the packages and add-ons
// listed online (category active, not quote-only) with their member and regular STARTING prices and what VIP members get, the
// quote-only items, the tint packages' prices by size (in the old tint-matrix shape), the booking fee, and the tiers sold online with
// their starting monthly price and perks. Keys are the slug of the service name over every active package (or add-on), exactly as
// the availability and booking routes key them, so a key read here is a key they accept. Nothing internal: no ids, versions,
// checklists, Squarespace SKUs or checkout URLs, desk flags or inactive rows.
//
// Starting prices (design §3b, the only prices the assistant may state; price-book.ts): an item's guestPriceCents is its lowest
// regular price over the active sizes (its base price when it has none by size), memberPriceCents the same less the lowest member %
// off of the public tiers that have a price, rounded to whole dollars; a tint row's min prices are its size's; a plan's priceCents its
// lowest monthly price. The website switches to GET /public/catalog/v2 (per-size prices) in wave Q3c; this shape stays until then.
import { z } from '../../http/zod.js'
import type { Executor } from '../../platform/db.js'
import { getSetting } from '../../platform/settings.js'
import { listCategories } from '../catalog/categories.js'
import { fromPrice, loadPriceBook, loadTierCells, memberCents, tierFromPrice } from '../catalog/price-book.js'
import type { CatalogService } from '../catalog/service.js'
import { loadPlans } from '../memberships/plans.js'
import { loadBoardServices } from './availability-loader.js'

const Cents = z.number().int()
const VipInclusion = z.enum(['included', 'allowance', 'none'])

const ItemFields = {
  key: z.string(),
  /** The public name (the service's public name, else its name). */
  name: z.string(),
  category: z.string(),
  description: z.string().nullable(),
  priceCents: Cents.describe(
    'The starting price (kept for the website’s booking flow; what a booking of an unknown size charges). Not a price to state: state memberPriceCents / guestPriceCents',
  ),
  memberPriceCents: Cents.describe('The member STARTING price (design §3b): what the website and the assistant state for members'),
  guestPriceCents: Cents.describe('The guest STARTING price (design §3b): what the website and the assistant state for everyone else'),
  vipInclusion: VipInclusion,
  vipNote: z.string().nullable(),
  tags: z.array(z.string()),
}

export const PublicCatalogView = z.object({
  generatedAt: z.iso.datetime(),
  currency: z.literal('USD'),
  guestMarkupPct: z.number().int().describe('Always 0 (ADR 0170): both prices are given'),
  guestBookingFeeCents: Cents,
  categories: z.array(z.object({ key: z.string(), label: z.string(), colour: z.string(), sort: z.number().int() })),
  services: z.array(
    z.object({
      ...ItemFields,
      shortName: z.string(),
      durationMin: z.number().int(),
      /** The tint film (catalog.tint_films) this tint package is, or null. */
      tintFilm: z.string().nullable(),
    }),
  ),
  addons: z.array(z.object(ItemFields)),
  quotes: z.array(
    z.object({ key: z.string(), name: z.string(), kind: z.enum(['package', 'addon']), category: z.string(), description: z.string().nullable() }),
  ),
  tint: z.object({
    vehicleTypes: z.array(z.object({ key: z.string(), label: z.string() })).describe('The active vehicle sizes'),
    films: z.array(z.object({ key: z.string(), label: z.string(), vlt: z.array(z.number().int()) })),
    prices: z.array(
      z.object({
        vehicle: z.string(),
        film: z.string(),
        memberMinCents: Cents.describe('The member "from" price of this size and film (design §3b)'),
        memberMaxCents: Cents,
        guestMinCents: Cents.describe('The regular "from" price of this size and film (design §3b)'),
        guestMaxCents: Cents,
      }),
    ),
  }),
  plans: z.array(
    z.object({
      key: z.string().describe('The tier’s key (gold, vip, …)'),
      name: z.string(),
      planKey: z.string().describe('The tier’s key (the same as key since ADR 0170)'),
      planName: z.string().nullable(),
      perks: z.array(z.string()),
      /** The tier's starting monthly price (the lowest over the sizes), when it has one. */
      priceCents: Cents.nullable(),
    }),
  ).describe('The tiers sold online (active and public), in tier order'),
})

export type PublicCatalog = z.infer<typeof PublicCatalogView>

const publicName = (s: CatalogService): string => s.publicName ?? s.name

export async function loadPublicCatalog(db: Executor, locationId: string, now: Date): Promise<PublicCatalog> {
  const [services, categories, fee, book, plans, tierCells] = await Promise.all([
    loadBoardServices(db, locationId),
    listCategories(db, locationId, { activeOnly: true }),
    getSetting(db, locationId, 'booking.guest_fee'),
    loadPriceBook(db, locationId),
    loadPlans(db, locationId),
    loadTierCells(db, locationId),
  ])
  const live = new Set(categories.map((c) => c.key))
  // an item without any price (no price by size and a $0 base price: a new row nobody priced yet) is not stated as $0
  const unpriced = (s: CatalogService): boolean => !s.quoteOnly && fromPrice(book, s.id).basis === 'base' && s.priceCents === 0
  const listed = (s: CatalogService): boolean => s.visibleOnline && live.has(s.category) && !unpriced(s)
  const sold = plans
    .filter((p) => p.active && p.public)
    .map((p) => ({ p, from: tierFromPrice(book, tierCells.get(p.id) ?? []) }))
  // "members from": the lowest member % off of the tiers sold online that have a price
  const priced = sold.filter((x) => x.from !== null)
  const memberBp = priced.length ? Math.min(...priced.map((x) => x.p.memberDiscountBp)) : 0
  const films = new Set(book.tintFilms.map((f) => f.key))
  const filmOf = (s: CatalogService): string | null => (s.category === 'tint' ? (s.tags.find((t) => films.has(t)) ?? null) : null)
  const item = (s: CatalogService & { key: string }) => {
    const from = fromPrice(book, s.id).cents
    return {
      key: s.key,
      name: publicName(s),
      category: s.category,
      description: s.description,
      priceCents: from,
      memberPriceCents: memberCents(from, memberBp),
      guestPriceCents: from,
      vipInclusion: s.vipInclusion,
      vipNote: s.vipNote,
      tags: s.tags,
      tintFilm: filmOf(s),
    }
  }
  const quote = (kind: 'package' | 'addon') => (s: CatalogService & { key: string }) => ({
    key: s.key,
    name: publicName(s),
    kind,
    category: s.category,
    description: s.description,
  })
  const packages = services.packages.filter((s) => listed(s) && !s.quoteOnly)
  // the tint packages' prices by size, in the old matrix shape: one row per film (its first listed package) and active size
  const tintPrices = book.tintFilms.flatMap((f) => {
    const pkg = packages.find((s) => filmOf(s) === f.key)
    const cells = pkg ? book.cells.get(pkg.id) : undefined
    if (!cells) return []
    return book.classes.flatMap((cls) => {
      const c = cells.get(cls.key)
      if (!c) return []
      const max = c.maxCents ?? c.cents
      return [
        {
          vehicle: cls.key,
          film: f.key,
          memberMinCents: memberCents(c.cents, memberBp),
          memberMaxCents: memberCents(max, memberBp),
          guestMinCents: c.cents,
          guestMaxCents: max,
        },
      ]
    })
  })
  return {
    generatedAt: now.toISOString(),
    currency: 'USD',
    guestMarkupPct: 0,
    guestBookingFeeCents: fee.value.cents,
    categories: categories.map((c) => ({ key: c.key, label: c.label, colour: c.colour, sort: c.sort })),
    services: packages.map((s) => ({
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
    tint: {
      vehicleTypes: book.classes.map((c) => ({ key: c.key, label: c.label })),
      films: book.tintFilms.map((f) => ({ key: f.key, label: f.label, vlt: [...f.vlt] })),
      prices: tintPrices,
    },
    plans: sold.map(({ p, from }) => ({
      key: p.key,
      name: p.name,
      planKey: p.key,
      planName: p.name,
      perks: p.perks,
      priceCents: from?.monthlyCents ?? null,
    })),
  }
}
