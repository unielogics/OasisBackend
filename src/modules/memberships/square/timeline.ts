// The failure policy of the memberships billed by Square (ADR 0171 D10, plan decision 7, design 5.5), run daily by the job
// membership.billing with the setting memberships.billing_policy ({graceDays: 7, cancelDays: 21}):
//   day 0   (the invoice event, billing.ts) billing failed, in grace: perks on, the client texted their card page and Square's
//           invoice page (emailed Square's page), staff told; this job tells a client the event could not (a text that failed);
//   day 7   past due: perks off (the memberships port reads only active memberships);
//   day 21  CancelSubscription and the open invoice canceled at Square (no more retries), the membership canceled payment_failed.
// A payment at any point restores the membership (billing.ts). The days are shop-local calendar days. Square's own retries are the
// only retries: CreatePayment cannot pay a subscription invoice's order (sandbox 2026-10-12), so the design's day-3 retry is dropped.
import { getSetting } from '../../../platform/settings.js'
import * as audit from '../../../platform/audit.js'
import { transaction } from '../../../platform/db.js'
import { notifyManagers } from '../../messaging/notify.js'
import { squareWritesOn } from '../../square/links.js'
import { locationTz } from '../view.js'
import { tellPaymentFailed } from './billing.js'
import type { SquareSteps } from './steps.js'
import { failureStage } from './policy.js'

export interface BillingPolicyReport {
  considered: number
  told: number
  pastDue: number
  canceled: number
  /** Day 21 reached while Square writes are off: nothing canceled at Square (the job tries again tomorrow). */
  waiting: number
}

/** The latest failed invoice of a membership (for the notice and the day-21 cancel). */
const failedInvoiceOf = (x: SquareSteps, membershipId: string) =>
  x.db
    .selectFrom('square_subscription_invoices')
    .selectAll()
    .where('membership_id', '=', membershipId)
    .where('failed_at', 'is not', null)
    .where('paid_at', 'is', null)
    .orderBy('failed_at', 'desc')
    .executeTakeFirst()

export async function runBillingPolicy(x: SquareSteps): Promise<BillingPolicyReport> {
  const report: BillingPolicyReport = { considered: 0, told: 0, pastDue: 0, canceled: 0, waiting: 0 }
  const now = x.clock.now()
  const tz = await locationTz(x.db, x.locationId)
  const policy = (await getSetting(x.db, x.locationId, 'memberships.billing_policy')).value
  const rows = await x.db
    .selectFrom('memberships')
    .selectAll()
    .where('location_id', '=', x.locationId)
    .where('source', '=', 'square')
    .where('billing_status', '=', 'failed')
    .where('status', 'in', ['active', 'past_due'])
    .execute()
  for (const m of rows) {
    report.considered++
    const inv = await failedInvoiceOf(x, m.id)
    if (!m.failure_notified_at && inv) {
      await transaction(x.db, async (tx) => {
        const cur = await tx.selectFrom('memberships').selectAll().where('id', '=', m.id).forUpdate().executeTakeFirstOrThrow()
        if (cur.billing_status !== 'failed' || cur.failure_notified_at) return
        await tellPaymentFailed(tx, x, cur, { id: inv.square_invoice_id, amountCents: inv.amount_cents, publicUrl: inv.public_url })
        report.told++
      })
    }
    const stage = failureStage(m.payment_failed_at!, now, tz, policy)
    if (stage === 'past_due' && m.status === 'active') {
      await transaction(x.db, async (tx) => {
        const cur = await tx.selectFrom('memberships').selectAll().where('id', '=', m.id).forUpdate().executeTakeFirstOrThrow()
        if (cur.billing_status !== 'failed' || cur.status !== 'active') return
        await tx
          .updateTable('memberships')
          .set((eb) => ({ status: 'past_due', in_grace: false, updated_at: now, version: eb('version', '+', 1) }))
          .where('id', '=', m.id)
          .execute()
        await audit.record(tx, {
          locationId: x.locationId,
          action: 'membership.square.past_due',
          entityType: 'membership',
          entityId: m.id,
          before: { status: 'active' },
          after: { status: 'past_due', failedAt: m.payment_failed_at!.toISOString() },
          ctx: { actor: { name: 'Square billing' } },
        })
        report.pastDue++
      })
    }
    if (stage === 'cancel') {
      if (!squareWritesOn(x.env) || !m.square_subscription_id) {
        report.waiting++
        continue
      }
      // at Square first (outside any transaction): the subscription ends, the open invoice is canceled so Square stops asking
      await x.api.subscriptions.cancel(m.square_subscription_id)
      if (inv) {
        const wire = await x.api.invoices.get(inv.square_invoice_id)
        if (['UNPAID', 'SCHEDULED', 'PARTIALLY_PAID'].includes(wire.status)) await x.api.invoices.cancel(wire.id, wire.version ?? 0)
      }
      await transaction(x.db, async (tx) => {
        const cur = await tx.selectFrom('memberships').selectAll().where('id', '=', m.id).forUpdate().executeTakeFirstOrThrow()
        // paid meanwhile (the invoice could not be canceled because it was paid): restored, nothing to do
        if (cur.billing_status !== 'failed' || cur.status === 'canceled') return
        await tx
          .updateTable('memberships')
          .set((eb) => ({
            status: 'canceled',
            canceled_at: now,
            cancel_reason: 'payment_failed',
            in_grace: false,
            cancel_effective_at: null,
            updated_at: now,
            version: eb('version', '+', 1),
          }))
          .where('id', '=', m.id)
          .execute()
        if (inv) await tx.updateTable('square_subscription_invoices').set({ canceled_at: now, status: 'CANCELED', updated_at: now }).where('id', '=', inv.id).execute()
        await audit.record(tx, {
          locationId: x.locationId,
          action: 'membership.square.canceled_unpaid',
          entityType: 'membership',
          entityId: m.id,
          before: { status: cur.status },
          after: { status: 'canceled', failedAt: m.payment_failed_at!.toISOString(), days: policy.cancelDays },
          ctx: { actor: { name: 'Square billing' } },
        })
        const cust = await tx.selectFrom('customers').select('full_name').where('id', '=', m.customer_id).executeTakeFirst()
        await notifyManagers(
          tx,
          {
            locationId: x.locationId,
            kind: 'membership.canceled_unpaid',
            title: `Membership canceled for non-payment: ${cust?.full_name ?? 'a member'}`,
            body: `The ${m.plan_label} membership of ${cust?.full_name ?? 'a member'} was not paid for ${policy.cancelDays} days, so it was canceled at Square.`,
            entityType: 'membership',
            entityId: m.id,
          },
          { newId: x.newId, clock: x.clock },
        )
        report.canceled++
      })
    }
  }
  return report
}
