// Kysely types for the payments tables (migration 20261006190000_payments.sql), registered by module augmentation.
import type { Generated } from 'kysely'

export type LedgerType = 'pay' | 'adjust' | 'refund' | 'credit_issue' | 'credit_apply' | 'void'
export type RefundStatus = 'pending' | 'done' | 'denied'
export type MethodKind = 'card' | 'apple_pay' | 'cash' | 'store_credit' | 'other'
export type RefundDest = 'card' | 'credit' | 'cash'
export type CreditExpiry = 'none' | 'd30' | 'd90'
export type LedgerSource = 'oasis' | 'squarespace' | 'system' | 'seed'
export type ProcessorState = 'na' | 'awaiting_processor' | 'confirmed' | 'failed'
export type InvoiceStatus =
  | 'paid'
  | 'unpaid'
  | 'partially_paid'
  | 'partially_refunded'
  | 'refunded'
  | 'canceled'
  | 'canceled_kept'
  | 'canceled_refunded'
export type CancelReason = 'canceled' | 'no_show'
export type ItemKind = 'package' | 'addon'

export interface InvoiceCountersTable {
  location_id: string
  next_no: Generated<number>
}

export interface InvoicesTable {
  id: string
  location_id: string
  invoice_no: number
  appointment_id: string | null
  customer_id: string
  client_name: string
  vehicle_label: Generated<string>
  staff_label: Generated<string>
  occurred_at: Date
  biz_date: string
  date_frozen_at: Date | null
  tax_bp: number
  tip_cents: Generated<number>
  canceled_at: Date | null
  canceled_by: string | null
  canceled_by_name: string | null
  cancel_reason: CancelReason | null
  payment_link_url: string | null
  payment_link_sent_at: Date | null
  version: Generated<number>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface InvoiceItemsTable {
  id: string
  invoice_id: string
  position: number
  kind: ItemKind
  service_id: string | null
  name: string
  price_cents: number
  appointment_addon_id: string | null
}

export interface LedgerEventsTable {
  id: string
  seq: Generated<number>
  location_id: string
  invoice_id: string
  customer_id: string
  type: LedgerType
  amount_cents: number
  status: Generated<RefundStatus>
  method: string | null
  method_kind: MethodKind | null
  brand: string | null
  last4: string | null
  dest: RefundDest | null
  deposit: Generated<boolean>
  reason: string | null
  note: string | null
  expiry: CreditExpiry | null
  expires_at: Date | null
  item_ids: Generated<string[]>
  parent_event_id: string | null
  voids_event_id: string | null
  actor_user_id: string | null
  actor_employee_id: string | null
  actor_name: string | null
  actor_roles: string | null
  view_as_role_id: string | null
  approved_by_user_id: string | null
  approved_by_employee_id: string | null
  approved_by_name: string | null
  approved_by_roles: string | null
  approved_at: Date | null
  denied_by_user_id: string | null
  denied_by_employee_id: string | null
  denied_by_name: string | null
  denied_by_roles: string | null
  denied_at: Date | null
  denied_note: string | null
  occurred_at: Date
  resolved_at: Date | null
  source: Generated<LedgerSource>
  processor_state: Generated<ProcessorState>
  processor_ref: string | null
  sqsp_order_id: string | null
  processor_confirmed_at: Date | null
  processor_confirmed_by: string | null
  needs_review: Generated<boolean>
  idempotency_key: string | null
  created_at: Generated<Date>
}

export interface CreditAllocationsTable {
  id: string
  apply_event_id: string
  lot_event_id: string
  customer_id: string
  cents: number
  created_at: Generated<Date>
}

export interface PaymentLinksTable {
  id: string
  location_id: string
  invoice_id: string
  kind: Generated<'checkout' | 'invoice'>
  purpose: Generated<'balance' | 'deposit'>
  url: string
  expected_cents: number
  created_by: string | null
  sent_message_id: string | null
  sent_at: Date | null
  expires_at: Date | null
  state: Generated<'active' | 'paid' | 'expired' | 'canceled'>
  matched_sqsp_order_id: string | null
  created_at: Generated<Date>
}

/** One row of the invoice_calc view / invoice_calc_of(): every amount in integer cents (bigint sums parse to number). */
export interface InvoiceCalcRow {
  invoice_id: string
  items: number
  adj: number
  sub: number
  tax: number
  tip: number
  total: number
  paid_orig: number
  credit_applied: number
  paid: number
  refunded: number
  ref_orig: number
  pending_amt: number
  pending_n: number
  issued: number
  balance: number
  refundable: number
  to_orig_max: number
  net: number
  overpaid: number
  status: InvoiceStatus
}

/** One nightly ledger integrity check per location (migration 20261006410000, ADR 0123). */
export interface LedgerIntegrityRunsTable {
  id: string
  location_id: string
  check_date: string
  started_at: Date
  finished_at: Date
  ok: boolean
  invoices_checked: number
  findings: unknown
  job_id: string | null
  created_at: Generated<Date>
}

declare module '../../platform/schema.js' {
  interface Database {
    ledger_integrity_runs: LedgerIntegrityRunsTable
    invoice_counters: InvoiceCountersTable
    invoices: InvoicesTable
    invoice_items: InvoiceItemsTable
    ledger_events: LedgerEventsTable
    credit_allocations: CreditAllocationsTable
    payment_links: PaymentLinksTable
    invoice_calc: InvoiceCalcRow
  }
}
