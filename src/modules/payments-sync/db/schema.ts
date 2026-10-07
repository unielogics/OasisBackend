// Kysely types for the Squarespace sync tables (migration 20261006210100_sqsp_sync.sql), registered by module augmentation.
import type { Generated } from 'kysely'
import type { JsonColumn, JsonValue } from '../../../platform/schema.js'

export type SqspMatchState = 'unmatched' | 'auto' | 'manual' | 'ignored' | 'membership'
export type SqspTxnState = 'new' | 'matched' | 'manual' | 'ignored' | 'deferred' | 'membership'
export type SqspResource = 'orders' | 'transactions' | 'contacts' | 'reconcile'

export interface SqspConnectionsTable {
  id: string
  location_id: string
  auth_kind: Generated<'api_key' | 'oauth'>
  api_key_enc: string | null
  site_id: string | null
  client_id: string | null
  client_secret_enc: string | null
  access_token_enc: string | null
  refresh_token_enc: string | null
  token_expires_at: Date | null
  scopes: Generated<string[]>
  status: Generated<'connected' | 'error' | 'disconnected'>
  last_error: string | null
  last_verified_at: Date | null
  created_by: string | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface SqspSyncStateTable {
  location_id: string
  resource: SqspResource
  watermark: Date | null
  in_flight: JsonColumn | null
  phase: 'orders' | 'transactions' | null
  window_start: Date | null
  last_run_at: Date | null
  last_success_at: Date | null
  status: Generated<'idle' | 'ok' | 'partial' | 'error' | 'dead_letter'>
  last_error: string | null
  consecutive_failures: Generated<number>
  updated_at: Generated<Date>
}

export interface SqspOrdersTable {
  id: string
  location_id: string
  sqsp_order_id: string
  order_number: string
  created_on: Date
  modified_on: Date
  customer_email: string | null
  customer_name: string | null
  customer_phone: string | null
  sqsp_customer_id: string | null
  channel: string | null
  fulfillment_status: string | null
  payment_state: string | null
  is_subscription: Generated<boolean>
  grand_total_cents: number
  refunded_total_cents: Generated<number>
  subtotal_cents: number | null
  tax_cents: number | null
  currency: string
  test_mode: Generated<boolean>
  line_items: JsonColumn<JsonValue[]>
  order_json: JsonColumn<Record<string, JsonValue>>
  raw: JsonColumn | null
  payload_hash: string
  customer_id: string | null
  matched_invoice_id: string | null
  match_state: Generated<SqspMatchState>
  ignore_reason: string | null
  first_seen_at: Date
  synced_at: Date
  matched_at: Date | null
}

export interface SqspTransactionsTable {
  id: string
  location_id: string
  sqsp_txn_id: string
  sqsp_order_id: string | null
  kind: 'payment' | 'refund'
  created_on: Date
  amount_cents: number
  currency: string
  brand: string | null
  last4: string | null
  provider: string | null
  document_id: string | null
  payment_id: string | null
  external_transaction_id: string | null
  voided: Generated<boolean>
  document_modified_on: Date | null
  effective_modified_on: Date
  customer_email: string | null
  txn_json: JsonColumn<Record<string, JsonValue>>
  raw: JsonColumn | null
  payload_hash: string
  state: Generated<SqspTxnState>
  ignore_reason: string | null
  matched_event_id: string | null
  first_seen_at: Date
  synced_at: Date
}

export interface SqspContactsTable {
  id: string
  location_id: string
  sqsp_contact_id: string
  email: string | null
  name: string | null
  phone: string | null
  created_on: Date | null
  payload_hash: string
  synced_at: Date
}

export interface SqspCustomerLinksTable {
  location_id: string
  sqsp_customer_id: string
  customer_id: string
  source: 'email' | 'phone' | 'manual'
  linked_by: string | null
  created_at: Generated<Date>
}

export interface SqspProductsTable {
  id: string
  location_id: string
  sqsp_product_id: string | null
  sku: string | null
  name: string | null
  kind: 'membership' | 'service'
  plan_id: string | null
  plan_label: string | null
  interval_months: Generated<number>
  service_id: string | null
  active: Generated<boolean>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface SqspWebhookSubscriptionsTable {
  id: string
  location_id: string
  sqsp_subscription_id: string
  topic: string
  endpoint_url: string
  secret_enc: string | null
  created_at: Generated<Date>
  last_delivery_at: Date | null
}

export interface SqspSyncErrorsTable {
  id: string
  location_id: string
  resource: SqspResource
  key: string
  kind: 'mapping' | 'persist'
  message: string
  raw: JsonColumn | null
  attempts: Generated<number>
  first_at: Date
  last_at: Date
  dead_lettered_at: Date | null
  resolved_at: Date | null
}

export type SqspMatchKind =
  | 'confirm_awaiting'
  | 'attach_refs'
  | 'record_payment'
  | 'confirm_refund'
  | 'external_refund'
  | 'manual_ignore'

export interface SqspMatchesTable {
  id: string
  location_id: string
  idempotency_key: string
  kind: SqspMatchKind
  sqsp_order_id: string | null
  sqsp_txn_id: string | null
  event_id: string | null
  invoice_id: string | null
  rule: string | null
  confidence: string | number | null
  variance: JsonColumn | null
  manual: Generated<boolean>
  actor_user_id: string | null
  created_at: Generated<Date>
}

export interface SqspManualQueueTable {
  id: string
  location_id: string
  idempotency_key: string
  sqsp_order_id: string
  sqsp_txn_id: string | null
  reason: string
  candidates: JsonColumn<JsonValue[]>
  arrival: JsonColumn<Record<string, JsonValue>>
  variance: JsonColumn | null
  state: Generated<'open' | 'resolved' | 'ignored'>
  resolution: string | null
  resolved_at: Date | null
  resolved_by: string | null
  created_at: Generated<Date>
}

export interface SqspAlertsTable {
  id: string
  location_id: string
  dedupe_key: string
  code: string
  sqsp_order_id: string | null
  sqsp_txn_id: string | null
  invoice_id: string | null
  message: string
  variance: JsonColumn | null
  created_at: Generated<Date>
  resolved_at: Date | null
  resolved_by: string | null
}

declare module '../../../platform/schema.js' {
  interface Database {
    sqsp_connections: SqspConnectionsTable
    sqsp_sync_state: SqspSyncStateTable
    sqsp_orders: SqspOrdersTable
    sqsp_transactions: SqspTransactionsTable
    sqsp_contacts: SqspContactsTable
    sqsp_customer_links: SqspCustomerLinksTable
    sqsp_products: SqspProductsTable
    sqsp_webhook_subscriptions: SqspWebhookSubscriptionsTable
    sqsp_sync_errors: SqspSyncErrorsTable
    sqsp_matches: SqspMatchesTable
    sqsp_manual_queue: SqspManualQueueTable
    sqsp_alerts: SqspAlertsTable
  }
}
