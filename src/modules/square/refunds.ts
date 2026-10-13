// Card refunds through the Square API (ADR 0171 D4, design 3.6). The refund ledger row is the outbox: a card refund written while
// Square is the processor, on an invoice holding Square card money, carries processor 'square' and waits on the processor
// (PaymentsService.refund, approveRefund, adjust and the cancel / no-show settlement write it exactly as before). The job
// square.refunds.submit (every minute):
//   1. plans the legs under the invoice lock: the invoice's Square payments newest first, each capped by what it can still give back
//      (its total, tip included, less its live legs); a refund the Square money cannot cover is marked failed at once (alert);
//   2. sends RefundPayment for each leg with its own key (rf_<leg id>): a retry after a timeout answers the same refund;
//   3. refund.* webhooks (and the catch-up) move the legs; once every leg is settled: all completed -> the refund is confirmed; any leg
//      FAILED or REJECTED -> processor_state 'failed': it no longer counts as refunded (invoice_calc_of and its twins), what the
//      completed legs gave back is written as its own confirmed card refund (settleRefundEvent), and staff are alerted to give the
//      rest back another way. A refund sent to Square, or that the job will send, is not confirmed by hand (confirmProcessor refuses it).
// A refund made in the Square POS app is attached to the staff's awaiting card refund of that amount (or to one they confirmed by hand
// before Square's event arrived), or recorded as an external refund that needs review (ingestSquareRefund).
import { sql } from 'kysely'
import type { Env } from '../../config/env.js'
import type { SquareApi } from '../../integrations/ports/square.js'
import { SquareApiError, SquareError, SquareNetworkError } from '../../integrations/square/errors.js'
import { sqKey } from '../../integrations/square/keys.js'
import { usd } from '../../integrations/square/money.js'
import type { Clock } from '../../platform/clock.js'
import { transaction, type Db, type Tx } from '../../platform/db.js'
import type { NewId } from '../../platform/ids.js'
import { maskText } from '../../platform/logging.js'
import { announceInvoiceChange, invoiceSnapshot } from '../payments/announce.js'
import { insertEvent, lockInvoice } from '../payments/repository.js'
import type { SquareRefundLegState } from './db/schema.js'
import { factsOfRow, type SquareRefundFacts } from './facts.js'
import type { SquareLogger } from './ingest.js'
import { SquareLedgerOps, SquareStaleDecision } from './ledger.js'
import { squareProcessor, squareWritesOn } from './links.js'

export interface SquarePayRef {
  paymentId: string
  /** What the payment took, tip included. */
  totalCents: number
  /** Already given back or on its way (live legs of any refund). */
  usedCents: number
  occurredAt: Date
}

export interface PlannedLeg {
  paymentId: string
  amountCents: number
}

/** Newest payment first, each capped by what it can still give back. Null when the Square money cannot cover the amount. Pure. */
export function planRefundLegs(pays: readonly SquarePayRef[], amountCents: number): PlannedLeg[] | null {
  const ordered = [...pays].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || a.paymentId.localeCompare(b.paymentId))
  const legs: PlannedLeg[] = []
  let left = amountCents
  for (const p of ordered) {
    if (left <= 0) break
    const cap = Math.max(0, p.totalCents - p.usedCents)
    const take = Math.min(cap, left)
    if (take > 0) {
      legs.push({ paymentId: p.paymentId, amountCents: take })
      left -= take
    }
  }
  return left === 0 && amountCents > 0 ? legs : null
}

export interface RefundJobDeps {
  db: Db
  clock: Clock
  newId: NewId
  env: Env
  api: SquareApi
  logger: SquareLogger
  locationId: string
}

export interface RefundRunReport {
  status: 'ok' | 'skipped'
  reason?: string
  planned: number
  uncovered: number
  submitted: number
  failed: number
  retry: number
}

const LIVE_LEG: SquareRefundLegState[] = ['to_submit', 'pending', 'completed']

/** The invoice's Square card payments and what each can still give back. */
async function squarePaysOf(tx: Tx, invoiceId: string): Promise<SquarePayRef[]> {
  const r = await sql<{ payment_id: string; total: string | number; at: Date }>`
    select e.processor_ref as payment_id, sum(e.amount_cents) as total, min(e.occurred_at) as at
    from ledger_events e
    where e.invoice_id = ${invoiceId} and e.type = 'pay' and e.processor = 'square' and e.processor_state = 'confirmed'
      and e.processor_ref is not null and coalesce(e.method_kind, 'other') <> 'cash'
      and not exists (select 1 from ledger_events v where v.voids_event_id = e.id)
    group by e.processor_ref`.execute(tx)
  const out: SquarePayRef[] = []
  for (const p of r.rows) {
    const used = await tx
      .selectFrom('square_refund_legs')
      .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('amount_cents'), eb.lit(0)).as('used'))
      .where('square_payment_id', '=', p.payment_id)
      .where('state', 'in', LIVE_LEG)
      .executeTakeFirst()
    out.push({ paymentId: p.payment_id, totalCents: Number(p.total), usedCents: Number(used?.used ?? 0), occurredAt: p.at })
  }
  return out
}

/**
 * Moves the refund event once every leg is settled (none to submit or pending), under the invoice lock:
 *   all completed -> confirmed;
 *   any failed or rejected -> the event is failed (it stops counting) and what the completed legs did give back is written as its
 *   own confirmed card refund (parent_event_id = the event, key square:refund-part:<event id>), so the ledger counts exactly the money
 *   that went back and the alert asks staff only for the rest.
 * A leg that fails while another is still on its way leaves the event waiting (the alert already shows the failed part).
 */
export async function settleRefundEvent(
  tx: Tx,
  d: { locationId: string; clock: Clock; newId: NewId },
  eventId: string,
): Promise<'confirmed' | 'failed' | 'waiting'> {
  const ev = await tx.selectFrom('ledger_events').selectAll().where('id', '=', eventId).executeTakeFirst()
  if (!ev) return 'waiting'
  await lockInvoice(tx, d.locationId, ev.invoice_id)
  const legs = await tx.selectFrom('square_refund_legs').selectAll().where('ledger_event_id', '=', eventId).orderBy('created_at').execute()
  if (ev.processor_state !== 'awaiting_processor' || legs.length === 0) return 'waiting'
  if (legs.some((l) => l.state === 'to_submit' || l.state === 'pending')) return 'waiting'
  const failed = legs.some((l) => l.state === 'failed' || l.state === 'rejected')
  const completed = legs.filter((l) => l.state === 'completed')
  const before = await invoiceSnapshot(tx, ev.invoice_id)
  const now = d.clock.now()
  await tx
    .updateTable('ledger_events')
    .set(
      failed
        ? { processor_state: 'failed', processor: 'square' }
        : {
            processor_state: 'confirmed',
            processor: 'square',
            processor_ref: legs.find((l) => l.square_refund_id)?.square_refund_id ?? null,
            processor_confirmed_at: now,
            processor_confirmed_by: 'Square',
          },
    )
    .where('id', '=', eventId)
    .execute()
  const doneCents = completed.reduce((s, l) => s + l.amount_cents, 0)
  const part =
    failed && doneCents > 0
      ? await insertEvent(tx, {
          id: d.newId(),
          location_id: ev.location_id,
          invoice_id: ev.invoice_id,
          customer_id: ev.customer_id,
          type: 'refund',
          amount_cents: doneCents,
          status: 'done',
          dest: 'card',
          method: ev.method,
          method_kind: ev.method_kind,
          brand: ev.brand,
          last4: ev.last4,
          deposit: ev.deposit,
          reason: ev.reason,
          note: 'The part of the card refund Square gave back (the rest failed)',
          // the items stay claimed (refundedItemIds): refunding them again by item would give their whole price back a second time,
          // so the uncovered rest the alert names goes back as an amount refund (finding E2)
          item_ids: ev.item_ids,
          parent_event_id: ev.id,
          actor_user_id: ev.actor_user_id,
          actor_employee_id: ev.actor_employee_id,
          actor_name: ev.actor_name,
          actor_roles: ev.actor_roles,
          approved_by_user_id: ev.approved_by_user_id,
          approved_by_employee_id: ev.approved_by_employee_id,
          approved_by_name: ev.approved_by_name,
          approved_by_roles: ev.approved_by_roles,
          approved_at: ev.approved_at,
          occurred_at: ev.occurred_at,
          resolved_at: ev.resolved_at ?? now,
          source: 'square',
          processor: 'square',
          processor_state: 'confirmed',
          processor_ref: completed.find((l) => l.square_refund_id)?.square_refund_id ?? null,
          processor_confirmed_at: now,
          processor_confirmed_by: 'Square',
          idempotency_key: `square:refund-part:${ev.id}`,
        })
      : null
  await announceInvoiceChange(tx, {
    locationId: d.locationId,
    invoiceId: ev.invoice_id,
    now,
    action: failed ? 'square.refund_failed' : 'square.refund_completed',
    ctx: { actor: { name: 'Square' } },
    before,
    after: {
      eventId,
      ...(failed ? { refundedCents: doneCents, partEventId: part?.id ?? null } : {}),
      legs: legs.map((l) => ({ id: l.id, paymentId: l.square_payment_id, amountCents: l.amount_cents, state: l.state, error: l.error })),
    },
    events: part ? [{ id: eventId, type: 'refund' }, { id: part.id, type: 'refund' }] : [{ id: eventId, type: 'refund' }],
  })
  return failed ? 'failed' : 'confirmed'
}

/** Step 1: legs for the Square card refunds that have none (each in its own transaction, under the invoice lock). */
export async function planSquareRefundLegs(d: RefundJobDeps, r: RefundRunReport): Promise<void> {
  const waiting = await d.db
    .selectFrom('ledger_events as e')
    .select(['e.id', 'e.invoice_id'])
    .where('e.location_id', '=', d.locationId)
    .where('e.type', '=', 'refund')
    .where('e.dest', '=', 'card')
    .where('e.status', '=', 'done')
    .where('e.processor', '=', 'square')
    .where('e.processor_state', '=', 'awaiting_processor')
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('square_refund_legs as l').select('l.id').whereRef('l.ledger_event_id', '=', 'e.id'))))
    .orderBy('e.seq')
    .limit(50)
    .execute()
  for (const w of waiting) {
    await transaction(d.db, async (tx) => {
      await lockInvoice(tx, d.locationId, w.invoice_id)
      const ev = await tx.selectFrom('ledger_events').selectAll().where('id', '=', w.id).executeTakeFirstOrThrow()
      const has = await tx.selectFrom('square_refund_legs').select('id').where('ledger_event_id', '=', ev.id).executeTakeFirst()
      if (has || ev.processor_state !== 'awaiting_processor' || ev.status !== 'done') return
      const legs = planRefundLegs(await squarePaysOf(tx, ev.invoice_id), ev.amount_cents)
      if (!legs) {
        // the Square money on the invoice cannot cover it: nothing is sent, the refund stops counting, staff give it back another way
        const before = await invoiceSnapshot(tx, ev.invoice_id)
        await tx.updateTable('ledger_events').set({ processor_state: 'failed' }).where('id', '=', ev.id).execute()
        await announceInvoiceChange(tx, {
          locationId: d.locationId,
          invoiceId: ev.invoice_id,
          now: d.clock.now(),
          action: 'square.refund_failed',
          ctx: { actor: { name: 'Square' } },
          before,
          after: { eventId: ev.id, reason: 'not enough Square card money on the invoice to refund through Square' },
          events: [{ id: ev.id, type: 'refund' }],
        })
        r.uncovered++
        return
      }
      for (const l of legs) {
        const id = d.newId()
        await tx
          .insertInto('square_refund_legs')
          .values({
            id,
            location_id: d.locationId,
            ledger_event_id: ev.id,
            square_payment_id: l.paymentId,
            amount_cents: l.amountCents,
            origin: 'api',
            idempotency_key: sqKey('rf', id),
            state: 'to_submit',
            created_at: d.clock.now(),
            updated_at: d.clock.now(),
          })
          .execute()
        r.planned++
      }
    })
  }
}

const SQUARE_STATE: Record<string, SquareRefundLegState> = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
  REJECTED: 'rejected',
}

/** Step 2: RefundPayment for every leg still to submit (outside any transaction), then the answer recorded under the lock. */
export async function submitSquareRefundLegs(d: RefundJobDeps, r: RefundRunReport): Promise<void> {
  const legs = await d.db
    .selectFrom('square_refund_legs as l')
    .innerJoin('ledger_events as e', 'e.id', 'l.ledger_event_id')
    .select(['l.id', 'l.ledger_event_id', 'l.square_payment_id', 'l.amount_cents', 'l.idempotency_key', 'e.reason', 'e.invoice_id'])
    .where('l.location_id', '=', d.locationId)
    .where('l.state', '=', 'to_submit')
    .where('l.origin', '=', 'api')
    .orderBy('l.created_at')
    .limit(50)
    .execute()
  for (const l of legs) {
    let state: SquareRefundLegState | null = null
    let refundId: string | null = null
    let error: string | null = null
    try {
      const out = await d.api.refunds.refund(sqKey('rf', l.id), {
        payment_id: l.square_payment_id,
        amount_money: usd(l.amount_cents),
        reason: (l.reason ?? 'Refund').slice(0, 192),
      })
      refundId = out.id
      state = SQUARE_STATE[out.status] ?? 'pending'
      r.submitted++
    } catch (e) {
      // a timeout or a 5xx is tried again next minute with the same key (Square answers the same refund); a refusal is final
      const final = e instanceof SquareApiError && !e.retryable
      if (!final && (e instanceof SquareNetworkError || e instanceof SquareError)) {
        r.retry++
        await d.db
          .updateTable('square_refund_legs')
          .set((eb) => ({ attempts: eb('attempts', '+', 1), error: maskText(String(e)).slice(0, 300), updated_at: d.clock.now() }))
          .where('id', '=', l.id)
          .execute()
        d.logger.warn({ square: { leg: l.id }, err: maskText(String(e)).slice(0, 200) }, 'square refund not sent yet (next run tries again)')
        continue
      }
      if (!(e instanceof SquareError)) throw e
      state = 'failed'
      error = maskText(e.message).slice(0, 300)
      r.failed++
    }
    await transaction(d.db, async (tx) => {
      await lockInvoice(tx, d.locationId, l.invoice_id)
      const cur = await tx.selectFrom('square_refund_legs').selectAll().where('id', '=', l.id).forUpdate().executeTakeFirstOrThrow()
      // a webhook may have recorded the refund first: keep the furthest state
      if (cur.state === 'to_submit' || cur.state === 'pending')
        await tx
          .updateTable('square_refund_legs')
          .set((eb) => ({
            state: cur.state === 'pending' && state === 'pending' ? 'pending' : state!,
            square_refund_id: cur.square_refund_id ?? refundId,
            error,
            attempts: eb('attempts', '+', 1),
            submitted_at: d.clock.now(),
            ...(state === 'completed' ? { completed_at: d.clock.now() } : {}),
            updated_at: d.clock.now(),
          }))
          .where('id', '=', l.id)
          .execute()
      await settleRefundEvent(tx, d, l.ledger_event_id)
    })
  }
}

/** square.refunds.submit: plan and send. Runs only with PAYMENT_PROCESSOR=square and Square writes on (observe-only sends nothing). */
export async function runSquareRefunds(d: RefundJobDeps): Promise<RefundRunReport> {
  const r: RefundRunReport = { status: 'ok', planned: 0, uncovered: 0, submitted: 0, failed: 0, retry: 0 }
  if (!squareProcessor(d.env)) return { ...r, status: 'skipped', reason: 'PAYMENT_PROCESSOR is not square' }
  if (!squareWritesOn(d.env)) return { ...r, status: 'skipped', reason: 'SQUARE_WRITES_ENABLED=false (observe-only)' }
  await planSquareRefundLegs(d, r)
  await submitSquareRefundLegs(d, r)
  return r
}

// ---- refund.* events --------------------------------------------------------------------------------------------------------------

export type RefundIngestOutcome = { status: 'processed' | 'ignored'; note: string }

/**
 * A Square refund as Square answers it now (the event processor holds the advisory lock square:refund:<id>): a leg of ours moves; a
 * refund of ours whose answer has not been recorded yet (the webhook won the race with the job) takes its leg; a refund made in the
 * Square POS app is attached to the staff's awaiting card refund of that amount or recorded as an external refund needing review.
 */
export async function ingestSquareRefund(
  tx: Tx,
  d: { locationId: string; clock: Clock; newId: NewId },
  rf: SquareRefundFacts,
): Promise<RefundIngestOutcome> {
  const state = SQUARE_STATE[rf.status] ?? 'pending'
  let found = await tx.selectFrom('square_refund_legs').select(['id', 'ledger_event_id']).where('square_refund_id', '=', rf.refundId).executeTakeFirst()
  if (!found && rf.paymentId)
    found = await tx
      .selectFrom('square_refund_legs')
      .select(['id', 'ledger_event_id'])
      .where('location_id', '=', d.locationId)
      .where('square_payment_id', '=', rf.paymentId)
      .where('amount_cents', '=', rf.amountCents)
      .where('origin', '=', 'api')
      .where('square_refund_id', 'is', null)
      .where('state', 'in', ['to_submit', 'pending'])
      .orderBy('created_at')
      .executeTakeFirst()
  // the invoice first, then the leg (the order the submit job takes them in: no deadlock)
  const leg = found
    ? await (async () => {
        const ev = await tx.selectFrom('ledger_events').select('invoice_id').where('id', '=', found!.ledger_event_id).executeTakeFirstOrThrow()
        await lockInvoice(tx, d.locationId, ev.invoice_id)
        return tx.selectFrom('square_refund_legs').selectAll().where('id', '=', found!.id).forUpdate().executeTakeFirstOrThrow()
      })()
    : undefined
  if (leg) {
    if (leg.state === 'completed' || leg.state === 'failed' || leg.state === 'rejected')
      return { status: 'processed', note: `refund leg already ${leg.state}` }
    await tx
      .updateTable('square_refund_legs')
      .set({
        square_refund_id: rf.refundId,
        state,
        ...(state === 'completed' ? { completed_at: d.clock.now() } : {}),
        ...(state === 'failed' || state === 'rejected' ? { error: `Square reported the refund ${rf.status}` } : {}),
        updated_at: d.clock.now(),
      })
      .where('id', '=', leg.id)
      .execute()
    const settled = await settleRefundEvent(tx, d, leg.ledger_event_id)
    return { status: 'processed', note: `refund leg ${state}; refund ${settled}` }
  }
  // not ours: a refund made in the Square app. Only a completed one moves money in the ledger.
  if (rf.status !== 'COMPLETED') return { status: 'processed', note: `refund made at Square, ${rf.status.toLowerCase()}: waiting for it to complete` }
  if (!rf.paymentId) return { status: 'ignored', note: 'refund without a payment' }
  const mirror = await tx.selectFrom('square_payments').selectAll().where('square_payment_id', '=', rf.paymentId).executeTakeFirst()
  if (!mirror?.invoice_id) {
    // its payment is not on an invoice yet (the counter delay, the queue): kept until it is, then recorded there (review Q4 SQ-SEM-1)
    await tx
      .insertInto('square_refunds_waiting')
      .values({ square_refund_id: rf.refundId, location_id: d.locationId, square_payment_id: rf.paymentId, facts: JSON.stringify({ ...rf, createdAt: rf.createdAt.toISOString() }) })
      .onConflict((oc) => oc.column('square_refund_id').doNothing())
      .execute()
    return { status: 'processed', note: 'refund of a Square payment that is not on an invoice yet: kept until the payment is matched' }
  }
  const ops = new SquareLedgerOps(d)
  const awaiting = await tx
    .selectFrom('ledger_events as e')
    .select('e.id')
    .where('e.invoice_id', '=', mirror.invoice_id)
    .where('e.type', '=', 'refund')
    .where('e.dest', '=', 'card')
    .where('e.status', '=', 'done')
    .where('e.processor_state', '=', 'awaiting_processor')
    .where('e.amount_cents', '=', rf.amountCents)
    .where((eb) => eb.or([eb('e.processor', 'is', null), eb('e.processor', '=', 'square')]))
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('square_refund_legs as l').select('l.id').whereRef('l.ledger_event_id', '=', 'e.id'))))
    .orderBy('e.seq')
    .executeTakeFirst()
  if (awaiting) {
    try {
      await ops.attachPosRefund(tx, { refund: rf, eventId: awaiting.id })
      return { status: 'processed', note: 'refund made in the Square app: attached to the staff refund' }
    } catch (e) {
      if (!(e instanceof SquareStaleDecision)) throw e
    }
  }
  // the staff confirmed their card refund by hand (today's step before the cutover) before Square's refund event arrived: that refund
  // is this one, so it takes the Square ids instead of the money counting twice. Not one finished in Squarespace (its order id), and
  // only on an invoice whose card money is all Square's: with Squarespace (or unknown) card money there too, the hand-confirmed refund
  // may be that money's, so Square's refund is recorded on its own for review (a possible double count shown to staff, never a refund
  // silently hidden).
  const byHand = await tx
    .selectFrom('ledger_events as e')
    .select('e.id')
    .where('e.invoice_id', '=', mirror.invoice_id)
    .where('e.type', '=', 'refund')
    .where('e.dest', '=', 'card')
    .where('e.status', '=', 'done')
    .where('e.processor_state', '=', 'confirmed')
    .where('e.amount_cents', '=', rf.amountCents)
    .where('e.processor_ref', 'is', null)
    .where('e.sqsp_order_id', 'is', null)
    .where((eb) => eb.or([eb('e.processor', 'is', null), eb('e.processor', '=', 'square')]))
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('square_refund_legs as l').select('l.id').whereRef('l.ledger_event_id', '=', 'e.id'))))
    .where(
      ({ not, exists }) =>
        not(
          exists(sql`(select 1 from ledger_events p where p.invoice_id = e.invoice_id and p.type = 'pay' and p.method_kind in ('card', 'apple_pay')
            and p.processor is distinct from 'square' and not exists (select 1 from ledger_events v where v.voids_event_id = p.id))`),
        ),
    )
    .orderBy('e.seq')
    .executeTakeFirst()
  if (byHand) {
    try {
      await ops.attachConfirmedRefund(tx, { refund: rf, eventId: byHand.id })
      return { status: 'processed', note: 'refund made in the Square app, confirmed by hand: attached to the staff refund' }
    } catch (e) {
      if (!(e instanceof SquareStaleDecision)) throw e
    }
  }
  const r = await ops.recordExternalRefund(tx, { refund: rf, invoiceId: mirror.invoice_id, payment: factsOfRow(mirror) })
  return { status: 'processed', note: r.created ? 'refund made in the Square app: recorded, needs review' : 'refund already recorded' }
}

/**
 * The refunds made in the Square app while the payment was not on an invoice (review Q4 SQ-SEM-1), recorded now that it is: in the
 * caller's transaction, right after the payment was recorded (the matcher, the queue's apply, a link or a charge). Each is recorded
 * once (its ledger key) and its waiting row deleted.
 */
export async function drainWaitingRefunds(tx: Tx, d: { locationId: string; clock: Clock; newId: NewId }, paymentId: string): Promise<number> {
  const rows = await tx.selectFrom('square_refunds_waiting').selectAll().where('square_payment_id', '=', paymentId).orderBy('received_at').forUpdate().execute()
  let n = 0
  for (const row of rows) {
    const f = (typeof row.facts === 'string' ? JSON.parse(row.facts) : row.facts) as Omit<SquareRefundFacts, 'createdAt'> & { createdAt: string }
    await tx.deleteFrom('square_refunds_waiting').where('square_refund_id', '=', row.square_refund_id).execute()
    const out = await ingestSquareRefund(tx, d, { ...f, createdAt: new Date(f.createdAt) })
    if (out.status === 'processed') n++
  }
  return n
}
