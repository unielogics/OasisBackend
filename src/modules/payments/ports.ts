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

/** The Square section of the reconciliation (ADR 0171): the payments to match, failed card refunds, refunds on their way. */
export interface SquareSection {
  paymentsToMatch: Array<{
    paymentId: string
    matchState: 'pending' | 'unmatched'
    classification: string | null
    amountCents: number
    tipCents: number
    totalCents: number
    refundedCents: number
    method: string
    sourceType: string | null
    brand: string | null
    last4: string | null
    note: string | null
    receiptNumber: string | null
    product: string | null
    createdAt: string
    ageMinutes: number
    candidates: Array<{
      invoiceId: string
      invoiceNo: number
      client: string
      balanceCents: number
      awaitingEventId: string | null
      score: number
      why: string[]
    }>
  }>
  failedRefunds: Array<{
    eventId: string
    invoiceId: string
    label: string
    client: string
    amountCents: number
    occurredAt: string
    refundedCents: number
    uncoveredCents: number
    errors: string[]
  }>
  refundsInFlight: number
}

/** The processors' unmatched queues (Squarespace sync tables; the Square mirror); empty until wired. */
export interface UnmatchedSource {
  unmatchedOrders(db: Executor): Promise<UnmatchedOrder[]>
  unmatchedTransactions(db: Executor): Promise<UnmatchedTransaction[]>
  /** The Square section (wave Q2b); absent = empty. */
  squareSection?(db: Executor, locationId: string, now: Date): Promise<SquareSection>
}

export const EMPTY_SQUARE_SECTION: SquareSection = { paymentsToMatch: [], failedRefunds: [], refundsInFlight: 0 }

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
/** Square's payment link hosts (ADR 0171): `url` on square.link, `long_url` on square.site checkout pages. */
export const SQUARE_LINK_HOSTS = ['square.link', 'square.site'] as const
/** The sandbox's (sandbox.square.link is a square.link subdomain; long URLs on connect.squareupsandbox.com): never in production. */
export const SQUARE_SANDBOX_LINK_HOSTS = ['squareupsandbox.com'] as const

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

/**
 * The allow-listed payment link hosts: PAYMENT_LINK_HOSTS (comma separated) when set. Otherwise squarespace.com (until the Square
 * cutover, PAYMENT_PROCESSOR=square, retires it) plus Square's square.link and square.site, plus the Square sandbox's hosts outside
 * production (ADR 0171).
 */
export function linkHostsFromEnv(
  raw: string | undefined,
  o: { processor?: 'squarespace' | 'square'; production?: boolean } = {},
): readonly string[] {
  const hosts = (raw ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
  if (hosts.length) return hosts
  return [
    ...(o.processor === 'square' ? [] : DEFAULT_LINK_HOSTS),
    ...SQUARE_LINK_HOSTS,
    ...((o.production ?? process.env.NODE_ENV === 'production') ? [] : SQUARE_SANDBOX_LINK_HOSTS),
  ]
}

/**
 * Defaults: outside production messages go to devOutbox; in production they fail until a real outbox is passed. No card
 * hints, no unmatched queues, payment link hosts from PAYMENT_LINK_HOSTS (default: linkHostsFromEnv).
 */
export function defaultPorts(overrides: Partial<PaymentsPorts> = {}): PaymentsPorts {
  return {
    messenger: createPaymentMessenger(process.env.NODE_ENV === 'production' ? unwiredOutbox : devOutbox),
    cardHints: noCardHints,
    unmatched: noUnmatched,
    linkHosts: linkHostsFromEnv(process.env.PAYMENT_LINK_HOSTS, {
      processor: process.env.PAYMENT_PROCESSOR === 'square' ? 'square' : 'squarespace',
    }),
    ...overrides,
  }
}
