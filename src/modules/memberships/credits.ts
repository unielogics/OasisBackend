// Credits of the current membership cycle. The ledger of credit events is append-only: a cycle grant per per_cycle inclusion
// (qty = its per_cycle, or null when unlimited), redeems when an inclusion covers a visit. "Left" is derived: grants minus redeems
// (plus restores) for the cycle that started at memberships.current_period_start, over the inclusions of the member's CURRENT tier,
// so a tier change starts the new tier's credits without touching history. Events written before ADR 0170 name a credit rule; the
// migration gave each rule's inclusion the rule's id and backfilled inclusion_id, so they count through it (coalesce(inclusion_id,
// rule_id)). An every_visit inclusion is not a credit: it has no grant and no count, and always covers.
import { sql } from 'kysely'
import type { Clock } from '../../platform/clock.js'
import type { Executor } from '../../platform/db.js'
import type { NewId } from '../../platform/ids.js'
import { inclusionCovers, type Inclusion, type Plan } from './plans.js'

export interface RuleCredit {
  /** The inclusion's id (the credit rule's id for an inclusion the migration made from one). */
  ruleId: string
  label: string
  /** The inclusion applies itself when a covered visit is completed. */
  autoApply: boolean
  unlimited: boolean
  /** null when unlimited */
  granted: number | null
  used: number
  /** null when unlimited */
  left: number | null
}

export interface CreditSummary {
  cycleStart: Date | null
  /** The per_cycle inclusions of the tier (every_visit ones are not credits). */
  rules: RuleCredit[]
  /** null = unlimited (shown as the infinity sign): at least one inclusion has no cap */
  creditsLeft: number | null
  creditsUsed: number
}

export interface CycleRef {
  id: string
  planId: string
  currentPeriodStart: Date | null
}

/** The inclusions that count as credits: active per_cycle ones. */
export const creditInclusions = (plan: Plan | undefined): Inclusion[] =>
  (plan?.inclusions ?? []).filter((i) => i.active && i.mode === 'per_cycle')

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
        .select((eb) => [
          'membership_id',
          'cycle_start',
          'kind',
          'qty',
          eb.fn.coalesce('inclusion_id', 'rule_id').as('inclusion_id'),
        ])
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
      (e) =>
        e.membership_id === m.id &&
        m.currentPeriodStart &&
        e.cycle_start.getTime() === m.currentPeriodStart.getTime(),
    )
    const rules: RuleCredit[] = creditInclusions(plan).map((r) => {
      const grants = mine.filter((e) => e.kind === 'grant' && e.inclusion_id === r.id)
      const granted = grants.length
        ? grants.some((g) => g.qty === null)
          ? null
          : grants.reduce((n, g) => n + (g.qty ?? 0), 0)
        : r.perCycle
      // A restore gives a redeemed credit back (staff correction, or a closure canceled the visit that held it). It counts in
      // the cycle it is written in: when the redeem belonged to an earlier cycle there is nothing to offset, and the credit
      // comes back as a bonus. 'protect' is a marker only (ADR 0084) and never changes a count.
      const net =
        mine.filter((e) => e.kind === 'redeem' && e.inclusion_id === r.id).reduce((n, e) => n + (e.qty ?? 0), 0) -
        mine.filter((e) => e.kind === 'restore' && e.inclusion_id === r.id).reduce((n, e) => n + (e.qty ?? 0), 0)
      const used = Math.max(0, net)
      const bonus = Math.max(0, -net)
      return {
        ruleId: r.id,
        label: r.label,
        autoApply: r.autoApply,
        unlimited: granted === null,
        granted,
        used,
        left: granted === null ? null : Math.max(0, granted + bonus - used),
      }
    })
    const unlimited = rules.some((r) => r.unlimited)
    out.set(m.id, {
      cycleStart: m.currentPeriodStart,
      rules,
      creditsLeft:
        m.currentPeriodStart === null ? 0 : unlimited ? null : rules.reduce((n, r) => n + (r.left ?? 0), 0),
      creditsUsed: rules.reduce((n, r) => n + r.used, 0),
    })
  }
  return out
}

/**
 * The first inclusion (in tier order) that covers the service and can still cover it: an every_visit one, or a per_cycle one with a
 * credit left this cycle (or unlimited). `covered: false` names the first covering inclusion when none has a credit left.
 */
export function eligibleInclusion(
  plan: Plan,
  summary: CreditSummary,
  serviceId: string,
): { inclusion: Inclusion; covered: boolean } | undefined {
  const covering = plan.inclusions.filter((r) => inclusionCovers(r, serviceId))
  if (covering.length === 0) return undefined
  for (const r of covering) {
    if (r.mode === 'every_visit') return { inclusion: r, covered: true }
    const c = summary.rules.find((x) => x.ruleId === r.id)
    if (c && (c.unlimited || (c.left ?? 0) > 0)) return { inclusion: r, covered: true }
  }
  return { inclusion: covering[0]!, covered: false }
}

/**
 * Writes the cycle's grant events for every per_cycle inclusion of the tier; idempotent per membership, cycle and inclusion (the key
 * keeps the old rule wording, so a cycle granted before ADR 0170 is not granted again). Returns how many were new.
 */
export async function grantCycleCredits(
  db: Executor,
  d: { clock: Clock; newId: NewId },
  m: { id: string; currentPeriodStart: Date },
  plan: Plan,
  actor = 'System',
): Promise<number> {
  let n = 0
  for (const r of creditInclusions(plan)) {
    const res = await sql`
      insert into membership_credit_events (id, membership_id, cycle_start, kind, qty, inclusion_id, note, actor, idempotency_key, created_at)
      values (${d.newId()}, ${m.id}, ${m.currentPeriodStart}, 'grant', ${r.perCycle}, ${r.id}, 'Cycle credits', ${actor},
        ${`grant:${m.id}:${m.currentPeriodStart.toISOString()}:${r.id}`}, ${d.clock.now()})
      on conflict (idempotency_key) do nothing`.execute(db)
    n += Number(res.numAffectedRows ?? 0)
  }
  return n
}
