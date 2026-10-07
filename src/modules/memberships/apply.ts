// "Apply credit": the explicit command that redeems one membership credit on a visit. It creates a system `adjust` event
// (reason "Membership credit") equal to the package line through the Payments command layer, so tax falls with it exactly as the
// design's never-applied credit implies, exempt from the actor's adjust limit (the staff member needs cli.member, not pay.adjust)
// and still attributed to the real person. Percent perks stay display-only; nothing here runs automatically.
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
import { loadPlans } from './plans.js'
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

export async function applyMembershipCredit(
  tx: Tx,
  d: ApplyDeps,
  input: { appointmentId: string },
  c: ApplyContext,
): Promise<ApplyResult> {
  const appt = await tx
    .selectFrom('appointments as a')
    .innerJoin('services as s', 's.id', 'a.service_id')
    .select(['a.id', 'a.customer_id', 'a.status', 'a.price_cents', 's.tags'])
    .where('a.id', '=', input.appointmentId)
    .where('a.location_id', '=', d.locationId)
    .executeTakeFirst()
  if (!appt) throw new AppError('NOT_FOUND', { detail: 'That appointment does not exist' })
  if (appt.status === 'canceled' || appt.status === 'no_show')
    throw new AppError('MEMBERSHIP_APPOINTMENT_CLOSED')

  const membership = await tx
    .selectFrom('memberships')
    .selectAll()
    .where('customer_id', '=', appt.customer_id)
    .where('status', 'in', ['pending', 'active', 'past_due', 'paused'])
    .forUpdate()
    .executeTakeFirst()
  if (!membership) throw new AppError('MEMBERSHIP_NOT_FOUND', { detail: 'This client is not a member' })
  if (membership.status !== 'active') throw new AppError('MEMBERSHIP_NOT_ACTIVE')

  const done = await tx
    .selectFrom('membership_credit_events')
    .select('id')
    .where('appointment_id', '=', appt.id)
    .where('kind', '=', 'redeem')
    .executeTakeFirst()
  if (done) throw new AppError('MEMBERSHIP_CREDIT_APPLIED')

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
  if (!pick) throw new AppError('MEMBERSHIP_NOT_ELIGIBLE')
  if (!pick.covered) throw new AppError('MEMBERSHIP_NO_CREDIT')

  const invoice = await tx
    .selectFrom('invoices')
    .select('id')
    .where('appointment_id', '=', appt.id)
    .where('location_id', '=', d.locationId)
    .executeTakeFirst()
  if (!invoice) throw new AppError('MEMBERSHIP_NO_INVOICE')
  const calc = await calcOf(tx, invoice.id)
  if (calc.balance <= 0) throw new AppError('MEMBERSHIP_NO_BALANCE')
  const pkg = await tx
    .selectFrom('invoice_items')
    .select('price_cents')
    .where('invoice_id', '=', invoice.id)
    .where('kind', '=', 'package')
    .orderBy('position')
    .executeTakeFirst()
  const discount = Math.min(pkg?.price_cents ?? appt.price_cents, calc.sub)
  if (discount <= 0) throw new AppError('MEMBERSHIP_NO_BALANCE')

  const result = await d.payments.adjust(
    tx,
    {
      locationId: d.locationId,
      actor: creditActor(c.actor),
      audit: c.audit,
      idempotencyKey: c.idempotencyKey,
      source: 'system',
    },
    invoice.id,
    {
      kind: 'discount',
      unit: '$',
      value: discount,
      reason: CREDIT_REASON,
      note: `${pick.rule.label} · ${membership.plan_label}`,
      settle: 'credit',
    },
  )
  const cycle = membership.current_period_start!
  await sql`
    insert into membership_credit_events (id, membership_id, cycle_start, kind, qty, rule_id, appointment_id, invoice_id,
      ledger_event_id, note, actor, actor_user_id, idempotency_key, created_at)
    values (${d.newId()}, ${membership.id}, ${cycle}, 'redeem', 1, ${pick.rule.id}, ${appt.id}, ${invoice.id},
      ${result.event.id}, ${`${pick.rule.label} on ${appt.id}`}, ${c.actor.name}, ${c.actor.userId},
      ${`redeem:${appt.id}`}, ${d.clock.now()})`.execute(tx)
  const after = (
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
  return {
    ...result,
    membershipId: membership.id,
    appointmentId: appt.id,
    rule: { id: pick.rule.id, label: pick.rule.label },
    discountCents: discount,
    credits: { left: after.creditsLeft, used: after.creditsUsed },
  }
}
