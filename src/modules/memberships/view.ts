// Read models of memberships: what the Operations Membership tab, the card badge and the Customer file need, computed from the
// member row, the plan, the cycle's credit events and the visit history. Percent perks (addon and service discount) are
// returned as display data only.
import type { Selectable } from 'kysely'
import { DateTime } from 'luxon'
import type { Executor } from '../../platform/db.js'
import { creditSummaries, type CreditSummary } from './credits.js'
import { loadPlans, type Plan } from './plans.js'
import { memberMonths, retentionOf, visitCounts, type Retention } from './retention.js'
import type { MembershipsTable, MembershipSource, MembershipStatus } from './schema.js'

export type MembershipRow = Selectable<MembershipsTable>

export interface MembershipView {
  id: string
  customerId: string
  status: MembershipStatus
  source: MembershipSource
  plan: {
    key: Plan['key']
    name: string
    /** What was sold ("Premium Care"). */
    label: string
    color: string
    bgColor: string
    tint: string
    perks: string[]
    addonDiscountBp: number
    serviceDiscountBp: number
  }
  startedAt: string
  memberMonths: number
  currentPeriodStart: string | null
  renewsAt: string | null
  renewLabel: string | null
  inGrace: boolean
  canceledAt: string | null
  autoApply: boolean
  credits: {
    cycleStart: string | null
    left: number | null
    used: number
    rules: CreditSummary['rules']
  }
  retention: Retention
  flags: { code: string; orderId?: string; note: string }[]
  inferenceReason: string | null
  lastSqspOrderId: string | null
  version: number
}

export const renewLabelOf = (d: Date, tz: string): string =>
  DateTime.fromJSDate(d, { zone: tz }).toFormat('LLL d, yyyy')

export async function viewsOf(
  db: Executor,
  c: { locationId: string; now: Date; tz: string },
  rows: readonly MembershipRow[],
): Promise<MembershipView[]> {
  if (rows.length === 0) return []
  const plans = await loadPlans(db, c.locationId)
  const credits = await creditSummaries(
    db,
    rows.map((r) => ({ id: r.id, planId: r.plan_id, currentPeriodStart: r.current_period_start })),
    plans,
  )
  const counts = await visitCounts(db, c.locationId, [...new Set(rows.map((r) => r.customer_id))], c.now)
  return rows.map((r) => {
    const plan = plans.find((p) => p.id === r.plan_id)!
    const cs = credits.get(r.id)!
    return {
      id: r.id,
      customerId: r.customer_id,
      status: r.status,
      source: r.source,
      plan: {
        key: plan.key,
        name: plan.name,
        label: r.plan_label,
        color: plan.color,
        bgColor: plan.bgColor,
        tint: plan.tint,
        perks: plan.perks,
        addonDiscountBp: plan.addonDiscountBp,
        serviceDiscountBp: plan.serviceDiscountBp,
      },
      startedAt: r.started_at.toISOString(),
      memberMonths: memberMonths(r.started_at, c.now),
      currentPeriodStart: r.current_period_start?.toISOString() ?? null,
      renewsAt: r.current_period_end?.toISOString() ?? null,
      renewLabel: r.current_period_end ? renewLabelOf(r.current_period_end, c.tz) : null,
      inGrace: r.in_grace,
      canceledAt: r.canceled_at?.toISOString() ?? null,
      autoApply: r.auto_apply,
      credits: {
        cycleStart: cs.cycleStart?.toISOString() ?? null,
        left: cs.creditsLeft,
        used: cs.creditsUsed,
        rules: cs.rules,
      },
      retention: retentionOf(counts.get(r.customer_id) ?? { cur30: 0, prev30: 0 }, r.started_at, c.now),
      flags: r.review_flags as MembershipView['flags'],
      inferenceReason: r.inference_reason,
      lastSqspOrderId: r.last_sqsp_order_id,
      version: r.version,
    }
  })
}

export async function locationTz(db: Executor, locationId: string): Promise<string> {
  return (
    (await db.selectFrom('locations').select('timezone').where('id', '=', locationId).executeTakeFirst())?.timezone ??
    'America/New_York'
  )
}
