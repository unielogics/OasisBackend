// appointments.categories (ADR 0160, plan K): the category keys of what an appointment holds, its package and its live add-ons, in
// category order (sort, then key). Kept right by the commands that change what an appointment holds: booking (createAppointment),
// adding and removing an add-on, and a service moving to another category (for the visits not yet finished; a finished, canceled
// or no-show visit keeps what it was). The same SQL as the migration's backfill, so every path agrees.
import { sql } from 'kysely'
import type { Executor, Tx } from '../../platform/db.js'
import { isUuid } from '../../platform/ids.js'
import '../customers/schema.js'
import './schema.js'

/** The statuses whose categories still follow the catalog. */
export const OPEN_STATUSES = ['booked', 'confirmed', 'arrived', 'cleaning'] as const

/** The add-ons category: an add-on alone never makes a visit "mixed". */
export const ADDONS_CATEGORY = 'addons'

/**
 * Recomputes the categories of these appointments from their package and live add-ons; rows already right are not written.
 * Returns how many rows changed.
 */
export async function refreshAppointmentCategories(tx: Tx, appointmentIds: string | readonly string[]): Promise<number> {
  const ids = (typeof appointmentIds === 'string' ? [appointmentIds] : [...appointmentIds]).filter(isUuid)
  if (ids.length === 0) return 0
  const r = await sql`
    update appointments a
       set categories = c.categories
      from (
        select a2.id, coalesce((
          select array_agg(x.key order by x.sort, x.key)
            from (
              select distinct cc.key, cc.sort
                from services s
                join catalog_categories cc on cc.location_id = s.location_id and cc.key = s.category
               where s.id = a2.service_id
                  or s.id in (select aa.service_id from appointment_addons aa where aa.appointment_id = a2.id and aa.removed_at is null)
            ) x
        ), '{}'::text[]) as categories
          from appointments a2
         where a2.id = any(${ids}::uuid[])
      ) c
     where a.id = c.id and a.categories is distinct from c.categories`.execute(tx)
  return Number(r.numAffectedRows ?? 0)
}

/** Recomputes the open visits (not finished, canceled or no-show) that hold the service as their package or a live add-on. */
export async function refreshCategoriesForService(tx: Tx, locationId: string, serviceId: string): Promise<number> {
  const rows = await tx
    .selectFrom('appointments as a')
    .select('a.id')
    .where('a.location_id', '=', locationId)
    .where('a.status', 'in', [...OPEN_STATUSES])
    .where((eb) =>
      eb.or([
        eb('a.service_id', '=', serviceId),
        eb.exists(
          eb
            .selectFrom('appointment_addons as aa')
            .select('aa.id')
            .whereRef('aa.appointment_id', '=', 'a.id')
            .where('aa.service_id', '=', serviceId)
            .where('aa.removed_at', 'is', null),
        ),
      ]),
    )
    .execute()
  return refreshAppointmentCategories(
    tx,
    rows.map((r) => r.id),
  )
}

/** Every open visit of the location (after a catalog re-categorisation such as the website-catalog seed). */
export async function refreshOpenAppointmentCategories(tx: Tx, locationId: string): Promise<number> {
  const rows = await tx
    .selectFrom('appointments')
    .select('id')
    .where('location_id', '=', locationId)
    .where('status', 'in', [...OPEN_STATUSES])
    .execute()
  return refreshAppointmentCategories(
    tx,
    rows.map((r) => r.id),
  )
}

/** The categories a package and add-ons would give an appointment (for a preview before booking), in category order. */
export async function categoriesOf(db: Executor, locationId: string, serviceIds: readonly string[]): Promise<string[]> {
  const ids = serviceIds.filter(isUuid)
  if (ids.length === 0) return []
  const rows = await db
    .selectFrom('services as s')
    .innerJoin('catalog_categories as cc', (j) => j.onRef('cc.location_id', '=', 's.location_id').onRef('cc.key', '=', 's.category'))
    .select(['cc.key', 'cc.sort'])
    .distinct()
    .where('s.location_id', '=', locationId)
    .where('s.id', 'in', ids)
    .execute()
  return rows.sort((a, b) => a.sort - b.sort || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((r) => r.key)
}

/**
 * The one word a board chip or a KPI counts a visit under: its category, ignoring add-ons ("wash" for a wash with wax), "mixed"
 * when it holds two or more other categories (a wash and a tint), the add-ons category for add-ons alone, null for nothing.
 */
export function visitCategory(categories: readonly string[]): string | null {
  const main = categories.filter((c) => c !== ADDONS_CATEGORY)
  if (main.length >= 2) return 'mixed'
  return main[0] ?? categories[0] ?? null
}

/** Every appointment of the location, whatever its status (seeds that insert appointments directly call it once at the end). */
export async function refreshAllAppointmentCategories(tx: Tx, locationId: string): Promise<number> {
  const rows = await tx.selectFrom('appointments').select('id').where('location_id', '=', locationId).execute()
  return refreshAppointmentCategories(
    tx,
    rows.map((r) => r.id),
  )
}
