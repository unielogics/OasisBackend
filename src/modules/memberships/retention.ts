// Visit-history facts computed from real appointments and invoices (backend design 4.6): retention (completed visits in the last
// 30 days against the 30 before), upgrade candidates (3+ completed visits in 60 days) and the History tab statistics.
import { sql } from 'kysely'
import type { Executor } from '../../platform/db.js'

export interface VisitCounts {
  cur30: number
  prev30: number
  visits60: number
  visitCount: number
}

const DAY = 86_400_000

export async function visitCounts(
  db: Executor,
  locationId: string,
  customerIds: readonly string[],
  now: Date,
): Promise<Map<string, VisitCounts>> {
  const out = new Map<string, VisitCounts>()
  if (customerIds.length === 0) return out
  const d30 = new Date(now.getTime() - 30 * DAY)
  const d60 = new Date(now.getTime() - 60 * DAY)
  const r = await sql<{
    customer_id: string
    cur30: number
    prev30: number
    visits60: number
    visit_count: number
  }>`
    select a.customer_id,
      count(*) filter (where v.at > ${d30} and v.at <= ${now})::int as cur30,
      count(*) filter (where v.at > ${d60} and v.at <= ${d30})::int as prev30,
      count(*) filter (where v.at > ${d60} and v.at <= ${now})::int as visits60,
      count(*)::int as visit_count
    from appointments a cross join lateral (select coalesce(a.completed_at, a.scheduled_start) as at) v
    where a.location_id = ${locationId} and a.status = 'completed' and a.customer_id = any(${customerIds as string[]}::uuid[])
    group by a.customer_id`.execute(db)
  for (const id of customerIds) out.set(id, { cur30: 0, prev30: 0, visits60: 0, visitCount: 0 })
  for (const x of r.rows)
    out.set(x.customer_id, {
      cur30: x.cur30,
      prev30: x.prev30,
      visits60: x.visits60,
      visitCount: x.visit_count,
    })
  return out
}

export type RetentionTone = 'green' | 'red'

export interface Retention {
  label: string
  desc: string
  tone: RetentionTone
  /** loyal | watch | new */
  state: 'loyal' | 'watch' | 'new'
  cur30: number
  prev30: number
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)

/**
 * Loyal when the last 30 days have at least one visit and no fewer than the 30 before; otherwise Watch with the missed visits
 * (design strings). One deviation from the design's rule: a member who joined less than 30 days ago and has no visit yet is "New
 * member", because "Down from 0 to 0 visits" would be false.
 */
export function retentionOf(
  c: Pick<VisitCounts, 'cur30' | 'prev30'>,
  memberSince: Date | null,
  now: Date,
): Retention {
  const { cur30: cur, prev30: prev } = c
  if (cur >= 1 && cur >= prev)
    return {
      label: 'Loyal · low risk',
      desc: 'Consistent monthly usage — strong retention',
      tone: 'green',
      state: 'loyal',
      cur30: cur,
      prev30: prev,
    }
  if (cur === 0 && prev === 0 && memberSince && now.getTime() - memberSince.getTime() < 30 * DAY)
    return {
      label: 'New member',
      desc: 'Joined in the last 30 days — no visits yet',
      tone: 'green',
      state: 'new',
      cur30: cur,
      prev30: prev,
    }
  const missed = Math.max(1, prev - cur)
  return {
    label: `Watch · ${missed} missed ${plural(missed, 'visit', 'visits')}`,
    desc: `Down from ${prev} to ${cur} ${plural(cur, 'visit', 'visits')} last month`,
    tone: 'red',
    state: 'watch',
    cur30: cur,
    prev30: prev,
  }
}

export const UPGRADE_MIN_VISITS_60D = 3

export interface Upgrade {
  candidate: boolean
  visits60: number
  copy: string | null
}

/** A non-member with at least 3 completed visits in 60 days is a strong upgrade candidate (the number in the copy is real). */
export function upgradeOf(name: string, visits60: number): Upgrade {
  const candidate = visits60 >= UPGRADE_MIN_VISITS_60D
  return {
    candidate,
    visits60,
    copy: candidate
      ? `${name} is a strong upgrade candidate — ${visits60} ${plural(visits60, 'visit', 'visits')} in 60 days. Offer Essential at check-out.`
      : null,
  }
}

export interface History {
  visitCount: number
  /** Σ (paid − refunded) over the customer's invoices, in cents. */
  lifetimeSpendCents: number
  /** Mean days between consecutive completed visits; null with fewer than two. */
  avgFreqDays: number | null
  /** The most-used package, ties broken by name. */
  favPackage: string | null
}

export async function historyFor(db: Executor, locationId: string, customerId: string): Promise<History> {
  const visits = await sql<{ at: Date; package_name: string }>`
    select coalesce(a.completed_at, a.scheduled_start) as at, a.package_name
    from appointments a
    where a.location_id = ${locationId} and a.customer_id = ${customerId} and a.status = 'completed'
    order by 1`.execute(db)
  const gaps: number[] = []
  for (let i = 1; i < visits.rows.length; i++)
    gaps.push((visits.rows[i]!.at.getTime() - visits.rows[i - 1]!.at.getTime()) / DAY)
  const counts = new Map<string, number>()
  for (const v of visits.rows) counts.set(v.package_name, (counts.get(v.package_name) ?? 0) + 1)
  const fav = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]
  const spend = await sql<{ cents: number }>`
    select coalesce(sum(greatest(c.paid - c.refunded, 0)), 0)::bigint as cents
    from invoices i cross join lateral invoice_calc_of(i.id) c
    where i.location_id = ${locationId} and i.customer_id = ${customerId}`.execute(db)
  return {
    visitCount: visits.rows.length,
    lifetimeSpendCents: Number(spend.rows[0]?.cents ?? 0),
    avgFreqDays: gaps.length ? Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 10) / 10 : null,
    favPackage: fav ? fav[0] : null,
  }
}

/** Whole months from `since` to `now`, at least 1 for a current member. */
export function memberMonths(since: Date, now: Date): number {
  let months =
    (now.getUTCFullYear() - since.getUTCFullYear()) * 12 + (now.getUTCMonth() - since.getUTCMonth())
  if (now.getUTCDate() < since.getUTCDate()) months -= 1
  return Math.max(1, months)
}
