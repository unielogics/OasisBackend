// The real MembershipPort for the scheduling module: an entry for every appointment whose client is an ACTIVE member, with the
// credits left this cycle, whether an unused eligible credit exists for that appointment, and the display data of the
// Membership tab (renewal date, perks, plan colours, months active, retention label). Batched: a board of 40 appointments is
// a handful of queries, not 40.
import { sql } from 'kysely'
import type { Executor } from '../../platform/db.js'
import type { MembershipInfo, MembershipPort, MembershipRef } from '../scheduling/ports.js'
import { creditSummaries, eligibleRule } from './credits.js'
import { loadPlans } from './plans.js'
import { memberMonths, retentionOf, visitCounts } from './retention.js'
import { locationTz, renewLabelOf } from './view.js'

export const dbMembershipPort: MembershipPort = {
  async forAppointments(db: Executor, refs: MembershipRef[]): Promise<Map<string, MembershipInfo>> {
    const out = new Map<string, MembershipInfo>()
    if (refs.length === 0) return out
    const customerIds = [...new Set(refs.map((r) => r.customerId))]
    const members = await db
      .selectFrom('memberships')
      .selectAll()
      .where('customer_id', 'in', customerIds)
      .where('status', '=', 'active')
      .execute()
    if (members.length === 0) return out
    const locationId = members[0]!.location_id
    const now = (await sql<{ now: Date }>`select app_now() as now`.execute(db)).rows[0]!.now
    const tz = await locationTz(db, locationId)
    const plans = await loadPlans(db, locationId)
    const credits = await creditSummaries(
      db,
      members.map((m) => ({ id: m.id, planId: m.plan_id, currentPeriodStart: m.current_period_start })),
      plans,
    )
    const counts = await visitCounts(db, locationId, [...new Set(members.map((m) => m.customer_id))], now)
    const apptIds = refs.map((r) => r.appointmentId)
    const tags = await sql<{ id: string; tags: string[]; redeemed: boolean }>`
      select a.id, s.tags,
        exists (select 1 from membership_credit_events e where e.appointment_id = a.id and e.kind = 'redeem') as redeemed
      from appointments a join services s on s.id = a.service_id
      where a.id = any(${apptIds}::uuid[])`.execute(db)
    const tagsOf = new Map(tags.rows.map((t) => [t.id, t]))
    for (const r of refs) {
      const m = members.find((x) => x.customer_id === r.customerId)
      if (!m) continue
      const plan = plans.find((p) => p.id === m.plan_id)
      if (!plan) continue
      const cs = credits.get(m.id)!
      const t = tagsOf.get(r.appointmentId)
      const rule = t && !t.redeemed ? eligibleRule(plan, cs, t.tags) : undefined
      const ret = retentionOf(counts.get(m.customer_id) ?? { cur30: 0, prev30: 0 }, m.started_at, now)
      out.set(r.appointmentId, {
        plan: m.plan_label,
        creditsLeft: cs.creditsLeft,
        creditAvailable: rule?.covered === true,
        planKey: plan.key,
        renewsAt: m.current_period_end?.toISOString() ?? null,
        renewLabel: m.current_period_end ? renewLabelOf(m.current_period_end, tz) : null,
        creditsUsed: cs.creditsUsed,
        perks: plan.perks,
        color: plan.color,
        bgColor: plan.bgColor,
        tint: plan.tint,
        memberMonths: memberMonths(m.started_at, now),
        retention: { label: ret.label, desc: ret.desc, tone: ret.tone },
      })
    }
    return out
  },
}
