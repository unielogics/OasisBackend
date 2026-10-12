// Kysely types for the identity tables (migration 20261011000200_identity.sql, ADR 0160): personal links and their sessions, the
// website PIN, the 30-day phone trust, the in-chat actions waiting for a reply number; plus the columns that migration adds to
// customers and to the website's one-time codes. Registered by module augmentation.
import type { Generated } from 'kysely'
import type { JsonColumn, JsonValue } from '../../platform/schema.js'

/** `card` (#/k, ADR 0171 D7): the page where a client saves a card with Square (wave Q3; the website's LinkKind follows with Q3a). */
export type ClientLinkKind = 'calendar' | 'verify' | 'pin' | 'membership' | 'pay' | 'book_again' | 'card'
export type ClientLinkIssuer = 'assistant' | 'staff' | 'system'
/** Why a link or a phone's trust ended before its time. */
export type IdentityRevokeReason =
  | 'phone_change'
  | 'pin_set'
  | 'pin_reset'
  | 'pin_cleared'
  | 'merge'
  | 'opt_out'
  | 'staff'
  | 'epoch'
  | 'superseded'
export type LinkSessionTrust = 'link' | 'verified'
export type VerifiedBy = 'pin' | 'code'
export type PendingActionKind = 'book' | 'reschedule' | 'cancel'
export type PendingActionState = 'pending' | 'executed' | 'failed' | 'expired' | 'superseded' | 'locked' | 'canceled'
export type OtpPurpose = 'website' | 'link_verify' | 'pin_set' | 'pin_reset'

export interface ClientLinksTable {
  id: string
  location_id: string
  token_hash: string
  kind: ClientLinkKind
  customer_id: string | null
  phone_e164: string
  appointment_id: string | null
  invoice_id: string | null
  plan_key: string | null
  pin_version: Generated<number>
  phone_version: Generated<number>
  epoch: number
  issued_by: ClientLinkIssuer
  expires_at: Date
  uses: Generated<number>
  max_uses: number
  consumed_at: Date | null
  revoked_at: Date | null
  revoke_reason: IdentityRevokeReason | null
  created_at: Generated<Date>
}

export interface ClientLinkSessionsTable {
  token_hash: string
  link_id: string
  customer_id: string | null
  phone_e164: string
  trust: Generated<LinkSessionTrust>
  verified_by: VerifiedBy | null
  step_up_at: Date | null
  failed_attempts: Generated<number>
  idle_expires_at: Date
  expires_at: Date
  revoked_at: Date | null
  ip: string | null
  created_at: Generated<Date>
  last_used_at: Date | null
}

export interface CustomerPinsTable {
  customer_id: string
  pin_hash: string | null
  version: Generated<number>
  failed_attempts: Generated<number>
  /** 0 none, 1 locked 15 minutes, 2 locked 1 hour, 3 disabled until reset. */
  lock_level: Generated<number>
  locked_until: Date | null
  set_at: Date
  reset_hold_until: Date | null
  cleared_at: Date | null
  updated_at: Generated<Date>
}

export interface PhoneTrustTable {
  location_id: string
  phone_e164: string
  customer_id: string
  verified_at: Date
  verified_by: VerifiedBy
  expires_at: Date
  revoked_at: Date | null
  revoke_reason: IdentityRevokeReason | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
  /** The links.epoch setting when granted (migration 20261011020000); another value voids the trust. */
  epoch: Generated<number>
}

/** One wrong PIN entry (migration 20261011020000): the rolling per-client and per-address limits count these rows. */
export interface IdentityPinFailuresTable {
  id: string
  location_id: string
  customer_id: string | null
  phone_e164: string
  ip: string | null
  at: Generated<Date>
}

export interface AssistantPendingActionsTable {
  id: string
  location_id: string
  conversation_id: string
  customer_id: string
  phone_e164: string
  kind: PendingActionKind
  payload: JsonColumn<{ [key: string]: JsonValue }>
  code_hash: string
  attempts: Generated<number>
  max_attempts: Generated<number>
  expires_at: Date
  state: Generated<PendingActionState>
  confirm_message_id: string | null
  appointment_id: string | null
  error: string | null
  created_at: Generated<Date>
  resolved_at: Date | null
}

declare module '../customers/schema.js' {
  interface CustomersTable {
    email_verified: Generated<boolean>
    /** Bumped on every phone change; a link issued for another version is dead. */
    phone_version: Generated<number>
    /** The last proof of being this client (their PIN, staff confirming the number); migration 20261013010000. */
    identity_confirmed_at: Date | null
    /** The number moved to a new client after a party verified only the number on this stale record (staff flag). */
    phone_reassigned_at: Date | null
    phone_reassigned_to: string | null
  }
  interface AppointmentsTable {
    /** Booked by a link page or the assistant for a session verified with this client's own PIN (migration 20261013010000). */
    booked_with_pin: Generated<boolean>
  }
}

declare module '../public/schema.js' {
  interface PublicOtpChallengesTable {
    purpose: Generated<OtpPurpose>
    link_session_hash: string | null
  }
}

declare module '../../platform/schema.js' {
  interface Database {
    client_links: ClientLinksTable
    client_link_sessions: ClientLinkSessionsTable
    customer_pins: CustomerPinsTable
    phone_trust: PhoneTrustTable
    assistant_pending_actions: AssistantPendingActionsTable
    identity_pin_failures: IdentityPinFailuresTable
  }
}
