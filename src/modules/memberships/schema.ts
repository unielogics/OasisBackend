// Kysely types for the membership tables (migration 20261006210000_memberships.sql), registered by module augmentation.
import type { ColumnType, Generated } from 'kysely'
import type { JsonValue } from '../../platform/schema.js'

/** A tier's key: a slug (^[a-z][a-z0-9_]{0,31}$), gold and vip by default (premium and executive before ADR 0170, kept in legacy_key). */
export type PlanKey = string
export type InclusionMode = 'per_cycle' | 'every_visit'
/** pending until synced to Square as a plan variation; retired: a superseded price no subscription used, deleted at Square (wave Q3b). */
export type TierPriceSquareState = 'pending' | 'synced' | 'failed' | 'retired'
export type MembershipStatus = 'pending' | 'active' | 'past_due' | 'paused' | 'canceled'
/** square: billed by a Square subscription (ADR 0171 wave Q3b). */
export type MembershipSource = 'squarespace' | 'manual' | 'square'
export type MembershipBillingStatus = 'ok' | 'failed'
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
  // website/AI fields (migration 20261011000000_catalog_categories.sql, ADR 0160)
  monthly_price_cents: number | null
  /** https://...squarespace.com/... only (the membership link redirects there). */
  checkout_url: string | null
  /** The name the website and the assistant use (Gold, VIP). Deprecated (ADR 0170): the tier's name is the one name. */
  public_label: string | null
  // the tier fields (migration 20261014100100, ADR 0170)
  member_discount_bp: Generated<number>
  public: Generated<boolean>
  vip_booking: Generated<boolean>
  max_vehicles: number | null
  price_version: Generated<number>
  square_plan_id: string | null
  legacy_key: string | null
}

/** A tier's monthly price at a size; append-only (a save supersedes the current row). One Square plan variation each (wave Q3b). */
export interface MembershipTierPricesTable {
  id: string
  location_id: string
  plan_id: string
  class_key: string
  monthly_cents: number
  effective_from: Generated<Date>
  superseded_at: Date | null
  price_version: number
  square_variation_id: string | null
  square_state: Generated<TierPriceSquareState>
  square_synced_at: Date | null
  /** Why the last sync of this price failed (wave Q3b). */
  square_error: string | null
  created_by: string | null
  created_at: Generated<Date>
}

/** What a tier includes: per_cycle visits a cycle (null = unlimited) or an add-on on every visit; the services it covers. */
export interface MembershipInclusionsTable {
  id: string
  plan_id: string
  label: string
  mode: Generated<InclusionMode>
  per_cycle: number | null
  auto_apply: Generated<boolean>
  sort: Generated<number>
  active: Generated<boolean>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface MembershipInclusionServicesTable {
  inclusion_id: string
  service_id: string
}

/** The other customers a membership covers (written from wave Q2). */
export interface MembershipHouseholdTable {
  id: string
  membership_id: string
  customer_id: string
  added_at: Generated<Date>
  added_by: string | null
  removed_at: Date | null
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
  /** The size the membership is priced at (required; a row written without one gets the location's smallest active size). */
  plan_class: Generated<string>
  /** The tier price row being billed (wave Q3b). */
  tier_price_id: string | null
  // memberships billed by Square (migration 20261014600000, ADR 0171 wave Q3b)
  square_subscription_id: string | null
  square_customer_id: string | null
  /** The saved card the subscription charges (customer_cards). */
  card_id: string | null
  /** Square's status of the subscription as last read (PENDING, ACTIVE, PAUSED, CANCELED, DEACTIVATED). */
  square_status: string | null
  billing_status: Generated<MembershipBillingStatus>
  payment_failed_at: Date | null
  failure_notified_at: Date | null
  /** Shop-local dates (yyyy-mm-dd; a date column is read as its text) Square scheduled: the next billing date. */
  cancel_effective_at: string | null
  pause_effective_at: string | null
  scheduled_change: ColumnType<ScheduledChange | null, string | null | undefined, string | null>
  /** Variations whose scheduled swap was undone this billing period: never sent again in it (Square locks the subscription). */
  swap_undone_variations: Generated<string[]>
  square_synced_at: Date | null
}

/** A tier or size change Square will make at the next billing date (staff), or a price move after its notice ("Move members"). */
export interface ScheduledChange {
  kind: 'change' | 'move'
  toTierPriceId: string
  fromTierPriceId: string | null
  planKey: string
  planClass: string
  monthlyCents: number
  /** The date Square makes the swap (the next billing date), once SwapPlan was sent. */
  effectiveDate: string | null
  /** move: SwapPlan is sent on or after this instant (the notice's end). */
  swapAfter?: string | null
  noticeSentAt?: string | null
  requestedAt: string
  by: string
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
  /** The inclusion the event belongs to (backfilled from rule_id; new events name only this). */
  inclusion_id: string | null
  service_id: string | null
  line_cents: number | null
  covered_cents: number | null
  plan_class: string | null
  visit_class: string | null
}

export type MembershipCheckoutState =
  | 'open'
  | 'matched'
  | 'awaiting_match'
  | 'expired'
  | 'superseded'
  | 'abandoned'
  | 'rejected'

/** Who opened a checkout row: the membership page of a personal link, or the order sync (an order waiting for staff). */
export type MembershipCheckoutOrigin = 'link' | 'sync'

/**
 * A membership started through a personal link: the checkout intent the order sync matches first (migrations 20261011000500 and
 * 20261011050000); or a row the order sync opened for a paid order that matches the client only by an unverified email.
 */
export interface MembershipCheckoutsTable {
  id: string
  location_id: string
  membership_id: string
  customer_id: string
  link_id: string | null
  plan_key: string
  product_key: string | null
  expected_email: string | null
  /** null only on a row the sync opened (origin 'sync'). */
  checkout_url: string | null
  origin: Generated<MembershipCheckoutOrigin>
  started_at: Date
  expires_at: Date
  state: Generated<MembershipCheckoutState>
  matched_order_id: string | null
  matched_at: Date | null
  plan_class: string | null
  version: Generated<number>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

declare module '../../platform/schema.js' {
  interface Database {
    membership_checkouts: MembershipCheckoutsTable
    membership_plans: MembershipPlansTable
    plan_credit_rules: PlanCreditRulesTable
    memberships: MembershipsTable
    membership_tier_prices: MembershipTierPricesTable
    membership_inclusions: MembershipInclusionsTable
    membership_inclusion_services: MembershipInclusionServicesTable
    membership_household: MembershipHouseholdTable
    membership_credit_events: MembershipCreditEventsTable
  }
}
