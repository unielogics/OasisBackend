// Credits of the current membership cycle. The ledger of credit events is append-only: a cycle grant per rule (qty = the
// rule's per_cycle, or null for an unlimited rule), redeems when a credit is applied to a visit. "Left" is derived: grants
// minus redeems (plus restores) for the cycle that started at memberships.current_period_start, over the rules of the member's
// CURRENT plan, so a tier change starts the new plan's credits without touching history.
import { sql } from 'kysely'
import type { Clock } from '../../platform/clock.js'
import type { Executor } from '../../platform/db.js'
import type { NewId } from '../../platform/ids.js'
import { ruleCovers, type CreditRule, type Plan } from './plans.js'

export interface RuleCredit {
  ruleId: string
  label: string
  unlimited: boolean
  /** null when unlimited */
  granted: number | null
  used: number
  /** null when unlimited */
  left: number | null
}

export interface CreditSummary {
  cycleStart: Date | null
  rules: RuleCredit[]
  /** null = unlimited (shown as the infinity sign): at least one rule has no cap */
  creditsLeft: number | null
  creditsUsed: number
}

export interface CycleRef {
  id: string
  planId: string
  currentPeriodStart: Date | null
}

export async function creditSummaries(
  db: Executor,
  members: readonly CycleRef[],
  plans: readonly Plan[],
): Promise<Map<string, CreditSummary>> {
  const out = new Map<string, CreditSummary>()
  const withCycle = members.filter((m) => m.currentPeriodStart !== null)
  const events = withCycle.length
    ? await db
        .selectFrom('membership_credit_events')
        .select(['membership_id', 'cycle_start', 'kind', 'qty', 'rule_id'])
        .where(
          'membership_id',
          'in',
          withCycle.map((m) => m.id),
        )
        .execute()
    : []
  for (const m of members) {
    const plan = plans.find((p) => p.id === m.planId)
    const mine = events.filter(
      (e) => e.membership_id === m.id && m.currentPeriodStart && e.cycle_start.getTime() === m.currentPeriodStart.getTime(),
    )
    const rules: RuleCredit[] = (plan?.rules ?? []).map((r) => {
      const grants = mine.filter((e) => e.kind === 'grant' && e.rule_id === r.id)
      const granted = grants.length ? (grants.some((g) => g.qty === null) ? null : grants.reduce((n, g) => n + (g.qty ?? 0), 0)) : r.perCycle
      const used =
        mine.filter((e) => e.kind === 'redeem' && e.rule_id === r.id).reduce((n, e) => n + (e.qty ?? 0), 0) -
        mine.filter((e) => (e.kind === 'restore' || e.kind === 'protect') && e.rule_id === r.id).reduce((n, e) => n + (e.qty ?? 0), 0)
      return {
        ruleId: r.id,
        label: r.label,
        unlimited: granted === null,
        granted,
        used: Math.max(0, used),
        left: granted === null ? null : Math.max(0, granted - Math.max(0, used)),
      }
    })
    const unlimited = rules.some((r) => r.unlimited)
    out.set(m.id, {
      cycleStart: m.currentPeriodStart,
      rules,
      creditsLeft: m.currentPeriodStart === null ? 0 : unlimited ? null : rules.reduce((n, r) => n + (r.left ?? 0), 0),
      creditsUsed: rules.reduce((n, r) => n + r.used, 0),
    })
  }
  return out
}

/** The first rule (in plan order) that covers the service tags and still has a credit this cycle. */
export function eligibleRule(
  plan: Plan,
  summary: CreditSummary,
  serviceTags: readonly string[],
): { rule: CreditRule; covered: boolean } | undefined {
  const covering = plan.rules.filter((r) => ruleCovers(r, serviceTags))
  if (covering.length === 0) return undefined
  for (const r of covering) {
    const c = summary.rules.find((x) => x.ruleId === r.id)
    if (c && (c.unlimited || (c.left ?? 0) > 0)) return { rule: r, covered: true }
  }
  return { rule: covering[0]!, covered: false }
}

/** Writes the cycle's grant events for every rule of the plan; idempotent per membership, cycle and rule. Returns how many were new. */
export async function grantCycleCredits(
  db: Executor,
  d: { clock: Clock; newId: NewId },
  m: { id: string; currentPeriodStart: Date },
  plan: Plan,
  actor = 'System',
): Promise<number> {
  let n = 0
  for (const r of plan.rules) {
    const res = await sql`
      insert into membership_credit_events (id, membership_id, cycle_start, kind, qty, rule_id, note, actor, idempotency_key, created_at)
      values (${d.newId()}, ${m.id}, ${m.currentPeriodStart}, 'grant', ${r.perCycle}, ${r.id}, 'Cycle credits', ${actor},
        ${`grant:${m.id}:${m.currentPeriodStart.toISOString()}:${r.id}`}, ${d.clock.now()})
      on conflict (idempotency_key) do nothing`.execute(db)
    n += Number(res.numAffectedRows ?? 0)
  }
  return n
}
