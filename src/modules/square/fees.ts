// No-show and late-cancel fees on a saved card (ADR 0171 D7, design q-design-square.md 4.3, wave Q3a). Off until the owner sets the
// amounts (setting fees.card_on_file {enabled:false, noShowCents, lateCancelCents}) and only once Square is the processor.
//
// settleClosed (scheduling/closing.ts) calls proposeCardFee after the deposit is settled. A fee is due on a no-show, and on a cancel
// inside the free-cancellation window (the same rule that keeps the deposit). What is proposed is the fee BEYOND the deposit the shop
// kept (a $25 deposit kept against a $40 fee proposes $15), on the client's newest saved card whose consent covers that fee, as a
// square_charges row `proposed`. It NEVER charges: a staff member charges it or waives it (charges.ts chargeFee / waiveFee). When the
// staff's own choice was to refund the deposit, no fee is proposed (they decided to be lenient). A visit brought back (reopen) has its
// open fee waived.
import type { Env } from '../../config/env.js'
import * as audit from '../../platform/audit.js'
import type { AuditContext } from '../../platform/audit.js'
import type { Clock } from '../../platform/clock.js'
import type { Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import type { NewId } from '../../platform/ids.js'
import { formatUsd } from '../../platform/money.js'
import { getSetting } from '../../platform/settings.js'
import { cardLabel } from '../payments/repository.js'
import { REASONS, cardsOn, usableCard } from './charges.js'
import type { SquareChargePurpose } from './db/cards-schema.js'
import { sqKey } from '../../integrations/square/keys.js'
import './db/cards-schema.js'
import './problems.js'

export interface FeeProposalInput {
  locationId: string
  appointmentId: string
  customerId: string
  kind: 'canceled' | 'no_show'
  /** A cancel inside the free-cancellation window (or after the start). */
  late: boolean
  /** The deposit the shop kept by this settlement. */
  retainedCents: number
  /** How the deposit was settled: a staff refund means no fee. */
  mode: 'policy' | 'keep' | 'refund_card' | 'refund_credit'
  /** Who closed the visit (the activity line and proposed_by). */
  actorName: string | null
  audit?: AuditContext
}

export type FeePurpose = Exclude<SquareChargePurpose, 'balance'>

export interface FeeProposal {
  chargeId: string
  purpose: FeePurpose
  amountCents: number
  cardLabel: string
}

/**
 * Proposes the fee of a closed visit, in the caller's transaction (the cancel or no-show): null when fees are off, Square is not the
 * processor, no fee is due beyond the kept deposit, the client has no card whose consent covers it, or an open fee exists already.
 */
export async function proposeCardFee(
  tx: Tx,
  d: { clock: Clock; newId: NewId; env: Pick<Env, 'PAYMENT_PROCESSOR'> },
  i: FeeProposalInput,
): Promise<FeeProposal | null> {
  if (!cardsOn(d.env)) return null
  if (i.mode === 'refund_card' || i.mode === 'refund_credit') return null
  if (i.kind === 'canceled' && !i.late) return null
  const fees = (await getSetting(tx, i.locationId, 'fees.card_on_file')).value
  if (!fees.enabled) return null
  const purpose: FeePurpose = i.kind === 'no_show' ? 'no_show_fee' : 'late_cancel_fee'
  const fee = purpose === 'no_show_fee' ? fees.noShowCents : fees.lateCancelCents
  const amount = fee - Math.max(0, i.retainedCents)
  if (amount <= 0) return null
  const now = d.clock.now()
  const usable = await usableCard(tx, { locationId: i.locationId, customerId: i.customerId, purpose, now })
  if (!usable) return null
  const open = await tx
    .selectFrom('square_charges')
    .select('id')
    .where('appointment_id', '=', i.appointmentId)
    .where('purpose', '=', purpose)
    .where('state', 'in', ['proposed', 'charging', 'unknown', 'declined', 'charged'])
    .executeTakeFirst()
  if (open) return null
  const inv = await tx.selectFrom('invoices').select('id').where('appointment_id', '=', i.appointmentId).executeTakeFirst()
  if (!inv) return null
  const id = d.newId()
  await tx
    .insertInto('square_charges')
    .values({
      id,
      location_id: i.locationId,
      customer_id: i.customerId,
      card_id: usable.card.id,
      consent_id: usable.consentId,
      purpose,
      amount_cents: amount,
      state: 'proposed',
      idempotency_key: sqKey('ch', id),
      invoice_id: inv.id,
      appointment_id: i.appointmentId,
      proposed_by: i.actorName,
      reason: REASONS[purpose],
      created_at: now,
      updated_at: now,
    })
    .execute()
  const label = cardLabel(usable.card.brand, usable.card.last4).label
  await audit.record(tx, {
    locationId: i.locationId,
    action: 'card.fee_proposed',
    entityType: 'square_charge',
    entityId: id,
    after: { purpose, amountCents: amount, feeCents: fee, retainedCents: i.retainedCents, appointmentId: i.appointmentId, cardId: usable.card.id },
    ctx: i.audit,
  })
  return { chargeId: id, purpose, amountCents: amount, cardLabel: label }
}

/** The activity line of a proposal: "No-show fee proposed · $15.00 on Visa ••4242 (charge or waive it)". */
export const proposalLine = (p: FeeProposal): string => `${REASONS[p.purpose]} proposed · ${formatUsd(p.amountCents)} on ${p.cardLabel} (charge or waive it)`

/**
 * A visit brought back (reopen): its open fee is waived ("Visit reopened"). 409 CARD_CHARGE_IN_PROGRESS while an attempt waits for
 * Square (reopen after it is decided). A charged fee stays on the invoice as money toward the visit.
 */
export async function waiveFeesOnReopen(tx: Tx, d: { clock: Clock; locationId: string }, appointmentId: string, ctx?: AuditContext): Promise<number> {
  const rows = await tx
    .selectFrom('square_charges')
    .select(['id', 'state', 'purpose', 'amount_cents'])
    .where('location_id', '=', d.locationId)
    .where('appointment_id', '=', appointmentId)
    .where('purpose', 'in', ['no_show_fee', 'late_cancel_fee'])
    .where('state', 'in', ['proposed', 'declined', 'charging', 'unknown'])
    .forUpdate()
    .execute()
  if (rows.some((r) => r.state === 'charging' || r.state === 'unknown')) throw new AppError('CARD_CHARGE_IN_PROGRESS')
  const now = d.clock.now()
  for (const r of rows) {
    await tx
      .updateTable('square_charges')
      .set({ state: 'waived', waive_reason: 'Visit reopened', decided_by: 'Oasis', decided_at: now, updated_at: now })
      .where('id', '=', r.id)
      .execute()
    await audit.record(tx, {
      locationId: d.locationId,
      action: 'card.fee_waived',
      entityType: 'square_charge',
      entityId: r.id,
      before: { state: r.state },
      after: { state: 'waived', purpose: r.purpose, amountCents: r.amount_cents, reason: 'Visit reopened' },
      ctx,
    })
  }
  return rows.length
}
