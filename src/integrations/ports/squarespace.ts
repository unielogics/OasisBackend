// Squarespace is the card processor, but its Commerce APIs are READ-ONLY for payments: they cannot charge,
// refund, create links or expose saved cards. So the source port only reads; PaymentProcessor states capabilities honestly.
export interface Page<T> {
  items: T[]
  nextCursor?: string
}

export interface SqspOrder {
  id: string
  orderNumber: string
  createdOn: Date
  modifiedOn: Date
  customerEmail?: string
  customerName?: string
  isSubscription: boolean
  grandTotalCents: number
  refundedTotalCents: number
  currency: string
  testMode: boolean
  lineItems: { productId?: string; sku?: string; name: string; unitCents: number; qty: number }[]
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
  raw: unknown
}

export interface SqspContact {
  id: string
  email?: string
  name?: string
  phone?: string
}

export interface SquarespaceSource {
  listOrders(p: { modifiedAfter: Date; modifiedBefore: Date; cursor?: string }): Promise<Page<SqspOrder>>
  getOrder(id: string): Promise<SqspOrder>
  listTransactions(p: { modifiedAfter: Date; modifiedBefore: Date; cursor?: string }): Promise<Page<SqspTransaction>>
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
