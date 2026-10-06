// The bridge to the InvoiceGateway: builds its inputs from appointment rows.
import type { Executor, Tx } from '../../platform/db.js'
import { displayName } from '../auth/context.js'
import '../people/schema.js'
import { customerBrief, vehicleBrief, vehicleLabel, type AppointmentRecord } from './appointments.js'
import type { SchedulingCtx } from './context.js'
import type { InvoiceItem, InvoiceSummary } from './ports.js'

/** "Marco R." for an employee, "Unassigned" for none. */
export async function staffLabel(db: Executor, employeeId: string | null): Promise<string> {
  if (!employeeId) return 'Unassigned'
  const e = await db
    .selectFrom('employees')
    .select(['first', 'last'])
    .where('id', '=', employeeId)
    .executeTakeFirst()
  return e ? displayName(e.first, e.last) : 'Unassigned'
}

export async function liveAddons(
  db: Executor,
  appointmentId: string,
): Promise<{ id: string; serviceId: string; name: string; priceCents: number }[]> {
  const rows = await db
    .selectFrom('appointment_addons')
    .select(['id', 'service_id', 'name', 'price_cents'])
    .where('appointment_id', '=', appointmentId)
    .where('removed_at', 'is', null)
    .orderBy('added_at')
    .orderBy('id')
    .execute()
  return rows.map((r) => ({ id: r.id, serviceId: r.service_id, name: r.name, priceCents: r.price_cents }))
}

/** The package line then one line per live add-on, as the invoice lists them. */
export async function invoiceItemsOf(db: Executor, a: AppointmentRecord): Promise<InvoiceItem[]> {
  const addons = await liveAddons(db, a.id)
  return [
    { name: a.packageName, priceCents: a.priceCents, kind: 'package' },
    ...addons.map((x) => ({ name: x.name, priceCents: x.priceCents, kind: 'addon' as const })),
  ]
}

/** Creates the appointment's invoice (or refreshes its date and revives it after a reopen). */
export async function ensureInvoiceFor(
  tx: Tx,
  c: SchedulingCtx,
  a: AppointmentRecord,
): Promise<InvoiceSummary> {
  const [customer, vehicle, staff, addons] = await Promise.all([
    customerBrief(tx, a.customerId),
    vehicleBrief(tx, a.vehicleId),
    staffLabel(tx, a.assignedEmployeeId),
    liveAddons(tx, a.id),
  ])
  return c.ports.invoices.ensureForAppointment(tx, {
    appointmentId: a.id,
    locationId: a.locationId,
    customerId: a.customerId,
    clientName: customer.fullName,
    vehicleLabel: vehicleLabel(vehicle),
    staffLabel: staff,
    occurredAt: a.scheduledStart,
    packageName: a.packageName,
    packagePriceCents: a.priceCents,
    addons: addons.map((x) => ({ name: x.name, priceCents: x.priceCents })),
  })
}

export async function syncInvoiceItems(
  tx: Tx,
  c: SchedulingCtx,
  a: AppointmentRecord,
): Promise<InvoiceSummary> {
  return c.ports.invoices.syncItems(tx, a.id, await invoiceItemsOf(tx, a))
}
