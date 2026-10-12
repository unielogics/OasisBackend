// Kysely types for the Square tables (db/migrations/20261014200000_square_foundation.sql), registered by module augmentation.
import type { Generated } from 'kysely'
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

declare module '../../../platform/schema.js' {
  interface Database {
    square_state: SquareStateTable
  }
}
