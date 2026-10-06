// Squarespace is the card processor, but its Commerce APIs are READ-ONLY for payments: they cannot charge,
// refund, create links or expose saved cards. So the source port only reads; PaymentProcessor states capabilities honestly.
export interface Page<T> {
  items: T[]
  nextCursor?: string
  /** Items the adapter could not map (kept so one malformed record cannot wedge a sync). Additive. */
  rejected?: { id?: string; reason: string; raw: unknown }[]
}

/** Order.paymentState as documented (2026-05); `UNKNOWN` when absent or not one of the documented values. */
export type SqspPaymentState =
  | 'NOT_CHARGED'
  | 'AUTHORIZED'
  | 'PAID'
  | 'PARTIALLY_PAID'
  | 'PENDING'
  | 'FAILED'
  | 'REFUND_PENDING'
  | 'REFUNDED'
  | 'REFUND_FAILED'
  | 'UNKNOWN'

export interface SqspOrder {
  id: string
  orderNumber: string
  createdOn: Date
  modifiedOn: Date
  customerEmail?: string
  customerName?: string
  /** billingAddress.phone (fallback shippingAddress.phone); the only phone an order carries. Additive. */
  customerPhone?: string
  /** Squarespace customer id; equals the Contacts API contact id. Additive. */
  customerId?: string
  /** Heuristic only: the Orders API documents no subscription field (see docs/integrations/squarespace.md). */
  isSubscription: boolean
  grandTotalCents: number
  refundedTotalCents: number
  currency: string
  testMode: boolean
  /** Additive fields below; all optional so existing consumers keep compiling. */
  paymentState?: SqspPaymentState
  fulfillmentStatus?: 'PENDING' | 'FULFILLED' | 'CANCELED'
  channel?: string
  subtotalCents?: number
  discountCents?: number
  shippingCents?: number
  taxCents?: number
  priceTaxInterpretation?: 'EXCLUSIVE' | 'INCLUSIVE'
  externalOrderReference?: string
  lineItems: {
    productId?: string
    sku?: string
    name: string
    unitCents: number
    qty: number
    lineItemType?: string
    variantId?: string
  }[]
  raw: unknown
}

export interface SqspTransaction {
  id: string
  orderId?: string
  kind: 'payment' | 'refund'
  createdOn: Date
  amountCents: number
  currency: string
  /** Brand enum only (VISA, MASTERCARD, AMEX, DISCOVER, JCB, OTHER); last4 is not in the documented fields. */
  brand?: string
  /** One Squarespace transaction Document per order; a payment or refund is one entry inside it. Additive. */
  documentId?: string
  documentModifiedOn?: Date
  /** For refunds: the payment the refund was issued against (refunds are nested per payment in the schema). */
  paymentId?: string
  customerEmail?: string
  /** Gateway: SQUARESPACE, STRIPE, PAYPAL or SQUARE. */
  provider?: string
  externalTransactionId?: string
  /** Document.voided: the order was cancelled. */
  voided?: boolean
  raw: unknown
}

export interface SqspContact {
  id: string
  email?: string
  name?: string
  phone?: string
  createdOn?: Date
}

export interface SquarespaceSource {
  listOrders(p: { modifiedAfter: Date; modifiedBefore: Date; cursor?: string }): Promise<Page<SqspOrder>>
  getOrder(id: string): Promise<SqspOrder>
  listTransactions(p: {
    modifiedAfter: Date
    modifiedBefore: Date
    cursor?: string
  }): Promise<Page<SqspTransaction>>
  listContacts(p: { cursor?: string }): Promise<Page<SqspContact>>
}

export interface PaymentProcessor {
  capabilities: {
    chargeCard: boolean
    refundCard: boolean
    paymentLink: 'api' | 'manual'
    savedCards: 'api' | 'hint' | 'none'
  }
}

/** v1 reality: Squarespace can do none of these through its API. A future Stripe adapter flips the flags. */
export const squarespaceCapabilities: PaymentProcessor['capabilities'] = {
  chargeCard: false,
  refundCard: false,
  paymentLink: 'manual',
  savedCards: 'hint',
}
