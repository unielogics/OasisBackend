// Settings → Catalog (ADR 0160, plan A and K; ADR 0170): the one catalog the website, the bookings and the AI assistant read. Staff
// edit here each service's website fields, the categories (name, colour, order, on/off; the key never changes), the vehicle sizes,
// the prices by size (one regular price per service and size), the membership tiers (perks, member % off, VIP booking, inclusions)
// with their monthly price per size, and the booking fee. Reads are open to any signed-in user; every write needs set.services, runs
// in one transaction, writes an audit row and publishes settings.changed. Versions are ETags; the PUTs (whole-object saves of the
// Settings screen) require the version they edited (428 without, 412 when stale), PATCH and DELETE enforce it when sent. The old
// writes of the tint matrix, the guest markup and a plan's public fields answer 410 CATALOG_ROUTE_RETIRED (prices are by size now).
import { access } from '../../../http/access.js'
import { hasPermission } from '../../../http/authorizer.js'
import { z } from '../../../http/zod.js'
import type { Executor } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import { getSetting, updateSetting, type SettingValue } from '../../../platform/settings.js'
import {
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
  type Category,
} from '../../catalog/categories.js'
import { putClassPrices } from '../../catalog/class-prices.js'
import { listPlanPublic, type PlanPublic } from '../../catalog/plans.js'
import { fromPrice, loadPriceBook, loadTierCells, memberCents, missingCells, tierFromPrice, type PriceBook } from '../../catalog/price-book.js'
import { listCatalog, requireService, type CatalogService } from '../../catalog/service.js'
import { createTier, deleteTier, listTiers, putTier, putTierPrices, type Tier, type TierFields } from '../../catalog/tiers.js'
import {
  createVehicleClass,
  deleteVehicleClass,
  listVehicleClasses,
  updateVehicleClass,
  type VehicleClass,
} from '../../catalog/vehicle-classes.js'
import { putWebsiteFields, syncBookingPrices } from '../../catalog/website.js'
import { loadPlans } from '../../memberships/plans.js'
import { etag, expectedVersion, idem, inTx, requestContext, requiredVersion, storedUserId, type SettingsRuntime } from './runtime.js'

const TAGS = ['catalog']
const Cents = z.number().int()
const Version = z.number().int().min(0)
const VipInclusion = z.enum(['included', 'allowance', 'none'])
const Slug = z.string().max(64)

export const CategoryView = z.object({
  key: z.string(),
  label: z.string(),
  colour: z.string().describe('#RRGGBB'),
  sort: z.number().int(),
  active: z.boolean(),
  builtin: z.boolean().describe('A default category: it can be turned off, never deleted'),
  version: z.number().int(),
})

export const VehicleClassView = z.object({
  key: z.string().describe('Never changes: prices, tiers, vehicles, memberships and visits refer to it'),
  label: z.string(),
  sort: z.number().int().describe('Size order, smallest first'),
  active: z.boolean(),
  version: z.number().int(),
})

export const WebsiteServiceView = z.object({
  id: z.string(),
  kind: z.enum(['package', 'addon']),
  name: z.string(),
  active: z.boolean(),
  priceCents: Cents.describe(
    'The starting price (the lowest price over the active sizes) for a service priced by size, kept in step by every grid save; otherwise the base price a booking charges',
  ),
  durationMin: z.number().int(),
  tags: z.array(z.string()),
  category: z.string(),
  publicName: z.string().nullable(),
  description: z.string().nullable(),
  memberPriceCents: Cents.nullable().describe('Deprecated (ADR 0170): the stored pre-size member price, read only'),
  guestPriceCents: Cents.nullable().describe('Deprecated (ADR 0170): the stored pre-size guest price, read only'),
  vipInclusion: VipInclusion.describe('Deprecated (ADR 0170): VIP members get the VIP tier’s inclusions'),
  vipNote: z.string().nullable().describe('Deprecated (ADR 0170)'),
  quoteOnly: z.boolean(),
  visibleOnline: z.boolean(),
  sort: z.number().int(),
  effective: z
    .object({ memberPriceCents: Cents, guestPriceCents: Cents, tintFilm: z.string().nullable() })
    .describe(
      'The starting prices the website and the assistant state: the regular starting price, and the member one at the lowest % off of the public tiers that have a price (ADR 0170)',
    ),
  version: z.number().int(),
})

const PriceCell = z.object({
  class: z.string(),
  cents: Cents,
  maxCents: Cents.nullable().describe('The “up to” price of a range (tint); null = one price'),
})

export const PriceRowView = z.object({
  serviceId: z.string(),
  version: z.number().int().describe('The service’s version: the token a grid save of this row takes'),
  cells: z.array(PriceCell).describe('The sizes that have a price, in size order (a size not listed is not set)'),
  fromCents: Cents.describe('The starting price: the lowest over the active sizes, else the base price'),
  missing: z.number().int().describe('Active sizes without a price (priced at the starting price, confirm at the shop)'),
})

const InclusionView = z.object({
  id: z.string(),
  label: z.string(),
  mode: z.enum(['per_cycle', 'every_visit']),
  perCycle: z.number().int().nullable().describe('per_cycle: visits a billing cycle, null = unlimited; always null for every_visit'),
  autoApply: z.boolean().describe('Applied by itself when a covered visit is completed'),
  active: z.boolean(),
  serviceIds: z.array(z.string()),
})

const TierPriceView = z.object({
  class: z.string(),
  monthlyCents: Cents,
  priceVersion: z.number().int(),
  effectiveFrom: z.iso.datetime(),
  squareState: z
    .enum(['pending', 'synced', 'failed', 'retired'])
    .optional()
    .describe(
      'Staff with set.services only. The real state of the price at Square (wave Q3b syncs it): pending (not synced yet; always while SQUARE_MEMBERSHIPS_ENABLED is off), synced (a plan variation exists), failed (the last sync failed: see squareError; the next sync tries again), retired (a superseded price deleted at Square; never a current one)',
    ),
  squareError: z.string().nullable().optional().describe('Staff with set.services only: why the last sync failed (plain words); null unless failed'),
  squareSyncedAt: z.iso.datetime().nullable().optional().describe('Staff with set.services only: when it was last synced to Square'),
})

export const TierView = z.object({
  key: z.string().describe('Never changes'),
  name: z.string(),
  colour: z.string().describe('#RRGGBB: the board badge colour'),
  bgColour: z.string(),
  sort: z.number().int(),
  active: z.boolean(),
  public: z.boolean().describe('Sold on the website and by the assistant'),
  vipBooking: z.boolean().describe('Members get the VIP slot rules'),
  memberDiscountBp: z.number().int().describe('The member % off every line the membership does not cover (1000 = 10%)'),
  maxVehicles: z.number().int().nullable(),
  perks: z.array(z.string()),
  checkoutUrl: z.string().nullable().describe('The Squarespace subscription checkout (internal: never in the public catalog)'),
  legacyKey: z.string().nullable().describe('The key before ADR 0170 (premium, executive)'),
  priceVersion: z.number().int().describe('The token a tier-price save of this tier takes'),
  version: z.number().int().describe('The token PUT /catalog/tiers/{key} takes'),
  squarePlanId: z.string().nullable().optional().describe('Staff with set.services only'),
  inclusions: z.array(InclusionView),
  prices: z.array(TierPriceView).describe('The current monthly price of each size that has one, in size order'),
  fromMonthlyCents: Cents.nullable().describe('The lowest current price over the active sizes; null = no price, not sold online'),
  sold: z.boolean().describe('Memberships, links or checkouts name it: it can be turned off, never deleted'),
})

export const GuestFeeView = z.object({
  cents: Cents.describe('The booking fee guests pay toward the visit (members pay none)'),
  collect: z.enum(['counter', 'link', 'card_hold']),
  version: z.number().int(),
})

const TintMatrixShape = {
  vehicleTypes: z.array(z.object({ key: z.string().max(32), label: z.string().max(40) }).strict()).max(20),
  films: z
    .array(z.object({ key: z.string().max(32), label: z.string().max(40), vlt: z.array(z.number().int()).max(10) }).strict())
    .max(20),
  prices: z
    .array(
      z
        .object({
          vehicle: z.string().max(32),
          film: z.string().max(32),
          memberMinCents: Cents,
          memberMaxCents: Cents,
          guestMinCents: Cents,
          guestMaxCents: Cents,
        })
        .strict(),
    )
    .max(400),
}
export const TintMatrixView = z.object({ ...TintMatrixShape, version: z.number().int() })
export const GuestMarkupView = z.object({ pct: z.number().int(), version: z.number().int() })

export const PlanPublicView = z.object({
  key: z.string(),
  name: z.string().describe('The tier’s name'),
  active: z.boolean(),
  websiteTier: z.string().nullable().describe('The key the website sells it under (a public tier), or null'),
  publicLabel: z.string().nullable().describe('The tier’s name (deprecated)'),
  monthlyPriceCents: Cents.nullable().describe('The tier’s starting monthly price over the active sizes'),
  perks: z.array(z.string()),
  checkoutUrl: z.string().nullable().describe('The Squarespace subscription checkout (internal: never in the public catalog)'),
  version: z.number().int(),
})

export const CatalogSettingsView = z.object({
  categories: z.array(CategoryView),
  packages: z.array(WebsiteServiceView),
  addons: z.array(WebsiteServiceView),
  vehicleClasses: z.array(VehicleClassView).describe('Every size in size order, turned-off ones included'),
  prices: z.array(PriceRowView).describe('One row per listed service (packages, then add-ons)'),
  missingPrices: z.number().int().describe('Cells not set over the listed services and the active sizes (“N prices not set”)'),
  tiers: z.array(TierView),
  guestFee: GuestFeeView,
  tintMatrix: TintMatrixView.describe('Deprecated (ADR 0170): the stored pre-size matrix, read only'),
  guestMarkup: GuestMarkupView.describe('Deprecated (ADR 0170): the stored pre-size markup, read only'),
  guestBookingFeeCents: Cents,
  plans: z.array(PlanPublicView).describe('Deprecated (ADR 0170): the tiers’ public fields; read `tiers`'),
})

const categoryView = (c: Category): z.infer<typeof CategoryView> => ({ ...c })
const vehicleClassView = (c: VehicleClass): z.infer<typeof VehicleClassView> => ({ ...c })

const planView = (p: PlanPublic): z.infer<typeof PlanPublicView> => ({
  key: p.key,
  name: p.name,
  active: p.active,
  websiteTier: p.websiteTier,
  publicLabel: p.publicLabel,
  monthlyPriceCents: p.monthlyPriceCents,
  perks: p.perks,
  checkoutUrl: p.checkoutUrl,
  version: p.version,
})

export const tierView = (t: Tier, admin: boolean): z.infer<typeof TierView> => ({
  key: t.key,
  name: t.name,
  colour: t.colour,
  bgColour: t.bgColour,
  sort: t.sort,
  active: t.active,
  public: t.public,
  vipBooking: t.vipBooking,
  memberDiscountBp: t.memberDiscountBp,
  maxVehicles: t.maxVehicles,
  perks: t.perks,
  checkoutUrl: t.checkoutUrl,
  legacyKey: t.legacyKey,
  priceVersion: t.priceVersion,
  version: t.version,
  ...(admin ? { squarePlanId: t.squarePlanId } : {}),
  inclusions: t.inclusions.map((i) => ({
    id: i.id,
    label: i.label,
    mode: i.mode,
    perCycle: i.perCycle,
    autoApply: i.autoApply,
    active: i.active,
    serviceIds: i.serviceIds,
  })),
  prices: t.prices.map((p) => ({
    class: p.class,
    monthlyCents: p.monthlyCents,
    priceVersion: p.priceVersion,
    effectiveFrom: p.effectiveFrom.toISOString(),
    ...(admin ? { squareState: p.squareState, squareError: p.squareError, squareSyncedAt: p.squareSyncedAt?.toISOString() ?? null } : {}),
  })),
  fromMonthlyCents: t.fromMonthlyCents,
  sold: t.sold,
})

/** What the website and the assistant state as starting prices: the regular one and the member one at `memberBp`. */
interface PricingContext {
  book: PriceBook
  memberBp: number
  tintFilms: ReadonlySet<string>
}

/** The lowest member % off over the public active tiers that have a price ("members from"); 0 when none. */
export async function memberDisplayBp(db: Executor, locationId: string, book: PriceBook): Promise<number> {
  const [plans, cells] = await Promise.all([loadPlans(db, locationId), loadTierCells(db, locationId)])
  const priced = plans.filter((p) => p.active && p.public && tierFromPrice(book, cells.get(p.id) ?? []) !== null)
  return priced.length ? Math.min(...priced.map((p) => p.memberDiscountBp)) : 0
}

async function pricingOf(db: Executor, locationId: string): Promise<PricingContext> {
  const book = await loadPriceBook(db, locationId)
  return { book, memberBp: await memberDisplayBp(db, locationId, book), tintFilms: new Set(book.tintFilms.map((f) => f.key)) }
}

export const websiteServiceView = (s: CatalogService, p: PricingContext): z.infer<typeof WebsiteServiceView> => {
  const from = fromPrice(p.book, s.id).cents
  return {
    id: s.id,
    kind: s.kind,
    name: s.name,
    active: s.active,
    priceCents: s.priceCents,
    durationMin: s.durationMin,
    tags: s.tags,
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
    effective: {
      memberPriceCents: memberCents(from, p.memberBp),
      guestPriceCents: from,
      tintFilm: s.category === 'tint' ? (s.tags.find((t) => p.tintFilms.has(t)) ?? null) : null,
    },
    version: s.version,
  }
}

const priceRowView = (s: CatalogService, book: PriceBook): z.infer<typeof PriceRowView> => {
  const cells = book.cells.get(s.id)
  const order = new Map(book.classes.map((c, i) => [c.key, i]))
  return {
    serviceId: s.id,
    version: s.version,
    cells: [...(cells?.entries() ?? [])]
      .map(([cls, c]) => ({ class: cls, cents: c.cents, maxCents: c.maxCents }))
      .sort((a, b) => (order.get(a.class) ?? 99) - (order.get(b.class) ?? 99) || (a.class < b.class ? -1 : 1)),
    fromCents: fromPrice(book, s.id).cents,
    missing: s.quoteOnly ? 0 : missingCells(book, s.id),
  }
}

const tintView = (r: { value: SettingValue<'catalog.tint_matrix'>; version: number }): z.infer<typeof TintMatrixView> => ({
  ...r.value,
  version: r.version,
})

export async function loadCatalogSettings(
  db: Executor,
  locationId: string,
  includeInactive: boolean,
  admin = false,
): Promise<z.infer<typeof CatalogSettingsView>> {
  const [categories, catalog, tint, markup, fee, plans, classes, tiers, p] = await Promise.all([
    listCategories(db, locationId),
    listCatalog(db, locationId, { includeInactive }),
    getSetting(db, locationId, 'catalog.tint_matrix'),
    getSetting(db, locationId, 'catalog.guest_markup_pct'),
    getSetting(db, locationId, 'booking.guest_fee'),
    listPlanPublic(db, locationId),
    listVehicleClasses(db, locationId),
    listTiers(db, locationId),
    pricingOf(db, locationId),
  ])
  const prices = [...catalog.packages, ...catalog.addons].map((s) => priceRowView(s, p.book))
  return {
    categories: categories.map(categoryView),
    packages: catalog.packages.map((s) => websiteServiceView(s, p)),
    addons: catalog.addons.map((s) => websiteServiceView(s, p)),
    vehicleClasses: classes.map(vehicleClassView),
    prices,
    missingPrices: prices.reduce((n, r) => n + r.missing, 0),
    tiers: tiers.map((t) => tierView(t, admin)),
    guestFee: { cents: fee.value.cents, collect: fee.value.collect, version: fee.version },
    tintMatrix: tintView(tint),
    guestMarkup: { pct: markup.value, version: markup.version },
    guestBookingFeeCents: fee.value.cents,
    plans: plans.map(planView),
  }
}

const NullableText = (max: number) => z.string().max(max).nullable()
const CategoryKeyParam = z.object({ key: z.string().max(64) })

const InclusionBody = z
  .object({
    id: z.string().uuid().optional(),
    label: z.string().max(200),
    mode: z.enum(['per_cycle', 'every_visit']),
    perCycle: z.number().int().nullable(),
    autoApply: z.boolean(),
    active: z.boolean().optional(),
    serviceIds: z.array(z.string().uuid()).max(100),
  })
  .strict()

const TierBody = {
  name: z.string().max(200),
  colour: z.string().max(16),
  bgColour: z.string().max(16).nullish(),
  sort: z.number().int(),
  active: z.boolean(),
  public: z.boolean(),
  vipBooking: z.boolean(),
  memberDiscountBp: z.number().int(),
  maxVehicles: z.number().int().nullable(),
  perks: z.array(z.string().max(500)).max(40),
  checkoutUrl: NullableText(4096),
  inclusions: z.array(InclusionBody).max(40),
}

const RETIRED =
  'Retired (ADR 0170): answers 410 CATALOG_ROUTE_RETIRED. Prices are set per vehicle size (PUT /catalog/prices) and tiers in PUT /catalog/tiers/{key} and PUT /catalog/tier-prices.'

const retired = async (): Promise<never> => {
  throw new AppError('CATALOG_ROUTE_RETIRED')
}

const isAdmin = (req: { auth?: Parameters<typeof hasPermission>[0] | null }): boolean =>
  req.auth != null && hasPermission(req.auth, 'set.services')

export function registerCatalogSettingsRoutes(rt: SettingsRuntime): void {
  const { app } = rt

  app.get(
    '/catalog',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: TAGS,
        operationId: 'getCatalogSettings',
        summary:
          'Settings → Catalog in one call: categories, every service’s website fields, vehicle sizes, prices by size, membership tiers, booking fee',
        description:
          'Active services only; `includeInactive=true` (retired ones too) needs set.services. Each part carries its own `version` (the token its save takes): a price row carries its service’s version, a tier its `version` (PUT /catalog/tiers/{key}) and `priceVersion` (PUT /catalog/tier-prices). Square fields of the tiers are shown to set.services holders only. `tintMatrix`, `guestMarkup` and `plans` are the deprecated pre-size data, read only (ADR 0170).',
        querystring: z.object({ includeInactive: z.enum(['true', 'false']).default('false') }),
        response: { 200: CatalogSettingsView },
      },
    },
    async (req) => {
      const includeInactive = req.query.includeInactive === 'true'
      if (includeInactive && !hasPermission(req.auth!, 'set.services'))
        throw new AppError('FORBIDDEN', { meta: { required: ['set.services'], mode: 'all' } })
      return loadCatalogSettings(app.db, requestContext(req).locationId, includeInactive, isAdmin(req))
    },
  )

  // ---- a service's website fields ---------------------------------------------------------------------------------------

  app.get(
    '/catalog/services/:id',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: TAGS,
        operationId: 'getCatalogService',
        summary: 'A package’s or add-on’s website fields with the starting prices the website shows (ETag = version)',
        params: z.object({ id: z.string().uuid() }),
        response: { 200: WebsiteServiceView },
      },
    },
    async (req, reply) => {
      const c = requestContext(req)
      const [s, p] = await Promise.all([requireService(app.db, c.locationId, req.params.id), pricingOf(app.db, c.locationId)])
      etag(reply, s.version)
      return websiteServiceView(s, p)
    },
  )

  app.put(
    '/catalog/services/:id',
    {
      config: { access: access.perm('set.services') },
      schema: {
        tags: TAGS,
        operationId: 'putCatalogService',
        summary: 'Save a package’s or add-on’s website fields (category, public name, description, quote-only, online, order)',
        description:
          'All fields, replaced together; `version` (or If-Match) is required: 428 without, 412 VERSION_CONFLICT when stale (the service’s version, shared with checklist, price and catalog edits). ' +
          'Texts are trimmed (blank = none). 422: an unknown or turned-off category (a service may keep a category that was turned off later). Prices are not website fields (ADR 0170): they are set per vehicle size (PUT /catalog/prices); what VIP members get is the VIP tier’s inclusions. ' +
          'A category change re-derives `categories` on the visits not yet finished that hold the service (`appointmentsUpdated`). Publishes `settings.changed {section: "services"}`.',
        params: z.object({ id: z.string().uuid() }),
        body: z
          .object({
            category: z.string().max(32),
            publicName: NullableText(200),
            description: NullableText(2000),
            quoteOnly: z.boolean(),
            visibleOnline: z.boolean(),
            sort: z.number().int(),
            version: Version.optional(),
          })
          .strict(),
        response: {
          200: WebsiteServiceView.extend({ changed: z.boolean(), appointmentsUpdated: z.number().int() }),
        },
      },
    },
    async (req, reply) => {
      const c = requestContext(req)
      const { version, ...fields } = req.body
      const v = requiredVersion(req, version)
      const out = await inTx(app.db, async (tx) => {
        const r = await putWebsiteFields(tx, {
          locationId: c.locationId,
          serviceId: req.params.id,
          fields,
          expectedVersion: v,
          audit: c.audit,
        })
        return { r, p: await pricingOf(tx, c.locationId) }
      })
      etag(reply, out.r.service.version)
      return { ...websiteServiceView(out.r.service, out.p), changed: out.r.changed, appointmentsUpdated: out.r.appointmentsUpdated }
    },
  )

  // ---- categories --------------------------------------------------------------------------------------------------------

  app.get(
    '/catalog/categories',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: TAGS,
        operationId: 'listCatalogCategories',
        summary: 'The catalog categories in display order, turned-off ones included, with their colours and versions',
        response: { 200: z.object({ categories: z.array(CategoryView) }) },
      },
    },
    async (req) => ({ categories: (await listCategories(app.db, requestContext(req).locationId)).map(categoryView) }),
  )

  app.post(
    '/catalog/categories',
    {
      config: { access: access.perm('set.services'), idempotency: 'optional' },
      schema: {
        tags: TAGS,
        operationId: 'createCatalogCategory',
        summary: 'Add a category',
        description:
          '`key` is immutable once created: a lowercase letter, then letters, digits or underscores (up to 32); `mixed` is reserved (the word a visit with two categories is counted under). `colour` #RRGGBB (stored upper case). `sort` defaults to after the last. 409 CATEGORY_KEY_TAKEN; 422 CATEGORY_LIMIT past 20 categories. Publishes `settings.changed {section: "catalog", key: "categories"}`.',
        body: z
          .object({
            key: z.string().max(64),
            label: z.string().max(200),
            colour: z.string().max(16),
            sort: z.number().int().optional(),
            active: z.boolean().optional(),
          })
          .strict(),
        response: { 201: CategoryView },
      },
    },
    idem(async (req, tx) => {
      const c = requestContext(req)
      const b = req.body as { key: string; label: string; colour: string; sort?: number; active?: boolean }
      const cat = await createCategory(tx, { ...b, locationId: c.locationId, audit: c.audit })
      return { status: 201, body: categoryView(cat) }
    }),
  )

  app.patch(
    '/catalog/categories/:key',
    {
      config: { access: access.perm('set.services') },
      schema: {
        tags: TAGS,
        operationId: 'updateCatalogCategory',
        summary: 'Rename, recolour, reorder or turn a category on or off (the key never changes)',
        description:
          '`version` (or If-Match) is optional and enforced when sent. A category that is turned off leaves the public catalog with its services (they stay in it) and takes no new service. Appointments keep the key. Publishes `settings.changed {section: "catalog", key: "categories"}`.',
        params: CategoryKeyParam,
        body: z
          .object({
            label: z.string().max(200).optional(),
            colour: z.string().max(16).optional(),
            sort: z.number().int().optional(),
            active: z.boolean().optional(),
            version: Version.optional(),
          })
          .strict(),
        response: { 200: CategoryView.extend({ changed: z.boolean() }) },
      },
    },
    async (req, reply) => {
      const c = requestContext(req)
      const { version, ...patch } = req.body
      const r = await inTx(app.db, (tx) =>
        updateCategory(tx, {
          locationId: c.locationId,
          key: req.params.key,
          patch,
          expectedVersion: expectedVersion(req, version),
          audit: c.audit,
        }),
      )
      etag(reply, r.category.version)
      return { ...categoryView(r.category), changed: r.changed }
    },
  )

  app.delete(
    '/catalog/categories/:key',
    {
      config: { access: access.perm('set.services') },
      schema: {
        tags: TAGS,
        operationId: 'deleteCatalogCategory',
        summary: 'Delete a category no service uses (never a default one)',
        description:
          '409 CATEGORY_BUILTIN for Wash, Add-ons, Tint, Detail and Quote (turn them off instead); 409 CATEGORY_IN_USE while any service, active or retired, names it. If-Match is enforced when sent. Appointments that named it keep the key.',
        params: CategoryKeyParam,
        response: { 200: z.object({ key: z.string(), removed: z.literal(true) }) },
      },
    },
    async (req) => {
      const c = requestContext(req)
      const v = req.headers['if-match'] ? expectedVersion(req, undefined) : undefined
      const cat = await inTx(app.db, (tx) =>
        deleteCategory(tx, { locationId: c.locationId, key: req.params.key, expectedVersion: v, audit: c.audit }),
      )
      return { key: cat.key, removed: true as const }
    },
  )

  // ---- vehicle sizes ---------------------------------------------------------------------------------------------------

  app.get(
    '/catalog/vehicle-classes',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: TAGS,
        operationId: 'listVehicleClasses',
        summary: 'The vehicle sizes in size order, turned-off ones included, with their versions',
        response: { 200: z.object({ vehicleClasses: z.array(VehicleClassView) }) },
      },
    },
    async (req) => ({ vehicleClasses: (await listVehicleClasses(app.db, requestContext(req).locationId)).map(vehicleClassView) }),
  )

  app.post(
    '/catalog/vehicle-classes',
    {
      config: { access: access.perm('set.services'), idempotency: 'optional' },
      schema: {
        tags: TAGS,
        operationId: 'createVehicleClass',
        summary: 'Add a vehicle size',
        description:
          '`key` is immutable once created: a lowercase letter, then letters, digits or underscores (up to 32). `label` up to 40 characters, unique (case-insensitively). `sort` defaults to after the last (size order, smallest first). 409 CLASS_KEY_TAKEN; 422 CLASS_LIMIT past 12 sizes. A new size has no prices (“not set”). Publishes `settings.changed {section: "catalog", key: "vehicle_classes"}`.',
        body: z
          .object({ key: z.string().max(64), label: z.string().max(200), sort: z.number().int().optional(), active: z.boolean().optional() })
          .strict(),
        response: { 201: VehicleClassView },
      },
    },
    idem(async (req, tx) => {
      const c = requestContext(req)
      const b = req.body as { key: string; label: string; sort?: number; active?: boolean }
      const vc = await createVehicleClass(tx, { ...b, locationId: c.locationId, audit: c.audit })
      return { status: 201, body: vehicleClassView(vc) }
    }),
  )

  app.patch(
    '/catalog/vehicle-classes/:key',
    {
      config: { access: access.perm('set.services') },
      schema: {
        tags: TAGS,
        operationId: 'updateVehicleClass',
        summary: 'Rename, reorder or turn a vehicle size on or off (the key never changes)',
        description:
          '`version` (or If-Match) is optional and enforced when sent. The last size that is on cannot be turned off (422). A size that is off is not offered and its prices are kept but not used; turning one on or off moves the starting price of the services priced on it (audited `catalog.price.sync`). Publishes `settings.changed {section: "catalog", key: "vehicle_classes"}`.',
        params: CategoryKeyParam,
        body: z
          .object({
            label: z.string().max(200).optional(),
            sort: z.number().int().optional(),
            active: z.boolean().optional(),
            version: Version.optional(),
          })
          .strict(),
        response: { 200: VehicleClassView.extend({ changed: z.boolean() }) },
      },
    },
    async (req, reply) => {
      const c = requestContext(req)
      const { version, ...patch } = req.body
      const r = await inTx(app.db, async (tx) => {
        const out = await updateVehicleClass(tx, {
          locationId: c.locationId,
          key: req.params.key,
          patch,
          expectedVersion: expectedVersion(req, version),
          audit: c.audit,
        })
        if (out.changed) await syncBookingPrices(tx, { locationId: c.locationId, reason: 'catalog.vehicle_classes', audit: c.audit })
        return out
      })
      etag(reply, r.vehicleClass.version)
      return { ...vehicleClassView(r.vehicleClass), changed: r.changed }
    },
  )

  app.delete(
    '/catalog/vehicle-classes/:key',
    {
      config: { access: access.perm('set.services') },
      schema: {
        tags: TAGS,
        operationId: 'deleteVehicleClass',
        summary: 'Delete a vehicle size nothing uses',
        description:
          '409 CLASS_IN_USE (meta names the counts) while any price, tier price (current or past), membership, membership checkout, credit event, vehicle or visit uses it: turn it off instead. The last size that is on cannot be deleted (422). If-Match is enforced when sent.',
        params: CategoryKeyParam,
        response: { 200: z.object({ key: z.string(), removed: z.literal(true) }) },
      },
    },
    async (req) => {
      const c = requestContext(req)
      const v = req.headers['if-match'] ? expectedVersion(req, undefined) : undefined
      const vc = await inTx(app.db, (tx) =>
        deleteVehicleClass(tx, { locationId: c.locationId, key: req.params.key, expectedVersion: v, audit: c.audit }),
      )
      return { key: vc.key, removed: true as const }
    },
  )

  // ---- prices by size ----------------------------------------------------------------------------------------------------

  app.put(
    '/catalog/prices',
    {
      config: { access: access.perm('set.services') },
      schema: {
        tags: TAGS,
        operationId: 'putCatalogPrices',
        summary: 'Save rows of the price grid (services × vehicle sizes), all or nothing',
        description:
          'Each row names a service and the version it was edited at (its service’s version: 428 when a row has none, 412 VERSION_CONFLICT when stale with `meta.row` and `meta.serviceId` naming the row; nothing is saved). Cells: a size and a regular price in cents (0 to $100,000), `maxCents` for an “up to” price (a range, tint), or `cents: null` to clear it (not set: priced at the starting price, confirm at the shop). Sizes a row does not list keep their price. 422 for an unknown size, a size twice in a row, a service twice. ' +
          'Every changed row bumps the service’s version, sets `priceCents` to the new starting price, is audited (`catalog.price.update`) and publishes `settings.changed {section: "services"}`; the save publishes `settings.changed {section: "catalog", key: "prices"}`.',
        body: z
          .object({
            rows: z
              .array(
                z
                  .object({
                    serviceId: z.string().max(64),
                    version: Version.optional(),
                    cells: z
                      .array(z.object({ class: Slug, cents: Cents.nullable(), maxCents: Cents.nullable().default(null) }).strict())
                      .max(24),
                  })
                  .strict(),
              )
              .max(200),
          })
          .strict(),
        response: {
          200: z.object({
            rows: z.array(PriceRowView.extend({ changed: z.boolean() })),
            missingPrices: z.number().int(),
          }),
        },
      },
    },
    async (req) => {
      const c = requestContext(req)
      const rows = req.body.rows.map((r, i) => {
        if (r.version === undefined)
          throw new AppError('PRECONDITION_REQUIRED', { meta: { row: i, serviceId: r.serviceId } })
        return { serviceId: r.serviceId, version: r.version, cells: r.cells }
      })
      return inTx(app.db, async (tx) => {
        const saved = await putClassPrices(tx, {
          locationId: c.locationId,
          rows,
          userId: await storedUserId(tx, c.userId),
          audit: c.audit,
        })
        const book = await loadPriceBook(tx, c.locationId)
        const out = await Promise.all(
          saved.map(async (r) => ({
            ...priceRowView(await requireService(tx, c.locationId, r.serviceId), book),
            changed: r.changed,
          })),
        )
        const catalog = await listCatalog(tx, c.locationId)
        const missing = [...catalog.packages, ...catalog.addons].reduce(
          (n, s) => n + (s.quoteOnly ? 0 : missingCells(book, s.id)),
          0,
        )
        return { rows: out, missingPrices: missing }
      })
    },
  )

  // ---- membership tiers --------------------------------------------------------------------------------------------------

  app.get(
    '/catalog/tiers',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: TAGS,
        operationId: 'listCatalogTiers',
        summary: 'The membership tiers with their inclusions and monthly prices by size',
        description: 'Square fields (`squarePlanId`, each price’s `squareState`) are shown to set.services holders only.',
        response: { 200: z.object({ tiers: z.array(TierView) }) },
      },
    },
    async (req) => ({ tiers: (await listTiers(app.db, requestContext(req).locationId)).map((t) => tierView(t, isAdmin(req))) }),
  )

  app.post(
    '/catalog/tiers',
    {
      config: { access: access.perm('set.services'), idempotency: 'optional' },
      schema: {
        tags: TAGS,
        operationId: 'createCatalogTier',
        summary: 'Add a membership tier',
        description:
          '`key` is immutable once created (a lowercase slug, up to 32); it cannot be a key or an old key (premium, executive) another tier holds (409 TIER_KEY_TAKEN). At most 12 tiers. The tier starts without prices (not sold online until it has one): set them with PUT /catalog/tier-prices. Body fields as PUT /catalog/tiers/{key}. Publishes `settings.changed {section: "catalog", key: "tiers"}`.',
        body: z.object({ key: z.string().max(64), ...TierBody }).strict(),
        response: { 201: TierView },
      },
    },
    idem(async (req, tx) => {
      const c = requestContext(req)
      const { key, ...fields } = req.body as { key: string } & TierFields
      const t = await createTier(tx, { newId: app.newId }, { locationId: c.locationId, key, fields, audit: c.audit })
      return { status: 201, body: tierView(t, true) }
    }),
  )

  app.put(
    '/catalog/tiers/:key',
    {
      config: { access: access.perm('set.services') },
      schema: {
        tags: TAGS,
        operationId: 'putCatalogTier',
        summary: 'Save a membership tier: name, colour, perks, member % off, VIP booking, car cap, online, inclusions',
        description:
          'The whole tier, replaced together; `version` (or If-Match) is required: 428 without, 412 when stale. The key never changes. `memberDiscountBp` 0 to 10000 (the member % off every line the membership does not cover, rounded to whole dollars); `vipBooking` gives members the VIP slot rules; `maxVehicles` 1 to 20 or null; perks up to 12, each up to 120 characters, trimmed, no duplicates; `checkoutUrl` a Squarespace checkout (https on squarespace.com) or null. ' +
          '`inclusions` replace the tier’s list in order: an `id` keeps an existing inclusion (its credit history follows it), no `id` adds one; an inclusion left out is deleted, or turned off when credits name it. Each covers `serviceIds` (at least one service of the catalog), `mode` per_cycle (`perCycle` visits a cycle, null = unlimited) or every_visit (`perCycle` null), and `autoApply`. Audited `catalog.tier.update`; publishes `settings.changed {section: "catalog", key: "tiers"}`.',
        params: CategoryKeyParam,
        body: z.object({ ...TierBody, version: Version.optional() }).strict(),
        response: { 200: TierView.extend({ changed: z.boolean() }) },
      },
    },
    async (req, reply) => {
      const c = requestContext(req)
      const { version, ...fields } = req.body
      const v = requiredVersion(req, version)
      const r = await inTx(app.db, (tx) =>
        putTier(tx, { newId: app.newId }, { locationId: c.locationId, key: req.params.key, fields, expectedVersion: v, audit: c.audit }),
      )
      etag(reply, r.tier.version)
      return { ...tierView(r.tier, true), changed: r.changed }
    },
  )

  app.delete(
    '/catalog/tiers/:key',
    {
      config: { access: access.perm('set.services') },
      schema: {
        tags: TAGS,
        operationId: 'deleteCatalogTier',
        summary: 'Delete a membership tier that was never sold',
        description:
          '409 TIER_IN_USE when a membership (any status), a personal link, a checkout or a Squarespace product names it: turn it off instead. Its price history goes with it. If-Match is enforced when sent.',
        params: CategoryKeyParam,
        response: { 200: z.object({ key: z.string(), removed: z.literal(true) }) },
      },
    },
    async (req) => {
      const c = requestContext(req)
      const v = req.headers['if-match'] ? expectedVersion(req, undefined) : undefined
      const t = await inTx(app.db, (tx) =>
        deleteTier(tx, { locationId: c.locationId, key: req.params.key, expectedVersion: v, audit: c.audit }),
      )
      return { key: t.key, removed: true as const }
    },
  )

  app.put(
    '/catalog/tier-prices',
    {
      config: { access: access.perm('set.services') },
      schema: {
        tags: TAGS,
        operationId: 'putCatalogTierPrices',
        summary: 'Save rows of the tier × size monthly price grid, all or nothing',
        description:
          'Each row names a tier and the `priceVersion` it was edited at (428 when a row has none, 412 VERSION_CONFLICT naming the row in `meta.row` and `meta.tierKey` when stale; nothing is saved). Cells: a size and a monthly price in cents (0 to $100,000), or `monthlyCents: null` to clear it (that size is not sold). Sizes a row does not list keep their price. ' +
          'Prices are append-only: a changed size supersedes its current price and adds a new one at the tier’s next `priceVersion` with Square state `pending` (synced to Square later); members keep the price they joined at. Audited `catalog.tier_price.update`; publishes `settings.changed {section: "catalog", key: "tier_prices"}`.',
        body: z
          .object({
            rows: z
              .array(
                z
                  .object({
                    tierKey: Slug,
                    priceVersion: Version.optional(),
                    cells: z.array(z.object({ class: Slug, monthlyCents: Cents.nullable() }).strict()).max(24),
                  })
                  .strict(),
              )
              .max(24),
          })
          .strict(),
        response: { 200: z.object({ tiers: z.array(TierView), changed: z.array(z.string()) }) },
      },
    },
    async (req) => {
      const c = requestContext(req)
      const rows = req.body.rows.map((r, i) => {
        if (r.priceVersion === undefined) throw new AppError('PRECONDITION_REQUIRED', { meta: { row: i, tierKey: r.tierKey } })
        return { tierKey: r.tierKey, priceVersion: r.priceVersion, cells: r.cells }
      })
      const out = await inTx(app.db, async (tx) =>
        putTierPrices(
          tx,
          { newId: app.newId, now: app.clock.now() },
          { locationId: c.locationId, rows, userId: await storedUserId(tx, c.userId), audit: c.audit },
        ),
      )
      return { tiers: out.tiers.map((t) => tierView(t, true)), changed: out.changed }
    },
  )

  // ---- the booking fee ---------------------------------------------------------------------------------------------------

  app.get(
    '/catalog/guest-fee',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: TAGS,
        operationId: 'getCatalogGuestFee',
        summary: 'The booking fee guests pay toward the visit, and how it is collected (ETag = version)',
        response: { 200: GuestFeeView },
      },
    },
    async (req, reply) => {
      const r = await getSetting(app.db, requestContext(req).locationId, 'booking.guest_fee')
      etag(reply, r.version)
      return { cents: r.value.cents, collect: r.value.collect, version: r.version }
    },
  )

  app.put(
    '/catalog/guest-fee',
    {
      config: { access: access.perm('set.services') },
      schema: {
        tags: TAGS,
        operationId: 'putCatalogGuestFee',
        summary: 'Save the booking fee (0 to $1,000) and how it is collected (at the counter, by a payment link, or a saved card)',
        description:
          'A deposit toward the visit guests pay (members pay none; ADR 0150), settled by the cancel and no-show rules. `collect`: `counter`; `link` (with PAYMENT_PROCESSOR=square a Square quick-pay link is created and texted after each online booking, ADR 0171); `card_hold` (wave Q3a; accepted now, collected at the counter until then). `version` (or If-Match) required (0 before the first save): 428 without, 412 when stale. Audited `settings.update`; publishes `settings.changed {key: "booking.guest_fee"}`.',
        body: z.object({ cents: Cents, collect: z.enum(['counter', 'link', 'card_hold']), version: Version.optional() }).strict(),
        response: { 200: GuestFeeView },
      },
    },
    async (req, reply) => {
      const c = requestContext(req)
      const v = requiredVersion(req, req.body.version)
      if (req.body.cents < 0 || req.body.cents > 100_000)
        throw new AppError('VALIDATION_FAILED', {
          detail: 'Enter a fee from $0 to $1,000.',
          errors: [{ path: 'cents', message: 'Enter a fee from $0 to $1,000.' }],
        })
      const r = await inTx(app.db, async (tx) =>
        updateSetting(tx, {
          locationId: c.locationId,
          key: 'booking.guest_fee',
          value: { cents: req.body.cents, collect: req.body.collect },
          expectedVersion: v,
          updatedBy: await storedUserId(tx, c.userId),
          audit: c.audit,
        }),
      )
      etag(reply, r.version)
      return { cents: r.value.cents, collect: r.value.collect, version: r.version }
    },
  )

  // ---- the pre-size data (ADR 0170): reads kept, writes retired ------------------------------------------------------------

  app.get(
    '/catalog/tint-matrix',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: TAGS,
        operationId: 'getCatalogTintMatrix',
        summary: 'Deprecated: the stored pre-size tint matrix (ETag = version)',
        description: 'Read only (ADR 0170): tint packages are priced per vehicle size now (PUT /catalog/prices).',
        response: { 200: TintMatrixView },
      },
    },
    async (req, reply) => {
      const r = await getSetting(app.db, requestContext(req).locationId, 'catalog.tint_matrix')
      etag(reply, r.version)
      return tintView(r)
    },
  )

  app.put(
    '/catalog/tint-matrix',
    {
      config: { access: access.perm('set.services') },
      schema: { tags: TAGS, operationId: 'putCatalogTintMatrix', summary: 'Retired: save the tint matrix', description: RETIRED, deprecated: true },
    },
    retired,
  )

  app.get(
    '/catalog/guest-markup',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: TAGS,
        operationId: 'getCatalogGuestMarkup',
        summary: 'Deprecated: the stored pre-size guest markup (ETag = version)',
        description: 'Read only (ADR 0170): a member price is the regular price less the tier’s % off now.',
        response: { 200: GuestMarkupView },
      },
    },
    async (req, reply) => {
      const r = await getSetting(app.db, requestContext(req).locationId, 'catalog.guest_markup_pct')
      etag(reply, r.version)
      return { pct: r.value, version: r.version }
    },
  )

  app.put(
    '/catalog/guest-markup',
    {
      config: { access: access.perm('set.services') },
      schema: { tags: TAGS, operationId: 'putCatalogGuestMarkup', summary: 'Retired: save the guest markup', description: RETIRED, deprecated: true },
    },
    retired,
  )

  app.get(
    '/catalog/plans',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: TAGS,
        operationId: 'listCatalogPlans',
        summary: 'Deprecated: the tiers’ public fields (name, starting monthly price, perks, Squarespace checkout link)',
        description: 'Read `GET /catalog/tiers` instead (ADR 0170).',
        response: { 200: z.object({ plans: z.array(PlanPublicView) }) },
      },
    },
    async (req) => ({ plans: (await listPlanPublic(app.db, requestContext(req).locationId)).map(planView) }),
  )

  app.put(
    '/catalog/plans/:key',
    {
      config: { access: access.perm('set.services') },
      schema: { tags: TAGS, operationId: 'putCatalogPlan', summary: 'Retired: save a plan’s public fields', description: RETIRED, deprecated: true },
    },
    retired,
  )
}
