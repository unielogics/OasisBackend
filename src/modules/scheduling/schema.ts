// Kysely types for the tables the scheduling module owns (the appointment tables are typed in customers/schema.ts).
import type { Generated } from 'kysely'

export interface OpsAlertStateTable {
  location_id: string
  alerts_hash: string
  alert_keys: Generated<string[]>
  updated_at: Generated<Date>
}

declare module '../../platform/schema.js' {
  interface Database {
    ops_alert_state: OpsAlertStateTable
  }
}
