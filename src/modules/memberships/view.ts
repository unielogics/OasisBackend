// Read models of memberships: what the Operations Membership tab, the card badge and the Customer file need, computed from the
// member row, the plan, the cycle's credit events and the visit history. Percent perks (addon and service discount) are
// returned as display data only.
import type { Selectable } from 'kysely'
import { DateTime } from 'luxon'
import type { Executor } from '../../platform/db.js'
import { getSetting } from '../../platform/settings.js'
import { cardLabel } from '../payments/repository.js'
import { liveCheckouts } from './checkouts.js'
import { creditSummaries, type CreditSummary } from './credits.js'
import { loadPlans, type Plan } from './plans.js'
import { memberMonths, retentionOf, visitCounts, type Retention } from './retention.js'
import type { MembershipsTable, MembershipSource, MembershipStatus } from './schema.js'
import './square/schema.js'
import '../square/db/cards-schema.js'

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
    /** The member % off every line the membership does not cover (ADR 0170). */
    memberDiscountBp: number
  }
  /** The size the membership is priced at: a covered line is covered up to this size's price (ADR 0170). */
  planClass: string
  planClassLabel: string | null
  /** The other clients the membership covers (the holder is customerId); credits are shared. */
  household: { customerId: string; name: string; addedAt: string }[]
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
  /**
   * The membership's live Squarespace checkout (ADR 0160): an open intent waiting for its order, or a paid order that matches
   * the client only through an unverified email and waits for staff (awaiting_match). null when there is none.
   */
  checkout: {
    id: string
    state: 'open' | 'awaiting_match'
    expectedEmail: string | null
    startedAt: string
    expiresAt: string
    order: { id: string; number: string; createdOn: string } | null
  } | null
  /** How Square bills it (source square, ADR 0171 wave Q3b); null for any other membership. */
  billing: SquareBillingView | null
  version: number
}

export interface SquareBillingView {
  /** ok, or failed since failedAt: in grace until pastDueOn (perks on), past due until cancelOn, then canceled (plan decision 7). */
  status: 'ok' | 'failed'
  /** Square's own status of the subscription (ACTIVE, PAUSED, CANCELED, DEACTIVATED, PENDING). */
  squareStatus: string | null
  failedAt: string | null
  /** The client was texted the card link (and emailed Square's invoice page). */
  notifiedAt: string | null
  /** Shop-local dates of the failure policy for a failed renewal. */
  pastDueOn: string | null
  cancelOn: string | null
  /** The monthly price billed (the tier price row of the membership). */
  monthlyCents: number | null
  /** The size the plan is priced at ("Compact car"; the same as the view's planClassLabel). */
  planClassLabel: string | null
  /**
   * The shop-local date Square charges next (the end of the paid period); null when no charge is due on a known date: not active at
   * Square, not an active membership, a failed renewal (see failedAt and lastFailed), or a cancel or pause scheduled on or before it.
   */
  nextChargeOn: string | null
  card: { brand: string | null; last4: string | null; label: string; expMonth: number | null; expYear: number | null; state: string } | null
  /** What Square has scheduled for the next billing date. */
  cancelAt: string | null
  pauseAt: string | null
  change: {
    kind: 'change' | 'move'
    planKey: string
    planName: string | null
    planClass: string
    planClassLabel: string | null
    monthlyCents: number
    effectiveDate: string | null
    swapAfter: string | null
  } | null
  lastInvoice: { status: string; amountCents: number; dueDate: string | null; paidAt: string | null; refundedCents: number; payUrl: string | null } | null
  /** The newest invoice Square was paid for. */
  lastPaid: { amountCents: number; paidAt: string; dueDate: string | null; refundedCents: number } | null
  /** The newest invoice Square could not charge (it may have been paid since: compare with lastPaid and status). */
  lastFailed: { amountCents: number; failedAt: string; dueDate: string | null; paid: boolean; payUrl: string | null } | null
  /** The latest enrollment of a membership that has not started: where it stands. */
  enrollment: { state: string; failure: string | null } | null
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
  const checkouts = await liveCheckouts(db, rows.map((r) => r.id))
  const sizes = await db.selectFrom('vehicle_classes').select(['key', 'label']).where('location_id', '=', c.locationId).execute()
  const billing = await squareBilling(db, c, rows, { plans, sizes })
  const household = await db
    .selectFrom('membership_household as h')
    .innerJoin('customers as cu', 'cu.id', 'h.customer_id')
    .select(['h.membership_id', 'h.customer_id', 'cu.full_name', 'h.added_at'])
    .where(
      'h.membership_id',
      'in',
      rows.map((r) => r.id),
    )
    .where('h.removed_at', 'is', null)
    .orderBy('h.added_at')
    .orderBy('h.id')
    .execute()
  return rows.map((r) => {
    const co = checkouts.get(r.id)
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
        memberDiscountBp: plan.memberDiscountBp,
      },
      planClass: r.plan_class,
      planClassLabel: sizes.find((s) => s.key === r.plan_class)?.label ?? null,
      household: household
        .filter((h) => h.membership_id === r.id)
        .map((h) => ({ customerId: h.customer_id, name: h.full_name, addedAt: h.added_at.toISOString() })),
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
      checkout: co
        ? {
            id: co.id,
            state: co.state as 'open' | 'awaiting_match',
            expectedEmail: co.expectedEmail,
            startedAt: co.startedAt,
            expiresAt: co.expiresAt,
            order: co.order ? { id: co.order.id, number: co.order.number, createdOn: co.order.createdOn } : null,
          }
        : null,
      billing: billing.get(r.id) ?? null,
      version: r.version,
    }
  })
}

/** The Square billing blocks of the rows billed by Square (batched reads). */
async function squareBilling(
  db: Executor,
  c: { locationId: string; tz: string },
  rows: readonly MembershipRow[],
  names: { plans: readonly Plan[]; sizes: readonly { key: string; label: string }[] },
): Promise<Map<string, SquareBillingView>> {
  const out = new Map<string, SquareBillingView>()
  const sq = rows.filter((r) => r.source === 'square')
  if (sq.length === 0) return out
  const ids = sq.map((r) => r.id)
  const priceIds = sq.map((r) => r.tier_price_id).filter((x): x is string => !!x)
  const cardIds = sq.map((r) => r.card_id).filter((x): x is string => !!x)
  const [prices, cards, invoices, enrollments, policy] = await Promise.all([
    priceIds.length ? db.selectFrom('membership_tier_prices').select(['id', 'monthly_cents']).where('id', 'in', priceIds).execute() : [],
    cardIds.length ? db.selectFrom('customer_cards').select(['id', 'brand', 'last4', 'exp_month', 'exp_year', 'state']).where('id', 'in', cardIds).execute() : [],
    db
      .selectFrom('square_subscription_invoices')
      .select(['membership_id', 'status', 'amount_cents', 'due_date', 'paid_at', 'failed_at', 'refunded_cents', 'public_url', 'created_at'])
      .where('membership_id', 'in', ids)
      .orderBy('created_at', 'desc')
      .execute(),
    db.selectFrom('square_enrollments').select(['membership_id', 'state', 'failure_code', 'started_at']).where('membership_id', 'in', ids).orderBy('started_at', 'desc').execute(),
    getSetting(db, c.locationId, 'memberships.billing_policy'),
  ])
  const day = (d: Date, plus: number) => DateTime.fromJSDate(d, { zone: c.tz }).plus({ days: plus }).toFormat('yyyy-MM-dd')
  const sizeLabel = (key: string) => names.sizes.find((x) => x.key === key)?.label ?? null
  const newest = (a: Date | null, b: Date | null) => (b?.getTime() ?? 0) - (a?.getTime() ?? 0)
  for (const r of sq) {
    const card = cards.find((x) => x.id === r.card_id)
    const mine = invoices.filter((x) => x.membership_id === r.id)
    const inv = mine[0]
    const paid = mine.filter((x) => x.paid_at).sort((a, b) => newest(a.paid_at, b.paid_at))[0]
    const failed = mine.filter((x) => x.failed_at).sort((a, b) => newest(a.failed_at, b.failed_at))[0]
    const enr = enrollments.find((x) => x.membership_id === r.id)
    const ch = r.scheduled_change
    const periodEnd = r.current_period_end ? day(r.current_period_end, 0) : null
    const stops = [r.cancel_effective_at, r.pause_effective_at].filter((x): x is string => !!x)
    const nextChargeOn =
      periodEnd && r.square_status === 'ACTIVE' && r.status === 'active' && r.billing_status === 'ok' && !stops.some((x) => x <= periodEnd)
        ? periodEnd
        : null
    out.set(r.id, {
      status: r.billing_status,
      squareStatus: r.square_status,
      failedAt: r.payment_failed_at?.toISOString() ?? null,
      notifiedAt: r.failure_notified_at?.toISOString() ?? null,
      pastDueOn: r.payment_failed_at ? day(r.payment_failed_at, policy.value.graceDays) : null,
      cancelOn: r.payment_failed_at ? day(r.payment_failed_at, policy.value.cancelDays) : null,
      monthlyCents: prices.find((p) => p.id === r.tier_price_id)?.monthly_cents ?? null,
      planClassLabel: sizeLabel(r.plan_class),
      nextChargeOn,
      card: card
        ? { brand: card.brand, last4: card.last4, label: cardLabel(card.brand, card.last4).label, expMonth: card.exp_month, expYear: card.exp_year, state: card.state }
        : null,
      cancelAt: r.cancel_effective_at,
      pauseAt: r.pause_effective_at,
      change: ch
        ? {
            kind: ch.kind,
            planKey: ch.planKey,
            planName: names.plans.find((p) => p.key === ch.planKey)?.name ?? null,
            planClass: ch.planClass,
            planClassLabel: sizeLabel(ch.planClass),
            monthlyCents: ch.monthlyCents,
            effectiveDate: ch.effectiveDate,
            swapAfter: ch.swapAfter ?? null,
          }
        : null,
      lastInvoice: inv
        ? { status: inv.status, amountCents: inv.amount_cents, dueDate: inv.due_date, paidAt: inv.paid_at?.toISOString() ?? null, refundedCents: inv.refunded_cents, payUrl: inv.public_url }
        : null,
      lastPaid: paid?.paid_at
        ? { amountCents: paid.amount_cents, paidAt: paid.paid_at.toISOString(), dueDate: paid.due_date, refundedCents: paid.refunded_cents }
        : null,
      lastFailed: failed?.failed_at
        ? { amountCents: failed.amount_cents, failedAt: failed.failed_at.toISOString(), dueDate: failed.due_date, paid: failed.paid_at !== null, payUrl: failed.public_url }
        : null,
      enrollment: r.status === 'pending' && enr ? { state: enr.state, failure: enr.failure_code } : null,
    })
  }
  return out
}

export async function locationTz(db: Executor, locationId: string): Promise<string> {
  return (
    (await db.selectFrom('locations').select('timezone').where('id', '=', locationId).executeTakeFirst())
      ?.timezone ?? 'America/New_York'
  )
}
