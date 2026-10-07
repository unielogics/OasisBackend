// Kysely types for the tables the scheduling module owns (the appointment tables are typed in customers/schema.ts).
import type { ColumnType, Generated } from 'kysely'
import type { JsonValue } from '../../platform/schema.js'

export interface OpsAlertStateTable {
  location_id: string
  alerts_hash: string
  alert_keys: Generated<string[]>
  updated_at: Generated<Date>
}

export interface ArrivalPingsTable {
  id: string
  location_id: string
  appointment_id: string
  at: Generated<Date>
  lat: ColumnType<string, number | string, number | string>
  lng: ColumnType<string, number | string, number | string>
  accuracy_m: number | null
  distance_m: number
  eta_min: number | null
  declared: Generated<boolean>
  outcome: 'outside' | 'inconclusive' | 'checked_in' | 'confirm_needed' | 'already_arrived'
  ping_key: string | null
  reply: ColumnType<JsonValue, string, string>
}

// Arrival links add an expiry to the appointment row (migration 20261006300000_arrival_ping.sql).
declare module '../customers/schema.js' {
  interface AppointmentsTable {
    arrival_token_expires_at: Date | null
  }
}

declare module '../../platform/schema.js' {
  interface Database {
    ops_alert_state: OpsAlertStateTable
    arrival_pings: ArrivalPingsTable
  }
}
