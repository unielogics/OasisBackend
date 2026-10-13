// What staff see of the Square item library (ADR 0172 section 8): the state of each service and price at Square, from the links and
// the desired library (no Square call): the Square item library block of Settings → Billing & integrations
// (GET /integrations/square/items), its summary in GET /settings/billing, and the per-cell dot of Prices by size (GET /catalog).
import type { Env } from '../../../config/env.js'
import { squareItemsOn } from '../../../integrations/square/config.js'
import type { Executor } from '../../../platform/db.js'
import { squareEnvironment } from '../../square/db/state.js'
import { desiredLibrary, itemHash } from './desired.js'
import { refsFor, sizeKey, type LinkRow } from './plan.js'
import { getItemsState, itemsMode, loadLibraryInput, loadLinks, type ItemsMode, type ItemsPreview } from './sync.js'
import type { TaxCheck } from './tax.js'

/** synced: on Square as Oasis has it; pending: waiting for the next sync; failed: the last try failed; archived; not_sold: never made. */
export type ServiceSquareState = 'synced' | 'pending' | 'failed' | 'archived' | 'not_sold'
export type CellSquareState = 'synced' | 'pending' | 'failed' | 'hidden'

export interface ServiceSquare {
  serviceId: string
  name: string
  state: ServiceSquareState
  error: string | null
  /** The sizes Oasis sells it at ('' = Regular), and where each stands. */
  cells: Record<string, CellSquareState>
}

export function serviceStates(lib: ReturnType<typeof desiredLibrary>, links: readonly LinkRow[]): ServiceSquare[] {
  return lib.items.map((item) => {
    const link = links.find((l) => l.kind === 'item' && l.serviceId === item.serviceId)
    const hash = itemHash(item, refsFor(item, links))
    const state: ServiceSquareState = !link?.objectId
      ? link?.state === 'failed'
        ? 'failed'
        : item.archived
          ? 'not_sold'
          : 'pending'
      : link.state === 'failed'
        ? 'failed'
        : link.contentHash !== hash || link.state === 'pending'
          ? 'pending'
          : item.archived
            ? 'archived'
            : 'synced'
    const cells: Record<string, CellSquareState> = {}
    if (!item.archived)
      for (const v of item.variations.filter((x) => x.present)) {
        const vl = links.find((l) => l.kind === 'variation' && l.serviceId === item.serviceId && sizeKey(l.classKey) === sizeKey(v.classKey))
        cells[sizeKey(v.classKey)] = state === 'failed' ? 'failed' : state === 'synced' && vl?.state === 'synced' ? 'synced' : 'pending'
      }
    return { serviceId: item.serviceId, name: item.name, state, error: state === 'failed' ? (link?.error ?? null) : null, cells }
  })
}

export async function loadServiceStates(db: Executor, locationId: string, env: Pick<Env, 'SQUARE_PROVIDER' | 'SQUARE_ENVIRONMENT'>): Promise<ServiceSquare[]> {
  const [input, links] = await Promise.all([loadLibraryInput(db, locationId), loadLinks(db, locationId, squareEnvironment(env))])
  return serviceStates(desiredLibrary(input), links)
}

export interface ItemsCounts {
  onSquare: number
  waiting: number
  failed: number
  archived: number
  notSold: number
}

export const countsOf = (s: readonly ServiceSquare[]): ItemsCounts => ({
  onSquare: s.filter((x) => x.state === 'synced').length,
  waiting: s.filter((x) => x.state === 'pending').length,
  failed: s.filter((x) => x.state === 'failed').length,
  archived: s.filter((x) => x.state === 'archived').length,
  notSold: s.filter((x) => x.state === 'not_sold').length,
})

export interface ItemsView {
  mode: ItemsMode
  environment: 'sim' | 'sandbox' | 'production'
  writesEnabled: boolean
  itemsSyncEnabled: boolean
  taxMode: 'auto' | 'adopt' | 'create'
  taxObjectId: string | null
  taxCheck: TaxCheck | null
  taxCheckedAt: string | null
  counts: ItemsCounts
  lastSyncAt: string | null
  lastSync: Record<string, unknown> | null
  lastDriftAt: string | null
  lastWriteAt: string | null
  lastError: string | null
  lastErrorAt: string | null
  failures: Array<{ serviceId: string; service: string; error: string | null }>
  preview: ItemsPreview | null
  version: number
}

type ItemsEnv = Pick<Env, 'SQUARE_PROVIDER' | 'SQUARE_ENVIRONMENT' | 'SQUARE_WRITES_ENABLED' | 'SQUARE_ITEMS_SYNC_ENABLED' | 'SQUARE_LOCATION_ID'>

export async function loadItemsView(db: Executor, locationId: string, env: ItemsEnv): Promise<ItemsView> {
  const environment = squareEnvironment(env)
  const [states, state] = await Promise.all([loadServiceStates(db, locationId, env), getItemsState(db, locationId, environment)])
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null)
  return {
    mode: itemsMode(env),
    environment,
    writesEnabled: env.SQUARE_WRITES_ENABLED,
    itemsSyncEnabled: env.SQUARE_ITEMS_SYNC_ENABLED,
    taxMode: state?.tax_mode ?? 'auto',
    taxObjectId: state?.tax_mode === 'adopt' ? (state.tax_object_id ?? null) : null,
    taxCheck: (state?.tax_check as TaxCheck | null | undefined) ?? null,
    taxCheckedAt: iso(state?.tax_checked_at),
    counts: countsOf(states),
    lastSyncAt: iso(state?.last_sync_at),
    lastSync: (state?.last_sync as Record<string, unknown> | null | undefined) ?? null,
    lastDriftAt: iso(state?.last_drift_at),
    lastWriteAt: iso(state?.last_write_at),
    lastError: state?.last_error ?? null,
    lastErrorAt: iso(state?.last_error_at),
    failures: states.filter((s) => s.state === 'failed').map((s) => ({ serviceId: s.serviceId, service: s.name, error: s.error })),
    preview: (state?.last_preview as ItemsPreview | null | undefined) ?? null,
    version: state?.version ?? 0,
  }
}

/** The per-cell Square state of Prices by size, only while the sync is on (else nothing is shown). */
export async function priceRowsSquare(db: Executor, locationId: string, env: ItemsEnv): Promise<Map<string, ServiceSquare> | null> {
  if (!squareItemsOn(env)) return null
  return new Map((await loadServiceStates(db, locationId, env)).map((s) => [s.serviceId, s]))
}
