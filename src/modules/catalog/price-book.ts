// The price book (ADR 0170): what a visit costs at a vehicle size, for a member or a guest. One engine for the staff booking sheet,
// the website, personal links, the assistant and the invoice (pure functions over a loaded book; the loaders are at the end).
//
// 1. Price at a size (classPrice). A service has one regular price per size (service_class_prices; max_cents makes a range).
//      the size's own cell                                   basis 'class'
//      no size known, or a size that is unknown or off       the first active size's cell, else the starting price: 'unknown_class'
//      a known size without a price                          the starting price (the lowest set cell): 'estimated' ("confirm price")
//      a service without any price by size                   services.price_cents: 'base'
//    The starting price ("from $40") is the lowest cell over the active sizes (fromPrice).
// 2. A member (MemberContext: the holder or a household member of an ACTIVE membership).
//      covered   the first active inclusion that names the service and can still cover it (every_visit, or per_cycle with a credit
//                left / unlimited) covers min(price at the visit size, price at the plan size — that size's own cell even
//                when the size is off now); the line is charged the regular
//                price and the size difference (line - covered) stays due. No % off on a covered line, nor on its difference.
//      other     the member price: price x (1 - tier %), rounded half up to whole dollars (never above the price; 0% = the price).
// Money is integer cents; nothing here reads the clock or the database.
import { sql } from 'kysely'
import type { Executor } from '../../platform/db.js'
import { divHalfUp } from '../../platform/money.js'
import { getSetting, type SettingValue } from '../../platform/settings.js'
import type { PriceBasis } from '../customers/schema.js'
import { creditSummaries } from '../memberships/credits.js'
import { loadPlans } from '../memberships/plans.js'
import type { ServiceKind } from './schema.js'
import './schema.js'

export interface BookClass {
  key: string
  label: string
  sort: number
}

export interface BookService {
  id: string
  kind: ServiceKind
  name: string
  /** services.price_cents: what the service costs when it has no price by size (and, kept in step, its starting price). */
  priceCents: number
  category: string
  tags: string[]
  active: boolean
  quoteOnly: boolean
}

export interface BookCell {
  cents: number
  maxCents: number | null
}

export type TintFilm = SettingValue<'catalog.tint_films'>[number]

export interface PriceBook {
  /** The active sizes in size order (smallest first). */
  classes: BookClass[]
  /** Every size's label, turned-off ones included (snapshots keep the label of a size turned off later). */
  labels: ReadonlyMap<string, string>
  services: ReadonlyMap<string, BookService>
  /** service id -> size key -> cell (cells of sizes that are off included; the rules read only the active sizes'). */
  cells: ReadonlyMap<string, ReadonlyMap<string, BookCell>>
  tintFilms: TintFilm[]
}

export interface ClassPrice {
  cents: number
  maxCents: number | null
  basis: Exclude<PriceBasis, 'legacy'>
  /** The size priced, null when none was known (unknown_class). */
  classKey: string | null
  classLabel: string | null
}

/** A tier's monthly price at a size. */
export interface TierCell {
  classKey: string
  monthlyCents: number
}

// ---- rule 1: the price at a size -------------------------------------------------------------------------------------------

const activeCells = (book: PriceBook, serviceId: string): { cls: BookClass; cell: BookCell }[] => {
  const cells = book.cells.get(serviceId)
  if (!cells) return []
  return book.classes.flatMap((cls) => {
    const cell = cells.get(cls.key)
    return cell ? [{ cls, cell }] : []
  })
}

/** The starting price of a service: its lowest price over the active sizes, or its base price when it has none. */
export function fromPrice(
  book: PriceBook,
  serviceId: string,
): { cents: number; maxCents: number | null; classKey: string | null; classLabel: string | null; basis: 'class' | 'base' } {
  const set = activeCells(book, serviceId)
  if (set.length === 0) {
    const s = book.services.get(serviceId)
    return { cents: s?.priceCents ?? 0, maxCents: null, classKey: null, classLabel: null, basis: 'base' }
  }
  // the lowest price; on a tie the smaller size
  const low = set.reduce((a, b) => (b.cell.cents < a.cell.cents ? b : a))
  return { cents: low.cell.cents, maxCents: low.cell.maxCents, classKey: low.cls.key, classLabel: low.cls.label, basis: 'class' }
}

/** What the service costs at a size (rule 1 above). */
export function classPrice(book: PriceBook, serviceId: string, classKey: string | null): ClassPrice {
  const set = activeCells(book, serviceId)
  if (set.length === 0) {
    const s = book.services.get(serviceId)
    const known = classKey !== null && book.classes.some((c) => c.key === classKey)
    return {
      cents: s?.priceCents ?? 0,
      maxCents: null,
      basis: 'base',
      classKey: known ? classKey : null,
      classLabel: known ? (book.labels.get(classKey!) ?? null) : null,
    }
  }
  const cls = classKey === null ? undefined : book.classes.find((c) => c.key === classKey)
  if (!cls) {
    const first = book.classes[0]
    const cell = first ? book.cells.get(serviceId)?.get(first.key) : undefined
    const p = cell ?? fromPrice(book, serviceId)
    return { cents: p.cents, maxCents: p.maxCents, basis: 'unknown_class', classKey: null, classLabel: null }
  }
  const own = book.cells.get(serviceId)?.get(cls.key)
  if (own) return { cents: own.cents, maxCents: own.maxCents, basis: 'class', classKey: cls.key, classLabel: cls.label }
  const from = fromPrice(book, serviceId)
  return { cents: from.cents, maxCents: from.maxCents, basis: 'estimated', classKey: cls.key, classLabel: cls.label }
}

// ---- rule 2: members -----------------------------------------------------------------------------------------------------

/** price x (1 - bp/10000), rounded half up to whole dollars, never above the price; 0 bp leaves the price as it is. */
export function memberCents(cents: number, discountBp: number): number {
  if (discountBp <= 0) return cents
  if (discountBp >= 10_000) return 0
  return Math.min(cents, divHalfUp(cents * (10_000 - discountBp), 1_000_000) * 100)
}

/** The member starting price of a service at a tier's % off. */
export const memberFromPrice = (book: PriceBook, serviceId: string, discountBp: number): number =>
  memberCents(fromPrice(book, serviceId).cents, discountBp)

/** A tier's starting monthly price: its lowest current price over the active sizes (null: the tier has no price, not sold). */
export function tierFromPrice(
  book: Pick<PriceBook, 'classes'>,
  cells: readonly TierCell[],
): { monthlyCents: number; classKey: string; classLabel: string } | null {
  let best: { monthlyCents: number; classKey: string; classLabel: string } | null = null
  for (const cls of book.classes) {
    const c = cells.find((x) => x.classKey === cls.key)
    if (c && (best === null || c.monthlyCents < best.monthlyCents))
      best = { monthlyCents: c.monthlyCents, classKey: cls.key, classLabel: cls.label }
  }
  return best
}

export interface MemberInclusion {
  id: string
  label: string
  mode: 'per_cycle' | 'every_visit'
  /** Credits left this cycle (per_cycle); null = unlimited, or every_visit. */
  left: number | null
  autoApply: boolean
  serviceIds: readonly string[]
}

/** What the engine needs to know about a member (loadMemberContext). */
export interface MemberContext {
  membershipId: string
  /** The membership's holder (memberships.customer_id). */
  holderId: string
  /** The customer is a household member, not the holder. */
  viaHousehold: boolean
  planId: string
  tierKey: string
  tierName: string
  /** The member % off, in basis points. */
  discountBp: number
  /** The size the membership is priced at: a covered line is covered up to this size's price. */
  planClass: string
  vipBooking: boolean
  /** The tier's active inclusions in tier order, with this cycle's credits. */
  inclusions: MemberInclusion[]
}

export interface Coverage {
  inclusionId: string
  label: string
  /** min(price at the visit size, price at the plan size) */
  coveredCents: number
  /** What stays due on the line: line - covered (no % off). */
  differenceCents: number
  planClass: string
}

export interface PricedLine {
  serviceId: string
  /** The regular price at the size. */
  listCents: number
  listMaxCents: number | null
  /** listCents - chargeCents (the member % off); 0 for a guest or a covered line. */
  memberDiscountCents: number
  /** What the invoice line charges: the member price, or the regular price for a guest or a covered line. */
  chargeCents: number
  /** The % off applied (0 when none). */
  discountBp: number
  basis: ClassPrice['basis']
  classKey: string | null
  classLabel: string | null
  coverage: Coverage | null
  /** What the client owes for the line: chargeCents, less the coverage. */
  dueCents: number
}

/** The inclusion that covers a service now: the first active one naming it that is every_visit or has a credit left (or no cap). */
export function coveringInclusion(member: MemberContext, serviceId: string, used: ReadonlyMap<string, number> = new Map()): MemberInclusion | null {
  for (const inc of member.inclusions) {
    if (!inc.serviceIds.includes(serviceId)) continue
    if (inc.mode === 'every_visit' || inc.left === null) return inc
    if (inc.left - (used.get(inc.id) ?? 0) > 0) return inc
  }
  return null
}

/**
 * The price at a member's plan size: that size's own cell even when the size was turned off later (a member keeps the size they pay
 * for), else rule 1.
 */
export function planSizeCents(book: PriceBook, serviceId: string, planClass: string): number {
  return book.cells.get(serviceId)?.get(planClass)?.cents ?? classPrice(book, serviceId, planClass).cents
}

/**
 * One line for a guest (member null) or a member. `inclusion`: the inclusion that covers it (quoteVisit picks it), null for none,
 * undefined to let the line find its own (coveringInclusion with the member's credits as they stand).
 */
export function priceLine(
  book: PriceBook,
  line: { serviceId: string },
  classKey: string | null,
  member: MemberContext | null,
  o: { inclusion?: MemberInclusion | null } = {},
): PricedLine {
  const p = classPrice(book, line.serviceId, classKey)
  const base = {
    serviceId: line.serviceId,
    listCents: p.cents,
    listMaxCents: p.maxCents,
    basis: p.basis,
    classKey: p.classKey,
    classLabel: p.classLabel,
  }
  if (!member) return { ...base, memberDiscountCents: 0, chargeCents: p.cents, discountBp: 0, coverage: null, dueCents: p.cents }
  const inc = o.inclusion === undefined ? coveringInclusion(member, line.serviceId) : o.inclusion
  if (inc) {
    const atPlan = planSizeCents(book, line.serviceId, member.planClass)
    const coveredCents = Math.min(p.cents, atPlan)
    const differenceCents = p.cents - coveredCents
    return {
      ...base,
      memberDiscountCents: 0,
      chargeCents: p.cents,
      discountBp: 0,
      coverage: { inclusionId: inc.id, label: inc.label, coveredCents, differenceCents, planClass: member.planClass },
      dueCents: differenceCents,
    }
  }
  const charge = memberCents(p.cents, member.discountBp)
  return {
    ...base,
    memberDiscountCents: p.cents - charge,
    chargeCents: charge,
    discountBp: charge < p.cents ? member.discountBp : 0,
    coverage: null,
    dueCents: charge,
  }
}

export interface VisitQuote {
  lines: PricedLine[]
  totals: {
    /** Sum of the regular prices. */
    listCents: number
    /** Sum of the member % off. */
    discountCents: number
    /** Sum of what the membership covers. */
    coveredCents: number
    /** What the client owes before tax and tip. */
    dueCents: number
  }
}

/**
 * A whole visit (the package, then the add-ons in order) at a size; each covered line spends one of the cycle's credits, and an
 * inclusion covers at most one line of a visit (wave Q2: one redeem per inclusion and visit, `redeem:<appointment>:<inclusion>`).
 */
export function quoteVisit(
  book: PriceBook,
  visit: { packageId: string; addonIds: readonly string[]; classKey: string | null },
  member: MemberContext | null,
): VisitQuote {
  const used = new Map<string, number>()
  const lines = [visit.packageId, ...visit.addonIds].map((serviceId) => {
    const inc = member ? coveringInclusion({ ...member, inclusions: member.inclusions.filter((i) => !used.has(i.id)) }, serviceId, used) : null
    if (inc) used.set(inc.id, (used.get(inc.id) ?? 0) + 1)
    return priceLine(book, { serviceId }, visit.classKey, member, { inclusion: inc })
  })
  const sum = (f: (l: PricedLine) => number): number => lines.reduce((n, l) => n + f(l), 0)
  return {
    lines,
    totals: {
      listCents: sum((l) => l.listCents),
      discountCents: sum((l) => l.memberDiscountCents),
      coveredCents: sum((l) => l.coverage?.coveredCents ?? 0),
      dueCents: sum((l) => l.dueCents),
    },
  }
}

/** Services whose cells leave sizes unpriced: how many active sizes have no price (the Settings banner "N prices not set"). */
export const missingCells = (book: PriceBook, serviceId: string): number => book.classes.length - activeCells(book, serviceId).length

// ---- loaders -----------------------------------------------------------------------------------------------------------------

/** The book of a location: active sizes, every service (retired ones too: an old visit may name one), their cells, the tint films. */
export async function loadPriceBook(db: Executor, locationId: string): Promise<PriceBook> {
  const [classes, services, cells, films] = await Promise.all([
    db
      .selectFrom('vehicle_classes')
      .select(['key', 'label', 'sort', 'active'])
      .where('location_id', '=', locationId)
      .orderBy('sort')
      .orderBy('key')
      .execute(),
    db
      .selectFrom('services')
      .select(['id', 'kind', 'name', 'price_cents', 'category', 'tags', 'active', 'quote_only'])
      .where('location_id', '=', locationId)
      .execute(),
    db
      .selectFrom('service_class_prices')
      .select(['service_id', 'class_key', 'price_cents', 'max_cents'])
      .where('location_id', '=', locationId)
      .execute(),
    getSetting(db, locationId, 'catalog.tint_films'),
  ])
  const byService = new Map<string, Map<string, BookCell>>()
  for (const c of cells) {
    let m = byService.get(c.service_id)
    if (!m) byService.set(c.service_id, (m = new Map()))
    m.set(c.class_key, { cents: c.price_cents, maxCents: c.max_cents })
  }
  return {
    classes: classes.filter((c) => c.active).map((c) => ({ key: c.key, label: c.label, sort: c.sort })),
    labels: new Map(classes.map((c) => [c.key, c.label])),
    services: new Map(
      services.map((s) => [
        s.id,
        {
          id: s.id,
          kind: s.kind,
          name: s.name,
          priceCents: s.price_cents,
          category: s.category,
          tags: s.tags,
          active: s.active,
          quoteOnly: s.quote_only,
        },
      ]),
    ),
    cells: byService,
    tintFilms: films.value,
  }
}

/** The current monthly price of every tier at every size (membership_tier_prices rows not superseded), by tier id. */
export async function loadTierCells(db: Executor, locationId: string): Promise<Map<string, TierCell[]>> {
  const rows = await db
    .selectFrom('membership_tier_prices')
    .select(['plan_id', 'class_key', 'monthly_cents'])
    .where('location_id', '=', locationId)
    .where('superseded_at', 'is', null)
    .execute()
  const out = new Map<string, TierCell[]>()
  for (const r of rows) {
    const list = out.get(r.plan_id) ?? []
    list.push({ classKey: r.class_key, monthlyCents: r.monthly_cents })
    out.set(r.plan_id, list)
  }
  return out
}

/** The ACTIVE membership a customer holds, or is a live household member of (the newest when both). */
export async function membershipOfCustomer(
  db: Executor,
  customerId: string,
): Promise<{ id: string; customerId: string; viaHousehold: boolean } | undefined> {
  const r = await sql<{ id: string; customer_id: string; via: boolean }>`
    select m.id, m.customer_id, m.customer_id <> ${customerId}::uuid as via
    from memberships m
    where m.status = 'active'
      and (m.customer_id = ${customerId}::uuid
        or exists (select 1 from membership_household h
                   where h.membership_id = m.id and h.customer_id = ${customerId}::uuid and h.removed_at is null))
    order by (m.customer_id = ${customerId}::uuid) desc, m.created_at desc
    limit 1`.execute(db)
  const m = r.rows[0]
  return m ? { id: m.id, customerId: m.customer_id, viaHousehold: m.via } : undefined
}

/**
 * The member context of a customer (household-aware): the holder or a live household member of an ACTIVE membership, its tier's
 * % off, VIP flag and active inclusions with this cycle's credits, and the plan size. null for anyone else.
 */
export async function loadMemberContext(db: Executor, locationId: string, customerId: string): Promise<MemberContext | null> {
  const ref = await membershipOfCustomer(db, customerId)
  if (!ref) return null
  const m = await db
    .selectFrom('memberships')
    .select(['id', 'customer_id', 'plan_id', 'plan_class', 'current_period_start'])
    .where('id', '=', ref.id)
    .where('location_id', '=', locationId)
    .executeTakeFirst()
  if (!m) return null
  const plans = await loadPlans(db, locationId)
  const plan = plans.find((p) => p.id === m.plan_id)
  if (!plan) return null
  const summary = (
    await creditSummaries(db, [{ id: m.id, planId: m.plan_id, currentPeriodStart: m.current_period_start }], plans)
  ).get(m.id)
  return {
    membershipId: m.id,
    holderId: m.customer_id,
    viaHousehold: ref.viaHousehold,
    planId: plan.id,
    tierKey: plan.key,
    tierName: plan.name,
    discountBp: plan.memberDiscountBp,
    planClass: m.plan_class,
    vipBooking: plan.vipBooking,
    inclusions: plan.inclusions
      .filter((i) => i.active)
      .map((i) => ({
        id: i.id,
        label: i.label,
        mode: i.mode,
        left: i.mode === 'every_visit' ? null : (summary?.rules.find((r) => r.ruleId === i.id)?.left ?? (i.perCycle === null ? null : 0)),
        autoApply: i.autoApply,
        serviceIds: i.serviceIds,
      })),
  }
}
