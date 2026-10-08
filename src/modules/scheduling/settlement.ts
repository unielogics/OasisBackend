// Executes a cancel / no-show deposit settlement through the payments command layer (ADR 0082). The money held on the invoice
// (payments less refunds less refunds already waiting for approval) is split by the policy; the refund half is written by
// PaymentsService.refund, so limits, the awaiting-Squarespace flag, store-credit lots, audit and SSE are the ordinary ones.
// A policy refund is a SYSTEM event: it needs no pay.refund and is exempt from the actor's refund limit (the rule, not the
// person, decided it), and still names the real person. A staff-chosen refund is the actor's own.
import { sql } from 'kysely'
import type { Clock } from '../../platform/clock.js'
import type { Tx } from '../../platform/db.js'
import type { NewId } from '../../platform/ids.js'
import { actorFromAuth, type PayActor } from '../payments/actor.js'
import { PaymentsService, type CommandContext } from '../payments/commands.js'
import { defaultPorts } from '../payments/ports.js'
import * as audit from '../../platform/audit.js'
import type { AuditContext } from '../../platform/audit.js'
import { AppError } from '../../platform/errors.js'
import * as realtime from '../../platform/realtime.js'
import { calcOf, lockInvoice, touchInvoice } from '../payments/repository.js'
import type { RefundDest } from '../payments/schema.js'
import {
  splitHeld,
  type RefundDestination,
  type SettledRefundView,
  type SettlementView,
} from './cancellation.js'
import './problems.js'
import type { DepositSettlement, SettleRequest } from './ports.js'

export const POLICY_REASON = 'Cancellation policy'
export const NO_SHOW_REASON = 'No-show policy'

/** The caller's identity with the refund right and limit lifted, labelled as the rule that decided. */
function policyActor(real: PayActor): PayActor {
  return {
    ...real,
    has: (perm) => perm === 'pay.refund' || real.has(perm),
    limit: (kind) => (kind === 'refund' ? null : real.limit(kind)),
    rolesFor: (perm) => (perm === 'pay.refund' ? POLICY_REASON : real.rolesFor(perm)),
  }
}

async function originalTender(tx: Tx, invoiceId: string): Promise<'card' | 'cash'> {
  const r = await sql<{ kind: string | null }>`
    select e.method_kind as kind from ledger_events e
    where e.invoice_id = ${invoiceId} and e.type = 'pay'
      and not exists (select 1 from ledger_events v where v.voids_event_id = e.id)
    order by e.occurred_at desc, e.seq desc`.execute(tx)
  return r.rows.some((x) => x.kind === 'card' || x.kind === 'apple_pay' || x.kind === 'other')
    ? 'card'
    : r.rows.some((x) => x.kind === 'cash')
      ? 'cash'
      : 'card'
}

export function createDbDepositSettlement(d: { clock: Clock; newId: NewId }): DepositSettlement {
  const payments = new PaymentsService({ clock: d.clock, newId: d.newId, ports: defaultPorts() })
  return {
    async settle(tx: Tx, req: SettleRequest): Promise<SettlementView | null> {
      const inv = await tx
        .selectFrom('invoices')
        .select('id')
        .where('appointment_id', '=', req.appointmentId)
        .where('location_id', '=', req.locationId)
        .executeTakeFirst()
      if (!inv) return null
      await lockInvoice(tx, req.locationId, inv.id)
      const calc = await calcOf(tx, inv.id)
      const held = Math.max(0, calc.refundable)
      const empty: SettlementView = { heldCents: held, refundedCents: 0, retainedCents: held, refunds: [] }
      if (held === 0) return { ...empty, retainedCents: 0 }

      const manualRefund = req.mode === 'refund_card' || req.mode === 'refund_credit'
      const retainBp = req.mode === 'keep' ? 10_000 : req.mode === 'policy' ? req.retainBp : 0
      const { retained, refund } = splitHeld(held, retainBp)
      if (refund === 0) return { ...empty, retainedCents: retained }

      const toCredit = req.mode === 'refund_credit' || (req.mode === 'policy' && req.refundTo === 'credit')
      // the part that can go back to the original tender is capped by what was paid outside store credit
      const origPart = toCredit ? 0 : Math.min(refund, calc.toOrigMax)
      const creditPart = refund - origPart
      const real = actorFromAuth(req.actor.auth)
      const ctx = (suffix: string): CommandContext => ({
        locationId: req.locationId,
        actor: manualRefund ? real : policyActor(real),
        audit: req.actor.audit,
        idempotencyKey: `${req.idempotencyKey}:${suffix}`,
        ...(manualRefund ? {} : { source: 'system' as const }),
      })
      const reason = manualRefund
        ? 'Customer canceled'
        : req.kind === 'no_show'
          ? NO_SHOW_REASON
          : POLICY_REASON
      const refunds: SettledRefundView[] = []
      const run = async (amount: number, dest: RefundDest, suffix: string): Promise<void> => {
        const r = await payments.refund(tx, ctx(suffix), inv.id, {
          mode: 'custom',
          amountCents: amount,
          dest,
          reason,
          note: req.rule,
        })
        refunds.push({
          amountCents: r.event.amountCents,
          dest: dest as RefundDestination,
          state: r.event.status === 'pending' ? 'pending' : 'done',
          awaitingProcessor: r.event.awaitingProcessor,
        })
      }
      if (origPart > 0) await run(origPart, await originalTender(tx, inv.id), 'refund')
      if (creditPart > 0) await run(creditPart, 'credit', 'refund-credit')
      return {
        heldCents: held,
        refundedCents: refunds.filter((r) => r.state === 'done').reduce((n, r) => n + r.amountCents, 0),
        retainedCents: retained,
        refunds,
      }
    },
    async reopen(tx: Tx, req: { appointmentId: string; locationId: string; audit?: AuditContext }): Promise<void> {
      const inv = await tx
        .selectFrom('invoices')
        .select(['id', 'canceled_at', 'version'])
        .where('appointment_id', '=', req.appointmentId)
        .where('location_id', '=', req.locationId)
        .forUpdate()
        .executeTakeFirst()
      if (!inv?.canceled_at) return
      const refunds = await tx
        .selectFrom('ledger_events')
        .select('id')
        .where('invoice_id', '=', inv.id)
        .where('type', '=', 'refund')
        .where('status', 'in', ['done', 'pending'])
        .limit(1)
        .execute()
      if (refunds.length > 0) throw new AppError('REOPEN_REFUNDED')
      await tx
        .updateTable('invoices')
        .set({ canceled_at: null, canceled_by: null, canceled_by_name: null, cancel_reason: null })
        .where('id', '=', inv.id)
        .execute()
      const version = await touchInvoice(tx, inv.id, d.clock.now())
      await audit.record(tx, {
        locationId: req.locationId,
        action: 'payments.invoice_reopened',
        entityType: 'invoice',
        entityId: inv.id,
        after: { appointmentId: req.appointmentId },
        ctx: req.audit,
      })
      await realtime.publish(tx, {
        locationId: req.locationId,
        channel: 'payments',
        type: 'invoice.updated',
        payload: { invoiceId: inv.id, version },
      })
    },
  }
}
