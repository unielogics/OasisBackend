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

// ---- GET /public/catalog/v2 (ADR 0170 wave Q3d; design q-design-pricing §9) ------------------------------------------------------
//
// The catalog by vehicle size, for the website (wave Q3c switches to it) and the assistant's facts-v4. Everything from Settings:
// the active sizes, the categories, every listed package and add-on with its price at each size that HAS one (a size without a
// price is left out: the website says "priced at the shop"), the member price beside each (the lowest % off of the tiers sold online
// that have a price, rounded half up to whole dollars: memberDisplay), the starting price and its size, the tint film of a tint
// package, which tiers include it; the quote-only items; and the tiers sold online WITH a current price (plan decision 3: a tier with
// no price is not sold online) with their price per size, perks, % off, VIP booking flag, the cars a household may name and what they
// include (by the item's key). Nothing internal: no ids, versions, Square ids, checkout URLs, tags, desk flags or inactive rows.

const PriceCell = z.object({
  class: z.string().describe('A size key (vehicleClasses[].key)'),
  cents: Cents.describe('The regular price at this size (a range starts here)'),
  maxCents: Cents.nullable().describe('The top of a range ("up to"), else null'),
  memberCents: Cents.describe('The member price: cents less memberDisplay.discountBp, rounded half up to whole dollars'),
  memberMaxCents: Cents.nullable(),
})

const IncludedIn = z.object({
  tier: z.string().describe('A tier key (tiers[].key)'),
  mode: z.enum(['per_cycle', 'every_visit']),
  perCycle: z.number().int().nullable().describe('per_cycle: visits a billing cycle (null: unlimited); null for every_visit'),
})

const ItemV2Fields = {
  key: z.string(),
  name: z.string().describe('The public name (else the name)'),
  category: z.string(),
  description: z.string().nullable(),
  prices: z.array(PriceCell).describe('The sizes that have a price, in size order (a size left out is priced at the shop)'),
  fromCents: Cents.describe('The starting price: the lowest price over the sizes (the base price of an item without prices by size)'),
  fromClass: z.string().nullable().describe('The size of the starting price (null: the item has no prices by size)'),
  memberFromCents: Cents,
  includedIn: z.array(IncludedIn).describe('The tiers below whose inclusions name this item'),
}

export const PublicCatalogV2View = z.object({
  version: z.literal(2),
  generatedAt: z.iso.datetime(),
  currency: z.literal('USD'),
  guestBookingFeeCents: Cents,
  guestFeeCollect: z.enum(['counter', 'link']).describe('How a guest pays the booking fee: at the shop, or by a texted payment link'),
  vehicleClasses: z.array(z.object({ key: z.string(), label: z.string(), sort: z.number().int() })).describe('The active sizes, smallest first'),
  categories: z.array(z.object({ key: z.string(), label: z.string(), colour: z.string(), sort: z.number().int() })),
  memberDisplay: z.object({
    discountBp: z.number().int().describe('The lowest member % off (basis points) of the tiers sold online that have a price: the "members from" figure'),
  }),
  services: z.array(
    z.object({
      ...ItemV2Fields,
      shortName: z.string(),
      durationMin: z.number().int(),
      tintFilm: z.object({ key: z.string(), label: z.string(), vlt: z.array(z.number().int()) }).nullable(),
    }),
  ),
  addons: z.array(z.object(ItemV2Fields)),
  quotes: z.array(
    z.object({ key: z.string(), name: z.string(), kind: z.enum(['package', 'addon']), category: z.string(), description: z.string().nullable() }),
  ),
  tiers: z
    .array(
      z.object({
        key: z.string(),
        name: z.string(),
        colour: z.string().describe('The badge colour (#RRGGBB)'),
        sort: z.number().int(),
        perks: z.array(z.string()),
        memberDiscountBp: z.number().int().describe('The % off every line the membership does not cover, in basis points'),
        vipBooking: z.boolean().describe('Members get the VIP booking rules (longer window, held times)'),
        householdCars: z.number().int().nullable().describe('The cars a household may name when joining (null: no cap)'),
        prices: z.array(z.object({ class: z.string(), monthlyCents: Cents })).describe('The sizes that have a monthly price, in size order'),
        fromMonthlyCents: Cents,
        fromClass: z.string(),
        inclusions: z.array(
          z.object({
            serviceKey: z.string().describe('An item key of services or addons'),
            mode: z.enum(['per_cycle', 'every_visit']),
            perCycle: z.number().int().nullable(),
            group: z
              .number()
              .int()
              .describe('The inclusion this row belongs to (1, 2, ... in tier order): rows with the same group share ONE allowance (perCycle visits a month in all, not each)'),
          }),
        ),
      }),
    )
    .describe('The tiers sold online: active, public and with a current price, in tier order'),
})

export type PublicCatalogV2 = z.infer<typeof PublicCatalogV2View>

export async function loadPublicCatalogV2(db: Executor, locationId: string, now: Date): Promise<PublicCatalogV2> {
  const [services, categories, fee, book, plans, tierCells] = await Promise.all([
    loadBoardServices(db, locationId),
    listCategories(db, locationId, { activeOnly: true }),
    getSetting(db, locationId, 'booking.guest_fee'),
    loadPriceBook(db, locationId),
    loadPlans(db, locationId),
    loadTierCells(db, locationId),
  ])
  const live = new Set(categories.map((c) => c.key))
  const unpriced = (s: CatalogService): boolean => !s.quoteOnly && fromPrice(book, s.id).basis === 'base' && s.priceCents === 0
  const listed = (s: CatalogService): boolean => s.visibleOnline && live.has(s.category) && !unpriced(s)
  // the tiers sold online: active, public, with a current price at an active size
  const sold = plans
    .filter((p) => p.active && p.public)
    .flatMap((p) => {
      const cells = tierCells.get(p.id) ?? []
      const from = tierFromPrice(book, cells)
      return from ? [{ p, cells, from }] : []
    })
  const bp = sold.length ? Math.min(...sold.map((x) => x.p.memberDiscountBp)) : 0
  const films = new Map(book.tintFilms.map((f) => [f.key, f]))
  const filmOf = (s: CatalogService) => {
    if (s.category !== 'tint') return null
    const f = s.tags.map((t) => films.get(t)).find((x) => x !== undefined)
    return f ? { key: f.key, label: f.label, vlt: [...f.vlt] } : null
  }
  const packages = services.packages.filter((s) => listed(s) && !s.quoteOnly)
  const addons = services.addons.filter((s) => listed(s) && !s.quoteOnly)
  const keyOf = new Map([...packages, ...addons].map((s) => [s.id, s.key]))
  // an inclusion's items in the catalog's own order (packages, then add-ons, as listed below)
  const listOrder = new Map([...packages, ...addons].map((s, n) => [s.id, n]))
  const includedIn = (serviceId: string) =>
    sold.flatMap(({ p }) =>
      p.inclusions
        .filter((i) => i.active && i.serviceIds.includes(serviceId))
        .map((i) => ({ tier: p.key, mode: i.mode, perCycle: i.mode === 'every_visit' ? null : i.perCycle })),
    )
  const item = (s: CatalogService & { key: string }) => {
    const cells = book.cells.get(s.id)
    const prices = book.classes.flatMap((cls) => {
      const c = cells?.get(cls.key)
      if (!c) return []
      return [
        {
          class: cls.key,
          cents: c.cents,
          maxCents: c.maxCents,
          memberCents: memberCents(c.cents, bp),
          memberMaxCents: c.maxCents === null ? null : memberCents(c.maxCents, bp),
        },
      ]
    })
    const from = fromPrice(book, s.id)
    return {
      key: s.key,
      name: publicName(s),
      category: s.category,
      description: s.description,
      prices,
      fromCents: from.cents,
      fromClass: from.classKey,
      memberFromCents: memberCents(from.cents, bp),
      includedIn: includedIn(s.id),
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
    version: 2,
    generatedAt: now.toISOString(),
    currency: 'USD',
    guestBookingFeeCents: fee.value.cents,
    // as a booking answer says it (square/deposits.ts feeHow): card_hold (wave Q3a) is collected at the counter until then
    guestFeeCollect: fee.value.collect === 'link' ? ('link' as const) : ('counter' as const),
    vehicleClasses: book.classes.map((c) => ({ key: c.key, label: c.label, sort: c.sort })),
    categories: categories.map((c) => ({ key: c.key, label: c.label, colour: c.colour, sort: c.sort })),
    memberDisplay: { discountBp: bp },
    services: packages.map((s) => ({
      ...item(s),
      shortName: s.publicName ? s.publicName.split(' + ')[0]!.trim() : s.shortName,
      durationMin: s.durationMin,
      tintFilm: filmOf(s),
    })),
    addons: addons.map(item),
    quotes: [
      ...services.packages.filter((s) => listed(s) && s.quoteOnly).map(quote('package')),
      ...services.addons.filter((s) => listed(s) && s.quoteOnly).map(quote('addon')),
    ],
    tiers: sold.map(({ p, cells, from }) => ({
      key: p.key,
      name: p.name,
      colour: p.color,
      sort: p.sort,
      perks: p.perks,
      memberDiscountBp: p.memberDiscountBp,
      vipBooking: p.vipBooking,
      householdCars: p.maxVehicles,
      prices: book.classes.flatMap((cls) => {
        const c = cells.find((x) => x.classKey === cls.key)
        return c ? [{ class: cls.key, monthlyCents: c.monthlyCents }] : []
      }),
      fromMonthlyCents: from.monthlyCents,
      fromClass: from.classKey,
      // one row per covered listed item; `group` numbers the inclusions that cover a listed item, so two inclusions of 4 a month
      // read apart from one inclusion of 4 a month over two items (review F4)
      inclusions: p.inclusions
        .filter((i) => i.active)
        .map((i) => ({ i, keys: [...new Set(i.serviceIds)].filter((id) => keyOf.has(id)).sort((a, b) => listOrder.get(a)! - listOrder.get(b)!).map((id) => keyOf.get(id)!) }))
        .filter((x) => x.keys.length > 0)
        .flatMap(({ i, keys }, n) =>
          keys.map((serviceKey) => ({ serviceKey, mode: i.mode, perCycle: i.mode === 'every_visit' ? null : i.perCycle, group: n + 1 })),
        ),
    })),
  }
}
