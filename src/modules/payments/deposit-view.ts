// The deposit of a visit as the appointment file shows it (ADR 0171 D2, wave Q3 dashapi; dashboard review Q2c N1): asked for by a
// link and not paid yet, paid, refunded or a refund waiting for approval, and once the visit is canceled, kept as well. Read from the
// invoice's calc, its deposit payments, its refunds and its newest deposit link; nothing here writes.
import { sql } from 'kysely'
import type { Executor } from '../../platform/db.js'
import type { PaymentLinkState } from './schema.js'

export type DepositState = 'requested' | 'link_sent' | 'link_expired' | 'paid' | 'kept' | 'refunded' | 'refund_pending'

export interface DepositView {
  /**
   * requested: a deposit link is asked for (being made, or made and not texted); link_sent: texted, not paid; link_expired: the link
   * lapsed or was withdrawn unpaid; paid: a deposit is paid on an open visit (a partial refund shows in refundedCents); on an open
   * visit refund_pending when a refund waiting for approval would leave the invoice holding less than the deposit, refunded when the
   * invoice holds nothing any more; for a canceled visit holding money: refund_pending (a refund waits for approval), refunded (all
   * of it given back), kept (some or all of it stays with the shop). A deposit paid by link and then voided gives null.
   */
  state: DepositState
  /** The amount the newest deposit link asks for; null without one. */
  requestedCents: number | null
  /** Open visit: the deposit payments less voided ones. Canceled visit: the money paid on the invoice (refunds not subtracted). */
  paidCents: number
  /** Refunds done (a refund the processor reported failed is not counted). */
  refundedCents: number
  /** Refunds waiting for approval. */
  pendingRefundCents: number
  /** Canceled visit: what stays with the shop (paid less refunded less pending refunds); 0 on an open visit. */
  keptCents: number
  /** A card refund the processor reported failed: that money was not given back. */
  refundFailed: boolean
  /** A card refund is on its way at the processor (sent, not confirmed yet); it already counts as refunded. */
  refundSending: boolean
  /** The newest deposit link (never its URL). */
  link: { state: PaymentLinkState; sentAt: string | null; expiresAt: string | null; createdAt: string } | null
}

export interface DepositFacts {
  canceled: boolean
  /** calc.paid: payments less voided ones, plus store credit applied. */
  paidCents: number
  /** calc.refunded */
  refundedCents: number
  /** calc.pendingAmt / calc.pendingN */
  pendingRefundCents: number
  pendingRefunds: number
  /** Payments flagged as deposits less their voids. */
  depositPaidCents: number
  refundFailed: boolean
  refundSending: boolean
  link: {
    state: PaymentLinkState
    expectedCents: number
    sentAt: Date | null
    expiresAt: Date | null
    createdAt: Date
    cancelReason: string | null
  } | null
}

/** The deposit block of one invoice, or null when there is no deposit to speak of. Pure. */
export function depositViewOf(f: DepositFacts): DepositView | null {
  const link = f.link
    ? { state: f.link.state, sentAt: f.link.sentAt?.toISOString() ?? null, expiresAt: f.link.expiresAt?.toISOString() ?? null, createdAt: f.link.createdAt.toISOString() }
    : null
  const base = {
    requestedCents: f.link?.expectedCents ?? null,
    refundedCents: f.refundedCents,
    pendingRefundCents: f.pendingRefundCents,
    refundFailed: f.refundFailed,
    refundSending: f.refundSending,
    link,
  }
  if (f.canceled) {
    if (f.paidCents <= 0) return null
    const keptCents = Math.max(0, f.paidCents - f.refundedCents - f.pendingRefundCents)
    const state: DepositState = f.pendingRefunds > 0 ? 'refund_pending' : f.refundedCents >= f.paidCents ? 'refunded' : 'kept'
    return { ...base, state, paidCents: f.paidCents, keptCents }
  }
  const open = { ...base, paidCents: Math.max(0, f.depositPaidCents), keptCents: 0 }
  if (f.depositPaidCents > 0) {
    // Refunds are kept per invoice, not per payment: the deposit is touched only when what the invoice still holds (paid less
    // refunded) falls below it. A refund waiting for approval that would bring it below reads refund_pending; nothing left: refunded.
    const held = f.paidCents - f.refundedCents
    if (f.pendingRefunds > 0 && held - f.pendingRefundCents < f.depositPaidCents) return { ...open, state: 'refund_pending' }
    if (held <= 0) return { ...open, state: 'refunded' }
    return { ...open, state: 'paid' }
  }
  if (!f.link) return null
  switch (f.link.state) {
    case 'pending':
      return { ...open, state: 'requested' }
    case 'active':
      return { ...open, state: f.link.sentAt ? 'link_sent' : 'requested' }
    case 'paid':
      // the link's payment is recorded as a deposit in the same transaction that marks the link paid: no deposit money left means
      // that payment was voided, so nothing is held and nothing is asked for any more
      return null
    default:
      // withdrawn because the deposit was paid some other way: nothing is asked for any more
      if (f.link.cancelReason === 'deposit_paid' || f.link.cancelReason === 'paid_elsewhere') return null
      return { ...open, state: 'link_expired' }
  }
}

export interface DepositRowFacts {
  depositPaidCents: Map<string, number>
  refunds: Map<string, { failed: boolean; sending: boolean }>
  links: Map<string, NonNullable<DepositFacts['link']>>
}

/** The deposit payments, refund flags and newest deposit link of these invoices (three batched reads). */
export async function depositRowFacts(db: Executor, invoiceIds: readonly string[]): Promise<DepositRowFacts> {
  const ids = [...invoiceIds]
  const out: DepositRowFacts = { depositPaidCents: new Map(), refunds: new Map(), links: new Map() }
  if (ids.length === 0) return out
  const [paid, refunds, links] = await Promise.all([
    sql<{ invoice_id: string; cents: number }>`
      select invoice_id,
             (coalesce(sum(amount_cents) filter (where type = 'pay' and deposit), 0)
              - coalesce(sum(amount_cents) filter (where type = 'void' and deposit), 0))::bigint as cents
      from ledger_events where invoice_id = any(${ids}::uuid[]) group by invoice_id`.execute(db),
    sql<{ invoice_id: string; failed: boolean; sending: boolean }>`
      select invoice_id,
             bool_or(status <> 'denied' and processor_state = 'failed') as failed,
             bool_or(status = 'done' and processor_state = 'awaiting_processor') as sending
      from ledger_events where invoice_id = any(${ids}::uuid[]) and type = 'refund' group by invoice_id`.execute(db),
    db
      .selectFrom('payment_links')
      .select(['invoice_id', 'state', 'expected_cents', 'sent_at', 'expires_at', 'created_at', 'cancel_reason'])
      .distinctOn('invoice_id')
      .where('invoice_id', 'in', ids)
      .where('purpose', '=', 'deposit')
      .orderBy('invoice_id')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute(),
  ])
  for (const r of paid.rows) out.depositPaidCents.set(r.invoice_id, Number(r.cents))
  for (const r of refunds.rows) out.refunds.set(r.invoice_id, { failed: !!r.failed, sending: !!r.sending })
  for (const r of links)
    out.links.set(r.invoice_id, {
      state: r.state,
      expectedCents: r.expected_cents,
      sentAt: r.sent_at,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
      cancelReason: r.cancel_reason,
    })
  return out
}
