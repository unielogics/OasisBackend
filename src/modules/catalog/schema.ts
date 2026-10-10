import type { Generated } from 'kysely'

export type ServiceKind = 'package' | 'addon'
/** What VIP members get of a service on the website: included, an allowance (vip_note says how much), or nothing. */
export type VipInclusion = 'included' | 'allowance' | 'none'

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
  // the website/AI fields (migration 20261011000000_catalog_categories.sql, ADR 0160)
  /** catalog_categories.key of the same location; null = uncategorised. */
  category: string | null
  public_name: string | null
  description: string | null
  member_price_cents: number | null
  guest_price_cents: number | null
  vip_inclusion: Generated<VipInclusion>
  vip_note: string | null
  quote_only: Generated<boolean>
  visible_online: Generated<boolean>
}

/** The categories of the catalog (Wash, Add-ons, Tint, Detail, Quote by default), with the colour the dashboard and site show. */
export interface CatalogCategoriesTable {
  location_id: string
  key: string
  label: string
  /** #RRGGBB */
  colour: string
  sort: Generated<number>
  active: Generated<boolean>
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

// Each appointment keeps the categories of its package and live add-ons, in category order (maintained from wave 2 on).
declare module '../customers/schema.js' {
  interface AppointmentsTable {
    categories: Generated<string[]>
  }
}

declare module '../../platform/schema.js' {
  interface Database {
    catalog_categories: CatalogCategoriesTable
    services: ServicesTable
    checklist_tasks: ChecklistTasksTable
  }
}
