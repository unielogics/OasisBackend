// Kysely types for the cards-on-file tables (db/migrations/20261014500000_square_cards.sql, ADR 0171 D7), registered by module
// augmentation: the client's Square customer, their saved cards, their consents (append-only except the revoke columns) and the
// charges proposed on a saved card.
import type { Generated } from 'kysely'

export type SquareCustomerLinkedBy = 'created' | 'found' | 'staff'

export interface SquareCustomerLinksTable {
  id: string
  location_id: string
  customer_id: string
  square_customer_id: string
  linked_by: SquareCustomerLinkedBy
  created_at: Generated<Date>
}

export type CustomerCardState = 'active' | 'disabled' | 'forgotten' | 'expired'
export type CustomerCardCreatedVia = 'card_link' | 'membership_link' | 'staff' | 'square'
export type CustomerCardDisabledReason =
  | 'client_removed'
  | 'staff_removed'
  | 'square_disabled'
  | 'square_forgotten'
  | 'expired'
  | 'customer_deleted'

export interface CustomerCardsTable {
  id: string
  location_id: string
  customer_id: string
  square_customer_id: string
  square_card_id: string
  brand: string | null
  last4: string | null
  exp_month: number | null
  exp_year: number | null
  card_type: string | null
  postal: string | null
  fingerprint: string | null
  state: Generated<CustomerCardState>
  created_via: CustomerCardCreatedVia
  disabled_at: Date | null
  disabled_reason: CustomerCardDisabledReason | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export type CardConsentRevokeReason =
  | 'client_removed'
  | 'staff_removed'
  | 'card_disabled'
  | 'card_forgotten'
  | 'card_expired'
  | 'replaced'
  | 'customer_deleted'

export interface CardConsentsTable {
  id: string
  location_id: string
  customer_id: string
  card_id: string
  /** text[]: a subset of CARD_PURPOSES (src/modules/square/consents.ts), at least one. */
  purposes: string[]
  text_version: string
  text_sha256: string
  text_snapshot: string
  accepted_at: Date
  /** inet: pg answers it as text. */
  ip: string | null
  user_agent: string | null
  link_id: string | null
  session_hash: string | null
  revoked_at: Date | null
  revoked_by: string | null
  revoke_reason: CardConsentRevokeReason | null
  created_at: Generated<Date>
}

export type SquareChargePurpose = 'no_show_fee' | 'late_cancel_fee' | 'balance'
export type SquareChargeState = 'proposed' | 'charging' | 'charged' | 'declined' | 'unknown' | 'waived'

export interface SquareChargesTable {
  id: string
  location_id: string
  customer_id: string
  card_id: string | null
  consent_id: string | null
  purpose: SquareChargePurpose
  amount_cents: number
  state: Generated<SquareChargeState>
  idempotency_key: string
  invoice_id: string | null
  appointment_id: string | null
  square_payment_id: string | null
  ledger_event_id: string | null
  error: string | null
  attempts: Generated<number>
  proposed_by: string | null
  decided_by: string | null
  decided_by_user_id: string | null
  decided_at: Date | null
  charged_at: Date | null
  waive_reason: string | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

declare module '../../../platform/schema.js' {
  interface Database {
    square_customer_links: SquareCustomerLinksTable
    customer_cards: CustomerCardsTable
    card_consents: CardConsentsTable
    square_charges: SquareChargesTable
  }
}
