import type { Generated } from 'kysely'

export type ServiceKind = 'package' | 'addon'

export interface ServicesTable {
  id: string
  location_id: string
  kind: ServiceKind
  name: string
  short_name: string | null
  price_cents: number
  duration_min: number
  tags: Generated<string[]>
  bookable_desk: Generated<boolean>
  sort: Generated<number>
  active: Generated<boolean>
  sqsp_sku: string | null
  version: Generated<number>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface ChecklistTasksTable {
  id: string
  service_id: string
  label: string
  position: number
  retired_at: Date | null
  created_at: Generated<Date>
}

declare module '../../platform/schema.js' {
  interface Database {
    services: ServicesTable
    checklist_tasks: ChecklistTasksTable
  }
}
