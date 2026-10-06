// Read models of one invoice: the ledger events as the UI needs them and the full invoice detail (items, adjustment lines,
// calc, client credit, per-event approval rights for the caller). Shared by GET /invoices/:id and every command response.
import type { Executor } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { atLabel, clockLabel, DEFAULT_TZ, toBizDate } from '../../platform/time.js'
import type { PayActor } from './actor.js'
import { calcInvoice, statusLabel, type InvoiceCalc } from './calc.js'
import { clientCreditSummary, type ClientCreditSummary } from './credit-summary.js'
import { dayLabel } from './ranges.js'
import {
  calcOf,
  getInvoice,
  listEvents,
  listItems,
  type EventRow,
  type InvoiceRow,
  type ItemRow,
} from './repository.js'
import type { CreditExpiry, InvoiceStatus } from './schema.js'

export const EXPIRY_LABELS: Record<CreditExpiry, string> = { none: 'No expiry', d30: '30 days', d90: '90 days' }

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
}

export interface AdjustmentLineDto {
  eventId: string
  kind: 'discount' | 'surcharge'
  reason: string | null
  note: string | null
  amountCents: number
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
  /** Count of awaiting_processor events on this invoice (card money recorded but not yet seen in Squarespace). */
  awaitingProcessorCount: number
  version: number
  items: InvoiceItemDto[]
  adjustments: AdjustmentLineDto[]
  calc: InvoiceCalc
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

export function toEventDto(
  e: EventRow,
  o: { now: Date; tz: string; actor: PayActor | null; rules: ApprovalRules; voidedIds: ReadonlySet<string> },
): LedgerEventDto {
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
    approvedBy: e.approved_by_name ? `${e.approved_by_name}${e.approved_by_roles ? ` · ${e.approved_by_roles}` : ''}` : null,
    deniedBy: e.denied_by_name ? `${e.denied_by_name}${e.denied_by_roles ? ` · ${e.denied_by_roles}` : ''}` : null,
    at: e.occurred_at.toISOString(),
    atLabel: atLabel(e.occurred_at, o.now, o.tz),
    resolvedAt: e.resolved_at ? e.resolved_at.toISOString() : null,
    source: e.source,
    processorState: e.processor_state,
    awaitingProcessor: e.processor_state === 'awaiting_processor',
    processorRef: e.processor_ref,
    sqspOrderId: e.sqsp_order_id,
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

export interface DetailContext {
  locationId: string
  now: Date
  tz: string
  actor: PayActor | null
  rules: ApprovalRules
}

export async function invoiceDetail(db: Executor, c: DetailContext, invoiceId: string): Promise<InvoiceDetail> {
  const inv = await getInvoice(db, c.locationId, invoiceId)
  return buildDetail(db, c, inv)
}

export async function buildDetail(db: Executor, c: DetailContext, inv: InvoiceRow): Promise<InvoiceDetail> {
  const [items, events, calc, credit] = await Promise.all([
    listItems(db, inv.id),
    listEvents(db, inv.id),
    calcOf(db, inv.id),
    clientCreditSummary(db, inv.customer_id, c.now),
  ])
  if (!calc) throw new AppError('NOT_FOUND')
  const voidedIds = new Set(events.filter((e) => e.type === 'void' && e.voids_event_id).map((e) => e.voids_event_id!))
  const claimed = new Set(events.filter((e) => e.type === 'refund' && e.status !== 'denied').flatMap((e) => e.item_ids))
  const dto = events.map((e) => toEventDto(e, { now: c.now, tz: c.tz, actor: c.actor, rules: c.rules, voidedIds }))
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
    version: inv.version,
    items: items.map((i) => ({
      id: i.id,
      position: i.position,
      kind: i.kind,
      name: i.name,
      priceCents: i.price_cents,
      refunded: claimed.has(i.id),
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
      })),
    calc,
    clientCredit: credit,
    ledger: dto,
    caller: callerDto(c.actor),
  }
}

export { calcInvoice, DEFAULT_TZ }
