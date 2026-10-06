// Planned closures: CRUD with the design's error strings, real affected counts and the notify fan-out behind ports.
import type { Executor, Tx } from '../../platform/db.js'
import { AppError, registerProblems } from '../../platform/errors.js'
import * as audit from '../../platform/audit.js'
import { isUuid, type NewId } from '../../platform/ids.js'
import { isValidBizDate } from '../../platform/time.js'
import { getSetting } from '../../platform/settings.js'
import './schema.js'
import type { ClosureSource, ClosureType } from './schema.js'
import { recordChange } from './changes.js'
import { HOURS_MAX, HOURS_MIN, HOURS_STEP } from './hours.js'
import { fmtT } from '../../platform/time.js'
import { sqlAffectedCounter } from './affected.js'
import {
  noopClosureNotifier,
  type AffectedAppointment,
  type AffectedCounter,
  type ClosureNotifier,
} from './ports.js'

export const CLOSURE_ERRORS = {
  incomplete: 'Add a date and a name.',
  duplicateDate: "There's already a closure on that date.",
} as const

registerProblems({
  CLOSURE_INCOMPLETE: { status: 422, title: 'Check the form', detail: CLOSURE_ERRORS.incomplete },
  CLOSURE_DATE_TAKEN: { status: 422, title: 'Check the form', detail: CLOSURE_ERRORS.duplicateDate },
  CLOSURE_LOCKED: {
    status: 409,
    title: 'Emergency closure',
    detail: 'This closure belongs to an emergency closure. Reopen the shop to change it',
  },
})

export interface ClosureRecord {
  id: string
  locationId: string
  date: string
  name: string
  type: ClosureType
  openMin: number | null
  closeMin: number | null
  notify: boolean
  source: ClosureSource
  federalKey: string | null
  federalYear: number | null
  emergencyClosureId: string | null
  deletedAt: Date | null
}

const CLOSURE_COLUMNS = [
  'id',
  'location_id',
  'date',
  'name',
  'type',
  'open_min',
  'close_min',
  'notify',
  'source',
  'federal_key',
  'federal_year',
  'emergency_closure_id',
  'deleted_at',
] as const

export const toClosure = (r: {
  id: string
  location_id: string
  date: string
  name: string
  type: ClosureType
  open_min: number | null
  close_min: number | null
  notify: boolean
  source: ClosureSource
  federal_key: string | null
  federal_year: number | null
  emergency_closure_id: string | null
  deleted_at: Date | null
}): ClosureRecord => ({
  id: r.id,
  locationId: r.location_id,
  date: r.date,
  name: r.name,
  type: r.type,
  openMin: r.open_min,
  closeMin: r.close_min,
  notify: r.notify,
  source: r.source,
  federalKey: r.federal_key,
  federalYear: r.federal_year,
  emergencyClosureId: r.emergency_closure_id,
  deletedAt: r.deleted_at,
})

/** "Emergency", "Closed all day" or "Reduced · 10:00 AM – 2:00 PM" (en dash). */
export function closureTypeLabel(c: Pick<ClosureRecord, 'source' | 'type' | 'openMin' | 'closeMin'>): string {
  if (c.source === 'emergency') return 'Emergency'
  if (c.type === 'closed') return 'Closed all day'
  return `Reduced · ${fmtT(c.openMin ?? 0)} – ${fmtT(c.closeMin ?? 0)}`
}

/** The row sub-line with the real count (singular and plural fixed, D3). */
export function closureSubLine(type: ClosureType, affected: number): string {
  const s = affected === 1 ? '' : 's'
  return type === 'closed'
    ? `Online booking blocked · ${affected} existing booking${s} to move`
    : `Slots outside reduced hours hidden · ${affected} booking${s} affected`
}

export async function getClosure(
  db: Executor,
  locationId: string,
  id: string,
): Promise<ClosureRecord | undefined> {
  if (!isUuid(id)) return undefined
  const r = await db
    .selectFrom('closures')
    .select([...CLOSURE_COLUMNS])
    .where('location_id', '=', locationId)
    .where('id', '=', id)
    .executeTakeFirst()
  return r ? toClosure(r) : undefined
}

/** Live closures, optionally within [from, to] (inclusive business dates), ordered by date. */
export async function listLiveClosures(
  db: Executor,
  locationId: string,
  range: { from?: string; to?: string } = {},
): Promise<ClosureRecord[]> {
  let q = db
    .selectFrom('closures')
    .select([...CLOSURE_COLUMNS])
    .where('location_id', '=', locationId)
    .where('deleted_at', 'is', null)
  if (range.from) q = q.where('date', '>=', range.from)
  if (range.to) q = q.where('date', '<=', range.to)
  return (await q.orderBy('date').orderBy('id').execute()).map(toClosure)
}

export interface ClosureWindowInput {
  type: ClosureType
  openMin?: number | null
  closeMin?: number | null
}

function validateWindow(input: ClosureWindowInput): void {
  if (input.type !== 'closed' && input.type !== 'reduced')
    throw new AppError('VALIDATION_FAILED', {
      detail: 'Choose closed all day or reduced hours.',
      errors: [{ path: 'type', message: 'Choose closed all day or reduced hours.' }],
    })
  if (input.type === 'closed') return
  const { openMin, closeMin } = input
  const bad = (message: string) =>
    new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path: 'openMin', message }] })
  if (
    typeof openMin !== 'number' ||
    typeof closeMin !== 'number' ||
    !Number.isInteger(openMin) ||
    !Number.isInteger(closeMin)
  )
    throw bad('Set the opening and closing time for reduced hours.')
  if (openMin >= closeMin) throw bad('Closing time must be after opening time.')
  if (openMin % HOURS_STEP !== 0 || closeMin % HOURS_STEP !== 0) throw bad('Use 30-minute steps.')
  if (openMin < HOURS_MIN || closeMin > HOURS_MAX)
    throw bad(`Hours must be between ${fmtT(HOURS_MIN)} and ${fmtT(HOURS_MAX)}.`)
}

export interface PreviewClosureInput extends ClosureWindowInput {
  locationId: string
  date: string
  tz: string
  counter?: AffectedCounter
}

/** POST /closures/preview: the real number of customers the closure would touch. */
export async function previewClosure(
  db: Executor,
  input: PreviewClosureInput,
): Promise<{ affected: number }> {
  if (!input.date || !isValidBizDate(input.date)) throw new AppError('CLOSURE_INCOMPLETE')
  validateWindow(input)
  const counter = input.counter ?? sqlAffectedCounter
  const affected = await counter.count(
    db,
    {
      locationId: input.locationId,
      date: input.date,
      type: input.type,
      openMin: input.openMin,
      closeMin: input.closeMin,
    },
    input.tz,
  )
  return { affected }
}

export interface CreateClosureInput extends ClosureWindowInput {
  locationId: string
  date: string
  name: string
  /** Messages the affected customers once, at creation (default true, the design's default). */
  notify?: boolean
  source?: Exclude<ClosureSource, 'emergency'>
  federalKey?: string
  federalYear?: number
  createdBy?: string | null
  tz: string
  newId: NewId
  counter?: AffectedCounter
  notifier?: ClosureNotifier
  audit?: audit.AuditContext
}

export interface CreateClosureResult {
  closure: ClosureRecord
  affectedCount: number
  notified: number
}

export async function createClosure(tx: Tx, input: CreateClosureInput): Promise<CreateClosureResult> {
  const name = (input.name ?? '').trim()
  if (!input.date || !isValidBizDate(input.date) || name === '') throw new AppError('CLOSURE_INCOMPLETE')
  if (name.length > 80)
    throw new AppError('VALIDATION_FAILED', {
      detail: 'Keep the name under 80 characters.',
      errors: [{ path: 'name', message: 'Keep the name under 80 characters.' }],
    })
  validateWindow(input)
  const reduced = input.type === 'reduced'
  const id = input.newId()
  const notify = input.notify ?? true
  const inserted = await tx
    .insertInto('closures')
    .values({
      id,
      location_id: input.locationId,
      date: input.date,
      name,
      type: input.type,
      open_min: reduced ? input.openMin! : null,
      close_min: reduced ? input.closeMin! : null,
      notify,
      source: input.source ?? 'manual',
      federal_key: input.federalKey ?? null,
      federal_year: input.federalYear ?? null,
      emergency_closure_id: null,
      created_by: input.createdBy ?? null,
      deleted_at: null,
    })
    .onConflict((oc) => oc.columns(['location_id', 'date']).where('deleted_at', 'is', null).doNothing())
    .returning('id')
    .executeTakeFirst()
  if (!inserted) throw new AppError('CLOSURE_DATE_TAKEN')

  const closure = (await getClosure(tx, input.locationId, id))!
  const counter = input.counter ?? sqlAffectedCounter
  const window = {
    locationId: input.locationId,
    date: closure.date,
    type: closure.type,
    openMin: closure.openMin,
    closeMin: closure.closeMin,
  }
  let affected: AffectedAppointment[] = []
  let affectedCount: number
  let notified = 0
  if (notify) {
    affected = await counter.list(tx, window, input.tz)
    affectedCount = affected.length
    const toMessage = affected.filter((a) => a.status === 'booked' || a.status === 'confirmed')
    if (toMessage.length > 0) {
      const notifier = input.notifier ?? noopClosureNotifier
      notified = (
        await notifier.notify(
          tx,
          { closureId: id, date: closure.date, name: closure.name, type: closure.type },
          toMessage,
        )
      ).notified
    }
  } else {
    affectedCount = await counter.count(tx, window, input.tz)
  }
  await recordChange(tx, {
    locationId: input.locationId,
    action: 'settings.closure.create',
    entityType: 'closure',
    entityId: id,
    after: {
      date: closure.date,
      name: closure.name,
      type: closure.type,
      openMin: closure.openMin,
      closeMin: closure.closeMin,
      notify,
    },
    section: 'closures',
    audit: input.audit,
  })
  return { closure, affectedCount, notified }
}

export interface UpdateClosureInput {
  locationId: string
  id: string
  patch: {
    name?: string
    notify?: boolean
    type?: ClosureType
    openMin?: number | null
    closeMin?: number | null
  }
  audit?: audit.AuditContext
}

/** PATCH /closures/:id: name, notify and type or window (how Labor Day became reduced). The date is fixed. */
export async function updateClosure(tx: Tx, input: UpdateClosureInput): Promise<ClosureRecord> {
  const row = isUuid(input.id)
    ? await tx
        .selectFrom('closures')
        .select([...CLOSURE_COLUMNS])
        .where('location_id', '=', input.locationId)
        .where('id', '=', input.id)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst()
    : undefined
  if (!row) throw new AppError('NOT_FOUND', { detail: 'That closure does not exist' })
  const before = toClosure(row)
  if (before.source === 'emergency') throw new AppError('CLOSURE_LOCKED')
  const p = input.patch
  const set: Record<string, unknown> = {}
  if (p.name !== undefined) {
    const name = p.name.trim()
    if (name === '') throw new AppError('CLOSURE_INCOMPLETE')
    set.name = name
  }
  if (p.notify !== undefined) set.notify = p.notify
  if (p.type !== undefined || p.openMin !== undefined || p.closeMin !== undefined) {
    const type = p.type ?? before.type
    const next = {
      type,
      openMin: p.openMin !== undefined ? p.openMin : type === 'reduced' ? before.openMin : null,
      closeMin: p.closeMin !== undefined ? p.closeMin : type === 'reduced' ? before.closeMin : null,
    }
    validateWindow(next)
    set.type = type
    set.open_min = type === 'reduced' ? next.openMin : null
    set.close_min = type === 'reduced' ? next.closeMin : null
  }
  if (Object.keys(set).length === 0) return before
  await tx
    .updateTable('closures')
    .set((eb) => ({ ...set, updated_at: eb.fn('app_now', []) }))
    .where('id', '=', before.id)
    .execute()
  const after = (await getClosure(tx, input.locationId, before.id))!
  await recordChange(tx, {
    locationId: input.locationId,
    action: 'settings.closure.update',
    entityType: 'closure',
    entityId: before.id,
    before: {
      name: before.name,
      type: before.type,
      openMin: before.openMin,
      closeMin: before.closeMin,
      notify: before.notify,
    },
    after: {
      name: after.name,
      type: after.type,
      openMin: after.openMin,
      closeMin: after.closeMin,
      notify: after.notify,
    },
    section: 'closures',
    audit: input.audit,
  })
  return after
}

/**
 * DELETE /closures/:id. Soft delete: the row keeps its federal key so the generator does not bring a removed holiday
 * back, and nothing is sent to customers.
 */
export async function deleteClosure(
  tx: Tx,
  input: { locationId: string; id: string; audit?: audit.AuditContext },
): Promise<ClosureRecord> {
  const row = isUuid(input.id)
    ? await tx
        .selectFrom('closures')
        .select([...CLOSURE_COLUMNS])
        .where('location_id', '=', input.locationId)
        .where('id', '=', input.id)
        .where('deleted_at', 'is', null)
        .forUpdate()
        .executeTakeFirst()
    : undefined
  if (!row) throw new AppError('NOT_FOUND', { detail: 'That closure does not exist' })
  const closure = toClosure(row)
  if (closure.source === 'emergency') throw new AppError('CLOSURE_LOCKED')
  await tx
    .updateTable('closures')
    .set((eb) => ({ deleted_at: eb.fn('app_now', []), updated_at: eb.fn('app_now', []) }))
    .where('id', '=', closure.id)
    .execute()
  await recordChange(tx, {
    locationId: input.locationId,
    action: 'settings.closure.delete',
    entityType: 'closure',
    entityId: closure.id,
    before: { date: closure.date, name: closure.name, type: closure.type },
    section: 'closures',
    audit: input.audit,
  })
  return (await getClosure(tx, input.locationId, closure.id))!
}

export interface ClosureView extends ClosureRecord {
  typeLabel: string
  past: boolean
  emergency: boolean
  /** Real count; null for past rows (they are history only). */
  affectedCount: number | null
  subLine: string | null
}

export interface ClosureList {
  federalAuto: boolean
  upcoming: ClosureView[]
  /** Newest first. */
  past: ClosureView[]
}

/** GET /closures: upcoming by date ascending and past descending, each upcoming row with its real affected count. */
export async function listClosureViews(
  db: Executor,
  o: { locationId: string; today: string; tz: string; counter?: AffectedCounter; from?: string; to?: string },
): Promise<ClosureList> {
  const counter = o.counter ?? sqlAffectedCounter
  const rows = await listLiveClosures(db, o.locationId, { from: o.from, to: o.to })
  const views: ClosureView[] = []
  for (const c of rows) {
    const past = c.date < o.today
    const affectedCount = past
      ? null
      : await counter.count(
          db,
          { locationId: o.locationId, date: c.date, type: c.type, openMin: c.openMin, closeMin: c.closeMin },
          o.tz,
        )
    views.push({
      ...c,
      typeLabel: closureTypeLabel(c),
      past,
      emergency: c.source === 'emergency',
      affectedCount,
      subLine: affectedCount === null ? null : closureSubLine(c.type, affectedCount),
    })
  }
  const federalAuto = (await getSetting(db, o.locationId, 'federal_holidays.auto')).value
  return {
    federalAuto,
    upcoming: views.filter((v) => !v.past),
    past: views.filter((v) => v.past).reverse(),
  }
}
