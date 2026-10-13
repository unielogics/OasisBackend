// Pure twin of the invoice_calc SQL (migration 20261006190000_payments.sql): the Payments design's calc() in integer
// cents with the review fixes. Used for sheet previews (adjust, by-item refund), seeds and the equality tests against SQL.
import { divHalfUp, percentOfCents, salesTaxCents, TAX_DBP_PER_100_PERCENT, type TaxRate, type TaxRounding } from '../../platform/money.js'
import type { InvoiceStatus, LedgerType, ProcessorState, RefundDest, RefundStatus } from './schema.js'

export interface CalcEvent {
  type: LedgerType
  /** adjust is signed (negative = discount); every other type is positive. */
  amountCents: number
  status?: RefundStatus
  dest?: RefundDest | null
  /** A card refund the processor reported failed ('failed') no longer counts as refunded (ADR 0171 D4). */
  processorState?: ProcessorState
}

export interface CalcInput {
  /** Price snapshot of every invoice line (package and add-ons). */
  itemPrices: readonly number[]
  events: readonly CalcEvent[]
  /** The invoice's own rate in thousandths of a percent (invoices.tax_dbp: 7000 = 7%, 6625 = 6.625%; ADR 0173). */
  taxDbp: number
  /** The invoice's own rounding (invoices.tax_rounding): half_up before ADR 0173, half_even (Square's rule) since. */
  taxRounding: TaxRounding
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
export function netCents(items: number, adj: number, refunded: number, taxDbp: number): number {
  return items + adj - divHalfUp(refunded * TAX_DBP_PER_100_PERCENT, TAX_DBP_PER_100_PERCENT + taxDbp)
}

/** The rate of a calc input as salesTaxCents takes it. */
export const rateOf = (i: { taxDbp: number; taxRounding: TaxRounding }): TaxRate => ({ dbp: i.taxDbp, rounding: i.taxRounding })

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
  const tax = salesTaxCents(sub, rateOf(input))
  const total = sub + tax + input.tipCents
  const paidOrig = of('pay') - of('void')
  const creditApplied = of('credit_apply')
  const paid = paidOrig + creditApplied
  // a refund the processor reported failed gave nothing back (ADR 0171 D4; the same rule as invoice_calc_of)
  const counts = (e: CalcEvent): boolean => e.status === 'done' && e.processorState !== 'failed'
  const refunded = of('refund', counts)
  const refOrig = of('refund', (e) => counts(e) && e.dest !== 'credit')
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
    net: netCents(items, adj, refunded, input.taxDbp),
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
/** Card money staff recorded that Squarespace has not confirmed yet reads this instead of "Paid" (DV-212). */
export const PAYMENT_PENDING_LABEL = 'Payment pending'

export const statusLabel = (status: InvoiceStatus, refundPending: boolean): string =>
  refundPending ? REFUND_PENDING_LABEL : STATUS_LABELS[status]

/**
 * By-item refund value: the selected lines plus their tax at the invoice's rate and rounding, never more than what is refundable.
 * (Half-up: the same as the selected lines times (1 + rate) rounded half-up, the rule before ADR 0173.)
 */
export function itemsRefundValue(selectedPrices: readonly number[], rate: TaxRate, refundable: number): number {
  const lines = sum(selectedPrices)
  return Math.min(refundable, lines + salesTaxCents(lines, rate))
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

export function adjustPreview(c: InvoiceCalc, rate: TaxRate, a: AdjustInput): AdjustPreview {
  const pre = a.unit === '%' ? percentOfCents(c.items, a.value) : a.value
  const signed = a.kind === 'discount' ? -pre : pre
  const newSub = c.sub + signed
  const newTotal = newSub + salesTaxCents(Math.max(newSub, 0), rate) + c.tip
  return { pre, signed, newSub, newTotal, diff: c.paid - c.refunded - newTotal }
}
