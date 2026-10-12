// Square payment links and the "Square payments to match" queue over HTTP, with the real routes and roles (ADR 0171 D3, D6; design
// 2.5, 3.1 to 3.4): Send link makes a Square link for the exact balance (its lines, tax and tip) or texts the personal pay page, a
// deposit is a quick-pay link, older links are superseded and deleted at Square, a link paid with a tip is recorded with it, the sweep
// cancels a link once the invoice changes, a stale amount is refused, observe-only refuses and writes nothing at Square; the queue's
// apply, ignore and reassign with their permissions.
import { describe, expect, it } from 'vitest'
import { loadEnv } from '../../src/config/env.js'
import { SquareNetworkError } from '../../src/integrations/square/errors.js'
import type { SquareApi } from '../../src/integrations/ports/square.js'
import { devOutbox } from '../../src/modules/payments/ports.js'
import { activateSquareLink, prepareSquareLink, sweepSquareLinks } from '../../src/modules/square/links.js'
import { paymentFacts } from '../../src/modules/square/facts.js'
import { decideSquarePayment, lockPayment } from '../../src/modules/square/payments.js'
import { configureSquareRuntime } from '../../src/modules/square/runtime.js'
import { transaction } from '../../src/platform/db.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import type { FixedClock } from '../../src/platform/clock.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { addEvent, makeInvoice } from '../payments/helpers.js'
import { usePayHarness } from '../payments/http.js'
import { coreVars, silent, useCoreRuntime } from './core.js'
import { simFor } from './helpers.js'

const p = usePayHarness()
useCoreRuntime()
const PEPPER = '5c1b7e0a9f3d2c6b8a4e1f07d9c2b5a3e6f1d8c4b7a2e9f0c3d6b1a8e5f2c7d4'

function square(vars: Record<string, string> = {}, api?: (s: SquareApi) => SquareApi) {
  const clock = p.h.t.clock as FixedClock
  const sim = simFor(clock)
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl(), ...coreVars, ...vars })
  configureSquareRuntime({ env, api: () => (api ? api(sim.api) : sim.api) })
  const newId = createIdGenerator(clock)
  const deps = { db: p.h.t.db, clock, newId, env, api: sim.api, logger: silent }
  const decide = (paymentId: string) =>
    transaction(p.h.t.db, async (tx) => {
      await lockPayment(tx, paymentId)
      return decideSquarePayment(tx, { locationId: p.env().locationId, clock, newId, env }, paymentFacts(await sim.api.payments.get(paymentId)), { force: true })
    })
  const sweep = () => sweepSquareLinks({ ...deps, locationId: p.env().locationId })
  const links = (invoiceId: string) => p.h.t.db.selectFrom('payment_links').selectAll().where('invoice_id', '=', invoiceId).orderBy('created_at').execute()
  return { sim, env, clock, deps, decide, sweep, links }
}

type LinkBody = { paymentLink: { id: string; url: string | null; expectedCents: number; purpose: string; sms: string; provider: string }; invoice: { calc: { balance: number } } }

describe('Square payment links', () => {
  it('Send link (personal links off): a Square link for exactly the balance, its lines plus a Sales tax line, texted', async () => {
    const s = square()
    const { rafael } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env())
    const res = await p.send(rafael, 'POST', `invoices/${inv.id}/payment-links`, { kind: 'balance' })
    expect(res.statusCode, res.body).toBe(201)
    const b = p.json<LinkBody>(res)
    expect(b.paymentLink).toMatchObject({ provider: 'square', purpose: 'balance', expectedCents: 16478, sms: 'queued' })
    expect(new URL(b.paymentLink.url!).hostname).toBe('sandbox.square.link')
    const [row] = await s.links(inv.id)
    expect(row).toMatchObject({ provider: 'square', kind: 'square_order', state: 'active', origin: 'staff', expected_cents: 16478, url: b.paymentLink.url })
    const order = s.sim.store.orders.get(row!.square_order_id!)!
    const lines = (order.line_items as Array<{ name: string; base_price_money: { amount: number } }>).map((l) => [l.name, l.base_price_money.amount])
    expect(lines).toEqual([
      ['Premium Hand Wash + Interior', 12900],
      ['Rain repellent', 2500],
      ['Sales tax', 1078],
    ])
    expect((order.total_money as { amount: number }).amount).toBe(16478)
    expect(devOutbox.sms.map((m) => [m.klass, m.body.includes(b.paymentLink.url!)])).toEqual([['payment_link', true]])
    // a second Send link supersedes the first, and the sweep deletes it at Square
    const again = p.json<LinkBody>(await p.send(rafael, 'POST', `invoices/${inv.id}/payment-links`, { kind: 'balance' }))
    const rows = await s.links(inv.id)
    const old = rows.find((l) => l.url === b.paymentLink.url)!
    expect(old).toMatchObject({ state: 'canceled', cancel_reason: 'superseded' })
    expect(rows.find((l) => l.url === again.paymentLink.url)).toMatchObject({ state: 'active', cancel_reason: null })
    expect(again.paymentLink.url).not.toBe(b.paymentLink.url)
    expect(await s.sweep()).toMatchObject({ deleted: 1 })
    expect(s.sim.store.links.has(old.square_payment_link_id!)).toBe(false)
    expect((await s.links(inv.id)).find((l) => l.id === old.id)!.square_deleted_at).not.toBeNull()
    expect(await s.sweep()).toEqual({ canceled: 0, deleted: 0, failed: 0 })
  })

  it('a deposit is a quick-pay link; collect by payment link works the same way', async () => {
    const s = square()
    const { sofia } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env())
    const dep = p.json<LinkBody>(await p.send(sofia, 'POST', `invoices/${inv.id}/payment-links`, { kind: 'deposit', amountCents: 2500 }))
    expect(dep.paymentLink).toMatchObject({ provider: 'square', purpose: 'deposit', expectedCents: 2500 })
    const [row] = await s.links(inv.id)
    expect(row).toMatchObject({ kind: 'square_quick_pay', purpose: 'deposit' })
    const order = s.sim.store.orders.get(row!.square_order_id!)!
    expect((order.line_items as Array<{ name: string }>)[0]!.name).toBe(`Booking deposit · INV-${inv.no}`)
    const col = await p.send(sofia, 'POST', `invoices/${inv.id}/payments`, { method: 'payment_link', url: 'https://ignored.example/pay' })
    expect(col.statusCode, col.body).toBe(201)
    expect(p.json<LinkBody>(col).paymentLink).toMatchObject({ provider: 'square', purpose: 'balance', expectedCents: 16478 })
  })

  it('with personal links on, Send link texts the client’s own pay page (the link masked), and makes nothing at Square', async () => {
    const s = square({ PUBLIC_LINKS_ENABLED: 'true', PIN_PEPPER: PEPPER, PUBLIC_SITE_URL: 'https://site.example.test' })
    const { rafael } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env())
    const b = p.json<LinkBody>(await p.send(rafael, 'POST', `invoices/${inv.id}/payment-links`, { kind: 'balance' }))
    expect(b.paymentLink).toMatchObject({ provider: 'personal', url: null, sms: 'queued', expectedCents: 16478 })
    const link = await p.h.t.db.selectFrom('client_links').selectAll().executeTakeFirstOrThrow()
    expect(link).toMatchObject({ kind: 'pay', issued_by: 'staff', invoice_id: inv.id, customer_id: inv.customerId })
    const [sms] = devOutbox.sms
    expect(sms).toMatchObject({ klass: 'payment_link', template: { key: 'payment_link_personal', vars: { invoice: `INV-${inv.no}` } } })
    expect(sms!.template!.secretVars.link).toMatch(/^https:\/\/site\.example\.test\/#\/p\/[A-Za-z0-9_-]{43}$/)
    expect(sms!.body).not.toContain(sms!.template!.secretVars.link)
    expect(await s.links(inv.id)).toEqual([])
    expect(s.sim.store.links.size).toBe(0)
  })

  it('a link paid with a tip is recorded on its invoice with the tip; the link is paid', async () => {
    const s = square()
    const { rafael } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env())
    await p.send(rafael, 'POST', `invoices/${inv.id}/payment-links`, { kind: 'balance' })
    const [row] = await s.links(inv.id)
    const paid = s.sim.store.payLink(row!.square_payment_link_id!, { tipCents: 300 })
    expect(await s.decide(String(paid.id))).toBe('matched')
    const pays = await p.h.t.db.selectFrom('ledger_events').select(['amount_cents', 'reason', 'processor_order_id', 'deposit']).where('invoice_id', '=', inv.id).orderBy('seq').execute()
    expect(pays).toEqual([
      { amount_cents: 16478, reason: null, processor_order_id: row!.square_order_id, deposit: false },
      { amount_cents: 300, reason: 'Tip', processor_order_id: row!.square_order_id, deposit: false },
    ])
    expect((await s.links(inv.id))[0]).toMatchObject({ state: 'paid', paid_square_payment_id: paid.id })
    const detail = p.json<{ calc: { balance: number; tip: number; status: string }; ledger: Array<{ processor: string; source: string }> }>(await p.get(rafael, `invoices/${inv.id}`))
    expect(detail.calc).toMatchObject({ balance: 0, tip: 300, status: 'paid' })
    expect(detail.ledger.every((e) => e.processor === 'square' && e.source === 'square')).toBe(true)
  })

  it('the sweep cancels a link once the invoice owes another amount, and deletes it at Square', async () => {
    const s = square()
    const { rafael } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env())
    await p.send(rafael, 'POST', `invoices/${inv.id}/payment-links`, { kind: 'balance' })
    expect(await s.sweep()).toEqual({ canceled: 0, deleted: 0, failed: 0 })
    const adj = await p.send(rafael, 'POST', `invoices/${inv.id}/adjustments`, { kind: 'surcharge', unit: '$', value: 500, reason: 'Pet hair surcharge' })
    expect(adj.statusCode, adj.body).toBe(201)
    expect(await s.sweep()).toEqual({ canceled: 1, deleted: 1, failed: 0 })
    const [row] = await s.links(inv.id)
    expect(row).toMatchObject({ state: 'canceled', cancel_reason: 'amount_changed' })
    expect(s.sim.store.links.size).toBe(0)
  })

  it('a balance that changes between the Square call and the command is refused; the planned link is given up and deleted', async () => {
    const s = square()
    const inv = await makeInvoice(p.h.t.db, p.env())
    const prepared = await prepareSquareLink(s.deps, { locationId: p.env().locationId, invoiceId: inv.id, purpose: 'balance', origin: 'staff' })
    await addEvent(p.h.t.db, p.env(), inv, { type: 'pay', amountCents: 1000, method: 'Cash', methodKind: 'cash' })
    await expect(transaction(p.h.t.db, (tx) => activateSquareLink(tx, { locationId: p.env().locationId, clock: s.clock }, prepared))).rejects.toMatchObject({ code: 'CONCURRENT_UPDATE' })
    expect((await s.links(inv.id))[0]).toMatchObject({ state: 'pending' })
    s.clock.advance(11 * 60_000)
    expect(await s.sweep()).toEqual({ canceled: 1, deleted: 1, failed: 0 })
    expect((await s.links(inv.id))[0]).toMatchObject({ state: 'canceled', cancel_reason: 'stale' })
  })

  it('observe-only refuses a Square link and sends nothing; Square down answers 503 and leaves no live link', async () => {
    const off = square({ SQUARE_WRITES_ENABLED: 'false' })
    const { rafael } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env())
    const r = await p.send(rafael, 'POST', `invoices/${inv.id}/payment-links`, { kind: 'balance' })
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ code: 'SQUARE_WRITES_OFF' })
    expect(off.sim.sim.log.filter((x) => x.method !== 'GET')).toEqual([])
    expect(await off.links(inv.id)).toEqual([])
    const down = square({}, (api) => ({
      ...api,
      checkout: {
        ...api.checkout,
        createLink: async () => {
          throw new SquareNetworkError('connect ECONNREFUSED', false)
        },
      },
    }))
    const r2 = await p.send(rafael, 'POST', `invoices/${inv.id}/payment-links`, { kind: 'balance' })
    expect(r2.statusCode).toBe(503)
    expect(r2.json()).toMatchObject({ code: 'SQUARE_UNAVAILABLE' })
    expect((await down.links(inv.id)).map((l) => [l.state, l.cancel_reason])).toEqual([['canceled', 'square_error']])
  })
})

describe('Square payments to match (queue routes)', () => {
  type Item = { paymentId: string; matchState: string; amountCents: number; candidates: Array<{ invoiceId: string; awaitingEventId: string | null }> }

  it('lists what the matcher could not decide; apply records it (or confirms the staff entry), ignore sets it aside; permissions', async () => {
    const s = square()
    const { rafael, sofia, kevin } = p.people()
    const a = await makeInvoice(p.h.t.db, p.env(), { items: [{ name: 'Wash', priceCents: 4000 }] })
    const entry = await addEvent(p.h.t.db, p.env(), a, { type: 'pay', amountCents: 1000, method: 'Card', methodKind: 'card', processorState: 'awaiting_processor' })
    const p1 = s.sim.store.posPayment({ amountCents: 1000, tipCents: 200 })
    s.clock.advance(1000)
    const p2 = s.sim.store.posPayment({ amountCents: 777 })
    // two staff entries would make R3 ambiguous: the second one keeps p1 in the queue
    const b = await makeInvoice(p.h.t.db, p.env(), { items: [{ name: 'Wash', priceCents: 4000 }] })
    await addEvent(p.h.t.db, p.env(), b, { type: 'pay', amountCents: 1000, method: 'Card', methodKind: 'card', processorState: 'awaiting_processor' })
    expect(await s.decide(String(p1.id))).toBe('unmatched')
    expect(await s.decide(String(p2.id))).toBe('unmatched')
    expect((await p.get(kevin, 'payments/square/unmatched')).statusCode).toBe(403)
    const list = p.json<{ items: Item[] }>(await p.get(rafael, 'payments/square/unmatched'))
    expect(list.items.map((i) => [i.paymentId, i.matchState, i.amountCents])).toEqual([
      [p1.id, 'unmatched', 1000],
      [p2.id, 'unmatched', 777],
    ])
    expect(list.items[0]!.candidates.map((c) => c.awaitingEventId).sort()).toHaveLength(2)
    expect((await p.send(kevin, 'POST', `payments/square/${p1.id}/apply`, { invoiceId: a.id, confirmEventId: entry })).statusCode).toBe(403)
    const applied = await p.send(sofia, 'POST', `payments/square/${p1.id}/apply`, { invoiceId: a.id, confirmEventId: entry })
    expect(applied.statusCode, applied.body).toBe(200)
    expect(applied.json()).toMatchObject({ matchState: 'matched', invoiceId: a.id, eventId: entry })
    const e = await p.h.t.db.selectFrom('ledger_events').selectAll().where('id', '=', entry).executeTakeFirstOrThrow()
    expect(e).toMatchObject({ processor_state: 'confirmed', processor_ref: p1.id, processor_confirmed_by: 'Sofia D.' })
    const again = await p.send(sofia, 'POST', `payments/square/${p1.id}/apply`, { invoiceId: b.id })
    expect(again.json()).toMatchObject({ code: 'SQUARE_PAYMENT_DECIDED' })
    const ignored = await p.send(sofia, 'POST', `payments/square/${p2.id}/ignore`, { reason: 'not_oasis_sale', note: 'coffee' })
    expect(ignored.statusCode, ignored.body).toBe(200)
    expect(p.json<{ items: Item[] }>(await p.get(rafael, 'payments/square/unmatched')).items).toEqual([])
    expect((await p.send(sofia, 'POST', 'payments/square/NOPE123/ignore', { reason: 'test' })).json()).toMatchObject({ code: 'SQUARE_PAYMENT_NOT_FOUND' })
    // the reconciliation's Square section
    const rec = p.json<{ square: { paymentsToMatch: unknown[]; failedRefunds: unknown[]; refundsInFlight: number } }>(await p.get(rafael, 'payments/reconciliation'))
    expect(rec.square).toEqual({ paymentsToMatch: [], failedRefunds: [], refundsInFlight: 0 })
  })

  it('reassign (pay.void) moves a matched payment and its tip to the right invoice', async () => {
    const s = square()
    const { amara, kevin } = p.people()
    const a = await makeInvoice(p.h.t.db, p.env(), { items: [{ name: 'Wash', priceCents: 4000 }] })
    const b = await makeInvoice(p.h.t.db, p.env(), { items: [{ name: 'Wash', priceCents: 4000 }] })
    const pay = s.sim.store.posPayment({ amountCents: 4280, tipCents: 400, note: `INV-${a.no}` })
    expect(await s.decide(String(pay.id))).toBe('matched')
    expect((await p.send(kevin, 'POST', `payments/square/${pay.id}/reassign`, { toInvoiceId: b.id })).statusCode).toBe(403)
    const moved = await p.send(amara, 'POST', `payments/square/${pay.id}/reassign`, { toInvoiceId: b.id })
    expect(moved.statusCode, moved.body).toBe(200)
    const calcOf = async (id: string) => p.json<{ calc: { paid: number; tip: number; balance: number } }>(await p.get(amara, `invoices/${id}`)).calc
    expect(await calcOf(a.id)).toMatchObject({ paid: 0, tip: 0, balance: 4280 })
    expect(await calcOf(b.id)).toMatchObject({ paid: 4680, tip: 400, balance: 0 })
    const m = await p.h.t.db.selectFrom('square_payments').selectAll().where('square_payment_id', '=', String(pay.id)).executeTakeFirstOrThrow()
    expect(m).toMatchObject({ invoice_id: b.id, rule: 'reassign', match_state: 'matched' })
  })
})
