// Seed profile "memberships": the four plans with the design's perks, colours and credit rules (review B12), and the design's
// members as manual memberships (Maria Essential, Priya Premium, Jonathan Premium Care, Sofia Executive, Aisha and Elena Exotic,
// Nathan Essential; scheduling.ts PARITY_OPS_MEMBERS). They carry NO Squarespace ids: a real subscription order takes over by
// email, phone or customer link. The renewal is Jul 12 (the design's date) at the parity clock, months active follow the
// design's `8 + visits % 6`, and Priya has used one of her two Premium credits this cycle (the design's "creditsUsed 1").
import { sql } from 'kysely'
import { DESIGN_PLANS } from '../../src/modules/memberships/design-plans.js'
import { grantCycleCredits } from '../../src/modules/memberships/credits.js'
import { ensurePlans, loadPlans } from '../../src/modules/memberships/plans.js'
import type { PlanKey } from '../../src/modules/memberships/schema.js'
import { addMonths } from '../../src/modules/payments-sync/membership.js'
import { addDays, bizDayBounds, toBizDate } from '../../src/platform/time.js'
import type { SeedProfile } from './index.js'
import { PARITY_OPS_MEMBERS } from './scheduling.js'

/** The design's `visits` for each member's appointment (cc-domain 7.5), which drives months active (8 + visits % 6). */
const DESIGN_VISITS: Readonly<Record<string, number>> = {
  'Maria Delgado': 3,
  'Priya Nair': 5,
  'Jonathan Franco': 6,
  'Sofia Marchetti': 7,
  'Aisha Rahman': 11,
  'Elena Volkov': 4,
  'Nathan Brooks': 5,
}

const planKeyOf = (label: string): PlanKey => label.split(' ')[0]!.toLowerCase() as PlanKey

export const membershipsProfile: SeedProfile = {
  description:
    'Membership plans and credit rules, plus the design members (manual, no Squarespace ids) with this cycle’s credits',
  dependsOn: ['design'],
  async run(ctx) {
    const { tx, clock, newId, location } = ctx
    const d = { locationId: location.id, clock, newId }
    await ensurePlans(tx, d)
    const plans = await loadPlans(tx, location.id)
    const now = clock.now()
    const tz = location.timezone
    const periodStart = bizDayBounds(addDays(toBizDate(now, tz), -1), tz).start
    const periodEnd = addMonths(periodStart, 1)
    let made = 0
    for (const [name, label] of Object.entries(PARITY_OPS_MEMBERS)) {
      const customer = await tx
        .selectFrom('customers')
        .select('id')
        .where('full_name', '=', name)
        .where('deleted_at', 'is', null)
        .where('merged_into', 'is', null)
        .executeTakeFirst()
      if (!customer) {
        ctx.log(`memberships: no customer named ${name}, skipped`)
        continue
      }
      const live = await tx
        .selectFrom('memberships')
        .select('id')
        .where('customer_id', '=', customer.id)
        .where('status', 'in', ['pending', 'active', 'past_due', 'paused'])
        .executeTakeFirst()
      if (live) continue
      const plan = plans.find((p) => p.key === planKeyOf(label))!
      const months = 8 + ((DESIGN_VISITS[name] ?? 0) % 6)
      const id = newId()
      await tx
        .insertInto('memberships')
        .values({
          id,
          location_id: location.id,
          customer_id: customer.id,
          plan_id: plan.id,
          plan_label: label,
          status: 'active',
          source: 'manual',
          started_at: addMonths(now, -months),
          current_period_start: periodStart,
          current_period_end: periodEnd,
          manual_status_at: now,
          created_at: now,
          updated_at: now,
        })
        .execute()
      await grantCycleCredits(tx, d, { id, currentPeriodStart: periodStart }, plan, 'Seed')
      if (name === 'Priya Nair') {
        const rule = plan.rules[0]!
        await sql`
          insert into membership_credit_events (id, membership_id, cycle_start, kind, qty, rule_id, note, actor, idempotency_key, created_at)
          values (${newId()}, ${id}, ${periodStart}, 'redeem', 1, ${rule.id}, 'Seed: an earlier visit this cycle', 'Seed',
            ${`seed:redeem:${id}`}, ${now})
          on conflict (idempotency_key) do nothing`.execute(tx)
      }
      made++
    }
    ctx.log(`memberships: ${DESIGN_PLANS.length} plans, ${made} design members`)
  },
}

export const membershipsSeedProfiles: Record<string, SeedProfile> = { memberships: membershipsProfile }
