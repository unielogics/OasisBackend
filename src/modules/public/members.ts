// What the website may know about a verified member: first name, the tier the site sells (or null for a plan it does not), the
// washes left this cycle, and whether the membership is active (the fee waiver); since ADR 0170 also the tier's name, the size the
// membership is priced at and the member % off. A household member (membership_household) counts as the member: the membership and
// its credits are shared. Read from the same memberships rows and credit ledger the Membership tab reads. Nothing else of the
// customer leaves here.
import type { Executor } from '../../platform/db.js'
import type { CustomerRecord } from '../customers/service.js'
import { membershipOfCustomer } from '../catalog/price-book.js'
import { creditSummaries } from '../memberships/credits.js'
import { loadPlans } from '../memberships/plans.js'
import { tierKeyOf, type PublicTier } from './tiers.js'

export interface MemberView {
  /** "" when the number belongs to nobody yet. */
  firstName: string
  tier: PublicTier | null
  /** Washes left this cycle for an active member; null when unlimited, not a member, or not active. */
  washesLeft: number | null
  /** The plan label as sold ("Gold"), null for a non-member. */
  plan: string | null
  /** An active membership: no booking fee. */
  active: boolean
  /** The tier's name ("Gold"); null for a non-member. */
  tierName: string | null
  /** The size the membership is priced at (a size key); null for a non-member. */
  planClass: string | null
  /** The member % off, in basis points (0 for a non-member). */
  memberDiscountBp: number
}

export const NOBODY: MemberView = {
  firstName: '',
  tier: null,
  washesLeft: null,
  plan: null,
  active: false,
  tierName: null,
  planClass: null,
  memberDiscountBp: 0,
}

/** The ACTIVE membership the customer holds or shares as a live household member (their own first); undefined otherwise. */
export async function activeMembership(
  db: Executor,
  customerId: string,
): Promise<
  | { id: string; planId: string; planLabel: string; planClass: string; currentPeriodStart: Date | null; viaHousehold: boolean }
  | undefined
> {
  const ref = await membershipOfCustomer(db, customerId)
  if (!ref) return undefined
  const m = await db
    .selectFrom('memberships')
    .select(['id', 'plan_id', 'plan_label', 'plan_class', 'current_period_start'])
    .where('id', '=', ref.id)
    .executeTakeFirst()
  return m
    ? {
        id: m.id,
        planId: m.plan_id,
        planLabel: m.plan_label,
        planClass: m.plan_class,
        currentPeriodStart: m.current_period_start,
        viaHousehold: ref.viaHousehold,
      }
    : undefined
}

export async function memberView(
  db: Executor,
  locationId: string,
  customer: CustomerRecord | undefined,
): Promise<MemberView> {
  if (!customer) return NOBODY
  const firstName = customer.needsDetails ? '' : (customer.fullName.trim().split(/\s+/)[0] ?? '')
  const m = await activeMembership(db, customer.id)
  if (!m) return { ...NOBODY, firstName }
  const plans = await loadPlans(db, locationId)
  const plan = plans.find((p) => p.id === m.planId)
  const credits = plan
    ? (await creditSummaries(db, [{ id: m.id, planId: m.planId, currentPeriodStart: m.currentPeriodStart }], plans)).get(m.id)
    : undefined
  return {
    firstName,
    tier: tierKeyOf(plan),
    washesLeft: credits?.creditsLeft ?? null,
    plan: m.planLabel,
    active: true,
    tierName: plan?.name ?? m.planLabel,
    planClass: m.planClass,
    memberDiscountBp: plan?.memberDiscountBp ?? 0,
  }
}
