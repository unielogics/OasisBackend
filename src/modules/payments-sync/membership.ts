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
 *
 * Who an order belongs to (ADR 0160, design section 5): a checkout intent first (the client verified their phone on a personal
 * link, confirmed an email and was sent to the plan's checkout: an order with that email and product inside the intent's window
 * is theirs, and so are that email's later renewals of the product once one matched), then the Squarespace customer id, then an
 * email the client VERIFIED (customers.email_verified), then the phone. An email nobody verified never links: an order that
 * matches a client only that way waits for staff ('unverified_email', the awaiting_match state). A second paid order of the same
 * plan while the first period still runs is a duplicate: flagged, and never moves the period.
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
  /** Emails the client verified (customers.email_verified): the only emails the email tier reads. */
  emails: string[]
  /** Emails on file that nobody verified: they never link, but an order matching only one of them waits for staff. */
  unverifiedEmails?: string[]
  phones: string[]
  sqspCustomerIds?: string[]
}

/** A membership_checkouts row as the matching sees it (memberships/checkouts.ts loads them). */
export interface CheckoutIntentRef {
  id: string
  customerId: string
  membershipId: string
  /** open: waiting for its order; matched: bound to an order (its later renewals follow it); awaiting_match: waiting for staff. */
  state: 'open' | 'matched' | 'awaiting_match'
  /** The plan (tier) the client chose. */
  planKey: string
  /** The Squarespace product id or SKU the order should carry; null matches any product of the plan. */
  productKey?: string
  expectedEmail?: string
  startedAt: Date
  expiresAt: Date
  /** The Squarespace order id the row is bound to (matched) or waits for (awaiting_match). */
  orderId?: string
}

export type LinkedBy =
  | 'checkout_intent'
  | 'sqsp_customer_id'
  | 'email'
  | 'phone'
  | 'unverified_email'
  | 'ambiguous'
  | 'none'

export type ReviewFlagCode =
  | 'full_refund'
  | 'partial_refund'
  | 'refund_pending'
  | 'payment_pending'
  | 'payment_failed'
  | 'ambiguous_customer'
  | 'tier_changed'
  | 'lagged_cancellation'
  | 'duplicate_payment'

export interface ReviewFlag {
  code: ReviewFlagCode
  orderId?: string
  note: string
}

export interface MembershipInference {
  personKey: string
  customerId?: string
  linkedBy: LinkedBy
  /** linkedBy 'unverified_email': the one client whose unverified email the order carries (never linked by the inference). */
  candidateCustomerId?: string
  /** Open checkout intents an order of this person matched (intent id, Squarespace order id): the sync marks them matched. */
  checkoutMatches: { intentId: string; orderId: string }[]
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
  /** The newest paid order of any kind, a duplicate included: a newer payment releases a hand-set status even when flagged. */
  newestPaidAt?: Date
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
  /** by 'checkout_intent': the intent that linked; `fresh` when it was still open (this order consumes it). */
  intent?: { id: string; fresh: boolean }
  /** by 'unverified_email': the client staff are asked about. */
  candidateCustomerId?: string
}

/** What an order says about who paid and for what, as the linking reads it. */
export interface OrderIdentity {
  email?: string
  phone?: string
  sqspCustomerId?: string
  /** The Squarespace order id, the moment it was placed and its membership product: needed by the checkout-intent tier. */
  orderId?: string
  createdOn?: Date
  product?: { key: string; productId?: string; sku?: string; tier?: string }
}

const sameKey = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase()

/** The order carries the intent's product (by product id or SKU), or any product of its plan when the intent names none. */
function productFits(intent: CheckoutIntentRef, product: NonNullable<OrderIdentity['product']>): boolean {
  if (intent.productKey)
    return (
      sameKey(intent.productKey, product.productId) ||
      sameKey(intent.productKey, product.sku) ||
      sameKey(intent.productKey, product.key)
    )
  return product.tier !== undefined && product.tier === intent.planKey
}

/** The one client a set of intents names, or 'ambiguous' when they name several. */
function oneClient(hits: readonly CheckoutIntentRef[]): CheckoutIntentRef | 'ambiguous' | undefined {
  if (hits.length === 0) return undefined
  if (new Set(hits.map((h) => h.customerId)).size > 1) return 'ambiguous'
  return [...hits].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0]
}

/** The checkout-intent tier: the order a row is bound to, an open intent's order, then the renewals of a matched intent. */
function intentFor(who: OrderIdentity, intents: readonly CheckoutIntentRef[]): CustomerLink | undefined {
  if (who.orderId) {
    const bound = intents.filter((i) => i.state === 'matched' && i.orderId === who.orderId)
    const hit = oneClient(bound)
    if (hit === 'ambiguous') return { by: 'ambiguous' }
    if (hit) return { customerId: hit.customerId, by: 'checkout_intent', intent: { id: hit.id, fresh: false } }
  }
  const email = normalizeEmail(who.email)
  const product = who.product
  const at = who.createdOn?.getTime()
  if (!email || !product || at === undefined) return undefined
  const fits = (i: CheckoutIntentRef): boolean => normalizeEmail(i.expectedEmail) === email && productFits(i, product)
  const open = oneClient(intents.filter((i) => i.state === 'open' && fits(i) && i.startedAt.getTime() <= at && at <= i.expiresAt.getTime()))
  if (open === 'ambiguous') return { by: 'ambiguous' }
  if (open) return { customerId: open.customerId, by: 'checkout_intent', intent: { id: open.id, fresh: true } }
  // a renewal: the same email and product after a checkout of this client matched (Squarespace renews with the current email)
  const renewal = oneClient(intents.filter((i) => i.state === 'matched' && fits(i) && i.startedAt.getTime() <= at))
  if (renewal === 'ambiguous') return { by: 'ambiguous' }
  if (renewal) return { customerId: renewal.customerId, by: 'checkout_intent', intent: { id: renewal.id, fresh: false } }
  return undefined
}

/**
 * Link a Squarespace identity to an Oasis customer: a checkout intent, then the Squarespace customer id, then a verified email,
 * then the phone. An email nobody verified never links; an order it alone points at names the client as a candidate for staff.
 */
export function linkCustomer(
  who: OrderIdentity,
  customers: readonly CustomerRef[],
  intents: readonly CheckoutIntentRef[] = [],
): CustomerLink {
  const byIntent = intentFor(who, intents)
  if (byIntent) return byIntent
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
  if (e) {
    const hits = customers.filter((c) => (c.unverifiedEmails ?? []).some((x) => normalizeEmail(x) === e))
    if (hits.length === 1) return { by: 'unverified_email', candidateCustomerId: hits[0]!.id }
    if (hits.length > 1) return { by: 'ambiguous' }
  }
  return { by: 'none' }
}

/** A renewal may be placed this much before the paid period ends and still be a renewal, not a duplicate. */
export const RENEWAL_EARLY_MS = 3 * 86_400_000

export function inferMemberships(
  orders: readonly SqspOrder[],
  map: ProductMap,
  customers: readonly CustomerRef[],
  now: Date,
  config: Partial<MembershipConfig> = {},
  intents: readonly CheckoutIntentRef[] = [],
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
    const productKey = li.productId ?? li.sku ?? 'unknown'
    const link = linkCustomer(
      {
        email: order.customerEmail,
        phone: order.customerPhone,
        sqspCustomerId: order.customerId,
        orderId: order.id,
        createdOn: order.createdOn,
        product: { key: productKey, productId: li.productId, sku: li.sku, tier: product.tier },
      },
      customers,
      intents,
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
    list.push({ order, product, productKey, link })
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
    // The paid chain: a paid order of the same plan placed while the previous one's period still runs (more than the renewal
    // slack before its end) is a duplicate (a second subscription, a double checkout): flagged for a refund, never a new period.
    const paid: typeof classified = []
    const duplicates: typeof classified = []
    for (const x of classified.filter((y) => y.cls === 'paid')) {
      const head = paid[paid.length - 1]
      const runsUntil = head
        ? addMonths(head.c.order.createdOn, head.c.product.intervalMonths).getTime() - RENEWAL_EARLY_MS
        : undefined
      if (head && head.c.product.tier === x.c.product.tier && runsUntil !== undefined && x.c.order.createdOn.getTime() < runsUntil)
        duplicates.push(x)
      else paid.push(x)
    }
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
    for (const x of duplicates)
      flags.push({
        code: 'duplicate_payment',
        orderId: x.c.order.id,
        note: `order ${x.c.order.orderNumber} pays the same plan again while the membership is already paid: refund it in Squarespace`,
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
      candidateCustomerId: link.by === 'unverified_email' ? link.candidateCustomerId : undefined,
      checkoutMatches: list.flatMap((c) =>
        c.link.intent?.fresh ? [{ intentId: c.link.intent.id, orderId: c.order.id }] : [],
      ),
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
      newestPaidAt: [...paid, ...duplicates].reduce<Date | undefined>(
        (max, x) => (max === undefined || x.c.order.createdOn > max ? x.c.order.createdOn : max),
        undefined,
      ),
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
    const paidAt = inf.newestPaidAt ?? inf.lastPaidAt
    const renewed =
      paidAt !== undefined && existing.manualStatusAt !== undefined && paidAt > existing.manualStatusAt
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
