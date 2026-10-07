// Plans and their credit rules: reference data every environment needs (the four design plans), read back as views.
import type { Selectable } from 'kysely'
import type { Clock } from '../../platform/clock.js'
import type { Executor } from '../../platform/db.js'
import type { NewId } from '../../platform/ids.js'
import { DESIGN_PLANS } from './design-plans.js'
import type { MembershipPlansTable, PlanCreditRulesTable, PlanKey } from './schema.js'

export interface CreditRule {
  id: string
  planId: string
  label: string
  includeTags: string[]
  excludeTags: string[]
  /** null = unlimited */
  perCycle: number | null
  /** Completing a covered visit redeems this credit by itself (default off; the member's own flag also enables it). */
  autoApply: boolean
  sort: number
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
  rules: CreditRule[]
}

const ruleOf = (r: Selectable<PlanCreditRulesTable>): CreditRule => ({
  id: r.id,
  planId: r.plan_id,
  label: r.label,
  includeTags: r.include_tags,
  excludeTags: r.exclude_tags,
  perCycle: r.per_cycle,
  autoApply: r.auto_apply,
  sort: r.sort,
})

const planOf = (p: Selectable<MembershipPlansTable>, rules: CreditRule[]): Plan => ({
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
  rules: rules.filter((r) => r.planId === p.id).sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : 1)),
})

/** Inserts the four design plans and their rules when missing (matched by plan key, rules by label). Cheap when present. */
export async function ensurePlans(
  db: Executor,
  d: { locationId: string; clock: Clock; newId: NewId },
): Promise<void> {
  const have = await db
    .selectFrom('membership_plans')
    .select(['id', 'key'])
    .where('location_id', '=', d.locationId)
    .execute()
  const now = d.clock.now()
  for (const [i, p] of DESIGN_PLANS.entries()) {
    let id = have.find((h) => h.key === p.key)?.id
    if (!id) {
      id = d.newId()
      await db
        .insertInto('membership_plans')
        .values({
          id,
          location_id: d.locationId,
          key: p.key,
          name: p.name,
          color: p.color,
          bg_color: p.bgColor,
          tint: p.tint,
          sort: i,
          perks: p.perks,
          addon_discount_bp: p.addonDiscountBp,
          service_discount_bp: p.serviceDiscountBp,
          billing_interval_months: 1,
          created_at: now,
          updated_at: now,
        })
        .onConflict((oc) => oc.columns(['location_id', 'key']).doNothing())
        .execute()
      id = (
        await db
          .selectFrom('membership_plans')
          .select('id')
          .where('location_id', '=', d.locationId)
          .where('key', '=', p.key)
          .executeTakeFirstOrThrow()
      ).id
    }
    const rules = await db.selectFrom('plan_credit_rules').select('label').where('plan_id', '=', id).execute()
    for (const [j, r] of p.rules.entries()) {
      if (rules.some((x) => x.label === r.label)) continue
      await db
        .insertInto('plan_credit_rules')
        .values({
          id: d.newId(),
          plan_id: id,
          label: r.label,
          include_tags: r.includeTags,
          exclude_tags: r.excludeTags ?? [],
          per_cycle: r.perCycle,
          sort: j,
          created_at: now,
        })
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
  const rules = await db
    .selectFrom('plan_credit_rules')
    .selectAll()
    .where(
      'plan_id',
      'in',
      plans.map((p) => p.id),
    )
    .execute()
  const mapped = rules.map(ruleOf)
  return plans.map((p) => planOf(p, mapped))
}

export const planByKey = (plans: readonly Plan[], key: PlanKey): Plan | undefined =>
  plans.find((p) => p.key === key)

/** A credit covers a visit of a service whose tags include any of the rule's include tags and none of its exclude tags. */
export function ruleCovers(
  rule: Pick<CreditRule, 'includeTags' | 'excludeTags'>,
  serviceTags: readonly string[],
): boolean {
  return (
    rule.includeTags.some((t) => serviceTags.includes(t)) &&
    !rule.excludeTags.some((t) => serviceTags.includes(t))
  )
}
