// Redeeming one membership credit on a visit. Two entry points share one evaluation and one write:
//  * applyMembershipCredit: the explicit command (staff press "Apply credit"), refusing with the design's guard errors;
//  * autoApplyMembershipCredit: the same redemption when a covered visit is completed, for a rule marked auto_apply or a member
//    who asked for it. It never refuses: anything that stops it is a quiet skip, so completing a job cannot fail because of it.
// Both create a system `adjust` event (reason "Membership credit") equal to the package line through the Payments command layer,
// so tax falls with it exactly as the design's never-applied credit implies, exempt from the actor's adjust limit (the staff
// member needs cli.member, or only jobs.status for the automatic one, not pay.adjust) and still attributed to the real person.
// Percent perks stay display-only. One credit per appointment, enforced here and by a partial unique index.
import { sql } from 'kysely'
import type { AuditContext } from '../../platform/audit.js'
import type { Clock } from '../../platform/clock.js'
import type { Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import type { NewId } from '../../platform/ids.js'
import type { PayActor } from '../payments/actor.js'
import { PaymentsService, type AdjustResult } from '../payments/commands.js'
import { calcOf } from '../payments/repository.js'
import { creditSummaries, eligibleRule } from './credits.js'
import { loadPlans, type CreditRule } from './plans.js'
import type { MembershipsTable } from './schema.js'
import type { Selectable } from 'kysely'
import './problems.js'

export const CREDIT_REASON = 'Membership credit'

export interface ApplyDeps {
  locationId: string
  clock: Clock
  newId: NewId
  payments: PaymentsService
}

export interface ApplyContext {
  actor: PayActor
  audit: AuditContext
  idempotencyKey: string | null
}

export interface ApplyResult extends AdjustResult {
  membershipId: string
  appointmentId: string
  rule: { id: string; label: string }
  discountCents: number
  credits: { left: number | null; used: number }
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

interface Ready {
  appt: { id: string; price_cents: number }
  membership: Selectable<MembershipsTable>
  rule: CreditRule
  invoiceId: string
  discount: number
}

async function evaluate(
  tx: Tx,
  d: ApplyDeps,
  appointmentId: string,
): Promise<{ ok: true; ready: Ready } | { ok: false; block: Block }> {
  const appt = await tx
    .selectFrom('appointments as a')
    .innerJoin('services as s', 's.id', 'a.service_id')
    .select(['a.id', 'a.customer_id', 'a.status', 'a.price_cents', 's.tags'])
    .where('a.id', '=', appointmentId)
    .where('a.location_id', '=', d.locationId)
    .executeTakeFirst()
  if (!appt) throw new AppError('NOT_FOUND', { detail: 'That appointment does not exist' })
  if (appt.status === 'canceled' || appt.status === 'no_show') return { ok: false, block: 'closed' }

  const membership = await tx
    .selectFrom('memberships')
    .selectAll()
    .where('customer_id', '=', appt.customer_id)
    .where('status', 'in', ['pending', 'active', 'past_due', 'paused'])
    .forUpdate()
    .executeTakeFirst()
  if (!membership) return { ok: false, block: 'no_membership' }
  if (membership.status !== 'active') return { ok: false, block: 'not_active' }

  const done = await tx
    .selectFrom('membership_credit_events')
    .select('id')
    .where('appointment_id', '=', appt.id)
    .where('kind', '=', 'redeem')
    .executeTakeFirst()
  if (done) return { ok: false, block: 'done' }

  const plans = await loadPlans(tx, d.locationId)
  const plan = plans.find((p) => p.id === membership.plan_id)!
  const summary = (
    await creditSummaries(
      tx,
      [
        {
          id: membership.id,
          planId: membership.plan_id,
          currentPeriodStart: membership.current_period_start,
        },
      ],
      plans,
    )
  ).get(membership.id)!
  const pick = eligibleRule(plan, summary, appt.tags)
  if (!pick) return { ok: false, block: 'not_eligible' }
  if (!pick.covered) return { ok: false, block: 'no_credit' }

  const invoice = await tx
    .selectFrom('invoices')
    .select('id')
    .where('appointment_id', '=', appt.id)
    .where('location_id', '=', d.locationId)
    .executeTakeFirst()
  if (!invoice) return { ok: false, block: 'no_invoice' }
  const calc = await calcOf(tx, invoice.id)
  if (calc.balance <= 0) return { ok: false, block: 'no_balance' }
  const pkg = await tx
    .selectFrom('invoice_items')
    .select('price_cents')
    .where('invoice_id', '=', invoice.id)
    .where('kind', '=', 'package')
    .orderBy('position')
    .executeTakeFirst()
  const discount = Math.min(pkg?.price_cents ?? appt.price_cents, calc.sub)
  if (discount <= 0) return { ok: false, block: 'no_balance' }
  return { ok: true, ready: { appt, membership, rule: pick.rule, invoiceId: invoice.id, discount } }
}

async function redeem(
  tx: Tx,
  d: ApplyDeps,
  r: Ready,
  c: ApplyContext,
  o: { auto: boolean },
): Promise<ApplyResult> {
  const result = await d.payments.adjust(
    tx,
    {
      locationId: d.locationId,
      actor: creditActor(c.actor),
      audit: c.audit,
      idempotencyKey: c.idempotencyKey,
      source: 'system',
    },
    r.invoiceId,
    {
      kind: 'discount',
      unit: '$',
      value: r.discount,
      reason: CREDIT_REASON,
      note: `${r.rule.label} · ${r.membership.plan_label}${o.auto ? ' · auto-applied' : ''}`,
      settle: 'credit',
    },
  )
  const cycle = r.membership.current_period_start!
  await sql`
    insert into membership_credit_events (id, membership_id, cycle_start, kind, qty, rule_id, appointment_id, invoice_id,
      ledger_event_id, note, actor, actor_user_id, idempotency_key, created_at)
    values (${d.newId()}, ${r.membership.id}, ${cycle}, 'redeem', 1, ${r.rule.id}, ${r.appt.id}, ${r.invoiceId},
      ${result.event.id}, ${`${r.rule.label} on ${r.appt.id}${o.auto ? ' (auto-applied)' : ''}`}, ${c.actor.name}, ${c.actor.userId},
      ${`redeem:${r.appt.id}`}, ${d.clock.now()})`.execute(tx)
  const plans = await loadPlans(tx, d.locationId)
  const after = (
    await creditSummaries(
      tx,
      [
        {
          id: r.membership.id,
          planId: r.membership.plan_id,
          currentPeriodStart: r.membership.current_period_start,
        },
      ],
      plans,
    )
  ).get(r.membership.id)!
  return {
    ...result,
    membershipId: r.membership.id,
    appointmentId: r.appt.id,
    rule: { id: r.rule.id, label: r.rule.label },
    discountCents: r.discount,
    credits: { left: after.creditsLeft, used: after.creditsUsed },
  }
}

export async function applyMembershipCredit(
  tx: Tx,
  d: ApplyDeps,
  input: { appointmentId: string },
  c: ApplyContext,
): Promise<ApplyResult> {
  const e = await evaluate(tx, d, input.appointmentId)
  if (!e.ok) throw blockError(e.block)
  return redeem(tx, d, e.ready, c, { auto: false })
}

export type AutoApplyOutcome =
  | { applied: true; ruleLabel: string; creditsLeft: number | null; discountCents: number }
  | { applied: false; skipped: Block | 'not_auto' | 'error' }

/**
 * Redeems the credit when the rule (or the member) is set to apply itself; otherwise reports why it did not. Runs under a
 * savepoint so a failure inside the payments command can never take the caller's transaction (the job completion) with it.
 */
export async function autoApplyMembershipCredit(
  tx: Tx,
  d: ApplyDeps,
  input: { appointmentId: string },
  c: ApplyContext,
): Promise<AutoApplyOutcome> {
  const e = await evaluate(tx, d, input.appointmentId)
  if (!e.ok) return { applied: false, skipped: e.block }
  if (!e.ready.rule.autoApply && !e.ready.membership.auto_apply)
    return { applied: false, skipped: 'not_auto' }
  await sql`savepoint auto_credit`.execute(tx)
  try {
    const r = await redeem(
      tx,
      d,
      e.ready,
      { ...c, idempotencyKey: `auto-credit:${input.appointmentId}` },
      { auto: true },
    )
    await sql`release savepoint auto_credit`.execute(tx)
    return {
      applied: true,
      ruleLabel: r.rule.label,
      creditsLeft: r.credits.left,
      discountCents: r.discountCents,
    }
  } catch (err) {
    await sql`rollback to savepoint auto_credit`.execute(tx)
    if (err instanceof AppError) return { applied: false, skipped: 'error' }
    throw err
  }
}
