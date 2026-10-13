// Tiers (membership_plans) and what they include, read back as views; the design's four tiers are reference data every environment
// needs (ensurePlans). ADR 0170: a tier's key is a slug (gold and vip by default; the old premium and executive stay as legacyKey);
// what a tier includes is a list of inclusions that name the services they cover (membership_inclusions), which replaced the
// tag-based plan_credit_rules (kept, read only, as history: migration 20261014100100 copied every rule to an inclusion with the
// same id and the services its tags covered).
import type { Selectable } from 'kysely'
import type { Clock } from '../../platform/clock.js'
import type { Executor } from '../../platform/db.js'
import type { NewId } from '../../platform/ids.js'
import { DESIGN_PLANS } from './design-plans.js'
import type { InclusionMode, MembershipInclusionsTable, MembershipPlansTable, PlanKey } from './schema.js'
import '../catalog/schema.js'

export interface Inclusion {
  id: string
  planId: string
  label: string
  /** per_cycle: perCycle visits a billing cycle (null = unlimited); every_visit: on every visit while the membership is active. */
  mode: InclusionMode
  /** null = unlimited (always null for every_visit) */
  perCycle: number | null
  /** Completing a covered visit applies it by itself (the member's own flag also enables it). */
  autoApply: boolean
  sort: number
  active: boolean
  /** The services it covers. */
  serviceIds: string[]
}

export interface Plan {
  id: string
  key: PlanKey
  name: string
  color: string
  bgColor: string
  tint: string
  sort: number
  perks: string[]
  addonDiscountBp: number
  serviceDiscountBp: number
  billingIntervalMonths: number
  active: boolean
  /** The member % off every line the membership does not cover, in basis points. */
  memberDiscountBp: number
  /** Sold on the website and by the assistant. */
  public: boolean
  /** Members get the VIP slot rules. */
  vipBooking: boolean
  maxVehicles: number | null
  priceVersion: number
  /** The key before ADR 0170 (premium, executive), which old Squarespace product names and links still use. */
  legacyKey: string | null
  inclusions: Inclusion[]
}

const inclusionOf = (r: Selectable<MembershipInclusionsTable>, serviceIds: string[]): Inclusion => ({
  id: r.id,
  planId: r.plan_id,
  label: r.label,
  mode: r.mode,
  perCycle: r.mode === 'every_visit' ? null : r.per_cycle,
  autoApply: r.auto_apply,
  sort: r.sort,
  active: r.active,
  serviceIds,
})

const planOf = (p: Selectable<MembershipPlansTable>, inclusions: Inclusion[]): Plan => ({
  id: p.id,
  key: p.key,
  name: p.name,
  color: p.color,
  bgColor: p.bg_color,
  tint: p.tint,
  sort: p.sort,
  perks: p.perks,
  addonDiscountBp: p.addon_discount_bp,
  serviceDiscountBp: p.service_discount_bp,
  billingIntervalMonths: p.billing_interval_months,
  active: p.active,
  memberDiscountBp: p.member_discount_bp,
  public: p.public,
  vipBooking: p.vip_booking,
  maxVehicles: p.max_vehicles,
  priceVersion: p.price_version,
  legacyKey: p.legacy_key,
  inclusions: inclusions.filter((r) => r.planId === p.id).sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : 1)),
})

/**
 * Inserts the design's tiers and their inclusions for a location that has no tier at all (staff edit, add and delete tiers in
 * Settings afterwards; nothing here brings a deleted tier or inclusion back). A new inclusion covers the location's services that
 * carry its rule's tags at that moment. Cheap when present.
 */
export async function ensurePlans(db: Executor, d: { locationId: string; clock: Clock; newId: NewId }): Promise<void> {
  const any = await db.selectFrom('membership_plans').select('id').where('location_id', '=', d.locationId).limit(1).executeTakeFirst()
  if (any) return
  const now = d.clock.now()
  const services = await db.selectFrom('services').select(['id', 'tags']).where('location_id', '=', d.locationId).execute()
  for (const [i, p] of DESIGN_PLANS.entries()) {
    const inserted = await db
      .insertInto('membership_plans')
      .values({
        id: d.newId(),
        location_id: d.locationId,
        key: p.key,
        legacy_key: p.legacyKey,
        name: p.name,
        color: p.color,
        bg_color: p.bgColor,
        tint: p.tint,
        sort: i,
        perks: p.perks,
        addon_discount_bp: p.addonDiscountBp,
        service_discount_bp: p.serviceDiscountBp,
        billing_interval_months: 1,
        public: p.public,
        vip_booking: p.vipBooking,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.columns(['location_id', 'key']).doNothing())
      .returning('id')
      .executeTakeFirst()
    if (!inserted) continue // a concurrent caller created it
    for (const [j, r] of p.rules.entries()) {
      const inclusionId = d.newId()
      await db
        .insertInto('membership_inclusions')
        .values({
          id: inclusionId,
          plan_id: inserted.id,
          label: r.label,
          mode: 'per_cycle',
          per_cycle: r.perCycle,
          // applied by itself when a covered visit is completed (plan decision 2; sandbox run F1): what the booking and the quote
          // showed as covered is what the invoice covers. The owner may turn it off per inclusion in Settings.
          auto_apply: true,
          sort: j,
          created_at: now,
          updated_at: now,
        })
        .execute()
      const covered = services.filter((s) => tagsCover(r.includeTags, r.excludeTags ?? [], s.tags)).map((s) => s.id)
      if (covered.length > 0)
        await db
          .insertInto('membership_inclusion_services')
          .values(covered.map((serviceId) => ({ inclusion_id: inclusionId, service_id: serviceId })))
          .onConflict((oc) => oc.doNothing())
          .execute()
    }
  }
}

export async function loadPlans(db: Executor, locationId: string): Promise<Plan[]> {
  const plans = await db
    .selectFrom('membership_plans')
    .selectAll()
    .where('location_id', '=', locationId)
    .orderBy('sort')
    .orderBy('key')
    .execute()
  if (plans.length === 0) return []
  const inclusions = await db
    .selectFrom('membership_inclusions')
    .selectAll()
    .where(
      'plan_id',
      'in',
      plans.map((p) => p.id),
    )
    .execute()
  const links = inclusions.length
    ? await db
        .selectFrom('membership_inclusion_services')
        .select(['inclusion_id', 'service_id'])
        .where(
          'inclusion_id',
          'in',
          inclusions.map((r) => r.id),
        )
        .orderBy('service_id')
        .execute()
    : []
  const mapped = inclusions.map((r) =>
    inclusionOf(
      r,
      links.filter((l) => l.inclusion_id === r.id).map((l) => l.service_id),
    ),
  )
  return plans.map((p) => planOf(p, mapped))
}

/** The tier with this key, or whose old key (premium, executive) this is. */
export const planByKey = (plans: readonly Plan[], key: string): Plan | undefined =>
  plans.find((p) => p.key === key) ?? plans.find((p) => p.legacyKey === key)

/** The tag rule of the old plan_credit_rules (and the design's rules): any include tag and no exclude tag. */
export function tagsCover(includeTags: readonly string[], excludeTags: readonly string[], serviceTags: readonly string[]): boolean {
  return includeTags.some((t) => serviceTags.includes(t)) && !excludeTags.some((t) => serviceTags.includes(t))
}

/** The inclusion covers the service (it is on and names it). */
export const inclusionCovers = (inc: Pick<Inclusion, 'active' | 'serviceIds'>, serviceId: string): boolean =>
  inc.active && inc.serviceIds.includes(serviceId)
