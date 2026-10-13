// Charges on a saved card (ADR 0171 D7, plan decision 6, wave Q3a; design q-design-square.md 4.2 and 4.3). A saved card is charged
// ONLY after a staff member confirms: a balance with the client's OK (POST /invoices/:id/card-charges), or a no-show / late-cancel
// fee that the cancel or no-show proposed (fees.ts) and staff charge or waive. Every charge is a square_charges row:
//
//   proposed  -> (staff confirm) charging -> charged    the payment is recorded through SquareLedgerOps (rule `charge`, key
//                                                       square:pay:<payment id>), the fee's client gets the card_fee_charged text
//                                       -> declined   Square refused the card: the plain reason is kept; a fee may be charged again
//                                                       (a new attempt, a new key) or waived
//                                       -> unknown    Square did not answer: the job square.charges.resolve first looks for the
//                                                       payment the request made (ListPayments, reference_id = the charge); only when
//                                                       Square has none and the invoice still owes it does it send the SAME request
//                                                       with the SAME key; otherwise the charge is closed `declined` (NOT_SENT).
//                                                       Meanwhile nothing else collects the invoice (charge-guard.ts, review Q4 H1).
//                                                       Watch-only Square or past the 23-hour re-send window: the job only looks
//                                                       (none 15 minutes after the last request: closed NOT_SENT), and staff may
//                                                       press "Not charged (checked Square)", the same look-up (review Q4 H1-R1)
//   proposed | declined -> waived (a fee only, audited)
//
// CreatePayment (`source_id` the card, `customer_id` its Square customer, `autocomplete`, `reference_id` the charge id, a note naming
// the invoice) is sent OUTSIDE any transaction and never while the invoice is locked: the first short transaction checks and claims
// the charge (the invoice lock is released when it commits), the Square call runs on the pool, a second transaction records what
// Square answered. The webhook of the same payment (classified `charge` by its reference_id) records it the same way, so whichever
// comes first records it and the other finds it recorded. Nothing is charged while PAYMENT_PROCESSOR is squarespace (409
// CARD_PAYMENTS_OFF) or Square is watch-only (409 SQUARE_WRITES_OFF).
import { sql, type Selectable } from 'kysely'
import type { Env } from '../../config/env.js'
import type { CreatePaymentInput, SquareApi } from '../../integrations/ports/square.js'
import { squareLocationId } from '../../integrations/square/config.js'
import {
  SquareApiError,
  SquareAuthError,
  SquareDeclined,
  SquareIdempotencyReused,
  SquarePermissionError,
  SquareWritesDisabled,
  declineText,
} from '../../integrations/square/errors.js'
import { sqKey } from '../../integrations/square/keys.js'
import { usd } from '../../integrations/square/money.js'
import type { WirePayment } from '../../integrations/square/wire.js'
import * as audit from '../../platform/audit.js'
import type { AuditContext } from '../../platform/audit.js'
import type { Clock } from '../../platform/clock.js'
import { transaction, type Db, type Executor, type Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import type { NewId } from '../../platform/ids.js'
import { formatUsd } from '../../platform/money.js'
import { invoiceLabel } from '../payments/format.js'
import { calcOf, cardLabel, lockInvoice } from '../payments/repository.js'
import { loadCustomerTarget } from '../messaging/db/recipients.js'
import { isCardPurpose, type CardPurpose } from './consents.js'
import type { SquareChargePurpose, SquareChargeState, SquareChargesTable, CustomerCardsTable } from './db/cards-schema.js'
import { paymentFacts, type SquarePaymentFacts } from './facts.js'
import type { SquareLogger } from './ingest.js'
import { SquareLedgerOps, type SquareActor } from './ledger.js'
import { squareProcessor, squareWritesOn } from './links.js'
import { lockPayment, upsertMirror, type SquarePaymentDeps } from './payments.js'
import type { SquareQueue } from './runtime.js'
import './db/cards-schema.js'
import './problems.js'

const MIN = 60_000
const HOUR = 60 * MIN

/** The job re-sends an unanswered attempt (same key) while it is younger than this; later it only waits for the webhook. */
export const RESEND_WINDOW_MS = 23 * HOUR
/** A `charging` row older than this lost its process between the call and the answer: the job treats it as unanswered. */
export const CHARGING_STALE_MS = 5 * MIN

export type ChargeRow = Selectable<SquareChargesTable>
export type CardRow = Selectable<CustomerCardsTable>

export interface CardChargeDeps {
  db: Db
  clock: Clock
  newId: NewId
  env: Env
  api: SquareApi
  locationId: string
  logger?: SquareLogger
  /** The messaging queue the fee's card_fee_charged text goes through (none: the text is skipped). */
  queue?: SquareQueue
}

/** Saved cards are on: Square takes the payments (the cutover). Before it the "Saved card" tender is hidden and nothing is charged. */
export const cardsOn = (env: Pick<Env, 'PAYMENT_PROCESSOR'>): boolean => squareProcessor(env)

export const REASONS: Record<SquareChargePurpose, string> = {
  no_show_fee: 'No-show fee',
  late_cancel_fee: 'Late-cancel fee',
  balance: 'Balance',
}

/** A card as a text says it ("Visa ending in 4242"): the dashboard's bullets become dashes in a GSM-7 text. */
export const cardWords = (label: string): string => label.replace(/ ••([0-9]{4})$/, ' ending in $1')

/** How the client's text names a fee. */
const FEE_WORDS: Record<SquareChargePurpose, string> = { no_show_fee: 'no-show fee', late_cancel_fee: 'late-cancel fee', balance: 'balance' }

// ---- eligibility ------------------------------------------------------------------------------------------------------------

/** A card is good through the last day of its expiry month (UTC); a card without an expiry is taken as Square holds it. */
export function cardExpired(c: Pick<CardRow, 'exp_month' | 'exp_year'>, now: Date): boolean {
  if (!c.exp_month || !c.exp_year) return false
  const end = Date.UTC(c.exp_year, c.exp_month, 1) // the first instant after the expiry month
  return now.getTime() >= end
}

export interface UsableCard {
  card: CardRow
  consentId: string
  purposes: CardPurpose[]
}

/**
 * The client's card that may be charged for `purpose`: active, not expired, of this location and client, with a live consent covering
 * the purpose (the newest such consent). `cardId` names one card; without it the newest usable card. null when there is none.
 */
export async function usableCard(
  db: Executor,
  o: { locationId: string; customerId: string; purpose: SquareChargePurpose; now: Date; cardId?: string | null },
): Promise<UsableCard | null> {
  const cards = await db
    .selectFrom('customer_cards')
    .selectAll()
    .where('location_id', '=', o.locationId)
    .where('customer_id', '=', o.customerId)
    .where('state', '=', 'active')
    .$if(!!o.cardId, (q) => q.where('id', '=', o.cardId!))
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute()
  for (const card of cards) {
    if (cardExpired(card, o.now)) continue
    const consent = await db
      .selectFrom('card_consents')
      .select(['id', 'purposes'])
      .where('card_id', '=', card.id)
      .where('revoked_at', 'is', null)
      .where(sql<boolean>`${o.purpose} = any(purposes)`)
      .orderBy('accepted_at', 'desc')
      .executeTakeFirst()
    if (consent) return { card, consentId: consent.id, purposes: consent.purposes.filter(isCardPurpose) }
  }
  return null
}

// ---- views ------------------------------------------------------------------------------------------------------------------

export interface ChargeView {
  id: string
  purpose: SquareChargePurpose
  state: SquareChargeState
  amountCents: number
  reason: string
  card: { id: string; label: string; brand: string | null; last4: string | null } | null
  invoiceId: string | null
  appointmentId: string | null
  squarePaymentId: string | null
  /** The plain reason of a decline (or why Square could not be reached). */
  error: string | null
  declineCode: string | null
  attempts: number
  proposedBy: string | null
  decidedBy: string | null
  decidedAt: string | null
  chargedAt: string | null
  waiveReason: string | null
  createdAt: string
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null)

export async function chargeViews(db: Executor, rows: ChargeRow[]): Promise<ChargeView[]> {
  const ids = [...new Set(rows.map((r) => r.card_id).filter((x): x is string => !!x))]
  const cards = ids.length ? await db.selectFrom('customer_cards').select(['id', 'brand', 'last4']).where('id', 'in', ids).execute() : []
  const byId = new Map(cards.map((c) => [c.id, c]))
  return rows.map((r) => {
    const c = r.card_id ? byId.get(r.card_id) : undefined
    return {
      id: r.id,
      purpose: r.purpose,
      state: r.state,
      amountCents: r.amount_cents,
      reason: r.reason ?? REASONS[r.purpose],
      card: c ? { id: c.id, label: cardLabel(c.brand, c.last4).label, brand: c.brand, last4: c.last4 } : null,
      invoiceId: r.invoice_id,
      appointmentId: r.appointment_id,
      squarePaymentId: r.square_payment_id,
      error: r.error,
      declineCode: r.decline_code,
      attempts: r.attempts,
      proposedBy: r.proposed_by,
      decidedBy: r.decided_by,
      decidedAt: iso(r.decided_at),
      chargedAt: iso(r.charged_at),
      waiveReason: r.waive_reason,
      createdAt: r.created_at.toISOString(),
    }
  })
}

export async function chargeView(db: Executor, id: string): Promise<ChargeView> {
  const row = await db.selectFrom('square_charges').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
  return (await chargeViews(db, [row]))[0]!
}

// ---- the attempt ------------------------------------------------------------------------------------------------------------

export interface ChargeOutcome {
  chargeId: string
  state: SquareChargeState
  invoiceId: string | null
  /** The plain reason of a decline. */
  error: string | null
}

const auditCtx = (a: SquareActor): AuditContext =>
  a.audit ?? { actor: { userId: a.userId ?? null, employeeId: a.employeeId ?? null, name: a.name, roles: a.roles ?? null } }

/** Who confirmed a charge, as the ledger and the audit name them (the webhook and the job record it in that person's name). */
const deciderOf = (r: ChargeRow): SquareActor => ({ userId: r.decided_by_user_id, name: r.decided_by ?? 'Staff', manual: true })

async function activity(tx: Tx, appointmentId: string | null, at: Date, text: string, actor: string | null, meta: Record<string, unknown>): Promise<void> {
  if (!appointmentId) return
  await tx
    .insertInto('activity_log')
    .values({
      appointment_id: appointmentId,
      at,
      text,
      channels: ['internal'],
      actor_type: actor ? 'staff' : 'system',
      actor_name: actor,
      meta: JSON.stringify(meta) as never,
    })
    .execute()
}

/** The exact CreatePayment of a charge's attempt: built from the row, so the job's re-send is the same request. */
export async function paymentRequestOf(db: Executor, env: Env, r: ChargeRow): Promise<{ key: ReturnType<typeof sqKey>; body: CreatePaymentInput }> {
  if (!r.card_id) throw new AppError('CARD_NOT_USABLE')
  const card = await db.selectFrom('customer_cards').select(['square_card_id', 'square_customer_id']).where('id', '=', r.card_id).executeTakeFirstOrThrow()
  const location = squareLocationId(env)
  if (!location) throw new AppError('SQUARE_UNAVAILABLE', { detail: 'SQUARE_LOCATION_ID is not set' })
  const inv = r.invoice_id ? await db.selectFrom('invoices').select('invoice_no').where('id', '=', r.invoice_id).executeTakeFirst() : undefined
  const reason = r.reason ?? REASONS[r.purpose]
  return {
    key: r.idempotency_key as ReturnType<typeof sqKey>,
    body: {
      source_id: card.square_card_id,
      customer_id: card.square_customer_id,
      amount_money: usd(r.amount_cents),
      location_id: location,
      autocomplete: true,
      // the charge's own id: the webhook of this payment finds the charge by it (classify `charge`)
      reference_id: r.id,
      note: inv ? `${invoiceLabel(inv.invoice_no)} · ${reason}` : reason,
    },
  }
}

type Answer =
  | { kind: 'paid'; payment: WirePayment }
  /** `by`: staff closed it ("Not charged (checked Square)"), recorded in their name. */
  | { kind: 'declined'; code: string | null; text: string; by?: SquareActor }
  | { kind: 'unknown'; error: string; paymentId?: string | null }
  /** Only looked, nothing sent and nothing learned: the row is left as it is (its last request time stays). */
  | { kind: 'wait' }

/** What one CreatePayment answered, sorted into the three outcomes. */
async function send(d: CardChargeDeps, r: ChargeRow): Promise<Answer> {
  let req: Awaited<ReturnType<typeof paymentRequestOf>>
  try {
    req = await paymentRequestOf(d.db, d.env, r)
  } catch (e) {
    // nothing was sent (no card, no Square location): nothing can have been charged
    const detail = e instanceof AppError ? e.detail : 'The charge could not be sent'
    return { kind: 'declined', code: 'NOT_SENT', text: `Nothing was charged: ${detail}` }
  }
  try {
    const p = await d.api.payments.create(req.key, req.body)
    if (p.status === 'COMPLETED') return { kind: 'paid', payment: p }
    if (p.status === 'FAILED' || p.status === 'CANCELED') return { kind: 'declined', code: null, text: declineText(undefined) }
    // APPROVED or PENDING: the payment exists; the webhook (or the job's GetPayment) records it once it completes
    return { kind: 'unknown', error: `Square answered ${p.status.toLowerCase()}`, paymentId: p.id }
  } catch (e) {
    if (e instanceof SquareDeclined) return { kind: 'declined', code: e.code ?? null, text: e.friendly }
    if (e instanceof SquareWritesDisabled) return { kind: 'declined', code: 'WRITES_OFF', text: 'Square is in watch-only mode, so nothing was charged.' }
    if (e instanceof SquareIdempotencyReused) {
      d.logger?.error({ chargeId: r.id }, 'square: a card charge key was reused with another body')
      return { kind: 'unknown', error: 'Square refused the request as a repeat; check the Square dashboard' }
    }
    // refused before anything was charged: the token, a permission, a request Square will not take (a disabled card)
    if (e instanceof SquareAuthError || e instanceof SquarePermissionError)
      return { kind: 'declined', code: e.code ?? null, text: 'Square refused the request, so nothing was charged. Check the Square connection.' }
    if (e instanceof SquareApiError && !e.retryable && e.status >= 400 && e.status < 500) return { kind: 'declined', code: e.code ?? null, text: declineText(e.code) }
    d.logger?.warn({ chargeId: r.id, err: e instanceof Error ? e.message : String(e) }, 'square: a card charge got no answer')
    return { kind: 'unknown', error: 'Square did not answer' }
  }
}

/** Sends a claimed attempt and records the answer (the caller holds no transaction). */
export async function runAttempt(d: CardChargeDeps, chargeId: string): Promise<ChargeOutcome> {
  const r = await d.db.selectFrom('square_charges').selectAll().where('id', '=', chargeId).executeTakeFirstOrThrow()
  const answer = await send(d, r)
  return transaction(d.db, (tx) => applyAnswer(tx, d, chargeId, answer))
}

async function applyAnswer(tx: Tx, d: CardChargeDeps, chargeId: string, a: Answer): Promise<ChargeOutcome> {
  if (a.kind === 'paid') return recordChargePayment(tx, d, chargeId, paymentFacts(a.payment))
  const r = await tx.selectFrom('square_charges').selectAll().where('id', '=', chargeId).forUpdate().executeTakeFirstOrThrow()
  const out = (row: ChargeRow): ChargeOutcome => ({ chargeId, state: row.state, invoiceId: row.invoice_id, error: row.error })
  // the webhook recorded it meanwhile, or another path decided it
  if (r.state !== 'charging' && r.state !== 'unknown') return out(r)
  if (a.kind === 'wait') return out(r)
  const now = d.clock.now()
  if (a.kind === 'declined') {
    const row = await tx
      .updateTable('square_charges')
      .set({ state: 'declined', error: a.text, decline_code: a.code, updated_at: now })
      .where('id', '=', chargeId)
      .returningAll()
      .executeTakeFirstOrThrow()
    await audit.record(tx, {
      locationId: r.location_id,
      action: a.by ? 'card.charge_not_charged' : 'card.charge_declined',
      entityType: 'square_charge',
      entityId: chargeId,
      after: { purpose: r.purpose, amountCents: r.amount_cents, code: a.code, invoiceId: r.invoice_id },
      ctx: auditCtx(a.by ?? deciderOf(r)),
    })
    const what = a.by ? 'marked not charged' : 'declined'
    await activity(tx, r.appointment_id, now, `${row.reason ?? REASONS[r.purpose]} ${what} · ${formatUsd(r.amount_cents)} · ${a.text}`, a.by?.name ?? null, { chargeId })
    return out(row)
  }
  const row = await tx
    .updateTable('square_charges')
    .set({ state: 'unknown', error: a.error, ...(a.paymentId ? { square_payment_id: a.paymentId } : {}), updated_at: now })
    .where('id', '=', chargeId)
    .returningAll()
    .executeTakeFirstOrThrow()
  return out(row)
}

/**
 * Records a charge's completed Square payment on its invoice (rule `charge`, key square:pay:<payment id>, the ledger reason "No-show
 * fee" / "Late-cancel fee" / "Balance", in the name of the staff member who confirmed it) and marks the charge `charged`. Idempotent:
 * the webhook, the route and the job may each bring the same payment; the first records it, the others find it recorded.
 */
export async function recordChargePayment(
  tx: Tx,
  d: Pick<CardChargeDeps, 'clock' | 'newId' | 'locationId' | 'queue' | 'logger'> & { env: SquarePaymentDeps['env'] },
  chargeId: string,
  f: SquarePaymentFacts,
): Promise<ChargeOutcome> {
  await lockPayment(tx, f.paymentId)
  const pd = { locationId: d.locationId, clock: d.clock, newId: d.newId, env: d.env }
  await upsertMirror(tx, pd, f)
  const r = await tx.selectFrom('square_charges').selectAll().where('id', '=', chargeId).forUpdate().executeTakeFirstOrThrow()
  if (r.state === 'charged' && r.ledger_event_id)
    return { chargeId, state: 'charged', invoiceId: r.invoice_id, error: null }
  if (!r.invoice_id) throw new AppError('CARD_CHARGE_NOT_FOUND')
  await tx.updateTable('square_payments').set({ classification: 'charge', updated_at: d.clock.now() }).where('square_payment_id', '=', f.paymentId).execute()
  const ops = new SquareLedgerOps(pd)
  const variance = f.amountCents !== r.amount_cents ? { expectedCents: r.amount_cents, paidCents: f.amountCents } : null
  const actor = deciderOf(r)
  const rec = await ops.recordPayment(tx, {
    facts: f,
    invoiceId: r.invoice_id,
    rule: 'charge',
    confidence: 1,
    actor,
    reason: r.reason ?? REASONS[r.purpose],
    variance,
  })
  const now = d.clock.now()
  await tx
    .updateTable('square_charges')
    .set({ state: 'charged', square_payment_id: f.paymentId, ledger_event_id: rec.eventId, charged_at: now, error: null, decline_code: null, updated_at: now })
    .where('id', '=', chargeId)
    .execute()
  const card = r.card_id ? await tx.selectFrom('customer_cards').select(['brand', 'last4']).where('id', '=', r.card_id).executeTakeFirst() : undefined
  const label = cardLabel(card?.brand ?? f.brand, card?.last4 ?? f.last4).label
  await audit.record(tx, {
    locationId: r.location_id,
    action: 'card.charged',
    entityType: 'square_charge',
    entityId: chargeId,
    after: { purpose: r.purpose, amountCents: f.amountCents, squarePaymentId: f.paymentId, eventId: rec.eventId, invoiceId: r.invoice_id, card: label },
    ctx: auditCtx(actor),
  })
  await activity(tx, r.appointment_id, now, `${r.reason ?? REASONS[r.purpose]} charged · ${formatUsd(f.amountCents)} on ${label}`, actor.name, { chargeId, squarePaymentId: f.paymentId })
  if (r.purpose !== 'balance') await textFeeCharged(tx, d, r, f.amountCents, label)
  return { chargeId, state: 'charged', invoiceId: r.invoice_id, error: null }
}

/** The card_fee_charged text to the client (a fee only: a balance is charged with the client at the counter). */
async function textFeeCharged(
  tx: Tx,
  d: Pick<CardChargeDeps, 'queue' | 'logger'>,
  r: ChargeRow,
  amountCents: number,
  card: string,
): Promise<void> {
  if (!d.queue) {
    d.logger?.warn({ chargeId: r.id }, 'square: no messaging queue wired; the fee text was not sent')
    return
  }
  const target = await loadCustomerTarget(tx, r.location_id, r.customer_id)
  if (!target) return
  const out = await d.queue.enqueueFor(tx, {
    locationId: r.location_id,
    customerId: r.customer_id,
    recipient: target.recipient,
    appointmentId: r.appointment_id,
    templateKey: 'card_fee_charged',
    vars: { amount: formatUsd(amountCents), card: cardWords(card), fee: FEE_WORDS[r.purpose] },
    purpose: 'card_fee_charged',
    senderKind: 'system',
    dedupeKey: `card-fee:${r.id}`,
  })
  if (!out.queued) d.logger?.info({ chargeId: r.id, skipped: out.skipped }, 'square: the fee text was not queued')
}

// ---- a balance on a saved card ------------------------------------------------------------------------------------------------

export interface BalanceChargeInput {
  invoiceId: string
  cardId: string
  amountCents: number
  actor: SquareActor
  /**
   * The staff request (the user and its Idempotency-Key): the same request coming again after its stored answer was lost finds its
   * charge (charged: answered as is; waiting: its state; declined: a new attempt, checked like a new charge) instead of charging a second time.
   */
  requestKey?: string | null
}

const outcomeOf = (r: Pick<ChargeRow, 'id' | 'state' | 'invoice_id' | 'error'>): ChargeOutcome => ({ chargeId: r.id, state: r.state, invoiceId: r.invoice_id, error: r.error })

/** A new attempt of a declined charge: a new key (Square answers a key's first result), `charging` again. */
async function retryAttempt(tx: Tx, d: Pick<CardChargeDeps, 'clock'>, r: ChargeRow, i: { actor: SquareActor; requestKey?: string | null; cardId?: string; consentId?: string }): Promise<void> {
  const now = d.clock.now()
  const attempts = r.attempts + 1
  await tx
    .updateTable('square_charges')
    .set({
      state: 'charging',
      attempts,
      // the first attempt keeps ch_<id>; each new attempt gets its own key
      idempotency_key: attempts === 1 ? r.idempotency_key : sqKey('ch', `${r.id}:${attempts}`),
      ...(i.cardId ? { card_id: i.cardId } : {}),
      ...(i.consentId ? { consent_id: i.consentId } : {}),
      decided_by: i.actor.name,
      decided_by_user_id: i.actor.userId ?? null,
      decided_at: now,
      attempted_at: now,
      request_key: i.requestKey ?? null,
      error: null,
      decline_code: null,
      updated_at: now,
    })
    .where('id', '=', r.id)
    .execute()
  await audit.record(tx, {
    locationId: r.location_id,
    action: 'card.charge_started',
    entityType: 'square_charge',
    entityId: r.id,
    after: { purpose: r.purpose, amountCents: r.amount_cents, invoiceId: r.invoice_id, appointmentId: r.appointment_id, cardId: i.cardId ?? r.card_id, attempt: attempts },
    ctx: auditCtx(i.actor),
  })
}

/**
 * Staff charge a saved card for (part of) an invoice's balance, with the client's OK: the card's consent must cover `balance`. One
 * charge at a time per invoice (409 CARD_CHARGE_IN_PROGRESS while one waits for Square). 422 PAY_AMOUNT_INVALID above the balance,
 * 422 PAY_NOTHING_TO_COLLECT on a paid or canceled invoice, 422 CARD_NOT_USABLE, 409 CARD_PAYMENTS_OFF / SQUARE_WRITES_OFF before
 * anything is written. The outcome's state: charged, declined (with the reason) or unknown (the job resolves it).
 */
export async function chargeBalance(d: CardChargeDeps, i: BalanceChargeInput): Promise<ChargeOutcome> {
  if (!cardsOn(d.env)) throw new AppError('CARD_PAYMENTS_OFF')
  if (!squareWritesOn(d.env)) throw new AppError('SQUARE_WRITES_OFF')
  const claimed = await transaction(d.db, async (tx): Promise<{ chargeId: string; done?: ChargeOutcome }> => {
    const inv = await lockInvoice(tx, d.locationId, i.invoiceId)
    // the same request again (its stored answer was lost): its charge, never a second one
    let declined: ChargeRow | null = null
    if (i.requestKey) {
      const mine = await tx
        .selectFrom('square_charges')
        .selectAll()
        .where('location_id', '=', d.locationId)
        .where('request_key', '=', i.requestKey)
        .forUpdate()
        .executeTakeFirst()
      if (mine) {
        if (mine.invoice_id !== inv.id || mine.purpose !== 'balance' || mine.amount_cents !== i.amountCents) throw new AppError('IDEMPOTENCY_MISMATCH')
        if (mine.state !== 'declined') return { chargeId: mine.id, done: outcomeOf(mine) }
        // declined: a new attempt, checked like a new charge (the invoice may have been paid, canceled or charged meanwhile)
        declined = mine
      }
    }
    if (inv.canceled_at) throw new AppError('PAY_NOTHING_TO_COLLECT', { detail: 'A canceled invoice has nothing to pay' })
    const calc = await calcOf(tx, inv.id)
    if (calc.balance <= 0) throw new AppError('PAY_NOTHING_TO_COLLECT')
    if (!Number.isSafeInteger(i.amountCents) || i.amountCents <= 0 || i.amountCents > calc.balance)
      throw new AppError('PAY_AMOUNT_INVALID', { detail: `Charge between $0.01 and the balance, ${formatUsd(calc.balance)}` })
    const open = await tx
      .selectFrom('square_charges')
      .select('id')
      .where('invoice_id', '=', inv.id)
      .where('state', 'in', ['charging', 'unknown'])
      .executeTakeFirst()
    if (open) throw new AppError('CARD_CHARGE_IN_PROGRESS')
    const now = d.clock.now()
    const usable = await usableCard(tx, { locationId: d.locationId, customerId: inv.customer_id, purpose: 'balance', now, cardId: i.cardId })
    if (!usable) throw new AppError('CARD_NOT_USABLE')
    if (declined) {
      await retryAttempt(tx, d, declined, { actor: i.actor, requestKey: i.requestKey, cardId: usable.card.id, consentId: usable.consentId })
      return { chargeId: declined.id }
    }
    const id = d.newId()
    await tx
      .insertInto('square_charges')
      .values({
        id,
        location_id: d.locationId,
        customer_id: inv.customer_id,
        card_id: usable.card.id,
        consent_id: usable.consentId,
        purpose: 'balance',
        amount_cents: i.amountCents,
        state: 'charging',
        idempotency_key: sqKey('ch', id),
        invoice_id: inv.id,
        appointment_id: inv.appointment_id,
        attempts: 1,
        proposed_by: i.actor.name,
        decided_by: i.actor.name,
        decided_by_user_id: i.actor.userId ?? null,
        decided_at: now,
        attempted_at: now,
        reason: REASONS.balance,
        request_key: i.requestKey ?? null,
        created_at: now,
        updated_at: now,
      })
      .execute()
    await audit.record(tx, {
      locationId: d.locationId,
      action: 'card.charge_started',
      entityType: 'square_charge',
      entityId: id,
      after: { purpose: 'balance', amountCents: i.amountCents, invoiceId: inv.id, cardId: usable.card.id, consentId: usable.consentId },
      ctx: auditCtx(i.actor),
    })
    return { chargeId: id }
  })
  if (claimed.done) return claimed.done
  // the invoice lock is released: Square is called on the pool
  return runAttempt(d, claimed.chargeId)
}

// ---- fees: charge or waive what the cancel or no-show proposed ----------------------------------------------------------------

/** The fee charge of a visit, locked; 404 CARD_CHARGE_NOT_FOUND for another visit's or location's. */
async function feeRow(tx: Tx, locationId: string, appointmentId: string, chargeId: string): Promise<ChargeRow> {
  const r = await tx
    .selectFrom('square_charges')
    .selectAll()
    .where('id', '=', chargeId)
    .where('location_id', '=', locationId)
    .where('appointment_id', '=', appointmentId)
    .where('purpose', 'in', ['no_show_fee', 'late_cancel_fee'])
    .forUpdate()
    .executeTakeFirst()
  if (!r) throw new AppError('CARD_CHARGE_NOT_FOUND')
  return r
}

/**
 * Staff charge a proposed (or declined) fee: on its card, or `cardId` (another of the client's cards whose consent covers the fee).
 * A declined fee charged again is a new attempt with a new key. 409 CARD_CHARGE_DECIDED once charged or waived, 409
 * CARD_CHARGE_IN_PROGRESS while an attempt waits for Square.
 */
export async function chargeFee(
  d: CardChargeDeps,
  i: { appointmentId: string; chargeId: string; cardId?: string | null; actor: SquareActor; requestKey?: string | null },
): Promise<ChargeOutcome> {
  if (!cardsOn(d.env)) throw new AppError('CARD_PAYMENTS_OFF')
  if (!squareWritesOn(d.env)) throw new AppError('SQUARE_WRITES_OFF')
  const done = await transaction(d.db, async (tx): Promise<ChargeOutcome | null> => {
    const r = await feeRow(tx, d.locationId, i.appointmentId, i.chargeId)
    // the same request again (its stored answer was lost): what that attempt came to
    if (i.requestKey && r.request_key === i.requestKey && r.state !== 'declined') return outcomeOf(r)
    if (r.state === 'charging' || r.state === 'unknown') throw new AppError('CARD_CHARGE_IN_PROGRESS')
    if (r.state !== 'proposed' && r.state !== 'declined') throw new AppError('CARD_CHARGE_DECIDED')
    const usable = await usableCard(tx, { locationId: d.locationId, customerId: r.customer_id, purpose: r.purpose, now: d.clock.now(), cardId: i.cardId ?? r.card_id })
    if (!usable) throw new AppError('CARD_NOT_USABLE')
    await retryAttempt(tx, d, r, { actor: i.actor, requestKey: i.requestKey, cardId: usable.card.id, consentId: usable.consentId })
    return null
  })
  return done ?? runAttempt(d, i.chargeId)
}

/** Staff waive a proposed or declined fee (audited `card.fee_waived`, an activity line). 409 CARD_CHARGE_DECIDED / IN_PROGRESS. */
export async function waiveFee(
  tx: Tx,
  d: Pick<CardChargeDeps, 'clock' | 'locationId'>,
  i: { appointmentId: string; chargeId: string; reason: string; actor: SquareActor },
): Promise<void> {
  const r = await feeRow(tx, d.locationId, i.appointmentId, i.chargeId)
  if (r.state === 'charging' || r.state === 'unknown') throw new AppError('CARD_CHARGE_IN_PROGRESS')
  if (r.state !== 'proposed' && r.state !== 'declined') throw new AppError('CARD_CHARGE_DECIDED')
  const now = d.clock.now()
  await tx
    .updateTable('square_charges')
    .set({ state: 'waived', waive_reason: i.reason, decided_by: i.actor.name, decided_by_user_id: i.actor.userId ?? null, decided_at: now, updated_at: now })
    .where('id', '=', r.id)
    .execute()
  await audit.record(tx, {
    locationId: d.locationId,
    action: 'card.fee_waived',
    entityType: 'square_charge',
    entityId: r.id,
    before: { state: r.state },
    after: { state: 'waived', purpose: r.purpose, amountCents: r.amount_cents, reason: i.reason },
    ctx: auditCtx(i.actor),
  })
  await activity(tx, r.appointment_id, now, `${r.reason ?? REASONS[r.purpose]} waived · ${formatUsd(r.amount_cents)} · ${i.reason}`, i.actor.name, { chargeId: r.id })
}

// ---- the job: unanswered attempts ---------------------------------------------------------------------------------------------

export interface ResolveReport {
  considered: number
  charged: number
  declined: number
  unknown: number
  /** Past the re-send window, or Square watch-only: only looked up, never sent again (review Q4 H1-R1). */
  stale: number
}

/** Square has no payment for the charge this long after its last request: nothing was charged (the job closes it, NOT_SENT). */
export const CHARGE_SETTLE_MS = 15 * MIN

/** When the charge's last request ended: each re-send that got no answer moves updated_at (a look-up alone never does). */
const lastRequestAt = (r: ChargeRow): Date => {
  const at = r.attempted_at ?? r.created_at
  return r.updated_at > at ? r.updated_at : at
}

const NONE_AT_SQUARE = 'Nothing was charged: Square has no payment for it.'

/**
 * square.charges.resolve: every charge Square did not answer (state `unknown`, or `charging` for more than 5 minutes: its process
 * died between the call and the answer). With the payment id known: GetPayment. Otherwise the payment a request made is looked for
 * (ListPayments from a minute before the first request to 15 minutes after the last, by reference_id); found: recorded (or declined
 * as Square has it). None, and a balance charge whose invoice was canceled or now owes less than the charge: closed `declined`
 * (NOT_SENT, nothing charged). None otherwise: within 23 hours of the attempt and with Square writes on, the SAME CreatePayment with
 * the SAME key (Square answers the payment it already made, or makes it now, exactly once); past the window or watch-only
 * (SQUARE_WRITES_ENABLED=false, the rollback lever), nothing is sent and the charge is closed NOT_SENT once its last request is 15
 * minutes old, so a charge never blocks its invoice for good (review Q4 H1-R1). Square not answering the look-up: it waits.
 */
export async function resolveCharges(d: CardChargeDeps): Promise<ResolveReport> {
  const report: ResolveReport = { considered: 0, charged: 0, declined: 0, unknown: 0, stale: 0 }
  const writes = squareWritesOn(d.env)
  const now = d.clock.now()
  const oldest = new Date(now.getTime() - RESEND_WINDOW_MS)
  const rows = await d.db
    .selectFrom('square_charges')
    .selectAll()
    .where('location_id', '=', d.locationId)
    .where((eb) =>
      eb.or([eb('state', '=', 'unknown'), eb.and([eb('state', '=', 'charging'), eb('attempted_at', '<', new Date(now.getTime() - CHARGING_STALE_MS))])]),
    )
    .orderBy('attempted_at')
    .orderBy('id')
    .limit(50)
    .execute()
  for (const r of rows) {
    report.considered += 1
    const resend = writes && r.attempted_at !== null && r.attempted_at >= oldest
    if (!resend) report.stale += 1
    let answer: Answer
    const found = await lookUp(d, r)
    if (found === 'unreachable') answer = { kind: 'wait' }
    else if (found) answer = answerOf(found)
    // Square never got it, and the invoice no longer owes it (paid another way, or canceled): nothing is sent (plan decision 6:
    // staff confirmed a charge of a balance that is gone)
    else if (await noLongerOwed(d.db, r)) answer = { kind: 'declined', code: 'NOT_SENT', text: 'Nothing was charged: the invoice no longer owes it.' }
    else if (resend) answer = await send(d, r)
    else if (now.getTime() - lastRequestAt(r).getTime() >= CHARGE_SETTLE_MS) answer = { kind: 'declined', code: 'NOT_SENT', text: NONE_AT_SQUARE }
    else answer = { kind: 'wait' }
    try {
      const out = await transaction(d.db, (tx) => applyAnswer(tx, d, r.id, answer))
      if (out.state === 'charged') report.charged += 1
      else if (out.state === 'declined') report.declined += 1
      else report.unknown += 1
    } catch (e) {
      report.unknown += 1
      d.logger?.warn({ chargeId: r.id, err: e instanceof Error ? e.message : String(e) }, 'square: recording a resolved charge failed')
    }
  }
  return report
}

/** The Square payment of a charge: GetPayment when its id is known, else by reference_id; null: none, 'unreachable': no answer. */
async function lookUp(d: CardChargeDeps, r: ChargeRow): Promise<WirePayment | null | 'unreachable'> {
  if (!r.square_payment_id) return paymentOfCharge(d, r)
  try {
    return await d.api.payments.get(r.square_payment_id)
  } catch {
    return 'unreachable'
  }
}

/**
 * Staff "Not charged (checked Square)" (POST /invoices/:id/card-charges/:chargeId/not-charged, review Q4 H1-R1): the same read-only
 * look-up as the job, at once and with Square watch-only too. Square has the payment: it is recorded (or declined as Square has it),
 * never closed as not charged; Square has none: the charge is closed `declined` (NOT_SENT) in the staff member's name (audit
 * `card.charge_not_charged`, an activity line) and the invoice can be collected again. 404 CARD_CHARGE_NOT_FOUND (another invoice's),
 * 409 CARD_CHARGE_NOT_WAITING (already charged, declined or waived), 409 CARD_CHARGE_IN_PROGRESS (its request is still out, or
 * Square shows the payment pending), 503 SQUARE_UNAVAILABLE (Square did not answer: nothing changes).
 */
export async function closeUnanswered(d: CardChargeDeps, i: { invoiceId: string; chargeId: string; actor: SquareActor }): Promise<ChargeOutcome> {
  const r = await d.db
    .selectFrom('square_charges')
    .selectAll()
    .where('id', '=', i.chargeId)
    .where('location_id', '=', d.locationId)
    .where('invoice_id', '=', i.invoiceId)
    .executeTakeFirst()
  if (!r) throw new AppError('CARD_CHARGE_NOT_FOUND')
  if (r.state !== 'charging' && r.state !== 'unknown') throw new AppError('CARD_CHARGE_NOT_WAITING')
  if (r.state === 'charging' && (r.attempted_at ?? r.created_at).getTime() > d.clock.now().getTime() - CHARGING_STALE_MS)
    throw new AppError('CARD_CHARGE_IN_PROGRESS')
  const found = await lookUp(d, r)
  if (found === 'unreachable') throw new AppError('SQUARE_UNAVAILABLE')
  let answer: Answer
  if (found) {
    answer = answerOf(found)
    if (answer.kind === 'unknown')
      throw new AppError('CARD_CHARGE_IN_PROGRESS', { detail: 'Square shows this payment as still going through. Check again in a few minutes.' })
  } else answer = { kind: 'declined', code: 'NOT_SENT', text: `${NONE_AT_SQUARE} Checked by ${i.actor.name}.`, by: i.actor }
  const out = await transaction(d.db, (tx) => applyAnswer(tx, d, r.id, answer))
  if (out.state !== 'charged' && out.state !== 'declined') throw new AppError('CARD_CHARGE_NOT_WAITING')
  return out
}

const answerOf = (p: WirePayment): Answer =>
  p.status === 'COMPLETED'
    ? { kind: 'paid', payment: p }
    : p.status === 'FAILED' || p.status === 'CANCELED'
      ? { kind: 'declined', code: null, text: declineText(undefined) }
      : { kind: 'unknown', error: `Square answered ${p.status.toLowerCase()}`, paymentId: p.id }

/** How far around the attempt the job looks for the payment Square may have made (ListPayments by creation time). */
export const CHARGE_LOOKUP_BEFORE_MS = MIN
export const CHARGE_LOOKUP_AFTER_MS = 15 * MIN
const CHARGE_LOOKUP_PAGES = 20

/**
 * The Square payment a charge's requests made (its reference_id is the charge id), null when none, 'unreachable' when Square did not
 * answer. From a minute before the attempt to 15 minutes after its last request (a re-send hours later made it then).
 */
async function paymentOfCharge(d: CardChargeDeps, r: ChargeRow): Promise<WirePayment | null | 'unreachable'> {
  const at = (r.attempted_at ?? r.created_at).getTime()
  const last = lastRequestAt(r).getTime()
  try {
    let cursor: string | undefined
    for (let page = 0; page < CHARGE_LOOKUP_PAGES; page++) {
      const res = await d.api.payments.list({
        begin_time: new Date(at - CHARGE_LOOKUP_BEFORE_MS).toISOString(),
        end_time: new Date(last + CHARGE_LOOKUP_AFTER_MS).toISOString(),
        ...(squareLocationId(d.env) ? { location_id: squareLocationId(d.env) } : {}),
        sort_order: 'ASC',
        ...(cursor ? { cursor } : {}),
      })
      const mine = res.items.find((p) => p.reference_id === r.id)
      if (mine) return mine
      cursor = res.cursor ?? undefined
      if (!cursor) return null
    }
    return 'unreachable'
  } catch {
    return 'unreachable'
  }
}

/** A balance charge whose invoice is canceled or now owes less than the charge (a fee sits on a canceled invoice by design). */
async function noLongerOwed(db: Db, r: ChargeRow): Promise<boolean> {
  if (r.purpose !== 'balance' || !r.invoice_id) return false
  const inv = await db.selectFrom('invoices').select(['canceled_at']).where('id', '=', r.invoice_id).executeTakeFirst()
  if (!inv || inv.canceled_at) return true
  return (await calcOf(db, r.invoice_id)).balance < r.amount_cents
}

/** The charge a Square payment belongs to: by its payment id, or by its reference_id (the charge's id) while the charge waits. */
export async function chargeOfPayment(tx: Executor, locationId: string, f: Pick<SquarePaymentFacts, 'paymentId' | 'referenceId' | 'amountCents'>): Promise<string | null> {
  const byPayment = await tx
    .selectFrom('square_charges')
    .select('id')
    .where('location_id', '=', locationId)
    .where('square_payment_id', '=', f.paymentId)
    .executeTakeFirst()
  if (byPayment) return byPayment.id
  const ref = f.referenceId
  if (!ref || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) return null
  const byRef = await tx
    .selectFrom('square_charges')
    .select('id')
    .where('location_id', '=', locationId)
    .where('id', '=', ref.toLowerCase())
    .where('state', 'in', ['charging', 'unknown', 'declined'])
    .where('amount_cents', '=', f.amountCents)
    .executeTakeFirst()
  return byRef?.id ?? null
}
