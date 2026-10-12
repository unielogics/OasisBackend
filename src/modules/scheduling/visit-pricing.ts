// What a visit costs at a vehicle size (ADR 0170, wave Q2): the bridge from the booking paths to the price book. Every path that
// books, adds an add-on, changes the size or previews a price comes through here, so the snapshot on the appointment (price_cents =
// the charge, list_price_cents, discount_bp, price_basis, the size and its label) is always the engine's.
//
// The size of a visit, in order: the size the caller names (a size of the shop that is on), then the size on file for the visit's
// vehicle (when that size is still on), else none: priced at the smallest size, the "starts at" price (basis unknown_class), and
// the appointment shows "Confirm size" until staff set it at the shop (class_confirmed_at).
import { sql } from 'kysely'
import type { Executor, Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import {
  loadPriceBook,
  quoteVisit,
  type MemberContext,
  type PricedLine,
  type PriceBook,
  type VisitQuote,
} from '../catalog/price-book.js'
import { requireVehicleClass } from '../catalog/vehicle-classes.js'
import type { PriceBasis } from '../customers/schema.js'
import { logActivity, type AppointmentRecord } from './appointments.js'
import type { Actor, SchedulingCtx } from './context.js'
import { formatUsdOps } from '../../platform/money.js'

/** Who may say a car's size: staff, the client (a verified website or link page), the AI assistant. */
export type ClassSource = 'staff' | 'client' | 'ai'

export interface VisitPricing {
  book: PriceBook
  member: MemberContext | null
  classKey: string | null
  classLabel: string | null
  quote: VisitQuote
}

/** The pricing summary every booking answer carries (the staff sheet, the website, links, the assistant). */
export interface PricingView {
  vehicleClass: string | null
  vehicleClassLabel: string | null
  /** How the package was priced: class, unknown_class (no size known), estimated (the size has no price), base, legacy. */
  basis: PriceBasis
  /** No size known yet: priced at the smallest size; staff confirm it at the shop. */
  needsSizeConfirm: boolean
  /** The size has no price of its own: charged the starting price; staff confirm the price at the shop. */
  needsPriceConfirm: boolean
  /** Priced as a member (the holder or a household member of an active membership). */
  member: boolean
  /**
   * A line's price depends on a size not known yet, or the size has no price of its own (basis unknown_class or estimated): the
   * client is told the exact price is confirmed at the shop. False for services with one price for every size.
   */
  confirmAtShop: boolean
  totals: VisitQuote['totals']
}

/** The size flags of an appointment (none on a visit priced before sizes, none once staff confirmed the size). */
export function sizeFlags(a: Pick<AppointmentRecord, 'priceBasis' | 'classConfirmedAt' | 'vehicleClass'>): {
  needsSizeConfirm: boolean
  needsPriceConfirm: boolean
} {
  const open = a.priceBasis !== 'legacy' && a.classConfirmedAt === null
  return {
    needsSizeConfirm: open && a.vehicleClass === null,
    needsPriceConfirm: open && a.vehicleClass !== null && a.priceBasis === 'estimated',
  }
}

/**
 * The size a visit is priced at: `explicit` (422 on `path` unless it is a size of the shop that is on), else the vehicle's size on
 * file when that size is on, else null.
 */
export async function resolveVisitClass(
  db: Executor,
  locationId: string,
  o: { explicit?: string | null; vehicleClass?: string | null; path?: string },
): Promise<string | null> {
  if (o.explicit) return (await requireVehicleClass(db, locationId, o.explicit, { active: true, path: o.path ?? 'vehicleClass' })).key
  if (!o.vehicleClass) return null
  const on = await db
    .selectFrom('vehicle_classes')
    .select('key')
    .where('location_id', '=', locationId)
    .where('key', '=', o.vehicleClass)
    .where('active', '=', true)
    .executeTakeFirst()
  return on ? on.key : null
}

/** The member context the engine prices a customer with: none when `memberPricing` is false or the port has no pricing. */
export async function memberFor(
  db: Executor,
  c: SchedulingCtx,
  customerId: string,
  memberPricing = true,
): Promise<MemberContext | null> {
  if (!memberPricing) return null
  return (await c.ports.memberships.pricingFor?.(db, { locationId: c.locationId, customerId })) ?? null
}

/**
 * The member's credits as if this visit had not spent any yet: a visit the membership already covered is priced again with the
 * credits its own redeems took (a size change after the coverage keeps the covered lines covered).
 */
export async function withVisitCredits(
  db: Executor,
  member: MemberContext | null,
  appointmentId: string,
): Promise<MemberContext | null> {
  if (!member) return null
  const rows = await db
    .selectFrom('membership_credit_events as e')
    .select((eb) => [eb.fn.coalesce('e.inclusion_id', 'e.rule_id').as('inclusion_id'), 'e.qty'])
    .where('e.appointment_id', '=', appointmentId)
    .where('e.kind', '=', 'redeem')
    // a redeem given back (a closure, or the visit changed after it was settled) holds no credit any more
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('membership_credit_events as x')
            .select('x.id')
            .whereRef('x.idempotency_key', '=', sql<string>`'restore:' || e.id::text`),
        ),
      ),
    )
    .execute()
  if (rows.length === 0) return member
  const spent = new Map<string, number>()
  for (const r of rows) if (r.inclusion_id) spent.set(r.inclusion_id, (spent.get(r.inclusion_id) ?? 0) + (r.qty ?? 1))
  return {
    ...member,
    inclusions: member.inclusions.map((i) =>
      i.left === null || !spent.has(i.id) ? i : { ...i, left: i.left + spent.get(i.id)! },
    ),
  }
}

/** Prices a visit: the package then the add-ons in order, at the size, for the member (or a guest). */
export async function priceVisit(
  db: Executor,
  c: SchedulingCtx,
  visit: { packageId: string; addonIds: readonly string[]; classKey: string | null; member: MemberContext | null },
): Promise<VisitPricing> {
  const book = await loadPriceBook(db, c.locationId)
  const quote = quoteVisit(book, { packageId: visit.packageId, addonIds: visit.addonIds, classKey: visit.classKey }, visit.member)
  return {
    book,
    member: visit.member,
    classKey: visit.classKey,
    classLabel: visit.classKey ? (book.labels.get(visit.classKey) ?? null) : null,
    quote,
  }
}

/** The snapshot columns of one priced line. */
export const lineColumns = (l: PricedLine): { price_cents: number; list_price_cents: number; discount_bp: number; price_basis: PriceBasis } => ({
  price_cents: l.chargeCents,
  list_price_cents: l.listCents,
  discount_bp: l.discountBp,
  price_basis: l.basis,
})

export function pricingView(p: VisitPricing, o: { confirmed?: boolean } = {}): PricingView {
  const pkg = p.quote.lines[0]!
  const flags = o.confirmed
    ? { needsSizeConfirm: false, needsPriceConfirm: false }
    : sizeFlags({ priceBasis: pkg.basis, classConfirmedAt: null, vehicleClass: p.classKey })
  return {
    vehicleClass: p.classKey,
    vehicleClassLabel: p.classLabel,
    basis: pkg.basis,
    ...flags,
    member: p.member !== null,
    confirmAtShop: !o.confirmed && p.quote.lines.some((l) => l.basis === 'unknown_class' || l.basis === 'estimated'),
    totals: p.quote.totals,
  }
}

/** Records the size on the car with who said it; a size staff set is only changed by staff. */
export async function recordVehicleClass(
  tx: Tx,
  vehicleId: string,
  classKey: string,
  source: ClassSource,
): Promise<boolean> {
  const r = await tx
    .updateTable('vehicles')
    .set({ vehicle_class: classKey, vehicle_class_source: source })
    .where('id', '=', vehicleId)
    .where((eb) =>
      eb.and([
        eb.or([eb('vehicle_class', 'is', null), eb('vehicle_class', '<>', classKey), eb('vehicle_class_source', '<>', source)]),
        ...(source === 'staff' ? [] : [eb.or([eb('vehicle_class_source', 'is', null), eb('vehicle_class_source', '<>', 'staff')])]),
      ]),
    )
    .executeTakeFirst()
  return Number(r.numUpdatedRows ?? 0) > 0
}

/** 422 on the field naming a vehicle that is not one of the customer's own. */
export const notTheirVehicle = (path: string): AppError =>
  new AppError('VALIDATION_FAILED', {
    detail: 'Pick one of the client’s vehicles.',
    errors: [{ path, message: 'Pick one of the client’s vehicles.' }],
  })

/**
 * A visit the membership already covered changed (the size, an add-on): it is settled again before the invoice sync, so the
 * coverage follows the visit (ADR 0170, wave Q2a review); a change of what is covered is noted on the visit. Nothing when the visit
 * holds no redeem yet. Throws the sync's 409 ADDON_REMOVE_OVERPAID when the new prices would leave the invoice overpaid.
 */
export async function resettleCoverage(tx: Tx, c: SchedulingCtx, actor: Actor, appointmentId: string): Promise<void> {
  const r = await c.ports.memberships.resettleCredit?.(tx, c, actor, appointmentId)
  if (!r || r.beforeCents === r.afterCents) return
  await logActivity(tx, c, {
    appointmentId,
    text: `Membership coverage updated · ${formatUsdOps(r.beforeCents)} → ${formatUsdOps(r.afterCents)}`,
    channels: ['internal'],
    actor,
  })
}
