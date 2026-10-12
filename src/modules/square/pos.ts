// The Square POS app switch (ADR 0171, design 2.6): "Open Square POS" on the dashboard (iPad), behind SQUARE_POS_API_ENABLED (live
// production only: the Point of Sale API has no sandbox). The intent writes the staff "card" entry for the balance (so the board
// shows it paid at once, like the "Square reader" tender), remembers a random `state` the app must hand back and a short code put in
// the payment's note (INV-20640 · OAS-PI-7KQ2X3). The app's answer comes back through the dashboard's callback page to
// POST /payments/square/pos-callback: the state is checked, the transaction id kept, and the order's payments are fetched and
// decided at once with the intent as strong evidence (rule R2). Without a callback (the app was closed), the payment still arrives by
// webhook and carries the code in its note.
import { randomBytes } from 'node:crypto'
import type { Env } from '../../config/env.js'
import type { SquareApi } from '../../integrations/ports/square.js'
import type { Clock } from '../../platform/clock.js'
import { transaction, type Db, type Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import type { NewId } from '../../platform/ids.js'
import { maskText } from '../../platform/logging.js'
import { invoiceLabel } from '../payments/format.js'
import { paymentFacts } from './facts.js'
import type { SquareLogger } from './ingest.js'
import { decideSquarePayment, lockPayment } from './payments.js'
import './problems.js'

const MIN = 60_000
export const POS_INTENT_TTL_MS = 30 * MIN
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function newPosCode(): string {
  const b = randomBytes(6)
  let s = ''
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[b[i]! % CODE_ALPHABET.length]
  return `OAS-PI-${s}`
}

export interface AppSwitchUrls {
  /** iOS: the Square Point of Sale app's URL scheme (API version 1.3). */
  ios: string
  /** Android: the CHARGE intent as an intent: URL. */
  android: string
}

/** The two app-switch URLs of an intent (pure). The callback is the dashboard's page; the client id is the application id. */
export function posAppSwitchUrls(i: { amountCents: number; note: string; state: string; callbackUrl: string; clientId: string }): AppSwitchUrls {
  const data = {
    amount_money: { amount: i.amountCents, currency_code: 'USD' },
    callback_url: i.callbackUrl,
    client_id: i.clientId,
    version: '1.3',
    notes: i.note,
    state: i.state,
    options: { supported_tender_types: ['CREDIT_CARD', 'CASH', 'OTHER', 'SQUARE_GIFT_CARD', 'CARD_ON_FILE'] },
  }
  const ios = `square-commerce-v1://payment/create?data=${encodeURIComponent(JSON.stringify(data))}`
  const extra = [
    'action=com.squareup.pos.action.CHARGE',
    'package=com.squareup',
    `S.com.squareup.pos.WEB_CALLBACK_URI=${encodeURIComponent(i.callbackUrl)}`,
    `S.com.squareup.pos.CLIENT_ID=${encodeURIComponent(i.clientId)}`,
    'S.com.squareup.pos.API_VERSION=v2.0',
    `i.com.squareup.pos.TOTAL_AMOUNT=${i.amountCents}`,
    'S.com.squareup.pos.CURRENCY_CODE=USD',
    'S.com.squareup.pos.TENDER_TYPES=com.squareup.pos.TENDER_CARD,com.squareup.pos.TENDER_CASH',
    `S.com.squareup.pos.NOTE=${encodeURIComponent(i.note)}`,
    `S.com.squareup.pos.REQUEST_METADATA=${encodeURIComponent(i.state)}`,
  ]
  return { ios, android: `intent:#Intent;${extra.join(';')};end` }
}

/** "Open Square POS" is possible: the switch is on, with live production Square and an application id. */
export function posEnabled(env: Pick<Env, 'SQUARE_POS_API_ENABLED' | 'SQUARE_PROVIDER' | 'SQUARE_ENVIRONMENT' | 'SQUARE_APPLICATION_ID'>): boolean {
  return env.SQUARE_POS_API_ENABLED && env.SQUARE_PROVIDER === 'live' && env.SQUARE_ENVIRONMENT === 'production' && !!env.SQUARE_APPLICATION_ID
}

export interface PosIntentView {
  id: string
  code: string
  amountCents: number
  note: string
  expiresAt: string
  appSwitch: AppSwitchUrls
}

/** Records the intent for the staff entry the collect command just wrote (same transaction). */
export async function recordPosIntent(
  tx: Tx,
  d: { clock: Clock; newId: NewId; env: Env },
  i: { locationId: string; invoiceId: string; invoiceNo: number; ledgerEventId: string; amountCents: number; createdBy: string | null },
): Promise<PosIntentView> {
  const now = d.clock.now()
  const code = newPosCode()
  const state = randomBytes(24).toString('base64url')
  const note = `${invoiceLabel(i.invoiceNo)} · ${code}`
  const id = d.newId()
  const expires = new Date(now.getTime() + POS_INTENT_TTL_MS)
  await tx
    .insertInto('square_pos_intents')
    .values({
      id,
      location_id: i.locationId,
      invoice_id: i.invoiceId,
      ledger_event_id: i.ledgerEventId,
      amount_cents: i.amountCents,
      callback_state: state,
      code,
      note,
      created_by: i.createdBy,
      created_at: now,
      expires_at: expires,
    })
    .execute()
  const callbackUrl = `${d.env.PUBLIC_DASHBOARD_URL.replace(/\/+$/, '')}/payments/square-callback`
  return {
    id,
    code,
    amountCents: i.amountCents,
    note,
    expiresAt: expires.toISOString(),
    appSwitch: posAppSwitchUrls({ amountCents: i.amountCents, note, state, callbackUrl, clientId: d.env.SQUARE_APPLICATION_ID ?? '' }),
  }
}

export interface PosCallbackInput {
  state: string
  transactionId?: string | null
  clientTransactionId?: string | null
  errorCode?: string | null
}

export interface PosCallbackResult {
  status: 'recorded' | 'error' | 'waiting'
  invoiceId: string
  errorCode: string | null
  payments: number
}

/**
 * The POS app's answer, as the dashboard's callback page posts it: the state must be an open intent's. An error code is kept (the
 * staff entry stays waiting; void it if nothing was charged). A transaction id: the order's tenders are fetched and each payment is
 * decided at once (the intent is the evidence). Square unreachable: the webhook brings the payment later.
 */
export async function handlePosCallback(
  d: { db: Db; clock: Clock; newId: NewId; env: Env; api: SquareApi; logger: SquareLogger; locationId: string },
  i: PosCallbackInput,
): Promise<PosCallbackResult> {
  const now = d.clock.now()
  const intent = await transaction(d.db, async (tx) => {
    const row = await tx
      .selectFrom('square_pos_intents')
      .selectAll()
      .where('location_id', '=', d.locationId)
      .where('callback_state', '=', i.state)
      .forUpdate()
      .executeTakeFirst()
    if (!row) throw new AppError('SQUARE_POS_INTENT_UNKNOWN')
    if (row.status === 'open' || row.status === 'callback_ok' || row.status === 'callback_error')
      await tx
        .updateTable('square_pos_intents')
        .set({
          status: i.errorCode ? 'callback_error' : 'callback_ok',
          transaction_id: row.transaction_id ?? i.transactionId ?? null,
          client_transaction_id: row.client_transaction_id ?? i.clientTransactionId ?? null,
          error_code: i.errorCode ?? null,
          callback_at: now,
        })
        .where('id', '=', row.id)
        .execute()
    return row
  })
  if (i.errorCode || !i.transactionId) return { status: i.errorCode ? 'error' : 'waiting', invoiceId: intent.invoice_id, errorCode: i.errorCode ?? null, payments: 0 }
  let paymentIds: string[] = []
  try {
    const order = await d.api.orders.retrieve(i.transactionId)
    paymentIds = (order.tenders ?? []).map((t) => t.payment_id ?? t.id ?? '').filter(Boolean)
  } catch (e) {
    d.logger.warn({ square: { intent: intent.id }, err: maskText(String(e)).slice(0, 200) }, 'square POS callback: order not read (the webhook brings the payment)')
    return { status: 'waiting', invoiceId: intent.invoice_id, errorCode: null, payments: 0 }
  }
  let n = 0
  for (const id of paymentIds) {
    let p
    try {
      p = await d.api.payments.get(id)
    } catch {
      continue
    }
    const f = paymentFacts(p)
    await transaction(d.db, async (tx) => {
      await lockPayment(tx, f.paymentId)
      // the callback names the order: the intent is found by it (and by the code in the note)
      await tx.updateTable('square_pos_intents').set({ transaction_id: i.transactionId! }).where('id', '=', intent.id).where('transaction_id', 'is', null).execute()
      await decideSquarePayment(tx, { locationId: d.locationId, clock: d.clock, newId: d.newId, env: d.env }, f, { force: true })
    })
    n++
  }
  return { status: 'recorded', invoiceId: intent.invoice_id, errorCode: null, payments: n }
}
