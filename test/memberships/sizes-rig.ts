// Helpers of the wave Q2 tests (ADR 0170): prices by size on the design catalog, a tier with chosen inclusions and % off, members at
// a plan size, cars with a size, and bookings through the real route.
import { sql } from 'kysely'
import { expect } from 'vitest'
import { ensureVehicleClasses } from '../../src/modules/catalog/vehicle-classes.js'
import type { MemRig } from './harness.js'

export const SAT = '2026-06-13T14:00:00-04:00'

export async function serviceIdOf(m: MemRig, name: string): Promise<string> {
  return (await m.h.t.db.selectFrom('services').select('id').where('name', '=', name).executeTakeFirstOrThrow()).id
}

/** The regular price of a service at each size named (cents); other sizes stay unset. */
export async function setCells(m: MemRig, name: string, cells: Record<string, number>): Promise<void> {
  await ensureVehicleClasses(m.h.t.db, m.locationId())
  const id = await serviceIdOf(m, name)
  await m.h.t.db.deleteFrom('service_class_prices').where('service_id', '=', id).execute()
  for (const [cls, cents] of Object.entries(cells))
    await m.h.t.db
      .insertInto('service_class_prices')
      .values({ service_id: id, location_id: m.locationId(), class_key: cls, price_cents: cents })
      .execute()
}

export interface InclusionSpec {
  label: string
  services: string[]
  mode?: 'per_cycle' | 'every_visit'
  perCycle?: number | null
  autoApply?: boolean
}

/** Replaces a tier's inclusions and sets its member % off (basis points). Returns the inclusion ids in order. */
export async function setTier(
  m: MemRig,
  key: string,
  o: { discountBp?: number; inclusions: InclusionSpec[] },
): Promise<string[]> {
  const db = m.h.t.db
  const plan = await db
    .selectFrom('membership_plans')
    .select('id')
    .where('location_id', '=', m.locationId())
    .where('key', '=', key)
    .executeTakeFirstOrThrow()
  await db.updateTable('membership_plans').set({ member_discount_bp: o.discountBp ?? 0 }).where('id', '=', plan.id).execute()
  await db.deleteFrom('membership_inclusions').where('plan_id', '=', plan.id).execute()
  const ids: string[] = []
  for (const [i, inc] of o.inclusions.entries()) {
    const id = m.h.t.app.newId()
    ids.push(id)
    await db
      .insertInto('membership_inclusions')
      .values({
        id,
        plan_id: plan.id,
        label: inc.label,
        mode: inc.mode ?? 'per_cycle',
        per_cycle: inc.mode === 'every_visit' ? null : inc.perCycle === undefined ? 2 : inc.perCycle,
        auto_apply: inc.autoApply ?? true,
        sort: i,
      })
      .execute()
    for (const s of inc.services)
      await db.insertInto('membership_inclusion_services').values({ inclusion_id: id, service_id: await serviceIdOf(m, s) }).execute()
  }
  return ids
}

/** A tier's current monthly price at a size. */
export async function setTierPrice(m: MemRig, key: string, cls: string, cents: number): Promise<void> {
  await ensureVehicleClasses(m.h.t.db, m.locationId())
  const plan = await m.h.t.db
    .selectFrom('membership_plans')
    .select(['id', 'price_version'])
    .where('location_id', '=', m.locationId())
    .where('key', '=', key)
    .executeTakeFirstOrThrow()
  await sql`update membership_tier_prices set superseded_at = app_now()
    where plan_id = ${plan.id} and class_key = ${cls} and superseded_at is null`.execute(m.h.t.db)
  await m.h.t.db
    .insertInto('membership_tier_prices')
    .values({
      id: m.h.t.app.newId(),
      location_id: m.locationId(),
      plan_id: plan.id,
      class_key: cls,
      monthly_cents: cents,
      price_version: plan.price_version,
    })
    .execute()
}

/** A member through the real route, at a plan size. */
export async function memberAt(m: MemRig, name: string, plan: string, planClass: string): Promise<{ id: string; customerId: string }> {
  await ensureVehicleClasses(m.h.t.db, m.locationId())
  const customerId = await m.customer(name)
  const res = await m.send(m.superS(), 'POST', '/memberships', { customerId, planKey: plan, planClass, renewsOn: '2026-07-12' })
  expect(res.statusCode, res.body).toBe(201)
  return { id: (res.json() as { membership: { id: string } }).membership.id, customerId }
}

/** A car on file for the customer, with a size when given. */
export async function carOf(m: MemRig, name: string, o: { make: string; model: string; cls?: string; source?: 'staff' | 'client' | 'ai' | 'legacy' }): Promise<string> {
  const id = m.h.t.app.newId()
  await m.h.t.db
    .insertInto('vehicles')
    .values({
      id,
      customer_id: await m.customer(name),
      make: o.make,
      model: o.model,
      year: null,
      color: null,
      plate: null,
      deleted_at: null,
      vehicle_class: o.cls ?? null,
      vehicle_class_source: o.cls ? (o.source ?? 'staff') : null,
    })
    .execute()
  return id
}

export interface Booked {
  appointmentId: string
  invoiceId: string
  body: Record<string, unknown> & {
    appointment: { id: string; version: number; vehicleClass: string | null; needsSizeConfirm: boolean; needsPriceConfirm: boolean }
    pricing: { vehicleClass: string | null; basis: string; member: boolean; confirmAtShop: boolean; totals: Record<string, number> }
    invoice: { items: { name: string; priceCents: number; listCents?: number | null }[] }
  }
}

/** A booking through POST /appointments with the wave Q2 fields. */
export async function bookAt(
  m: MemRig,
  customerName: string,
  service: string,
  o: { start?: string; vehicleClass?: string | null; vehicleId?: string; addons?: string[]; vehicle?: Record<string, unknown> } = {},
): Promise<Booked> {
  const res = await m.send(m.superS(), 'POST', '/appointments', {
    customer: { id: await m.customer(customerName) },
    serviceId: await serviceIdOf(m, service),
    start: o.start ?? SAT,
    ...(o.vehicleClass !== undefined ? { vehicleClass: o.vehicleClass } : {}),
    ...(o.vehicleId ? { vehicleId: o.vehicleId } : {}),
    ...(o.vehicle ? { vehicle: o.vehicle } : {}),
    ...(o.addons ? { addonIds: await Promise.all(o.addons.map((a) => serviceIdOf(m, a))) } : {}),
  })
  expect(res.statusCode, res.body).toBe(201)
  const body = res.json() as Booked['body']
  const inv = await m.h.t.db.selectFrom('invoices').select('id').where('appointment_id', '=', body.appointment.id).executeTakeFirstOrThrow()
  return { appointmentId: body.appointment.id, invoiceId: inv.id, body }
}

export async function apptRow(m: MemRig, id: string) {
  return m.h.t.db
    .selectFrom('appointments')
    .select(['price_cents', 'list_price_cents', 'discount_bp', 'price_basis', 'vehicle_class', 'vehicle_class_label', 'class_confirmed_at', 'membership_id', 'vehicle_id', 'version'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
}

export async function itemsOf(m: MemRig, invoiceId: string) {
  return m.h.t.db
    .selectFrom('invoice_items')
    .select(['kind', 'name', 'price_cents', 'list_cents', 'discount_bp', 'price_basis'])
    .where('invoice_id', '=', invoiceId)
    .orderBy('position')
    .execute()
}

export async function calcOfInvoice(m: MemRig, invoiceId: string) {
  return m.h.t.db
    .selectFrom('invoice_calc')
    .select(['sub', 'adj', 'tax', 'total', 'paid', 'balance'])
    .where('invoice_id', '=', invoiceId)
    .executeTakeFirstOrThrow()
}
