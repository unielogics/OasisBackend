// Kysely types of the Square membership tables (db/migrations/20261014600000_square_memberships.sql, ADR 0171 wave Q3b), registered
// by module augmentation: the enrollment of a membership page (a resumable state machine) and the subscription invoices Square sends.
import type { Generated } from 'kysely'

export type EnrollmentState = 'started' | 'customer_ready' | 'card_saved' | 'subscribed' | 'active' | 'failed' | 'abandoned'
export type EnrollmentFailure =
  | 'card_declined'
  | 'square_unavailable'
  | 'subscription_refused'
  | 'first_payment_failed'
  | 'deactivated'
  | 'expired'
  | 'superseded'
export type EnrollmentCleanup = 'none' | 'pending' | 'done'

/** States in which an attempt is still under way (one per membership at a time). */
export const LIVE_ENROLLMENT_STATES: readonly EnrollmentState[] = ['started', 'customer_ready', 'card_saved', 'subscribed']

export interface SquareEnrollmentsTable {
  id: string
  location_id: string
  customer_id: string
  membership_id: string
  link_id: string | null
  plan_id: string
  tier_price_id: string
  plan_class: string
  square_variation_id: string
  monthly_cents: number
  email: string
  state: Generated<EnrollmentState>
  square_customer_id: string | null
  card_id: string | null
  consent_id: string | null
  square_subscription_id: string | null
  /** yyyy-mm-dd in the shop's time zone (a date column is read as its text). */
  start_date: string
  failure_code: EnrollmentFailure | null
  failure_detail: string | null
  cleanup: Generated<EnrollmentCleanup>
  attempts: Generated<number>
  last_attempt_at: Date | null
  started_at: Date
  finished_at: Date | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface SquareSubscriptionInvoicesTable {
  id: string
  location_id: string
  membership_id: string
  square_invoice_id: string
  square_subscription_id: string
  square_order_id: string | null
  status: string
  amount_cents: number
  paid_cents: Generated<number>
  due_date: string | null
  period_start: Date | null
  period_end: Date | null
  public_url: string | null
  paid_at: Date | null
  applied_at: Date | null
  failed_at: Date | null
  canceled_at: Date | null
  square_payment_id: string | null
  refunded_cents: Generated<number>
  square_refund_id: string | null
  refunded_at: Date | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

declare module '../../../platform/schema.js' {
  interface Database {
    square_enrollments: SquareEnrollmentsTable
    square_subscription_invoices: SquareSubscriptionInvoicesTable
  }
}
