// Settings → Catalog (ADR 0160, plan A and K): the one catalog the website, the bookings and the AI assistant read. Staff edit here
// each service's website fields, the categories (name, colour, order, on/off; the key never changes), the tint price matrix, the
// guest markup and the membership plans' public fields. Reads are open to any signed-in user; every write needs set.services, runs in
// one transaction, writes an audit row and publishes settings.changed. Versions are ETags; the PUTs (whole-object saves of the
// Settings screen) require the version they edited (428 without, 412 when stale), PATCH and DELETE enforce it when sent.
import { access } from '../../../http/access.js'
import { hasPermission } from '../../../http/authorizer.js'
import { z } from '../../../http/zod.js'
import type { Executor } from '../../../platform/db.js'
import { AppError } from '../../../platform/errors.js'
import { getSetting, settingDefs, updateSetting, type SettingValue } from '../../../platform/settings.js'
import {
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
  type Category,
} from '../../catalog/categories.js'
import { listPlanPublic, putPlanPublic, type PlanPublic } from '../../catalog/plans.js'
import { effectivePrices, type TintMatrix } from '../../catalog/pricing.js'
import { listCatalog, requireService, type CatalogService } from '../../catalog/service.js'
import { putWebsiteFields } from '../../catalog/website.js'
import { etag, expectedVersion, idem, inTx, requestContext, requiredVersion, storedUserId, type SettingsRuntime } from './runtime.js'

const TAGS = ['catalog']
const Cents = z.number().int()
const Version = z.number().int().min(0)
const VipInclusion = z.enum(['included', 'allowance', 'none'])

export const CategoryView = z.object({
  key: z.string(),
  label: z.string(),
  colour: z.string().describe('#RRGGBB'),
  sort: z.number().int(),
  active: z.boolean(),
  builtin: z.boolean().describe('A default category: it can be turned off, never deleted'),
  version: z.number().int(),
})

export const WebsiteServiceView = z.object({
  id: z.string(),
  kind: z.enum(['package', 'addon']),
  name: z.string(),
  active: z.boolean(),
  priceCents: Cents.describe('The plain price: what a booking charges today'),
  durationMin: z.number().int(),
  tags: z.array(z.string()),
  category: z.string(),
  publicName: z.string().nullable(),
  description: z.string().nullable(),
  memberPriceCents: Cents.nullable().describe('null: the plain price'),
  guestPriceCents: Cents.nullable().describe('null: the member price plus the guest markup, rounded half up to whole dollars'),
  vipInclusion: VipInclusion,
  vipNote: z.string().nullable(),
  quoteOnly: z.boolean(),
  visibleOnline: z.boolean(),
  sort: z.number().int(),
  effective: z
    .object({ memberPriceCents: Cents, guestPriceCents: Cents, tintFilm: z.string().nullable() })
    .describe('The prices the website and the assistant show (a tint package: the lowest prices of its film in the tint matrix)'),
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
  key: z.enum(['essential', 'premium', 'executive', 'exotic']),
  name: z.string().describe('The dashboard plan’s name'),
  active: z.boolean(),
  websiteTier: z.enum(['gold', 'vip']).nullable().describe('The website tier sold over this plan'),
  publicLabel: z.string().nullable(),
  monthlyPriceCents: Cents.nullable(),
  perks: z.array(z.string()),
  checkoutUrl: z.string().nullable().describe('The Squarespace subscription checkout (internal: never in the public catalog)'),
  version: z.number().int(),
})

export const CatalogSettingsView = z.object({
  categories: z.array(CategoryView),
  packages: z.array(WebsiteServiceView),
  addons: z.array(WebsiteServiceView),
  tintMatrix: TintMatrixView,
  guestMarkup: GuestMarkupView,
  guestBookingFeeCents: Cents,
  plans: z.array(PlanPublicView),
})

const categoryView = (c: Category): z.infer<typeof CategoryView> => ({ ...c })

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

interface PricingContext {
  markupPct: number
  tint: TintMatrix
}

async function pricingOf(db: Executor, locationId: string): Promise<PricingContext> {
  const [markup, tint] = await Promise.all([
    getSetting(db, locationId, 'catalog.guest_markup_pct'),
    getSetting(db, locationId, 'catalog.tint_matrix'),
  ])
  return { markupPct: markup.value, tint: tint.value }
}

export const websiteServiceView = (s: CatalogService, p: PricingContext): z.infer<typeof WebsiteServiceView> => ({
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
  effective: effectivePrices(s, p),
  version: s.version,
})

const tintView = (r: { value: SettingValue<'catalog.tint_matrix'>; version: number }): z.infer<typeof TintMatrixView> => ({
  ...r.value,
  version: r.version,
})

/** The registry's rules for the tint matrix (keys, ranges, known pairs, no duplicates), as a 422 with body paths. */
function parseTintMatrix(v: unknown): TintMatrix {
  const r = settingDefs['catalog.tint_matrix'].schema.safeParse(v)
  if (!r.success)
    throw new AppError('VALIDATION_FAILED', {
      detail: r.error.issues[0]?.message ?? 'Check the tint prices.',
      errors: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    })
  return r.data
}

export async function loadCatalogSettings(
  db: Executor,
  locationId: string,
  includeInactive: boolean,
): Promise<z.infer<typeof CatalogSettingsView>> {
  const [categories, catalog, tint, markup, fee, plans] = await Promise.all([
    listCategories(db, locationId),
    listCatalog(db, locationId, { includeInactive }),
    getSetting(db, locationId, 'catalog.tint_matrix'),
    getSetting(db, locationId, 'catalog.guest_markup_pct'),
    getSetting(db, locationId, 'booking.guest_fee'),
    listPlanPublic(db, locationId),
  ])
  const p = { markupPct: markup.value, tint: tint.value }
  return {
    categories: categories.map(categoryView),
    packages: catalog.packages.map((s) => websiteServiceView(s, p)),
    addons: catalog.addons.map((s) => websiteServiceView(s, p)),
    tintMatrix: tintView(tint),
    guestMarkup: { pct: markup.value, version: markup.version },
    guestBookingFeeCents: fee.value.cents,
    plans: plans.map(planView),
  }
}

const NullableText = (max: number) => z.string().max(max).nullable()
const CategoryKeyParam = z.object({ key: z.string().max(64) })

export function registerCatalogSettingsRoutes(rt: SettingsRuntime): void {
  const { app } = rt

  app.get(
    '/catalog',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: TAGS,
        operationId: 'getCatalogSettings',
        summary: 'Settings → Catalog in one call: categories, every service’s website fields, tint matrix, guest markup, plans',
        description:
          'Active services only; `includeInactive=true` (retired ones too) needs set.services. Each part carries its own `version` (the token its save takes).',
        querystring: z.object({ includeInactive: z.enum(['true', 'false']).default('false') }),
        response: { 200: CatalogSettingsView },
      },
    },
    async (req) => {
      const includeInactive = req.query.includeInactive === 'true'
      if (includeInactive && !hasPermission(req.auth!, 'set.services'))
        throw new AppError('FORBIDDEN', { meta: { required: ['set.services'], mode: 'all' } })
      return loadCatalogSettings(app.db, requestContext(req).locationId, includeInactive)
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
        summary: 'A package’s or add-on’s website fields with the prices the website shows (ETag = version)',
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
        summary: 'Save a package’s or add-on’s website fields (category, public name, description, prices, VIP, quote-only, online, order)',
        description:
          'All fields, replaced together; `version` (or If-Match) is required: 428 without, 412 VERSION_CONFLICT when stale (the service’s version, shared with checklist and catalog edits). ' +
          'Texts are trimmed (blank = none). 422: an unknown or turned-off category (a service may keep a category that was turned off later), a price outside 0..$100,000, a guest price below the member price, `allowance` without a `vipNote`. ' +
          'A category change re-derives `categories` on the visits not yet finished that hold the service (`appointmentsUpdated`). Publishes `settings.changed {section: "services"}`.',
        params: z.object({ id: z.string().uuid() }),
        body: z
          .object({
            category: z.string().max(32),
            publicName: NullableText(200),
            description: NullableText(2000),
            memberPriceCents: Cents.nullable(),
            guestPriceCents: Cents.nullable(),
            vipInclusion: VipInclusion,
            vipNote: NullableText(400),
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
          '`key` is immutable once created: a lowercase letter, then letters, digits or underscores (up to 32). `colour` #RRGGBB (stored upper case). `sort` defaults to after the last. 409 CATEGORY_KEY_TAKEN; 422 CATEGORY_LIMIT past 20 categories. Publishes `settings.changed {section: "catalog", key: "categories"}`.',
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

  // ---- tint matrix and guest markup (settings keys) -------------------------------------------------------------------

  app.get(
    '/catalog/tint-matrix',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: TAGS,
        operationId: 'getCatalogTintMatrix',
        summary: 'The tint price matrix: vehicle types × films, member and guest ranges, VLT options (ETag = version)',
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
      schema: {
        tags: TAGS,
        operationId: 'putCatalogTintMatrix',
        summary: 'Save the whole tint price matrix',
        description:
          '`version` (or If-Match) is required (0 before the first save): 428 without, 412 VERSION_CONFLICT when stale. Keys are lowercase (letters, digits, underscore); a price row names a listed vehicle type and film, each pair once, each range not ending below its start; VLT values 1..100. ' +
          'A tint package names its film by a tag (e.g. `ceramic`) and shows that film’s lowest prices. Publishes `settings.changed {section: "catalog", key: "catalog.tint_matrix"}`.',
        body: z.object({ ...TintMatrixShape, version: Version.optional() }).strict(),
        response: { 200: TintMatrixView },
      },
    },
    async (req, reply) => {
      const c = requestContext(req)
      const { version, ...value } = req.body
      const v = requiredVersion(req, version)
      const matrix = parseTintMatrix(value)
      const r = await inTx(app.db, async (tx) =>
        updateSetting(tx, {
          locationId: c.locationId,
          key: 'catalog.tint_matrix',
          value: matrix,
          expectedVersion: v,
          updatedBy: await storedUserId(tx, c.userId),
          audit: c.audit,
        }),
      )
      etag(reply, r.version)
      return tintView(r)
    },
  )

  app.get(
    '/catalog/guest-markup',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: TAGS,
        operationId: 'getCatalogGuestMarkup',
        summary: 'The guest markup in percent over the member price (ETag = version)',
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
      schema: {
        tags: TAGS,
        operationId: 'putCatalogGuestMarkup',
        summary: 'Save the guest markup (0 to 200 percent)',
        description:
          'Applies to every service without its own guest price: guest = member × (100 + pct) / 100, rounded half up to whole dollars. `version` (or If-Match) required (0 before the first save). Publishes `settings.changed {section: "catalog", key: "catalog.guest_markup_pct"}`.',
        body: z.object({ pct: z.number().int(), version: Version.optional() }).strict(),
        response: { 200: GuestMarkupView },
      },
    },
    async (req, reply) => {
      const c = requestContext(req)
      const v = requiredVersion(req, req.body.version)
      if (req.body.pct < 0 || req.body.pct > 200)
        throw new AppError('VALIDATION_FAILED', {
          detail: 'Enter a markup from 0 to 200 percent.',
          errors: [{ path: 'pct', message: 'Enter a markup from 0 to 200 percent.' }],
        })
      const r = await inTx(app.db, async (tx) =>
        updateSetting(tx, {
          locationId: c.locationId,
          key: 'catalog.guest_markup_pct',
          value: req.body.pct,
          expectedVersion: v,
          updatedBy: await storedUserId(tx, c.userId),
          audit: c.audit,
        }),
      )
      etag(reply, r.version)
      return { pct: r.value, version: r.version }
    },
  )

  // ---- membership plans' public fields -----------------------------------------------------------------------------------

  app.get(
    '/catalog/plans',
    {
      config: { access: access.authenticated() },
      schema: {
        tags: TAGS,
        operationId: 'listCatalogPlans',
        summary: 'The membership plans’ public fields: public name, monthly price, perks, Squarespace checkout link',
        response: { 200: z.object({ plans: z.array(PlanPublicView) }) },
      },
    },
    async (req) => ({ plans: (await listPlanPublic(app.db, requestContext(req).locationId)).map(planView) }),
  )

  app.put(
    '/catalog/plans/:key',
    {
      config: { access: access.perm('set.services') },
      schema: {
        tags: TAGS,
        operationId: 'putCatalogPlan',
        summary: 'Save a plan’s public name, monthly price, perks and checkout link',
        description:
          'All four fields, replaced together; `version` (or If-Match) is required (the plan’s version): 428 without, 412 when stale. Perks: up to 12, each up to 120 characters, trimmed, blanks dropped, no duplicates (they are also what the Membership tab lists). ' +
          '`checkoutUrl` is the plan’s Squarespace subscription checkout: https on squarespace.com or a subdomain, no user, password or port (422 otherwise); it never appears in the public catalog. Publishes `settings.changed {section: "catalog", key: "plans"}`.',
        params: z.object({ key: z.enum(['essential', 'premium', 'executive', 'exotic']) }),
        body: z
          .object({
            publicLabel: NullableText(200),
            monthlyPriceCents: Cents.nullable(),
            perks: z.array(z.string().max(500)).max(40),
            checkoutUrl: NullableText(4096),
            version: Version.optional(),
          })
          .strict(),
        response: { 200: PlanPublicView.extend({ changed: z.boolean() }) },
      },
    },
    async (req, reply) => {
      const c = requestContext(req)
      const { version, ...fields } = req.body
      const v = requiredVersion(req, version)
      const r = await inTx(app.db, (tx) =>
        putPlanPublic(tx, { locationId: c.locationId, key: req.params.key, fields, expectedVersion: v, audit: c.audit }),
      )
      etag(reply, r.plan.version)
      return { ...planView(r.plan), changed: r.changed }
    },
  )
}
