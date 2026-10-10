// Kysely types for the public website's tables (migration 20261006500000_public_website.sql, ADR 0150), registered by module
// augmentation.
import type { Generated } from 'kysely'

export type OtpConsumedReason = 'verified' | 'superseded' | 'locked'

export interface PublicOtpChallengesTable {
  id: string
  location_id: string
  phone_e164: string
  code_hash: string
  attempts: Generated<number>
  max_attempts: Generated<number>
  expires_at: Date
  consumed_at: Date | null
  consumed_reason: OtpConsumedReason | null
  requested_ip: string | null
  delivery: Generated<string>
  created_at: Generated<Date>
}

export interface PublicMemberTokensTable {
  token_hash: string
  location_id: string
  phone_e164: string
  customer_id: string | null
  challenge_id: string | null
  expires_at: Date
  last_used_at: Date | null
  created_at: Generated<Date>
}

export interface PublicRateLimitsTable {
  key: string
  window_start: Date
  count: Generated<number>
}

declare module '../../platform/schema.js' {
  interface Database {
    public_otp_challenges: PublicOtpChallengesTable
    public_member_tokens: PublicMemberTokensTable
    public_rate_limits: PublicRateLimitsTable
  }
}
