// Read models of one invoice: the ledger events as the UI needs them and the full invoice detail (items, adjustment lines,
// calc, client credit, per-event approval rights for the caller). Shared by GET /invoices/:id and every command response.
import type { Executor } from '../../platform/db.js'
import { atLabel, clockLabel, toBizDate } from '../../platform/time.js'
import type { PayActor } from './actor.js'
import { statusLabel, type InvoiceCalc } from './calc.js'
import { clientCreditSummary, type ClientCreditSummary } from './credit-summary.js'
import { dayLabel } from './ranges.js'
import {
  calcOf,
  getInvoice,
  listEvents,
  listItems,
  originalRefundCap,
  type EventRow,
  type InvoiceRow,
  type ItemRow,
} from './repository.js'
import type { CreditExpiry, InvoiceStatus } from './schema.js'
import { coverageOf, lineClassLabel, type CoverageLine } from './gateway.js'
import { squareEnv } from '../square/runtime.js'
import { balanceCardsFor, processingOf, type InvoiceProcessing } from '../square/tenders.js'
import '../square/db/schema.js'

export const EXPIRY_LABELS: Record<CreditExpiry, string> = {
  none: 'No expiry',
  d30: '30 days',
  d90: '90 days',
}

export type ApproveBlock = 'permission' | 'limit' | 'self' | null

export interface LedgerEventDto {
  id: string
  seq: number
  type: EventRow['type']
  status: EventRow['status']
  amountCents: number
  method: string | null
  methodKind: EventRow['method_kind']
  brand: string | null
  last4: string | null
  dest: EventRow['dest']
  deposit: boolean
  reason: string | null
  note: string | null
  expiry: CreditExpiry | null
  expiryLabel: string | null
  expiresAt: string | null
  itemIds: string[]
  parentEventId: string | null
  voidsEventId: string | null
  /** A pay event that a later void cancelled. */
  voided: boolean
  by: string | null
  byRole: string | null
  approvedBy: string | null
  deniedBy: string | null
  at: string
  atLabel: string
  resolvedAt: string | null
  source: EventRow['source']
  processorState: EventRow['processor_state']
  awaitingProcessor: boolean
  processorRef: string | null
  sqspOrderId: string | null
  /** Which processor took (or is to take) the card money: squarespace, square, or null (cash, credit, nothing yet). */
  processor: EventRow['processor']
  /** The Square order of a Square payment (a link's order, a POS order). */
  processorOrderId: string | null
  /** Square's receipt number of a Square payment ("1a2B"); null for anything else or before Square told it. */
  receiptNumber: string | null
  /** Square's receipt page of that payment, only when it is an https page on Square's own receipt hosts; else null. */
  receiptUrl: string | null
  needsReview: boolean
  /** Pending refunds only: whether the caller can approve it now, and why not. */
  canApprove: boolean
  approveBlock: ApproveBlock
}

export interface InvoiceItemDto {
  id: string
  position: number
  kind: ItemRow['kind']
  name: string
  priceCents: number
  /** Claimed by a done or pending by-item refund. */
  refunded: boolean
  /** The regular price at the visit's size (ADR 0170); null on a line priced before sizes. */
  listCents: number | null
  /** The member % off applied, in basis points (null before sizes). */
  discountBp: number | null
  /** list - price: the member % off in cents. */
  memberDiscountCents: number
  /** The size the line is priced at ("Large SUV"); null when unknown or not priced by size. */
  classLabel: string | null
}

export interface AdjustmentLineDto {
  eventId: string
  kind: 'discount' | 'surcharge'
  reason: string | null
  note: string | null
  amountCents: number
  /** A membership's coverage of one line (ADR 0170): "Covered $40 · $20 size difference due"; null for any other adjustment. */
  coverage: {
    serviceName: string
    coveredCents: number
    lineCents: number
    differenceCents: number
    planClassLabel: string | null
  } | null
}

export interface CallerDto {
  canCollect: boolean
  canRefund: boolean
  canAdjust: boolean
  canCredit: boolean
  canVoid: boolean
  /** Cents; null = unlimited. */
  refundLimitCents: number | null
  adjustLimitCents: number | null
  creditLimitCents: number | null
}

/**
 * The refund caps the refund command applies, after every done and pending refund (a pending request reserves its money):
 * `cardCents` caps a refund to card (the card money not given back), `otherCents` a refund to cash (the money paid by
 * anything but store credit), `totalCents` every refund (calc.refundable). The command checks, in this order: card
 * `cardCents` then `totalCents`; cash `totalCents` then `otherCents`; store credit `totalCents`.
 */
export interface RefundCapsDto {
  cardCents: number
  otherCents: number
  totalCents: number
}

export interface InvoiceDetail {
  id: string
  invoiceNo: number
  label: string
  appointmentId: string | null
  customerId: string
  client: string
  vehicle: string
  staff: string
  occurredAt: string
  bizDate: string
  /** "Today 10:31 AM" / "Yesterday 2:10 PM" / "Jun 11 11:00 AM". */
  when: string
  status: InvoiceStatus
  statusLabel: string
  refundPending: boolean
  canceled: boolean
  cancelReason: InvoiceRow['cancel_reason']
  taxBp: number
  tipCents: number
  paymentLinkUrl: string | null
  /** Count of awaiting_processor events on this invoice (card money recorded but not yet confirmed by its processor). */
  awaitingProcessorCount: number
  /**
   * Who takes new card money (PAYMENT_PROCESSOR, ADR 0171), whether "Open Square POS" is on (SQUARE_POS_API_ENABLED) and which
   * Square tenders may be offered (the same block as the appointment file's invoice summary).
   */
  processing: InvoiceProcessing
  version: number
  items: InvoiceItemDto[]
  adjustments: AdjustmentLineDto[]
  calc: InvoiceCalc
  refundCaps: RefundCapsDto
  clientCredit: ClientCreditSummary
  ledger: LedgerEventDto[]
  caller: CallerDto | null
}

export interface ApprovalRules {
  /** approvals.allow_self */
  allowSelf: boolean
}

/** Can this actor approve this pending refund now? Mirrors approveRefund's checks, minus re-validation of amounts. */
export function approvalRights(
  actor: PayActor | null,
  e: Pick<EventRow, 'type' | 'status' | 'amount_cents' | 'actor_user_id'>,
  rules: ApprovalRules,
): { canApprove: boolean; block: ApproveBlock } {
  if (e.type !== 'refund' || e.status !== 'pending' || !actor) return { canApprove: false, block: null }
  if (!actor.has('pay.refund')) return { canApprove: false, block: 'permission' }
  const limit = actor.limit('refund')
  if (limit !== null && limit < e.amount_cents) return { canApprove: false, block: 'limit' }
  if (e.actor_user_id === actor.userId && limit !== null && !rules.allowSelf)
    return { canApprove: false, block: 'self' }
  return { canApprove: true, block: null }
}

/** Square's receipt pages: https on squareup.com or squareupsandbox.com (or a subdomain). Anything else is not shown. */
export function safeReceiptUrl(url: string | null | undefined): string | null {
  if (!url || url.length > 2048) return null
  try {
    const u = new URL(url)
    const host = u.hostname.toLowerCase()
    const square = ['squareup.com', 'squareupsandbox.com'].some((d) => host === d || host.endsWith(`.${d}`))
    return u.protocol === 'https:' && square && !u.username && !u.password && !u.port ? u.toString() : null
  } catch {
    return null
  }
}

export interface SquareReceipt {
  receiptNumber: string | null
  receiptUrl: string | null
}

/** The receipts of the Square payments behind these ledger rows (pay rows with processor square), by Square payment id. */
export async function squareReceiptsOf(db: Executor, locationId: string, events: readonly EventRow[]): Promise<Map<string, SquareReceipt>> {
  const ids = [...new Set(events.filter((e) => e.type === 'pay' && e.processor === 'square' && e.processor_ref).map((e) => e.processor_ref!))]
  const out = new Map<string, SquareReceipt>()
  if (ids.length === 0) return out
  const rows = await db
    .selectFrom('square_payments')
    .select(['square_payment_id', 'receipt_number', 'receipt_url'])
    .where('location_id', '=', locationId)
    .where('square_payment_id', 'in', ids)
    .execute()
  for (const r of rows) out.set(r.square_payment_id, { receiptNumber: r.receipt_number, receiptUrl: safeReceiptUrl(r.receipt_url) })
  return out
}

export function toEventDto(
  e: EventRow,
  o: {
    now: Date
    tz: string
    actor: PayActor | null
    rules: ApprovalRules
    voidedIds: ReadonlySet<string>
    receipts?: ReadonlyMap<string, SquareReceipt>
  },
): LedgerEventDto {
  const receipt = e.type === 'pay' && e.processor === 'square' && e.processor_ref ? o.receipts?.get(e.processor_ref) : undefined
  const rights = approvalRights(o.actor, e, o.rules)
  return {
    id: e.id,
    seq: e.seq,
    type: e.type,
    status: e.status,
    amountCents: e.amount_cents,
    method: e.method,
    methodKind: e.method_kind,
    brand: e.brand,
    last4: e.last4,
    dest: e.dest,
    deposit: e.deposit,
    reason: e.reason,
    note: e.note,
    expiry: e.expiry,
    expiryLabel: e.expiry ? EXPIRY_LABELS[e.expiry] : null,
    expiresAt: e.expires_at ? e.expires_at.toISOString() : null,
    itemIds: e.item_ids,
    parentEventId: e.parent_event_id,
    voidsEventId: e.voids_event_id,
    voided: o.voidedIds.has(e.id),
    by: e.actor_name,
    byRole: e.actor_roles,
    approvedBy: e.approved_by_name
      ? `${e.approved_by_name}${e.approved_by_roles ? ` · ${e.approved_by_roles}` : ''}`
      : null,
    deniedBy: e.denied_by_name
      ? `${e.denied_by_name}${e.denied_by_roles ? ` · ${e.denied_by_roles}` : ''}`
      : null,
    at: e.occurred_at.toISOString(),
    atLabel: atLabel(e.occurred_at, o.now, o.tz),
    resolvedAt: e.resolved_at ? e.resolved_at.toISOString() : null,
    source: e.source,
    processorState: e.processor_state,
    awaitingProcessor: e.processor_state === 'awaiting_processor',
    processorRef: e.processor_ref,
    sqspOrderId: e.sqsp_order_id,
    processor: e.processor,
    processorOrderId: e.processor_order_id,
    receiptNumber: receipt?.receiptNumber ?? null,
    receiptUrl: receipt?.receiptUrl ?? null,
    needsReview: e.needs_review,
    canApprove: rights.canApprove,
    approveBlock: rights.block,
  }
}

export function callerDto(actor: PayActor | null): CallerDto | null {
  if (!actor) return null
  return {
    canCollect: actor.has('pay.collect'),
    canRefund: actor.has('pay.refund'),
    canAdjust: actor.has('pay.adjust'),
    canCredit: actor.has('pay.credit'),
    canVoid: actor.has('pay.void'),
    refundLimitCents: actor.has('pay.refund') ? actor.limit('refund') : 0,
    adjustLimitCents: actor.has('pay.adjust') ? actor.limit('adjust') : 0,
    creditLimitCents: actor.has('pay.credit') ? actor.limit('credit') : 0,
  }
}

const coverageDto = (x: CoverageLine | undefined): AdjustmentLineDto['coverage'] =>
  x
    ? {
        serviceName: x.serviceName,
        coveredCents: x.coveredCents,
        lineCents: x.lineCents,
        differenceCents: x.differenceCents,
        planClassLabel: x.planClassLabel,
      }
    : null

export interface DetailContext {
  locationId: string
  now: Date
  tz: string
  actor: PayActor | null
  rules: ApprovalRules
}

export async function invoiceDetail(
  db: Executor,
  c: DetailContext,
  invoiceId: string,
): Promise<InvoiceDetail> {
  const inv = await getInvoice(db, c.locationId, invoiceId)
  return buildDetail(db, c, inv)
}

export async function buildDetail(db: Executor, c: DetailContext, inv: InvoiceRow): Promise<InvoiceDetail> {
  const [items, events, calc, credit, cardCap, otherCap, coverage] = await Promise.all([
    listItems(db, inv.id),
    listEvents(db, inv.id),
    calcOf(db, inv.id),
    clientCreditSummary(db, inv.customer_id, c.now),
    originalRefundCap(db, inv.id, 'card'),
    originalRefundCap(db, inv.id, 'cash'),
    coverageOf(db, [inv.id]),
  ])
  const covered = new Map((coverage.get(inv.id) ?? []).map((x) => [x.eventId, x]))
  const voidedIds = new Set(
    events.filter((e) => e.type === 'void' && e.voids_event_id).map((e) => e.voids_event_id!),
  )
  // a refund the processor reported failed gave nothing back: its items can be refunded again
  const claimed = new Set(
    events
      .filter((e) => e.type === 'refund' && e.status !== 'denied' && e.processor_state !== 'failed')
      .flatMap((e) => e.item_ids),
  )
  const env = squareEnv()
  const [receipts, cards] = await Promise.all([
    squareReceiptsOf(db, inv.location_id, events),
    balanceCardsFor(db, env, { locationId: inv.location_id, customerIds: inv.canceled_at ? [] : [inv.customer_id], now: c.now }),
  ])
  const dto = events.map((e) =>
    toEventDto(e, { now: c.now, tz: c.tz, actor: c.actor, rules: c.rules, voidedIds, receipts }),
  )
  const refundPending = calc.pendingN > 0
  const today = toBizDate(c.now, c.tz)
  return {
    id: inv.id,
    invoiceNo: inv.invoice_no,
    label: `INV-${String(inv.invoice_no).padStart(5, '0')}`,
    appointmentId: inv.appointment_id,
    customerId: inv.customer_id,
    client: inv.client_name,
    vehicle: inv.vehicle_label,
    staff: inv.staff_label,
    occurredAt: inv.occurred_at.toISOString(),
    bizDate: inv.biz_date,
    when: `${dayLabel(inv.biz_date, today)} ${clockLabel(inv.occurred_at, c.tz)}`,
    status: calc.status,
    statusLabel: statusLabel(calc.status, refundPending),
    refundPending,
    canceled: inv.canceled_at !== null,
    cancelReason: inv.cancel_reason,
    taxBp: inv.tax_bp,
    tipCents: inv.tip_cents,
    paymentLinkUrl: inv.payment_link_url,
    awaitingProcessorCount: events.filter((e) => e.processor_state === 'awaiting_processor').length,
    processing: processingOf(env, { card: cards.get(inv.customer_id) ?? null, canceled: inv.canceled_at !== null }),
    version: inv.version,
    items: items.map((i) => ({
      id: i.id,
      position: i.position,
      kind: i.kind,
      name: i.name,
      priceCents: i.price_cents,
      refunded: claimed.has(i.id),
      listCents: i.list_cents,
      discountBp: i.discount_bp,
      memberDiscountCents: i.list_cents === null ? 0 : i.list_cents - i.price_cents,
      classLabel: lineClassLabel(i.price_basis, inv.vehicle_class_label),
    })),
    adjustments: events
      .filter((e) => e.type === 'adjust')
      .sort((a, b) => a.seq - b.seq)
      .map((e) => ({
        eventId: e.id,
        kind: e.amount_cents < 0 ? ('discount' as const) : ('surcharge' as const),
        reason: e.reason,
        note: e.note,
        amountCents: e.amount_cents,
        coverage: coverageDto(covered.get(e.id)),
      })),
    calc,
    refundCaps: { cardCents: cardCap, otherCents: otherCap, totalCents: calc.refundable },
    clientCredit: credit,
    ledger: dto,
    caller: callerDto(c.actor),
  }
}
