// Kysely types for the messaging tables (migration 20261006200000_messaging.sql), registered by module augmentation.
import type { Generated } from 'kysely'
import type { JsonColumn, JsonValue } from '../../platform/schema.js'

export type SmsDeviceStatus = 'unknown' | 'online' | 'degraded' | 'offline'
export type SmsDeviceProviderKind = 'sim' | 'smsgate'

export interface SmsDevicesTable {
  id: string
  location_id: string
  device_key: string
  label: string
  provider: Generated<SmsDeviceProviderKind>
  base_url: string | null
  username: string | null
  password_enc: string | null
  webhook_secret_enc: string
  remote_device_id: string | null
  sim_slot_default: number | null
  min_interval_ms: number | null
  max_per_window: number | null
  window_minutes: number | null
  enabled: Generated<boolean>
  status: Generated<SmsDeviceStatus>
  state_changed_at: Date | null
  last_seen_at: Date | null
  last_ping_at: Date | null
  last_app_started_at: Date | null
  last_poll_ok_at: Date | null
  consecutive_poll_failures: Generated<number>
  health_status: 'pass' | 'warn' | 'fail' | null
  battery: number | null
  charging: boolean | null
  last_health: JsonColumn<JsonValue> | null
  last_error: string | null
  webhooks_url: string | null
  webhooks_registered_at: Date | null
  sent_count: Generated<number>
  delivered_count: Generated<number>
  failed_count: Generated<number>
  received_count: Generated<number>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface MessageThreadsTable {
  id: string
  location_id: string
  customer_id: string
  last_message_at: Date | null
  last_inbound_at: Date | null
  unread_count: Generated<number>
  created_at: Generated<Date>
}

export type MessageDirection = 'in' | 'out'
export type MessageSenderKind = 'staff' | 'system' | 'customer'
export type MessageStatus =
  'queued' | 'sending' | 'sent' | 'delivered' | 'failed' | 'received' | 'canceled' | 'expired'

export interface MessagesTable {
  id: string
  location_id: string
  thread_id: string | null
  customer_id: string | null
  employee_id: string | null
  appointment_id: string | null
  direction: MessageDirection
  sender_kind: MessageSenderKind
  sender_employee_id: string | null
  channel: Generated<'sms' | 'email' | 'internal'>
  body: string
  template_key: string | null
  purpose: string | null
  klass: string | null
  status: MessageStatus
  peer_e164: string | null
  provider_message_id: string | null
  device_id: string | null
  error: string | null
  segments: Generated<number>
  encoding: 'GSM-7' | 'UCS-2' | null
  idempotency_key: string | null
  queued_at: Generated<Date>
  sent_at: Date | null
  delivered_at: Date | null
  received_at: Date | null
  read_at: Date | null
  created_at: Generated<Date>
}

export type OutboxStateColumn =
  'pending' | 'inflight' | 'accepted' | 'sent' | 'delivered' | 'failed' | 'expired' | 'cancelled'

export interface SmsOutboxTable {
  id: string
  message_id: string
  to_e164: string
  body: string
  encoding: 'GSM-7' | 'UCS-2'
  segments: number
  klass: string
  priority: number
  state: Generated<OutboxStateColumn>
  attempts: Generated<number>
  device_failures: Generated<number>
  reconcile_resends: Generated<number>
  next_attempt_at: Date | null
  locked_at: Date | null
  provider_message_id: string | null
  device_id: string | null
  sim_slot: number | null
  last_error: string | null
  queued_at: Generated<Date>
  ttl_at: Date
  hold_until: Date | null
  accepted_at: Date | null
  sent_at: Date | null
  delivered_at: Date | null
  failed_at: Date | null
  last_reconciled_at: Date | null
  fallback_emailed_at: Date | null
}

export interface SmsUsageTable {
  id: Generated<number>
  device_id: string | null
  provider_message_id: string
  segments: number
  accepted_at: Date
  sent_at: Date | null
}

export interface SmsProcessedEventsTable {
  event_id: string
  processed_at: Generated<Date>
}

export interface SmsInboxTable {
  id: string
  device_id: string
  provider_message_id: string
  from_raw: string
  from_e164: string | null
  body: string
  device_received_at: Date
  received_at: Generated<Date>
  processed_at: Date | null
  decision: string | null
  quarantined: Generated<boolean>
  customer_id: string | null
  appointment_id: string | null
  message_id: string | null
  reviewed_at: Date | null
}

export interface SmsOptOutsTable {
  id: string
  location_id: string
  phone_e164: string
  opted_out_at: Date
  source: 'keyword' | 'manual' | 'import'
  keyword: string | null
  inbound_message_id: string | null
  opted_out_by: string | null
  opted_in_again_at: Date | null
}

export type EmailState = 'pending' | 'sending' | 'sent' | 'failed' | 'suppressed'

export interface OutboxEmailsTable {
  id: string
  location_id: string
  customer_id: string | null
  employee_id: string | null
  to_email: string
  template: string
  vars: JsonColumn<Record<string, JsonValue>>
  purpose: string | null
  subject: string | null
  body: string | null
  state: Generated<EmailState>
  attempts: Generated<number>
  next_attempt_at: Date | null
  locked_at: Date | null
  provider_message_id: string | null
  error: string | null
  dedupe_key: string | null
  created_at: Generated<Date>
  sent_at: Date | null
}

declare module '../../platform/schema.js' {
  interface Database {
    sms_devices: SmsDevicesTable
    message_threads: MessageThreadsTable
    messages: MessagesTable
    sms_outbox: SmsOutboxTable
    sms_usage: SmsUsageTable
    sms_processed_events: SmsProcessedEventsTable
    sms_inbox: SmsInboxTable
    sms_opt_outs: SmsOptOutsTable
    outbox_emails: OutboxEmailsTable
  }
}
