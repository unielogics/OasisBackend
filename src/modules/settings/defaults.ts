// Design defaults and the idempotent row-creation used by seeds, tests and new locations.
import type { Tx } from '../../platform/db.js'
import './schema.js'
import type { HoursDay } from './hours.js'

/** Sun 9-3, Mon-Fri 8-6, Sat 8-5 (minutes from midnight, weekday 0 = Sunday). */
export const DEFAULT_HOURS: readonly HoursDay[] = [
  { weekday: 0, isOpen: true, openMin: 540, closeMin: 900 },
  { weekday: 1, isOpen: true, openMin: 480, closeMin: 1080 },
  { weekday: 2, isOpen: true, openMin: 480, closeMin: 1080 },
  { weekday: 3, isOpen: true, openMin: 480, closeMin: 1080 },
  { weekday: 4, isOpen: true, openMin: 480, closeMin: 1080 },
  { weekday: 5, isOpen: true, openMin: 480, closeMin: 1080 },
  { weekday: 6, isOpen: true, openMin: 480, closeMin: 1020 },
]

/** Inserts any missing hours, booking_rules, vip_settings and arrival_settings row with the design defaults. */
export async function ensureDomainDefaults(tx: Tx, locationId: string): Promise<void> {
  await tx
    .insertInto('business_hours')
    .values(
      DEFAULT_HOURS.map((d) => ({
        location_id: locationId,
        weekday: d.weekday,
        is_open: d.isOpen,
        open_min: d.openMin,
        close_min: d.closeMin,
      })),
    )
    .onConflict((oc) => oc.columns(['location_id', 'weekday']).doNothing())
    .execute()
  await tx
    .insertInto('booking_rules')
    .values({ location_id: locationId, updated_by: null })
    .onConflict((oc) => oc.column('location_id').doNothing())
    .execute()
  await tx
    .insertInto('vip_settings')
    .values({ location_id: locationId, updated_by: null })
    .onConflict((oc) => oc.column('location_id').doNothing())
    .execute()
  await tx
    .insertInto('arrival_settings')
    .values({ location_id: locationId, updated_by: null })
    .onConflict((oc) => oc.column('location_id').doNothing())
    .execute()
}
