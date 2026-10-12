// What cancel and no-show do about the money (ADR 0082): read the policy setting, decide the kept share from the lead time
// or the staff's explicit choice, run the settlement port in the caller's transaction and describe the outcome for the
// response, the activity log and the customer's text.
import { getSetting } from '../../platform/settings.js'
import type { Tx } from '../../platform/db.js'
import {
  activityLines,
  retentionRule,
  type CancellationPolicy,
  type SettlementKind,
  type SettlementView,
} from './cancellation.js'
import type { Actor, SchedulingCtx } from './context.js'
import type { AppointmentRecord } from './appointments.js'
import type { SettlementMode } from './ports.js'
import { proposeCardFee, proposalLine, type FeeProposal } from '../square/fees.js'
import { squareEnv } from '../square/runtime.js'
import { actorName } from './context.js'

export interface Settlement extends SettlementView {
  policy: SettlementMode
  /** The sentence that explains the decision ("Canceled 47h ahead · free cancellation up to 24h before · refunded in full"). */
  rule: string
  /**
   * A no-show or late-cancel fee on the client's saved card, PROPOSED beyond the deposit kept (ADR 0171 D7, wave Q3a): staff charge
   * or waive it (POST /appointments/:id/fee-charges/:chargeId/charge | waive). null when fees are off or nothing is due.
   */
  cardFee?: FeeProposal | null
}

export const policyOf = async (tx: Tx, c: SchedulingCtx): Promise<CancellationPolicy> =>
  (await getSetting(tx, c.locationId, 'cancellation.policy')).value

/** null when no settlement port is wired (the in-memory default): the choice is only recorded. */
export async function settleClosed(
  tx: Tx,
  c: SchedulingCtx,
  actor: Actor,
  a: AppointmentRecord,
  o: { kind: SettlementKind; mode: SettlementMode },
): Promise<Settlement | null> {
  if (!c.ports.deposits) return null
  const policy = await policyOf(tx, c)
  const leadMin = (a.scheduledStart.getTime() - c.clock.now().getTime()) / 60_000
  const rule = retentionRule(policy, { kind: o.kind, leadMin })
  const text =
    o.mode === 'keep'
      ? 'Deposit kept by staff'
      : o.mode === 'refund_card' || o.mode === 'refund_credit'
        ? 'Deposit refunded by staff'
        : rule.text
  const view = await c.ports.deposits.settle(tx, {
    appointmentId: a.id,
    locationId: c.locationId,
    kind: o.kind,
    mode: o.mode,
    retainBp: rule.retainBp,
    refundTo: policy.refundTo,
    rule: text,
    actor,
    idempotencyKey: `${o.kind}:${a.id}:v${a.version}`,
  })
  if (!view) return null
  // a fee beyond the deposit kept, proposed on a saved card (never charged here): fees.card_on_file, Square the processor
  const cardFee = await proposeCardFee(
    tx,
    { clock: c.clock, newId: c.newId, env: squareEnv() },
    {
      locationId: c.locationId,
      appointmentId: a.id,
      customerId: a.customerId,
      kind: o.kind,
      late: leadMin < policy.freeCancelHours * 60,
      retainedCents: view.retainedCents,
      mode: o.mode,
      actorName: actorName(actor),
      audit: actor.audit,
    },
  )
  return { ...view, policy: o.mode, rule: text, cardFee }
}

/** Activity lines for a settlement; the kept share names who decided. */
export const settlementLog = (s: Settlement, kind: SettlementKind): string[] => [
  ...activityLines(
    s,
    s.policy === 'policy' ? (kind === 'no_show' ? 'no-show policy' : 'cancellation policy') : 'set by staff',
  ),
  ...(s.cardFee ? [proposalLine(s.cardFee)] : []),
]
