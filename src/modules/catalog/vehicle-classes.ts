// The vehicle sizes (ADR 0170, plan decision 1): Compact car, Large car, Compact SUV, Large SUV and Truck by default. Every service
// has one price per size (price-book.ts); a membership is priced at a size. Built on the categories pattern (categories.ts):
// migration 20261014100000 seeded these rows for the locations that existed; ensureVehicleClasses gives a new location the same rows
// (idempotent, never overwrites an edited row). Staff rename, reorder, add and turn sizes off in Settings; the key never changes
// (prices, tier prices, vehicles, memberships and visits refer to it), and a size anything uses cannot be deleted (turn it off).
import type { Executor, Tx } from '../../platform/db.js'
import * as audit from '../../platform/audit.js'
import { AppError } from '../../platform/errors.js'
import * as realtime from '../../platform/realtime.js'
import './problems.js'
import './schema.js'
import '../memberships/schema.js'
import '../payments/schema.js'

export interface VehicleClassDefault {
  key: string
  label: string
  sort: number
}

export const DEFAULT_VEHICLE_CLASSES: readonly VehicleClassDefault[] = [
  { key: 'compact_car', label: 'Compact car', sort: 10 },
  { key: 'large_car', label: 'Large car', sort: 20 },
  { key: 'compact_suv', label: 'Compact SUV', sort: 30 },
  { key: 'large_suv', label: 'Large SUV', sort: 40 },
  { key: 'truck', label: 'Truck', sort: 50 },
]

export const CLASS_KEY = /^[a-z][a-z0-9_]{0,31}$/
/** At most this many sizes per location (the price grid's columns). */
export const MAX_VEHICLE_CLASSES = 12

/** Inserts the default sizes when the location has none (a location that has sizes keeps its own list, edits and removals). */
export async function ensureVehicleClasses(db: Executor, locationId: string): Promise<void> {
  const any = await db.selectFrom('vehicle_classes').select('key').where('location_id', '=', locationId).limit(1).executeTakeFirst()
  if (any) return
  await db
    .insertInto('vehicle_classes')
    .values(DEFAULT_VEHICLE_CLASSES.map((c) => ({ location_id: locationId, key: c.key, label: c.label, sort: c.sort })))
    .onConflict((oc) => oc.columns(['location_id', 'key']).doNothing())
    .execute()
}

export interface VehicleClass {
  key: string
  label: string
  sort: number
  active: boolean
  version: number
}

const COLUMNS = ['key', 'label', 'sort', 'active', 'version'] as const

const toClass = (r: VehicleClass): VehicleClass => ({ key: r.key, label: r.label, sort: r.sort, active: r.active, version: r.version })

/** In size order (sort, then key), turned-off ones included unless `activeOnly`. */
export async function listVehicleClasses(
  db: Executor,
  locationId: string,
  o: { activeOnly?: boolean } = {},
): Promise<VehicleClass[]> {
  let q = db.selectFrom('vehicle_classes').select([...COLUMNS]).where('location_id', '=', locationId)
  if (o.activeOnly) q = q.where('active', '=', true)
  return (await q.orderBy('sort').orderBy('key').execute()).map(toClass)
}

const invalid = (path: string, message: string): AppError =>
  new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path, message }] })

/** A size of the location (422 on `path` otherwise); `active` also refuses one that is turned off. */
export async function requireVehicleClass(
  db: Executor,
  locationId: string,
  key: string,
  o: { active?: boolean; path?: string } = {},
): Promise<VehicleClass> {
  const r = CLASS_KEY.test(key)
    ? await db
        .selectFrom('vehicle_classes')
        .select([...COLUMNS])
        .where('location_id', '=', locationId)
        .where('key', '=', key)
        .executeTakeFirst()
    : undefined
  if (!r || (o.active && !r.active)) throw invalid(o.path ?? 'class', 'Pick one of the shop’s vehicle sizes.')
  return toClass(r)
}

export interface VehicleClassInput {
  label?: string
  sort?: number
  active?: boolean
}

function checkInput(i: VehicleClassInput): void {
  if (i.label !== undefined && (i.label.trim() === '' || i.label.trim().length > 40))
    throw invalid('label', 'Enter a name of up to 40 characters.')
  if (i.sort !== undefined && (!Number.isInteger(i.sort) || i.sort < -100_000 || i.sort > 100_000))
    throw invalid('sort', 'Enter an order from -100000 to 100000.')
}

const auditOf = (c: VehicleClass) => ({ label: c.label, sort: c.sort, active: c.active })

async function publish(tx: Tx, locationId: string, key: string): Promise<void> {
  await realtime.publish(tx, {
    locationId,
    channel: 'settings',
    type: 'settings.changed',
    payload: { section: 'catalog', key: 'vehicle_classes', vehicleClass: key },
  })
}

async function nextSort(tx: Tx, locationId: string): Promise<number> {
  const r = await tx
    .selectFrom('vehicle_classes')
    .select((eb) => eb.fn.max('sort').as('max'))
    .where('location_id', '=', locationId)
    .executeTakeFirst()
  return Math.min(100_000, (r?.max ?? 0) + 10)
}

/** Labels are unique per location, case-insensitively (two sizes called "Truck" would make the grid ambiguous). */
async function checkLabelFree(tx: Tx, locationId: string, label: string, except?: string): Promise<void> {
  const rows = await tx.selectFrom('vehicle_classes').select(['key', 'label']).where('location_id', '=', locationId).execute()
  if (rows.some((r) => r.key !== except && r.label.trim().toLowerCase() === label.trim().toLowerCase()))
    throw invalid('label', 'Another size already has that name.')
}

export async function createVehicleClass(
  tx: Tx,
  input: { locationId: string; key: string; label: string; sort?: number; active?: boolean; audit?: audit.AuditContext },
): Promise<VehicleClass> {
  if (!CLASS_KEY.test(input.key))
    throw invalid('key', 'Use a lowercase key: a letter, then letters, digits or underscores (up to 32).')
  checkInput(input)
  const count = await tx
    .selectFrom('vehicle_classes')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('location_id', '=', input.locationId)
    .executeTakeFirstOrThrow()
  if (Number(count.n) >= MAX_VEHICLE_CLASSES) throw new AppError('CLASS_LIMIT', { meta: { max: MAX_VEHICLE_CLASSES } })
  await checkLabelFree(tx, input.locationId, input.label)
  const inserted = await tx
    .insertInto('vehicle_classes')
    .values({
      location_id: input.locationId,
      key: input.key,
      label: input.label.trim(),
      sort: input.sort ?? (await nextSort(tx, input.locationId)),
      active: input.active ?? true,
    })
    .onConflict((oc) => oc.columns(['location_id', 'key']).doNothing())
    .returning([...COLUMNS])
    .executeTakeFirst()
  if (!inserted) throw new AppError('CLASS_KEY_TAKEN', { meta: { key: input.key } })
  const c = toClass(inserted)
  await audit.record(tx, {
    locationId: input.locationId,
    action: 'catalog.vehicle_class.create',
    entityType: 'vehicle_class',
    entityId: c.key,
    after: auditOf(c),
    ctx: input.audit,
  })
  await publish(tx, input.locationId, c.key)
  return c
}

async function lockClass(tx: Tx, locationId: string, key: string, expectedVersion?: number): Promise<VehicleClass> {
  const r = CLASS_KEY.test(key)
    ? await tx
        .selectFrom('vehicle_classes')
        .select([...COLUMNS])
        .where('location_id', '=', locationId)
        .where('key', '=', key)
        .forUpdate()
        .executeTakeFirst()
    : undefined
  if (!r) throw new AppError('NOT_FOUND', { detail: 'That vehicle size does not exist' })
  if (expectedVersion !== undefined && expectedVersion !== r.version)
    throw new AppError('VERSION_CONFLICT', { meta: { currentVersion: r.version } })
  return toClass(r)
}

/** Label, order and active in one version-checked update; the key never changes. The last active size cannot be turned off. */
export async function updateVehicleClass(
  tx: Tx,
  input: { locationId: string; key: string; patch: VehicleClassInput; expectedVersion?: number; audit?: audit.AuditContext },
): Promise<{ vehicleClass: VehicleClass; changed: boolean }> {
  const before = await lockClass(tx, input.locationId, input.key, input.expectedVersion)
  const p = input.patch
  checkInput(p)
  const next = {
    label: p.label === undefined ? before.label : p.label.trim(),
    sort: p.sort ?? before.sort,
    active: p.active ?? before.active,
  }
  if (next.label === before.label && next.sort === before.sort && next.active === before.active)
    return { vehicleClass: before, changed: false }
  if (next.label !== before.label) await checkLabelFree(tx, input.locationId, next.label, before.key)
  if (before.active && !next.active) {
    const others = await tx
      .selectFrom('vehicle_classes')
      .select('key')
      .where('location_id', '=', input.locationId)
      .where('active', '=', true)
      .where('key', '<>', before.key)
      .limit(1)
      .executeTakeFirst()
    if (!others) throw invalid('active', 'Keep at least one vehicle size on.')
  }
  const row = await tx
    .updateTable('vehicle_classes')
    .set((eb) => ({ ...next, version: eb('version', '+', 1), updated_at: eb.fn('app_now', []) }))
    .where('location_id', '=', input.locationId)
    .where('key', '=', input.key)
    .returning([...COLUMNS])
    .executeTakeFirstOrThrow()
  const after = toClass(row)
  await audit.record(tx, {
    locationId: input.locationId,
    action: 'catalog.vehicle_class.update',
    entityType: 'vehicle_class',
    entityId: after.key,
    before: auditOf(before),
    after: auditOf(after),
    ctx: input.audit,
  })
  await publish(tx, input.locationId, after.key)
  return { vehicleClass: after, changed: true }
}

/** What still uses a size: price cells, tier prices (current or past), memberships, vehicles and visits. */
export async function vehicleClassUses(db: Executor, locationId: string, key: string): Promise<Record<string, number>> {
  const n = async (q: Promise<{ n: string | number | bigint } | undefined>): Promise<number> => Number((await q)?.n ?? 0)
  const [prices, tierPrices, memberships, appointments, vehicles] = await Promise.all([
    n(
      db
        .selectFrom('service_class_prices')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('location_id', '=', locationId)
        .where('class_key', '=', key)
        .executeTakeFirst(),
    ),
    n(
      db
        .selectFrom('membership_tier_prices')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('location_id', '=', locationId)
        .where('class_key', '=', key)
        .executeTakeFirst(),
    ),
    n(
      db
        .selectFrom('memberships')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('location_id', '=', locationId)
        .where('plan_class', '=', key)
        .executeTakeFirst(),
    ),
    n(
      db
        .selectFrom('appointments')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('location_id', '=', locationId)
        .where('vehicle_class', '=', key)
        .executeTakeFirst(),
    ),
    n(
      db
        // vehicles carry no location (one shop): any vehicle on file with this size
        .selectFrom('vehicles')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('vehicle_class', '=', key)
        .where('deleted_at', 'is', null)
        .executeTakeFirst(),
    ),
  ])
  return { prices, tierPrices, memberships, appointments, vehicles }
}

/** Deletes a size nothing uses (409 CLASS_IN_USE otherwise: turn it off instead) and never the last one. */
export async function deleteVehicleClass(
  tx: Tx,
  input: { locationId: string; key: string; expectedVersion?: number; audit?: audit.AuditContext },
): Promise<VehicleClass> {
  const c = await lockClass(tx, input.locationId, input.key, input.expectedVersion)
  const uses = await vehicleClassUses(tx, input.locationId, c.key)
  const used = Object.fromEntries(Object.entries(uses).filter(([, v]) => v > 0))
  if (Object.keys(used).length > 0) throw new AppError('CLASS_IN_USE', { meta: { key: c.key, ...used } })
  const others = await tx
    .selectFrom('vehicle_classes')
    .select('key')
    .where('location_id', '=', input.locationId)
    .where('active', '=', true)
    .where('key', '<>', c.key)
    .limit(1)
    .executeTakeFirst()
  if (!others) throw invalid('key', 'Keep at least one vehicle size on.')
  await tx.deleteFrom('vehicle_classes').where('location_id', '=', input.locationId).where('key', '=', c.key).execute()
  await audit.record(tx, {
    locationId: input.locationId,
    action: 'catalog.vehicle_class.delete',
    entityType: 'vehicle_class',
    entityId: c.key,
    before: auditOf(c),
    ctx: input.audit,
  })
  await publish(tx, input.locationId, c.key)
  return c
}
