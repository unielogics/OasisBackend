// Catalog repository and service: packages and add-ons with their ordered checklist tasks. Reads accept a Db or Tx;
// every write takes a Tx so the caller composes it with its audit, idempotency and realtime work.
import { sql } from 'kysely'
import type { Executor, Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import * as audit from '../../platform/audit.js'
import * as realtime from '../../platform/realtime.js'
import type { NewId } from '../../platform/ids.js'
import { isUuid } from '../../platform/ids.js'
import './schema.js'
import type { ServiceKind } from './schema.js'
import {
  ChecklistDiffError,
  diffChecklist,
  type ChecklistInput,
  type ChecklistPlan,
  type ExistingTask,
} from './checklist-diff.js'

export interface CatalogTask {
  id: string
  label: string
  position: number
}

export interface CatalogService {
  id: string
  locationId: string
  kind: ServiceKind
  name: string
  /** The stored override, or null when the display name is derived. */
  shortNameOverride: string | null
  /** name.split(' + ')[0] unless overridden. */
  shortName: string
  priceCents: number
  durationMin: number
  tags: string[]
  bookableDesk: boolean
  sort: number
  active: boolean
  sqspSku: string | null
  version: number
  tasks: CatalogTask[]
}

export interface Catalog {
  packages: CatalogService[]
  addons: CatalogService[]
}

export const displayShortName = (name: string, override?: string | null): string =>
  override && override.trim() !== '' ? override.trim() : name.split(' + ')[0]!.trim()

/**
 * The tasks a job snapshots for this service. An add-on without tasks yields one task named after the add-on
 * (the design's fallback); a package without tasks yields none.
 */
export function jobTasksFor(service: Pick<CatalogService, 'kind' | 'name' | 'tasks'>): string[] {
  if (service.tasks.length > 0) return service.tasks.map((t) => t.label)
  return service.kind === 'addon' ? [service.name] : []
}

interface ServiceRow {
  id: string
  location_id: string
  kind: ServiceKind
  name: string
  short_name: string | null
  price_cents: number
  duration_min: number
  tags: string[]
  bookable_desk: boolean
  sort: number
  active: boolean
  sqsp_sku: string | null
  version: number
}

const SERVICE_COLUMNS = [
  'id',
  'location_id',
  'kind',
  'name',
  'short_name',
  'price_cents',
  'duration_min',
  'tags',
  'bookable_desk',
  'sort',
  'active',
  'sqsp_sku',
  'version',
] as const

function toService(r: ServiceRow, tasks: CatalogTask[]): CatalogService {
  return {
    id: r.id,
    locationId: r.location_id,
    kind: r.kind,
    name: r.name,
    shortNameOverride: r.short_name,
    shortName: displayShortName(r.name, r.short_name),
    priceCents: r.price_cents,
    durationMin: r.duration_min,
    tags: r.tags,
    bookableDesk: r.bookable_desk,
    sort: r.sort,
    active: r.active,
    sqspSku: r.sqsp_sku,
    version: r.version,
    tasks,
  }
}

async function loadTasks(db: Executor, serviceIds: string[]): Promise<Map<string, CatalogTask[]>> {
  const map = new Map<string, CatalogTask[]>(serviceIds.map((id) => [id, []]))
  if (serviceIds.length === 0) return map
  const rows = await db
    .selectFrom('checklist_tasks')
    .select(['id', 'service_id', 'label', 'position'])
    .where('service_id', 'in', serviceIds)
    .where('retired_at', 'is', null)
    .orderBy('service_id')
    .orderBy('position')
    .orderBy('id')
    .execute()
  for (const r of rows) map.get(r.service_id)!.push({ id: r.id, label: r.label, position: r.position })
  return map
}

export async function listCatalog(
  db: Executor,
  locationId: string,
  o: { includeInactive?: boolean } = {},
): Promise<Catalog> {
  let q = db
    .selectFrom('services')
    .select([...SERVICE_COLUMNS])
    .where('location_id', '=', locationId)
  if (!o.includeInactive) q = q.where('active', '=', true)
  const rows = await q.orderBy('kind').orderBy('sort').orderBy('id').execute()
  const tasks = await loadTasks(
    db,
    rows.map((r) => r.id),
  )
  const services = rows.map((r) => toService(r, tasks.get(r.id)!))
  return {
    packages: services.filter((s) => s.kind === 'package'),
    addons: services.filter((s) => s.kind === 'addon'),
  }
}

export async function getService(
  db: Executor,
  locationId: string,
  serviceId: string,
): Promise<CatalogService | undefined> {
  if (!isUuid(serviceId)) return undefined
  const row = await db
    .selectFrom('services')
    .select([...SERVICE_COLUMNS])
    .where('location_id', '=', locationId)
    .where('id', '=', serviceId)
    .executeTakeFirst()
  if (!row) return undefined
  const tasks = await loadTasks(db, [row.id])
  return toService(row, tasks.get(row.id)!)
}

export async function requireService(
  db: Executor,
  locationId: string,
  serviceId: string,
): Promise<CatalogService> {
  const s = await getService(db, locationId, serviceId)
  if (!s) throw new AppError('NOT_FOUND', { detail: 'That package or add-on does not exist' })
  return s
}

export async function findServiceByName(
  db: Executor,
  locationId: string,
  kind: ServiceKind,
  name: string,
): Promise<CatalogService | undefined> {
  const row = await db
    .selectFrom('services')
    .select([...SERVICE_COLUMNS])
    .where('location_id', '=', locationId)
    .where('kind', '=', kind)
    .where(sql<boolean>`lower(name) = lower(${name.trim()})`)
    .executeTakeFirst()
  if (!row) return undefined
  const tasks = await loadTasks(db, [row.id])
  return toService(row, tasks.get(row.id)!)
}

function validationError(path: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path, message }] })
}

const duplicateName = (kind: ServiceKind): AppError =>
  validationError('name', `${kind === 'package' ? 'A package' : 'An add-on'} with that name already exists.`)

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505'

function checkFields(
  kind: ServiceKind,
  f: { name?: string; priceCents?: number; durationMin?: number; shortName?: string | null; tags?: string[] },
): void {
  if (f.name !== undefined && (f.name.trim() === '' || f.name.trim().length > 120))
    throw validationError('name', 'Enter a name of up to 120 characters.')
  if (f.shortName !== undefined && f.shortName !== null && f.shortName.trim().length > 60)
    throw validationError('shortName', 'The short name can be at most 60 characters.')
  if (
    f.priceCents !== undefined &&
    (!Number.isSafeInteger(f.priceCents) || f.priceCents < 0 || f.priceCents > 10_000_000)
  )
    throw validationError('priceCents', 'Enter a price in whole cents, from 0 to $100,000.')
  if (f.durationMin !== undefined) {
    const ok =
      kind === 'addon'
        ? f.durationMin === 0
        : Number.isInteger(f.durationMin) && f.durationMin >= 1 && f.durationMin <= 720
    if (!ok)
      throw validationError(
        'durationMin',
        kind === 'addon' ? 'Add-ons do not have a duration.' : 'Enter a duration from 1 to 720 minutes.',
      )
  }
  if (f.tags !== undefined) {
    if (f.tags.length > 20 || f.tags.some((t) => !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(t)))
      throw validationError('tags', 'Tags are lowercase words (letters, digits, dash, underscore).')
  }
}

export interface CreateServiceInput {
  locationId: string
  kind: ServiceKind
  name: string
  priceCents: number
  /** Packages only; add-ons are always 0. */
  durationMin?: number
  shortName?: string | null
  tags?: string[]
  bookableDesk?: boolean
  sort?: number
  active?: boolean
  sqspSku?: string | null
  /** Initial ordered checklist labels. */
  tasks?: string[]
  newId: NewId
  audit?: audit.AuditContext
}

export async function createService(tx: Tx, input: CreateServiceInput): Promise<CatalogService> {
  const durationMin = input.kind === 'addon' ? 0 : (input.durationMin ?? 0)
  const name = input.name.trim()
  checkFields(input.kind, { ...input, name, durationMin })
  if (input.kind === 'package' && durationMin < 1)
    throw validationError('durationMin', 'Enter a duration from 1 to 720 minutes.')
  const existing = await findServiceByName(tx, input.locationId, input.kind, name)
  if (existing) throw duplicateName(input.kind)
  const id = input.newId()
  try {
    await tx
      .insertInto('services')
      .values({
        id,
        location_id: input.locationId,
        kind: input.kind,
        name,
        short_name: input.shortName?.trim() || null,
        price_cents: input.priceCents,
        duration_min: durationMin,
        tags: input.tags ?? [],
        bookable_desk: input.bookableDesk ?? true,
        sort: input.sort ?? 0,
        active: input.active ?? true,
        sqsp_sku: input.sqspSku ?? null,
      })
      .execute()
  } catch (e) {
    if (isUniqueViolation(e)) throw duplicateName(input.kind)
    throw e
  }
  const labels = (input.tasks ?? []).map((l) => l.trim()).filter((l) => l !== '')
  if (labels.length > 0) {
    await tx
      .insertInto('checklist_tasks')
      .values(
        labels.map((label, position) => ({
          id: input.newId(),
          service_id: id,
          label,
          position,
          retired_at: null,
        })),
      )
      .execute()
  }
  const created = await requireService(tx, input.locationId, id)
  await audit.record(tx, {
    locationId: input.locationId,
    action: 'catalog.create',
    entityType: 'service',
    entityId: id,
    after: serviceAudit(created),
    ctx: input.audit,
  })
  await publishChange(tx, input.locationId, id)
  return created
}

export interface ServicePatch {
  name?: string
  shortName?: string | null
  priceCents?: number
  durationMin?: number
  tags?: string[]
  bookableDesk?: boolean
  sort?: number
  active?: boolean
  sqspSku?: string | null
}

export interface UpdateServiceInput {
  locationId: string
  serviceId: string
  patch: ServicePatch
  expectedVersion?: number
  audit?: audit.AuditContext
}

const serviceAudit = (s: CatalogService) => ({
  kind: s.kind,
  name: s.name,
  shortName: s.shortNameOverride,
  priceCents: s.priceCents,
  durationMin: s.durationMin,
  tags: s.tags,
  bookableDesk: s.bookableDesk,
  sort: s.sort,
  active: s.active,
})

async function lockService(tx: Tx, locationId: string, serviceId: string, expectedVersion?: number) {
  const row = isUuid(serviceId)
    ? await tx
        .selectFrom('services')
        .select([...SERVICE_COLUMNS])
        .where('location_id', '=', locationId)
        .where('id', '=', serviceId)
        .forUpdate()
        .executeTakeFirst()
    : undefined
  if (!row) throw new AppError('NOT_FOUND', { detail: 'That package or add-on does not exist' })
  if (expectedVersion !== undefined && expectedVersion !== row.version)
    throw new AppError('VERSION_CONFLICT', { meta: { currentVersion: row.version } })
  return row
}

async function publishChange(tx: Tx, locationId: string, serviceId: string): Promise<void> {
  await realtime.publish(tx, {
    locationId,
    channel: 'settings',
    type: 'settings.changed',
    payload: { section: 'services', key: serviceId },
  })
}

/** Name, short name, price, duration, tags and flags in one version-checked update. */
export async function updateService(tx: Tx, input: UpdateServiceInput): Promise<CatalogService> {
  const row = await lockService(tx, input.locationId, input.serviceId, input.expectedVersion)
  const p = input.patch
  const name = p.name === undefined ? undefined : p.name.trim()
  checkFields(row.kind, { ...p, name })
  if (name !== undefined && name.toLowerCase() !== row.name.toLowerCase()) {
    const clash = await findServiceByName(tx, input.locationId, row.kind, name)
    if (clash && clash.id !== row.id) throw duplicateName(row.kind)
  }
  const before = await requireService(tx, input.locationId, row.id)
  const set: Record<string, unknown> = {}
  if (name !== undefined) set.name = name
  if (p.shortName !== undefined) set.short_name = p.shortName?.trim() || null
  if (p.priceCents !== undefined) set.price_cents = p.priceCents
  if (p.durationMin !== undefined) set.duration_min = p.durationMin
  if (p.tags !== undefined) set.tags = p.tags
  if (p.bookableDesk !== undefined) set.bookable_desk = p.bookableDesk
  if (p.sort !== undefined) set.sort = p.sort
  if (p.active !== undefined) set.active = p.active
  if (p.sqspSku !== undefined) set.sqsp_sku = p.sqspSku
  if (Object.keys(set).length === 0) return before
  try {
    await tx
      .updateTable('services')
      .set((eb) => ({
        ...set,
        version: eb('version', '+', 1),
        updated_at: eb.fn('app_now', []),
      }))
      .where('id', '=', row.id)
      .execute()
  } catch (e) {
    if (isUniqueViolation(e)) throw duplicateName(row.kind)
    throw e
  }
  const after = await requireService(tx, input.locationId, row.id)
  await audit.record(tx, {
    locationId: input.locationId,
    action: 'catalog.update',
    entityType: 'service',
    entityId: row.id,
    before: serviceAudit(before),
    after: serviceAudit(after),
    ctx: input.audit,
  })
  await publishChange(tx, input.locationId, row.id)
  return after
}

type Ctx = Omit<UpdateServiceInput, 'patch'>
export const renameService = (tx: Tx, c: Ctx, name: string, shortName?: string | null) =>
  updateService(tx, { ...c, patch: shortName === undefined ? { name } : { name, shortName } })
export const setServicePrice = (tx: Tx, c: Ctx, priceCents: number) =>
  updateService(tx, { ...c, patch: { priceCents } })
export const setServiceDuration = (tx: Tx, c: Ctx, durationMin: number) =>
  updateService(tx, { ...c, patch: { durationMin } })
/** Retired services stay in the table (appointments snapshot them) but leave booking. */
export const setServiceActive = (tx: Tx, c: Ctx, active: boolean) =>
  updateService(tx, { ...c, patch: { active } })

export interface PutChecklistInput {
  locationId: string
  serviceId: string
  /** The whole ordered list, as {id?, label}. A bare string[] maps to labels without ids. */
  tasks: readonly (ChecklistInput | string)[]
  expectedVersion?: number
  newId: NewId
  audit?: audit.AuditContext
}

export interface PutChecklistResult {
  service: CatalogService
  changed: boolean
  plan: Pick<ChecklistPlan, 'renamed' | 'created' | 'retired' | 'revived' | 'moved'> & {
    /** Ids assigned to created tasks, in list order. */
    createdIds: string[]
  }
}

export async function putChecklist(tx: Tx, input: PutChecklistInput): Promise<PutChecklistResult> {
  const row = await lockService(tx, input.locationId, input.serviceId, input.expectedVersion)
  const existingRows = await tx
    .selectFrom('checklist_tasks')
    .select(['id', 'label', 'position', 'retired_at'])
    .where('service_id', '=', row.id)
    .execute()
  const existing: ExistingTask[] = existingRows.map((t) => ({
    id: t.id,
    label: t.label,
    position: t.position,
    retired: t.retired_at !== null,
  }))
  const entries = input.tasks.map((t): ChecklistInput => (typeof t === 'string' ? { label: t } : t))
  let plan: ChecklistPlan
  try {
    plan = diffChecklist(existing, entries)
  } catch (e) {
    if (e instanceof ChecklistDiffError) throw validationError(`tasks.${e.index}`, e.message)
    throw e
  }
  if (!plan.changed) {
    return {
      service: await requireService(tx, input.locationId, row.id),
      changed: false,
      plan: { renamed: [], created: [], retired: [], revived: [], moved: [], createdIds: [] },
    }
  }
  const before = await requireService(tx, input.locationId, row.id)
  const createdIds: string[] = []
  for (const t of plan.tasks) {
    if (t.id === null) {
      const id = input.newId()
      createdIds.push(id)
      await tx
        .insertInto('checklist_tasks')
        .values({ id, service_id: row.id, label: t.label, position: t.position, retired_at: null })
        .execute()
    }
  }
  const byId = new Map(existing.map((e) => [e.id, e]))
  for (const t of plan.tasks) {
    if (t.id === null) continue
    const prev = byId.get(t.id)!
    if (prev.label === t.label && prev.position === t.position && !prev.retired) continue
    await tx
      .updateTable('checklist_tasks')
      .set({ label: t.label, position: t.position, retired_at: null })
      .where('id', '=', t.id)
      .execute()
  }
  if (plan.retired.length > 0) {
    await tx
      .updateTable('checklist_tasks')
      .set((eb) => ({ retired_at: eb.fn('app_now', []) }))
      .where(
        'id',
        'in',
        plan.retired.map((r) => r.id),
      )
      .execute()
  }
  await tx
    .updateTable('services')
    .set((eb) => ({ version: eb('version', '+', 1), updated_at: eb.fn('app_now', []) }))
    .where('id', '=', row.id)
    .execute()
  const service = await requireService(tx, input.locationId, row.id)
  await audit.record(tx, {
    locationId: input.locationId,
    action: 'catalog.checklist.update',
    entityType: 'service',
    entityId: row.id,
    before: before.tasks.map((t) => t.label),
    after: service.tasks.map((t) => t.label),
    ctx: input.audit,
  })
  await publishChange(tx, input.locationId, row.id)
  return {
    service,
    changed: true,
    plan: {
      renamed: plan.renamed,
      created: plan.created,
      retired: plan.retired,
      revived: plan.revived,
      moved: plan.moved,
      createdIds,
    },
  }
}
