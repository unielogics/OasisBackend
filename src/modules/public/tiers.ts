// The tiers the website, personal links and the assistant sell (ADR 0170): every ACTIVE PUBLIC membership tier, named by its key
// (gold and vip by default). The fixed Gold -> premium / VIP -> executive mapping of ADR 0150 is gone: the tiers themselves are
// editable in Settings and premium / executive survive only as legacy keys (memberships/plans.ts planByKey). The VIP slot rules
// come from the tier's vipBooking flag, not from its key.
import type { Plan } from '../memberships/plans.js'

/** A tier's key as the public side names it (a slug). */
export type PublicTier = string

/** The tier sold online under this key: active and public; undefined otherwise (also for a legacy key). */
export const publicTierOf = (plans: readonly Plan[], key: string): Plan | undefined =>
  plans.find((p) => p.key === key && p.active && p.public)

/** The key a member's tier is shown under on the public side: its key when the tier is public, null for one never sold online. */
export const tierKeyOf = (plan: Pick<Plan, 'key' | 'public'> | undefined): PublicTier | null =>
  plan && plan.public ? plan.key : null
