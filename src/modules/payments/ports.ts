// Everything the Payments module needs from outside, handed in at composition time.
import type { Executor } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import type { Tx } from '../../platform/db.js'
import {
  createPaymentMessenger,
  InMemoryOutbox,
  type PaymentMessenger,
  type PaymentOutbox,
  type QueuedEmail,
  type QueuedSms,
} from './messenger.js'

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

/** What the default (development and test) messenger queues; nothing leaves the process. */
export const devOutbox = new InMemoryOutbox()

/**
 * Production default until Messaging is wired: queueing fails loudly instead of pretending a receipt or payment link was
 * sent (the dev outbox is only used outside production).
 */
export const unwiredOutbox: PaymentOutbox = {
  queueSms: async (_tx: Tx, _m: QueuedSms) => {
    throw new AppError('SERVICE_UNAVAILABLE', { detail: 'Text messaging is not connected yet' })
  },
  queueEmail: async (_tx: Tx, _m: QueuedEmail) => {
    throw new AppError('SERVICE_UNAVAILABLE', { detail: 'Email is not connected yet' })
  },
}

/** PAYMENT_LINK_HOSTS (comma separated) overrides the allow-listed payment link hosts. */
export function linkHostsFromEnv(raw: string | undefined): readonly string[] {
  const hosts = (raw ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
  return hosts.length ? hosts : DEFAULT_LINK_HOSTS
}

/**
 * Defaults: outside production messages go to devOutbox; in production they fail until a real outbox is passed. No card
 * hints, no unmatched queues, payment link hosts from PAYMENT_LINK_HOSTS (default squarespace.com).
 */
export function defaultPorts(overrides: Partial<PaymentsPorts> = {}): PaymentsPorts {
  return {
    messenger: createPaymentMessenger(process.env.NODE_ENV === 'production' ? unwiredOutbox : devOutbox),
    cardHints: noCardHints,
    unmatched: noUnmatched,
    linkHosts: linkHostsFromEnv(process.env.PAYMENT_LINK_HOSTS),
    ...overrides,
  }
}
