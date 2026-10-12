// The personal link pages with Square as the processor (ADR 0171 D3, design 3.2 and 3.5):
//   pay/start      a payment page (fresh PIN or code, the page's own client): an active Square link for exactly the balance is reused,
//                  else one is made now. Two transactions around the Square call: the first checks the page and the invoice (and
//                  reuses), the Square call runs on the pool, the second checks again, makes the link live, uses one completion of the
//                  page and audits. Square down or watch-only: the page's usual answer {status: link_pending} (the managers are asked
//                  once to text a link).
//   deposit/start  a verified calendar page's "Pay $25 deposit now" for one of its client's upcoming visits whose booking asked for
//                  a deposit link: the same two-step, for the deposit.
import type { FastifyRequest } from 'fastify'
import * as audit from '../../platform/audit.js'
import { transaction, type Db, type Executor, type Tx } from '../../platform/db.js'
import { AppError } from '../../platform/errors.js'
import type { NewId } from '../../platform/ids.js'
import type { Clock } from '../../platform/clock.js'
import { consumeLink } from '../identity/links.js'
import type { SessionView } from '../identity/sessions.js'
import { calcOf } from '../payments/repository.js'
import {
  linkAudit,
  linkLocation,
  payHostAllowed,
  payPageInvoice,
  requireKind,
  requireVerified,
  startPayment,
  type LinkDeps,
  type LinkRequest,
  type PayStartResult,
} from '../public/links/service.js'
import { activateSquareLink, depositOwed, prepareSquareLink, reusableLink, type PreparedSquareLink } from './links.js'
import { squareApi, squareEnv } from './runtime.js'

type SessionOf = (db: Executor, o: { forUpdate?: boolean }) => Promise<SessionView>

interface Ctx {
  db: Db
  clock: Clock
  newId: NewId
}

const ctxOf = (d: LinkDeps): Ctx => ({ db: d.app.db, clock: d.app.clock, newId: d.app.newId })

async function prepare(c: Ctx, i: Parameters<typeof prepareSquareLink>[1], log?: FastifyRequest['log']): Promise<PreparedSquareLink | null> {
  const env = squareEnv()
  try {
    return await prepareSquareLink({ db: c.db, clock: c.clock, newId: c.newId, env, api: squareApi(env), logger: log }, i)
  } catch (e) {
    if (e instanceof AppError && (e.code === 'SQUARE_UNAVAILABLE' || e.code === 'SQUARE_WRITES_OFF')) return null
    throw e
  }
}

/** The redirect to a Square link: its host checked like any payment URL; a pay page uses one completion (a calendar page none). */
async function redirectTo(tx: Tx, d: LinkDeps, s: SessionView, r: LinkRequest, invoiceId: string, url: string, action: string): Promise<PayStartResult> {
  if (!payHostAllowed(url, d.linkHosts)) throw new AppError('SQUARE_UNAVAILABLE', { detail: 'The payment link is not on an allowed host' })
  const now = d.app.clock.now()
  if (s.link.kind === 'pay') await consumeLink(tx, s.link.id, now)
  await audit.record(tx, {
    locationId: s.link.locationId,
    action,
    entityType: 'invoice',
    entityId: invoiceId,
    after: { linkId: s.link.id, host: new URL(url).hostname, processor: 'square' },
    ctx: linkAudit(r),
  })
  return { status: 'redirect', redirectUrl: url }
}

/** POST pay/start with Square (PAYMENT_PROCESSOR=square). */
export async function startSquarePayment(d: LinkDeps, sessionOf: SessionOf, r: LinkRequest, log?: FastifyRequest['log']): Promise<PayStartResult> {
  const c = ctxOf(d)
  const first = await transaction(c.db, async (tx) => {
    const s = await sessionOf(tx, { forUpdate: true })
    const { loc, inv } = await payPageInvoice(tx, d, s)
    const calc = await calcOf(tx, inv.id)
    if (calc.balance <= 0) throw new AppError('PAY_NOTHING_TO_COLLECT')
    const reuse = await reusableLink(tx, inv.id, 'balance', calc.balance)
    if (reuse) return { kind: 'done' as const, done: await redirectTo(tx, d, s, r, inv.id, reuse.url, 'identity.link.pay_redirect') }
    return { kind: 'make' as const, loc, invoiceId: inv.id }
  })
  if (first.kind === 'done') return first.done
  const prepared = await prepare(c, { locationId: first.loc.id, invoiceId: first.invoiceId, purpose: 'balance', origin: 'pay_page' }, log)
  // Square down or watch-only: the page's usual answer (the managers are asked once to text a link)
  if (!prepared) return transaction(c.db, async (tx) => startPayment(tx, d, await sessionOf(tx, { forUpdate: true }), r))
  return transaction(c.db, async (tx) => {
    const s = await sessionOf(tx, { forUpdate: true })
    const { inv } = await payPageInvoice(tx, d, s)
    if (inv.id !== prepared.invoiceId) throw new AppError('LINK_WRONG_PURPOSE')
    const link = await activateSquareLink(tx, { locationId: s.link.locationId, clock: c.clock }, prepared)
    return redirectTo(tx, d, s, r, inv.id, link.url, 'identity.link.pay_redirect')
  })
}

const REF = /^OAS-(\d{1,9})$/

export interface DepositStartResult {
  status: 'redirect' | 'paid' | 'none' | 'link_pending'
  redirectUrl: string | null
  amountCents: number
}

/** The verified calendar page's own upcoming visit by booking reference, and its deposit request. */
async function depositOf(tx: Tx, d: LinkDeps, s: SessionView, bookingRef: string) {
  requireKind(s, ['calendar', 'book_again'])
  requireVerified(s)
  if (!s.customerId) throw new AppError('LINK_WRONG_PURPOSE')
  const m = REF.exec(bookingRef.trim().toUpperCase())
  if (!m) throw new AppError('NOT_FOUND', { detail: 'That booking does not exist' })
  const loc = await linkLocation(tx, s.link.locationId)
  const a = await tx
    .selectFrom('appointments')
    .select(['id', 'customer_id', 'status'])
    .where('location_id', '=', loc.id)
    .where('seq', '=', Number(m[1]))
    .executeTakeFirst()
  if (!a || a.customer_id !== s.customerId) throw new AppError('NOT_FOUND', { detail: 'That booking does not exist' })
  const inv = await tx.selectFrom('invoices').select(['id', 'canceled_at']).where('appointment_id', '=', a.id).executeTakeFirst()
  if (!inv || inv.canceled_at || !['booked', 'confirmed'].includes(a.status)) return { loc, inv: null, request: null }
  const request = await tx
    .selectFrom('payment_links')
    .select(['id', 'state', 'expected_cents', 'url'])
    .where('invoice_id', '=', inv.id)
    .where('provider', '=', 'square')
    .where('purpose', '=', 'deposit')
    .where('state', 'in', ['pending', 'active', 'paid'])
    .orderBy('created_at', 'desc')
    .executeTakeFirst()
  return { loc, inv, request: request ?? null }
}

/** POST deposit/start: "Pay the deposit now" on a verified calendar page (PAYMENT_PROCESSOR=square, the booking asked for a link). */
export async function startSquareDeposit(
  d: LinkDeps,
  sessionOf: SessionOf,
  r: LinkRequest,
  bookingRef: string,
  log?: FastifyRequest['log'],
): Promise<DepositStartResult> {
  const c = ctxOf(d)
  const first = await transaction(c.db, async (tx) => {
    const s = await sessionOf(tx, { forUpdate: true })
    const { loc, inv, request } = await depositOf(tx, d, s, bookingRef)
    const done = (x: DepositStartResult) => ({ kind: 'done' as const, done: x })
    if (!inv || !request) return done({ status: 'none', redirectUrl: null, amountCents: 0 })
    const owed = request.state === 'paid' ? 0 : await depositOwed(tx, inv.id, request.expected_cents)
    if (owed === 0) return done({ status: 'paid', redirectUrl: null, amountCents: request.expected_cents })
    const reuse = await reusableLink(tx, inv.id, 'deposit', owed)
    if (reuse) {
      const out = await redirectTo(tx, d, s, r, inv.id, reuse.url, 'identity.link.deposit_redirect')
      return done({ status: 'redirect', redirectUrl: out.redirectUrl, amountCents: owed })
    }
    return { kind: 'make' as const, loc, invoiceId: inv.id, rowId: request.state === 'pending' ? request.id : undefined, owed }
  })
  if (first.kind === 'done') return first.done
  const prepared = await prepare(
    c,
    { locationId: first.loc.id, invoiceId: first.invoiceId, purpose: 'deposit', amountCents: first.owed, origin: 'deposit_page', ...(first.rowId ? { rowId: first.rowId } : {}) },
    log,
  )
  if (!prepared) return { status: 'link_pending', redirectUrl: null, amountCents: first.owed }
  return transaction(c.db, async (tx) => {
    const s = await sessionOf(tx, { forUpdate: true })
    const { inv } = await depositOf(tx, d, s, bookingRef)
    if (!inv || inv.id !== prepared.invoiceId) throw new AppError('CONCURRENT_UPDATE')
    const link = await activateSquareLink(tx, { locationId: s.link.locationId, clock: c.clock }, prepared)
    const out = await redirectTo(tx, d, s, r, inv.id, link.url, 'identity.link.deposit_redirect')
    return { status: 'redirect', redirectUrl: out.redirectUrl, amountCents: prepared.expectedCents }
  })
}
