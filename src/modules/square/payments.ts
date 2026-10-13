// Square payments into Oasis (ADR 0171, design 2.1 to 2.4): the mirror row, the classification and the counter matching, for every
// path a payment can arrive by (the webhook's square.event.process, the Events API catch-up, the nightly reconcile, the delayed
// matching job square.payments.match, a POS callback, and the people working the "Square payments to match" queue).
//
// One payment is decided by one transaction at a time: every path takes the advisory lock square:payment:<id> (the event processor
// already holds it) and then the mirror row; a decided row (matched or ignored) is never decided again. The ledger ops re-check the
// decision under the invoice lock and refuse to write a payment that is already live in the ledger, so a webhook, the catch-up and
// the reconcile racing on one payment record it exactly once.
import { sql } from 'kysely'
import type { Env } from '../../config/env.js'
import { squareLocationId } from '../../integrations/square/config.js'
import type { Clock } from '../../platform/clock.js'
import { advisoryXactLock, type Tx } from '../../platform/db.js'
import type { NewId } from '../../platform/ids.js'
import { addDays, toBizDate } from '../../platform/time.js'
import { calcOf, lockInvoice } from '../payments/repository.js'
import { classifySquarePayment, invoiceNoIn, posCodeIn, type ClassifyContext, type LinkRef, type PosIntentRef } from './classify.js'
import type { SquareCandidate, SquarePaymentsTable } from './db/schema.js'
import type { SquarePaymentFacts } from './facts.js'
import { SquareLedgerOps, SquareStaleDecision, payKey, type SquareActor } from './ledger.js'
import { planSquarePayment, rankCandidates, type Identity, type MatchContext, type MatchEntry, type MatchInvoice } from './matcher.js'
import { AppError } from '../../platform/errors.js'
import type { Selectable } from 'kysely'
import { chargeOfPayment, recordChargePayment } from './charges.js'
import { drainWaitingRefunds } from './refunds.js'
import { squareQueue } from './runtime.js'

export type MirrorRow = Selectable<SquarePaymentsTable>

export interface SquarePaymentDeps {
  locationId: string
  clock: Clock
  newId: NewId
  env: Pick<Env, 'SQUARE_LOCATION_ID' | 'SQUARE_PROVIDER' | 'SQUARE_MATCH_DELAY_SECONDS' | 'SQUARE_POS_AUTOMATCH'> & Partial<Env>
}

export type DecideOutcome = 'matched' | 'unmatched' | 'pending' | 'waiting' | 'ignored' | 'done'

const MIN = 60_000
const HOUR = 60 * MIN
/** Staff entries this far before the payment (or 30 minutes after it) may be the one it pays. */
export const ENTRY_WINDOW_BEFORE_MS = 12 * HOUR
export const ENTRY_WINDOW_AFTER_MS = 30 * MIN

export const lockPayment = (tx: Tx, paymentId: string): Promise<void> => advisoryXactLock(tx, `square:payment:${paymentId}`)

/** Inserts or refreshes the mirror row from the payment as Square answers it now (the decision columns are left alone); locked. */
export async function upsertMirror(tx: Tx, d: SquarePaymentDeps, f: SquarePaymentFacts): Promise<MirrorRow> {
  const now = d.clock.now()
  const values = {
    square_location_id: f.squareLocationId,
    status: f.status,
    source_type: f.sourceType,
    square_product: f.product,
    application_id: f.applicationId,
    square_order_id: f.orderId,
    reference_id: f.referenceId,
    note: f.note,
    receipt_number: f.receiptNumber,
    receipt_url: f.receiptUrl,
    amount_cents: f.amountCents,
    tip_cents: f.tipCents,
    total_cents: f.totalCents,
    refunded_cents: f.refundedCents,
    card_brand: f.brand,
    last4: f.last4,
    entry_method: f.entryMethod,
    square_customer_id: f.customerId,
    buyer_email: f.buyerEmail,
    square_created_at: f.createdAt,
    square_updated_at: f.updatedAt,
    updated_at: now,
  }
  await tx
    .insertInto('square_payments')
    .values({ id: d.newId(), location_id: d.locationId, square_payment_id: f.paymentId, first_seen_at: now, ...values })
    .onConflict((oc) => oc.column('square_payment_id').doUpdateSet(values))
    .execute()
  return tx
    .selectFrom('square_payments')
    .selectAll()
    .where('square_payment_id', '=', f.paymentId)
    .forUpdate()
    .executeTakeFirstOrThrow()
}

async function linkOf(tx: Tx, d: SquarePaymentDeps, orderId: string | null): Promise<LinkRef | null> {
  if (!orderId) return null
  const l = await tx
    .selectFrom('payment_links')
    .select(['id', 'invoice_id', 'purpose', 'expected_cents', 'state'])
    .where('location_id', '=', d.locationId)
    .where('square_order_id', '=', orderId)
    .executeTakeFirst()
  return l ? { id: l.id, invoiceId: l.invoice_id, purpose: l.purpose, expectedCents: l.expected_cents, state: l.state } : null
}

async function intentOf(tx: Tx, d: SquarePaymentDeps, f: SquarePaymentFacts): Promise<PosIntentRef | null> {
  const code = posCodeIn(f.note)
  if (!code && !f.orderId) return null
  const i = await tx
    .selectFrom('square_pos_intents')
    .select(['id', 'invoice_id', 'ledger_event_id', 'amount_cents'])
    .where('location_id', '=', d.locationId)
    .where((eb) =>
      eb.or([
        ...(code ? [eb('code', '=', code)] : []),
        ...(f.orderId ? [eb('transaction_id', '=', f.orderId), eb('square_payment_id', '=', f.paymentId)] : []),
      ]),
    )
    .orderBy('created_at', 'desc')
    .executeTakeFirst()
  return i ? { id: i.id, invoiceId: i.invoice_id, ledgerEventId: i.ledger_event_id, amountCents: i.amount_cents } : null
}

/** A card-on-file payment by the Square customer of a membership Square bills (wave Q3b): possibly a subscription invoice's. */
async function maybeMembershipPayment(tx: Tx, d: SquarePaymentDeps, f: SquarePaymentFacts): Promise<boolean> {
  if (f.entryMethod !== 'ON_FILE' || !f.customerId) return false
  const m = await tx
    .selectFrom('memberships')
    .select('id')
    .where('location_id', '=', d.locationId)
    .where('source', '=', 'square')
    .where('square_customer_id', '=', f.customerId)
    .limit(1)
    .executeTakeFirst()
  return !!m
}

export async function classifyContextFor(tx: Tx, d: SquarePaymentDeps, f: SquarePaymentFacts, ops: SquareLedgerOps): Promise<ClassifyContext> {
  const keyed = await tx.selectFrom('ledger_events').select('id').where('idempotency_key', '=', payKey(f.paymentId)).executeTakeFirst()
  const live = keyed ? true : !!(await ops.livePayOf(tx, f.paymentId))
  const chargeId = await chargeOfPayment(tx, d.locationId, f)
  return {
    squareLocationId: squareLocationId(d.env as Env),
    inLedger: live,
    link: await linkOf(tx, d, f.orderId),
    // a card-on-file charge (wave Q3a)
    charge: chargeId !== null,
    chargeId,
    // the payment of a membership's subscription invoice (wave Q3b): its order is the invoice's (never an Oasis invoice's money)
    membership: f.orderId
      ? !!(await tx.selectFrom('square_subscription_invoices').select('id').where('square_order_id', '=', f.orderId).executeTakeFirst())
      : false,
    posIntent: await intentOf(tx, d, f),
  }
}

// ---- the match snapshot ---------------------------------------------------------------------------------------------------------

async function identities(tx: Tx, customerIds: string[]): Promise<Map<string, Identity>> {
  const out = new Map<string, Identity>()
  if (customerIds.length === 0) return out
  const rows = await tx.selectFrom('customers').select(['id', 'email', 'phone_e164']).where('id', 'in', [...new Set(customerIds)]).execute()
  for (const r of rows) out.set(r.id, { emails: r.email ? [String(r.email)] : [], phones: r.phone_e164 ? [r.phone_e164] : [] })
  return out
}

type EntryRow = { id: string; invoice_id: string; customer_id: string; amount_cents: number; occurred_at: Date }

async function entries(tx: Tx, d: SquarePaymentDeps, kind: 'card' | 'cash', at: Date, invoiceId?: string): Promise<MatchEntry[]> {
  const lo = new Date(at.getTime() - ENTRY_WINDOW_BEFORE_MS)
  const hi = new Date(at.getTime() + ENTRY_WINDOW_AFTER_MS)
  const r = await sql<EntryRow>`
    select e.id, e.invoice_id, e.customer_id, e.amount_cents, e.occurred_at
    from ledger_events e
    where e.location_id = ${d.locationId} and e.type = 'pay' and e.processor_ref is null
      and not exists (select 1 from ledger_events v where v.voids_event_id = e.id)
      and ${
        kind === 'card'
          ? sql`e.processor_state = 'awaiting_processor' and e.method_kind in ('card', 'apple_pay') and (e.processor is null or e.processor = 'square')`
          : sql`e.method_kind = 'cash' and e.source = 'oasis'`
      }
      and ${invoiceId ? sql`e.invoice_id = ${invoiceId}` : sql`e.occurred_at >= ${lo} and e.occurred_at <= ${hi}`}
    order by e.occurred_at, e.seq`.execute(tx)
  const ids = await identities(tx, r.rows.map((x) => x.customer_id))
  return r.rows.map((x) => ({
    eventId: x.id,
    invoiceId: x.invoice_id,
    amountCents: x.amount_cents,
    occurredAt: x.occurred_at,
    identity: ids.get(x.customer_id) ?? { emails: [], phones: [] },
  }))
}

async function invoiceRows(tx: Tx, where: ReturnType<typeof sql>): Promise<MatchInvoice[]> {
  const r = await sql<{ id: string; invoice_no: number; customer_id: string; client_name: string; balance: string | number; canceled: boolean }>`
    select i.id, i.invoice_no, i.customer_id, i.client_name, c.balance, i.canceled_at is not null as canceled
    from invoices i cross join lateral invoice_calc_of(i.id) c
    where ${where}
    order by i.biz_date desc, i.invoice_no desc
    limit 200`.execute(tx)
  const ids = await identities(tx, r.rows.map((x) => x.customer_id))
  return r.rows.map((x) => ({
    id: x.id,
    no: x.invoice_no,
    customerId: x.customer_id,
    client: x.client_name,
    balanceCents: Number(x.balance),
    canceled: x.canceled,
    identity: ids.get(x.customer_id) ?? { emails: [], phones: [] },
  }))
}

/** The snapshot planSquarePayment decides on (read inside the deciding transaction). */
export async function loadMatchContext(
  tx: Tx,
  d: SquarePaymentDeps,
  f: SquarePaymentFacts,
  intent: PosIntentRef | null,
  payer: Identity,
): Promise<MatchContext> {
  const loc = await tx.selectFrom('locations').select('timezone').where('id', '=', d.locationId).executeTakeFirst()
  const tz = loc?.timezone ?? 'America/New_York'
  const day = toBizDate(f.createdAt, tz)
  const no = invoiceNoIn(f.note, f.referenceId)
  let named: MatchContext['named'] = null
  if (no !== null) {
    const [inv] = await invoiceRows(tx, sql`i.location_id = ${d.locationId} and i.invoice_no = ${no}`)
    if (inv) named = { ...inv, entries: await entries(tx, d, 'card', f.createdAt, inv.id), cashEntries: await entries(tx, d, 'cash', f.createdAt, inv.id) }
  }
  let intentCtx: MatchContext['intent'] = null
  if (intent) {
    const [inv] = await invoiceRows(tx, sql`i.id = ${intent.invoiceId}`)
    if (inv) intentCtx = { ...inv, entryId: intent.ledgerEventId, entries: await entries(tx, d, 'card', f.createdAt, inv.id) }
  }
  const open = await invoiceRows(
    tx,
    sql`i.location_id = ${d.locationId} and i.canceled_at is null and c.balance > 0
      and i.biz_date between ${addDays(day, -1)}::date and ${addDays(day, 1)}::date
      and (exists (select 1 from appointments a where a.id = i.appointment_id
                   and a.status in ('booked', 'confirmed', 'arrived', 'cleaning', 'completed'))
        or exists (select 1 from ledger_events e where e.invoice_id = i.id and e.processor_state = 'awaiting_processor'))`,
  )
  return {
    named,
    intent: intentCtx,
    awaitingCards: await entries(tx, d, 'card', f.createdAt),
    cashEntries: await entries(tx, d, 'cash', f.createdAt),
    openInvoices: open,
    payer,
  }
}

// ---- deciding -----------------------------------------------------------------------------------------------------------------

export interface DecideOptions {
  /** Match now even if the counter delay has not passed (the matching job, a POS callback, the reconcile of an old payment). */
  force?: boolean
  /** What else is known about the payer (the Square customer's email and phone, fetched before the transaction). */
  payer?: Identity
}

async function markUnmatched(tx: Tx, d: SquarePaymentDeps, row: MirrorRow, candidates: SquareCandidate[], reason: string): Promise<void> {
  await tx
    .updateTable('square_payments')
    .set({
      match_state: 'unmatched',
      candidates: JSON.stringify(candidates),
      variance: JSON.stringify({ reason }),
      updated_at: d.clock.now(),
    })
    .where('id', '=', row.id)
    .execute()
}

/**
 * Decides one payment (the caller holds lockPayment). Returns what happened; a decided row is left alone ('done'). A link payment is
 * recorded at once; a counter payment waits SQUARE_MATCH_DELAY_SECONDS (unless forced), then goes through the matcher.
 */
export async function decideSquarePayment(tx: Tx, d: SquarePaymentDeps, f: SquarePaymentFacts, o: DecideOptions = {}): Promise<DecideOutcome> {
  const out = await decide(tx, d, f, o)
  // a refund made in the Square app while the payment waited is recorded on its invoice now (review Q4 SQ-SEM-1)
  if (out === 'matched' || out === 'done') await drainWaitingRefunds(tx, d, f.paymentId)
  return out
}

async function decide(tx: Tx, d: SquarePaymentDeps, f: SquarePaymentFacts, o: DecideOptions): Promise<DecideOutcome> {
  const ops = new SquareLedgerOps(d)
  const row = await upsertMirror(tx, d, f)
  if (row.match_state === 'matched' || row.match_state === 'ignored') return 'done'
  const ctx = await classifyContextFor(tx, d, f, ops)
  const c = classifySquarePayment(f, ctx)
  const now = d.clock.now()
  const setClass = async (classification: MirrorRow['classification'], extra: Partial<MirrorRow> = {}): Promise<void> => {
    await tx
      .updateTable('square_payments')
      .set({ classification, updated_at: now, ...(extra as object) })
      .where('id', '=', row.id)
      .execute()
  }
  switch (c.kind) {
    case 'waiting':
      return 'waiting'
    case 'ignored':
      await setClass('ignored', { match_state: 'ignored', ignore_reason: 'other', ignore_note: c.reason, decided_by: 'Square', decided_at: now })
      return 'ignored'
    case 'done': {
      // already in the ledger (a staff confirmation with the Square reference, an earlier run): the mirror catches up
      const live = (await tx.selectFrom('ledger_events').selectAll().where('idempotency_key', '=', payKey(f.paymentId)).executeTakeFirst()) ??
        (await ops.livePayOf(tx, f.paymentId))
      if (live) await ops.setDecision(tx, f.paymentId, { invoiceId: live.invoice_id, eventId: live.id, rule: row.rule ?? 'manual', confidence: null, actor: { name: 'Square' } })
      return 'done'
    }
    case 'link': {
      await setClass('link')
      // paid by its link after the visit was canceled (a link still payable at Square, a webhook late behind the cancel): never kept
      // silently as money of the canceled invoice, which no cancel rule settles; a person refunds it or applies it from the queue
      // (review Q4 money:M2)
      const target = await tx
        .selectFrom('invoices')
        .select(['id', 'invoice_no', 'client_name', 'canceled_at'])
        .where('id', '=', c.link.invoiceId)
        .executeTakeFirst()
      if (target?.canceled_at) {
        const candidate: SquareCandidate = {
          invoiceId: target.id,
          invoiceNo: target.invoice_no,
          client: target.client_name,
          balanceCents: 0,
          awaitingEventId: null,
          score: 5,
          why: ['paid by its payment link after the visit was canceled'],
        }
        await markUnmatched(tx, d, row, [candidate], 'paid by a payment link after the visit was canceled: refund it in Square, or apply it')
        return 'unmatched'
      }
      const variance = f.amountCents !== c.link.expectedCents ? { expectedCents: c.link.expectedCents, paidCents: f.amountCents } : null
      await ops.recordPayment(tx, {
        facts: f,
        invoiceId: c.link.invoiceId,
        rule: 'link',
        confidence: 1,
        deposit: c.link.purpose === 'deposit',
        paymentLinkId: c.link.id,
        variance,
      })
      return 'matched'
    }
    case 'charge': {
      // a saved-card charge (wave Q3a): recorded on the charge's invoice in the name of the staff member who confirmed it
      await setClass('charge')
      if (!ctx.chargeId) return 'pending'
      await recordChargePayment(tx, { ...d, queue: squareQueue() }, ctx.chargeId, f)
      return 'matched'
    }
    case 'membership':
      // a membership's monthly payment (wave Q3b): Square bills it and the invoice events apply it; never matched to an invoice
      await setClass('membership', {
        match_state: 'ignored',
        ignore_reason: 'other',
        ignore_note: 'membership payment (Square subscription)',
        decided_by: 'Square',
        decided_at: now,
      })
      return 'ignored'
    case 'pos_intent':
    case 'counter': {
      const classification = c.kind
      const after = row.match_after ?? new Date(f.createdAt.getTime() + d.env.SQUARE_MATCH_DELAY_SECONDS * 1000)
      if (!o.force && now.getTime() < after.getTime()) {
        await setClass(classification, { match_after: after })
        return 'pending'
      }
      await setClass(classification, { match_after: after })
      // a card-on-file payment of a client whose membership Square bills may be that membership's (its invoice event not in yet):
      // never recorded on a visit's invoice by itself; staff see it, and the invoice event takes it out as a membership payment
      if (c.kind === 'counter' && (await maybeMembershipPayment(tx, d, f))) {
        await markUnmatched(tx, d, row, [], 'a card-on-file payment of a client billed by a Square membership: it may be a membership payment')
        return 'unmatched'
      }
      return runMatcher(tx, d, ops, f, row, c.kind === 'pos_intent' ? c.intent : null, o.payer)
    }
  }
}

async function runMatcher(
  tx: Tx,
  d: SquarePaymentDeps,
  ops: SquareLedgerOps,
  f: SquarePaymentFacts,
  row: MirrorRow,
  intent: PosIntentRef | null,
  extra?: Identity,
): Promise<DecideOutcome> {
  const payer: Identity = {
    emails: [...(f.buyerEmail ? [f.buyerEmail] : []), ...(extra?.emails ?? [])],
    phones: [...(extra?.phones ?? [])],
  }
  // a decision can go stale between the snapshot and the invoice lock (a staff member collected meanwhile): plan again, at most 3 times
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctx = await loadMatchContext(tx, d, f, intent, payer)
    const plan = planSquarePayment(f, ctx, { automatch: d.env.SQUARE_POS_AUTOMATCH })
    try {
      switch (plan.action) {
        case 'unmatched':
          await markUnmatched(tx, d, row, plan.candidates, plan.reason)
          return 'unmatched'
        case 'confirm':
          await ops.confirmAwaiting(tx, { facts: f, eventId: plan.eventId, rule: plan.rule, confidence: plan.confidence })
          break
        case 'attach_cash':
          await ops.attachCash(tx, { facts: f, eventId: plan.eventId })
          break
        case 'record': {
          if (plan.rule === 'R4' || plan.rule === 'R4a') {
            // under the lock: still exactly that balance, and no staff entry that this payment should confirm instead
            await lockInvoice(tx, d.locationId, plan.invoiceId)
            const calc = await calcOf(tx, plan.invoiceId)
            const waiting = await tx
              .selectFrom('ledger_events')
              .select('id')
              .where('invoice_id', '=', plan.invoiceId)
              .where('processor_state', '=', 'awaiting_processor')
              .where('type', '=', 'pay')
              .executeTakeFirst()
            if (calc.balance !== f.amountCents || waiting) throw new SquareStaleDecision('the invoice changed')
          }
          await ops.recordPayment(tx, { facts: f, invoiceId: plan.invoiceId, rule: plan.rule, confidence: plan.confidence })
          break
        }
      }
      if (intent)
        await tx
          .updateTable('square_pos_intents')
          .set({ status: 'matched', square_payment_id: f.paymentId })
          .where('id', '=', intent.id)
          .execute()
      return 'matched'
    } catch (e) {
      if (!(e instanceof SquareStaleDecision)) throw e
    }
  }
  const ctx = await loadMatchContext(tx, d, f, intent, payer)
  await markUnmatched(tx, d, row, rankCandidates(f, ctx), 'the invoices kept changing while matching')
  return 'unmatched'
}

/** A person applies a payment from the queue: to an invoice, confirming one of its awaiting card entries when named. */
export async function applySquarePayment(
  tx: Tx,
  d: SquarePaymentDeps,
  f: SquarePaymentFacts,
  i: { invoiceId: string; confirmEventId?: string | null; actor: SquareActor },
): Promise<{ eventId: string; invoiceId: string }> {
  const ops = new SquareLedgerOps(d)
  const row = await upsertMirror(tx, d, f)
  if (row.match_state === 'matched' || row.match_state === 'ignored') throw new AppError('SQUARE_PAYMENT_DECIDED')
  const actor = { ...i.actor, manual: true }
  if (i.confirmEventId) {
    const ev = await tx
      .selectFrom('ledger_events')
      .select(['invoice_id'])
      .where('id', '=', i.confirmEventId)
      .where('location_id', '=', d.locationId)
      .executeTakeFirst()
    if (!ev || ev.invoice_id !== i.invoiceId) throw new AppError('SQUARE_CONFIRM_MISMATCH')
    let confirmed
    try {
      confirmed = await ops.confirmAwaiting(tx, { facts: f, eventId: i.confirmEventId, rule: 'manual', confidence: 1, actor })
    } catch (e) {
      if (e instanceof SquareStaleDecision) throw new AppError('SQUARE_CONFIRM_MISMATCH')
      throw e
    }
    await drainWaitingRefunds(tx, d, f.paymentId)
    return confirmed
  }
  const r = await ops.recordPayment(tx, { facts: f, invoiceId: i.invoiceId, rule: 'manual', confidence: 1, actor })
  if (!r.created && r.invoiceId !== i.invoiceId) throw new AppError('SQUARE_PAYMENT_DECIDED')
  // a refund made in the Square app while the payment waited in the queue is recorded on the invoice too (review Q4 SQ-SEM-1)
  await drainWaitingRefunds(tx, d, f.paymentId)
  return r
}
