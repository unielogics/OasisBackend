// Kysely types for customers, vehicles and the appointment tables (the scheduling vertical owns the appointment
// repositories later; until that module exists the tables are typed here so settings can count and the seeds/tests can
// create rows). Registered through module augmentation, see src/platform/schema.ts.
import type { Generated } from 'kysely'
import type { JsonColumn, JsonValue } from '../../platform/schema.js'

export type CustomerSource = 'dashboard' | 'walk_in' | 'online' | 'squarespace' | 'inbound_sms' | 'import'
export type SmsOptInSource = CustomerSource | 'keyword'

export interface CustomersTable {
  id: string
  full_name: string
  phone_e164: string | null
  phone_display: string | null
  email: string | null
  notes: string | null
  sms_opted_in: Generated<boolean>
  sms_opt_in_source: SmsOptInSource | null
  sms_opt_in_at: Date | null
  sms_opted_out_at: Date | null
  email_bounced_at: Date | null
  source: Generated<CustomerSource>
  synthetic: Generated<boolean>
  needs_details: Generated<boolean>
  merged_into: string | null
  deleted_at: Date | null
  version: Generated<number>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface VehiclesTable {
  id: string
  customer_id: string
  year: number | null
  make: string | null
  model: string | null
  color: string | null
  plate: string | null
  deleted_at: Date | null
  created_at: Generated<Date>
}

export type AppointmentStatus =
  'booked' | 'confirmed' | 'arrived' | 'cleaning' | 'completed' | 'canceled' | 'no_show'
export type AppointmentSource = 'dashboard' | 'walk_in' | 'online' | 'phone' | 'standing' | 'reschedule_link'

export interface AppointmentsTable {
  id: string
  location_id: string
  seq: Generated<number>
  customer_id: string
  vehicle_id: string | null
  service_id: string
  package_name: string
  price_cents: number
  duration_min: number
  status: Generated<AppointmentStatus>
  scheduled_start: Date
  scheduled_end: Date
  assigned_employee_id: string | null
  planned_bay_id: string | null
  bay_id: string | null
  source: Generated<AppointmentSource>
  eta_minutes: number | null
  eta_at: Date | null
  geo_checked_in_at: Date | null
  bay_prepped_at: Date | null
  arrived_at: Date | null
  cleaning_started_at: Date | null
  completed_at: Date | null
  pickup_state: 'pending' | 'collected' | null
  picked_up_at: Date | null
  ready_notified_at: Date | null
  canceled_at: Date | null
  cancel_reason: string | null
  no_show_at: Date | null
  notes: string | null
  special_instructions: string | null
  membership_id: string | null
  emergency_closure_id: string | null
  standing_series_id: string | null
  arrival_token_hash: string | null
  version: Generated<number>
  created_by: string | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface AppointmentAddonsTable {
  id: string
  appointment_id: string
  service_id: string
  name: string
  price_cents: number
  added_by: string | null
  added_at: Generated<Date>
  removed_at: Date | null
}

export type OverrideKind = 'capacity' | 'hours' | 'closure' | 'vip_hold' | 'same_day_guarantee'

export interface AppointmentOverridesTable {
  id: string
  appointment_id: string
  kind: OverrideKind
  reason: string
  employee_id: string | null
  created_at: Generated<Date>
}

export interface JobChecklistItemsTable {
  id: string
  appointment_id: string
  section_kind: 'package' | 'addon'
  section_title: string
  source_task_id: string | null
  appointment_addon_id: string | null
  label: string
  position: number
  done: Generated<boolean>
  done_at: Date | null
  done_by_employee_id: string | null
  removed_at: Date | null
  created_at: Generated<Date>
}

export interface AppointmentPhotosTable {
  id: string
  appointment_id: string
  category: 'arrival' | 'before' | 'after' | 'issue'
  s3_key: string | null
  thumb_key: string | null
  content_type: string | null
  bytes: number | null
  note: string | null
  status: 'pending_upload' | 'ready' | 'deleted'
  taken_at: Generated<Date>
  uploaded_by: string | null
  created_at: Generated<Date>
}

export type ActivityChannel = 'sms' | 'email' | 'internal' | 'automation' | 'system'

export interface ActivityLogTable {
  id: Generated<number>
  appointment_id: string
  at: Generated<Date>
  text: string
  channels: Generated<ActivityChannel[]>
  actor_type: Generated<'staff' | 'system' | 'automation' | 'customer'>
  actor_name: string | null
  meta: Generated<JsonColumn<Record<string, JsonValue>>>
}

declare module '../../platform/schema.js' {
  interface Database {
    customers: CustomersTable
    vehicles: VehiclesTable
    appointments: AppointmentsTable
    appointment_addons: AppointmentAddonsTable
    appointment_overrides: AppointmentOverridesTable
    job_checklist_items: JobChecklistItemsTable
    appointment_photos: AppointmentPhotosTable
    activity_log: ActivityLogTable
  }
}
