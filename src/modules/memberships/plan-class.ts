// The size a membership is priced at (memberships.plan_class, ADR 0170): a covered line is covered up to that size's price, and the
// tier's current price at that size is the one billed (memberships.tier_price_id). Staff, the website's join and personal links
// name it; without one, the tier's cheapest priced size (the "from $129/month" one), else the shop's smallest size.
import type { Executor } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { loadTierCells, tierFromPrice } from '../catalog/price-book.js'
import { ensureVehicleClasses, listVehicleClasses, requireVehicleClass } from '../catalog/vehicle-classes.js'
import './problems.js'

export interface PlanClassChoice {
  classKey: string
  /** The tier's current price row at that size; null when the tier has no price there. */
  tierPriceId: string | null
  monthlyCents: number | null
}

/**
 * The plan size for a tier: `requested` (a size of the shop that is on; 422 on `path` otherwise), else the tier's cheapest priced
 * size, else the smallest size. `requirePrice`: a size the tier has no current price for is refused (422 TIER_CLASS_UNPRICED),
 * and so is a tier without any price.
 */
export async function resolvePlanClass(
  db: Executor,
  locationId: string,
  planId: string,
  o: { requested?: string | null; requirePrice?: boolean; path?: string } = {},
): Promise<PlanClassChoice> {
  // a location without sizes gets the defaults first (as the memberships_default_plan_class trigger does)
  await ensureVehicleClasses(db, locationId)
  const sizes = (await listVehicleClasses(db, locationId, { activeOnly: true })).map((c) => ({ key: c.key, label: c.label, sort: c.sort }))
  const rows = await db
    .selectFrom('membership_tier_prices')
    .select(['id', 'class_key', 'monthly_cents'])
    .where('plan_id', '=', planId)
    .where('superseded_at', 'is', null)
    .execute()
  const priceAt = (key: string) => rows.find((r) => r.class_key === key)
  let key: string | undefined
  if (o.requested) key = (await requireVehicleClass(db, locationId, o.requested, { active: true, path: o.path ?? 'planClass' })).key
  else {
    const cells = (await loadTierCells(db, locationId)).get(planId) ?? []
    key = tierFromPrice({ classes: sizes }, cells)?.classKey ?? sizes[0]?.key
  }
  if (!key) throw new AppError('VALIDATION_FAILED', { detail: 'Add a vehicle size in Settings first.', errors: [{ path: o.path ?? 'planClass', message: 'Add a vehicle size in Settings first.' }] })
  const row = priceAt(key)
  if (o.requirePrice && !row) throw new AppError('TIER_CLASS_UNPRICED', { meta: { planClass: key } })
  return { classKey: key, tierPriceId: row?.id ?? null, monthlyCents: row?.monthly_cents ?? null }
}
