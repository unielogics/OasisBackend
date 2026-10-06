// Everything the Payments module needs from outside, handed in at composition time.
import type { Executor } from '../../platform/db.js'
import { createPaymentMessenger, InMemoryOutbox, type PaymentMessenger } from './messenger.js'

/** The latest known card of a customer, when Squarespace revealed one. Brand only: last4 and wallet are not exposed. */
export interface CardHintProvider {
  hintFor(db: Executor, customerId: string): Promise<{ brand: string } | null>
}

export interface UnmatchedOrder {
  sqspOrderId: string
  orderNumber: string | null
  customerEmail: string | null
  totalCents: number
  createdAt: Date
}

export interface UnmatchedTransaction {
  sqspTransactionId: string
  sqspOrderId: string | null
  kind: 'payment' | 'refund'
  amountCents: number
  createdAt: Date
}

/** The Squarespace sync's unmatched queues (tables owned by the sync vertical); empty until it is wired. */
export interface UnmatchedSource {
  unmatchedOrders(db: Executor): Promise<UnmatchedOrder[]>
  unmatchedTransactions(db: Executor): Promise<UnmatchedTransaction[]>
}

export interface PaymentsPorts {
  messenger: PaymentMessenger
  cardHints: CardHintProvider
  unmatched: UnmatchedSource
  /** Hosts a payment link URL may point at (exact match or subdomain). */
  linkHosts: readonly string[]
}

export const noCardHints: CardHintProvider = { hintFor: async () => null }

export const noUnmatched: UnmatchedSource = {
  unmatchedOrders: async () => [],
  unmatchedTransactions: async () => [],
}

export const DEFAULT_LINK_HOSTS = ['squarespace.com'] as const

/** Defaults for development and tests: nothing is sent anywhere, no card hints, no unmatched queues. */
export function defaultPorts(overrides: Partial<PaymentsPorts> = {}): PaymentsPorts {
  return {
    messenger: createPaymentMessenger(new InMemoryOutbox()),
    cardHints: noCardHints,
    unmatched: noUnmatched,
    linkHosts: DEFAULT_LINK_HOSTS,
    ...overrides,
  }
}
