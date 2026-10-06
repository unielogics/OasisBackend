import type { Generated } from 'kysely'

export type BayStatus = 'active' | 'maintenance' | 'blocked'

export interface BaysTable {
  id: string
  location_id: string
  number: number
  name: string
  status: Generated<BayStatus>
  sort: Generated<number>
  created_at: Generated<Date>
}

export interface BusinessHoursTable {
  location_id: string
  weekday: number
  is_open: boolean
  open_min: number
  close_min: number
}

export interface BookingRulesTable {
  location_id: string
  slot_minutes: Generated<number>
  buffer_minutes: Generated<number>
  cutoff_minutes: Generated<number>
  online_lead_minutes: Generated<number>
  allow_overrun: Generated<boolean>
  auto_plan_bay: Generated<boolean>
  version: Generated<number>
  updated_by: string | null
  updated_at: Generated<Date>
}

export type ClosureType = 'closed' | 'reduced'
export type ClosureSource = 'manual' | 'federal' | 'emergency'

export interface ClosuresTable {
  id: string
  location_id: string
  /** Business date, 'YYYY-MM-DD'. */
  date: string
  name: string
  type: ClosureType
  open_min: number | null
  close_min: number | null
  notify: Generated<boolean>
  source: Generated<ClosureSource>
  federal_key: string | null
  federal_year: number | null
  emergency_closure_id: string | null
  created_by: string | null
  deleted_at: Date | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface FederalHolidayRunsTable {
  location_id: string
  year: number
  ran_at: Generated<Date>
}

export type EmergencyReason = 'severe_weather' | 'power_outage' | 'equipment_failure' | 'staff_shortage' | 'other'
export type EmergencyDurationKind = 'today' | 'until' | 'days'

export interface EmergencyClosuresTable {
  id: string
  location_id: string
  active: Generated<boolean>
  reason: EmergencyReason
  duration_kind: EmergencyDurationKind
  until_min: number | null
  through_date: string | null
  ends_at: Date | null
  message: Generated<string>
  notify: Generated<boolean>
  link: Generated<boolean>
  credits: Generated<boolean>
  pause: Generated<boolean>
  crew: Generated<boolean>
  summary: Generated<string>
  started_at: Generated<Date>
  started_by: string | null
  started_by_name: string | null
  reopened_at: Date | null
  reopened_by: string | null
  reopened_by_name: string | null
  auto_reopened: Generated<boolean>
  affected_count: Generated<number>
  notified_count: Generated<number>
  rebooked_count: Generated<number>
  detail: string | null
  replaced_closure_ids: Generated<string[]>
  created_at: Generated<Date>
}

export type NotificationState =
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'skipped_opt_out'
  | 'no_contact'

export interface EmergencyNotificationsTable {
  id: string
  emergency_closure_id: string
  appointment_id: string
  customer_id: string
  message_id: string | null
  channel: 'sms' | 'email' | 'none'
  state: NotificationState
  reschedule_link_id: string | null
  rebooked_at: Date | null
  created_at: Generated<Date>
}

export interface RescheduleLinksTable {
  id: string
  code: string
  appointment_id: string
  emergency_closure_id: string | null
  closure_id: string | null
  expires_at: Date
  used_at: Date | null
  result_appointment_id: string | null
  created_at: Generated<Date>
}

export interface VipSettingsTable {
  location_id: string
  release_hours: Generated<number>
  window_vip_days: Generated<number>
  window_std_days: Generated<number>
  same_day_per_month: Generated<number>
  waitlist: Generated<boolean>
  offer_minutes: Generated<number>
  standing: Generated<boolean>
  auto_confirm: Generated<boolean>
  cadences: Generated<string[]>
  version: Generated<number>
  updated_by: string | null
  updated_at: Generated<Date>
}

export interface VipHoldsTable {
  id: string
  location_id: string
  weekday: number
  time_min: number
  created_at: Generated<Date>
}

export interface VipClientsTable {
  location_id: string
  customer_id: string
  added_by: string | null
  added_at: Generated<Date>
}

export interface ArrivalSettingsTable {
  location_id: string
  enabled: Generated<boolean>
  radius_m: Generated<number>
  prep_at_min: Generated<number>
  auto_arrive: Generated<boolean>
  welcome: Generated<boolean>
  alert_crew: Generated<boolean>
  vip_first: Generated<boolean>
  version: Generated<number>
  updated_by: string | null
  updated_at: Generated<Date>
}

declare module '../../platform/schema.js' {
  interface Database {
    bays: BaysTable
    business_hours: BusinessHoursTable
    booking_rules: BookingRulesTable
    closures: ClosuresTable
    federal_holiday_runs: FederalHolidayRunsTable
    emergency_closures: EmergencyClosuresTable
    emergency_notifications: EmergencyNotificationsTable
    reschedule_links: RescheduleLinksTable
    vip_settings: VipSettingsTable
    vip_holds: VipHoldsTable
    vip_clients: VipClientsTable
    arrival_settings: ArrivalSettingsTable
  }
}
