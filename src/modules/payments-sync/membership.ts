import type { SqspOrder } from '../../integrations/ports/squarespace.js'
import { normalizeEmail, normalizePhone } from './identity.js'
import type { ProductMap, ResolvedProduct, Tier } from './product-map.js'

/**
 * Membership inference from Squarespace subscription orders (pure).
 *
 * What Squarespace does NOT give us (verified 2026-10-06): no subscription id, no subscription status, no cancellation
 * or failed-payment signal on the Orders API; renewals are simply new orders for the same customer and product, and a
 * renewal order carries the customer's *current* email. So:
 *   - the tier comes from the product/SKU map, never from the order;
 *   - the identity of a subscription is `sqsp:<email>:<productId|sku>` (review B11), grouped per person;
 *   - status is inferred from the latest PAID order: active until period end + grace, then past_due;
 *   - cancellation is LAGGED: it is only inferred after `lapseCancelDays` with no renewal (default 60, null disables);
 *     a customer who cancels in Squarespace stays "active" until the paid period and grace run out;
 *   - a full refund is a flag for human review, never an automatic cancel (review B11).
 */
export interface MembershipConfig {
  /** Days after period end during which the member is still active (Squarespace retries failed renewals). Default 7. */
  graceDays: number
  /** Days past grace with no renewal before inferring "canceled". null = never infer. Default 60. */
  lapseCancelDays: number | null
  includeTestMode: boolean
}

export const DEFAULT_MEMBERSHIP_CONFIG: MembershipConfig = {
  graceDays: 7,
  lapseCancelDays: 60,
  includeTestMode: false,
}

export interface CustomerRef {
  id: string
  emails: string[]
  phones: string[]
  sqspCustomerIds?: string[]
}

export type LinkedBy = 'sqsp_customer_id' | 'email' | 'phone' | 'ambiguous' | 'none'

export type ReviewFlagCode =
  | 'full_refund'
  | 'partial_refund'
  | 'refund_pending'
  | 'payment_pending'
  | 'payment_failed'
  | 'ambiguous_customer'
  | 'tier_changed'
  | 'lagged_cancellation'

export interface ReviewFlag {
  code: ReviewFlagCode
  orderId?: string
  note: string
}

export interface MembershipInference {
  personKey: string
  customerId?: string
  linkedBy: LinkedBy
  email?: string
  phone?: string
  name?: string
  sqspCustomerId?: string
  tier: Tier
  planLabel: string
  intervalMonths: number
  productKey: string
  /** sqsp:<normalised email>:<productId or sku>. Derived: Squarespace exposes no subscription id. */
  subscriptionRef: string
  status: 'pending' | 'active' | 'past_due' | 'canceled'
  currentPeriodStart?: Date
  currentPeriodEnd?: Date
  /** Past the paid period but still inside the grace days. */
  inGrace: boolean
  lastOrderId: string
  lastPaidAt?: Date
  paidOrderCount: number
  flags: ReviewFlag[]
  reason: string
}

type PayClass = 'paid' | 'full_refund' | 'pending' | 'failed'

function classify(o: SqspOrder): { cls: PayClass; flag?: ReviewFlag } {
  const s = o.paymentState ?? 'UNKNOWN'
  const refunded = o.refundedTotalCents
  if (s === 'REFUNDED') {
    if (refunded >= o.grandTotalCents && o.grandTotalCents > 0) {
      return {
        cls: 'full_refund',
        flag: {
          code: 'full_refund',
          orderId: o.id,
          note: `order ${o.orderNumber} fully refunded in Squarespace: review, membership is not auto-canceled`,
        },
      }
    }
    return {
      cls: 'paid',
      flag:
        refunded > 0
          ? {
              code: 'partial_refund',
              orderId: o.id,
              note: `order ${o.orderNumber} partially refunded (${refunded} cents)`,
            }
          : undefined,
    }
  }
  if (s === 'PAID' || s === 'REFUND_FAILED') return { cls: 'paid' }
  if (s === 'REFUND_PENDING')
    return {
      cls: 'paid',
      flag: { code: 'refund_pending', orderId: o.id, note: `refund pending on order ${o.orderNumber}` },
    }
  if (s === 'FAILED')
    return {
      cls: 'failed',
      flag: { code: 'payment_failed', orderId: o.id, note: `payment failed on order ${o.orderNumber}` },
    }
  // NOT_CHARGED, AUTHORIZED, PENDING, PARTIALLY_PAID, UNKNOWN
  return {
    cls: 'pending',
    flag: { code: 'payment_pending', orderId: o.id, note: `order ${o.orderNumber} is ${s}` },
  }
}

export function addMonths(d: Date, months: number): Date {
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + months
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return new Date(
    Date.UTC(
      y,
      m,
      Math.min(d.getUTCDate(), lastDay),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    ),
  )
}

export interface CustomerLink {
  customerId?: string
  by: LinkedBy
}

/** Link a Squarespace identity to an Oasis customer: Squarespace customer id, then email, then phone. */
export function linkCustomer(
  who: { email?: string; phone?: string; sqspCustomerId?: string },
  customers: readonly CustomerRef[],
): CustomerLink {
  const tiers: [LinkedBy, (c: CustomerRef) => boolean][] = []
  if (who.sqspCustomerId)
    tiers.push(['sqsp_customer_id', (c) => c.sqspCustomerIds?.includes(who.sqspCustomerId!) === true])
  const e = normalizeEmail(who.email)
  if (e) tiers.push(['email', (c) => c.emails.some((x) => normalizeEmail(x) === e)])
  const p = normalizePhone(who.phone)
  if (p) tiers.push(['phone', (c) => c.phones.some((x) => normalizePhone(x) === p)])
  for (const [by, test] of tiers) {
    const hits = customers.filter(test)
    if (hits.length === 1) return { customerId: hits[0]!.id, by }
    if (hits.length > 1) return { by: 'ambiguous' }
  }
  return { by: 'none' }
}

export function inferMemberships(
  orders: readonly SqspOrder[],
  map: ProductMap,
  customers: readonly CustomerRef[],
  now: Date,
  config: Partial<MembershipConfig> = {},
): MembershipInference[] {
  const cfg = { ...DEFAULT_MEMBERSHIP_CONFIG, ...config }
  interface Candidate {
    order: SqspOrder
    product: ResolvedProduct
    productKey: string
    link: CustomerLink
  }
  const groups = new Map<string, Candidate[]>()
  for (const order of orders) {
    if (order.testMode && !cfg.includeTestMode) continue
    const li = order.lineItems.find((l) => map.resolve(l)?.kind === 'membership')
    if (!li) continue
    const product = map.resolve(li)!
    const link = linkCustomer(
      { email: order.customerEmail, phone: order.customerPhone, sqspCustomerId: order.customerId },
      customers,
    )
    const email = normalizeEmail(order.customerEmail)
    const key =
      link.customerId !== undefined
        ? `customer:${link.customerId}`
        : email
          ? `email:${email}`
          : order.customerId
            ? `sqsp:${order.customerId}`
            : `phone:${normalizePhone(order.customerPhone) ?? order.id}`
    const list = groups.get(key) ?? []
    list.push({ order, product, productKey: li.productId ?? li.sku ?? 'unknown', link })
    groups.set(key, list)
  }

  const out: MembershipInference[] = []
  for (const [personKey, list] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
    list.sort(
      (a, b) =>
        a.order.createdOn.getTime() - b.order.createdOn.getTime() || (a.order.id < b.order.id ? -1 : 1),
    )
    const flags: ReviewFlag[] = []
    const classified = list.map((c) => ({ c, ...classify(c.order) }))
    const paid = classified.filter((x) => x.cls === 'paid')
    const latestOverall = classified[classified.length - 1]!
    const latestPaid = paid[paid.length - 1]
    const subject = latestPaid ?? latestOverall
    const o = subject.c.order
    const link = [...list].reverse().find((c) => c.link.by !== 'none')?.link ?? list[0]!.link

    for (const x of classified) {
      // Only the latest order's pending/failed state matters; refunds anywhere do.
      if (
        x.flag &&
        (x.flag.code === 'full_refund' ||
          x.flag.code === 'partial_refund' ||
          x.flag.code === 'refund_pending' ||
          x === latestOverall)
      )
        flags.push(x.flag)
    }
    if (link.by === 'ambiguous')
      flags.push({
        code: 'ambiguous_customer',
        note: 'more than one Oasis customer matches this email or phone',
      })
    const prevPaid = paid[paid.length - 2]
    if (latestPaid && prevPaid && prevPaid.c.product.tier !== latestPaid.c.product.tier) {
      flags.push({
        code: 'tier_changed',
        orderId: latestPaid.c.order.id,
        note: `${prevPaid.c.product.tier} -> ${latestPaid.c.product.tier}`,
      })
    }

    const email = normalizeEmail(o.customerEmail)
    const base = {
      personKey,
      customerId: link.customerId,
      linkedBy: link.by,
      email,
      phone: normalizePhone(o.customerPhone),
      name: o.customerName,
      sqspCustomerId: o.customerId,
      tier: subject.c.product.tier!,
      planLabel: subject.c.product.planLabel ?? subject.c.product.tier!,
      intervalMonths: subject.c.product.intervalMonths,
      productKey: subject.c.productKey,
      subscriptionRef: `sqsp:${email ?? o.customerId ?? 'unknown'}:${subject.c.productKey}`,
      lastOrderId: o.id,
      paidOrderCount: paid.length,
      flags,
    }

    if (!latestPaid) {
      out.push({ ...base, status: 'pending', inGrace: false, reason: 'no paid membership order yet' })
      continue
    }
    const start = o.createdOn
    const end = addMonths(start, base.intervalMonths)
    const graceEnd = new Date(end.getTime() + cfg.graceDays * 86_400_000)
    let status: MembershipInference['status']
    let reason: string
    let inGrace = false
    if (now.getTime() <= end.getTime()) {
      status = 'active'
      reason = 'inside the paid period'
    } else if (now.getTime() <= graceEnd.getTime()) {
      status = 'active'
      inGrace = true
      reason = `renewal overdue, inside the ${cfg.graceDays}-day grace period`
    } else if (
      cfg.lapseCancelDays !== null &&
      now.getTime() > graceEnd.getTime() + cfg.lapseCancelDays * 86_400_000
    ) {
      status = 'canceled'
      reason = `no renewal for ${cfg.lapseCancelDays} days past grace: cancellation inferred (lagged)`
      flags.push({
        code: 'lagged_cancellation',
        orderId: o.id,
        note: 'Squarespace exposes no cancellation signal; this is inferred from the missing renewal',
      })
    } else {
      status = 'past_due'
      reason = 'no renewal order within the paid period plus grace'
    }
    out.push({
      ...base,
      status,
      currentPeriodStart: start,
      currentPeriodEnd: end,
      inGrace,
      lastPaidAt: o.createdOn,
      reason,
    })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------

export interface ExistingMembership {
  id: string
  customerId: string
  status: 'pending' | 'active' | 'past_due' | 'paused' | 'canceled'
  source: 'squarespace' | 'manual'
  tier: Tier
  currentPeriodEnd?: Date
  lastSqspOrderId?: string
  /** When staff last set paused/canceled by hand; a later paid order reactivates. */
  manualStatusAt?: Date
}

export type MembershipAction =
  | { action: 'none'; reason: string }
  | { action: 'needs_customer'; reason: string }
  | { action: 'create'; inference: MembershipInference; customerId: string }
  | { action: 'update'; membershipId: string; inference: MembershipInference; changes: string[] }

/** Decide what to do with one inference given the stored membership (if any). Manual overrides are respected. */
export function reconcileMembership(
  existing: ExistingMembership | undefined,
  inf: MembershipInference,
): MembershipAction {
  if (!existing) {
    if (!inf.customerId)
      return {
        action: 'needs_customer',
        reason: `no Oasis customer for ${inf.email ?? inf.phone ?? inf.personKey}: create or link one`,
      }
    if (inf.status === 'pending' && inf.paidOrderCount === 0)
      return { action: 'none', reason: 'nothing paid yet' }
    return { action: 'create', inference: inf, customerId: inf.customerId }
  }
  const heldByHand =
    existing.status === 'paused' || (existing.source === 'manual' && existing.status === 'canceled')
  if (heldByHand) {
    const renewed =
      inf.lastPaidAt !== undefined &&
      existing.manualStatusAt !== undefined &&
      inf.lastPaidAt > existing.manualStatusAt
    if (!renewed)
      return {
        action: 'none',
        reason: `status ${existing.status} was set by hand and no newer paid order exists`,
      }
  }
  const changes: string[] = []
  if (existing.status !== inf.status) changes.push(`status ${existing.status} -> ${inf.status}`)
  if (existing.tier !== inf.tier) changes.push(`tier ${existing.tier} -> ${inf.tier}`)
  if (existing.currentPeriodEnd?.getTime() !== inf.currentPeriodEnd?.getTime()) changes.push('period')
  if (existing.lastSqspOrderId !== inf.lastOrderId) changes.push('last order')
  if (changes.length === 0) return { action: 'none', reason: 'unchanged' }
  return { action: 'update', membershipId: existing.id, inference: inf, changes }
}
