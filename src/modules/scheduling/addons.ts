// Add-on operations. The price is always the catalog's, snapshotted on the appointment; the invoice and the checklist
// follow. Allowed at any status except canceled and no-show. Removing an add-on that would leave the invoice overpaid is
// refused by the invoice gateway (409 ADDON_REMOVE_OVERPAID) and rolls the whole change back.
import type { Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { requireService } from '../catalog/service.js'
import '../customers/schema.js'
import { invalidTransition, lockAppointment, logActivity, publishOps } from './appointments.js'
import { audit } from './audit-helper.js'
import { addAddonChecklist, checklistProgress, hideAddonChecklist, type ChecklistProgress } from './checklist.js'
import type { Actor, SchedulingCtx } from './context.js'
import { liveAddons, syncInvoiceItems } from './invoicing.js'
import type { InvoiceSummary } from './ports.js'
import './problems.js'

export interface AddonChange {
  /** The add-on is on the appointment after the call (what the toast direction follows). */
  added: boolean
  /** Whether anything changed. */
  changed: boolean
  addon: { serviceId: string; name: string; priceCents: number }
  invoice: InvoiceSummary
  checklist: ChecklistProgress
  toast: { title: string; detail: string }
}

export async function addAddon(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  appointmentId: string,
  serviceId: string,
): Promise<AddonChange> {
  const a = await lockAppointment(tx, c.locationId, appointmentId)
  if (a.status === 'canceled' || a.status === 'no_show') throw invalidTransition(a)
  const svc = await requireService(tx, c.locationId, serviceId)
  if (svc.kind !== 'addon') throw new AppError('NOT_AN_ADDON')
  if (!svc.active) throw new AppError('NOT_AN_ADDON', { detail: 'That add-on is no longer offered' })
  const live = (await liveAddons(tx, a.id)).find((x) => x.serviceId === svc.id)
  let changed = false
  if (!live) {
    const rowId = c.newId()
    await tx
      .insertInto('appointment_addons')
      .values({
        id: rowId,
        appointment_id: a.id,
        service_id: svc.id,
        name: svc.name,
        price_cents: svc.priceCents,
        added_by: actor.auth.userId,
      })
      .execute()
    await addAddonChecklist(tx, c, a.id, rowId, svc)
    changed = true
  }
  const invoice = await syncInvoiceItems(tx, c, a)
  if (changed) {
    await tx
      .updateTable('appointments')
      .set((eb) => ({ version: eb('version', '+', 1), updated_at: eb.fn('app_now', []) }))
      .where('id', '=', a.id)
      .execute()
    await logActivity(tx, c, {
      appointmentId: a.id,
      text: `Add-on added · ${svc.name}`,
      channels: ['internal'],
      actor,
    })
    await audit(tx, c, actor, 'addon.add', a.id, null, { serviceId: svc.id, name: svc.name, priceCents: svc.priceCents })
    await publishOps(tx, c.locationId, {
      appointment: { id: a.id, version: a.version + 1, status: a.status, change: 'addons' },
    })
  }
  return {
    added: true,
    changed,
    addon: { serviceId: svc.id, name: svc.name, priceCents: live?.priceCents ?? svc.priceCents },
    invoice,
    checklist: await checklistProgress(tx, a.id),
    toast: { title: 'Invoice + checklist updated', detail: `Added ${svc.name}` },
  }
}

export async function removeAddon(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  appointmentId: string,
  serviceId: string,
): Promise<AddonChange> {
  const a = await lockAppointment(tx, c.locationId, appointmentId)
  if (a.status === 'canceled' || a.status === 'no_show') throw invalidTransition(a)
  const live = (await liveAddons(tx, a.id)).find((x) => x.serviceId === serviceId)
  if (!live) {
    const svc = await requireService(tx, c.locationId, serviceId)
    return {
      added: false,
      changed: false,
      addon: { serviceId: svc.id, name: svc.name, priceCents: svc.priceCents },
      invoice: await syncInvoiceItems(tx, c, a),
      checklist: await checklistProgress(tx, a.id),
      toast: { title: 'Invoice + checklist updated', detail: `Removed ${svc.name}` },
    }
  }
  await tx
    .updateTable('appointment_addons')
    .set({ removed_at: c.clock.now() })
    .where('id', '=', live.id)
    .execute()
  await hideAddonChecklist(tx, c, live.id)
  const invoice = await syncInvoiceItems(tx, c, a)
  await tx
    .updateTable('appointments')
    .set((eb) => ({ version: eb('version', '+', 1), updated_at: eb.fn('app_now', []) }))
    .where('id', '=', a.id)
    .execute()
  await logActivity(tx, c, {
    appointmentId: a.id,
    text: `Add-on removed · ${live.name}`,
    channels: ['internal'],
    actor,
  })
  await audit(tx, c, actor, 'addon.remove', a.id, { serviceId, name: live.name, priceCents: live.priceCents }, null)
  await publishOps(tx, c.locationId, {
    appointment: { id: a.id, version: a.version + 1, status: a.status, change: 'addons' },
  })
  return {
    added: false,
    changed: true,
    addon: { serviceId, name: live.name, priceCents: live.priceCents },
    invoice,
    checklist: await checklistProgress(tx, a.id),
    toast: { title: 'Invoice + checklist updated', detail: `Removed ${live.name}` },
  }
}
