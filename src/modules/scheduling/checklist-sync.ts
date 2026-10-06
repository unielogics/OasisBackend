// ChecklistSync: propagates a template edit (PUT /services/:id/checklist) to the jobs that have not started. Matching is
// by source_task_id, never by label. Jobs in cleaning, completed, canceled or no-show are never touched.
//   rename  the label changes on every untouched job
//   add     the new task joins the section
//   remove  a retired task disappears unless someone already checked it
//   order   the section follows the template order again
import { sql, type ExpressionBuilder } from 'kysely'
import type { Database, Tx } from '../../platform/db.js'
import type { CatalogService, PutChecklistResult } from '../catalog/service.js'
import '../customers/schema.js'
import type { SchedulingCtx } from './context.js'

export interface SyncResult {
  jobs: number
  renamed: number
  added: number
  removed: number
  restored: number
}

const NOT_STARTED = ['booked', 'confirmed', 'arrived'] as const

/** The rows of one section: the package's, or one add-on's. */
const inSection = (addonId: string | null) => (eb: ExpressionBuilder<Database, 'job_checklist_items'>) =>
  addonId === null
    ? eb.and([eb('appointment_addon_id', 'is', null), eb('section_kind', '=', 'package')])
    : eb('appointment_addon_id', '=', addonId)

/** `plan` and `service` come from the catalog's putChecklist result, in the same transaction. */
export async function syncChecklistTemplate(
  tx: Tx,
  c: Pick<SchedulingCtx, 'newId' | 'clock' | 'locationId'>,
  input: { service: CatalogService; plan: PutChecklistResult['plan'] },
): Promise<SyncResult> {
  const { service, plan } = input
  const out: SyncResult = { jobs: 0, renamed: 0, added: 0, removed: 0, restored: 0 }
  const changed =
    plan.renamed.length +
      plan.created.length +
      plan.retired.length +
      plan.revived.length +
      plan.moved.length >
    0
  if (!changed) return out

  // the sections to touch: [appointmentId, addonRowId | null]
  const sections: { appointmentId: string; addonId: string | null }[] =
    service.kind === 'package'
      ? (
          await tx
            .selectFrom('appointments')
            .select('id')
            .where('location_id', '=', c.locationId)
            .where('service_id', '=', service.id)
            .where('status', 'in', [...NOT_STARTED])
            .execute()
        ).map((r) => ({ appointmentId: r.id, addonId: null }))
      : (
          await tx
            .selectFrom('appointment_addons as ad')
            .innerJoin('appointments as a', 'a.id', 'ad.appointment_id')
            .select(['a.id as appointment_id', 'ad.id as addon_id'])
            .where('a.location_id', '=', c.locationId)
            .where('ad.service_id', '=', service.id)
            .where('ad.removed_at', 'is', null)
            .where('a.status', 'in', [...NOT_STARTED])
            .execute()
        ).map((r) => ({ appointmentId: r.appointment_id, addonId: r.addon_id }))

  const templateOrder = new Map(service.tasks.map((t, i) => [t.id, i]))
  const now = c.clock.now()
  for (const s of sections) {
    out.jobs += 1
    // renames
    for (const r of plan.renamed) {
      const upd = await tx
        .updateTable('job_checklist_items')
        .where(inSection(s.addonId))
        .set({ label: r.to })
        .where('appointment_id', '=', s.appointmentId)
        .where('source_task_id', '=', r.id)
        .where('label', '<>', r.to)
        .returning('id')
        .execute()
      out.renamed += upd.length
    }
    // retired tasks vanish unless already checked
    if (plan.retired.length > 0) {
      const upd = await tx
        .updateTable('job_checklist_items')
        .where(inSection(s.addonId))
        .set({ removed_at: now })
        .where('appointment_id', '=', s.appointmentId)
        .where('removed_at', 'is', null)
        .where('done', '=', false)
        .where(
          'source_task_id',
          'in',
          plan.retired.map((t) => t.id),
        )
        .returning('id')
        .execute()
      out.removed += upd.length
    }
    // revived tasks come back where they were hidden
    if (plan.revived.length > 0) {
      const upd = await tx
        .updateTable('job_checklist_items')
        .where(inSection(s.addonId))
        .set({ removed_at: null })
        .where('appointment_id', '=', s.appointmentId)
        .where('removed_at', 'is not', null)
        .where('source_task_id', 'in', plan.revived)
        .returning('id')
        .execute()
      out.restored += upd.length
    }
    // new tasks join the section
    const present = await tx
      .selectFrom('job_checklist_items')
      .select(['source_task_id'])
      .where('appointment_id', '=', s.appointmentId)
      .where('source_task_id', 'in', plan.createdIds.length ? plan.createdIds : [c.newId()])
      .execute()
    const have = new Set(present.map((p) => p.source_task_id))
    const todo = plan.created
      .map((t, i) => ({ id: plan.createdIds[i]!, label: t.label }))
      .filter((t) => !have.has(t.id))
    if (todo.length > 0) {
      const max = await tx
        .selectFrom('job_checklist_items')
        .select(sql<number>`coalesce(max(position) + 1, 0)::int`.as('n'))
        .where('appointment_id', '=', s.appointmentId)
        .executeTakeFirstOrThrow()
      const title = await tx
        .selectFrom('job_checklist_items')
        .select('section_title')
        .where('appointment_id', '=', s.appointmentId)
        .where(inSection(s.addonId))
        .limit(1)
        .executeTakeFirst()
      await tx
        .insertInto('job_checklist_items')
        .values(
          todo.map((t, i) => ({
            id: c.newId(),
            appointment_id: s.appointmentId,
            section_kind: service.kind === 'package' ? ('package' as const) : ('addon' as const),
            section_title: title?.section_title ?? service.name,
            source_task_id: t.id,
            appointment_addon_id: s.addonId,
            label: t.label,
            position: max.n + i,
          })),
        )
        .execute()
      out.added += todo.length
      // an add-on that only had the fallback task named after it drops it once it has real tasks
      if (service.kind === 'addon')
        await tx
          .updateTable('job_checklist_items')
          .set({ removed_at: now })
          .where('appointment_addon_id', '=', s.addonId!)
          .where('source_task_id', 'is', null)
          .where('done', '=', false)
          .where('removed_at', 'is', null)
          .execute()
    }
    // the section follows the template order again, reusing the positions it already occupies
    const items = await tx
      .selectFrom('job_checklist_items')
      .select(['id', 'source_task_id', 'position'])
      .where('appointment_id', '=', s.appointmentId)
      .where('removed_at', 'is', null)
      .where(inSection(s.addonId))
      .execute()
    const ordered = [...items].sort(
      (a, b) =>
        (templateOrder.get(a.source_task_id ?? '') ?? 10_000 + a.position) -
          (templateOrder.get(b.source_task_id ?? '') ?? 10_000 + b.position) || a.position - b.position,
    )
    const slots = items.map((i) => i.position).sort((a, b) => a - b)
    for (const [i, item] of ordered.entries())
      if (item.position !== slots[i]) {
        await tx
          .updateTable('job_checklist_items')
          .set({ position: slots[i]! })
          .where('id', '=', item.id)
          .execute()
      }
  }
  return out
}
