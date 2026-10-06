// Job checklists: snapshotted at booking with stable ids (never labels), extended by add-ons, toggled item by item or in
// bulk. A section is the package or one add-on; removing an add-on hides its items (kept, restored when it is re-added).
import { sql } from 'kysely'
import type { Executor, Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { isUuid } from '../../platform/ids.js'
import '../customers/schema.js'
import { jobTasksFor, type CatalogService } from '../catalog/service.js'
import { invalidTransition, lockAppointment, logActivity, publishOps } from './appointments.js'
import type { Actor, SchedulingCtx } from './context.js'
import { audit } from './audit-helper.js'

export interface ChecklistItemView {
  id: string
  label: string
  done: boolean
  position: number
}

export interface ChecklistSection {
  kind: 'package' | 'addon'
  title: string
  /** The appointment_addons row of an add-on section. */
  addonId: string | null
  items: ChecklistItemView[]
  done: number
  total: number
  allDone: boolean
}

export interface ChecklistProgress {
  done: number
  total: number
  pct: number
  allDone: boolean
}

export interface ChecklistView extends ChecklistProgress {
  sections: ChecklistSection[]
}

export const progressOf = (done: number, total: number): ChecklistProgress => ({
  done,
  total,
  pct: total === 0 ? 0 : Math.round((done / total) * 100),
  allDone: total > 0 && done === total,
})

export async function loadChecklist(db: Executor, appointmentId: string): Promise<ChecklistView> {
  const rows = await db
    .selectFrom('job_checklist_items')
    .select(['id', 'section_kind', 'section_title', 'appointment_addon_id', 'label', 'position', 'done'])
    .where('appointment_id', '=', appointmentId)
    .where('removed_at', 'is', null)
    .orderBy('position')
    .orderBy('id')
    .execute()
  const sections: ChecklistSection[] = []
  const byKey = new Map<string, ChecklistSection>()
  for (const r of rows) {
    const key = `${r.section_kind}|${r.appointment_addon_id ?? ''}|${r.section_title}`
    let s = byKey.get(key)
    if (!s) {
      s = {
        kind: r.section_kind,
        title: r.section_title,
        addonId: r.appointment_addon_id,
        items: [],
        done: 0,
        total: 0,
        allDone: false,
      }
      byKey.set(key, s)
      sections.push(s)
    }
    s.items.push({ id: r.id, label: r.label, done: r.done, position: r.position })
    s.total += 1
    if (r.done) s.done += 1
  }
  for (const s of sections) s.allDone = s.total > 0 && s.done === s.total
  const done = sections.reduce((n, s) => n + s.done, 0)
  const total = sections.reduce((n, s) => n + s.total, 0)
  return { ...progressOf(done, total), sections }
}

export async function checklistProgress(db: Executor, appointmentId: string): Promise<ChecklistProgress> {
  const r = await db
    .selectFrom('job_checklist_items')
    .select([
      sql<number>`count(*)::int`.as('total'),
      sql<number>`count(*) filter (where done)::int`.as('done'),
    ])
    .where('appointment_id', '=', appointmentId)
    .where('removed_at', 'is', null)
    .executeTakeFirstOrThrow()
  return progressOf(r.done, r.total)
}

async function nextPosition(tx: Tx, appointmentId: string): Promise<number> {
  const r = await tx
    .selectFrom('job_checklist_items')
    .select(sql<number>`coalesce(max(position) + 1, 0)::int`.as('n'))
    .where('appointment_id', '=', appointmentId)
    .executeTakeFirstOrThrow()
  return r.n
}

/** The package section: the package's active tasks as they are right now (template edits later never touch it). */
export async function snapshotPackageChecklist(
  tx: Tx,
  c: SchedulingCtx,
  appointmentId: string,
  pkg: CatalogService,
): Promise<void> {
  if (pkg.tasks.length === 0) return
  await tx
    .insertInto('job_checklist_items')
    .values(
      pkg.tasks.map((t, i) => ({
        id: c.newId(),
        appointment_id: appointmentId,
        section_kind: 'package' as const,
        section_title: pkg.name,
        source_task_id: t.id,
        appointment_addon_id: null,
        label: t.label,
        position: i,
      })),
    )
    .execute()
}

/**
 * An add-on's section. A section hidden by an earlier removal comes back with its done marks; otherwise its tasks are
 * snapshotted after the existing ones (an add-on without tasks yields one task named after it).
 */
export async function addAddonChecklist(
  tx: Tx,
  c: SchedulingCtx,
  appointmentId: string,
  addonRowId: string,
  addon: CatalogService,
): Promise<void> {
  const hidden = await tx
    .selectFrom('job_checklist_items as i')
    .innerJoin('appointment_addons as ad', 'ad.id', 'i.appointment_addon_id')
    .select('i.id')
    .where('i.appointment_id', '=', appointmentId)
    .where('ad.service_id', '=', addon.id)
    .where('i.removed_at', 'is not', null)
    .execute()
  if (hidden.length > 0) {
    await tx
      .updateTable('job_checklist_items')
      .set({ removed_at: null, appointment_addon_id: addonRowId })
      .where(
        'id',
        'in',
        hidden.map((h) => h.id),
      )
      .execute()
    return
  }
  const labels = jobTasksFor(addon)
  const taskIds = new Map(addon.tasks.map((t) => [t.label, t.id]))
  const start = await nextPosition(tx, appointmentId)
  await tx
    .insertInto('job_checklist_items')
    .values(
      labels.map((label, i) => ({
        id: c.newId(),
        appointment_id: appointmentId,
        section_kind: 'addon' as const,
        section_title: addon.name,
        source_task_id: addon.tasks.length > 0 ? (taskIds.get(label) ?? null) : null,
        appointment_addon_id: addonRowId,
        label,
        position: start + i,
      })),
    )
    .execute()
}

export async function hideAddonChecklist(tx: Tx, c: SchedulingCtx, addonRowId: string): Promise<void> {
  await tx
    .updateTable('job_checklist_items')
    .set({ removed_at: c.clock.now() })
    .where('appointment_addon_id', '=', addonRowId)
    .where('removed_at', 'is', null)
    .execute()
}

export interface ChecklistChange {
  progress: ChecklistProgress
  changed: number
}

async function guardChecklistEdit(tx: Tx, c: SchedulingCtx, appointmentId: string): Promise<void> {
  const a = await lockAppointment(tx, c.locationId, appointmentId)
  if (a.status === 'canceled' || a.status === 'no_show') throw invalidTransition(a)
}

/** One task: done or not done, recording who and when. Idempotent. */
export async function setChecklistItem(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  appointmentId: string,
  itemId: string,
  done: boolean,
): Promise<ChecklistChange & { item: ChecklistItemView }> {
  await guardChecklistEdit(tx, c, appointmentId)
  const row = isUuid(itemId)
    ? await tx
        .selectFrom('job_checklist_items')
        .select(['id', 'label', 'position', 'done'])
        .where('id', '=', itemId)
        .where('appointment_id', '=', appointmentId)
        .where('removed_at', 'is', null)
        .forUpdate()
        .executeTakeFirst()
    : undefined
  if (!row) throw new AppError('NOT_FOUND', { detail: 'That checklist task does not exist' })
  let changed = 0
  if (row.done !== done) {
    await tx
      .updateTable('job_checklist_items')
      .set({
        done,
        done_at: done ? c.clock.now() : null,
        done_by_employee_id: done ? actor.auth.employeeId : null,
      })
      .where('id', '=', row.id)
      .execute()
    changed = 1
  }
  const progress = await checklistProgress(tx, appointmentId)
  if (changed)
    await publishOps(tx, c.locationId, {
      kpi: false,
      appointment: await versionOf(tx, appointmentId, 'checklist'),
    })
  return { progress, changed, item: { id: row.id, label: row.label, position: row.position, done } }
}

async function versionOf(
  tx: Tx,
  appointmentId: string,
  change: string,
): Promise<{ id: string; version: number; status: never; change: string }> {
  const a = await tx
    .selectFrom('appointments')
    .select(['id', 'version', 'status'])
    .where('id', '=', appointmentId)
    .executeTakeFirstOrThrow()
  return { id: a.id, version: a.version, status: a.status as never, change }
}

/** Check or clear many tasks at once (a section, or the global "Check all" with every task id). */
export async function bulkSetChecklist(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  appointmentId: string,
  itemIds: string[],
  done: boolean,
): Promise<ChecklistChange> {
  await guardChecklistEdit(tx, c, appointmentId)
  const ids = [...new Set(itemIds)]
  if (ids.some((i) => !isUuid(i)))
    throw new AppError('NOT_FOUND', { detail: 'That checklist task does not exist' })
  const live = ids.length
    ? await tx
        .selectFrom('job_checklist_items')
        .select(['id', 'done'])
        .where('appointment_id', '=', appointmentId)
        .where('removed_at', 'is', null)
        .where('id', 'in', ids)
        .forUpdate()
        .execute()
    : []
  if (live.length !== ids.length)
    throw new AppError('NOT_FOUND', { detail: 'That checklist task does not exist' })
  const toChange = live.filter((r) => r.done !== done).map((r) => r.id)
  if (toChange.length > 0) {
    await tx
      .updateTable('job_checklist_items')
      .set({
        done,
        done_at: done ? c.clock.now() : null,
        done_by_employee_id: done ? actor.auth.employeeId : null,
      })
      .where('id', 'in', toChange)
      .execute()
    await logActivity(tx, c, {
      appointmentId,
      text: done
        ? `${toChange.length} checklist task${toChange.length === 1 ? '' : 's'} marked done`
        : `${toChange.length} checklist task${toChange.length === 1 ? '' : 's'} reset`,
      channels: ['internal'],
      actor,
    })
    await audit(tx, c, actor, 'checklist.bulk', appointmentId, null, { done, count: toChange.length })
    await publishOps(tx, c.locationId, {
      kpi: false,
      appointment: await versionOf(tx, appointmentId, 'checklist'),
    })
  }
  return { progress: await checklistProgress(tx, appointmentId), changed: toChange.length }
}
