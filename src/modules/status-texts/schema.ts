// Kysely types for the status-text tables (migration 20261011000400_status_texts.sql, ADR 0160). Registered by module augmentation.
import type { Generated } from 'kysely'

export type PendingCheckinState = 'pending' | 'sent' | 'dropped'
export type CheckinDropReason = 'cleaning_started' | 'canceled' | 'disabled' | 'not_sendable'

export interface PendingCheckinTextsTable {
  appointment_id: string
  location_id: string
  due_at: Date
  state: Generated<PendingCheckinState>
  drop_reason: CheckinDropReason | null
  message_id: string | null
  created_at: Generated<Date>
  settled_at: Date | null
}

export interface AppointmentLateTextsTable {
  appointment_id: string
  /** 1 or 2: at most two running-late texts per visit. */
  seq: number
  eta_at: Date
  message_id: string | null
  created_at: Generated<Date>
}

declare module '../../platform/schema.js' {
  interface Database {
    pending_checkin_texts: PendingCheckinTextsTable
    appointment_late_texts: AppointmentLateTextsTable
  }
}
