// Kysely table types for the kiosk migrations (ADR 0180): db/migrations/20261016100000_kiosk.sql (devices, sessions and the kiosk
// columns of employees, sessions and audit_log), 20261016100100_staff_attribution.sql (the employee columns next to the user columns),
// 20261016100200_staff_events.sql (per-employee activity), 20261016100300_staff_attribution_links.sql (the audit row of a staff event;
// who confirmed a saved-card charge) and 20261017100000_kiosk_pins.sql (the amendment: per-employee PINs, the shop's networks, the
// refused tries, who opened a kiosk session; the shop code dropped).
import type { ColumnType, Generated } from 'kysely'
import type { JsonColumn, JsonValue } from '../../platform/schema.js'

type Ts = ColumnType<Date, Date | string, Date | string>

export type KioskLockRule = 'closing' | 'previous_day' | 'two_hours'
export type KioskRevokeReason =
  | 'lock'
  | 'lock_device'
  | 'lock_all'
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
  /** Somebody's PIN opened the kiosk (ADR 0180 amendment): "Opened by Marco R.". */
  'kiosk_unlock',
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

/** An employee's kiosk PIN: its lookup (hex HMAC-SHA256 over "<location>:<pin>"), unique within the shop. */
export interface EmployeeKioskPinsTable {
  employee_id: string
  location_id: string
  pin_lookup: string
  set_at: Generated<Date>
  set_by: string | null
  set_by_name: string | null
}

/** An employee's previous PIN lookups (the "not one of your last 3" rule). */
export interface EmployeeKioskPinHistoryTable {
  id: Generated<number>
  employee_id: string
  pin_lookup: string
  set_at: Ts
  retired_at: Generated<Date>
}

/** A shop network: an IPv4 /32 or an IPv6 /64 (text as Postgres prints a cidr), with the per-address unlock throttle. */
export interface KioskNetworksTable {
  id: string
  location_id: string
  cidr: string
  label: string | null
  added_by: string | null
  added_by_name: string | null
  added_at: Generated<Date>
  last_seen_at: Ts | null
  failed_attempts: Generated<number>
  last_failed_at: Ts | null
  locked_out_at: Ts | null
}

/** "PIN tried from an unknown network": one row per address (/32 or /64), capped and pruned. */
export interface KioskRefusedNetworksTable {
  id: string
  location_id: string
  cidr: string
  first_seen_at: Generated<Date>
  last_seen_at: Generated<Date>
  attempts: Generated<number>
  known_device_id: string | null
  known_device_name: string | null
}

export interface KioskSessionsTable {
  id: string
  device_id: string
  location_id: string
  /** Whose PIN opened it (ADR 0180 amendment); null once that employee row is deleted. */
  opened_by_employee_id: string | null
  /** "Marco R." at the time. */
  opened_by_name: string
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
  /** The audit_log row the event was recorded with (no foreign key; unique when set). */
  audit_id: number | null
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
    kiosk_sessions: KioskSessionsTable
    employee_kiosk_pins: EmployeeKioskPinsTable
    employee_kiosk_pin_history: EmployeeKioskPinHistoryTable
    kiosk_networks: KioskNetworksTable
    kiosk_refused_networks: KioskRefusedNetworksTable
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
    /** The worker when the car was completed (migration 20261016100400): the activity report's bay time counts for them. */
    completed_worker_id: string | null
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

// Who confirmed a saved-card charge, beside decided_by_user_id (migration 20261016100300): the payment may be recorded later in their
// name, and a kiosk has no user.
declare module '../square/db/cards-schema.js' {
  interface SquareChargesTable {
    decided_by_employee_id: string | null
    decided_kiosk_device_id: string | null
  }
}
