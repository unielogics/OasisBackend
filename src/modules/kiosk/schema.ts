// Kysely table types for the kiosk migrations (ADR 0180): db/migrations/20261016100000_kiosk.sql (devices, codes, sessions and the
// kiosk columns of employees, sessions and audit_log), 20261016100100_staff_attribution.sql (the employee columns next to the user
// columns) and 20261016100200_staff_events.sql (per-employee activity).
import type { ColumnType, Generated } from 'kysely'
import type { JsonColumn, JsonValue } from '../../platform/schema.js'

type Ts = ColumnType<Date, Date | string, Date | string>

export type KioskLockRule = 'closing' | 'previous_day' | 'two_hours'
export type KioskRevokeReason =
  | 'lock'
  | 'lock_device'
  | 'lock_all'
  | 'code_changed'
  | 'device_revoked'
  | 'kiosk_off'
  | 'unlock_again'

export const STAFF_EVENT_KINDS = [
  'confirm',
  'arrive',
  'assign_bay',
  'start',
  'complete',
  'notify_ready',
  'pickup',
  'pickup_reopen',
  'prep_bay',
  'reschedule',
  'update',
  'book',
  'walk_in',
  'customer_create',
  'addon_add',
  'addon_remove',
  'size_change',
  'checklist',
  'photo',
  'payment',
  'tip',
  'receipt',
  'payment_link',
  'text',
  'arrival_link',
  'worker_set',
] as const
export type StaffEventKind = (typeof STAFF_EVENT_KINDS)[number]

export interface KioskDevicesTable {
  id: string
  location_id: string
  name: string
  token_hash: string
  created_at: Generated<Date>
  created_by: string | null
  created_by_name: string | null
  last_seen_at: Ts | null
  last_ip: string | null
  last_ua: string | null
  failed_attempts: Generated<number>
  last_failed_at: Ts | null
  locked_out_at: Ts | null
  revoked_at: Ts | null
  revoked_by: string | null
  version: Generated<number>
}

export interface KioskCodesTable {
  id: string
  location_id: string
  code_hash: string
  created_at: Generated<Date>
  created_by: string | null
  created_by_name: string | null
  retired_at: Ts | null
}

export interface KioskSessionsTable {
  id: string
  device_id: string
  location_id: string
  code_id: string
  created_at: Generated<Date>
  expires_at: Ts
  lock_rule: KioskLockRule
  csrf_secret: string
  ip: string | null
  ua: string | null
  last_seen_at: Generated<Date>
  revoked_at: Ts | null
  revoked_reason: KioskRevokeReason | null
}

export interface StaffEventsTable {
  id: Generated<number>
  location_id: string
  at: Generated<Date>
  employee_id: string | null
  employee_name: string
  kind: StaffEventKind
  appointment_id: string | null
  customer_id: string | null
  amount_cents: number | null
  ledger_event_id: string | null
  message_id: string | null
  via: 'kiosk' | 'signed_in'
  kiosk_device_id: string | null
  user_id: string | null
  request_id: string | null
  meta: Generated<JsonColumn<Record<string, JsonValue>>>
}

declare module '../people/schema.js' {
  interface EmployeesTable {
    /** "Shows on the kiosk": listed in the kiosk's employee picker (migration 20261016100000). */
    kiosk_listed: Generated<boolean>
  }
  interface SessionsTable {
    /** The kiosk device an admin signed in on (short timings and a banner; migration 20261016100000). */
    kiosk_device_id: string | null
  }
}

declare module '../../platform/schema.js' {
  interface AuditLogTable {
    /** The kiosk device behind the action (migration 20261016100000; no foreign key). */
    kiosk_device_id: string | null
  }
  interface Database {
    kiosk_devices: KioskDevicesTable
    kiosk_codes: KioskCodesTable
    kiosk_sessions: KioskSessionsTable
    staff_events: StaffEventsTable
  }
}

// The employee columns beside the user columns (migration 20261016100100). Written by the attribution package (wave K1b).
declare module '../customers/schema.js' {
  interface ActivityLogTable {
    actor_employee_id: string | null
    kiosk_device_id: string | null
  }
  interface AppointmentsTable {
    created_by_employee_id: string | null
  }
  interface AppointmentAddonsTable {
    added_by_employee_id: string | null
  }
  interface AppointmentPhotosTable {
    uploaded_by_employee_id: string | null
  }
}

declare module '../payments/schema.js' {
  interface PaymentLinksTable {
    created_by_employee_id: string | null
  }
}
