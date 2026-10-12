// The backend gaps the dashboard needs before the Square cutover (wave Q3 dashapi; dashboard review Q2c F3, N1): the processor and the
// usable Square tenders on every invoice summary (file, board, command answers) for a role without pay.reports; the tier colours on
// board cards; Square's receipt on the ledger rows of Square payments; the deposit of a visit (asked for by link, sent, paid, kept,
// refunded); the client's saved cards with their consent. The real app (session authorizer, real payments gateway) with the Square
// runtime pointed at the simulator; everything off by default.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../../src/config/env.js'
import { saveCardOnFile } from '../../src/modules/square/cards.js'
import type { CardPurpose } from '../../src/modules/square/consents.js'
import { requestDepositLink } from '../../src/modules/square/deposits.js'
import { configureSquareRuntime } from '../../src/modules/square/runtime.js'
import { transaction } from '../../src/platform/db.js'
import { key } from '../memberships/harness.js'
import { idemKey, recordPayment, useRig } from '../scheduling-gaps/support.js'
import { silent, squareEnvFor } from './core.js'
import { simFor } from './helpers.js'

const PEPPER = '5c1b7e0a9f3d2c6b8a4e1f07d9c2b5a3e6f1d8c4b7a2e9f0c3d6b1a8e5f2c7d4'
const m = useRig({ PUBLIC_LINKS_ENABLED: 'true', PIN_PEPPER: PEPPER })
afterEach(() => configureSquareRuntime({}))

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
type Sim = ReturnType<typeof simFor>

let sim!: Sim
let env!: Env
/** The Square runtime on the test's simulator with these switches (Square the processor and writes on unless overridden). */
function square(vars: Record<string, string> = {}, extra: Partial<Env> = {}): void {
  env = { ...squareEnvFor(vars), ...extra }
  configureSquareRuntime({ env, api: () => sim.api })
}
/** Observe-only with the POS app switch on (set past the environment check: it needs live production Square). */
const observeOnly = () => square({ SQUARE_WRITES_ENABLED: 'false' }, { SQUARE_POS_API_ENABLED: true })
const OFF = { PAYMENT_PROCESSOR: 'squarespace', SQUARE_WRITES_ENABLED: 'false' }
beforeEach(() => {
  sim = simFor(m.h.clock)
  square(OFF)
})

let n = 0
async function saveCard(customerId: string, purposes: CardPurpose[] = ['balance', 'no_show_fee', 'late_cancel_fee']) {
  return saveCardOnFile(
    { db: m.h.t.db, clock: m.h.clock, newId: m.h.t.app.newId, env, api: sim.api, locationId: m.locationId(), logger: silent },
    { customerId, sourceId: 'cnon:card-nonce-ok', purposes, consentVersion: 'v1', ip: '203.0.113.9', userAgent: 'test', keyBase: `gaps-test-${++n}`, postalCode: '07026' },
  )
}

/** A front-desk role: books and collects, never sees payment reports. */
const frontDesk = async () => (await m.h.userWithPermissions(['sched.view', 'sched.edit', 'pay.collect', 'cli.view'], `desk${++n}@example.test`)).session
const fileOf = async (s: Awaited<ReturnType<typeof frontDesk>>, id: string): Promise<Json> => {
  const r = await m.get(s, `/appointments/${id}`)
  expect(r.statusCode, r.body).toBe(200)
  return r.json() as Json
}
const cardOn = (snap: Json, id: string): Json =>
  [...snap.timeline.groups.flatMap((g: Json) => g.items), ...snap.completed.items, ...snap.queue].find((c: Json) => c.id === id)

const NO_TENDERS = { reader: false, link: false, savedCard: null }

describe('the processor and the Square tenders for every role (Q2c F3)', () => {
  it('off by default: Squarespace, no Square tender, on the file, the board and GET /invoices/:id', async () => {
    const desk = await frontDesk()
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    expect((await m.get(desk, `/invoices/${a.invoiceId}`)).statusCode).toBe(403) // no pay.reports
    const file = await fileOf(desk, a.appointmentId)
    expect(file.invoice.processing).toEqual({ processor: 'squarespace', squarePosAppSwitch: false, squareTenders: NO_TENDERS })
    expect(file.overview.pay.processing).toEqual(file.invoice.processing)
    const snap = (await m.get(desk, '/ops/snapshot')).json() as Json
    expect(cardOn(snap, a.appointmentId).pay.processing).toEqual(file.invoice.processing)
    const detail = (await m.get(m.superS(), `/invoices/${a.invoiceId}`)).json() as Json
    expect(detail.processing).toEqual(file.invoice.processing)
  })

  it('Square the processor with writes on: reader, link and the saved card whose consent covers balances', async () => {
    square()
    const desk = await frontDesk()
    const maria = await m.customer('Maria Delgado')
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    // no card yet
    expect((await fileOf(desk, a.appointmentId)).invoice.processing).toEqual({
      processor: 'square',
      squarePosAppSwitch: false,
      squareTenders: { reader: true, link: true, savedCard: null },
    })
    // a card whose consent does not cover balances is no tender
    await saveCard(maria, ['no_show_fee'])
    expect((await fileOf(desk, a.appointmentId)).invoice.processing.squareTenders.savedCard).toBeNull()
    const card = await saveCard(maria, ['balance'])
    const file = await fileOf(desk, a.appointmentId)
    expect(file.invoice.processing.squareTenders).toEqual({
      reader: true,
      link: true,
      savedCard: { cardId: card.cardId, label: 'Visa ••5858', brand: expect.any(String), last4: '5858' },
    })
    const snap = (await m.get(desk, '/ops/snapshot')).json() as Json
    expect(cardOn(snap, a.appointmentId).pay.processing).toEqual(file.invoice.processing)
    const detail = (await m.get(m.superS(), `/invoices/${a.invoiceId}`)).json() as Json
    expect(detail.processing).toEqual(file.invoice.processing)
    // the answer of a command carries it too (an add-on changes the invoice)
    const addon = await m.h.t.db.selectFrom('services').select('id').where('kind', '=', 'addon').where('active', '=', true).orderBy('name').executeTakeFirstOrThrow()
    const add = await m.send(desk, 'PUT', `/appointments/${a.appointmentId}/addons/${addon.id}`, undefined, false)
    expect(add.statusCode, add.body).toBe(200)
    expect((add.json() as Json).invoice.processing).toEqual(file.invoice.processing)
    // an expired card is no tender
    await m.h.t.db.updateTable('customer_cards').set({ exp_month: 5, exp_year: 2026 }).where('id', '=', card.cardId).execute()
    expect((await fileOf(desk, a.appointmentId)).invoice.processing.squareTenders.savedCard).toBeNull()
  })

  it('observe-only (writes off): the reader only; a canceled invoice offers no saved card', async () => {
    observeOnly()
    const desk = await frontDesk()
    const maria = await m.customer('Maria Delgado')
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    square()
    await saveCard(maria)
    observeOnly()
    expect((await fileOf(desk, a.appointmentId)).invoice.processing).toEqual({
      processor: 'square',
      squarePosAppSwitch: true,
      squareTenders: { reader: true, link: false, savedCard: null },
    })
    square()
    expect((await fileOf(desk, a.appointmentId)).invoice.processing.squareTenders.savedCard).not.toBeNull()
    const c = await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/cancel`, { reason: 'Customer called' }, idemKey())
    expect(c.statusCode, c.body).toBe(200)
    expect((c.json() as Json).invoice.processing.squareTenders).toEqual({ reader: true, link: true, savedCard: null })
  })
})

describe('board cards carry the tier colours', () => {
  it('a member’s card has the tier’s color and bgColor, as the file’s membership', async () => {
    const desk = await frontDesk()
    const res = await m.send(m.superS(), 'POST', '/memberships', { customerId: await m.customer('Maria Delgado'), planKey: 'gold', renewsOn: '2026-07-12' }, key())
    expect(res.statusCode, res.body).toBe(201)
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    const file = await fileOf(desk, a.appointmentId)
    expect(file.membership.color).toMatch(/^#/)
    const snap = (await m.get(desk, '/ops/snapshot')).json() as Json
    const card = cardOn(snap, a.appointmentId)
    expect(card.member).toEqual({ plan: file.membership.plan, label: expect.any(String), color: file.membership.color, bgColor: file.membership.bgColor })
    // a guest's card has no member
    const g = await m.book('Liam Chen', 'Express Hand Wash', '2026-06-13T16:00:00-04:00')
    expect(cardOn((await m.get(desk, '/ops/snapshot')).json() as Json, g.appointmentId).member).toBeNull()
  })
})

describe('Square’s receipt on the ledger rows of Square payments', () => {
  it('a balance charged on a saved card shows Square’s receipt number and page; an unsafe page is never shown', async () => {
    square()
    const maria = await m.customer('Maria Delgado')
    const card = await saveCard(maria)
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    const balance = (await m.get(m.superS(), `/invoices/${a.invoiceId}`)).json() as Json
    const r = await m.send(m.superS(), 'POST', `/invoices/${a.invoiceId}/card-charges`, { cardId: card.cardId, amountCents: balance.calc.balance }, idemKey())
    expect(r.statusCode, r.body).toBe(201)
    const mirror = await m.h.t.db.selectFrom('square_payments').select(['square_payment_id', 'receipt_number', 'receipt_url']).executeTakeFirstOrThrow()
    expect(mirror.receipt_number).toBeTruthy()
    const detail = (await m.get(m.superS(), `/invoices/${a.invoiceId}`)).json() as Json
    const pay = detail.ledger.find((e: Json) => e.type === 'pay')
    expect(pay).toMatchObject({ processor: 'square', processorRef: mirror.square_payment_id, receiptNumber: mirror.receipt_number, receiptUrl: mirror.receipt_url })
    expect(pay.receiptUrl).toMatch(/^https:\/\/[a-z.]*squareupsandbox\.com\//)
    // the charge's own answer carries it as well
    expect(((r.json() as Json).invoice.ledger as Json[]).find((e) => e.type === 'pay')).toMatchObject({ receiptNumber: mirror.receipt_number })
    await m.h.t.db.updateTable('square_payments').set({ receipt_url: 'https://squareup.com.evil.example/receipt/x' }).execute()
    const after = (await m.get(m.superS(), `/invoices/${a.invoiceId}`)).json() as Json
    expect(after.ledger.find((e: Json) => e.type === 'pay')).toMatchObject({ receiptNumber: mirror.receipt_number, receiptUrl: null })
  })

  it('cash and Squarespace rows have no receipt', async () => {
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    await recordPayment(m, a.invoiceId, 1000, { kind: 'cash', deposit: false })
    const detail = (await m.get(m.superS(), `/invoices/${a.invoiceId}`)).json() as Json
    expect(detail.ledger.map((e: Json) => [e.receiptNumber, e.receiptUrl])).toEqual([[null, null]])
  })
})

describe('the deposit of a visit on the file (Q2c N1)', () => {
  it('a requested deposit link, then texted, then paid; the visit canceled inside the window keeps it', async () => {
    square()
    const desk = await frontDesk()
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    expect((await fileOf(desk, a.appointmentId)).invoice.deposit).toBeNull()
    const linkId = await transaction(m.h.t.db, (tx) =>
      requestDepositLink(tx, { newId: m.h.t.app.newId, clock: m.h.clock, env }, { locationId: m.locationId(), appointmentId: a.appointmentId, cents: 2500, collect: 'link' }),
    )
    expect(linkId).toBeTruthy()
    let d = (await fileOf(desk, a.appointmentId)).invoice.deposit
    expect(d).toMatchObject({ state: 'requested', requestedCents: 2500, paidCents: 0, keptCents: 0, link: { state: 'pending', sentAt: null } })
    await m.h.t.db
      .updateTable('payment_links')
      .set({ state: 'active', url: 'https://square.link/u/test0001', sent_at: m.h.clock.now(), square_payment_link_id: 'PL1', square_order_id: 'O1' })
      .where('id', '=', linkId!)
      .execute()
    d = (await fileOf(desk, a.appointmentId)).invoice.deposit
    expect(d).toMatchObject({ state: 'link_sent', requestedCents: 2500, link: { state: 'active', sentAt: m.h.clock.now().toISOString() } })
    expect(JSON.stringify(d)).not.toContain('square.link')
    await recordPayment(m, a.invoiceId, 2500, { deposit: true, state: 'confirmed' })
    d = (await fileOf(desk, a.appointmentId)).invoice.deposit
    expect(d).toMatchObject({ state: 'paid', paidCents: 2500, refundedCents: 0 })
    const c = await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/cancel`, { reason: 'Customer called' }, idemKey())
    expect(c.statusCode, c.body).toBe(200)
    expect((c.json() as Json).invoice.deposit).toMatchObject({ state: 'kept', paidCents: 2500, keptCents: 2500, refundedCents: 0, pendingRefundCents: 0 })
    expect((await fileOf(desk, a.appointmentId)).invoice).toMatchObject({ status: 'canceled_kept', refundedCents: 0, deposit: { state: 'kept' } })
  })

  it('canceled ahead of the free window: refunded, the card refund still on its way', async () => {
    const desk = await frontDesk()
    const a = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-15T10:00:00-04:00')
    await recordPayment(m, a.invoiceId, 2500)
    const c = await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/cancel`, { reason: 'Customer called' }, idemKey())
    expect(c.statusCode, c.body).toBe(200)
    const file = await fileOf(desk, a.appointmentId)
    expect(file.invoice).toMatchObject({ status: 'canceled_refunded', refundedCents: 2500 })
    expect(file.invoice.deposit).toMatchObject({ state: 'refunded', paidCents: 2500, refundedCents: 2500, keptCents: 0, refundSending: true, refundFailed: false })
  })
})

describe('the client’s saved cards carry their consent', () => {
  it('GET /customers/:id/cards: the consent version, when it was given and its purposes', async () => {
    square()
    const maria = await m.customer('Maria Delgado')
    const card = await saveCard(maria, ['balance', 'membership_billing'])
    const list = (await m.get(m.superS(), `/customers/${maria}/cards`)).json() as Json
    expect(list.cards[0]).toMatchObject({
      id: card.cardId,
      purposes: ['membership_billing', 'balance'],
      consents: [{ version: 'v1', acceptedAt: m.h.clock.now().toISOString(), purposes: ['membership_billing', 'balance'], revokedAt: null }],
    })
  })
})
