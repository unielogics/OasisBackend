// A Square payment as the ledger code reads it: integer cents (USD only), the card's brand and last four, the order, the note, the
// times. Built from the wire object (always a fresh GetPayment, never a webhook payload) or from the mirror row.
import { centsOf } from '../../integrations/square/money.js'
import type { WirePayment, WireRefund } from '../../integrations/square/wire.js'
import type { MethodKind } from '../payments/schema.js'
import type { SquarePaymentsTable } from './db/schema.js'

export interface SquarePaymentFacts {
  paymentId: string
  status: string
  squareLocationId: string | null
  /** CARD, CASH, WALLET, EXTERNAL, BANK_ACCOUNT, ... */
  sourceType: string | null
  /** SQUARE_POS, ECOMMERCE_API, INVOICES, ... */
  product: string | null
  applicationId: string | null
  orderId: string | null
  referenceId: string | null
  note: string | null
  receiptNumber: string | null
  receiptUrl: string | null
  /** amount_money: what was charged for the sale, the tip excluded. */
  amountCents: number
  tipCents: number
  totalCents: number
  refundedCents: number
  brand: string | null
  last4: string | null
  entryMethod: string | null
  customerId: string | null
  buyerEmail: string | null
  createdAt: Date
  updatedAt: Date | null
}

const date = (s: string | null | undefined): Date | null => {
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

export function paymentFacts(p: WirePayment): SquarePaymentFacts {
  const amount = centsOf(p.amount_money, 'amount_money')
  const tip = centsOf(p.tip_money, 'tip_money')
  const card = p.card_details?.card
  const last4 = card?.last_4 && /^[0-9]{4}$/.test(card.last_4) ? card.last_4 : null
  return {
    paymentId: p.id,
    status: p.status,
    squareLocationId: p.location_id ?? null,
    sourceType: p.source_type ?? null,
    product: p.application_details?.square_product ?? null,
    applicationId: p.application_details?.application_id ?? null,
    orderId: p.order_id ?? null,
    referenceId: p.reference_id ?? null,
    note: p.note ?? null,
    receiptNumber: p.receipt_number ?? null,
    receiptUrl: p.receipt_url ?? null,
    amountCents: amount,
    tipCents: tip,
    totalCents: p.total_money ? centsOf(p.total_money, 'total_money') : amount + tip,
    refundedCents: centsOf(p.refunded_money, 'refunded_money'),
    brand: card?.card_brand ?? null,
    last4,
    entryMethod: p.card_details?.entry_method ?? null,
    customerId: p.customer_id ?? null,
    buyerEmail: p.buyer_email_address ?? null,
    createdAt: date(p.created_at) ?? new Date(0),
    updatedAt: date(p.updated_at),
  }
}

type MirrorRow = Pick<
  SquarePaymentsTable,
  | 'square_payment_id'
  | 'status'
  | 'square_location_id'
  | 'source_type'
  | 'square_product'
  | 'application_id'
  | 'square_order_id'
  | 'reference_id'
  | 'note'
  | 'receipt_number'
  | 'receipt_url'
  | 'amount_cents'
  | 'card_brand'
  | 'last4'
  | 'entry_method'
  | 'square_customer_id'
  | 'buyer_email'
  | 'square_created_at'
  | 'square_updated_at'
  | 'total_cents'
> & { tip_cents: number; refunded_cents: number }

export function factsOfRow(r: MirrorRow): SquarePaymentFacts {
  return {
    paymentId: r.square_payment_id,
    status: r.status,
    squareLocationId: r.square_location_id,
    sourceType: r.source_type,
    product: r.square_product,
    applicationId: r.application_id,
    orderId: r.square_order_id,
    referenceId: r.reference_id,
    note: r.note,
    receiptNumber: r.receipt_number,
    receiptUrl: r.receipt_url,
    amountCents: r.amount_cents,
    tipCents: r.tip_cents,
    totalCents: r.total_cents,
    refundedCents: r.refunded_cents,
    brand: r.card_brand,
    last4: r.last4,
    entryMethod: r.entry_method,
    customerId: r.square_customer_id,
    buyerEmail: r.buyer_email,
    createdAt: r.square_created_at,
    updatedAt: r.square_updated_at,
  }
}

/** How the ledger files the payment: CARD is a card (Apple Pay and Google Pay arrive as CARD), CASH is cash, anything else other. */
export function methodKindOf(sourceType: string | null): MethodKind {
  if (sourceType === 'CARD') return 'card'
  if (sourceType === 'CASH') return 'cash'
  return 'other'
}

export interface SquareRefundFacts {
  refundId: string
  status: string
  paymentId: string | null
  orderId: string | null
  squareLocationId: string | null
  amountCents: number
  reason: string | null
  createdAt: Date
}

export function refundFacts(r: WireRefund): SquareRefundFacts {
  return {
    refundId: r.id,
    status: r.status,
    paymentId: r.payment_id ?? null,
    orderId: r.order_id ?? null,
    squareLocationId: r.location_id ?? null,
    amountCents: centsOf(r.amount_money, 'amount_money'),
    reason: r.reason ?? null,
    createdAt: date(r.created_at) ?? new Date(0),
  }
}
