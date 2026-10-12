// Seed profile `pricing-defaults` (ADR 0170, plan decision 3): the two prices the owner gave, so the website can say "from $40" and
// "from $129/month" while the rest of the grid is filled in Settings.
//
//   Signature Hand Wash at Compact car   $40   (the cheapest active wash when the catalog has no Signature Hand Wash)
//   Gold at Compact car                   $129 a month
//   member % off                          0 (the default; not touched)
//
// Every other cell stays empty. It fills only empty cells: a price already set (by the owner, or an earlier run) is never changed,
// so it is idempotent and safe to run after the grid was edited. Compact car is the location's `compact_car` size, or its smallest
// active size when that key is gone. Writes go through the same commands as Settings (catalog.price.update, catalog.tier_price.update,
// settings.changed), audited under the actor "Seed (pricing-defaults)". Run in production after the deploy (rollout step 1).
import { putClassPrices } from '../../src/modules/catalog/class-prices.js'
import { putTierPrices } from '../../src/modules/catalog/tiers.js'
import { ensurePlans, loadPlans, planByKey } from '../../src/modules/memberships/plans.js'
import { ensureDomainDefaults } from '../../src/modules/settings/defaults.js'
import type * as audit from '../../src/platform/audit.js'
import type { SeedContext, SeedProfile } from './index.js'

export const PRICING_DEFAULTS = {
  washName: 'Signature Hand Wash',
  washCents: 4000,
  tierKey: 'gold',
  tierMonthlyCents: 12900,
  classKey: 'compact_car',
} as const

const ACTOR: audit.AuditContext = { actor: { name: 'Seed (pricing-defaults)' } }

export interface PricingDefaultsResult {
  /** The size the defaults went to. */
  classKey: string | null
  /** "Signature Hand Wash" when its cell was filled, null when it already had a price (or no wash exists). */
  wash: string | null
  /** The tier whose price was filled, null when it already had one (or no Gold tier exists). */
  tier: string | null
  skipped: string[]
}

export async function seedPricingDefaults(ctx: SeedContext): Promise<PricingDefaultsResult> {
  const { tx, location } = ctx
  await ensureDomainDefaults(tx, location.id)
  await ensurePlans(tx, { locationId: location.id, clock: ctx.clock, newId: ctx.newId })
  const out: PricingDefaultsResult = { classKey: null, wash: null, tier: null, skipped: [] }

  const classes = await tx
    .selectFrom('vehicle_classes')
    .select(['key', 'active'])
    .where('location_id', '=', location.id)
    .orderBy('sort')
    .orderBy('key')
    .execute()
  const cls = classes.find((c) => c.key === PRICING_DEFAULTS.classKey) ?? classes.find((c) => c.active)
  if (!cls) {
    out.skipped.push('no vehicle size')
    return out
  }
  out.classKey = cls.key

  // the wash: Signature Hand Wash, else the cheapest active wash
  const washes = await tx
    .selectFrom('services')
    .select(['id', 'name', 'version', 'price_cents'])
    .where('location_id', '=', location.id)
    .where('kind', '=', 'package')
    .where('active', '=', true)
    .where('quote_only', '=', false)
    .where('category', '=', 'wash')
    .orderBy('price_cents')
    .orderBy('sort')
    .orderBy('name')
    .execute()
  const wash = washes.find((w) => w.name.toLowerCase() === PRICING_DEFAULTS.washName.toLowerCase()) ?? washes[0]
  if (!wash) out.skipped.push('no active wash')
  else {
    const set = await tx
      .selectFrom('service_class_prices')
      .select('price_cents')
      .where('service_id', '=', wash.id)
      .where('class_key', '=', cls.key)
      .executeTakeFirst()
    if (set) out.skipped.push(`${wash.name} already has a ${cls.key} price`)
    else {
      await putClassPrices(tx, {
        locationId: location.id,
        rows: [{ serviceId: wash.id, version: wash.version, cells: [{ class: cls.key, cents: PRICING_DEFAULTS.washCents, maxCents: null }] }],
        userId: null,
        audit: ACTOR,
      })
      out.wash = wash.name
    }
  }

  // the tier: Gold (or the tier that carries the old premium key)
  const tier = planByKey(await loadPlans(tx, location.id), PRICING_DEFAULTS.tierKey)
  if (!tier) out.skipped.push('no Gold tier')
  else {
    const set = await tx
      .selectFrom('membership_tier_prices')
      .select('id')
      .where('plan_id', '=', tier.id)
      .where('class_key', '=', cls.key)
      .where('superseded_at', 'is', null)
      .executeTakeFirst()
    if (set) out.skipped.push(`${tier.name} already has a ${cls.key} price`)
    else {
      await putTierPrices(
        tx,
        { newId: ctx.newId, now: ctx.clock.now() },
        {
          locationId: location.id,
          rows: [{ tierKey: tier.key, priceVersion: tier.priceVersion, cells: [{ class: cls.key, monthlyCents: PRICING_DEFAULTS.tierMonthlyCents }] }],
          userId: null,
          audit: ACTOR,
        },
      )
      out.tier = tier.name
    }
  }
  return out
}

export const pricingDefaultsProfile: SeedProfile = {
  description:
    'The owner’s two starting prices (ADR 0170): Signature Hand Wash at Compact car $40 and Gold at Compact car $129/month; fills only empty cells',
  async run(ctx) {
    const r = await seedPricingDefaults(ctx)
    ctx.log(
      `pricing-defaults: size ${r.classKey ?? '-'}, wash ${r.wash ?? 'unchanged'}, tier ${r.tier ?? 'unchanged'}` +
        (r.skipped.length ? ` (${r.skipped.join('; ')})` : ''),
    )
  },
}
