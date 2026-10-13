// Seed profile `website-catalog` (ADR 0160, plan A; reworked by ADR 0170): the website's current services ("Oasis Site v2", the WASH,
// DURING, TINT, detail and "more" lists) and the two tiers it sells become the production catalog, so Settings is the one source.
//
//   creates or updates   the 2 washes, 2 tint packages (one per film, named by a tag), 2 details, 4 quote-only services and the
//                        9 add-ons, with category, public name, description, VIP inclusion (read by the old public catalog only),
//                        durations, order, tags and a starting checklist (only onto an empty one);
//   adopts               an existing service of the same kind and name (case-insensitive) or one of its `adopt` names
//                        (the dashboard design's "Wax" becomes "Hand wax", keeping its id and checklist);
//   deactivates          every other active service (never deletes: appointments and invoices snapshot them; reversible in
//                        Settings), and re-derives the categories of the visits not yet finished;
//   sets                 the Gold and VIP tiers' name and perks, sold online (the checkout URLs are left as they are), and the
//                        inclusions those perks promise while the tier covers no active service (review Q4 pricing:F1).
//
// Prices are NOT set here (ADR 0170, plan decision 9: the website's figures were wrong): a service keeps the price it has, a new one
// starts at $0 with no price by size, and the owner fills Settings → Prices by size (the `pricing-defaults` profile seeds only the
// $40 Signature Hand Wash at Compact car and Gold at $129 a month). Run it together with `pricing-defaults`, and switch the website
// to the live catalog only once the grid is filled. The member/guest prices, the guest markup and the tint matrix are not written.
//
// Members' coverage: a tier's inclusions name the services they cover. A tier that covers no active service gets the inclusions its
// perks promise (Gold: 4 hand washes a month; VIP: those, wax and engine bay every wash, leather 2 and stain removal 1 a month).
// Each run still logs a WARNING line per inclusion of an active tier that covers no active service.
//
// Idempotent: a second run changes nothing (no version bump, no audit row). A run after the owner edited the catalog resets these
// fields to the website's content again, so run it once (production) and edit in Settings afterwards. Every change is audited under
// the actor "Seed (website-catalog)".
//
// Durations: the design's own for the washes ("about 45 min", "about 30 min"); the rest are the seed's choices, for the owner to
// review in Settings (listed in WEBSITE_DURATIONS_CHOSEN).
import { sql } from 'kysely'
import { writeInclusions, type InclusionInput } from '../../src/modules/catalog/tiers.js'
import { ensurePlans, inclusionCovers, loadPlans } from '../../src/modules/memberships/plans.js'
import type { PlanKey } from '../../src/modules/memberships/schema.js'
import { refreshOpenAppointmentCategories } from '../../src/modules/catalog/appointment-categories.js'
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
  durationMin: number
  vipInclusion: VipInclusion
  vipNote: string | null
  quoteOnly: boolean
  tags: string[]
  sort: number
  /** The checklist a new (or task-less) service starts with. */
  tasks: string[]
}

const MEMBER_WASH_NOTE = 'Included with Gold and VIP (4 washes a month)'
const TINT_TASKS = ['Clean and prep the glass', 'Cut the film to fit', 'Apply and squeegee the film', 'Edge check and curing notes']

export const WEBSITE_SERVICES: readonly WebsiteService[] = [
  // WASH: the two hand washes (member price included in Gold and VIP; guests pay member + 20%)
  {
    kind: 'package',
    name: 'Signature Hand Wash',
    category: 'wash',
    description: 'Exterior + interior',
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
      ['Hand wax', ['Wax'], 'Carnauba, buffed by hand', 'included', null, ['Apply carnauba wax', 'Buff off haze']],
      ['Engine bay wash', ['Engine bay cleaning'], 'Degrease and dress', 'included', null, ['Cover electricals', 'Degrease engine bay', 'Dress plastics']],
      ['Leather conditioning', [], 'Clean, condition, matte finish', 'allowance', '2× / mo', ['Clean leather surfaces', 'Apply conditioner', 'Buff to matte finish']],
      ['Stain removal', [], 'Seats and carpets, when needed', 'allowance', '1× / mo', ['Pre-treat stains', 'Extract and rinse', 'Dry and check']],
      ['Tire shine & dressing', [], 'Satin or gloss', 'none', null, ['Clean tire walls', 'Apply dressing (satin or gloss)']],
      ['Rain-repellent glass', ['Rain repellent'], 'Windshield and side glass', 'none', null, ['Clean glass', 'Apply rain repellent to windshield and side glass']],
      ['Odor removal', [], 'Enzyme treatment', 'none', null, ['Enzyme treatment on fabrics', 'Odor neutralizer cycle']],
      ['Pet hair removal', [], 'Rubber brush and vacuum', 'none', null, ['Rubber-brush pet hair', 'Lint-roll upholstery', 'Vacuum seat seams']],
      ['Interior deep clean', [], 'Seats, carpets, vents', 'none', null, ['Deep vacuum seats & carpets', 'Steam clean vents & cupholders', 'Wipe door jambs & panels']],
    ] as const
  ).map(
    ([name, adopt, description, vipInclusion, vipNote, tasks], i): WebsiteService => ({
      kind: 'addon',
      name,
      adopt: [...adopt],
      category: 'addons',
      description,
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

/** The tint films the tint packages name by a tag (catalog.tint_films), with the website's VLT shades. */
export const WEBSITE_TINT_FILMS = [
  { key: 'carbon', label: 'Carbon', vlt: [5, 20, 35, 50, 70] },
  { key: 'ceramic', label: 'Ceramic', vlt: [5, 20, 35, 50, 70] },
]

export interface WebsiteInclusion {
  label: string
  mode: 'per_cycle' | 'every_visit'
  /** per_cycle: visits a month. */
  perCycle: number | null
  /** The website services it covers, by name. */
  services: string[]
}

export interface WebsitePlan {
  key: PlanKey
  name: string
  perks: string[]
  /** What the perks promise, as inclusions (review Q4 pricing:F1): written while the tier covers no active service. */
  inclusions: WebsiteInclusion[]
}

const HAND_WASHES: WebsiteInclusion = { label: 'Hand washes', mode: 'per_cycle', perCycle: 4, services: ['Signature Hand Wash', 'Exterior Hand Wash'] }

/**
 * The join flow's two tiers (joinVM's T), sold online; their prices are set in Settings (pricing-defaults seeds Gold's). The perks say
 * only what the inclusions give: the member % off starts at 0 (plan decision 3), so no "member prices" line until the owner sets one.
 */
export const WEBSITE_PLANS: readonly WebsitePlan[] = [
  {
    key: 'gold',
    name: 'Gold',
    perks: ['4 hand washes a month, interior included', 'Share across household cars', 'No booking fees'],
    inclusions: [HAND_WASHES],
  },
  {
    key: 'vip',
    name: 'VIP',
    perks: ['Everything in Gold', 'Wax every wash + engine bay', 'Leather 2× and stain removal 1× a month', 'Priority booking and same-day guarantee'],
    inclusions: [
      HAND_WASHES,
      { label: 'Wax every wash', mode: 'every_visit', perCycle: null, services: ['Hand wax'] },
      { label: 'Engine bay every wash', mode: 'every_visit', perCycle: null, services: ['Engine bay wash'] },
      { label: 'Leather conditioning', mode: 'per_cycle', perCycle: 2, services: ['Leather conditioning'] },
      { label: 'Stain removal', mode: 'per_cycle', perCycle: 1, services: ['Stain removal'] },
    ],
  },
]

const ACTOR: audit.AuditContext = { actor: { name: 'Seed (website-catalog)' } }

interface Row {
  id: string
  kind: ServiceKind
  name: string
  duration_min: number
  tags: string[]
  sort: number
  active: boolean
  category: string
  public_name: string | null
  description: string | null
  vip_inclusion: VipInclusion
  vip_note: string | null
  quote_only: boolean
  visible_online: boolean
}

const FIELDS = [
  'name',
  'duration_min',
  'tags',
  'sort',
  'active',
  'category',
  'public_name',
  'description',
  'vip_inclusion',
  'vip_note',
  'quote_only',
  'visible_online',
] as const

type Desired = Pick<Row, (typeof FIELDS)[number]>

/** The row a website entry wants (no price: ADR 0170). */
export function desiredRow(s: WebsiteService): Desired {
  return {
    name: s.name,
    duration_min: s.kind === 'addon' ? 0 : s.durationMin,
    tags: s.tags,
    sort: s.sort,
    active: true,
    category: s.category,
    public_name: s.name,
    description: s.description,
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
  /** "tier: inclusion label" of every inclusion of an active tier that covers no active service after the run. */
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

  // the tint films the tint packages name (only when the setting is still empty: the owner may have edited it)
  const films = await getSetting(tx, location.id, 'catalog.tint_films')
  if (films.value.length === 0) {
    await updateSetting(tx, { locationId: location.id, key: 'catalog.tint_films', value: WEBSITE_TINT_FILMS, audit: ACTOR })
    out.settings.push('catalog.tint_films')
  }

  const claimed = new Set<string>()
  for (const s of WEBSITE_SERVICES) {
    const want = desiredRow(s)
    const row = await findRow(ctx, s, claimed)
    let id: string
    if (!row) {
      id = ctx.newId()
      await tx
        .insertInto('services')
        .values({ id, location_id: location.id, kind: s.kind, short_name: null, bookable_desk: true, sqsp_sku: null, price_cents: 0, ...want })
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
      .select(['name', 'perks', 'public'])
      .where('location_id', '=', location.id)
      .where('key', '=', p.key)
      .executeTakeFirst()
    if (!cur) {
      ctx.log(`website-catalog: no ${p.key} tier, skipped`)
      continue
    }
    const want = { name: p.name, perks: p.perks, public: true }
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

  // the tiers' inclusions: what their perks promise (review Q4 pricing:F1), written only while the tier covers no active service (a
  // fresh catalog, or one whose inclusions name services this run deactivated); the owner's own inclusions are left alone
  const activeNow = await tx.selectFrom('services').select(['id', 'name', 'kind']).where('location_id', '=', location.id).where('active', '=', true).execute()
  for (const p of WEBSITE_PLANS) {
    const plan = (await loadPlans(tx, location.id)).find((x) => x.key === p.key)
    if (!plan) continue
    if (plan.inclusions.some((r) => r.active && activeNow.some((x) => inclusionCovers(r, x.id)))) continue
    const next: InclusionInput[] = p.inclusions.map((i) => ({
      label: i.label,
      mode: i.mode,
      perCycle: i.mode === 'every_visit' ? null : i.perCycle,
      // plan decision 2: inclusions apply by themselves at completion
      autoApply: true,
      serviceIds: i.services.flatMap((name) => activeNow.filter((x) => x.name === name).map((x) => x.id)),
    })).filter((i) => i.serviceIds.length > 0)
    if (next.length === 0) continue
    await writeInclusions(tx, { newId: ctx.newId }, plan, next)
    await tx.updateTable('membership_plans').set((eb) => ({ version: eb('version', '+', 1), updated_at: eb.fn('app_now', []) })).where('id', '=', plan.id).execute()
    await audit.record(tx, {
      locationId: location.id,
      action: 'catalog.seed.plan',
      entityType: 'membership_plan',
      entityId: p.key,
      before: { inclusions: plan.inclusions.map((r) => r.label) },
      after: { inclusions: next.map((i) => ({ label: i.label, mode: i.mode, perCycle: i.perCycle, services: i.serviceIds.length })) },
      ctx: ACTOR,
    })
    if (!out.plans.includes(p.key)) out.plans.push(p.key)
  }

  if (out.created.length + out.updated.length + out.deactivated.length > 0)
    out.appointmentsUpdated = await refreshOpenAppointmentCategories(tx, location.id)

  const activeIds = (
    await tx
      .selectFrom('services')
      .select('id')
      .where('location_id', '=', location.id)
      .where('active', '=', true)
      .execute()
  ).map((r) => r.id)
  for (const p of (await loadPlans(tx, location.id)).filter((x) => x.active))
    for (const r of p.inclusions.filter((i) => i.active))
      if (!activeIds.some((id) => inclusionCovers(r, id))) out.uncoveredRules.push(`${p.key}: ${r.label}`)
  return out
}

export const websiteCatalogProfile: SeedProfile = {
  description:
    'The website’s services as the production catalog (no prices: ADR 0170): washes, add-ons, tint, details, quote-only services, the Gold/VIP tiers’ perks; other services deactivated',
  async run(ctx) {
    const r = await seedWebsiteCatalog(ctx)
    ctx.log(
      `website-catalog: ${r.created.length} created, ${r.updated.length} updated, ${r.deactivated.length} deactivated` +
        (r.deactivated.length ? ` (${r.deactivated.join(', ')})` : '') +
        `, settings ${r.settings.join(', ') || 'unchanged'}, plans ${r.plans.join(', ') || 'unchanged'}, ${r.appointmentsUpdated} visits re-categorised`,
    )
    for (const rule of r.uncoveredRules)
      ctx.log(
        `WARNING website-catalog: inclusion "${rule}" covers no active service; align it in Settings → Memberships before members redeem (ADR 0170)`,
      )
  },
}
