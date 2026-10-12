// SquareLedgerOps (ADR 0171, design 2.2): what a Square payment or refund does to the append-only ledger, modelled on the Squarespace
// sync's SqspLedgerOps. Every command runs in the caller's transaction, locks the invoice first, checks again under the lock that the
// decision still holds (a staff member may have collected, confirmed or voided since the snapshot it was made on), and is idempotent:
//   recordPayment          a `pay` (source and processor square, confirmed) keyed square:pay:<payment id>; a payment already in the
//                          ledger under any key (a reassign, a staff confirmation) is never recorded again
//   confirmAwaiting        a staff "card" entry waiting on the processor becomes this payment (brand, last four, references)
//   recordTip              the payment's tip: invoices.tip_cents grows by it and a `pay` "Tip" keyed square:tip:<payment id>
//   attachCash             a staff cash entry of the same amount takes the POS cash payment's references (no new money)
//   reassign               a matched payment moves: a `void` of what it wrote on the wrong invoice, then recordPayment on the right one
//   recordExternalRefund   a refund made in the Square app that matches nothing: a `refund` needing review, key square:refund:<id>
//   attachPosRefund        a refund made in the Square app that is the staff's awaiting card refund of that amount
//   attachConfirmedRefund  the same, for a card refund the staff already confirmed by hand (it only takes the Square refund id)
// The common tail (version, audit, SSE, Operations refresh) is payments/announce.ts. The mirror row (square_payments) records the
// decision in the same transaction.
import { sql } from 'kysely'
import type { AuditContext } from '../../platform/audit.js'
import type { Clock } from '../../platform/clock.js'
import type { Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import type { NewId } from '../../platform/ids.js'
import { announceInvoiceChange, invoiceSnapshot } from '../payments/announce.js'
import { calcOf, cardLabel, insertEvent, lockInvoice, type EventRow } from '../payments/repository.js'
import type { SquareCandidate, SquareMatchRule } from './db/schema.js'
import { methodKindOf, type SquarePaymentFacts, type SquareRefundFacts } from './facts.js'
import './problems.js'

export interface SquareActor {
  userId?: string | null
  employeeId?: string | null
  name: string
  roles?: string | null
  audit?: AuditContext
  /** A person decided (the unmatched queue), not the matcher. */
  manual?: boolean
}

/** Who the ledger and audit rows name when Square itself is the source. */
export const SQUARE_ACTOR: SquareActor = { name: 'Square' }

export interface SquareLedgerDeps {
  locationId: string
  clock: Clock
  newId: NewId
}

/** The decision no longer holds under the lock (the invoice changed since the snapshot): plan again. */
export class SquareStaleDecision extends Error {
  constructor(why: string) {
    super(`the match no longer holds: ${why}`)
  }
}

export const payKey = (paymentId: string): string => `square:pay:${paymentId}`
export const tipKey = (paymentId: string): string => `square:tip:${paymentId}`
export const refundKey = (refundId: string): string => `square:refund:${refundId}`

const auditCtx = (a: SquareActor): AuditContext =>
  a.audit ?? { actor: { userId: a.userId ?? null, employeeId: a.employeeId ?? null, name: a.name, roles: a.roles ?? null } }

/** The ledger label of a Square payment: "Visa ••4242" for a card, "Cash", or "Square" for a wallet or anything else. */
export function squareMethod(p: Pick<SquarePaymentFacts, 'sourceType' | 'brand' | 'last4'>): {
  method: string
  kind: ReturnType<typeof methodKindOf>
  brand: string | null
  last4: string | null
} {
  const kind = methodKindOf(p.sourceType)
  if (kind === 'cash') return { method: 'Cash', kind, brand: null, last4: null }
  if (kind === 'card') {
    const c = cardLabel(p.brand, p.last4)
    return { method: c.label, kind, brand: c.brand, last4: p.last4 }
  }
  return { method: 'Square', kind, brand: null, last4: null }
}

export class SquareLedgerOps {
  constructor(private readonly d: SquareLedgerDeps) {}

  private now(): Date {
    return this.d.clock.now()
  }

  // ---- plumbing ---------------------------------------------------------------------------------------------------------------

  private async eventByKey(tx: Tx, key: string): Promise<EventRow | undefined> {
    return tx.selectFrom('ledger_events').selectAll().where('idempotency_key', '=', key).executeTakeFirst()
  }

  /** The live (not voided) pay this payment already landed on, whatever key wrote it: a staff confirmation, a reassign, the matcher. */
  async livePayOf(tx: Tx, paymentId: string): Promise<EventRow | undefined> {
    const r = await sql<EventRow>`
      select e.* from ledger_events e
      where e.location_id = ${this.d.locationId} and e.type = 'pay' and e.processor = 'square' and e.processor_ref = ${paymentId}
        and e.reason is distinct from 'Tip'
        and not exists (select 1 from ledger_events v where v.voids_event_id = e.id)
      order by e.seq limit 1`.execute(tx)
    return r.rows[0]
  }

  /** The live (not voided) tip pay of this payment, whatever key wrote it. */
  private async liveTipOf(tx: Tx, paymentId: string): Promise<EventRow | undefined> {
    const r = await sql<EventRow>`
      select e.* from ledger_events e
      where e.location_id = ${this.d.locationId} and e.type = 'pay' and e.processor = 'square' and e.processor_ref = ${paymentId}
        and e.reason = 'Tip'
        and not exists (select 1 from ledger_events v where v.voids_event_id = e.id)
      order by e.seq desc limit 1`.execute(tx)
    return r.rows[0]
  }

  private async eventFor(tx: Tx, id: string): Promise<EventRow> {
    const row = await tx
      .selectFrom('ledger_events')
      .selectAll()
      .where('id', '=', id)
      .where('location_id', '=', this.d.locationId)
      .executeTakeFirst()
    if (!row) throw new AppError('NOT_FOUND', { detail: 'That ledger entry does not exist' })
    return row
  }

  async setDecision(
    tx: Tx,
    paymentId: string,
    v: {
      invoiceId: string
      eventId: string
      tipEventId?: string | null
      rule: SquareMatchRule
      confidence: number | null
      actor: SquareActor
      variance?: Record<string, unknown> | null
    },
  ): Promise<void> {
    await tx
      .updateTable('square_payments')
      .set({
        match_state: 'matched',
        invoice_id: v.invoiceId,
        event_id: v.eventId,
        ...(v.tipEventId !== undefined ? { tip_event_id: v.tipEventId } : {}),
        rule: v.rule,
        confidence: v.confidence,
        candidates: JSON.stringify([] satisfies SquareCandidate[]),
        ...(v.variance ? { variance: JSON.stringify(v.variance) } : {}),
        decided_by: v.actor.name,
        decided_by_user_id: v.actor.userId ?? null,
        decided_at: this.now(),
        ignore_reason: null,
        ignore_note: null,
        updated_at: this.now(),
      })
      .where('square_payment_id', '=', paymentId)
      .where('location_id', '=', this.d.locationId)
      .execute()
  }

  // ---- payments ---------------------------------------------------------------------------------------------------------------

  /**
   * A `pay` for the payment's amount (the tip on top, as its own row). Idempotent on the key; a payment already live in the ledger
   * (on this or another invoice) is not recorded again: its event is returned with created=false.
   */
  async recordPayment(
    tx: Tx,
    i: {
      facts: SquarePaymentFacts
      invoiceId: string
      rule: SquareMatchRule
      confidence: number | null
      deposit?: boolean
      paymentLinkId?: string | null
      actor?: SquareActor
      key?: string
      variance?: Record<string, unknown> | null
      /** The ledger row's reason (a saved-card charge: "No-show fee", "Late-cancel fee", "Balance"). */
      reason?: string | null
    },
  ): Promise<{ eventId: string; invoiceId: string; tipEventId: string | null; created: boolean }> {
    const actor = i.actor ?? SQUARE_ACTOR
    const inv = await lockInvoice(tx, this.d.locationId, i.invoiceId)
    const key = i.key ?? payKey(i.facts.paymentId)
    const byKey = await this.eventByKey(tx, key)
    if (byKey) return { eventId: byKey.id, invoiceId: byKey.invoice_id, tipEventId: null, created: false }
    const live = await this.livePayOf(tx, i.facts.paymentId)
    if (live) return { eventId: live.id, invoiceId: live.invoice_id, tipEventId: null, created: false }
    const before = await invoiceSnapshot(tx, inv.id)
    const now = this.now()
    const m = squareMethod(i.facts)
    const row = await insertEvent(tx, {
      id: this.d.newId(),
      location_id: this.d.locationId,
      invoice_id: inv.id,
      customer_id: inv.customer_id,
      type: 'pay',
      amount_cents: i.facts.amountCents,
      status: 'done',
      method: m.method,
      method_kind: m.kind,
      brand: m.brand,
      last4: m.last4,
      deposit: i.deposit ?? false,
      ...(i.reason ? { reason: i.reason } : {}),
      actor_user_id: actor.userId ?? null,
      actor_employee_id: actor.employeeId ?? null,
      actor_name: actor.manual ? actor.name : 'Square',
      actor_roles: actor.roles ?? null,
      occurred_at: i.facts.createdAt,
      source: 'square',
      processor: 'square',
      processor_state: 'confirmed',
      processor_ref: i.facts.paymentId,
      processor_order_id: i.facts.orderId,
      processor_confirmed_at: now,
      processor_confirmed_by: 'Square',
      idempotency_key: key,
    })
    const tip = await this.tipOn(tx, inv.id, i.facts, actor)
    if (i.paymentLinkId)
      await tx
        .updateTable('payment_links')
        .set({ state: 'paid', paid_square_payment_id: i.facts.paymentId })
        .where('id', '=', i.paymentLinkId)
        .where('state', 'in', ['active', 'pending', 'canceled', 'expired'])
        .execute()
    await this.setDecision(tx, i.facts.paymentId, {
      invoiceId: inv.id,
      eventId: row.id,
      tipEventId: tip,
      rule: i.rule,
      confidence: i.confidence,
      actor,
      variance: i.variance ?? null,
    })
    await announceInvoiceChange(tx, {
      locationId: this.d.locationId,
      invoiceId: inv.id,
      now,
      action: 'square.record_payment',
      ctx: auditCtx(actor),
      before,
      after: {
        eventId: row.id,
        squarePaymentId: i.facts.paymentId,
        amountCents: i.facts.amountCents,
        tipCents: i.facts.tipCents,
        rule: i.rule,
        deposit: i.deposit ?? false,
        paymentLinkId: i.paymentLinkId ?? null,
      },
      events: tip ? [{ id: row.id, type: 'pay' }, { id: tip, type: 'pay' }] : [{ id: row.id, type: 'pay' }],
    })
    return { eventId: row.id, invoiceId: inv.id, tipEventId: tip, created: true }
  }

  /** The tip of the payment, once: invoices.tip_cents grows by it and a `pay` "Tip" pays it (so the balance does not move). */
  private async tipOn(tx: Tx, invoiceId: string, f: SquarePaymentFacts, actor: SquareActor): Promise<string | null> {
    if (f.tipCents <= 0) return null
    const key = tipKey(f.paymentId)
    const had = await this.eventByKey(tx, key)
    if (had) return had.id
    const inv = await tx.selectFrom('invoices').select(['customer_id', 'tip_cents']).where('id', '=', invoiceId).executeTakeFirstOrThrow()
    await tx.updateTable('invoices').set({ tip_cents: inv.tip_cents + f.tipCents }).where('id', '=', invoiceId).execute()
    const m = squareMethod(f)
    const row = await insertEvent(tx, {
      id: this.d.newId(),
      location_id: this.d.locationId,
      invoice_id: invoiceId,
      customer_id: inv.customer_id,
      type: 'pay',
      amount_cents: f.tipCents,
      status: 'done',
      method: m.method,
      method_kind: m.kind,
      brand: m.brand,
      last4: m.last4,
      reason: 'Tip',
      actor_user_id: actor.userId ?? null,
      actor_name: actor.manual ? actor.name : 'Square',
      occurred_at: f.createdAt,
      source: 'square',
      processor: 'square',
      processor_state: 'confirmed',
      processor_ref: f.paymentId,
      processor_order_id: f.orderId,
      processor_confirmed_at: this.now(),
      processor_confirmed_by: 'Square',
      idempotency_key: key,
    })
    return row.id
  }

  /** Records the payment's tip on the invoice it landed on (also used when a staff entry is confirmed). Audited. */
  async recordTip(tx: Tx, i: { facts: SquarePaymentFacts; invoiceId: string; actor?: SquareActor }): Promise<string | null> {
    const actor = i.actor ?? SQUARE_ACTOR
    await lockInvoice(tx, this.d.locationId, i.invoiceId)
    if (i.facts.tipCents <= 0) return null
    const had = await this.eventByKey(tx, tipKey(i.facts.paymentId))
    if (had) return had.id
    const before = await invoiceSnapshot(tx, i.invoiceId)
    const id = await this.tipOn(tx, i.invoiceId, i.facts, actor)
    await announceInvoiceChange(tx, {
      locationId: this.d.locationId,
      invoiceId: i.invoiceId,
      now: this.now(),
      action: 'square.record_tip',
      ctx: auditCtx(actor),
      before,
      after: { tipEventId: id, tipCents: i.facts.tipCents, squarePaymentId: i.facts.paymentId },
      events: id ? [{ id, type: 'pay' }] : [],
    })
    return id
  }

  /**
   * The staff's "card" entry waiting on the processor is this payment: it is confirmed with the brand, last four and references,
   * and the tip is recorded on top. Refused (SquareStaleDecision) when, under the lock, the entry is no longer waiting, was voided,
   * belongs to another payment or is of another amount.
   */
  async confirmAwaiting(
    tx: Tx,
    i: { facts: SquarePaymentFacts; eventId: string; rule: SquareMatchRule; confidence: number | null; actor?: SquareActor },
  ): Promise<{ eventId: string; invoiceId: string; tipEventId: string | null; created: boolean }> {
    const actor = i.actor ?? SQUARE_ACTOR
    const probe = await this.eventFor(tx, i.eventId)
    await lockInvoice(tx, this.d.locationId, probe.invoice_id)
    const live = await this.livePayOf(tx, i.facts.paymentId)
    if (live) return { eventId: live.id, invoiceId: live.invoice_id, tipEventId: null, created: false }
    const ev = await this.eventFor(tx, i.eventId)
    const voided = await tx.selectFrom('ledger_events').select('id').where('voids_event_id', '=', ev.id).executeTakeFirst()
    if (ev.type !== 'pay' || ev.processor_state !== 'awaiting_processor' || voided || ev.processor_ref)
      throw new SquareStaleDecision('the staff entry is no longer waiting')
    if (ev.amount_cents !== i.facts.amountCents) throw new SquareStaleDecision('the staff entry is of another amount')
    const before = await invoiceSnapshot(tx, ev.invoice_id)
    const now = this.now()
    const m = squareMethod(i.facts)
    await tx
      .updateTable('ledger_events')
      .set({
        processor_state: 'confirmed',
        processor_confirmed_at: now,
        processor_confirmed_by: actor.manual ? actor.name : 'Square',
        processor: 'square',
        processor_ref: i.facts.paymentId,
        processor_order_id: i.facts.orderId,
        // a staff "Card" becomes "Visa ••4242" (the guard allows it on this move only)
        ...(m.kind === 'card' ? { method: m.method, brand: m.brand, last4: m.last4 } : {}),
      })
      .where('id', '=', ev.id)
      .execute()
    const tip = await this.tipOn(tx, ev.invoice_id, i.facts, actor)
    await this.setDecision(tx, i.facts.paymentId, {
      invoiceId: ev.invoice_id,
      eventId: ev.id,
      tipEventId: tip,
      rule: i.rule,
      confidence: i.confidence,
      actor,
    })
    await announceInvoiceChange(tx, {
      locationId: this.d.locationId,
      invoiceId: ev.invoice_id,
      now,
      action: 'square.confirm_awaiting',
      ctx: auditCtx(actor),
      before,
      after: { eventId: ev.id, squarePaymentId: i.facts.paymentId, tipCents: i.facts.tipCents, rule: i.rule },
      events: tip ? [{ id: ev.id, type: 'pay' }, { id: tip, type: 'pay' }] : [{ id: ev.id, type: 'pay' }],
    })
    return { eventId: ev.id, invoiceId: ev.invoice_id, tipEventId: tip, created: false }
  }

  /** A staff cash entry of the same amount takes the POS cash payment's references; no money moves. */
  async attachCash(
    tx: Tx,
    i: { facts: SquarePaymentFacts; eventId: string; actor?: SquareActor },
  ): Promise<{ eventId: string; invoiceId: string }> {
    const actor = i.actor ?? SQUARE_ACTOR
    const probe = await this.eventFor(tx, i.eventId)
    await lockInvoice(tx, this.d.locationId, probe.invoice_id)
    const live = await this.livePayOf(tx, i.facts.paymentId)
    if (live) return { eventId: live.id, invoiceId: live.invoice_id }
    const ev = await this.eventFor(tx, i.eventId)
    const voided = await tx.selectFrom('ledger_events').select('id').where('voids_event_id', '=', ev.id).executeTakeFirst()
    if (ev.type !== 'pay' || ev.method_kind !== 'cash' || ev.processor_ref || voided || ev.amount_cents !== i.facts.amountCents)
      throw new SquareStaleDecision('the cash entry changed')
    await tx
      .updateTable('ledger_events')
      .set({ processor: 'square', processor_ref: i.facts.paymentId, processor_order_id: i.facts.orderId })
      .where('id', '=', ev.id)
      .execute()
    await this.setDecision(tx, i.facts.paymentId, { invoiceId: ev.invoice_id, eventId: ev.id, rule: 'cash_entry', confidence: 0.95, actor })
    await announceInvoiceChange(tx, {
      locationId: this.d.locationId,
      invoiceId: ev.invoice_id,
      now: this.now(),
      action: 'square.attach_cash',
      ctx: auditCtx(actor),
      after: { eventId: ev.id, squarePaymentId: i.facts.paymentId },
      events: [{ id: ev.id, type: 'pay' }],
    })
    return { eventId: ev.id, invoiceId: ev.invoice_id }
  }

  /**
   * Moves a matched payment to the right invoice (pay.void): a `void` of what it wrote on the wrong one (and of its tip, whose amount
   * leaves that invoice's tip), then the payment recorded on the right one. Refused once money was refunded against it.
   */
  async reassign(
    tx: Tx,
    i: { facts: SquarePaymentFacts; fromEventId: string; toInvoiceId: string; actor: SquareActor },
  ): Promise<{ eventId: string; voidEventIds: string[] }> {
    const from = await this.eventFor(tx, i.fromEventId)
    if (from.invoice_id === i.toInvoiceId) throw new AppError('SQUARE_PAYMENT_DECIDED', { detail: 'The payment is already on that invoice' })
    // both invoices, in a fixed order (two reassigns the other way round cannot deadlock)
    for (const id of [from.invoice_id, i.toInvoiceId].sort()) await lockInvoice(tx, this.d.locationId, id)
    const legs = await tx
      .selectFrom('square_refund_legs')
      .select('id')
      .where('square_payment_id', '=', i.facts.paymentId)
      .where('state', 'in', ['to_submit', 'pending', 'completed'])
      .executeTakeFirst()
    // the payment's live tip, whatever key wrote it (square:tip:<id>, or the key of an earlier reassign)
    const tipRow = await this.liveTipOf(tx, i.facts.paymentId)
    const moving = from.amount_cents + (tipRow && tipRow.invoice_id === from.invoice_id ? tipRow.amount_cents : 0)
    const calc = await calcOf(tx, from.invoice_id)
    if (legs || calc.paid - moving - calc.refunded - calc.pendingAmt < 0) throw new AppError('SQUARE_REASSIGN_REFUNDED')
    const before = await invoiceSnapshot(tx, from.invoice_id)
    const now = this.now()
    const voids: EventRow[] = []
    for (const ev of [from, ...(tipRow && tipRow.invoice_id === from.invoice_id ? [tipRow] : [])]) {
      const already = await tx.selectFrom('ledger_events').select('id').where('voids_event_id', '=', ev.id).executeTakeFirst()
      if (already) continue
      voids.push(
        await insertEvent(tx, {
          id: this.d.newId(),
          location_id: this.d.locationId,
          invoice_id: ev.invoice_id,
          customer_id: ev.customer_id,
          type: 'void',
          amount_cents: ev.amount_cents,
          method: ev.method,
          method_kind: ev.method_kind,
          brand: ev.brand,
          deposit: ev.deposit,
          voids_event_id: ev.id,
          reason: 'Voided',
          note: 'Square payment moved to another invoice',
          actor_user_id: i.actor.userId ?? null,
          actor_employee_id: i.actor.employeeId ?? null,
          actor_name: i.actor.name,
          actor_roles: i.actor.roles ?? null,
          occurred_at: now,
          source: 'oasis',
          idempotency_key: `square:void:${ev.id}`,
        }),
      )
    }
    // a staff entry the payment had confirmed stays confirmed and voided; the tip goes with the payment
    if (tipRow && tipRow.invoice_id === from.invoice_id) {
      const inv = await tx.selectFrom('invoices').select('tip_cents').where('id', '=', from.invoice_id).executeTakeFirstOrThrow()
      await tx
        .updateTable('invoices')
        .set({ tip_cents: Math.max(0, inv.tip_cents - tipRow.amount_cents) })
        .where('id', '=', from.invoice_id)
        .execute()
    }
    await announceInvoiceChange(tx, {
      locationId: this.d.locationId,
      invoiceId: from.invoice_id,
      now,
      action: 'square.reassign_from',
      ctx: auditCtx(i.actor),
      before,
      after: { squarePaymentId: i.facts.paymentId, toInvoiceId: i.toInvoiceId, voided: voids.map((v) => v.voids_event_id) },
      events: voids,
    })
    // the tip is moved below under its own key (recordPayment would find the first tip's key and take nothing along)
    const moved = await this.recordPayment(tx, {
      facts: { ...i.facts, tipCents: 0 },
      invoiceId: i.toInvoiceId,
      rule: 'reassign',
      confidence: 1,
      deposit: from.deposit,
      actor: { ...i.actor, manual: true },
      key: `square:pay:${i.facts.paymentId}:to:${i.toInvoiceId}:${voids[0]?.id ?? from.id}`,
    })
    // the tip moves under its own key on the new invoice
    if (tipRow && tipRow.invoice_id === from.invoice_id && moved.created) {
      const tip = await this.moveTip(tx, i.toInvoiceId, i.facts, tipRow, i.actor)
      await tx.updateTable('square_payments').set({ tip_event_id: tip }).where('square_payment_id', '=', i.facts.paymentId).execute()
    }
    return { eventId: moved.eventId, voidEventIds: voids.map((v) => v.id) }
  }

  private async moveTip(tx: Tx, invoiceId: string, f: SquarePaymentFacts, old: EventRow, actor: SquareActor): Promise<string> {
    const key = `square:tip:${f.paymentId}:to:${invoiceId}:${old.id}`
    const had = await this.eventByKey(tx, key)
    if (had) return had.id
    const inv = await tx.selectFrom('invoices').select(['customer_id', 'tip_cents']).where('id', '=', invoiceId).executeTakeFirstOrThrow()
    await tx.updateTable('invoices').set({ tip_cents: inv.tip_cents + old.amount_cents }).where('id', '=', invoiceId).execute()
    const row = await insertEvent(tx, {
      id: this.d.newId(),
      location_id: this.d.locationId,
      invoice_id: invoiceId,
      customer_id: inv.customer_id,
      type: 'pay',
      amount_cents: old.amount_cents,
      status: 'done',
      method: old.method,
      method_kind: old.method_kind,
      brand: old.brand,
      last4: old.last4,
      reason: 'Tip',
      actor_user_id: actor.userId ?? null,
      actor_name: actor.name,
      occurred_at: f.createdAt,
      source: 'square',
      processor: 'square',
      processor_state: 'confirmed',
      processor_ref: f.paymentId,
      processor_order_id: f.orderId,
      processor_confirmed_at: this.now(),
      processor_confirmed_by: 'Square',
      idempotency_key: key,
    })
    return row.id
  }

  // ---- refunds made in the Square app ---------------------------------------------------------------------------------------

  /** A Square refund that matches no Oasis refund: recorded as a card refund that needs review (key square:refund:<id>). */
  async recordExternalRefund(
    tx: Tx,
    i: { refund: SquareRefundFacts; invoiceId: string; payment: SquarePaymentFacts },
  ): Promise<{ eventId: string; created: boolean }> {
    const inv = await lockInvoice(tx, this.d.locationId, i.invoiceId)
    const key = refundKey(i.refund.refundId)
    const had = await this.eventByKey(tx, key)
    if (had) return { eventId: had.id, created: false }
    const before = await invoiceSnapshot(tx, inv.id)
    const now = this.now()
    const m = squareMethod(i.payment)
    const row = await insertEvent(tx, {
      id: this.d.newId(),
      location_id: this.d.locationId,
      invoice_id: inv.id,
      customer_id: inv.customer_id,
      type: 'refund',
      amount_cents: i.refund.amountCents,
      status: 'done',
      dest: m.kind === 'cash' ? 'cash' : 'card',
      method: m.method,
      method_kind: m.kind,
      brand: m.brand,
      last4: m.last4,
      reason: 'Refunded in Square',
      note: 'Made directly in the Square app, outside Oasis limits and approvals. Review it.',
      actor_name: 'Square',
      occurred_at: i.refund.createdAt,
      resolved_at: i.refund.createdAt,
      source: 'square',
      processor: 'square',
      processor_state: 'confirmed',
      processor_ref: i.refund.refundId,
      processor_order_id: i.payment.orderId,
      processor_confirmed_at: now,
      processor_confirmed_by: 'Square',
      needs_review: true,
      idempotency_key: key,
    })
    await this.posLeg(tx, row.id, i.refund)
    await announceInvoiceChange(tx, {
      locationId: this.d.locationId,
      invoiceId: inv.id,
      now,
      action: 'square.external_refund',
      ctx: auditCtx(SQUARE_ACTOR),
      before,
      after: { eventId: row.id, amountCents: i.refund.amountCents, squareRefundId: i.refund.refundId, squarePaymentId: i.payment.paymentId },
      events: [{ id: row.id, type: 'refund' }],
    })
    return { eventId: row.id, created: true }
  }

  /** The staff's card refund waiting on the processor (same amount, no legs) is this refund made in the Square app. */
  async attachPosRefund(tx: Tx, i: { refund: SquareRefundFacts; eventId: string }): Promise<void> {
    const probe = await this.eventFor(tx, i.eventId)
    await lockInvoice(tx, this.d.locationId, probe.invoice_id)
    const ev = await this.eventFor(tx, i.eventId)
    const legs = await tx.selectFrom('square_refund_legs').select('id').where('ledger_event_id', '=', ev.id).executeTakeFirst()
    if (ev.type !== 'refund' || ev.processor_state !== 'awaiting_processor' || legs || ev.amount_cents !== i.refund.amountCents)
      throw new SquareStaleDecision('the refund is no longer waiting')
    const before = await invoiceSnapshot(tx, ev.invoice_id)
    const now = this.now()
    await tx
      .updateTable('ledger_events')
      .set({
        processor_state: 'confirmed',
        processor_confirmed_at: now,
        processor_confirmed_by: 'Square',
        processor: 'square',
        processor_ref: i.refund.refundId,
      })
      .where('id', '=', ev.id)
      .execute()
    await this.posLeg(tx, ev.id, i.refund)
    await announceInvoiceChange(tx, {
      locationId: this.d.locationId,
      invoiceId: ev.invoice_id,
      now,
      action: 'square.confirm_refund',
      ctx: auditCtx(SQUARE_ACTOR),
      before,
      after: { eventId: ev.id, squareRefundId: i.refund.refundId },
      events: [{ id: ev.id, type: 'refund' }],
    })
  }

  /**
   * The staff's card refund they confirmed by hand (no processor reference, no legs, same amount) is this refund made in the Square
   * app: it takes the Square refund id; nothing else changes (the money already counts once).
   */
  async attachConfirmedRefund(tx: Tx, i: { refund: SquareRefundFacts; eventId: string }): Promise<void> {
    const probe = await this.eventFor(tx, i.eventId)
    await lockInvoice(tx, this.d.locationId, probe.invoice_id)
    const ev = await this.eventFor(tx, i.eventId)
    const legs = await tx.selectFrom('square_refund_legs').select('id').where('ledger_event_id', '=', ev.id).executeTakeFirst()
    if (
      ev.type !== 'refund' ||
      ev.dest !== 'card' ||
      ev.processor_state !== 'confirmed' ||
      ev.processor_ref ||
      ev.sqsp_order_id ||
      ev.processor === 'squarespace' ||
      legs ||
      ev.amount_cents !== i.refund.amountCents
    )
      throw new SquareStaleDecision('the refund changed')
    await tx.updateTable('ledger_events').set({ processor: 'square', processor_ref: i.refund.refundId }).where('id', '=', ev.id).execute()
    await this.posLeg(tx, ev.id, i.refund)
    await announceInvoiceChange(tx, {
      locationId: this.d.locationId,
      invoiceId: ev.invoice_id,
      now: this.now(),
      action: 'square.attach_refund',
      ctx: auditCtx(SQUARE_ACTOR),
      after: { eventId: ev.id, squareRefundId: i.refund.refundId },
      events: [{ id: ev.id, type: 'refund' }],
    })
  }

  private async posLeg(tx: Tx, eventId: string, r: SquareRefundFacts): Promise<void> {
    await tx
      .insertInto('square_refund_legs')
      .values({
        id: this.d.newId(),
        location_id: this.d.locationId,
        ledger_event_id: eventId,
        square_payment_id: r.paymentId ?? '',
        amount_cents: r.amountCents,
        origin: 'pos',
        square_refund_id: r.refundId,
        state: 'completed',
        completed_at: this.now(),
      })
      .onConflict((oc) => oc.column('square_refund_id').doNothing())
      .execute()
  }
}
