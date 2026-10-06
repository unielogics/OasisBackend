import type {
  Arrival,
  AlertFlag,
  LedgerEventRef,
  MatchCandidate,
  MatchContext,
  ManualReason,
  Variance,
} from './matcher.js'

/**
 * What the matcher needs from the Oasis ledger and what applying a decision does to it. The integrator implements both
 * over Postgres (ledger_events, payment_links, invoices); InMemoryLedger in memory-ledger.ts is the reference behaviour.
 * Every command takes an idempotency key derived from the Squarespace ids, so re-running a match never duplicates money.
 */
export interface LedgerContextQuery {
  orderId: string
  /** Squarespace payment/refund ids on this order. */
  transactionIds: string[]
  email?: string
  phone?: string
  sqspCustomerId?: string
  /** Awaiting events and links around these instants are relevant. */
  around: Date[]
  awaitingWindowMs: number
  linkWindowMs: number
}

export interface LedgerReader {
  loadContext(q: LedgerContextQuery): Promise<MatchContext>
}

export interface PaymentFacts {
  amountCents: number
  occurredAt: Date
  brand?: string
  sqspOrderId: string
  processorRef?: string
  variance?: Variance
}

export interface LedgerCommands {
  /** staff-recorded awaiting_processor event -> confirmed, storing the processor reference and Squarespace order id. */
  confirmAwaitingEvent(input: {
    idempotencyKey: string
    eventId: string
    sqspOrderId: string
    processorRef?: string
    variance?: Variance
  }): Promise<void>
  /** Fill in processor_ref / sqsp_order_id on an event that was already recorded without them. */
  attachProcessorRefs(input: {
    idempotencyKey: string
    eventId: string
    sqspOrderId?: string
    processorRef?: string
  }): Promise<void>
  /** New pay event (source=squarespace, processor_state=confirmed) against an invoice via its payment link. */
  recordProcessorPayment(
    input: PaymentFacts & {
      idempotencyKey: string
      invoiceId: string
      paymentLinkId: string
      deposit: boolean
    },
  ): Promise<{ eventId: string }>
  confirmRefundEvent(input: {
    idempotencyKey: string
    eventId: string
    sqspOrderId: string
    processorRef: string
  }): Promise<void>
  /** Refund that exists only in Squarespace: source=squarespace, done, confirmed, flagged for review. */
  recordExternalRefund(
    input: PaymentFacts & { idempotencyKey: string; invoiceId: string },
  ): Promise<{ eventId: string }>
  enqueueManual(input: {
    idempotencyKey: string
    orderId: string
    transactionId?: string
    reason: ManualReason
    candidates: MatchCandidate[]
    arrival: Arrival
    variance?: Variance
  }): Promise<void>
}

export interface AlertSink {
  raise(alert: {
    code: AlertFlag | 'product_map_empty' | 'order_ignored_unmapped'
    orderId?: string
    transactionId?: string
    invoiceId?: string
    message: string
    variance?: Variance
  }): Promise<void>
}

export type { LedgerEventRef }
