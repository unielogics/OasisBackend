// What the website may know about a verified member: first name, the tier the site sells (or null for a plan it does not), the
// washes left this cycle, and whether the membership is active (the fee waiver). Read from the same memberships rows and credit
// ledger the Membership tab reads. Nothing else of the customer leaves here.
import type { Executor } from '../../platform/db.js'
import type { CustomerRecord } from '../customers/service.js'
import { creditSummaries } from '../memberships/credits.js'
import { loadPlans } from '../memberships/plans.js'
import { tierOfPlan, type PublicTier } from './tiers.js'

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
}

export const NOBODY: MemberView = { firstName: '', tier: null, washesLeft: null, plan: null, active: false }

/** The customer's live membership when it is active; undefined otherwise. */
export async function activeMembership(
  db: Executor,
  customerId: string,
): Promise<{ id: string; planId: string; planLabel: string; currentPeriodStart: Date | null } | undefined> {
  const m = await db
    .selectFrom('memberships')
    .select(['id', 'plan_id', 'plan_label', 'current_period_start'])
    .where('customer_id', '=', customerId)
    .where('status', '=', 'active')
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst()
  return m ? { id: m.id, planId: m.plan_id, planLabel: m.plan_label, currentPeriodStart: m.current_period_start } : undefined
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
    tier: plan ? tierOfPlan(plan.key) : null,
    washesLeft: credits?.creditsLeft ?? null,
    plan: m.planLabel,
    active: true,
  }
}
