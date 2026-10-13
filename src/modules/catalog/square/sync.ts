// The Square item library sync (ADR 0172 section 3) with its database: one function, three triggers:
//   - the job square.items.sync, every 5 minutes (2-59/5, offset from square.catalog.sync: both write Square's catalog): a cheap
//     read-back of what changed at Square since the watermark (SearchCatalogObjects begin_time, deleted objects included, only linked
//     ids, versions Oasis wrote itself ignored), then what the library needs;
//   - the nightly job square.items.drift (04:40): everything linked read back (BatchRetrieve) and every item searched for Oasis's
//     marker (a crash or a restore never makes a second item);
//   - POST /integrations/square/items/sync ("Sync now"; while the sync is not on, a read-only preview).
// Skipped unless SQUARE_WRITES_ENABLED and SQUARE_ITEMS_SYNC_ENABLED; the preview (dryRun) only reads, so it works watch-only.
// The tax check runs first every time and a mismatch blocks the run (nothing is written; the managers are told once). The fast path:
// the library's fingerprint equal to the last complete sync's, nothing open and nothing changed at Square: no write at all. The
// Square calls run outside any transaction (engine.ts); each answer is recorded at once. Failures are told to the managers once per
// set (again a day later while they last), Square-side edits put back once per set; each run that did something is audited.
import { createHash } from 'node:crypto'
import { sql } from 'kysely'
import type { Env } from '../../../config/env.js'
import type { SquareApi } from '../../../integrations/ports/square.js'
import { squareItemsOn, squareLocationId } from '../../../integrations/square/config.js'
import { sqKey } from '../../../integrations/square/keys.js'
import type { WireCatalogObject } from '../../../integrations/square/wire.js'
import * as audit from '../../../platform/audit.js'
import type { Clock } from '../../../platform/clock.js'
import { transaction, type Db, type Executor } from '../../../platform/db.js'
import type { NewId } from '../../../platform/ids.js'
import { getSetting } from '../../../platform/settings.js'
import { notifyManagers } from '../../messaging/notify.js'
import type { SquareLogger } from '../../square/ingest.js'
import { squareEnvironment } from '../../square/db/state.js'
import { loadPriceBook } from '../price-book.js'
import { desiredLibrary, libraryFingerprint, parseMarker, type DesiredLibrary, type LibraryInput } from './desired.js'
import { failureText, runEngine, type EngineResult, type LinkStore } from './engine.js'
import { planItems, planSetup, previewCounts, refsFor, type LinkRow, type PreviewCounts, type RemoteView } from './plan.js'
import type { ItemsTaxMode, SquareEnvironmentName } from './schema.js'
import type { ConnectionCheck } from '../../square/connection.js'
import { checkItemsTax, roundingCheck, type TaxCheck } from './tax.js'
import './schema.js'
import '../schema.js'

export interface ItemSyncDeps {
  db: Db
  clock: Clock
  newId: NewId
  env: Pick<Env, 'SQUARE_WRITES_ENABLED' | 'SQUARE_ITEMS_SYNC_ENABLED' | 'SQUARE_PROVIDER' | 'SQUARE_ENVIRONMENT' | 'SQUARE_LOCATION_ID'>
  api: SquareApi
  logger?: SquareLogger
}

/** on: the sync writes; preview: watch-only (SQUARE_WRITES_ENABLED=false): read-only preview; off: writes on, item sync switched off. */
export type ItemsMode = 'on' | 'preview' | 'off'
export const itemsMode = (env: ItemSyncDeps['env']): ItemsMode => (squareItemsOn(env) ? 'on' : env.SQUARE_WRITES_ENABLED ? 'off' : 'preview')

export interface ItemsPreview extends PreviewCounts {
  categories: number
  tax: 'create' | 'update' | 'adopt' | 'none' | 'blocked'
  at: string
}

export interface ItemSyncReport {
  status: 'skipped' | 'preview' | 'blocked' | 'done'
  reason?: string
  mode: ItemsMode
  tax: TaxCheck | null
  created: number
  updated: number
  archived: number
  recreated: number
  adopted: number
  restored: number
  failed: number
  categoriesCreated: number
  taxCreated: number
  taxUpdated: number
  preview?: ItemsPreview
  failures: string[]
  changedInSquare: string[]
  reported: string[]
}

const report = (status: ItemSyncReport['status'], mode: ItemsMode, o: Partial<ItemSyncReport> = {}): ItemSyncReport => ({
  status,
  mode,
  tax: null,
  created: 0,
  updated: 0,
  archived: 0,
  recreated: 0,
  adopted: 0,
  restored: 0,
  failed: 0,
  categoriesCreated: 0,
  taxCreated: 0,
  taxUpdated: 0,
  failures: [],
  changedInSquare: [],
  reported: [],
  ...o,
})

// ---- the library and the links ----------------------------------------------------------------------------------------------

/** Everything the desired library is made of: every size, every service (retired ones too), the categories, the price book. */
export async function loadLibraryInput(db: Executor, locationId: string): Promise<LibraryInput> {
  const [classes, services, categories, book] = await Promise.all([
    db.selectFrom('vehicle_classes').select(['key', 'label', 'sort', 'active']).where('location_id', '=', locationId).execute(),
    db
      .selectFrom('services')
      .select(['id', 'kind', 'name', 'public_name', 'sort', 'category', 'active', 'quote_only', 'price_cents'])
      .where('location_id', '=', locationId)
      .execute(),
    db.selectFrom('catalog_categories').select(['key', 'label', 'sort']).where('location_id', '=', locationId).execute(),
    loadPriceBook(db, locationId),
  ])
  return {
    classes,
    services: services.map((s) => ({
      id: s.id,
      kind: s.kind,
      name: s.name,
      publicName: s.public_name,
      sort: s.sort,
      category: s.category,
      active: s.active,
      quoteOnly: s.quote_only,
      priceCents: s.price_cents,
    })),
    categories,
    book,
  }
}

const num = (v: string | number | null): number | null => (v === null ? null : Number(v))

export async function loadLinks(db: Executor, locationId: string, environment: SquareEnvironmentName): Promise<LinkRow[]> {
  const rows = await db
    .selectFrom('square_catalog_links')
    .selectAll()
    .where('location_id', '=', locationId)
    .where('environment', '=', environment)
    .orderBy('created_at')
    .orderBy('id')
    .execute()
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    serviceId: r.service_id,
    classKey: r.class_key,
    categoryKey: r.category_key,
    objectId: r.square_object_id,
    itemId: r.square_item_id,
    version: num(r.square_version),
    desiredHash: r.desired_hash,
    contentHash: r.content_hash,
    state: r.state,
    adopted: r.adopted,
    error: r.error,
    pendingKey: r.pending_key,
    pendingBody: r.pending_body ? (JSON.parse(r.pending_body) as Record<string, unknown>) : null,
    pendingAt: r.pending_at,
  }))
}

/** The links in the database: each write is its own statement (never held across a Square call). */
export function dbLinkStore(db: Db, locationId: string, environment: SquareEnvironmentName, clock: Clock, rows: LinkRow[]): LinkStore {
  let current = rows
  return {
    all: () => current,
    put: async (row) => {
      const now = clock.now()
      const values = {
        kind: row.kind,
        service_id: row.serviceId,
        class_key: row.classKey,
        category_key: row.categoryKey,
        square_object_id: row.objectId,
        square_item_id: row.itemId,
        square_version: row.version,
        desired_hash: row.desiredHash,
        content_hash: row.contentHash,
        state: row.state,
        adopted: row.adopted,
        error: row.error ? row.error.slice(0, 300) : null,
        pending_key: row.pendingKey,
        pending_body: row.pendingBody ? JSON.stringify(row.pendingBody) : null,
        pending_at: row.pendingAt,
        ...(row.state === 'synced' || row.state === 'archived' || row.state === 'hidden' ? { synced_at: now } : {}),
        checked_at: now,
        updated_at: now,
      }
      await db
        .insertInto('square_catalog_links')
        .values({ id: row.id, location_id: locationId, environment, created_at: now, ...values })
        .onConflict((oc) => oc.column('id').doUpdateSet(values))
        .execute()
      const i = current.findIndex((x) => x.id === row.id)
      current = i >= 0 ? current.map((x, j) => (j === i ? { ...row } : x)) : [...current, { ...row }]
    },
    remove: async (id) => {
      await db.deleteFrom('square_catalog_links').where('id', '=', id).execute()
      current = current.filter((x) => x.id !== id)
    },
  }
}

// ---- the state row ------------------------------------------------------------------------------------------------------------

export type ItemsStateRow = NonNullable<Awaited<ReturnType<typeof getItemsState>>>

export async function getItemsState(db: Executor, locationId: string, environment: SquareEnvironmentName) {
  return db.selectFrom('square_items_state').selectAll().where('location_id', '=', locationId).where('environment', '=', environment).executeTakeFirst()
}

type StatePatch = Partial<{
  tax_mode: ItemsTaxMode
  tax_object_id: string | null
  tax_check: unknown
  tax_checked_at: Date
  fingerprint: string | null
  watermark: Date | null
  last_write_at: Date
  last_sync_at: Date
  last_sync: unknown
  last_drift_at: Date
  last_drift: unknown
  last_preview: unknown
  last_preview_at: Date
  last_error: string | null
  last_error_at: Date | null
}>

const JSON_KEYS = new Set(['tax_check', 'last_sync', 'last_drift', 'last_preview'])

export async function saveItemsState(db: Executor, locationId: string, environment: SquareEnvironmentName, now: Date, patch: StatePatch, o: { bumpVersion?: boolean } = {}): Promise<void> {
  const values = Object.fromEntries(
    Object.entries(patch).map(([k, v]) => [k, JSON_KEYS.has(k) ? (v === null || v === undefined ? null : JSON.stringify(v)) : k === 'last_error' && typeof v === 'string' ? v.slice(0, 300) : v]),
  )
  await db
    .insertInto('square_items_state')
    .values({ location_id: locationId, environment, created_at: now, updated_at: now, ...values } as never)
    .onConflict((oc) =>
      oc.columns(['location_id', 'environment']).doUpdateSet({
        ...values,
        updated_at: now,
        ...(o.bumpVersion ? { version: sql`square_items_state.version + 1` } : {}),
      } as never),
    )
    .execute()
}

// ---- reading Square back ------------------------------------------------------------------------------------------------------

async function searchAll(api: SquareApi, q: Parameters<SquareApi['catalog']['search']>[0], max = 100): Promise<WireCatalogObject[]> {
  const all: WireCatalogObject[] = []
  let cursor: string | undefined
  for (let i = 0; i < max; i++) {
    const page = await api.catalog.search({ ...q, cursor })
    all.push(...page.items)
    cursor = page.cursor
    if (!cursor) break
  }
  return all
}

/**
 * What changed at Square since the watermark, among the linked objects; Oasis's own writes (the version Oasis recorded) are left
 * out. A changed variation brings its item (BatchRetrieve). Undefined when nothing changed.
 */
export async function readChanges(api: SquareApi, links: readonly LinkRow[], since: Date): Promise<RemoteView | undefined> {
  const byId = new Map(links.filter((l) => l.objectId).map((l) => [l.objectId!, l]))
  const changed = await searchAll(api, { object_types: ['ITEM', 'ITEM_VARIATION', 'CATEGORY'], begin_time: since.toISOString(), include_deleted_objects: true })
  const items = new Map<string, WireCatalogObject>()
  const categories = new Map<string, WireCatalogObject>()
  const gone = new Set<string>()
  const fetch = new Set<string>()
  for (const o of changed) {
    const l = byId.get(o.id)
    if (!l) continue
    if (!o.is_deleted && o.version !== undefined && o.version !== null && o.version === l.version) continue
    if (o.type === 'ITEM') {
      if (o.is_deleted) gone.add(o.id)
      else items.set(o.id, o)
    } else if (o.type === 'ITEM_VARIATION' && l.itemId) fetch.add(l.itemId)
    else if (o.type === 'CATEGORY') {
      if (o.is_deleted) gone.add(o.id)
      else categories.set(o.id, o)
    }
  }
  const missing = [...fetch].filter((id) => !items.has(id) && !gone.has(id))
  if (missing.length) {
    const got = (await api.catalog.batchRetrieve(missing, { include_deleted_objects: true })).objects
    for (const id of missing) {
      const o = got.find((x) => x.id === id)
      if (!o || o.is_deleted) gone.add(id)
      else items.set(id, o)
    }
  }
  return items.size || categories.size || gone.size ? { items, categories, gone } : undefined
}

/** Everything linked read back, and every item carrying an Oasis marker (the nightly drift run). */
export async function readAll(api: SquareApi, links: readonly LinkRow[]): Promise<RemoteView> {
  const ids = links.filter((l) => l.objectId && (l.kind === 'item' || l.kind === 'category')).map((l) => l.objectId!)
  const got = ids.length ? (await api.catalog.batchRetrieve(ids, { include_deleted_objects: true })).objects : []
  const byId = new Map(got.map((o) => [o.id, o]))
  const items = new Map(got.filter((o) => o.type === 'ITEM' && !o.is_deleted).map((o) => [o.id, o]))
  const categories = new Map(got.filter((o) => o.type === 'CATEGORY' && !o.is_deleted).map((o) => [o.id, o]))
  const gone = new Set(ids.filter((id) => !byId.has(id) || byId.get(id)!.is_deleted))
  return { items, categories, gone, marked: await markedItems(api) }
}

/** Every Square item carrying an Oasis marker on a variation (what a crash or a restore may have left without a link). */
export async function markedItems(api: SquareApi): Promise<WireCatalogObject[]> {
  return (await searchAll(api, { object_types: ['ITEM'], include_deleted_objects: false })).filter((o) =>
    (o.item_data?.variations ?? []).some((v) => parseMarker(v.item_variation_data?.user_data)),
  )
}

// ---- the run ------------------------------------------------------------------------------------------------------------------

/** The same failures (or Square-side edits, or tax mismatch) are told to the managers again after this long. */
export const ITEMS_NOTICE_REMINDER_MS = 24 * 60 * 60_000
/** A create left in the outbox longer than this is looked for by its marker before it is sent again. */
const OUTBOX_STALE_MS = 12 * 60 * 60_000
/** The watermark trails each run by this much (an edit made while a run reads is seen by the next one). */
const WATERMARK_SKEW_MS = 2 * 60_000

async function tellOnce(deps: ItemSyncDeps, locationId: string, kind: string, title: string, body: string, details: readonly string[], o: { remind: boolean }): Promise<boolean> {
  const sourceRef = `${kind}:${createHash('sha256').update([...details].sort().join('\n')).digest('hex').slice(0, 32)}`
  return transaction(deps.db, async (tx) => {
    let told = tx.selectFrom('notifications').select('id').where('location_id', '=', locationId).where('source_ref', '=', sourceRef)
    if (o.remind) told = told.where('created_at', '>', new Date(deps.clock.now().getTime() - ITEMS_NOTICE_REMINDER_MS))
    if (await told.limit(1).executeTakeFirst()) return false
    await notifyManagers(tx, { locationId, kind, title, body, entityType: 'integration', entityId: 'square', sourceRef }, { newId: deps.newId, clock: deps.clock })
    return true
  })
}

const list = (xs: readonly string[], n = 5): string => `${xs.slice(0, n).join('; ')}${xs.length > n ? ` (and ${xs.length - n} more)` : ''}`

/** The tax check of this location as the sync runs it (also Test connection and the preview). */
export async function itemsTaxCheck(db: Executor, api: SquareApi, locationId: string, env: ItemSyncDeps['env'], links?: readonly LinkRow[]): Promise<TaxCheck> {
  const environment = squareEnvironment(env)
  const [state, rate, rounding, rows] = await Promise.all([
    getItemsState(db, locationId, environment),
    getSetting(db, locationId, 'tax.rate_dbp'),
    getSetting(db, locationId, 'tax.rounding'),
    links ? Promise.resolve(links) : loadLinks(db, locationId, environment),
  ])
  const own = rows.find((l) => l.kind === 'tax' && !l.adopted)
  return checkItemsTax(api, {
    locationId: squareLocationId(env as Env) ?? '',
    rateDbp: rate.value,
    rounding: rounding.value,
    mode: state?.tax_mode ?? 'auto',
    chosenTaxId: state?.tax_mode === 'adopt' ? (state.tax_object_id ?? null) : null,
    ownTaxId: own?.objectId ?? null,
  })
}

function previewOf(lib: DesiredLibrary, links: readonly LinkRow[], tax: TaxCheck, locationId: string, now: Date): ItemsPreview {
  const setup = tax.status === 'blocked' || tax.status === 'error' ? [] : planSetup(lib, links, tax)
  const items = planItems(lib, { locationId, links })
  const taxAction = setup.find((a) => a.kind === 'create_tax' || a.kind === 'update_tax' || a.kind === 'adopt_tax')
  return {
    ...previewCounts(lib, items),
    categories: setup.filter((a) => a.kind === 'create_category').length,
    tax:
      tax.status === 'blocked' || tax.status === 'error'
        ? 'blocked'
        : taxAction?.kind === 'create_tax'
          ? 'create'
          : taxAction?.kind === 'update_tax'
            ? 'update'
            : taxAction?.kind === 'adopt_tax'
              ? 'adopt'
              : 'none',
    at: now.toISOString(),
  }
}

/**
 * Syncs one location's services to Square's item library (see the header). `drift` reads everything back; `dryRun` only reads and
 * plans (the preview: allowed watch-only). `actor` names who pressed Sync now (audited even when nothing changed).
 */
export async function runItemSync(
  deps: ItemSyncDeps,
  locationId: string,
  o: { drift?: boolean; dryRun?: boolean; actor?: audit.AuditContext } = {},
): Promise<ItemSyncReport> {
  const mode = itemsMode(deps.env)
  const environment = squareEnvironment(deps.env)
  const squareLocation = squareLocationId(deps.env as Env)
  if (!squareLocation) return report('skipped', mode, { reason: 'SQUARE_LOCATION_ID is not set' })
  const dryRun = o.dryRun === true || mode !== 'on'
  if (mode !== 'on' && !o.dryRun)
    return report('skipped', mode, {
      reason: !deps.env.SQUARE_WRITES_ENABLED ? 'Square writes are off (SQUARE_WRITES_ENABLED=false)' : 'The item sync is off (SQUARE_ITEMS_SYNC_ENABLED=false)',
    })
  const started = deps.clock.now()
  const [input, links, state] = await Promise.all([
    loadLibraryInput(deps.db, locationId),
    loadLinks(deps.db, locationId, environment),
    getItemsState(deps.db, locationId, environment),
  ])
  const lib = desiredLibrary(input)
  const tax = await itemsTaxCheck(deps.db, deps.api, locationId, deps.env, links)
  await saveItemsState(deps.db, locationId, environment, started, { tax_check: tax, tax_checked_at: started })
  if (dryRun) {
    const preview = previewOf(lib, links, tax, squareLocation, started)
    await saveItemsState(deps.db, locationId, environment, started, { last_preview: preview, last_preview_at: started })
    return report('preview', mode, { tax, preview, ...(tax.status === 'blocked' || tax.status === 'error' ? { reason: tax.detail } : {}) })
  }
  const fingerprintOf = (rows: readonly LinkRow[], t: TaxCheck = tax) =>
    libraryFingerprint(lib, (item) => refsFor(item, rows), { taxId: t.taxId, percentage: t.percentage, want: t.wantPercentage, location: squareLocation })
  const open = links.some((l) => l.state === 'pending' || l.state === 'failed' || l.pendingKey)
  // the remote view: everything (nightly), what changed since the watermark (every run), nothing before the first run
  let remote: RemoteView | undefined
  try {
    if (o.drift) remote = await readAll(deps.api, links)
    else if (state?.watermark) remote = await readChanges(deps.api, links, state.watermark)
    // before Oasis makes an item, it looks for one it made already (a crash, a restore of the database, an outbox Square forgot):
    // an item carrying the marker is adopted, never made twice
    const stale = links.some((l) => l.pendingKey && l.pendingAt && started.getTime() - l.pendingAt.getTime() > OUTBOX_STALE_MS)
    const creates = planItems(lib, { locationId: squareLocation, links, remote }).some((a) => a.kind === 'create_item')
    if ((stale || creates) && !remote?.marked) remote = { ...(remote ?? { items: new Map(), categories: new Map(), gone: new Set() }), marked: await markedItems(deps.api) }
  } catch (e) {
    const text = failureText(e)
    await saveItemsState(deps.db, locationId, environment, started, { last_error: `read-back: ${text}`, last_error_at: started })
    return report('done', mode, { tax, failed: 1, failures: [`Reading Square back: ${text}`] })
  }
  if (tax.status === 'ok' && !o.drift && !open && !remote && state?.fingerprint === fingerprintOf(links)) {
    await saveItemsState(deps.db, locationId, environment, started, { watermark: new Date(started.getTime() - WATERMARK_SKEW_MS), last_sync_at: started })
    return report('done', mode, { tax })
  }
  const store = dbLinkStore(deps.db, locationId, environment, deps.clock, links)
  const res: EngineResult = await runEngine({
    api: deps.api,
    environment,
    locationId: squareLocation,
    lib,
    tax,
    store,
    newId: deps.newId,
    now: started,
    remote,
  })
  const out = report(res.status === 'blocked' ? 'blocked' : 'done', mode, {
    tax,
    ...(res.blocked ? { reason: res.blocked } : {}),
    created: res.created,
    updated: res.updated,
    archived: res.archived,
    recreated: res.recreated,
    adopted: res.adopted,
    restored: res.restored,
    failed: res.failed,
    categoriesCreated: res.categoriesCreated + res.categoriesAdopted,
    taxCreated: res.taxCreated,
    taxUpdated: res.taxUpdated,
    failures: res.failures,
    changedInSquare: res.changedInSquare,
    reported: res.reported,
  })
  const summary = {
    status: out.status,
    created: out.created,
    updated: out.updated,
    archived: out.archived,
    recreated: out.recreated,
    adopted: out.adopted,
    restored: out.restored,
    failed: out.failed,
    categories: out.categoriesCreated,
    tax: out.taxCreated ? 'created' : out.taxUpdated ? 'updated' : 'unchanged',
    writes: res.writes,
    at: started.toISOString(),
  }
  // the tax was made or changed in this run: the stored check says so (Settings shows it)
  const taxNow = res.taxCreated || res.taxUpdated ? await itemsTaxCheck(deps.db, deps.api, locationId, deps.env, store.all()) : tax
  if (taxNow !== tax) out.tax = taxNow
  const complete = res.status === 'done' && res.failed === 0
  await saveItemsState(deps.db, locationId, environment, started, {
    ...(taxNow !== tax ? { tax_check: taxNow, tax_checked_at: deps.clock.now() } : {}),
    fingerprint: complete ? fingerprintOf(store.all(), taxNow) : null,
    watermark: new Date(started.getTime() - WATERMARK_SKEW_MS),
    last_sync_at: started,
    last_sync: summary,
    ...(o.drift ? { last_drift_at: started, last_drift: { ...summary, changedInSquare: res.changedInSquare.length, reported: res.reported } } : {}),
    ...(res.writes > 0 ? { last_write_at: deps.clock.now() } : {}),
    ...(res.blocked
      ? { last_error: res.blocked, last_error_at: started }
      : res.failures.length
        ? { last_error: res.failures[0]!, last_error_at: started }
        : { last_error: null, last_error_at: null }),
  })
  // the managers: failures (again a day later while they last), Square-side edits put back (once), a tax that blocks (once a day)
  let told = false
  if (res.blocked)
    told = await tellOnce(deps, locationId, 'square.items_tax_mismatch', 'Square item sync paused', `${res.blocked}. Settings → Billing & integrations → Square item library.`, [res.blocked], { remind: true })
  if (res.failures.length) {
    deps.logger?.warn({ square: { items: summary } }, 'square items sync: some services are not synced')
    told =
      (await tellOnce(
        deps,
        locationId,
        'square.items_sync_failed',
        'Some services are not in Square yet',
        `Oasis could not send these to Square’s item library: ${list(res.failures)}. Settings → Billing & integrations → Square item library → Sync now tries again.`,
        res.failures,
        { remind: true },
      )) || told
  }
  if (res.changedInSquare.length)
    told =
      (await tellOnce(
        deps,
        locationId,
        'square.items_changed_in_square',
        'Changed in Square, put back',
        `Changed in Square: ${list(res.changedInSquare)}. Oasis set ${res.changedInSquare.length === 1 ? 'it' : 'them'} back. Change prices in Settings → Prices by size.`,
        res.changedInSquare,
        { remind: true },
      )) || told
  if (res.writes > 0 || res.failed > 0 || told || o.actor)
    await transaction(deps.db, async (tx) => {
      await audit.record(tx, {
        locationId,
        action: 'square.items.sync',
        entityType: 'integration',
        entityId: 'square',
        after: { ...summary, environment, drift: o.drift === true },
        ctx: o.actor ?? { actor: { name: 'Square item sync' } },
      })
    })
  return out
}

export interface ArchiveAllReport {
  archived: number
  alreadyArchived: number
  failed: number
  failures: string[]
}

/**
 * The rollback (POST /integrations/square/items/archive-all): every Oasis item archived at Square (read-modify-write, nothing
 * deleted). The callers check that writes are on and the item sync is off (else the next sync would put them back on sale). The
 * links keep their ids; their content hash is cleared, so turning the sync on again re-sends every item.
 */
export async function archiveAllItems(deps: ItemSyncDeps, locationId: string, actor: audit.AuditContext): Promise<ArchiveAllReport> {
  const environment = squareEnvironment(deps.env)
  const links = await loadLinks(deps.db, locationId, environment)
  const store = dbLinkStore(deps.db, locationId, environment, deps.clock, links)
  const out: ArchiveAllReport = { archived: 0, alreadyArchived: 0, failed: 0, failures: [] }
  for (const l of links.filter((x) => x.kind === 'item' && x.objectId)) {
    try {
      const cur = await deps.api.catalog.retrieve(l.objectId!)
      if (cur.item_data?.is_archived === true) out.alreadyArchived++
      else {
        await deps.api.catalog.upsert(sqKey('ct', `items:archive:${l.objectId}:${cur.version ?? 0}`), { ...cur, item_data: { ...(cur.item_data ?? {}), is_archived: true } })
        out.archived++
      }
      await store.put({ ...l, state: 'archived', contentHash: null, error: null })
    } catch (e) {
      out.failed++
      out.failures.push(`${l.objectId}: ${failureText(e)}`)
    }
  }
  const now = deps.clock.now()
  await saveItemsState(deps.db, locationId, environment, now, { fingerprint: null, ...(out.archived ? { last_write_at: now } : {}) })
  await transaction(deps.db, async (tx) => {
    await audit.record(tx, { locationId, action: 'square.items.archive_all', entityType: 'integration', entityId: 'square', after: { ...out, environment }, ctx: actor })
  })
  return out
}

/**
 * Test connection's `tax` check (ADR 0172): the tax check, and when a tax is in use a CalculateOrder sample of Oasis's own prices
 * ("N of M totals differ by a cent"); read-only, kept as the last tax check. ok while the sync could run (a tax in use, or none yet).
 */
export async function itemsTaxConnectionCheck(db: Db, clock: Clock, api: SquareApi, locationId: string, env: ItemSyncDeps['env']): Promise<ConnectionCheck> {
  const t = await itemsTaxCheck(db, api, locationId, env)
  const squareLocation = squareLocationId(env as Env)
  if (t.status === 'ok' && t.percentage && squareLocation) {
    const [input, rate, rounding] = await Promise.all([loadLibraryInput(db, locationId), getSetting(db, locationId, 'tax.rate_dbp'), getSetting(db, locationId, 'tax.rounding')])
    const prices = desiredLibrary(input)
      .items.filter((i) => !i.archived)
      .flatMap((i) => i.variations.filter((v) => v.present && v.pricing.type === 'FIXED').map((v) => v.pricing.cents))
    try {
      t.rounding = await roundingCheck(api, { locationId: squareLocation, percentage: t.percentage, rateDbp: rate.value, rounding: rounding.value, prices })
    } catch (e) {
      t.warnings.push(`the rounding sample could not run: ${failureText(e)}`)
    }
  }
  const now = clock.now()
  await saveItemsState(db, locationId, squareEnvironment(env), now, { tax_check: t, tax_checked_at: now })
  const detail = [t.detail, t.rounding?.detail, ...t.warnings].filter(Boolean).join('; ')
  return { key: 'tax', ok: t.status === 'ok' || t.status === 'create', detail }
}
