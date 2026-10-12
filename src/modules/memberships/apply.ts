// Settling a member's visit (ADR 0170, wave Q2): what the membership covers on a visit. Three entry points share one evaluation and
// one write:
//  * applyMembershipCredit: the explicit command (staff press "Apply credit", POST /appointments/:id/membership-perks/apply),
//    refusing with the design's guard errors;
//  * autoApplyMembershipCredit: the same settlement when a visit is completed, for the inclusions marked auto_apply (or every one
//    when the member asked for it). It never refuses: anything that stops it is a quiet skip, under a savepoint, so completing a
//    job cannot fail because of it;
//  * resettleMembershipVisit: a visit changed after it was settled (the size set at the shop, an add-on added or removed) is settled
//    again, so the coverage follows the visit (wave Q2a review).
// settle:
//  1. the membership the client holds OR shares as a live household member (one membership row locked: credits are per membership,
//     so a household spends them one visit at a time), ACTIVE;
//  2. quoteVisit decides which lines the inclusions cover (an inclusion covers every line it names while it can; credits as they
//     stand, the visit's own redeems counted as still there);
//  3. the lines are priced again through the invoice item sync, from the price each line was booked at (its regular price at the
//     visit's size never changes here): a covered line is charged the regular price, any other line the member price; so an included
//     line no longer covered (the allowance ran out) gets the member price and a newly covered line goes back to the regular price;
//  4. for each covered line ONE system adjust (reason "Membership credit") of the covered amount — min(price at the visit size, price
//     at the plan size), so a larger car's size difference stays due, with no % off — and ONE redeem event (covered_cents,
//     line_cents, plan_class, visit_class, service_id; key redeem:<appointment>:<inclusion>, then …:<n> for the inclusion's n-th
//     line or replacement). A redeem whose line is gone or changed is given back first: a reversing adjust and a `restore` keyed
//     restore:<redeem>. The adjusts go through the Payments command layer exempt from the actor's adjust limit (cli.member, or only
//     jobs.status for the automatic one, not pay.adjust) and attributed to the real person; tax falls with them. calcInvoice /
//     invoice_calc_of do not change.
// A visit settled before is never left overpaid by its settlement: the end state is projected before any write, and a change that
// would overpay it is refused (re-settle: 409 ADDON_REMOVE_OVERPAID, a size change PRICE_CHANGE_OVERPAID; apply: no balance).
// An apply with nothing new to cover answers MEMBERSHIP_CREDIT_APPLIED. Releasing (emergency closure) works per redeem.
import { sql } from 'kysely'
import type { AuditContext } from '../../platform/audit.js'
import type { Clock } from '../../platform/clock.js'
import type { Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import type { NewId } from '../../platform/ids.js'
import { formatUsdOps } from '../../platform/money.js'
import {
  loadMemberContext,
  loadPriceBook,
  memberCents,
  planSizeCents,
  quoteVisit,
  type MemberContext,
  type PriceBook,
} from '../catalog/price-book.js'
import type { PriceBasis } from '../customers/schema.js'
import type { PayActor } from '../payments/actor.js'
import { PaymentsService, type AdjustResult } from '../payments/commands.js'
import { calcInvoice, type CalcEvent, type InvoiceCalc } from '../payments/calc.js'
import { calcOf } from '../payments/repository.js'
import type { InvoiceItem, InvoiceSummary, SyncItemsMeta } from '../scheduling/ports.js'
import { creditSummaries } from './credits.js'
import { loadPlans } from './plans.js'
import type { MembershipsTable } from './schema.js'
import type { Selectable } from 'kysely'
import './problems.js'
import '../scheduling/problems.js'

export const CREDIT_REASON = 'Membership credit'

/** The invoice item sync the settlement reprices through (the scheduling module's InvoiceGateway; the payments gateway in HTTP). */
export interface ItemSync {
  syncItems(tx: Tx, appointmentId: string, items: InvoiceItem[], meta?: SyncItemsMeta): Promise<InvoiceSummary>
}

export interface ApplyDeps {
  locationId: string
  clock: Clock
  newId: NewId
  payments: PaymentsService
  invoices: ItemSync
}

export interface ApplyContext {
  actor: PayActor
  audit: AuditContext
  idempotencyKey: string | null
}

export interface SettledLine {
  inclusionId: string
  label: string
  serviceId: string
  serviceName: string
  kind: 'package' | 'addon'
  /** The line's regular price (what it charges). */
  lineCents: number
  coveredCents: number
  /** line - covered: the size difference that stays due. */
  differenceCents: number
  planClass: string
  visitClass: string | null
  eventId: string
  redeemId: string
}

export interface SettleResult {
  membershipId: string
  appointmentId: string
  lines: SettledLine[]
  coveredCents: number
  /** How many redeems were given back (a re-settle: the line is gone or changed). */
  released: number
  /** Whether a line's price changed (the member price, or back to the regular price). */
  repriced: boolean
  credits: { left: number | null; used: number }
  /** The first adjust and the invoice after the last one (null when nothing was adjusted). */
  first: AdjustResult | null
  last: AdjustResult | null
}

export interface ApplyResult extends AdjustResult {
  membershipId: string
  appointmentId: string
  /** The first covered line's inclusion (one line: the only one). */
  rule: { id: string; label: string }
  /** What the membership covered on the visit, all lines together. */
  discountCents: number
  credits: { left: number | null; used: number }
  lines: SettledLine[]
  repriced: boolean
}

/** The caller's identity and roles, with the adjust permission and its limit lifted for this one command. */
function creditActor(real: PayActor): PayActor {
  return {
    ...real,
    has: (perm) => perm === 'pay.adjust' || real.has(perm),
    limit: (kind) => (kind === 'adjust' ? null : real.limit(kind)),
    rolesFor: (perm) =>
      perm === 'pay.adjust' ? real.rolesFor('cli.member') || 'Membership' : real.rolesFor(perm),
    limitRole: (kind) => real.limitRole(kind),
  }
}

type Block =
  | 'closed'
  | 'no_membership'
  | 'not_active'
  | 'done'
  | 'not_eligible'
  | 'no_credit'
  | 'no_invoice'
  | 'no_balance'

/** The guard error of each block (the explicit command throws it; the automatic path just records why it skipped). */
function blockError(b: Block): AppError {
  switch (b) {
    case 'closed':
      return new AppError('MEMBERSHIP_APPOINTMENT_CLOSED')
    case 'no_membership':
      return new AppError('MEMBERSHIP_NOT_FOUND', { detail: 'This client is not a member' })
    case 'not_active':
      return new AppError('MEMBERSHIP_NOT_ACTIVE')
    case 'done':
      return new AppError('MEMBERSHIP_CREDIT_APPLIED')
    case 'not_eligible':
      return new AppError('MEMBERSHIP_NOT_ELIGIBLE')
    case 'no_credit':
      return new AppError('MEMBERSHIP_NO_CREDIT')
    case 'no_invoice':
      return new AppError('MEMBERSHIP_NO_INVOICE')
    case 'no_balance':
      return new AppError('MEMBERSHIP_NO_BALANCE')
  }
}

class Blocked extends Error {
  constructor(readonly block: Block | 'not_auto' | 'not_settled') {
    super(block)
  }
}

/** One line of the visit as it was booked (the package first, then the live add-ons in order). */
interface VisitLine {
  /** appointment_addons.id; null for the package. */
  rowId: string | null
  kind: 'package' | 'addon'
  serviceId: string
  name: string
  priceCents: number
  listCents: number | null
  discountBp: number | null
  basis: PriceBasis
}

/** The membership the client holds or shares (live statuses; the active one first, then their own), locked. */
async function lockMembership(tx: Tx, locationId: string, customerId: string): Promise<Selectable<MembershipsTable> | undefined> {
  return tx
    .selectFrom('memberships as m')
    .selectAll('m')
    .where('m.location_id', '=', locationId)
    .where('m.status', 'in', ['pending', 'active', 'past_due', 'paused'])
    .where((eb) =>
      eb.or([
        eb('m.customer_id', '=', customerId),
        eb.exists(
          eb
            .selectFrom('membership_household as h')
            .select('h.id')
            .whereRef('h.membership_id', '=', 'm.id')
            .where('h.customer_id', '=', customerId)
            .where('h.removed_at', 'is', null),
        ),
      ]),
    )
    .orderBy(sql`(m.status = 'active') desc, (m.customer_id = ${customerId}::uuid) desc, m.created_at desc`)
    .limit(1)
    .forUpdate()
    .executeTakeFirst()
}

async function visitLines(tx: Tx, appt: { id: string; service_id: string; package_name: string; price_cents: number; list_price_cents: number | null; discount_bp: number | null; price_basis: PriceBasis }): Promise<VisitLine[]> {
  const addons = await tx
    .selectFrom('appointment_addons')
    .select(['id', 'service_id', 'name', 'price_cents', 'list_price_cents', 'discount_bp', 'price_basis'])
    .where('appointment_id', '=', appt.id)
    .where('removed_at', 'is', null)
    .orderBy('added_at')
    .orderBy('id')
    .execute()
  return [
    {
      rowId: null,
      kind: 'package',
      serviceId: appt.service_id,
      name: appt.package_name,
      priceCents: appt.price_cents,
      listCents: appt.list_price_cents,
      discountBp: appt.discount_bp,
      basis: appt.price_basis,
    },
    ...addons.map(
      (a): VisitLine => ({
        rowId: a.id,
        kind: 'addon',
        serviceId: a.service_id,
        name: a.name,
        priceCents: a.price_cents,
        listCents: a.list_price_cents,
        discountBp: a.discount_bp,
        basis: a.price_basis,
      }),
    ),
  ]
}

/** The member context of the locked membership (null when the price book's view of the client is another membership). */
async function contextOf(tx: Tx, locationId: string, customerId: string, membershipId: string): Promise<MemberContext | null> {
  const m = await loadMemberContext(tx, locationId, customerId)
  return m && m.membershipId === membershipId ? m : null
}

const usd = formatUsdOps

/** "Signature Hand Wash · Gold (Compact car plan) · covers $40 of $60" */
export function coverageNote(o: { service: string; tier: string; planClassLabel: string; coveredCents: number; lineCents: number }): string {
  return `${o.service} · ${o.tier} (${o.planClassLabel} plan) · covers ${usd(o.coveredCents)} of ${usd(o.lineCents)}`
}

/** A redeem the visit holds (not given back), with the adjust it wrote. */
interface HeldRedeem {
  id: string
  membershipId: string
  /** coalesce(inclusion_id, rule_id): the inclusion the redeem counts under. */
  inclusionId: string | null
  rawInclusionId: string | null
  ruleId: string | null
  serviceId: string | null
  qty: number
  lineCents: number | null
  coveredCents: number | null
  planClass: string | null
  cycleStart: Date
  invoiceId: string | null
  /** The adjust's signed amount (negative: the discount it wrote); null when it has none. */
  adjustCents: number | null
}

/** The redeems a visit holds: every redeem naming it that no `restore` (closure or a change of the visit) has given back. */
async function heldRedeems(tx: Tx, appointmentId: string): Promise<HeldRedeem[]> {
  const r = await sql<{
    id: string
    membership_id: string
    inclusion_id: string | null
    raw_inclusion_id: string | null
    rule_id: string | null
    service_id: string | null
    qty: number
    line_cents: number | null
    covered_cents: number | null
    plan_class: string | null
    cycle_start: Date
    invoice_id: string | null
    adjust_cents: number | null
  }>`
    select e.id, e.membership_id, coalesce(e.inclusion_id, e.rule_id) as inclusion_id, e.inclusion_id as raw_inclusion_id, e.rule_id, e.service_id, e.qty::int as qty,
      e.line_cents, e.covered_cents, e.plan_class, e.cycle_start, e.invoice_id, le.amount_cents::int as adjust_cents
    from membership_credit_events e
    left join ledger_events le on le.id = e.ledger_event_id
    where e.kind = 'redeem' and e.appointment_id = ${appointmentId}
      and not exists (select 1 from membership_credit_events x where x.idempotency_key = 'restore:' || e.id::text)
    order by e.created_at, e.id`.execute(tx)
  return r.rows.map((x) => ({
    id: x.id,
    membershipId: x.membership_id,
    inclusionId: x.inclusion_id,
    rawInclusionId: x.raw_inclusion_id,
    ruleId: x.rule_id,
    serviceId: x.service_id,
    qty: x.qty,
    lineCents: x.line_cents,
    coveredCents: x.covered_cents,
    planClass: x.plan_class,
    cycleStart: x.cycle_start,
    invoiceId: x.invoice_id,
    adjustCents: x.adjust_cents,
  }))
}

/** The idempotency key of the next redeem of an inclusion on a visit: redeem:<appointment>:<inclusion>, then …:<n> for the n-th. */
async function redeemKeyOf(tx: Tx, appointmentId: string, inclusionId: string, taken: Map<string, number>): Promise<string> {
  if (!taken.has(inclusionId)) {
    const r = await sql<{ n: number }>`
      select count(*)::int as n from membership_credit_events
      where kind = 'redeem' and appointment_id = ${appointmentId} and coalesce(inclusion_id, rule_id) = ${inclusionId}`.execute(tx)
    taken.set(inclusionId, r.rows[0]?.n ?? 0)
  }
  const n = taken.get(inclusionId)! + 1
  taken.set(inclusionId, n)
  return n === 1 ? `redeem:${appointmentId}:${inclusionId}` : `redeem:${appointmentId}:${inclusionId}:${n}`
}

/**
 * How a settlement runs: `apply` (staff press "Apply credit": every inclusion), `auto` (the completion: the inclusions that apply
 * themselves, or all of them when the member asked), `resettle` (the visit changed after it was settled: the size, an add-on added
 * or removed; the inclusions `auto` uses plus the ones the visit already holds).
 */
type Mode = 'apply' | 'auto' | 'resettle'

/**
 * Settles the visit, or settles it again (ADR 0170, wave Q2a review): the coverage follows the visit as it is now.
 *  * The lines are quoted with the member's credits as if this visit had spent none (its own redeems count as still there).
 *  * A redeem whose line is gone, is no longer covered, or changed price or plan size is given back: an adjust reverses its discount
 *    and a `restore` (key restore:<redeem>, ledger_event_id = that adjust) returns the credit in the redeem's own cycle.
 *  * Each covered line without a redeem gets one + its adjust (a replacement keeps the cycle of the redeem it replaces).
 * Throws Blocked for a business reason: `apply` and `auto` with nothing new to cover answer `done` when the visit already holds a
 * redeem (MEMBERSHIP_CREDIT_APPLIED), else why nothing is covered. Writes in this order: the give-backs, the reprice of the lines,
 * the new redeems (so the invoice's overpaid guard sees the reversed coverage first).
 */
async function settle(tx: Tx, d: ApplyDeps, appointmentId: string, c: ApplyContext, mode: Mode): Promise<SettleResult> {
  // the appointment first (the completion already holds it), then the membership, then the invoice: one lock order everywhere
  const appt = await tx
    .selectFrom('appointments')
    .select(['id', 'customer_id', 'status', 'service_id', 'package_name', 'price_cents', 'list_price_cents', 'discount_bp', 'price_basis', 'vehicle_class'])
    .where('id', '=', appointmentId)
    .where('location_id', '=', d.locationId)
    .forUpdate()
    .executeTakeFirst()
  if (!appt) throw new AppError('NOT_FOUND', { detail: 'That appointment does not exist' })
  if (appt.status === 'canceled' || appt.status === 'no_show') throw new Blocked('closed')
  const membership = await lockMembership(tx, d.locationId, appt.customer_id)
  if (!membership) throw new Blocked('no_membership')
  if (membership.status !== 'active') throw new Blocked('not_active')
  const ctx = await contextOf(tx, d.locationId, appt.customer_id, membership.id)
  if (!ctx) throw new Blocked('not_active')
  // redeems another membership wrote (the client changed membership since) stay as they are
  const held = (await heldRedeems(tx, appt.id)).filter((h) => h.membershipId === membership.id)
  if (mode === 'resettle' && held.length === 0) throw new Blocked('not_settled')
  // a membership without a current cycle has no credits to spend (every_visit inclusions still cover); the visit's own redeems
  // count as credits still there, so a line it covered stays covered when the visit changes
  const cycle = membership.current_period_start
  const back = new Map<string, number>()
  for (const h of held) if (h.inclusionId) back.set(h.inclusionId, (back.get(h.inclusionId) ?? 0) + h.qty)
  const member: MemberContext = {
    ...ctx,
    inclusions: ctx.inclusions.map((i) => {
      if (i.mode !== 'per_cycle') return i
      const left = cycle ? i.left : 0
      return left === null ? i : { ...i, left: left + (back.get(i.id) ?? 0) }
    }),
  }
  const invoice = await tx
    .selectFrom('invoices')
    .select(['id', 'canceled_at'])
    .where('appointment_id', '=', appt.id)
    .where('location_id', '=', d.locationId)
    .executeTakeFirst()

  const book = await loadPriceBook(tx, d.locationId)
  const lines = await visitLines(tx, appt)
  const heldInclusions = new Set(held.flatMap((h) => (h.inclusionId ? [h.inclusionId] : [])))
  const scoped = (m: MemberContext): MemberContext =>
    mode !== 'apply' && !membership.auto_apply
      ? { ...m, inclusions: m.inclusions.filter((i) => i.autoApply || heldInclusions.has(i.id)) }
      : m
  const visit = { packageId: lines[0]!.serviceId, addonIds: lines.slice(1).map((l) => l.serviceId), classKey: appt.vehicle_class }
  const all = quoteVisit(book, visit, member)
  const chosen = quoteVisit(book, visit, scoped(member))
  const covered = chosen.lines.map((l) => l.coverage)
  // from the booked regular price: covered lines at the regular price, the others at the member price
  const target = lines.map((l, i) => repriced(l, covered[i] ?? null, member, book))
  const changed = target.some((t, i) => t.priceCents !== lines[i]!.priceCents || t.discountBp !== lines[i]!.discountBp)

  // the redeems the visit keeps: same inclusion and line (a redeem written before wave Q2 names no line: the first its inclusion
  // covers), same line price and plan size
  const free = [...held]
  const kept = new Map<number, HeldRedeem>()
  const replaces = new Map<number, HeldRedeem>()
  for (const [i, cv] of covered.entries()) {
    if (!cv) continue
    let k = free.findIndex((h) => h.inclusionId === cv.inclusionId && h.serviceId === lines[i]!.serviceId)
    if (k < 0) k = free.findIndex((h) => h.inclusionId === cv.inclusionId && h.serviceId === null)
    if (k < 0) continue
    const h = free.splice(k, 1)[0]!
    const same = h.lineCents === null || (h.lineCents === target[i]!.priceCents && h.planClass === member.planClass)
    if (same) kept.set(i, h)
    else replaces.set(i, h)
  }
  const releases = [...free, ...replaces.values()]
  const creates = covered.flatMap((cv, i) => (cv && !kept.has(i) ? [i] : []))

  if (creates.length === 0 && (mode !== 'resettle' || releases.length === 0)) {
    // nothing to cover anew: the explicit apply writes nothing; the completion keeps the reprice; a re-settle only reprices
    if (mode !== 'apply' && changed) await repriceLines(tx, d, appt.id, lines, target, invoice, mode)
    if (mode === 'resettle') return emptyResult(membership.id, appt.id, changed)
    if (held.length > 0) throw new Blocked('done')
    if (all.lines.some((l) => l.coverage)) throw new Blocked('not_auto')
    const named = lines.some((l) => member.inclusions.some((inc) => inc.serviceIds.includes(l.serviceId)))
    throw new Blocked(named ? 'no_credit' : 'not_eligible')
  }
  if (!invoice || invoice.canceled_at) throw new Blocked('no_invoice')
  // a visit settled before (its paid part included): the settlement never turns a change into a refund on its own. The end state is
  // projected before anything is written; one that leaves the invoice overpaid is refused (a re-settle: the gateway's 409
  // ADDON_REMOVE_OVERPAID, a size change says PRICE_CHANGE_OVERPAID; staff refund or adjust the invoice first) and changes nothing.
  if (held.length > 0) {
    const releaseCents = releases.map((h) => (h.adjustCents !== null && h.adjustCents < 0 ? -h.adjustCents : 0))
    const end = await projectedCalc(tx, invoice.id, releaseCents, target.map((t) => t.priceCents), creates.map((i) => target[i]!.coveredCents))
    if (end.overpaid > 0) throw mode === 'resettle' ? new AppError('ADDON_REMOVE_OVERPAID') : new Blocked('no_balance')
  }

  const tier = membership.plan_label
  const planClassLabel = book.labels.get(member.planClass) ?? member.planClass
  const actor = creditActor(c.actor)
  const ledgerKey = (suffix: string): string | null => (c.idempotencyKey ? `${c.idempotencyKey}:${suffix}` : null)
  const adjusts: AdjustResult[] = []

  // 1. give back what no longer matches the visit
  for (const h of releases) {
    const lineName = lines.find((l) => l.serviceId === h.serviceId)?.name ?? book.services.get(h.serviceId ?? '')?.name ?? CREDIT_REASON
    const amount = h.adjustCents !== null && h.adjustCents < 0 ? -h.adjustCents : 0
    const why = `${lineName} · ${tier} · coverage of ${usd(amount)} given back (the visit changed)`
    let eventId: string | null = null
    if (amount > 0) {
      const r = await d.payments.adjust(
        tx,
        { locationId: d.locationId, actor, audit: c.audit, idempotencyKey: ledgerKey(`release:${h.id}`), source: 'system' },
        invoice.id,
        { kind: 'surcharge', unit: '$', value: amount, reason: CREDIT_REASON, note: why, settle: 'credit' },
      )
      adjusts.push(r)
      eventId = r.event.id
    }
    await sql`
      insert into membership_credit_events (id, membership_id, cycle_start, kind, qty, rule_id, inclusion_id, service_id, appointment_id,
        invoice_id, ledger_event_id, note, actor, actor_user_id, idempotency_key, created_at)
      values (${d.newId()}, ${h.membershipId}, ${h.cycleStart}, 'restore', ${h.qty}, ${h.ruleId}, ${h.rawInclusionId}, ${h.serviceId},
        ${appt.id}, ${h.invoiceId ?? invoice.id}, ${eventId}, ${why}, ${c.actor.name}, ${c.actor.userId}, ${`restore:${h.id}`},
        ${d.clock.now()})`.execute(tx)
  }

  // 2. the lines at their prices now (a re-settle always syncs: the caller changed the lines, the invoice follows before the caps)
  if (changed || mode === 'resettle') await repriceLines(tx, d, appt.id, lines, target, invoice, mode)

  // 3. one adjust + one redeem per line newly covered, each capped at what is left of the subtotal
  const calc = await calcOf(tx, invoice.id)
  if (held.length === 0 && calc.balance <= 0) throw new Blocked('no_balance')
  let sub = calc.sub
  const settled: SettledLine[] = []
  const taken = new Map<string, number>()
  for (const i of creates) {
    const cv = covered[i]!
    const line = lines[i]!
    const t = target[i]!
    const value = Math.min(t.coveredCents, sub)
    if (value <= 0) continue
    const key = await redeemKeyOf(tx, appt.id, cv.inclusionId, taken)
    const note = coverageNote({ service: line.name, tier, planClassLabel, coveredCents: value, lineCents: t.priceCents })
    const result = await d.payments.adjust(
      tx,
      { locationId: d.locationId, actor, audit: c.audit, idempotencyKey: ledgerKey(key), source: 'system' },
      invoice.id,
      {
        kind: 'discount',
        unit: '$',
        value,
        reason: CREDIT_REASON,
        note: `${note}${mode === 'auto' ? ' · auto-applied' : ''}`,
        settle: 'credit',
      },
    )
    sub -= value
    const redeemId = d.newId()
    const cycleStart = replaces.get(i)?.cycleStart ?? cycle ?? d.clock.now()
    await sql`
      insert into membership_credit_events (id, membership_id, cycle_start, kind, qty, inclusion_id, service_id, appointment_id,
        invoice_id, ledger_event_id, line_cents, covered_cents, plan_class, visit_class, note, actor, actor_user_id, idempotency_key,
        created_at)
      values (${redeemId}, ${membership.id}, ${cycleStart}, 'redeem', 1, ${cv.inclusionId}, ${line.serviceId},
        ${appt.id}, ${invoice.id}, ${result.event.id}, ${t.priceCents}, ${value}, ${member.planClass}, ${appt.vehicle_class},
        ${`${note}${mode === 'auto' ? ' (auto-applied)' : ''}`}, ${c.actor.name}, ${c.actor.userId}, ${key}, ${d.clock.now()})`.execute(tx)
    adjusts.push(result)
    settled.push({
      inclusionId: cv.inclusionId,
      label: cv.label,
      serviceId: line.serviceId,
      serviceName: line.name,
      kind: line.kind,
      lineCents: t.priceCents,
      coveredCents: value,
      differenceCents: t.priceCents - value,
      planClass: member.planClass,
      visitClass: appt.vehicle_class,
      eventId: result.event.id,
      redeemId,
    })
  }
  if (settled.length === 0 && mode !== 'resettle') throw new Blocked('no_balance')
  const plans = await loadPlans(tx, d.locationId)
  const after = (
    await creditSummaries(
      tx,
      [{ id: membership.id, planId: membership.plan_id, currentPeriodStart: membership.current_period_start }],
      plans,
    )
  ).get(membership.id)!
  return {
    membershipId: membership.id,
    appointmentId: appt.id,
    lines: settled,
    coveredCents: settled.reduce((n, l) => n + l.coveredCents, 0),
    released: releases.length,
    repriced: changed,
    credits: { left: after.creditsLeft, used: after.creditsUsed },
    first: adjusts[0] ?? null,
    last: adjusts[adjusts.length - 1] ?? null,
  }
}

/**
 * The invoice as the settlement would leave it (the pure calcInvoice over its ledger): the give-backs' surcharges, the lines at
 * their new prices, then each new coverage capped at what is left of the subtotal, as step 3 writes them.
 */
async function projectedCalc(
  tx: Tx,
  invoiceId: string,
  releaseCents: number[],
  itemPrices: number[],
  coverCents: number[],
): Promise<InvoiceCalc> {
  const inv = await tx.selectFrom('invoices').select(['tax_bp', 'tip_cents']).where('id', '=', invoiceId).executeTakeFirstOrThrow()
  const rows = await tx
    .selectFrom('ledger_events')
    .select(['type', 'amount_cents', 'status', 'dest'])
    .where('invoice_id', '=', invoiceId)
    .execute()
  const events: CalcEvent[] = rows.map((e) => ({ type: e.type, amountCents: e.amount_cents, status: e.status, dest: e.dest }))
  for (const cents of releaseCents) if (cents > 0) events.push({ type: 'adjust', amountCents: cents })
  const calc = (): InvoiceCalc => calcInvoice({ itemPrices, events, taxBp: inv.tax_bp, tipCents: inv.tip_cents, canceled: false })
  let sub = calc().sub
  for (const cents of coverCents) {
    const value = Math.min(cents, sub)
    if (value <= 0) continue
    events.push({ type: 'adjust', amountCents: -value })
    sub -= value
  }
  return calc()
}

const emptyResult = (membershipId: string, appointmentId: string, repriced: boolean): SettleResult => ({
  membershipId,
  appointmentId,
  lines: [],
  coveredCents: 0,
  released: 0,
  repriced,
  credits: { left: null, used: 0 },
  first: null,
  last: null,
})

/**
 * Writes the lines' new prices on the appointment and its add-ons, and syncs the invoice: 409 PRICE_CHANGE_OVERPAID when that would
 * leave it overpaid (a re-settle leaves the gateway's ADDON_REMOVE_OVERPAID to its caller: a removal says it in its own words).
 */
async function repriceLines(
  tx: Tx,
  d: ApplyDeps,
  appointmentId: string,
  lines: VisitLine[],
  target: ReturnType<typeof repriced>[],
  invoice: { canceled_at: Date | null } | undefined,
  mode: Mode,
): Promise<void> {
  if (!invoice || invoice.canceled_at) throw new Blocked('no_invoice')
  for (const [i, t] of target.entries()) {
    const l = lines[i]!
    if (t.priceCents === l.priceCents && t.discountBp === l.discountBp) continue
    const cols = { price_cents: t.priceCents, list_price_cents: t.listCents, discount_bp: t.discountBp }
    if (l.rowId) await tx.updateTable('appointment_addons').set(cols).where('id', '=', l.rowId).execute()
    else await tx.updateTable('appointments').set(cols).where('id', '=', appointmentId).execute()
  }
  try {
    await d.invoices.syncItems(
      tx,
      appointmentId,
      target.map((t, i) => ({
        name: lines[i]!.name,
        kind: lines[i]!.kind,
        priceCents: t.priceCents,
        listCents: t.listCents,
        discountBp: t.discountBp,
        basis: lines[i]!.basis,
      })),
    )
  } catch (e) {
    if (mode !== 'resettle' && e instanceof AppError && e.code === 'ADDON_REMOVE_OVERPAID')
      throw new AppError('PRICE_CHANGE_OVERPAID', { cause: e })
    throw e
  }
}

/**
 * A line's price at settlement, from its booked regular price (a line priced before sizes: its price): covered, the regular price
 * (no % off) and the covered amount up to the plan size's price; otherwise the member price (a line priced before sizes keeps its
 * price).
 */
function repriced(
  l: VisitLine,
  coverage: { coveredCents: number } | null,
  member: MemberContext,
  book: PriceBook,
): { priceCents: number; listCents: number | null; discountBp: number | null; coveredCents: number } {
  const legacy = l.basis === 'legacy' || l.listCents === null
  const list = legacy ? l.priceCents : l.listCents!
  if (coverage) {
    const atPlan = planSizeCents(book, l.serviceId, member.planClass)
    return { priceCents: list, listCents: legacy ? l.listCents : list, discountBp: legacy ? l.discountBp : 0, coveredCents: Math.min(list, atPlan) }
  }
  if (legacy) return { priceCents: l.priceCents, listCents: l.listCents, discountBp: l.discountBp, coveredCents: 0 }
  const charge = memberCents(list, member.discountBp)
  return { priceCents: charge, listCents: list, discountBp: charge < list ? member.discountBp : 0, coveredCents: 0 }
}

/** Settles a member's visit (the shared entry point of the explicit and the automatic apply). */
export async function settleMembershipVisit(
  tx: Tx,
  d: ApplyDeps,
  appointmentId: string,
  ctx: ApplyContext & { auto?: boolean },
): Promise<SettleResult> {
  return settle(tx, d, appointmentId, ctx, ctx.auto === true ? 'auto' : 'apply')
}

export async function applyMembershipCredit(
  tx: Tx,
  d: ApplyDeps,
  input: { appointmentId: string },
  c: ApplyContext,
): Promise<ApplyResult> {
  let r: SettleResult
  try {
    r = await settle(tx, d, input.appointmentId, c, 'apply')
  } catch (e) {
    if (e instanceof Blocked) throw blockError(e.block === 'not_auto' || e.block === 'not_settled' ? 'no_credit' : e.block)
    throw e
  }
  return {
    event: r.first!.event,
    settlement: r.first!.settlement,
    invoice: r.last!.invoice,
    membershipId: r.membershipId,
    appointmentId: r.appointmentId,
    rule: { id: r.lines[0]!.inclusionId, label: r.lines[0]!.label },
    discountCents: r.coveredCents,
    credits: r.credits,
    lines: r.lines,
    repriced: r.repriced,
  }
}

export type AutoApplyOutcome =
  | { applied: true; ruleLabel: string; creditsLeft: number | null; discountCents: number; lines: number }
  | { applied: false; skipped: Block | 'not_auto' | 'not_settled' | 'error' }

/**
 * Settles the visit when it is completed (the inclusions that apply themselves, or all of them when the member asked); otherwise
 * reports why it did not. Runs under a savepoint so a failure inside it can never take the caller's transaction (the job completion)
 * with it; a skip keeps the repricing (an included line the allowance no longer covers gets the member price).
 */
export async function autoApplyMembershipCredit(
  tx: Tx,
  d: ApplyDeps,
  input: { appointmentId: string },
  c: ApplyContext,
): Promise<AutoApplyOutcome> {
  await sql`savepoint auto_credit`.execute(tx)
  try {
    const r = await settle(tx, d, input.appointmentId, { ...c, idempotencyKey: `auto-credit:${input.appointmentId}` }, 'auto')
    await sql`release savepoint auto_credit`.execute(tx)
    return {
      applied: true,
      ruleLabel: [...new Set(r.lines.map((l) => l.label))].join(' + '),
      creditsLeft: r.credits.left,
      discountCents: r.coveredCents,
      lines: r.lines.length,
    }
  } catch (err) {
    if (err instanceof Blocked) {
      // a business skip keeps what was written before it (the repricing); nothing else was written
      await sql`release savepoint auto_credit`.execute(tx)
      return { applied: false, skipped: err.block }
    }
    await sql`rollback to savepoint auto_credit`.execute(tx)
    if (err instanceof AppError) return { applied: false, skipped: 'error' }
    throw err
  }
}

export interface ResettleOutcome {
  /** What the membership covered on the visit before and after. */
  beforeCents: number
  afterCents: number
  /** Redeems given back and written. */
  released: number
  added: number
}

/**
 * Settles a visit again after it changed (the size set at the shop, an add-on added or removed; ADR 0170 wave Q2a review), so the
 * coverage follows the visit: a larger size confirmed after the visit was covered is covered up to the plan size, an included add-on
 * added later is covered, a covered add-on removed gives its coverage and credit back. null when the visit holds no redeem yet (the
 * completion settles it) or the membership no longer covers it (what was covered stays). Runs in the caller's transaction, before
 * the caller syncs the invoice; an error refuses the whole change: 409 ADDON_REMOVE_OVERPAID when the change would leave a paid
 * invoice overpaid (projected before anything is written: the settlement never refunds to store credit on its own).
 */
export async function resettleMembershipVisit(
  tx: Tx,
  d: ApplyDeps,
  input: { appointmentId: string },
  c: ApplyContext,
): Promise<ResettleOutcome | null> {
  const before = await coveredOn(tx, input.appointmentId)
  let r: SettleResult
  try {
    r = await settle(tx, d, input.appointmentId, { ...c, idempotencyKey: null }, 'resettle')
  } catch (err) {
    if (err instanceof Blocked) return null
    throw err
  }
  return { beforeCents: before, afterCents: await coveredOn(tx, input.appointmentId), released: r.released, added: r.lines.length }
}

/** What the redeems a visit holds cover, in cents. */
async function coveredOn(tx: Tx, appointmentId: string): Promise<number> {
  return (await heldRedeems(tx, appointmentId)).reduce((n, h) => n + (h.adjustCents !== null && h.adjustCents < 0 ? -h.adjustCents : 0), 0)
}
