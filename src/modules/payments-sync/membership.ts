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
 * is theirs, and so are the later renewals of the same Squarespace customer once one matched), unless another client holds the
 * order (see `holdsOrder`: then the intent is ignored and the other tiers decide); then the Squarespace customer id, then an email
 * the client VERIFIED (customers.email_verified), then the phone. An email nobody verified never links: an order that
 * matches a client only that way waits for staff ('unverified_email', the awaiting_match state). A second paid order of the same
 * plan while the first period still runs is a duplicate: flagged, and never moves the period. An open intent only names the email its
 * client typed: an order matching it alone but carrying another phone or name than the client's waits for staff too
 * ('intent_mismatch', awaiting_match; W4c fixes). A STALE record (identity/stale.ts: numbers are recycled) is no match by its phone or by
 * an email nobody verified: the order names it for staff ('stale_record', "needs a customer") and links nobody (W4c re-review 2,
 * N1); its Squarespace links made while it was not stale (memberships/service.ts), a Squarespace customer that already paid on it
 * (W4c re-review 3, D1) and a verified email still link. A staff (manual) link of a Squarespace customer always wins over a payment
 * it made on another record (W4c re-review 4, E1). A Squarespace customer other than the one a client already has never links to
 * them by their phone or an email nobody verified ('second_account', "needs a customer": the number may have a new holder; E2).
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
  /**
   * Squarespace customer ids that LINK an order to the client, whatever the record's staleness: their links (one the contacts job
   * made by an unverified email, or by phone after the record went stale, excluded) and every Squarespace customer that already PAID
   * on the record (on a membership row a matched payment reached, or on a paid order linked to them: W4c re-review 3, D1), whatever
   * made its contact link.
   */
  sqspCustomerIds?: string[]
  /**
   * Every Squarespace customer id tied to the client, whatever made the tie: sqsp_customer_links of any source (one made by an
   * unverified email included) and the Squarespace customer on the client's membership rows. They link nothing by themselves, but
   * another client's checkout intent never takes an order of one of them (F1).
   */
  heldSqspCustomerIds?: string[]
  /**
   * The Squarespace customers staff linked to the client by hand (sqsp_customer_links source manual). A staff link always wins (W4c
   * re-review 4, E1): customerRefs drops such a customer from every other client's ids, and an order of one that another client's
   * checkout intent named raises no conflict alert (staff already said whose it is).
   */
  staffSqspCustomerIds?: string[]
  /**
   * Set when the stale-record rule holds the client (identity/stale.ts): since when it has. Their phone and their unverified email
   * link no order placed since then and hold none (whoever holds the number now may be someone else): such an order names them as
   * 'stale_record' for staff (W4c re-review 2). An order placed before then was the client's as it always was.
   */
  staleSince?: Date
}

/** The client's phone and unverified email speak for an order: they are not stale, or the order was placed before they were. */
const speaksFor = (c: CustomerRef, who: OrderIdentity): boolean =>
  c.staleSince === undefined || (who.createdOn !== undefined && who.createdOn.getTime() < c.staleSince.getTime())

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
  /** The Squarespace customer id of that order: a matched intent's renewals must come from the same Squarespace customer. */
  orderSqspCustomerId?: string
  /**
   * loadIntentRefs: a row an intent matched by itself (origin link, not a staff decision) whose order's Squarespace customer another
   * client holds (their link of any source, their membership row). It binds nothing: neither that order nor renewals (F1).
   */
  orderHeldByAnother?: boolean
  /** The intent's client as on file (loadIntentRefs): an open intent takes only an order whose phone and name, when it carries them, are theirs. */
  client?: { phone?: string; name?: string }
}

export type LinkedBy =
  | 'checkout_intent'
  | 'sqsp_customer_id'
  | 'email'
  | 'phone'
  | 'unverified_email'
  | 'intent_mismatch'
  | 'stale_record'
  | 'second_account'
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
  /**
   * linkedBy 'unverified_email': the one client whose unverified email the order carries; 'intent_mismatch': the client of the open
   * intent whose email the order carries with another phone or name. Never linked by the inference: staff confirm (awaiting_match).
   * 'stale_record': the stale record whose phone or unverified email the order carries; staff decide ("needs a customer").
   * 'second_account': the client whose phone or unverified email a Squarespace customer other than theirs pays with ("needs a
   * customer": the number may have a new holder; W4c re-review 4, E2).
   */
  candidateCustomerId?: string
  /**
   * Orders of this person that a checkout intent of ANOTHER client named but could not take, because this client holds the order
   * (its Squarespace customer, email or phone): the family-account case (W4c re-review 4, E3). The sync raises one alert per order
   * naming both clients. An order whose Squarespace customer staff linked to this client by hand is left out.
   */
  intentConflicts: { intentId: string; orderId: string; orderNumber: string; by: LinkedBy }[]
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
  /** by 'unverified_email', 'intent_mismatch', 'stale_record' or 'second_account': the client staff are asked about. */
  candidateCustomerId?: string
  /**
   * An intent that named this order but was ignored because another client holds the order (the other tiers, or that client's own
   * matched checkout, linked it, or nobody did).
   */
  intentConflict?: string
}

/** What an order says about who paid and for what, as the linking reads it. */
export interface OrderIdentity {
  email?: string
  phone?: string
  /** The name on the order (billing name). */
  name?: string
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

const nameWords = (n: string | undefined): string[] =>
  (n ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)

/**
 * Two names can be the same person's: the same words; or the same first word and nothing that conflicts: one of them is the first
 * name alone ("Nina" / "Nina New"), or the last words agree, an initial standing for a word ("Maria L. Delgado", "Ana R" / "Ana Ruiz").
 */
export function sameName(a: string | undefined, b: string | undefined): boolean {
  const x = nameWords(a)
  const y = nameWords(b)
  if (x.length === 0 || y.length === 0) return false
  if (x.join(' ') === y.join(' ')) return true
  if (x[0] !== y[0]) return false
  if (x.length === 1 || y.length === 1) return true
  const lx = x[x.length - 1]!
  const ly = y[y.length - 1]!
  return lx === ly || (lx.length === 1 && ly.startsWith(lx)) || (ly.length === 1 && lx.startsWith(ly))
}

/** A name the shop made up, not the client's: the walk-in default and the welcome flow's "New texter ••0142". */
const PLACEHOLDER_NAME = /^\s*(walk[\s-]*in guest|new texter\b)/i

/** No name to compare: a placeholder the shop made up, or none at all. Only the order's phone can show the order is the client's. */
const noRealName = (name: string | undefined): boolean => PLACEHOLDER_NAME.test(name ?? '') || nameWords(name).length === 0

/**
 * The order carries a phone or a name, and it is not the intent client's (a client with none on file matches nothing). A client
 * name that says too little to tell two people apart needs the order's phone too (W4c re-review I1): a single real word ("Maria"
 * matches "Maria Gonzalez" by design) needs the client's own phone on the order AND a name that can be theirs ("John Smith" with
 * Maria's phone is not hers; re-review 2, N2); a placeholder ("New texter ••0142", "Walk-in guest") or no name says nothing, so
 * the phone alone decides. An intent whose client was not loaded (`client` absent: never from loadIntentRefs, which always sets it)
 * is not checked.
 */
function notTheClient(who: OrderIdentity, intent: CheckoutIntentRef): boolean {
  if (!intent.client) return false
  const phone = normalizePhone(who.phone)
  if (phone !== undefined && normalizePhone(intent.client.phone) !== phone) return true
  if (noRealName(intent.client.name)) return phone === undefined
  if (nameWords(intent.client.name).length === 1 && phone === undefined) return true
  if (nameWords(who.name).length > 0 && !sameName(who.name, intent.client.name)) return true
  return false
}

/** The one client a set of intents names, or 'ambiguous' when they name several. */
function oneClient(hits: readonly CheckoutIntentRef[]): CheckoutIntentRef | 'ambiguous' | undefined {
  if (hits.length === 0) return undefined
  if (new Set(hits.map((h) => h.customerId)).size > 1) return 'ambiguous'
  return [...hits].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0]
}

/**
 * Another client than `clientId` holds the order, so an intent of `clientId` never takes it (F1): any Squarespace link of theirs
 * for the order's Squarespace customer (whatever its source), that customer on one of their membership rows, their email on file
 * (verified or NOT: after the identity migration no member's email is verified), their phone (unless the stale-record rule holds
 * them: a recycled number says nothing about them), or a checkout row of theirs bound to the same Squarespace customer or waiting on
 * this very order.
 */
function holdsOrder(who: OrderIdentity, customers: readonly CustomerRef[], intents: readonly CheckoutIntentRef[], clientId: string): boolean {
  const e = normalizeEmail(who.email)
  const p = normalizePhone(who.phone)
  const sq = who.sqspCustomerId
  const byClient = customers.some(
    (c) =>
      c.id !== clientId &&
      ((sq !== undefined && (c.sqspCustomerIds?.includes(sq) === true || c.heldSqspCustomerIds?.includes(sq) === true)) ||
        (e !== undefined && [...c.emails, ...(c.unverifiedEmails ?? [])].some((x) => normalizeEmail(x) === e)) ||
        (p !== undefined && speaksFor(c, who) && c.phones.some((x) => normalizePhone(x) === p))),
  )
  if (byClient) return true
  return intents.some(
    (i) =>
      i.customerId !== clientId &&
      (i.state === 'matched' || i.state === 'awaiting_match') &&
      ((sq !== undefined && i.orderSqspCustomerId === sq) || (who.orderId !== undefined && i.orderId === who.orderId)),
  )
}

/**
 * The checkout-intent tier: the order a row is bound to (a decision already taken, by an earlier pass or by staff), an open
 * intent's order, then the renewals of a matched intent. An intent whose client `taken` says another client holds the order is
 * left out (`refused` names one): it never takes the order, never makes it ambiguous, and the other tiers decide.
 */
function intentFor(
  who: OrderIdentity,
  intents: readonly CheckoutIntentRef[],
  taken: (clientId: string) => boolean,
): { link?: CustomerLink; refused?: string } {
  const binds = (i: CheckoutIntentRef): boolean => i.state === 'matched' && i.orderHeldByAnother !== true
  if (who.orderId) {
    const hit = oneClient(intents.filter((i) => binds(i) && i.orderId === who.orderId))
    if (hit === 'ambiguous') return { link: { by: 'ambiguous' } }
    if (hit) return { link: { customerId: hit.customerId, by: 'checkout_intent', intent: { id: hit.id, fresh: false } } }
  }
  const email = normalizeEmail(who.email)
  const product = who.product
  const at = who.createdOn?.getTime()
  if (!product || at === undefined) return {}
  let refused: string | undefined
  const usable = (hits: CheckoutIntentRef[]): CheckoutIntentRef[] => {
    const ok = hits.filter((i) => !taken(i.customerId))
    refused ??= hits.find((i) => !ok.includes(i))?.id
    return ok
  }
  const fits = (i: CheckoutIntentRef): boolean => email !== undefined && normalizeEmail(i.expectedEmail) === email && productFits(i, product)
  const open = oneClient(usable(intents.filter((i) => i.state === 'open' && fits(i) && i.startedAt.getTime() <= at && at <= i.expiresAt.getTime())))
  if (open === 'ambiguous') return { link: { by: 'ambiguous' }, refused }
  // the intent only names the email its client typed: an order carrying another phone or name may be anyone who used that email
  // (W4c fixes, "intent squatting"), so staff confirm it (awaiting_match) and the intent stays open
  if (open && notTheClient(who, open)) return { link: { by: 'intent_mismatch', candidateCustomerId: open.customerId }, refused }
  if (open) return { link: { customerId: open.customerId, by: 'checkout_intent', intent: { id: open.id, fresh: true } }, refused }
  // A renewal after a checkout of this client matched. When the bound order names its Squarespace customer, a renewal is an order of
  // that same Squarespace customer (Squarespace renews with the customer's current email, which may differ); only when it names none
  // do the email and product decide. Another payer using the intent's email is never a renewal of it.
  const renews = (i: CheckoutIntentRef): boolean => {
    if (!binds(i) || i.startedAt.getTime() > at) return false
    if (i.orderSqspCustomerId) return who.sqspCustomerId === i.orderSqspCustomerId && productFits(i, product)
    return fits(i)
  }
  const renewal = oneClient(usable(intents.filter(renews)))
  if (renewal === 'ambiguous') return { link: { by: 'ambiguous' }, refused }
  if (renewal) return { link: { customerId: renewal.customerId, by: 'checkout_intent', intent: { id: renewal.id, fresh: false } }, refused }
  return { refused }
}

/**
 * Link a Squarespace identity to an Oasis customer: a checkout intent, then the Squarespace customer id, then a verified email,
 * then the phone. An email nobody verified never links; an order it alone points at names the client as a candidate for staff.
 *
 * An intent only names the email the client typed, so it never takes an order another client holds (`holdsOrder`): such an
 * intent is ignored and the order links exactly as if it did not exist (its owner, awaiting_match for staff, or nobody), with
 * `intentConflict` naming the intent. Otherwise anyone could open an intent naming a member's email and take their renewals.
 */
export function linkCustomer(
  who: OrderIdentity,
  customers: readonly CustomerRef[],
  intents: readonly CheckoutIntentRef[] = [],
): CustomerLink {
  const byIntent = intentFor(who, intents, (clientId) => holdsOrder(who, customers, intents, clientId))
  // an intent refused while another one linked the order (its holder's own matched checkout) is a conflict all the same (E3)
  if (byIntent.link)
    return byIntent.refused && byIntent.link.customerId !== undefined ? { ...byIntent.link, intentConflict: byIntent.refused } : byIntent.link
  const link = linkByIdentity(who, customers)
  return byIntent.refused ? { ...link, intentConflict: byIntent.refused } : link
}

/**
 * The order comes from a Squarespace customer other than the one(s) the client already has (linked, on a membership row, or paid
 * on their record): a member normally has one account, so a second one using their phone or an email nobody verified may be a new
 * holder of the number (W4c re-review 4, E2). A client with no Squarespace customer yet, or an order naming none, is never one.
 */
const otherAccount = (c: CustomerRef, who: OrderIdentity): boolean =>
  who.sqspCustomerId !== undefined &&
  (c.heldSqspCustomerIds ?? []).length > 0 &&
  !(c.heldSqspCustomerIds ?? []).includes(who.sqspCustomerId)

/**
 * The tiers after the intents: the Squarespace customer id, a verified email, the phone, then an unverified email's candidate. A
 * stale record (CustomerRef.staleSince) takes no part in the phone and unverified-email tiers for an order placed since it went
 * stale: when only such a record carries the order's phone or email, the order names it as 'stale_record' for staff and links
 * nobody (W4c re-review 2, N1). Nor does a record that already has ANOTHER Squarespace customer (`otherAccount`): such an order
 * names it as 'second_account' for staff and links nobody (W4c re-review 4, E2).
 */
function linkByIdentity(who: OrderIdentity, customers: readonly CustomerRef[]): CustomerLink {
  const tiers: [LinkedBy, (c: CustomerRef) => boolean][] = []
  if (who.sqspCustomerId)
    tiers.push(['sqsp_customer_id', (c) => c.sqspCustomerIds?.includes(who.sqspCustomerId!) === true])
  const e = normalizeEmail(who.email)
  if (e) tiers.push(['email', (c) => c.emails.some((x) => normalizeEmail(x) === e)])
  const p = normalizePhone(who.phone)
  const byPhone = (c: CustomerRef): boolean => p !== undefined && c.phones.some((x) => normalizePhone(x) === p)
  const byUnverified = (c: CustomerRef): boolean => e !== undefined && (c.unverifiedEmails ?? []).some((x) => normalizeEmail(x) === e)
  const usable = (c: CustomerRef): boolean => speaksFor(c, who) && !otherAccount(c, who)
  if (p) tiers.push(['phone', (c) => usable(c) && byPhone(c)])
  for (const [by, test] of tiers) {
    const hits = customers.filter(test)
    if (hits.length === 1) return { customerId: hits[0]!.id, by }
    if (hits.length > 1) return { by: 'ambiguous' }
  }
  if (e) {
    const hits = customers.filter((c) => usable(c) && byUnverified(c))
    if (hits.length === 1) return { by: 'unverified_email', candidateCustomerId: hits[0]!.id }
    if (hits.length > 1) return { by: 'ambiguous' }
  }
  const stale = customers.filter((c) => !speaksFor(c, who) && (byPhone(c) || byUnverified(c)))
  if (stale.length === 1) return { by: 'stale_record', candidateCustomerId: stale[0]!.id }
  if (stale.length > 1) return { by: 'ambiguous' }
  const second = customers.filter((c) => speaksFor(c, who) && otherAccount(c, who) && (byPhone(c) || byUnverified(c)))
  if (second.length === 1) return { by: 'second_account', candidateCustomerId: second[0]!.id }
  if (second.length > 1) return { by: 'ambiguous' }
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
        name: order.customerName,
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
    // an order an intent named but another client holds, which no tier linked either: staff are told why
    const conflict = list.find((c) => c.link.intentConflict !== undefined && c.link.customerId === undefined)
    if (link.by === 'ambiguous' || conflict)
      flags.push({
        code: 'ambiguous_customer',
        orderId: conflict?.order.id,
        note: conflict
          ? `order ${conflict.order.orderNumber} carries the email of a checkout another client started, but its Squarespace customer, email or phone belongs to a different client: confirm whose it is`
          : 'more than one Oasis customer matches this email or phone',
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
      candidateCustomerId:
        link.by === 'unverified_email' || link.by === 'intent_mismatch' || link.by === 'stale_record' || link.by === 'second_account'
          ? link.candidateCustomerId
          : undefined,
      intentConflicts: list.flatMap((c) =>
        c.link.intentConflict !== undefined &&
        c.link.customerId !== undefined &&
        !(c.order.customerId !== undefined &&
          (customers.find((x) => x.id === c.link.customerId)?.staffSqspCustomerIds ?? []).includes(c.order.customerId))
          ? [{ intentId: c.link.intentConflict, orderId: c.order.id, orderNumber: c.order.orderNumber, by: c.link.by }]
          : [],
      ),
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
