// Settings → Prices by size (ADR 0170): the grid of services × vehicle sizes. One save sends the rows the admin changed, each with
// the version of its service (the token shared with the service's checklist and website edits); the save is all or nothing: a stale
// row refuses the whole save with 412 naming that row, and nothing is written. A cell is a regular price in cents (0 to $100,000)
// with an optional "up to" price for a range (tint); null clears it ("not set": priced at the starting price, confirm at the shop).
// Sizes a row does not list keep their cells. Every changed row bumps the service's version, keeps services.price_cents equal to its
// new starting price (what a booking charged before sizes, and the base the old public catalog reads), is audited
// (catalog.price.update) and publishes settings.changed.
import type { Tx } from '../../platform/db.js'
import * as audit from '../../platform/audit.js'
import { AppError } from '../../platform/errors.js'
import * as realtime from '../../platform/realtime.js'
import { isUuid } from '../../platform/ids.js'
import { publishServiceChange } from './service.js'
import './schema.js'

export const MAX_PRICE_CENTS = 10_000_000

export interface PriceCellInput {
  class: string
  cents: number | null
  maxCents: number | null
}

export interface PriceRowInput {
  serviceId: string
  version: number
  cells: PriceCellInput[]
}

export interface SavedCell {
  class: string
  cents: number
  maxCents: number | null
}

export interface SavedRow {
  serviceId: string
  version: number
  /** The service's cells after the save, in size order. */
  cells: SavedCell[]
  changed: boolean
}

const invalid = (path: string, message: string): AppError =>
  new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path, message }] })

const centsOk = (v: number): boolean => Number.isSafeInteger(v) && v >= 0 && v <= MAX_PRICE_CENTS

/** Checks the shape of every row before anything is read (422 with the body path of the first broken rule). */
export function checkPriceRows(rows: readonly PriceRowInput[], classKeys: ReadonlySet<string>): void {
  if (rows.length === 0) throw invalid('rows', 'Send at least one row.')
  const seen = new Set<string>()
  rows.forEach((r, i) => {
    if (!isUuid(r.serviceId)) throw invalid(`rows.${i}.serviceId`, 'Pick a package or add-on of the catalog.')
    if (seen.has(r.serviceId)) throw invalid(`rows.${i}.serviceId`, 'This service is listed twice.')
    seen.add(r.serviceId)
    const classes = new Set<string>()
    r.cells.forEach((c, j) => {
      const at = `rows.${i}.cells.${j}`
      if (!classKeys.has(c.class)) throw invalid(`${at}.class`, 'Pick one of the shop’s vehicle sizes.')
      if (classes.has(c.class)) throw invalid(`${at}.class`, 'This size is listed twice in the row.')
      classes.add(c.class)
      if (c.cents === null) {
        if (c.maxCents !== null) throw invalid(`${at}.maxCents`, 'Set the price before the “up to” price.')
        return
      }
      if (!centsOk(c.cents)) throw invalid(`${at}.cents`, 'Enter a price in whole cents, from 0 to $100,000.')
      if (c.maxCents !== null && (!centsOk(c.maxCents) || c.maxCents < c.cents))
        throw invalid(`${at}.maxCents`, 'The “up to” price cannot be below the price.')
    })
  })
}

const cellsAudit = (cells: readonly SavedCell[]) =>
  Object.fromEntries(cells.map((c) => [c.class, c.maxCents === null ? c.cents : [c.cents, c.maxCents]]))

/** The starting price over the active sizes; null when the service has no price on an active size. */
export async function startingPrice(tx: Tx, locationId: string, serviceId: string): Promise<number | null> {
  const r = await tx
    .selectFrom('service_class_prices as p')
    .innerJoin('vehicle_classes as c', (j) => j.onRef('c.location_id', '=', 'p.location_id').onRef('c.key', '=', 'p.class_key'))
    .select((eb) => eb.fn.min<number>('p.price_cents').as('low'))
    .where('p.service_id', '=', serviceId)
    .where('p.location_id', '=', locationId)
    .where('c.active', '=', true)
    .executeTakeFirst()
  return r?.low ?? null
}

async function cellsOf(tx: Tx, locationId: string, serviceId: string): Promise<SavedCell[]> {
  const rows = await tx
    .selectFrom('service_class_prices as p')
    .innerJoin('vehicle_classes as c', (j) => j.onRef('c.location_id', '=', 'p.location_id').onRef('c.key', '=', 'p.class_key'))
    .select(['p.class_key', 'p.price_cents', 'p.max_cents'])
    .where('p.service_id', '=', serviceId)
    .where('p.location_id', '=', locationId)
    .orderBy('c.sort')
    .orderBy('c.key')
    .execute()
  return rows.map((r) => ({ class: r.class_key, cents: r.price_cents, maxCents: r.max_cents }))
}

/** Saves the grid rows: all or nothing (412 VERSION_CONFLICT naming the first stale row; 404 for a service of another location). */
export async function putClassPrices(
  tx: Tx,
  input: { locationId: string; rows: PriceRowInput[]; userId: string | null; audit?: audit.AuditContext },
): Promise<SavedRow[]> {
  const classes = await tx.selectFrom('vehicle_classes').select('key').where('location_id', '=', input.locationId).execute()
  checkPriceRows(input.rows, new Set(classes.map((c) => c.key)))
  // lock every row first, in id order (two saves of overlapping rows never deadlock), and check every version before writing
  const ids = [...input.rows.map((r) => r.serviceId)].sort()
  const locked = await tx
    .selectFrom('services')
    .select(['id', 'version', 'price_cents', 'quote_only'])
    .where('location_id', '=', input.locationId)
    .where('id', 'in', ids)
    .orderBy('id')
    .forUpdate()
    .execute()
  input.rows.forEach((r, i) => {
    const s = locked.find((x) => x.id === r.serviceId)
    if (!s)
      throw new AppError('NOT_FOUND', { detail: 'That package or add-on does not exist', meta: { row: i, serviceId: r.serviceId } })
    if (s.version !== r.version)
      throw new AppError('VERSION_CONFLICT', { meta: { row: i, serviceId: r.serviceId, currentVersion: s.version } })
  })
  const out: SavedRow[] = []
  for (const r of input.rows) {
    const s = locked.find((x) => x.id === r.serviceId)!
    const before = await cellsOf(tx, input.locationId, r.serviceId)
    let changed = false
    for (const c of r.cells) {
      const cur = before.find((b) => b.class === c.class)
      if (c.cents === null) {
        if (!cur) continue
        await tx.deleteFrom('service_class_prices').where('service_id', '=', r.serviceId).where('class_key', '=', c.class).execute()
        changed = true
        continue
      }
      if (cur && cur.cents === c.cents && cur.maxCents === c.maxCents) continue
      await tx
        .insertInto('service_class_prices')
        .values({
          service_id: r.serviceId,
          location_id: input.locationId,
          class_key: c.class,
          price_cents: c.cents,
          max_cents: c.maxCents,
          updated_by: input.userId,
        })
        .onConflict((oc) =>
          oc.columns(['service_id', 'class_key']).doUpdateSet((eb) => ({
            price_cents: c.cents!,
            max_cents: c.maxCents,
            updated_by: input.userId,
            updated_at: eb.fn('app_now', []),
          })),
        )
        .execute()
      changed = true
    }
    if (!changed) {
      out.push({ serviceId: r.serviceId, version: s.version, cells: before, changed: false })
      continue
    }
    const after = await cellsOf(tx, input.locationId, r.serviceId)
    const start = s.quote_only ? null : await startingPrice(tx, input.locationId, r.serviceId)
    const price = start ?? s.price_cents
    const row = await tx
      .updateTable('services')
      .set((eb) => ({ price_cents: price, version: eb('version', '+', 1), updated_at: eb.fn('app_now', []) }))
      .where('id', '=', r.serviceId)
      .returning('version')
      .executeTakeFirstOrThrow()
    await audit.record(tx, {
      locationId: input.locationId,
      action: 'catalog.price.update',
      entityType: 'service',
      entityId: r.serviceId,
      before: { cells: cellsAudit(before), ...(price !== s.price_cents ? { priceCents: s.price_cents } : {}) },
      after: { cells: cellsAudit(after), ...(price !== s.price_cents ? { priceCents: price } : {}) },
      ctx: input.audit,
    })
    await publishServiceChange(tx, input.locationId, r.serviceId)
    out.push({ serviceId: r.serviceId, version: row.version, cells: after, changed: true })
  }
  if (out.some((r) => r.changed))
    await realtime.publish(tx, {
      locationId: input.locationId,
      channel: 'settings',
      type: 'settings.changed',
      payload: { section: 'catalog', key: 'prices', services: out.filter((r) => r.changed).map((r) => r.serviceId) },
    })
  return out
}
