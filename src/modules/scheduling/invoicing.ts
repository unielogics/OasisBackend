// The bridge to the InvoiceGateway: builds its inputs from appointment rows.
import type { Executor, Tx } from '../../platform/db.js'
import { displayName } from '../auth/context.js'
import '../people/schema.js'
import type { PriceBasis } from '../customers/schema.js'
import { customerBrief, vehicleBrief, vehicleLabel, type AppointmentRecord } from './appointments.js'
import type { Actor, SchedulingCtx } from './context.js'
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

export interface LiveAddon {
  id: string
  serviceId: string
  name: string
  /** What the line charges. */
  priceCents: number
  /** The regular price at the visit's size, the member % off and how it was priced (ADR 0170); null/legacy before sizes. */
  listPriceCents: number | null
  discountBp: number | null
  priceBasis: PriceBasis
}

export async function liveAddons(db: Executor, appointmentId: string): Promise<LiveAddon[]> {
  const rows = await db
    .selectFrom('appointment_addons')
    .select(['id', 'service_id', 'name', 'price_cents', 'list_price_cents', 'discount_bp', 'price_basis'])
    .where('appointment_id', '=', appointmentId)
    .where('removed_at', 'is', null)
    .orderBy('added_at')
    .orderBy('id')
    .execute()
  return rows.map((r) => ({
    id: r.id,
    serviceId: r.service_id,
    name: r.name,
    priceCents: r.price_cents,
    listPriceCents: r.list_price_cents,
    discountBp: r.discount_bp,
    priceBasis: r.price_basis,
  }))
}

const lineOf = (x: { priceCents: number; listPriceCents: number | null; discountBp: number | null; priceBasis: PriceBasis }) => ({
  priceCents: x.priceCents,
  listCents: x.listPriceCents,
  discountBp: x.discountBp,
  basis: x.priceBasis,
})

/** The package line then one line per live add-on, as the invoice lists them. */
export async function invoiceItemsOf(db: Executor, a: AppointmentRecord): Promise<InvoiceItem[]> {
  const addons = await liveAddons(db, a.id)
  return [
    { name: a.packageName, kind: 'package', ...lineOf(a) },
    ...addons.map((x) => ({ name: x.name, kind: 'addon' as const, ...lineOf(x) })),
  ]
}

/** Creates the appointment's invoice (or refreshes its date and revives it after a reopen), audited as `actor`'s request. */
export async function ensureInvoiceFor(
  tx: Tx,
  c: SchedulingCtx,
  a: AppointmentRecord,
  actor?: Actor,
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
    packageListCents: a.listPriceCents,
    packageDiscountBp: a.discountBp,
    packageBasis: a.priceBasis,
    addons: addons.map((x) => ({ name: x.name, ...lineOf(x) })),
    vehicleClassLabel: a.vehicleClassLabel,
    ...(actor ? { audit: actor.audit } : {}),
  })
}

/** Re-reads the appointment's lines and replaces the invoice's; `relabel` also writes the visit's size label on the invoice. */
export async function syncInvoiceItems(
  tx: Tx,
  c: SchedulingCtx,
  a: AppointmentRecord,
  o: { relabel?: boolean } = {},
): Promise<InvoiceSummary> {
  const items = await invoiceItemsOf(tx, a)
  return o.relabel
    ? c.ports.invoices.syncItems(tx, a.id, items, { vehicleClassLabel: a.vehicleClassLabel })
    : c.ports.invoices.syncItems(tx, a.id, items)
}
