// Kysely types for the leads table (migration 20261011000300_leads.sql, ADR 0160). Registered by module augmentation.
import type { Generated } from 'kysely'

export type LeadSource = 'text' | 'website' | 'walk_in'
export type LeadStatus = 'new' | 'followed_up' | 'booked' | 'closed'

export interface LeadsTable {
  id: string
  location_id: string
  phone_e164: string
  customer_id: string | null
  source: LeadSource
  /** catalog_categories keys. */
  interests: Generated<string[]>
  status: Generated<LeadStatus>
  first_contact_at: Date
  last_contact_at: Date
  follow_up_at: Date | null
  follow_up_message_id: string | null
  booked_appointment_id: string | null
  closed_at: Date | null
  version: Generated<number>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

declare module '../../platform/schema.js' {
  interface Database {
    leads: LeadsTable
  }
}
