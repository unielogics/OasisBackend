// Kysely table types for db/migrations/20261006140000_people_auth.sql (employees, roles/permissions, users, sessions).
import type { ColumnType, Generated } from 'kysely'

type Ts = ColumnType<Date, Date | string, Date | string>

export type EmployeeStatus = 'active' | 'invited' | 'inactive'
export type EmploymentType = 'full_time' | 'part_time' | 'contractor'
export type PayType = 'hourly' | 'commission' | 'salary'

export interface RbacStateTable {
  id: Generated<boolean>
  version: Generated<number>
}

export interface EmployeesTable {
  id: string
  first: string
  last: Generated<string>
  title: Generated<string>
  phone: Generated<string>
  phone_e164: string | null
  email: string | null
  status: Generated<EmployeeStatus>
  employment_type: Generated<EmploymentType>
  pay_type: Generated<PayType>
  rate_text: Generated<string>
  skills: Generated<string[]>
  avatar_color: string | null
  version: Generated<number>
  created_at: Generated<Date>
  updated_at: Generated<Date>
  deactivated_at: Ts | null
}

export interface EmployeeLocationsTable {
  employee_id: string
  location_id: string
}

export interface EmployeeSchedulesTable {
  employee_id: string
  weekday: number
  is_on: boolean
  from_min: number
  to_min: number
}

export interface RolesTable {
  id: string
  key: string | null
  name: string
  description: Generated<string>
  is_locked: Generated<boolean>
  is_custom: Generated<boolean>
  version: Generated<number>
  created_at: Generated<Date>
}

export interface PermissionsTable {
  key: string
  module: string
  label: string
  has_limit: Generated<boolean>
  sort: number
}

export interface RolePermissionsTable {
  role_id: string
  permission_key: string
}

export interface RoleLimitsTable {
  role_id: string
  kind: 'refund' | 'adjust' | 'credit'
  unlimited: Generated<boolean>
  limit_cents: number | null
}

export interface EmployeeRolesTable {
  employee_id: string
  role_id: string
}

export interface EmployeePermissionOverridesTable {
  employee_id: string
  permission_key: string
  effect: 'allow' | 'deny'
}

export interface UsersTable {
  id: string
  employee_id: string
  email: string
  password_hash: string
  failed_attempts: Generated<number>
  last_login_at: Ts | null
  password_changed_at: Generated<Date>
  disabled_at: Ts | null
  created_at: Generated<Date>
}

export interface InvitesTable {
  id: string
  employee_id: string
  token_hash: string
  channel: Generated<'sms' | 'email' | 'link'>
  expires_at: Ts
  accepted_at: Ts | null
  revoked_at: Ts | null
  created_by: string | null
  created_at: Generated<Date>
}

export interface SessionsTable {
  id: string
  user_id: string
  created_at: Generated<Date>
  last_seen_at: Generated<Date>
  idle_expires_at: Ts
  absolute_expires_at: Ts
  ip: string | null
  ua: string | null
  csrf_secret: string
  view_as_role_id: string | null
  revoked_at: Ts | null
}

export interface PasswordResetsTable {
  id: string
  user_id: string
  token_hash: string
  expires_at: Ts
  used_at: Ts | null
  requested_by: string | null
  created_at: Generated<Date>
}

export interface UserPreferencesTable {
  user_id: string
  theme: 'light' | 'dark' | null
  updated_at: Generated<Date>
}

declare module '../../platform/schema.js' {
  interface Database {
    rbac_state: RbacStateTable
    employees: EmployeesTable
    employee_locations: EmployeeLocationsTable
    employee_schedules: EmployeeSchedulesTable
    roles: RolesTable
    permissions: PermissionsTable
    role_permissions: RolePermissionsTable
    role_limits: RoleLimitsTable
    employee_roles: EmployeeRolesTable
    employee_permission_overrides: EmployeePermissionOverridesTable
    users: UsersTable
    invites: InvitesTable
    sessions: SessionsTable
    password_resets: PasswordResetsTable
    user_preferences: UserPreferencesTable
  }
}
