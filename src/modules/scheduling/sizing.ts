// The size of a visit at the shop (ADR 0170, wave Q2):
//  * setAppointmentClass (PUT /appointments/:id/vehicle-class): staff set or confirm the car's size. The package and the live add-ons
//    are priced again at that size for the client (the member price, or the regular price on a line the membership covers), the
//    invoice follows, class_confirmed_at is stamped (no more "Confirm size" / "Confirm price"), the car on file gets the size
//    (source staff). A change that would leave the invoice overpaid is refused whole (409 PRICE_CHANGE_OVERPAID: refund or adjust
//    first). A visit the membership already covered is settled again at the new size (its own credits count as still there): a
//    line it covered stays covered, up to the plan size's price.
//  * quoteFor (POST /appointments/quote): the booking sheet's price preview, the same engine as the booking, nothing written.
import type { Executor, Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import { isUuid } from '../../platform/ids.js'
import { requireService } from '../catalog/service.js'
import { formatUsdOps as dollars } from '../../platform/money.js'
import { invalidTransition, lockAppointment, logActivity, publishOps, type AppointmentRecord } from './appointments.js'
import { audit } from './audit-helper.js'
import type { Actor, SchedulingCtx } from './context.js'
import { liveAddons, syncInvoiceItems } from './invoicing.js'
import { toCore, type CommandResult } from './lifecycle.js'
import type { InvoiceSummary } from './ports.js'
import {
  autoApplied,
  lineColumns,
  memberFor,
  notTheirVehicle,
  priceVisit,
  pricingView,
  recordVehicleClass,
  resettleCoverage,
  resolveVisitClass,
  withVisitCredits,
  type PricingView,
} from './visit-pricing.js'
import './problems.js'

export interface ClassChangeResult extends CommandResult {
  invoice: InvoiceSummary
}

export async function setAppointmentClass(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  id: string,
  input: { vehicleClass: string; version?: number },
): Promise<ClassChangeResult> {
  const a = await lockAppointment(tx, c.locationId, id)
  if (input.version !== undefined && input.version !== a.version)
    throw new AppError('VERSION_CONFLICT', { meta: { currentVersion: a.version } })
  if (a.status === 'canceled' || a.status === 'no_show') throw invalidTransition(a)
  const classKey = (await resolveVisitClass(tx, c.locationId, { explicit: input.vehicleClass }))!
  const addons = await liveAddons(tx, a.id)
  // the visit's own credits count as still there, so a line the membership covered stays covered at the new size
  const member = await withVisitCredits(tx, await memberFor(tx, c, a.customerId), a.id)
  const priced = await priceVisit(tx, c, {
    packageId: a.serviceId,
    addonIds: addons.map((x) => x.serviceId),
    classKey,
    member,
  })
  const [pkg, ...rest] = priced.quote.lines
  const now = c.clock.now()
  await tx
    .updateTable('appointments')
    .set((eb) => ({
      ...lineColumns(pkg!),
      vehicle_class: classKey,
      vehicle_class_label: priced.classLabel,
      class_confirmed_at: now,
      version: eb('version', '+', 1),
      updated_at: eb.fn('app_now', []),
    }))
    .where('id', '=', a.id)
    .execute()
  for (const [i, x] of addons.entries())
    await tx.updateTable('appointment_addons').set(lineColumns(rest[i]!)).where('id', '=', x.id).execute()
  let fresh: AppointmentRecord
  let invoice: InvoiceSummary
  try {
    // a visit the membership already covered is settled again at the new size (the plan covers up to its size's price)
    await resettleCoverage(tx, c, actor, a.id)
    fresh = await lockAppointment(tx, c.locationId, a.id)
    invoice = await syncInvoiceItems(tx, c, fresh, { relabel: true })
  } catch (e) {
    // the gateway's overpaid guard in the words of a size change (the whole change rolls back with the transaction)
    if (e instanceof AppError && e.code === 'ADDON_REMOVE_OVERPAID') throw new AppError('PRICE_CHANGE_OVERPAID', { cause: e })
    throw e
  }
  if (a.vehicleId) await recordVehicleClass(tx, a.vehicleId, classKey, 'staff')
  const before = a.priceCents + addons.reduce((n, x) => n + x.priceCents, 0)
  const after = priced.quote.lines.reduce((n, l) => n + l.chargeCents, 0)
  const label = priced.classLabel ?? classKey
  const same = a.vehicleClass === classKey
  await logActivity(tx, c, {
    appointmentId: a.id,
    text:
      same && before === after
        ? `Size confirmed · ${label}`
        : `Size ${same ? 'confirmed' : 'changed'} · ${a.vehicleClassLabel && !same ? `${a.vehicleClassLabel} → ` : ''}${label}${before !== after ? ` · ${dollars(before)} → ${dollars(after)}` : ''}`,
    channels: ['internal'],
    actor,
  })
  await audit(
    tx,
    c,
    actor,
    'vehicle_class.set',
    a.id,
    { vehicleClass: a.vehicleClass, priceBasis: a.priceBasis, linesCents: before },
    { vehicleClass: classKey, priceBasis: pkg!.basis, linesCents: after },
  )
  await publishOps(tx, c.locationId, {
    appointment: { id: a.id, version: fresh.version, status: fresh.status, change: 'pricing' },
  })
  return {
    appointment: await toCore(tx, c, fresh),
    toast: { title: 'Size updated', detail: `${label} · ${dollars(after)}` },
    warnings: [],
    invoice,
  }
}

export interface QuoteInput {
  customerId?: string | null
  serviceId: string
  addonIds?: string[]
  vehicleId?: string | null
  vehicleClass?: string | null
}

export interface QuoteLine {
  serviceId: string
  name: string
  kind: 'package' | 'addon'
  listCents: number
  listMaxCents: number | null
  chargeCents: number
  memberDiscountCents: number
  discountBp: number
  basis: PricingView['basis']
  coverage: { label: string; coveredCents: number; differenceCents: number; planClassLabel: string | null } | null
  dueCents: number
}

export interface QuoteResult {
  pricing: PricingView
  member: { tierName: string; planClass: string; planClassLabel: string | null; discountBp: number; household: boolean } | null
  lines: QuoteLine[]
}

/** The booking sheet's preview: the same size and member rules as the booking itself; nothing is written. */
export async function quoteFor(db: Executor, c: SchedulingCtx, input: QuoteInput): Promise<QuoteResult> {
  const pkg = await requireService(db, c.locationId, input.serviceId)
  if (pkg.kind !== 'package') throw bad('serviceId', 'Pick a package.')
  const addons = []
  for (const id of [...new Set(input.addonIds ?? [])]) {
    const s = await requireService(db, c.locationId, id)
    if (s.kind !== 'addon') throw bad('addonIds', 'Pick add-ons from the catalog.')
    addons.push(s)
  }
  let vehicleClass: string | null = null
  if (input.vehicleId) {
    if (!input.customerId || !isUuid(input.vehicleId)) throw notTheirVehicle('vehicleId')
    const v = await db
      .selectFrom('vehicles')
      .select('vehicle_class')
      .where('id', '=', input.vehicleId)
      .where('customer_id', '=', input.customerId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
    if (!v) throw notTheirVehicle('vehicleId')
    vehicleClass = v.vehicle_class
  }
  const classKey = await resolveVisitClass(db, c.locationId, { explicit: input.vehicleClass, vehicleClass })
  const customer =
    input.customerId && isUuid(input.customerId)
      ? await db.selectFrom('customers').select('id').where('id', '=', input.customerId).where('deleted_at', 'is', null).executeTakeFirst()
      : undefined
  if (input.customerId && !customer) throw new AppError('NOT_FOUND', { detail: 'That customer does not exist' })
  // the quote shows as covered only what the booking will cover (sandbox run F1)
  const member = customer ? autoApplied(await memberFor(db, c, customer.id)) : null
  const priced = await priceVisit(db, c, { packageId: pkg.id, addonIds: addons.map((a) => a.id), classKey, member })
  const names = [pkg, ...addons]
  return {
    pricing: pricingView(priced),
    member: member
      ? {
          tierName: member.tierName,
          planClass: member.planClass,
          planClassLabel: priced.book.labels.get(member.planClass) ?? null,
          discountBp: member.discountBp,
          household: member.viaHousehold,
        }
      : null,
    lines: priced.quote.lines.map((l, i) => ({
      serviceId: l.serviceId,
      name: names[i]!.name,
      kind: i === 0 ? ('package' as const) : ('addon' as const),
      listCents: l.listCents,
      listMaxCents: l.listMaxCents,
      chargeCents: l.chargeCents,
      memberDiscountCents: l.memberDiscountCents,
      discountBp: l.discountBp,
      basis: l.basis,
      coverage: l.coverage
        ? {
            label: l.coverage.label,
            coveredCents: l.coverage.coveredCents,
            differenceCents: l.coverage.differenceCents,
            planClassLabel: priced.book.labels.get(l.coverage.planClass) ?? null,
          }
        : null,
      dueCents: l.dueCents,
    })),
  }
}

const bad = (path: string, message: string): AppError =>
  new AppError('VALIDATION_FAILED', { detail: message, errors: [{ path, message }] })
