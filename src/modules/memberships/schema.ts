// Kysely types for the membership tables (migration 20261006210000_memberships.sql), registered by module augmentation.
import type { ColumnType, Generated } from 'kysely'
import type { JsonValue } from '../../platform/schema.js'

export type PlanKey = 'essential' | 'premium' | 'executive' | 'exotic'
export type MembershipStatus = 'pending' | 'active' | 'past_due' | 'paused' | 'canceled'
export type MembershipSource = 'squarespace' | 'manual'
export type CreditKind = 'grant' | 'reserve' | 'redeem' | 'restore' | 'protect' | 'expire'

export interface MembershipPlansTable {
  id: string
  location_id: string
  key: PlanKey
  name: string
  color: string
  bg_color: string
  tint: string
  sort: Generated<number>
  perks: Generated<string[]>
  addon_discount_bp: Generated<number>
  service_discount_bp: Generated<number>
  billing_interval_months: Generated<number>
  active: Generated<boolean>
  version: Generated<number>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface PlanCreditRulesTable {
  id: string
  plan_id: string
  label: string
  include_tags: string[]
  exclude_tags: Generated<string[]>
  per_cycle: number | null
  auto_apply: Generated<boolean>
  sort: Generated<number>
  created_at: Generated<Date>
}

export interface MembershipsTable {
  id: string
  location_id: string
  customer_id: string
  plan_id: string
  plan_label: string
  status: MembershipStatus
  source: MembershipSource
  sqsp_subscription_ref: string | null
  sqsp_customer_id: string | null
  sqsp_product_key: string | null
  started_at: Date
  current_period_start: Date | null
  current_period_end: Date | null
  canceled_at: Date | null
  cancel_reason: string | null
  last_sqsp_order_id: string | null
  last_paid_at: Date | null
  paid_order_count: Generated<number>
  in_grace: Generated<boolean>
  manual_status_at: Date | null
  review_flags: ColumnType<JsonValue[], string | undefined, string>
  inference_reason: string | null
  auto_apply: Generated<boolean>
  last_synced_at: Date | null
  version: Generated<number>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface MembershipCreditEventsTable {
  id: string
  membership_id: string
  cycle_start: Date
  kind: CreditKind
  qty: number | null
  rule_id: string | null
  appointment_id: string | null
  invoice_id: string | null
  ledger_event_id: string | null
  note: string | null
  actor: string | null
  actor_user_id: string | null
  idempotency_key: string | null
  created_at: Generated<Date>
}

declare module '../../platform/schema.js' {
  interface Database {
    membership_plans: MembershipPlansTable
    plan_credit_rules: PlanCreditRulesTable
    memberships: MembershipsTable
    membership_credit_events: MembershipCreditEventsTable
  }
}
