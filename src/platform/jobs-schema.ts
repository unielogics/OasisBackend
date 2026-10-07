// Kysely types for the job-runtime tables (db/migrations/20261006310000_jobs_runtime.sql).
import type { Generated } from 'kysely'

export interface JobRunsTable {
  name: string
  runs: Generated<number>
  failures: Generated<number>
  consecutive_failures: Generated<number>
  last_job_id: string | null
  last_attempt: Generated<number>
  last_outcome: 'running' | 'completed' | 'failed'
  last_started_at: Date
  last_finished_at: Date | null
  last_success_at: Date | null
  last_error_at: Date | null
  last_error: string | null
  last_duration_ms: number | null
  updated_at: Generated<Date>
}

export interface VipHoldReleasesTable {
  hold_id: string
  slot_start: Date
  location_id: string
  released_at: Generated<Date>
}

export interface CreditExpiriesTable {
  lot_event_id: string
  location_id: string
  customer_id: string
  expired_cents: number
  expires_at: Date
  recorded_at: Generated<Date>
}

declare module './schema.js' {
  interface Database {
    job_runs: JobRunsTable
    vip_hold_releases: VipHoldReleasesTable
    credit_expiries: CreditExpiriesTable
  }
}
