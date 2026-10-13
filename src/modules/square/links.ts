// Square payment links (ADR 0171 D3, design 3.1 to 3.4): created at click time for the EXACT amount owed, never kept once the
// invoice owes something else.
//
//   prepareSquareLink   on the pool, OUTSIDE any invoice lock: reads the invoice, builds the order (its lines, a "Sales tax" line
//                       and a "Tip" line when nothing was paid or adjusted yet, else one "Balance due · INV-n" line; a deposit is a
//                       quick-pay link), ASSERTS that the lines add up to the amount exactly, writes the row as `pending` (so a crash
//                       after the Square call leaves something the sweep can clean up) and calls CreatePaymentLink with the key
//                       pl_<row id> (a retry answers the same link)
//   activateSquareLink  inside the command's transaction: locks the invoice, checks the amount is still owed, makes the row `active`
//                       and supersedes the older active links of the same purpose; a stale amount answers CONCURRENT_UPDATE and the
//                       pending row is left to the sweep
//   sweepSquareLinks    square.links.sweep, every minute: cancels the active links whose invoice no longer owes exactly that amount
//                       (canceled, paid, changed, deposit paid, older than 7 days), gives up on pending rows nobody activated, and
//                       deletes canceled links at Square (404 counts as done). A payment on a link canceled a moment too late is still
//                       recorded (real money); an overpaid invoice is an alert.
import type { Env } from '../../config/env.js'
import type { SquareApi } from '../../integrations/ports/square.js'
import { squareLocationId } from '../../integrations/square/config.js'
import { SquareError, SquareNetworkError, SquareWritesDisabled } from '../../integrations/square/errors.js'
import { sqKey } from '../../integrations/square/keys.js'
import { usd } from '../../integrations/square/money.js'
import type { Clock } from '../../platform/clock.js'
import { transaction, type Db, type Executor, type Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import type { NewId } from '../../platform/ids.js'
import { maskText } from '../../platform/logging.js'
import { getSetting } from '../../platform/settings.js'
import type { InvoiceCalc } from '../payments/calc.js'
import { invoiceLabel } from '../payments/format.js'
import { calcOf, lockInvoice } from '../payments/repository.js'
import type { PaymentLinkCancelReason, PaymentLinkOrigin } from '../payments/schema.js'
import { assertNoChargeWaiting } from './charge-guard.js'
import type { SquareLogger } from './ingest.js'
import './problems.js'

const MIN = 60_000
const DAY = 24 * 60 * MIN
/** A link older than this is canceled (a payment link texted a week ago should not still take money for today's balance). */
export const LINK_MAX_AGE_MS = 7 * DAY
/** A pending row nobody activated (the command failed after the Square call) is given up after this long. */
export const PENDING_GIVE_UP_MS = 10 * MIN
/** A booking's deposit request that could not become a link (Square down, writes off) for this long is dropped. */
export const DEPOSIT_REQUEST_MAX_AGE_MS = DAY

export interface SquareLinkDeps {
  db: Db
  clock: Clock
  newId: NewId
  env: Env
  api: SquareApi
  logger?: SquareLogger
}

export type LinkPurpose = 'balance' | 'deposit'

export interface PreparedSquareLink {
  rowId: string
  invoiceId: string
  purpose: LinkPurpose
  expectedCents: number
  url: string
  squareLinkId: string
  squareOrderId: string | null
  invoiceVersion: number
}

export interface LinkLine {
  name: string
  cents: number
}

/** Square accepts at most 512 characters in a line name; ours are short, but a long package name is cut, never refused. */
const lineName = (s: string): string => (s.length > 120 ? `${s.slice(0, 119)}…` : s)

/**
 * The lines of a balance link (pure). An invoice nobody paid, adjusted or refunded anything on is shown line by line, with the tax and
 * the tip as lines of their own; any other is one "Balance due" line. The lines always add up to the amount exactly (asserted).
 */
export function balanceLines(
  inv: { invoiceNo: number },
  items: ReadonlyArray<{ name: string; priceCents: number }>,
  calc: Pick<InvoiceCalc, 'paid' | 'adj' | 'refunded' | 'pendingAmt' | 'tax' | 'tip' | 'balance' | 'total'>,
): LinkLine[] {
  const untouched = calc.paid === 0 && calc.adj === 0 && calc.refunded === 0 && calc.pendingAmt === 0 && calc.balance === calc.total
  const lines: LinkLine[] = untouched
    ? [
        ...items.filter((i) => i.priceCents > 0).map((i) => ({ name: lineName(i.name), cents: i.priceCents })),
        ...(calc.tax > 0 ? [{ name: 'Sales tax', cents: calc.tax }] : []),
        ...(calc.tip > 0 ? [{ name: 'Tip', cents: calc.tip }] : []),
      ]
    : [{ name: `Balance due · ${invoiceLabel(inv.invoiceNo)}`, cents: calc.balance }]
  assertExactSum(lines, calc.balance)
  return lines
}

export class LinkSumError extends Error {}

/** A link never asks for a cent more or less than the amount owed. */
export function assertExactSum(lines: readonly LinkLine[], expectedCents: number): void {
  const sum = lines.reduce((s, l) => s + l.cents, 0)
  if (expectedCents <= 0 || sum !== expectedCents || lines.some((l) => !Number.isSafeInteger(l.cents) || l.cents <= 0))
    throw new LinkSumError(`payment link lines add up to ${sum} cents, not the ${expectedCents} owed`)
}

/** A failure of the Square call as a problem the dashboard or the page shows. */
export function squareProblem(e: unknown): AppError {
  if (e instanceof SquareWritesDisabled) return new AppError('SQUARE_WRITES_OFF')
  return new AppError('SQUARE_UNAVAILABLE')
}

/** Square writes are possible: anything that would create a link or a refund needs it (observe-only otherwise). */
export function squareWritesOn(env: Pick<Env, 'SQUARE_WRITES_ENABLED'>): boolean {
  return env.SQUARE_WRITES_ENABLED
}

/** Square takes the payments of new links and refunds (the cutover switch). */
export function squareProcessor(env: Pick<Env, 'PAYMENT_PROCESSOR'>): boolean {
  return env.PAYMENT_PROCESSOR === 'square'
}

/**
 * The job square.refunds.submit sends the card refunds with processor 'square' (the cutover and Square writes on): such a refund is
 * Square's to settle, never confirmed by hand. Observe-only (or before the cutover) staff still confirm it by hand.
 */
export function squareSendsRefunds(env: Pick<Env, 'PAYMENT_PROCESSOR' | 'SQUARE_WRITES_ENABLED'>): boolean {
  return squareProcessor(env) && squareWritesOn(env)
}

async function invoiceFor(db: Executor, locationId: string, invoiceId: string) {
  const inv = await db
    .selectFrom('invoices')
    .select(['id', 'invoice_no', 'customer_id', 'canceled_at', 'version'])
    .where('id', '=', invoiceId)
    .where('location_id', '=', locationId)
    .executeTakeFirst()
  if (!inv) throw new AppError('NOT_FOUND', { detail: 'That invoice does not exist' })
  return inv
}

/** The deposit still owed on an invoice: none once a deposit pay is live, and never more than the balance. */
export async function depositOwed(db: Executor, invoiceId: string, cents: number): Promise<number> {
  if (cents <= 0 || (await depositPay(db, invoiceId))) return 0
  const calc = await calcOf(db, invoiceId)
  return calc.balance >= cents ? cents : 0
}

export interface PrepareInput {
  locationId: string
  invoiceId: string
  purpose: LinkPurpose
  /** The deposit (a deposit link); a balance link is always for the whole current balance. */
  amountCents?: number
  origin: PaymentLinkOrigin
  createdBy?: string | null
  /** An existing pending row to create at Square (a booking's deposit request). */
  rowId?: string
}

/**
 * Creates the Square link for the exact amount owed now, on the pool and outside any lock (the Square call must never run under an
 * invoice lock). The row is written `pending`; activateSquareLink makes it live in the caller's transaction.
 */
export async function prepareSquareLink(d: SquareLinkDeps, i: PrepareInput): Promise<PreparedSquareLink> {
  if (!squareWritesOn(d.env)) throw new AppError('SQUARE_WRITES_OFF')
  const location = squareLocationId(d.env)
  if (!location) throw new AppError('SQUARE_UNAVAILABLE', { detail: 'SQUARE_LOCATION_ID is not set' })
  const inv = await invoiceFor(d.db, i.locationId, i.invoiceId)
  if (inv.canceled_at) throw new AppError('INVOICE_CANCELED', { detail: 'A canceled invoice has nothing to pay' })
  // a saved-card charge still waiting for Square: no link meanwhile (review Q4 money:H1; activateSquareLink checks again under the lock)
  await assertNoChargeWaiting(d.db, inv.id, { client: i.origin === 'pay_page' || i.origin === 'deposit_page' })
  const calc = await calcOf(d.db, inv.id)
  let expected: number
  let body: Record<string, unknown>
  const label = invoiceLabel(inv.invoice_no)
  if (i.purpose === 'deposit') {
    expected = await depositOwed(d.db, inv.id, i.amountCents ?? 0)
    if (expected <= 0) throw new AppError('PAY_NOTHING_TO_COLLECT', { detail: 'The deposit is already paid or no longer owed' })
    assertExactSum([{ name: 'deposit', cents: expected }], expected)
    body = { quick_pay: { name: `Booking deposit · ${label}`, price_money: usd(expected), location_id: location } }
  } else {
    expected = calc.balance
    if (expected <= 0) throw new AppError('PAY_NOTHING_TO_COLLECT')
    const items = await d.db.selectFrom('invoice_items').select(['name', 'price_cents']).where('invoice_id', '=', inv.id).orderBy('position').execute()
    const lines = balanceLines({ invoiceNo: inv.invoice_no }, items.map((x) => ({ name: x.name, priceCents: x.price_cents })), calc)
    body = {
      order: {
        location_id: location,
        reference_id: label,
        line_items: lines.map((l) => ({ name: l.name, quantity: '1', base_price_money: usd(l.cents) })),
      },
    }
  }
  const tipping = (await getSetting(d.db, i.locationId, 'payments.link_tipping')).value
  const customer = await d.db.selectFrom('customers').select(['phone_e164', 'email']).where('id', '=', inv.customer_id).executeTakeFirst()
  const site = d.env.PUBLIC_SITE_URL?.replace(/\/+$/, '')
  const now = d.clock.now()
  let rowId = i.rowId
  if (!rowId) {
    rowId = d.newId()
    await d.db
      .insertInto('payment_links')
      .values({
        id: rowId,
        location_id: i.locationId,
        invoice_id: inv.id,
        kind: i.purpose === 'deposit' ? 'square_quick_pay' : 'square_order',
        purpose: i.purpose,
        url: null,
        expected_cents: expected,
        created_by: i.createdBy ?? null,
        state: 'pending',
        provider: 'square',
        origin: i.origin,
        invoice_version: inv.version,
        created_at: now,
      })
      .execute()
  } else {
    await d.db.updateTable('payment_links').set({ expected_cents: expected, invoice_version: inv.version }).where('id', '=', rowId).execute()
  }
  try {
    const { link, order } = await d.api.checkout.createLink(sqKey('pl', rowId), {
      ...body,
      payment_note: label,
      checkout_options: {
        allow_tipping: tipping,
        ask_for_shipping_address: false,
        enable_coupon: false,
        enable_loyalty: false,
        accepted_payment_methods: { apple_pay: true, google_pay: true, cash_app_pay: false, afterpay_clearpay: false },
        ...(site ? { redirect_url: `${site}/#/paid` } : {}),
      },
      ...(customer?.phone_e164 || customer?.email
        ? {
            pre_populated_data: {
              ...(customer.phone_e164 ? { buyer_phone_number: customer.phone_e164 } : {}),
              ...(customer.email ? { buyer_email: String(customer.email) } : {}),
            },
          }
        : {}),
    })
    const url = link.url
    if (!/^https:\/\//.test(url)) throw new SquareError('Square answered a payment link that is not https')
    await d.db
      .updateTable('payment_links')
      .set({
        url,
        square_payment_link_id: link.id,
        square_order_id: link.order_id ?? order?.id ?? null,
        square_version: link.version,
      })
      .where('id', '=', rowId)
      .execute()
    return {
      rowId,
      invoiceId: inv.id,
      purpose: i.purpose,
      expectedCents: expected,
      url,
      squareLinkId: link.id,
      squareOrderId: link.order_id ?? order?.id ?? null,
      invoiceVersion: inv.version,
    }
  } catch (e) {
    d.logger?.warn({ square: { invoiceId: inv.id, purpose: i.purpose }, err: maskText(String(e)).slice(0, 200) }, 'square payment link not created')
    // a planned row that never reached Square is dropped at once (a booking's request stays pending for the next try)
    if (!i.rowId && !(e instanceof SquareNetworkError && e.sent))
      await d.db
        .updateTable('payment_links')
        .set({ state: 'canceled', canceled_at: d.clock.now(), cancel_reason: 'square_error' })
        .where('id', '=', rowId)
        .where('state', '=', 'pending')
        .execute()
    if (e instanceof AppError) throw e
    if (e instanceof SquareError || e instanceof LinkSumError) throw squareProblem(e)
    throw e
  }
}

/**
 * Makes a prepared link live in the caller's transaction, once the invoice (locked) still owes exactly its amount; supersedes the
 * older active links of the same purpose (the sweep deletes them at Square). A changed amount answers CONCURRENT_UPDATE and leaves
 * the pending row to the sweep.
 */
export async function activateSquareLink(
  tx: Tx,
  d: { locationId: string; clock: Clock },
  p: PreparedSquareLink,
): Promise<{ id: string; url: string; expectedCents: number }> {
  await lockInvoice(tx, d.locationId, p.invoiceId)
  await assertNoChargeWaiting(tx, p.invoiceId)
  const row = await tx.selectFrom('payment_links').selectAll().where('id', '=', p.rowId).forUpdate().executeTakeFirst()
  if (!row || row.state !== 'pending') {
    if (row?.state === 'active' && row.url) return { id: row.id, url: row.url, expectedCents: row.expected_cents }
    throw new AppError('CONCURRENT_UPDATE')
  }
  const owed = p.purpose === 'deposit' ? await depositOwed(tx, p.invoiceId, p.expectedCents) : (await calcOf(tx, p.invoiceId)).balance
  if (owed !== p.expectedCents) throw new AppError('CONCURRENT_UPDATE')
  const now = d.clock.now()
  await tx
    .updateTable('payment_links')
    .set({ state: 'canceled', canceled_at: now, cancel_reason: 'superseded' })
    .where('invoice_id', '=', p.invoiceId)
    .where('provider', '=', 'square')
    .where('purpose', '=', p.purpose)
    .where('state', '=', 'active')
    .where('id', '<>', p.rowId)
    .execute()
  await tx
    .updateTable('payment_links')
    .set({ state: 'active', url: p.url, expires_at: new Date(now.getTime() + LINK_MAX_AGE_MS) })
    .where('id', '=', p.rowId)
    .execute()
  return { id: p.rowId, url: p.url, expectedCents: p.expectedCents }
}

/** An active Square link of the invoice for exactly the amount owed now (the pay page reuses it instead of making another). */
export async function reusableLink(tx: Executor, invoiceId: string, purpose: LinkPurpose, owedCents: number): Promise<{ id: string; url: string } | null> {
  const row = await tx
    .selectFrom('payment_links')
    .select(['id', 'url', 'expected_cents'])
    .where('invoice_id', '=', invoiceId)
    .where('provider', '=', 'square')
    .where('purpose', '=', purpose)
    .where('state', '=', 'active')
    .orderBy('created_at', 'desc')
    .executeTakeFirst()
  return row && row.url && row.expected_cents === owedCents && owedCents > 0 ? { id: row.id, url: row.url } : null
}

export interface SweepReport {
  canceled: number
  deleted: number
  failed: number
  skipped?: string
}

/** Why an active link should stop taking money now, or null. Pure. */
export function staleReason(
  l: { purpose: LinkPurpose; expectedCents: number; createdAt: Date },
  s: { canceled: boolean; balanceCents: number; depositPaid: boolean },
  now: Date,
): { reason: PaymentLinkCancelReason; state: 'canceled' | 'expired' } | null {
  if (s.canceled) return { reason: 'invoice_canceled', state: 'canceled' }
  if (l.purpose === 'balance') {
    if (s.balanceCents === 0) return { reason: 'paid_elsewhere', state: 'canceled' }
    if (s.balanceCents !== l.expectedCents) return { reason: 'amount_changed', state: 'canceled' }
  } else {
    if (s.depositPaid) return { reason: 'deposit_paid', state: 'canceled' }
    if (s.balanceCents < l.expectedCents) return { reason: 'amount_changed', state: 'canceled' }
  }
  if (now.getTime() - l.createdAt.getTime() > LINK_MAX_AGE_MS) return { reason: 'expired', state: 'expired' }
  return null
}

/**
 * square.links.sweep: cancels what no longer matches, gives up on pending rows, deletes canceled links at Square. Idempotent: a
 * second run finds nothing to change. Deleting at Square needs writes (observe-only leaves the canceled rows for later).
 */
export async function sweepSquareLinks(d: SquareLinkDeps & { locationId: string }): Promise<SweepReport> {
  const now = d.clock.now()
  const r: SweepReport = { canceled: 0, deleted: 0, failed: 0 }
  const active = await d.db
    .selectFrom('payment_links')
    .select(['id', 'invoice_id', 'purpose', 'expected_cents', 'created_at'])
    .where('location_id', '=', d.locationId)
    .where('provider', '=', 'square')
    .where('state', '=', 'active')
    .execute()
  for (const l of active) {
    const changed = await transaction(d.db, async (tx) => {
      const inv = await lockInvoice(tx, d.locationId, l.invoice_id)
      const row = await tx.selectFrom('payment_links').select('state').where('id', '=', l.id).forUpdate().executeTakeFirst()
      if (row?.state !== 'active') return false
      const calc = await calcOf(tx, l.invoice_id)
      const depositPaid = l.purpose === 'deposit' && (await depositPay(tx, l.invoice_id))
      const why = staleReason(
        { purpose: l.purpose, expectedCents: l.expected_cents, createdAt: l.created_at },
        { canceled: inv.canceled_at !== null, balanceCents: calc.balance, depositPaid },
        now,
      )
      if (!why) return false
      await tx.updateTable('payment_links').set({ state: why.state, canceled_at: now, cancel_reason: why.reason }).where('id', '=', l.id).execute()
      return true
    })
    if (changed) r.canceled++
  }
  // pending rows nobody activated (the command failed after the Square call), and old deposit requests
  const gaveUp = await d.db
    .updateTable('payment_links')
    .set({ state: 'canceled', canceled_at: now, cancel_reason: 'stale' })
    .where('location_id', '=', d.locationId)
    .where('provider', '=', 'square')
    .where('state', '=', 'pending')
    .where((eb) =>
      eb.or([
        eb.and([eb('origin', '<>', 'booking'), eb('created_at', '<', new Date(now.getTime() - PENDING_GIVE_UP_MS))]),
        eb.and([eb('origin', '=', 'booking'), eb('created_at', '<', new Date(now.getTime() - DEPOSIT_REQUEST_MAX_AGE_MS))]),
      ]),
    )
    .executeTakeFirst()
  r.canceled += Number(gaveUp.numUpdatedRows ?? 0)
  if (!squareWritesOn(d.env)) return { ...r, skipped: 'SQUARE_WRITES_ENABLED=false: canceled links are deleted at Square once writes are on' }
  const toDelete = await d.db
    .selectFrom('payment_links')
    .select(['id', 'square_payment_link_id'])
    .where('location_id', '=', d.locationId)
    .where('provider', '=', 'square')
    .where('state', 'in', ['canceled', 'expired'])
    .where('square_payment_link_id', 'is not', null)
    .where('square_deleted_at', 'is', null)
    .limit(50)
    .execute()
  for (const l of toDelete) {
    try {
      await d.api.checkout.deleteLink(l.square_payment_link_id!)
      await d.db.updateTable('payment_links').set({ square_deleted_at: d.clock.now() }).where('id', '=', l.id).execute()
      r.deleted++
    } catch (e) {
      r.failed++
      d.logger?.warn({ square: { paymentLink: l.square_payment_link_id }, err: maskText(String(e)).slice(0, 200) }, 'square payment link not deleted (next sweep tries again)')
    }
  }
  return r
}

async function depositPay(tx: Executor, invoiceId: string): Promise<boolean> {
  const row = await tx
    .selectFrom('ledger_events as e')
    .select('e.id')
    .where('e.invoice_id', '=', invoiceId)
    .where('e.type', '=', 'pay')
    .where('e.deposit', '=', true)
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('ledger_events as v').select('v.id').whereRef('v.voids_event_id', '=', 'e.id'))))
    .executeTakeFirst()
  return !!row
}
