import type { SqspOrder, SqspTransaction } from '../../integrations/ports/squarespace.js'
import { identityMatch, type Contactable, type IdentityRef } from './identity.js'
import type { ProductMap, ResolvedProduct } from './product-map.js'

/**
 * Pure order/transaction-to-ledger matching. No I/O: the caller loads a MatchContext from the ledger and applies the
 * returned decision. Binding precedence (reviews B10, D14):
 *   0. money already recorded for this order or processor reference -> never record it twice
 *   1. a staff-recorded `awaiting_processor` event, same customer, equal amount, within 48 h -> confirm it
 *   2. a payment link on an invoice: customer + expected amount (tolerance) + window, exactly one candidate -> record pay
 *   3. otherwise the manual queue
 * Nothing auto-applies below the confidence threshold. Any equal-looking awaiting event blocks rule 2 (no double count).
 */
export interface MatcherConfig {
  /** Score at or above which a decision may be applied without a human. Default 0.8. */
  confidenceThreshold: number
  /** Rule 1 window, either direction. Default 48 h. */
  awaitingWindowMs: number
  /** Rule 2 window after the link was sent. Default 14 days. */
  linkWindowMs: number
  /** Rule 2 amount tolerance: max(cents, bp of the expected amount). Defaults 1 cent / 0 bp. */
  linkAmountToleranceCents: number
  linkAmountToleranceBp: number
  /** Alert when |Squarespace order total - Oasis invoice total| exceeds this. Default 100 cents. */
  varianceAlertCents: number
  /** Ignore orders none of whose line items are in the product map. Default true. */
  requireMappedSkus: boolean
  /** Treat test_mode orders like real ones. Default false. */
  includeTestMode: boolean
  maxManualCandidates: number
}

export const DEFAULT_MATCHER_CONFIG: MatcherConfig = {
  confidenceThreshold: 0.8,
  awaitingWindowMs: 48 * 3600_000,
  linkWindowMs: 14 * 86_400_000,
  linkAmountToleranceCents: 1,
  linkAmountToleranceBp: 0,
  varianceAlertCents: 100,
  requireMappedSkus: true,
  includeTestMode: false,
  maxManualCandidates: 3,
}

export interface Confidence {
  score: number
  level: 'high' | 'medium' | 'low'
}

export type AlertFlag =
  | 'variance_exceeds_delta'
  | 'external_refund'
  | 'partially_unmapped_skus'
  | 'mixed_membership_order'
  | 'refund_exceeds_payment'

export interface Variance {
  sqspTotalCents: number
  oasisTotalCents: number
  /** Squarespace minus Oasis. */
  deltaCents: number
  sqspTaxCents?: number
  oasisTaxCents?: number
  taxDeltaCents?: number
  exceedsAlert: boolean
}

export interface InvoiceSummary {
  id: string
  totalCents: number
  taxCents?: number
  balanceCents: number
  canceled?: boolean
  /** Pay events already on the invoice (any source), for the double-count guard. */
  payEvents?: {
    id: string
    amountCents: number
    methodKind?: 'card' | 'apple_pay' | 'cash' | 'store_credit' | 'other'
    sqspOrderId?: string
    processorRef?: string
  }[]
}

export interface LedgerEventRef {
  id: string
  type: 'pay' | 'refund'
  invoiceId: string
  customer: IdentityRef
  amountCents: number
  occurredAt: Date
  /** When a pending refund was approved: it can be paired with the feed from the request or from the approval. */
  resolvedAt?: Date
  processorState: 'na' | 'awaiting_processor' | 'confirmed' | 'failed'
  processorRef?: string
  sqspOrderId?: string
  source: 'oasis' | 'squarespace' | 'system' | 'seed'
  status?: 'pending' | 'done' | 'denied'
  invoice?: InvoiceSummary
}

export interface PaymentLinkRef {
  id: string
  invoiceId: string
  state: 'active' | 'paid' | 'expired' | 'canceled'
  expectedCents: number
  createdAt?: Date
  sentAt?: Date
  expiresAt?: Date
  /** Set when staff attached the Squarespace order number to the link (explicit match, no heuristics). */
  matchedSqspOrderId?: string
  customer: IdentityRef
  invoice: InvoiceSummary
}

export interface MatchContext {
  /** Ledger events tied to this order or its processor references, plus staff-recorded events waiting on the processor. */
  events: LedgerEventRef[]
  links: PaymentLinkRef[]
  /** The invoice this order is already booked against, when the loader knows it. */
  orderInvoiceId?: string
}

export interface Arrival {
  kind: 'payment' | 'refund'
  orderId: string
  orderNumber: string
  /** Squarespace payment or refund id; absent for an order-level arrival (order seen before its transaction). */
  transactionId?: string
  paymentId?: string
  occurredAt: Date
  amountCents: number
  currency: string
  brand?: string
  email?: string
  phone?: string
  sqspCustomerId?: string
  orderTotalCents: number
  orderTaxCents?: number
  source: 'transaction' | 'order'
}

export type ManualReason =
  | 'no_candidate'
  | 'ambiguous_awaiting'
  | 'ambiguous_link'
  | 'low_confidence'
  | 'possible_double_count'
  | 'invoice_settled'
  | 'overpayment'
  | 'refund_pending_approval'
  | 'currency_mismatch'

export interface MatchCandidate {
  kind: 'event' | 'link'
  id: string
  invoiceId: string
  score: number
  via: string
}

export type MatchRule = 'recorded' | 'awaiting' | 'link' | 'manual' | 'feed'

interface Common {
  arrival: Arrival
  rule: MatchRule
  confidence: Confidence
  variance?: Variance
  alerts: AlertFlag[]
  notes: string[]
}

export type MatchDecision = Common &
  (
    | { kind: 'already_recorded'; eventId: string; attachProcessorRef: boolean; attachSqspOrderId: boolean }
    | { kind: 'confirm_awaiting'; eventId: string; invoiceId: string }
    | { kind: 'create_payment'; invoiceId: string; paymentLinkId: string; deposit: boolean }
    | { kind: 'confirm_refund'; eventId: string; invoiceId: string }
    | { kind: 'record_external_refund'; invoiceId: string }
    | { kind: 'manual_queue'; reason: ManualReason; candidates: MatchCandidate[] }
    | { kind: 'defer'; reason: 'order_not_matched' }
  )

export function confidenceOf(score: number, cfg: MatcherConfig): Confidence {
  const s = Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000
  return {
    score: s,
    level: s >= cfg.confidenceThreshold ? 'high' : s >= cfg.confidenceThreshold - 0.2 ? 'medium' : 'low',
  }
}

/** True when a decision may be applied without a human. Manual and deferred decisions never are. */
export function isAutoApplicable(d: MatchDecision, cfg: MatcherConfig): boolean {
  return d.kind !== 'manual_queue' && d.kind !== 'defer' && d.confidence.score >= cfg.confidenceThreshold
}

// ---------------------------------------------------------------------------------------------------------------
// Order planning: what is this order, and which money arrivals does it contain?

export type IgnoreReason = 'test_mode' | 'unmapped_sku' | 'payment_failed'

export type OrderPlan =
  | { kind: 'ignore'; reason: IgnoreReason }
  | { kind: 'membership'; product: ResolvedProduct; alerts: AlertFlag[] }
  | { kind: 'no_payment_yet'; paymentState: string }
  | { kind: 'payments'; arrivals: Arrival[]; alerts: AlertFlag[] }

export function planOrder(
  order: SqspOrder,
  txns: SqspTransaction[],
  map: ProductMap,
  cfg: MatcherConfig,
  opts: { includeOrderLevel?: boolean } = {},
): OrderPlan {
  if (order.testMode && !cfg.includeTestMode) return { kind: 'ignore', reason: 'test_mode' }
  if (order.paymentState === 'FAILED') return { kind: 'ignore', reason: 'payment_failed' }

  const resolved = order.lineItems.map((li) => map.resolve(li))
  const mapped = resolved.filter((r): r is ResolvedProduct => r !== undefined)
  const membership = mapped.find((r) => r.kind === 'membership')
  if (membership) {
    const alerts: AlertFlag[] = mapped.some((r) => r.kind === 'service') ? ['mixed_membership_order'] : []
    return { kind: 'membership', product: membership, alerts }
  }
  if (cfg.requireMappedSkus && mapped.length === 0) return { kind: 'ignore', reason: 'unmapped_sku' }
  const alerts: AlertFlag[] = mapped.length < resolved.length ? ['partially_unmapped_skus'] : []

  const arrivals = arrivalsForOrder(order, txns, opts)
  if (arrivals.length === 0) return { kind: 'no_payment_yet', paymentState: order.paymentState ?? 'UNKNOWN' }
  return { kind: 'payments', arrivals, alerts }
}

/**
 * One arrival per payment and per refund in the Transactions feed. If the feed has no payment for the order yet but the
 * order says PAID, the order itself is the arrival (the feed catches up later and is then recognised as already recorded).
 */
export function arrivalsForOrder(
  order: SqspOrder,
  txns: SqspTransaction[],
  opts: { includeOrderLevel?: boolean } = {},
): Arrival[] {
  const base = {
    orderId: order.id,
    orderNumber: order.orderNumber,
    email: order.customerEmail,
    phone: order.customerPhone,
    sqspCustomerId: order.customerId,
    orderTotalCents: order.grandTotalCents,
    orderTaxCents: order.taxCents,
  }
  const rows = txns.filter((t) => t.orderId === order.id)
  const out: Arrival[] = rows.map((t) => ({
    ...base,
    kind: t.kind,
    transactionId: t.id,
    paymentId: t.paymentId,
    occurredAt: t.createdOn,
    amountCents: t.amountCents,
    currency: t.currency,
    brand: t.brand,
    email: t.customerEmail ?? order.customerEmail,
    source: 'transaction' as const,
  }))
  const hasPayment = rows.some((t) => t.kind === 'payment')
  if (
    !hasPayment &&
    (opts.includeOrderLevel ?? true) &&
    order.paymentState === 'PAID' &&
    order.grandTotalCents > 0
  ) {
    out.unshift({
      ...base,
      kind: 'payment',
      occurredAt: order.createdOn,
      amountCents: order.grandTotalCents,
      currency: order.currency,
      source: 'order',
    })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Matching

export function matchArrivals(
  plan: Extract<OrderPlan, { kind: 'payments' }>,
  ctx: MatchContext,
  cfg: MatcherConfig,
): MatchDecision[] {
  const consumed = new Set<string>()
  // Payments before refunds so a refund sees the pay event created by the same run.
  const ordered = [...plan.arrivals].sort((a, b) =>
    a.kind === b.kind ? a.occurredAt.getTime() - b.occurredAt.getTime() : a.kind === 'payment' ? -1 : 1,
  )
  return ordered.map((a) => {
    const d = matchArrival(a, ctx, cfg, consumed)
    for (const alert of plan.alerts) if (!d.alerts.includes(alert)) d.alerts.push(alert)
    if (d.kind === 'already_recorded' || d.kind === 'confirm_awaiting' || d.kind === 'confirm_refund')
      consumed.add(d.eventId)
    if (d.kind === 'create_payment') consumed.add(d.paymentLinkId)
    return d
  })
}

export function matchArrival(
  arrival: Arrival,
  ctx: MatchContext,
  cfg: MatcherConfig,
  consumed: Set<string> = new Set(),
): MatchDecision {
  const make = (
    rule: MatchRule,
    score: number,
    body: DistributiveOmit<MatchDecision, keyof Common>,
    extra: { variance?: Variance; alerts?: AlertFlag[]; notes?: string[] } = {},
  ): MatchDecision =>
    ({
      arrival,
      rule,
      confidence: confidenceOf(score, cfg),
      variance: extra.variance,
      alerts: [...(extra.alerts ?? [])],
      notes: extra.notes ?? [],
      ...body,
    }) as MatchDecision

  if (arrival.currency !== 'USD') {
    return make(
      'manual',
      0,
      { kind: 'manual_queue', reason: 'currency_mismatch', candidates: [] },
      { notes: [`currency ${arrival.currency}`] },
    )
  }

  const recorded = findRecorded(arrival, ctx, consumed)
  if (recorded) {
    return make('recorded', 1, {
      kind: 'already_recorded',
      eventId: recorded.id,
      attachProcessorRef: arrival.transactionId !== undefined && recorded.processorRef === undefined,
      attachSqspOrderId: recorded.sqspOrderId === undefined,
    })
  }
  return arrival.kind === 'refund'
    ? matchRefund(arrival, ctx, cfg, consumed, make)
    : matchPayment(arrival, ctx, cfg, consumed, make)
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type Make = (
  rule: MatchRule,
  score: number,
  body: DistributiveOmit<MatchDecision, keyof Common>,
  extra?: { variance?: Variance; alerts?: AlertFlag[]; notes?: string[] },
) => MatchDecision

/** Rule 0: money already in the ledger for this processor reference, or for this order and amount without one. */
function findRecorded(a: Arrival, ctx: MatchContext, consumed: Set<string>): LedgerEventRef | undefined {
  const type = a.kind === 'payment' ? 'pay' : 'refund'
  const live = ctx.events.filter((e) => e.type === type && e.status !== 'denied' && !consumed.has(e.id))
  if (a.transactionId) {
    const byRef = live.find((e) => e.processorRef === a.transactionId)
    if (byRef) return byRef
  }
  return live.find(
    (e) =>
      e.processorState !== 'awaiting_processor' &&
      e.sqspOrderId === a.orderId &&
      e.processorRef === undefined &&
      e.amountCents === a.amountCents,
  )
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

function timeScore(diffMs: number): number {
  const h = diffMs / 3600_000
  return h <= 6 ? 0.2 : h <= 24 ? 0.15 : 0.1
}

interface Scored {
  e: LedgerEventRef
  ident: number
  via: string
  score: number
}

function scoreAwaiting(a: Arrival, e: LedgerEventRef, cfg: MatcherConfig): Scored | undefined {
  const diff = Math.min(
    Math.abs(a.occurredAt.getTime() - e.occurredAt.getTime()),
    e.resolvedAt ? Math.abs(a.occurredAt.getTime() - e.resolvedAt.getTime()) : Number.POSITIVE_INFINITY,
  )
  if (e.amountCents !== a.amountCents || diff > cfg.awaitingWindowMs) return undefined
  const id = identityMatch(contactOf(a), e.customer)
  const orderLink = e.sqspOrderId === a.orderId
  const ident = Math.max(id.score, orderLink ? 0.5 : 0)
  return {
    e,
    ident,
    via: orderLink ? 'attached_order' : id.via,
    score: round3(ident + 0.3 + timeScore(diff)),
  }
}

function contactOf(a: Arrival): Contactable {
  return { email: a.email, phone: a.phone, sqspCustomerId: a.sqspCustomerId }
}

function toCandidate(s: Scored): MatchCandidate {
  return { kind: 'event', id: s.e.id, invoiceId: s.e.invoiceId, score: s.score, via: s.via }
}

function matchPayment(
  a: Arrival,
  ctx: MatchContext,
  cfg: MatcherConfig,
  consumed: Set<string>,
  make: Make,
): MatchDecision {
  const awaiting = ctx.events.filter(
    (e) =>
      e.type === 'pay' &&
      e.processorState === 'awaiting_processor' &&
      e.status !== 'denied' &&
      !consumed.has(e.id),
  )
  const cands = awaiting.map((e) => scoreAwaiting(a, e, cfg)).filter((s): s is Scored => s !== undefined)
  const strong = cands.filter((s) => s.ident > 0)

  // Rule 1
  if (strong.length === 1) {
    const s = strong[0]!
    const variance = varianceFor(a, s.e.invoice, cfg)
    const alerts: AlertFlag[] = variance?.exceedsAlert ? ['variance_exceeds_delta'] : []
    if (s.score >= cfg.confidenceThreshold) {
      return make(
        'awaiting',
        s.score,
        { kind: 'confirm_awaiting', eventId: s.e.id, invoiceId: s.e.invoiceId },
        { variance, alerts, notes: [`identity via ${s.via}`] },
      )
    }
    return make(
      'manual',
      s.score,
      { kind: 'manual_queue', reason: 'low_confidence', candidates: [toCandidate(s)] },
      { variance, alerts },
    )
  }
  if (strong.length > 1) {
    return make('manual', Math.max(...strong.map((s) => s.score)), {
      kind: 'manual_queue',
      reason: 'ambiguous_awaiting',
      candidates: top(strong.map(toCandidate), cfg),
    })
  }
  if (cands.length > 0) {
    // Equal amount in the window but nothing says it is the same customer: a human decides, and rule 2 must not run.
    return make(
      'manual',
      Math.max(...cands.map((s) => s.score)),
      { kind: 'manual_queue', reason: 'low_confidence', candidates: top(cands.map(toCandidate), cfg) },
      { notes: ['awaiting event with equal amount but no customer match'] },
    )
  }

  // Rule 2
  const linkOutcome = matchLink(a, ctx, cfg, consumed, make, awaiting)
  if (linkOutcome) return linkOutcome

  // Rule 3
  return make('manual', 0, {
    kind: 'manual_queue',
    reason: 'no_candidate',
    candidates: suggestionsFor(a, ctx, cfg),
  })
}

function amountTolerance(expected: number, cfg: MatcherConfig): number {
  return Math.max(cfg.linkAmountToleranceCents, Math.ceil((expected * cfg.linkAmountToleranceBp) / 10_000))
}

function matchLink(
  a: Arrival,
  ctx: MatchContext,
  cfg: MatcherConfig,
  consumed: Set<string>,
  make: Make,
  awaiting: LedgerEventRef[],
): MatchDecision | undefined {
  const open = ctx.links.filter((l) => !consumed.has(l.id) && !l.invoice.canceled && l.state !== 'canceled')
  const explicit = open.filter((l) => l.matchedSqspOrderId === a.orderId)
  let chosen: { link: PaymentLinkRef; score: number; via: string } | undefined

  if (explicit.length > 1) {
    return make('manual', 0, {
      kind: 'manual_queue',
      reason: 'ambiguous_link',
      candidates: top(
        explicit.map((l) => linkCandidate(l, 1, 'attached_order')),
        cfg,
      ),
    })
  }
  if (explicit.length === 1) {
    chosen = { link: explicit[0]!, score: 1, via: 'attached_order' }
  } else {
    const scored = open
      .filter((l) => l.state === 'active')
      .map((l) => scoreLink(a, l, cfg))
      .filter((s): s is NonNullable<typeof s> => s !== undefined)
    const strong = scored.filter((s) => s.ident > 0)
    if (strong.length > 1) {
      return make('manual', Math.max(...strong.map((s) => s.score)), {
        kind: 'manual_queue',
        reason: 'ambiguous_link',
        candidates: top(
          strong.map((s) => linkCandidate(s.link, s.score, s.via)),
          cfg,
        ),
      })
    }
    if (strong.length === 0) return undefined
    chosen = strong[0]!
  }

  const { link } = chosen
  const inv = link.invoice
  const tol = amountTolerance(link.expectedCents, cfg)
  const variance = varianceFor(a, inv, cfg)
  const alerts: AlertFlag[] = variance?.exceedsAlert ? ['variance_exceeds_delta'] : []
  const cand = [linkCandidate(link, chosen.score, chosen.via)]
  const manual = (reason: ManualReason, note: string): MatchDecision =>
    make(
      'manual',
      chosen.score,
      { kind: 'manual_queue', reason, candidates: cand },
      { variance, alerts, notes: [note] },
    )

  // Never create a second pay event for money that is already recorded or being recorded.
  const sameMoney = (inv.payEvents ?? []).find(
    (p) =>
      p.sqspOrderId !== a.orderId &&
      Math.abs(p.amountCents - a.amountCents) <= tol &&
      p.methodKind !== 'cash' &&
      p.methodKind !== 'store_credit',
  )
  if (sameMoney)
    return manual(
      'possible_double_count',
      `invoice already has a card/other pay event of the same amount (${sameMoney.id})`,
    )
  const nearAwaiting = awaiting.find(
    (e) =>
      e.invoiceId === inv.id ||
      (identityMatch(contactOf(a), e.customer).score > 0 &&
        Math.abs(a.occurredAt.getTime() - e.occurredAt.getTime()) <= cfg.awaitingWindowMs),
  )
  if (nearAwaiting)
    return manual(
      'possible_double_count',
      `an unconfirmed staff-recorded payment exists (${nearAwaiting.id}) with a different amount`,
    )
  if (inv.balanceCents <= 0) return manual('invoice_settled', 'invoice has no balance left')
  if (a.amountCents > inv.balanceCents + tol)
    return manual('overpayment', `payment ${a.amountCents} exceeds balance ${inv.balanceCents}`)
  if (chosen.score < cfg.confidenceThreshold) return manual('low_confidence', 'below confidence threshold')

  return make(
    'link',
    chosen.score,
    {
      kind: 'create_payment',
      invoiceId: inv.id,
      paymentLinkId: link.id,
      deposit: a.amountCents < inv.balanceCents - tol,
    },
    { variance, alerts, notes: [`identity via ${chosen.via}`] },
  )
}

function scoreLink(a: Arrival, l: PaymentLinkRef, cfg: MatcherConfig) {
  const start = (l.sentAt ?? l.createdAt)?.getTime()
  if (start === undefined) return undefined
  const end = Math.min(start + cfg.linkWindowMs, l.expiresAt?.getTime() ?? Infinity)
  const t = a.occurredAt.getTime()
  if (t < start || t > end) return undefined
  const diff = Math.abs(a.amountCents - l.expectedCents)
  if (diff > amountTolerance(l.expectedCents, cfg)) return undefined
  const id = identityMatch(contactOf(a), l.customer)
  return { link: l, ident: id.score, via: id.via, score: round3(id.score + (diff === 0 ? 0.3 : 0.25) + 0.15) }
}

function linkCandidate(l: PaymentLinkRef, score: number, via: string): MatchCandidate {
  return { kind: 'link', id: l.id, invoiceId: l.invoiceId, score, via }
}

function top(c: MatchCandidate[], cfg: MatcherConfig): MatchCandidate[] {
  return [...c].sort((x, y) => y.score - x.score).slice(0, cfg.maxManualCandidates)
}

/** Weak suggestions for the manual queue: events or links with a similar amount in a plausible window. */
function suggestionsFor(a: Arrival, ctx: MatchContext, cfg: MatcherConfig): MatchCandidate[] {
  const out: MatchCandidate[] = []
  for (const l of ctx.links) {
    if (l.invoice.canceled || l.state === 'canceled') continue
    const s = scoreLink(a, l, cfg)
    if (s) out.push(linkCandidate(l, s.score, s.via))
  }
  return top(out, cfg)
}

function varianceFor(a: Arrival, inv: InvoiceSummary | undefined, cfg: MatcherConfig): Variance | undefined {
  if (!inv) return undefined
  const delta = a.orderTotalCents - inv.totalCents
  const taxDelta =
    a.orderTaxCents !== undefined && inv.taxCents !== undefined ? a.orderTaxCents - inv.taxCents : undefined
  return {
    sqspTotalCents: a.orderTotalCents,
    oasisTotalCents: inv.totalCents,
    deltaCents: delta,
    sqspTaxCents: a.orderTaxCents,
    oasisTaxCents: inv.taxCents,
    taxDeltaCents: taxDelta,
    exceedsAlert: Math.abs(delta) > cfg.varianceAlertCents,
  }
}

function matchRefund(
  a: Arrival,
  ctx: MatchContext,
  cfg: MatcherConfig,
  consumed: Set<string>,
  make: Make,
): MatchDecision {
  const awaiting = ctx.events.filter(
    (e) =>
      e.type === 'refund' &&
      e.processorState === 'awaiting_processor' &&
      e.status !== 'denied' &&
      !consumed.has(e.id),
  )
  const cands = awaiting.map((e) => scoreAwaiting(a, e, cfg)).filter((s): s is Scored => s !== undefined)
  const strong = cands.filter((s) => s.ident > 0)

  if (strong.length === 1) {
    const s = strong[0]!
    if (s.e.status === 'pending') {
      return make(
        'manual',
        s.score,
        { kind: 'manual_queue', reason: 'refund_pending_approval', candidates: [toCandidate(s)] },
        { notes: ['feed shows the refund but Oasis approval is still pending'] },
      )
    }
    if (s.score >= cfg.confidenceThreshold) {
      return make(
        'awaiting',
        s.score,
        { kind: 'confirm_refund', eventId: s.e.id, invoiceId: s.e.invoiceId },
        { notes: [`identity via ${s.via}`] },
      )
    }
    return make('manual', s.score, {
      kind: 'manual_queue',
      reason: 'low_confidence',
      candidates: [toCandidate(s)],
    })
  }
  if (strong.length > 1) {
    return make('manual', Math.max(...strong.map((s) => s.score)), {
      kind: 'manual_queue',
      reason: 'ambiguous_awaiting',
      candidates: top(strong.map(toCandidate), cfg),
    })
  }
  if (cands.length > 0) {
    return make('manual', Math.max(...cands.map((s) => s.score)), {
      kind: 'manual_queue',
      reason: 'low_confidence',
      candidates: top(cands.map(toCandidate), cfg),
    })
  }

  // No Oasis event for this refund: it was done in Squarespace directly (bypassing Oasis limits and approvals).
  const invoiceId =
    ctx.orderInvoiceId ?? ctx.events.find((e) => e.type === 'pay' && e.sqspOrderId === a.orderId)?.invoiceId
  if (!invoiceId)
    return make(
      'feed',
      0,
      { kind: 'defer', reason: 'order_not_matched' },
      { notes: ['refund for an order not yet booked against an invoice'] },
    )
  const alerts: AlertFlag[] = ['external_refund']
  const paid = ctx.events
    .filter((e) => e.type === 'pay' && e.invoiceId === invoiceId)
    .reduce((n, e) => n + e.amountCents, 0)
  if (paid > 0 && a.amountCents > paid) alerts.push('refund_exceeds_payment')
  return make(
    'feed',
    0.95,
    { kind: 'record_external_refund', invoiceId },
    { alerts, notes: ['refund exists only in the Squarespace Transactions feed'] },
  )
}

/** Staff-recorded events still waiting on the processor after `thresholdMs` (default 24 h): the alert-card query. */
export function findOverdueAwaiting(
  events: LedgerEventRef[],
  now: Date,
  thresholdMs = 24 * 3600_000,
): LedgerEventRef[] {
  return events.filter(
    (e) =>
      e.processorState === 'awaiting_processor' &&
      e.status !== 'denied' &&
      now.getTime() - e.occurredAt.getTime() > thresholdMs,
  )
}
