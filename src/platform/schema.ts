// Kysely table types for the platform migration. Verticals add their tables by augmenting the Database interface:
//   declare module '../../platform/schema.js' { interface Database { customers: CustomersTable } }
import type { ColumnType, Generated } from 'kysely'

export type Timestamp = ColumnType<Date, Date | string, Date | string>
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
/** jsonb columns are written with JSON.stringify(value) (arrays would otherwise be sent as Postgres arrays). */
export type JsonColumn<T = JsonValue> = ColumnType<T, string, string>

export interface LocationsTable {
  id: string
  name: string
  slug: string
  timezone: Generated<string>
  address: string | null
  lat: ColumnType<string | null, number | string | null, number | string | null>
  lng: ColumnType<string | null, number | string | null, number | string | null>
  created_at: Generated<Date>
}

export interface SettingsTable {
  location_id: string
  key: string
  value: JsonColumn
  version: Generated<number>
  updated_by: string | null
  updated_at: Generated<Date>
}

export interface IdempotencyKeysTable {
  key: string
  actor: string
  method: string
  route: string
  request_hash: string
  state: 'in_flight' | 'done'
  response_status: number | null
  response_body: JsonColumn | null
  response_headers: JsonColumn<Record<string, string>> | null
  created_at: Timestamp
  lock_expires_at: Timestamp
  expires_at: Timestamp
}

export interface RealtimeEventsTable {
  id: Generated<number>
  at: Generated<Date>
  location_id: string
  channel: string
  type: string
  payload: JsonColumn<Record<string, JsonValue>>
  target_user_id: string | null
}

export interface RealtimeStateTable {
  id: Generated<boolean>
  purged_through: Generated<number>
}

export interface AuditLogTable {
  id: Generated<number>
  at: Generated<Date>
  location_id: string
  actor_user_id: string | null
  actor_employee_id: string | null
  actor_name: string | null
  actor_roles: string | null
  view_as_role_id: string | null
  action: string
  entity_type: string
  entity_id: string | null
  before: JsonColumn | null
  after: JsonColumn | null
  request_id: string | null
  idempotency_key: string | null
  ip: string | null
}

export interface WebhookLogTable {
  id: string
  provider: 'squarespace' | 'smsgate' | 'ses'
  external_id: string
  headers: JsonColumn<Record<string, string>>
  body: string | null
  signature_valid: boolean
  received_at: Generated<Date>
  processed_at: Date | null
  status: Generated<'received' | 'processed' | 'ignored' | 'failed'>
  error: string | null
}

export interface NotificationsTable {
  id: string
  location_id: string
  employee_id: string | null
  role_target: string | null
  kind: string
  title: string
  body: string | null
  entity_type: string | null
  entity_id: string | null
  created_at: Generated<Date>
  read_at: Date | null
}

export interface PlatformTables {
  locations: LocationsTable
  settings: SettingsTable
  idempotency_keys: IdempotencyKeysTable
  realtime_events: RealtimeEventsTable
  realtime_state: RealtimeStateTable
  audit_log: AuditLogTable
  webhook_log: WebhookLogTable
  notifications: NotificationsTable
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Database extends PlatformTables {}
