// Settling a member's visit (ADR 0170, wave Q2): what the membership covers on a visit, written once. Two entry points share one
// evaluation and one write:
//  * applyMembershipCredit: the explicit command (staff press "Apply credit", POST /appointments/:id/membership-perks/apply),
//    refusing with the design's guard errors;
//  * autoApplyMembershipCredit: the same settlement when a visit is completed, for the inclusions marked auto_apply (or every one
//    when the member asked for it). It never refuses: anything that stops it is a quiet skip, under a savepoint, so completing a
//    job cannot fail because of it.
// settleMembershipVisit:
//  1. the membership the client holds OR shares as a live household member (one membership row locked: credits are per membership,
//     so a household spends them one visit at a time), ACTIVE;
//  2. quoteVisit decides which line each inclusion covers (an inclusion covers one line of a visit; credits as they stand);
//  3. the lines are priced again through the invoice item sync, from the price each line was booked at (its regular price at the
//     visit's size never changes here): a covered line is charged the regular price, any other line the member price; so an included
//     line no longer covered (the allowance ran out) gets the member price and a newly covered line goes back to the regular price;
//  4. for each covered line ONE system adjust (reason "Membership credit") of the covered amount — min(price at the visit size, price
//     at the plan size), so a larger car's size difference stays due, with no % off — and ONE redeem event (covered_cents,
//     line_cents, plan_class, visit_class; key redeem:<appointment>:<inclusion>). The adjust goes through the Payments command layer
//     exempt from the actor's adjust limit (cli.member, or only jobs.status for the automatic one, not pay.adjust) and attributed to
//     the real person; tax falls with it. calcInvoice / invoice_calc_of do not change.
// A visit is settled once: a second apply answers MEMBERSHIP_CREDIT_APPLIED. Releasing (emergency closure) works per redeem.
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
  /** Whether a line's price changed (the member price, or back to the regular price). */
  repriced: boolean
  credits: { left: number | null; used: number }
  /** The first adjust and the invoice after the last one. */
  first: AdjustResult
  last: AdjustResult
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
  constructor(readonly block: Block | 'not_auto') {
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

/**
 * Settles the visit: reprices, then one adjust + one redeem per covered line. `auto`: only the inclusions that apply themselves (or
 * all of them when the member asked), and the lines are repriced even when nothing is covered. Throws Blocked for a business reason.
 */
async function settle(tx: Tx, d: ApplyDeps, appointmentId: string, c: ApplyContext, o: { auto: boolean }): Promise<SettleResult> {
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
  const done = await tx
    .selectFrom('membership_credit_events')
    .select('id')
    .where('appointment_id', '=', appt.id)
    .where('kind', '=', 'redeem')
    .executeTakeFirst()
  if (done) throw new Blocked('done')
  const ctx = await contextOf(tx, d.locationId, appt.customer_id, membership.id)
  if (!ctx) throw new Blocked('not_active')
  // a membership without a current cycle has no credits to spend (every_visit inclusions still cover)
  const cycle = membership.current_period_start
  const member: MemberContext = cycle
    ? ctx
    : { ...ctx, inclusions: ctx.inclusions.map((i) => (i.mode === 'per_cycle' ? { ...i, left: 0 } : i)) }
  const invoice = await tx
    .selectFrom('invoices')
    .select(['id', 'canceled_at'])
    .where('appointment_id', '=', appt.id)
    .where('location_id', '=', d.locationId)
    .executeTakeFirst()

  const book = await loadPriceBook(tx, d.locationId)
  const lines = await visitLines(tx, appt)
  const auto = (m: MemberContext): MemberContext =>
    o.auto && !membership.auto_apply ? { ...m, inclusions: m.inclusions.filter((i) => i.autoApply) } : m
  const visit = { packageId: lines[0]!.serviceId, addonIds: lines.slice(1).map((l) => l.serviceId), classKey: appt.vehicle_class }
  const all = quoteVisit(book, visit, member)
  const chosen = quoteVisit(book, visit, auto(member))
  const covered = chosen.lines.map((l) => l.coverage)

  // 3. reprice from the booked regular price: covered lines at the regular price, the others at the member price
  const target = lines.map((l, i) => repriced(l, covered[i] ?? null, member, book))
  const changed = target.some((t, i) => t.priceCents !== lines[i]!.priceCents || t.discountBp !== lines[i]!.discountBp)
  if (changed) {
    if (!invoice || invoice.canceled_at) throw new Blocked('no_invoice')
    for (const [i, t] of target.entries()) {
      const l = lines[i]!
      if (t.priceCents === l.priceCents && t.discountBp === l.discountBp) continue
      const cols = { price_cents: t.priceCents, list_price_cents: t.listCents, discount_bp: t.discountBp }
      if (l.rowId) await tx.updateTable('appointment_addons').set(cols).where('id', '=', l.rowId).execute()
      else await tx.updateTable('appointments').set(cols).where('id', '=', appt.id).execute()
    }
    try {
      await d.invoices.syncItems(
        tx,
        appt.id,
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
      if (e instanceof AppError && e.code === 'ADDON_REMOVE_OVERPAID') throw new AppError('PRICE_CHANGE_OVERPAID', { cause: e })
      throw e
    }
  }

  const coveredIdx = covered.flatMap((cv, i) => (cv ? [i] : []))
  if (coveredIdx.length === 0) {
    if (all.lines.some((l) => l.coverage)) throw new Blocked('not_auto')
    const named = lines.some((l) => member.inclusions.some((inc) => inc.serviceIds.includes(l.serviceId)))
    throw new Blocked(named ? 'no_credit' : 'not_eligible')
  }
  if (!invoice || invoice.canceled_at) throw new Blocked('no_invoice')
  const calc = await calcOf(tx, invoice.id)
  if (calc.balance <= 0) throw new Blocked('no_balance')

  const tier = membership.plan_label
  const planClassLabel = book.labels.get(member.planClass) ?? member.planClass
  let sub = calc.sub
  const settled: SettledLine[] = []
  const results: AdjustResult[] = []
  for (const i of coveredIdx) {
    const cv = covered[i]!
    const line = lines[i]!
    const t = target[i]!
    const value = Math.min(t.coveredCents, sub)
    if (value <= 0) continue
    const note = coverageNote({ service: line.name, tier, planClassLabel, coveredCents: value, lineCents: t.priceCents })
    const result = await d.payments.adjust(
      tx,
      {
        locationId: d.locationId,
        actor: creditActor(c.actor),
        audit: c.audit,
        idempotencyKey: c.idempotencyKey ? `${c.idempotencyKey}:${cv.inclusionId}` : null,
        source: 'system',
      },
      invoice.id,
      {
        kind: 'discount',
        unit: '$',
        value,
        reason: CREDIT_REASON,
        note: `${note}${o.auto ? ' · auto-applied' : ''}`,
        settle: 'credit',
      },
    )
    sub -= value
    const redeemId = d.newId()
    await sql`
      insert into membership_credit_events (id, membership_id, cycle_start, kind, qty, inclusion_id, service_id, appointment_id,
        invoice_id, ledger_event_id, line_cents, covered_cents, plan_class, visit_class, note, actor, actor_user_id, idempotency_key,
        created_at)
      values (${redeemId}, ${membership.id}, ${cycle ?? d.clock.now()}, 'redeem', 1, ${cv.inclusionId}, ${line.serviceId},
        ${appt.id}, ${invoice.id}, ${result.event.id}, ${t.priceCents}, ${value}, ${member.planClass}, ${appt.vehicle_class},
        ${`${note}${o.auto ? ' (auto-applied)' : ''}`}, ${c.actor.name}, ${c.actor.userId}, ${`redeem:${appt.id}:${cv.inclusionId}`},
        ${d.clock.now()})`.execute(tx)
    results.push(result)
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
  if (settled.length === 0) throw new Blocked('no_balance')
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
    repriced: changed,
    credits: { left: after.creditsLeft, used: after.creditsUsed },
    first: results[0]!,
    last: results[results.length - 1]!,
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
  return settle(tx, d, appointmentId, ctx, { auto: ctx.auto === true })
}

export async function applyMembershipCredit(
  tx: Tx,
  d: ApplyDeps,
  input: { appointmentId: string },
  c: ApplyContext,
): Promise<ApplyResult> {
  let r: SettleResult
  try {
    r = await settle(tx, d, input.appointmentId, c, { auto: false })
  } catch (e) {
    if (e instanceof Blocked) throw blockError(e.block === 'not_auto' ? 'no_credit' : e.block)
    throw e
  }
  return {
    event: r.first.event,
    settlement: r.first.settlement,
    invoice: r.last.invoice,
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
  | { applied: false; skipped: Block | 'not_auto' | 'error' }

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
    const r = await settle(tx, d, input.appointmentId, { ...c, idempotencyKey: `auto-credit:${input.appointmentId}` }, { auto: true })
    await sql`release savepoint auto_credit`.execute(tx)
    return {
      applied: true,
      ruleLabel: r.lines.map((l) => l.label).join(' + '),
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
