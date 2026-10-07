// Kysely types of the standing-appointment and waitlist tables (migration 20261006300200_standing_waitlist.sql).
import type { Generated } from 'kysely'

export type Cadence = 'weekly' | 'biweekly' | 'triweekly' | 'monthly'
export type SeriesStatus = 'active' | 'paused' | 'ended'
export type EntryStatus = 'waiting' | 'offered' | 'booked' | 'expired' | 'canceled'
export type OfferPhase = 'vip' | 'everyone'
export type OfferStatus = 'open' | 'accepted' | 'expired' | 'canceled'

export interface StandingSeriesTable {
  id: string
  location_id: string
  customer_id: string
  vehicle_id: string | null
  service_id: string
  cadence: Cadence
  weekday: number
  time_min: number
  start_date: string
  end_date: string | null
  status: Generated<SeriesStatus>
  generated_through: string | null
  auto_confirm: Generated<boolean>
  notes: string | null
  created_by: string | null
  version: Generated<number>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface StandingOccurrencesTable {
  id: string
  series_id: string
  occurrence_date: string
  status: 'booked' | 'skipped'
  appointment_id: string | null
  reason: string | null
  created_at: Generated<Date>
}

export interface WaitlistEntriesTable {
  id: string
  location_id: string
  customer_id: string
  vehicle_id: string | null
  service_id: string
  desired_date: string
  window_start_min: number
  window_end_min: number
  is_vip: Generated<boolean>
  status: Generated<EntryStatus>
  appointment_id: string | null
  notes: string | null
  created_by: string | null
  version: Generated<number>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface WaitlistOffersTable {
  id: string
  location_id: string
  entry_id: string
  slot_start: Date
  slot_end: Date
  phase: OfferPhase
  status: Generated<OfferStatus>
  offered_at: Generated<Date>
  expires_at: Date
  resolved_at: Date | null
  message_id: string | null
}

declare module '../../platform/schema.js' {
  interface Database {
    standing_series: StandingSeriesTable
    standing_occurrences: StandingOccurrencesTable
    waitlist_entries: WaitlistEntriesTable
    waitlist_offers: WaitlistOffersTable
  }
}
