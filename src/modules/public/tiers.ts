// The website sells two plans, Gold and VIP ("Oasis Site v2"); the dashboard's membership plans are the Operations design's four
// (essential, premium, executive, exotic). The website's tier is a label over a dashboard plan (ADR 0150): joining Gold creates
// a membership of the mapped plan with plan_label "Gold", so the board, the Membership tab and the Squarespace product map keep
// working unchanged. The site shows its own prices as static content; the plans carry none.
import type { PlanKey } from '../memberships/schema.js'

export type PublicTier = 'gold' | 'vip'

export interface TierSpec {
  key: PublicTier
  /** The label the membership is sold under (memberships.plan_label). */
  label: string
  planKey: PlanKey
}

export const PUBLIC_TIERS: readonly TierSpec[] = [
  { key: 'gold', label: 'Gold', planKey: 'premium' },
  { key: 'vip', label: 'VIP', planKey: 'executive' },
]

export const tierSpec = (tier: PublicTier): TierSpec => PUBLIC_TIERS.find((t) => t.key === tier)!

/** The website tier of a dashboard plan, or null for a plan the website does not sell (still a member: no fee). */
export const tierOfPlan = (planKey: string): PublicTier | null =>
  PUBLIC_TIERS.find((t) => t.planKey === planKey)?.key ?? null
