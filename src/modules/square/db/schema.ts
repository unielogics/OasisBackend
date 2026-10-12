// Kysely types for the Square tables (db/migrations/20261014200000_square_foundation.sql and 20261014400000_square_core.sql),
// registered by module augmentation.
import type { ColumnType, Generated } from 'kysely'
import type { JsonColumn } from '../../../platform/schema.js'

export interface SquareConnectionTest {
  ok: boolean
  at: string
  checks: Array<{ key: string; ok: boolean; detail: string }>
}

export interface SquareReconcileSummary {
  from: string
  to: string
  payments: number
  refunds: number
  paymentsByStatus: Record<string, number>
  refundsByStatus: Record<string, number>
  bySource: Record<string, number>
  byProduct: Record<string, number>
  complete: boolean
  /** Payments decided by the reconcile itself (the webhook and the catch-up had missed them; wave Q2b). */
  decided?: number
}

export interface SquareStateTable {
  location_id: string
  environment: 'sandbox' | 'production' | 'sim'
  square_location_id: string | null
  merchant_id: string | null
  events_enabled_at: Date | null
  webhook_subscription_id: string | null
  webhook_checked_at: Date | null
  last_webhook_at: Date | null
  watermark: Date | null
  last_catchup_at: Date | null
  last_catchup_events: Generated<number>
  last_catchup_claimed_at: Date | null
  last_reconcile_at: Date | null
  last_reconcile: JsonColumn<SquareReconcileSummary> | null
  last_test_at: Date | null
  last_test: JsonColumn<SquareConnectionTest> | null
  last_error: string | null
  last_error_at: Date | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export type SquareClassification = 'link' | 'charge' | 'membership' | 'pos_intent' | 'counter' | 'ignored'
export type SquareMatchState = 'pending' | 'matched' | 'unmatched' | 'ignored'
export type SquareIgnoreReason = 'not_oasis_sale' | 'duplicate' | 'test' | 'other'
/** R1 invoice number, R2 POS intent, R3 awaiting entry, R4 identity and balance, R4a amount only (opt-in), and the others. */
export type SquareMatchRule = 'R1' | 'R2' | 'R3' | 'R4' | 'R4a' | 'link' | 'cash_entry' | 'manual' | 'reassign' | 'charge'

/** One candidate invoice of an unmatched payment, best first. */
export interface SquareCandidate {
  invoiceId: string
  invoiceNo: number
  client: string
  balanceCents: number
  /** The awaiting staff card entry of the same amount on that invoice, if any (applying confirms it). */
  awaitingEventId: string | null
  score: number
  why: string[]
}

export interface SquarePaymentsTable {
  id: string
  location_id: string
  square_payment_id: string
  square_location_id: string | null
  status: string
  source_type: string | null
  square_product: string | null
  application_id: string | null
  square_order_id: string | null
  reference_id: string | null
  note: string | null
  receipt_number: string | null
  receipt_url: string | null
  amount_cents: number
  tip_cents: Generated<number>
  total_cents: number
  refunded_cents: Generated<number>
  card_brand: string | null
  last4: string | null
  entry_method: string | null
  square_customer_id: string | null
  buyer_email: string | null
  square_created_at: Date
  square_updated_at: Date | null
  classification: SquareClassification | null
  match_state: Generated<SquareMatchState>
  match_after: Date | null
  invoice_id: string | null
  event_id: string | null
  tip_event_id: string | null
  rule: SquareMatchRule | null
  /** numeric(3,2): pg returns it as a string. */
  confidence: string | number | null
  /** jsonb, default '[]': written as JSON text. */
  candidates: ColumnType<SquareCandidate[], string | undefined, string>
  variance: JsonColumn<Record<string, unknown>> | null
  decided_by: string | null
  decided_by_user_id: string | null
  decided_at: Date | null
  ignore_reason: SquareIgnoreReason | null
  ignore_note: string | null
  first_seen_at: Generated<Date>
  updated_at: Generated<Date>
}

export type SquareRefundLegState = 'to_submit' | 'pending' | 'completed' | 'failed' | 'rejected'

export interface SquareRefundLegsTable {
  id: string
  location_id: string
  ledger_event_id: string
  square_payment_id: string
  amount_cents: number
  origin: Generated<'api' | 'pos'>
  idempotency_key: string | null
  square_refund_id: string | null
  state: Generated<SquareRefundLegState>
  error: string | null
  attempts: Generated<number>
  submitted_at: Date | null
  completed_at: Date | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export type SquarePosIntentStatus = 'open' | 'callback_ok' | 'callback_error' | 'matched' | 'expired'

export interface SquarePosIntentsTable {
  id: string
  location_id: string
  invoice_id: string
  ledger_event_id: string | null
  amount_cents: number
  callback_state: string
  code: string
  note: string
  status: Generated<SquarePosIntentStatus>
  transaction_id: string | null
  client_transaction_id: string | null
  error_code: string | null
  square_payment_id: string | null
  created_by: string | null
  created_at: Generated<Date>
  expires_at: Date
  callback_at: Date | null
}

declare module '../../../platform/schema.js' {
  interface Database {
    square_state: SquareStateTable
    square_payments: SquarePaymentsTable
    square_refund_legs: SquareRefundLegsTable
    square_pos_intents: SquarePosIntentsTable
  }
}
