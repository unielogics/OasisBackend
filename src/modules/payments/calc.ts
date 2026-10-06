// Pure twin of the invoice_calc SQL (migration 20261006190000_payments.sql): the Payments design's calc() in integer
// cents with the review fixes. Used for sheet previews (adjust, by-item refund), seeds and the equality tests against SQL.
import { divHalfUp, percentOfCents, taxCents } from '../../platform/money.js'
import type { InvoiceStatus, LedgerType, RefundDest, RefundStatus } from './schema.js'

export interface CalcEvent {
  type: LedgerType
  /** adjust is signed (negative = discount); every other type is positive. */
  amountCents: number
  status?: RefundStatus
  dest?: RefundDest | null
}

export interface CalcInput {
  /** Price snapshot of every invoice line (package and add-ons). */
  itemPrices: readonly number[]
  events: readonly CalcEvent[]
  taxBp: number
  tipCents: number
  canceled: boolean
}

export interface InvoiceCalc {
  items: number
  adj: number
  sub: number
  tax: number
  tip: number
  total: number
  paidOrig: number
  creditApplied: number
  paid: number
  refunded: number
  refOrig: number
  pendingAmt: number
  pendingN: number
  issued: number
  balance: number
  refundable: number
  toOrigMax: number
  net: number
  overpaid: number
  status: InvoiceStatus
}

const sum = (xs: Iterable<number>): number => {
  let t = 0
  for (const x of xs) t += x
  return t
}

/** net revenue of an invoice: items + adjustments less the refunds with their tax portion removed (half-up). */
export function netCents(items: number, adj: number, refunded: number, taxBp: number): number {
  return items + adj - divHalfUp(refunded * 10_000, 10_000 + taxBp)
}

export function deriveStatus(v: {
  canceled: boolean
  paid: number
  refunded: number
  balance: number
}): InvoiceStatus {
  if (v.canceled && v.paid === 0 && v.refunded === 0) return 'canceled'
  if (v.canceled && v.refunded >= v.paid) return 'canceled_refunded'
  if (v.canceled) return 'canceled_kept'
  if (v.refunded > 0 && v.refunded >= v.paid - 1) return 'refunded'
  if (v.paid === 0) return 'unpaid'
  if (v.balance > 0) return 'partially_paid'
  if (v.refunded > 0) return 'partially_refunded'
  return 'paid'
}

export function calcInvoice(input: CalcInput): InvoiceCalc {
  const ev = input.events
  const of = (t: LedgerType, pred: (e: CalcEvent) => boolean = () => true): number =>
    sum(ev.filter((e) => e.type === t && pred(e)).map((e) => e.amountCents))
  const items = sum(input.itemPrices)
  const adj = of('adjust')
  const sub = Math.max(items + adj, 0)
  const tax = taxCents(sub, input.taxBp)
  const total = sub + tax + input.tipCents
  const paidOrig = of('pay') - of('void')
  const creditApplied = of('credit_apply')
  const paid = paidOrig + creditApplied
  const refunded = of('refund', (e) => e.status === 'done')
  const refOrig = of('refund', (e) => e.status === 'done' && e.dest !== 'credit')
  const pending = ev.filter((e) => e.type === 'refund' && e.status === 'pending')
  const pendingAmt = sum(pending.map((e) => e.amountCents))
  const balance = input.canceled ? 0 : Math.max(0, total - paid)
  return {
    items,
    adj,
    sub,
    tax,
    tip: input.tipCents,
    total,
    paidOrig,
    creditApplied,
    paid,
    refunded,
    refOrig,
    pendingAmt,
    pendingN: pending.length,
    issued: of('credit_issue'),
    balance,
    refundable: Math.max(0, paid - refunded - pendingAmt),
    toOrigMax: Math.max(0, paidOrig - refOrig),
    net: netCents(items, adj, refunded, input.taxBp),
    overpaid: Math.max(0, paid - refunded - total),
    status: deriveStatus({ canceled: input.canceled, paid, refunded, balance }),
  }
}

/** "Paid", "Unpaid", ... as the design's pills read; 'Refund pending' replaces the label while a refund waits. */
export const STATUS_LABELS: Record<InvoiceStatus, string> = {
  paid: 'Paid',
  unpaid: 'Unpaid',
  partially_paid: 'Partially paid',
  partially_refunded: 'Partially refunded',
  refunded: 'Refunded',
  canceled: 'Canceled',
  canceled_kept: 'Canceled · deposit kept',
  canceled_refunded: 'Canceled · refunded',
}

export const REFUND_PENDING_LABEL = 'Refund pending'

export const statusLabel = (status: InvoiceStatus, refundPending: boolean): string =>
  refundPending ? REFUND_PENDING_LABEL : STATUS_LABELS[status]

/** By-item refund value: the selected lines with the invoice tax rate, never more than what is refundable. */
export function itemsRefundValue(
  selectedPrices: readonly number[],
  taxBp: number,
  refundable: number,
): number {
  return Math.min(refundable, divHalfUp(sum(selectedPrices) * (10_000 + taxBp), 10_000))
}

export interface AdjustInput {
  kind: 'discount' | 'surcharge'
  unit: '$' | '%'
  /** Cents for '$', basis points of the items subtotal for '%' (1000 = 10%). */
  value: number
}

export interface AdjustPreview {
  /** Pre-tax amount (always positive). */
  pre: number
  signed: number
  newSub: number
  newTotal: number
  /** paid - refunded - newTotal: positive means the invoice is now overpaid. */
  diff: number
}

export function adjustPreview(c: InvoiceCalc, taxBp: number, a: AdjustInput): AdjustPreview {
  const pre = a.unit === '%' ? percentOfCents(c.items, a.value) : a.value
  const signed = a.kind === 'discount' ? -pre : pre
  const newSub = c.sub + signed
  const newTotal = newSub + taxCents(Math.max(newSub, 0), taxBp) + c.tip
  return { pre, signed, newSub, newTotal, diff: c.paid - c.refunded - newTotal }
}
