// Seed profile `website-catalog` (ADR 0160, plan A): the website's current services and prices ("Oasis Site v2", the WASH, DURING,
// TINT, detail and "more" lists, the two plans and the 20% guest rule) become the production catalog, so Settings is the one
// source and nothing public changes on the day the website starts reading it.
//
//   creates or updates   the 2 washes, 2 tint packages (priced by the tint matrix), 2 details, 4 quote-only services and the
//                        9 add-ons, with category, public name, description, member price (the guest price follows the markup),
//                        VIP inclusion, durations, order, tags and a starting checklist (only onto an empty one);
//   adopts               an existing service of the same kind and name (case-insensitive) or one of its `adopt` names
//                        (the dashboard design's "Wax" becomes "Hand wax", keeping its id and checklist);
//   deactivates          every other active service (never deletes: appointments and invoices snapshot them; reversible in
//                        Settings), and re-derives the categories of the visits not yet finished;
//   sets                 catalog.tint_matrix, catalog.guest_markup_pct = 20, and the Gold (premium) and VIP (executive) plans'
//                        public name, monthly price and perks (the checkout URLs are left as they are: the owner pastes them).
//
// Members' credits: a plan's credit rules redeem on service tags (memberships/design-plans.ts). The washes carry the tags of the
// washes they replace (Signature, exterior + interior, is the premium wash; Exterior is the express wash), so every plan redeems
// what it redeemed before. The rules themselves are the memberships package's and are NOT changed here: the website's perks
// ("4 hand washes a month") differ from the rules' counts, and the executive "Executive detail" credit covers no website service.
// Each run logs a WARNING line per credit rule that covers no active service: align the rules (owner decision) before this runs
// in production (ADR 0160 W2a).
//
// Idempotent: a second run changes nothing (no version bump, no audit row). A run after the owner edited the catalog resets these
// fields to the website's content again, so run it once (production) and edit in Settings afterwards. Every change is audited under
// the actor "Seed (website-catalog)".
//
// Durations: the design's own for the washes ("about 45 min", "about 30 min"); the rest are the seed's choices, for the owner to
// review in Settings (listed in WEBSITE_DURATIONS_CHOSEN).
import { sql } from 'kysely'
import { ensurePlans, loadPlans, ruleCovers } from '../../src/modules/memberships/plans.js'
import type { PlanKey } from '../../src/modules/memberships/schema.js'
import { refreshOpenAppointmentCategories } from '../../src/modules/catalog/appointment-categories.js'
import { withMarkup, type TintMatrix } from '../../src/modules/catalog/pricing.js'
import type { ServiceKind, VipInclusion } from '../../src/modules/catalog/schema.js'
import { ensureDomainDefaults } from '../../src/modules/settings/defaults.js'
import * as audit from '../../src/platform/audit.js'
import { getSetting, updateSetting } from '../../src/platform/settings.js'
import '../../src/modules/catalog/schema.js'
import '../../src/modules/memberships/schema.js'
import type { SeedContext, SeedProfile } from './index.js'

export interface WebsiteService {
  kind: ServiceKind
  /** The name the dashboard and the website use (also the public name); the public key is its slug. */
  name: string
  /** Existing names (case-insensitive) this entry takes over, keeping the row's id and checklist. */
  adopt?: string[]
  category: 'wash' | 'addons' | 'tint' | 'detail' | 'quote'
  description: string | null
  /** What a member pays, in dollars (null for quote-only and tint packages, which the tint matrix prices). */
  memberDollars: number | null
  durationMin: number
  vipInclusion: VipInclusion
  vipNote: string | null
  quoteOnly: boolean
  tags: string[]
  sort: number
  /** The checklist a new (or task-less) service starts with. */
  tasks: string[]
}

export const WEBSITE_GUEST_MARKUP_PCT = 20

const MEMBER_WASH_NOTE = 'Included with Gold and VIP (4 washes a month)'
const TINT_TASKS = ['Clean and prep the glass', 'Cut the film to fit', 'Apply and squeegee the film', 'Edge check and curing notes']

export const WEBSITE_SERVICES: readonly WebsiteService[] = [
  // WASH: the two hand washes (member price included in Gold and VIP; guests pay member + 20%)
  {
    kind: 'package',
    name: 'Signature Hand Wash',
    category: 'wash',
    description: 'Exterior + interior',
    memberDollars: 45,
    durationMin: 45,
    vipInclusion: 'included',
    vipNote: MEMBER_WASH_NOTE,
    quoteOnly: false,
    tags: ['handwash', 'signature', 'premium'],
    sort: 10,
    tasks: [
      'Foam cannon pre-soak',
      'Hand wash with high-gloss soap',
      'Wheel & tire deep clean',
      'Ceramic wax spray sealant',
      'Streak-free hand dry',
      'Interior vacuum, dash and glass',
    ],
  },
  {
    kind: 'package',
    name: 'Exterior Hand Wash',
    category: 'wash',
    description: 'Foam, hand wash, wheels, hand dry',
    memberDollars: 32,
    durationMin: 30,
    vipInclusion: 'included',
    vipNote: MEMBER_WASH_NOTE,
    quoteOnly: false,
    tags: ['handwash', 'exterior', 'express'],
    sort: 20,
    tasks: [
      'Foam cannon pre-soak',
      'Hand wash with high-gloss soap',
      'Wheel & tire clean',
      'Ceramic wax spray sealant',
      'Streak-free hand dry',
    ],
  },
  // TINT: one package per film, priced by the tint matrix (the film is named by a tag)
  {
    kind: 'package',
    name: 'Carbon window tint',
    category: 'tint',
    description: 'Carbon film: a deep matte look and solid heat control at a lower price · side & rear windows',
    memberDollars: null,
    durationMin: 180,
    vipInclusion: 'none',
    vipNote: null,
    quoteOnly: false,
    tags: ['tint', 'carbon'],
    sort: 30,
    tasks: TINT_TASKS,
  },
  {
    kind: 'package',
    name: 'Ceramic window tint',
    category: 'tint',
    description:
      'Ceramic film: blocks the most heat without looking darker, and won’t interfere with phone or GPS signals · side & rear windows',
    memberDollars: null,
    durationMin: 180,
    vipInclusion: 'none',
    vipNote: null,
    quoteOnly: false,
    tags: ['tint', 'ceramic'],
    sort: 40,
    tasks: TINT_TASKS,
  },
  // Detailing
  {
    kind: 'package',
    name: 'Interior detail',
    category: 'detail',
    description: 'Shampoo, steam, leather, glass',
    memberDollars: 149,
    durationMin: 150,
    vipInclusion: 'none',
    vipNote: null,
    quoteOnly: false,
    tags: ['detail', 'interior'],
    sort: 50,
    tasks: ['Shampoo seats & carpets', 'Steam vents & console', 'Clean & condition leather', 'Interior glass'],
  },
  {
    kind: 'package',
    name: 'Full detail',
    category: 'detail',
    description: 'Inside and out, clay bar + sealant',
    memberDollars: 249,
    durationMin: 240,
    vipInclusion: 'none',
    vipNote: null,
    quoteOnly: false,
    tags: ['detail'],
    sort: 60,
    tasks: [
      'Foam pre-soak',
      'Hand wash',
      'Clay bar',
      'Wheel deep clean',
      'Carpet shampoo',
      'Full interior vacuum',
      'Leather treatment',
      'Glass polish',
      'Sealant',
    ],
  },
  // More services: priced per vehicle after a photo ("Send a photo and we'll reply with a quote")
  ...(
    [
      ['Windshield replacement', 120, 70],
      ['Rim powder coating', 480, 80],
      ['Chrome delete', 300, 90],
      ['Car key copies', 30, 100],
    ] as const
  ).map(
    ([name, durationMin, sort]): WebsiteService => ({
      kind: 'package',
      name,
      category: 'quote',
      description: null,
      memberDollars: null,
      durationMin,
      vipInclusion: 'none',
      vipNote: null,
      quoteOnly: true,
      tags: ['quote'],
      sort,
      tasks: [],
    }),
  ),
  // DURING: add during your wash (the design's order)
  ...(
    [
      ['Hand wax', ['Wax'], 'Carnauba, buffed by hand', 39, 'included', null, ['Apply carnauba wax', 'Buff off haze']],
      ['Engine bay wash', ['Engine bay cleaning'], 'Degrease and dress', 45, 'included', null, ['Cover electricals', 'Degrease engine bay', 'Dress plastics']],
      ['Leather conditioning', [], 'Clean, condition, matte finish', 35, 'allowance', '2× / mo', ['Clean leather surfaces', 'Apply conditioner', 'Buff to matte finish']],
      ['Stain removal', [], 'Seats and carpets, when needed', 59, 'allowance', '1× / mo', ['Pre-treat stains', 'Extract and rinse', 'Dry and check']],
      ['Tire shine & dressing', [], 'Satin or gloss', 12, 'none', null, ['Clean tire walls', 'Apply dressing (satin or gloss)']],
      ['Rain-repellent glass', ['Rain repellent'], 'Windshield and side glass', 25, 'none', null, ['Clean glass', 'Apply rain repellent to windshield and side glass']],
      ['Odor removal', [], 'Enzyme treatment', 30, 'none', null, ['Enzyme treatment on fabrics', 'Odor neutralizer cycle']],
      ['Pet hair removal', [], 'Rubber brush and vacuum', 35, 'none', null, ['Rubber-brush pet hair', 'Lint-roll upholstery', 'Vacuum seat seams']],
      ['Interior deep clean', [], 'Seats, carpets, vents', 60, 'none', null, ['Deep vacuum seats & carpets', 'Steam clean vents & cupholders', 'Wipe door jambs & panels']],
    ] as const
  ).map(
    ([name, adopt, description, member, vipInclusion, vipNote, tasks], i): WebsiteService => ({
      kind: 'addon',
      name,
      adopt: [...adopt],
      category: 'addons',
      description,
      memberDollars: member,
      durationMin: 0,
      vipInclusion,
      vipNote,
      quoteOnly: false,
      tags: [],
      sort: (i + 1) * 10,
      tasks: [...tasks],
    }),
  ),
]

/** The durations this seed chose (the design gives only the washes'), for the owner to review in Settings. */
export const WEBSITE_DURATIONS_CHOSEN: Readonly<Record<string, number>> = Object.fromEntries(
  WEBSITE_SERVICES.filter((s) => s.kind === 'package' && s.category !== 'wash').map((s) => [s.name, s.durationMin]),
)

const VLT = [5, 20, 35, 50, 70]
const TINT_DOLLARS: Record<'carbon' | 'ceramic', Record<'sedan' | 'suv' | 'truck', [number, number]>> = {
  carbon: { sedan: [229, 279], suv: [269, 329], truck: [249, 299] },
  ceramic: { sedan: [379, 449], suv: [429, 529], truck: [399, 479] },
}

/** The website's TINT and VEH tables: vehicle type × film, member ranges as shown ("VIP $229–$279"), guest = member + 20%. */
export const WEBSITE_TINT_MATRIX: TintMatrix = {
  vehicleTypes: [
    { key: 'sedan', label: 'Sedan / Coupe' },
    { key: 'suv', label: 'SUV / Crossover' },
    { key: 'truck', label: 'Truck / Van' },
  ],
  films: [
    { key: 'carbon', label: 'Carbon', vlt: VLT },
    { key: 'ceramic', label: 'Ceramic', vlt: VLT },
  ],
  prices: (['sedan', 'suv', 'truck'] as const).flatMap((vehicle) =>
    (['carbon', 'ceramic'] as const).map((film) => {
      const [lo, hi] = TINT_DOLLARS[film][vehicle]
      return {
        vehicle,
        film,
        memberMinCents: lo * 100,
        memberMaxCents: hi * 100,
        guestMinCents: withMarkup(lo * 100, WEBSITE_GUEST_MARKUP_PCT),
        guestMaxCents: withMarkup(hi * 100, WEBSITE_GUEST_MARKUP_PCT),
      }
    }),
  ),
}

export interface WebsitePlan {
  key: PlanKey
  publicLabel: string
  monthlyDollars: number
  perks: string[]
}

/** The join flow's two plans (joinVM's T): Gold over the premium plan, VIP over executive (src/modules/public/tiers.ts). */
export const WEBSITE_PLANS: readonly WebsitePlan[] = [
  {
    key: 'premium',
    publicLabel: 'Gold',
    monthlyDollars: 99,
    perks: ['4 hand washes a month, interior included', 'Share across household cars', 'No booking fees', 'Member prices on everything else'],
  },
  {
    key: 'executive',
    publicLabel: 'VIP',
    monthlyDollars: 169,
    perks: ['Everything in Gold', 'Wax every wash + engine bay', 'Leather 2× and stain removal 1× a month', 'Priority booking and same-day guarantee'],
  },
]

const ACTOR: audit.AuditContext = { actor: { name: 'Seed (website-catalog)' } }

interface Row {
  id: string
  kind: ServiceKind
  name: string
  price_cents: number
  duration_min: number
  tags: string[]
  sort: number
  active: boolean
  category: string
  public_name: string | null
  description: string | null
  member_price_cents: number | null
  guest_price_cents: number | null
  vip_inclusion: VipInclusion
  vip_note: string | null
  quote_only: boolean
  visible_online: boolean
}

const FIELDS = [
  'name',
  'price_cents',
  'duration_min',
  'tags',
  'sort',
  'active',
  'category',
  'public_name',
  'description',
  'member_price_cents',
  'guest_price_cents',
  'vip_inclusion',
  'vip_note',
  'quote_only',
  'visible_online',
] as const

type Desired = Pick<Row, (typeof FIELDS)[number]>

/** The row a website entry wants. The plain price (what a booking charges today) is the guest price. */
export function desiredRow(s: WebsiteService, tint: TintMatrix, markupPct: number): Desired {
  const member = s.memberDollars === null ? null : s.memberDollars * 100
  let plain = member === null ? 0 : withMarkup(member, markupPct)
  if (s.category === 'tint') {
    const film = s.tags.find((t) => tint.films.some((f) => f.key === t))
    const guests = tint.prices.filter((p) => p.film === film).map((p) => p.guestMinCents)
    plain = guests.length ? Math.min(...guests) : 0
  }
  return {
    name: s.name,
    price_cents: plain,
    duration_min: s.kind === 'addon' ? 0 : s.durationMin,
    tags: s.tags,
    sort: s.sort,
    active: true,
    category: s.category,
    public_name: s.name,
    description: s.description,
    member_price_cents: member,
    guest_price_cents: null,
    vip_inclusion: s.vipInclusion,
    vip_note: s.vipNote,
    quote_only: s.quoteOnly,
    visible_online: true,
  }
}

const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

async function findRow(ctx: SeedContext, s: WebsiteService, claimed: Set<string>): Promise<Row | undefined> {
  for (const name of [s.name, ...(s.adopt ?? [])]) {
    const r = await ctx.tx
      .selectFrom('services')
      .select(['id', 'kind', ...FIELDS])
      .where('location_id', '=', ctx.location.id)
      .where('kind', '=', s.kind)
      .where(sql<boolean>`lower(name) = lower(${name})`)
      .executeTakeFirst()
    if (r && !claimed.has(r.id)) return r as Row
  }
  return undefined
}

export interface WebsiteCatalogResult {
  created: string[]
  updated: string[]
  deactivated: string[]
  settings: string[]
  plans: string[]
  appointmentsUpdated: number
  /** "plan: rule label" of every credit rule of an active plan that covers no active package after the run (members could not redeem it). */
  uncoveredRules: string[]
}

export async function seedWebsiteCatalog(ctx: SeedContext): Promise<WebsiteCatalogResult> {
  const { tx, location } = ctx
  await ensureDomainDefaults(tx, location.id)
  await ensurePlans(tx, { locationId: location.id, clock: ctx.clock, newId: ctx.newId })
  const out: WebsiteCatalogResult = {
    created: [],
    updated: [],
    deactivated: [],
    settings: [],
    plans: [],
    appointmentsUpdated: 0,
    uncoveredRules: [],
  }

  // settings first: the tint packages' plain price comes from the matrix
  for (const [key, value] of [
    ['catalog.guest_markup_pct', WEBSITE_GUEST_MARKUP_PCT],
    ['catalog.tint_matrix', WEBSITE_TINT_MATRIX],
  ] as const) {
    const cur = await getSetting(tx, location.id, key)
    if (eq(cur.value, value)) continue
    await updateSetting(tx, { locationId: location.id, key, value, audit: ACTOR })
    out.settings.push(key)
  }

  const claimed = new Set<string>()
  for (const s of WEBSITE_SERVICES) {
    const want = desiredRow(s, WEBSITE_TINT_MATRIX, WEBSITE_GUEST_MARKUP_PCT)
    const row = await findRow(ctx, s, claimed)
    let id: string
    if (!row) {
      id = ctx.newId()
      await tx
        .insertInto('services')
        .values({ id, location_id: location.id, kind: s.kind, short_name: null, bookable_desk: true, sqsp_sku: null, ...want })
        .execute()
      await audit.record(tx, { locationId: location.id, action: 'catalog.seed.create', entityType: 'service', entityId: id, after: want, ctx: ACTOR })
      out.created.push(s.name)
    } else {
      id = row.id
      const before: Partial<Desired> = {}
      const after: Partial<Desired> = {}
      for (const k of FIELDS)
        if (!eq(row[k], want[k])) {
          ;(before as Record<string, unknown>)[k] = row[k]
          ;(after as Record<string, unknown>)[k] = want[k]
        }
      if (Object.keys(after).length > 0) {
        await tx
          .updateTable('services')
          .set((eb) => ({ ...after, version: eb('version', '+', 1), updated_at: eb.fn('app_now', []) }))
          .where('id', '=', id)
          .execute()
        await audit.record(tx, { locationId: location.id, action: 'catalog.seed.update', entityType: 'service', entityId: id, before, after, ctx: ACTOR })
        out.updated.push(s.name)
      }
    }
    claimed.add(id)
    // a checklist only onto an empty one: edits and retirements are never undone
    const hasTasks = await tx.selectFrom('checklist_tasks').select('id').where('service_id', '=', id).limit(1).executeTakeFirst()
    if (!hasTasks && s.tasks.length > 0)
      await tx
        .insertInto('checklist_tasks')
        .values(s.tasks.map((label, position) => ({ id: ctx.newId(), service_id: id, label, position, retired_at: null })))
        .execute()
  }

  // everything else leaves the catalog (kept for history; Settings can turn any of it back on)
  const others = await tx
    .selectFrom('services')
    .select(['id', 'name'])
    .where('location_id', '=', location.id)
    .where('active', '=', true)
    .$if(claimed.size > 0, (q) => q.where('id', 'not in', [...claimed]))
    .orderBy('kind')
    .orderBy('sort')
    .execute()
  for (const o of others) {
    await tx
      .updateTable('services')
      .set((eb) => ({ active: false, version: eb('version', '+', 1), updated_at: eb.fn('app_now', []) }))
      .where('id', '=', o.id)
      .execute()
    await audit.record(tx, {
      locationId: location.id,
      action: 'catalog.seed.deactivate',
      entityType: 'service',
      entityId: o.id,
      before: { active: true },
      after: { active: false },
      ctx: ACTOR,
    })
    out.deactivated.push(o.name)
  }

  for (const p of WEBSITE_PLANS) {
    const cur = await tx
      .selectFrom('membership_plans')
      .select(['public_label', 'monthly_price_cents', 'perks'])
      .where('location_id', '=', location.id)
      .where('key', '=', p.key)
      .executeTakeFirstOrThrow()
    const want = { public_label: p.publicLabel, monthly_price_cents: p.monthlyDollars * 100, perks: p.perks }
    if (eq(cur, want)) continue
    await tx
      .updateTable('membership_plans')
      .set((eb) => ({ ...want, version: eb('version', '+', 1), updated_at: eb.fn('app_now', []) }))
      .where('location_id', '=', location.id)
      .where('key', '=', p.key)
      .execute()
    await audit.record(tx, { locationId: location.id, action: 'catalog.seed.plan', entityType: 'membership_plan', entityId: p.key, before: cur, after: want, ctx: ACTOR })
    out.plans.push(p.key)
  }

  if (out.created.length + out.updated.length + out.deactivated.length > 0)
    out.appointmentsUpdated = await refreshOpenAppointmentCategories(tx, location.id)

  const activeTags = (
    await tx
      .selectFrom('services')
      .select('tags')
      .where('location_id', '=', location.id)
      .where('kind', '=', 'package')
      .where('active', '=', true)
      .execute()
  ).map((r) => r.tags)
  for (const p of (await loadPlans(tx, location.id)).filter((x) => x.active))
    for (const r of p.rules) if (!activeTags.some((tags) => ruleCovers(r, tags))) out.uncoveredRules.push(`${p.key}: ${r.label}`)
  return out
}

export const websiteCatalogProfile: SeedProfile = {
  description:
    'The website’s services and prices as the production catalog: washes, add-ons, tint (matrix), details, quote-only services, Gold/VIP plans; other services deactivated',
  async run(ctx) {
    const r = await seedWebsiteCatalog(ctx)
    ctx.log(
      `website-catalog: ${r.created.length} created, ${r.updated.length} updated, ${r.deactivated.length} deactivated` +
        (r.deactivated.length ? ` (${r.deactivated.join(', ')})` : '') +
        `, settings ${r.settings.join(', ') || 'unchanged'}, plans ${r.plans.join(', ') || 'unchanged'}, ${r.appointmentsUpdated} visits re-categorised`,
    )
    for (const rule of r.uncoveredRules)
      ctx.log(
        `WARNING website-catalog: credit rule "${rule}" covers no active package; align the plans’ credit rules before members redeem (ADR 0160 W2a)`,
      )
  },
}
