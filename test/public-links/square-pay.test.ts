// The personal-link pages with Square as the processor (ADR 0171 D3, design 3.2 and 3.5): the pay page makes (or reuses) a Square
// link for exactly the balance at click time, in two transactions around the Square call; a changed balance gets a new link; Square
// watch-only falls back to the page's usual answer; a calendar page's "Pay the deposit now" opens the booking's quick-pay link once it
// is owed, and says it is paid afterwards.
import { sql } from 'kysely'
import { afterEach, describe, expect, it } from 'vitest'
import { loadEnv } from '../../src/config/env.js'
import { paymentFacts } from '../../src/modules/square/facts.js'
import { decideSquarePayment, lockPayment } from '../../src/modules/square/payments.js'
import { configureSquareRuntime } from '../../src/modules/square/runtime.js'
import { transaction } from '../../src/platform/db.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { coreVars } from '../square-db/core.js'
import { simFor } from '../square-db/helpers.js'
import { json, TODAY, useLinksHarness } from './harness.js'

const h = useLinksHarness()
afterEach(() => configureSquareRuntime({}))

function square(vars: Record<string, string> = {}) {
  const sim = simFor(h.clock)
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl(), ...coreVars, ...vars })
  configureSquareRuntime({ env, api: () => sim.api })
  return { sim, env }
}

async function bookOnCalendar(startMin = 13 * 60) {
  const id = await h.customer()
  await h.trust(id)
  const cal = await h.page({ customerId: id })
  const booked = await h.call('POST', 'bookings', { session: cal.session, key: h.nextKey(), body: { serviceKey: h.key('Express Hand Wash'), addonKeys: [], date: TODAY, startMin } })
  expect(booked.statusCode, booked.body).toBe(201)
  const invoice = await h.db.selectFrom('invoices').select(['id', 'invoice_no']).where('customer_id', '=', id).executeTakeFirstOrThrow()
  return { id, cal, booked: json(booked), invoice }
}

const squareLinks = (invoiceId: string) =>
  h.db.selectFrom('payment_links').select(['state', 'origin', 'expected_cents', 'url', 'purpose', 'cancel_reason']).where('invoice_id', '=', invoiceId).where('provider', '=', 'square').orderBy('created_at').execute()

describe('POST pay/start with Square', () => {
  it('makes a Square link for exactly the balance, reuses it while it matches, makes another once the balance changes', async () => {
    const s = square()
    const { id, invoice } = await bookOnCalendar()
    const page = await h.page({ customerId: id, kind: 'pay', invoiceId: invoice.id })
    await h.verifyByCode(page.session)
    const r = await h.call('POST', 'pay/start', { session: page.session, body: {} })
    expect(r.statusCode, r.body).toBe(200)
    const first = json(r)
    expect(first.status).toBe('redirect')
    expect(new URL(first.redirectUrl).hostname).toBe('sandbox.square.link')
    const balance = Number((await sql<{ balance: string }>`select balance from invoice_calc_of(${invoice.id}::uuid)`.execute(h.db)).rows[0]!.balance)
    expect(await squareLinks(invoice.id)).toEqual([{ state: 'active', origin: 'pay_page', expected_cents: balance, url: first.redirectUrl, purpose: 'balance', cancel_reason: null }])
    const again = json(await h.call('POST', 'pay/start', { session: page.session, body: {} }))
    expect(again).toEqual(first)
    expect(s.sim.store.links.size).toBe(1)
    expect((await h.db.selectFrom('client_links').select('uses').where('id', '=', page.link.id).executeTakeFirstOrThrow()).uses).toBe(2)
    // part of it paid at the counter: the next click gets a link for what is left
    await h.db.transaction().execute(async (tx) => {
      const inv = await tx.selectFrom('invoices').select(['customer_id']).where('id', '=', invoice.id).executeTakeFirstOrThrow()
      await tx.insertInto('ledger_events').values({ id: h.newId(), location_id: h.locationId, invoice_id: invoice.id, customer_id: inv.customer_id, type: 'pay', amount_cents: 1000, method: 'Cash', method_kind: 'cash', actor_name: 'Desk', occurred_at: h.clock.now() }).execute()
    })
    const third = json(await h.call('POST', 'pay/start', { session: page.session, body: {} }))
    expect(third.redirectUrl).not.toBe(first.redirectUrl)
    expect((await squareLinks(invoice.id)).map((l) => [l.state, l.expected_cents, l.cancel_reason]).sort()).toEqual([
      ['active', balance - 1000, null],
      ['canceled', balance, 'superseded'],
    ])
  })

  it('Square watch-only: the page’s usual answer (link_pending, the managers asked once)', async () => {
    square({ SQUARE_WRITES_ENABLED: 'false' })
    const { id, invoice } = await bookOnCalendar()
    const page = await h.page({ customerId: id, kind: 'pay', invoiceId: invoice.id })
    await h.verifyByCode(page.session)
    expect(json(await h.call('POST', 'pay/start', { session: page.session, body: {} }))).toEqual({ status: 'link_pending', redirectUrl: null })
    expect(await h.db.selectFrom('notifications').select('kind').where('kind', '=', 'payments.link_requested').execute()).not.toEqual([])
    expect(await squareLinks(invoice.id)).toEqual([])
  })

  it('still needs a fresh PIN or code', async () => {
    square()
    const { id, invoice } = await bookOnCalendar()
    const page = await h.page({ customerId: id, kind: 'pay', invoiceId: invoice.id })
    expect(json(await h.call('POST', 'pay/start', { session: page.session, body: {} }))).toMatchObject({ status: 403, code: 'IDENTITY_STEP_UP_REQUIRED' })
    expect(await squareLinks(invoice.id)).toEqual([])
  })
})

describe('POST deposit/start (calendar page, Square)', () => {
  it('opens the booking’s quick-pay link for the deposit, reuses it, and says paid once it is paid', async () => {
    const s = square()
    await sql`insert into settings (location_id, key, value) values (${h.locationId}, 'booking.guest_fee', ${JSON.stringify({ cents: 2500, collect: 'link' })}::jsonb)
      on conflict (location_id, key) do update set value = excluded.value`.execute(h.db)
    const { cal, booked, invoice } = await bookOnCalendar()
    expect(booked.deposit).toEqual({ dueCents: 2500, how: 'link' })
    expect(await squareLinks(invoice.id)).toEqual([{ state: 'pending', origin: 'booking', expected_cents: 2500, url: null, purpose: 'deposit', cancel_reason: null }])
    const r = await h.call('POST', 'deposit/start', { session: cal.session, body: { bookingRef: booked.bookingRef } })
    expect(r.statusCode, r.body).toBe(200)
    const out = json(r)
    expect(out).toMatchObject({ status: 'redirect', amountCents: 2500 })
    expect(json(await h.call('POST', 'deposit/start', { session: cal.session, body: { bookingRef: booked.bookingRef } }))).toEqual(out)
    expect(s.sim.store.links.size).toBe(1)
    const row = await h.db.selectFrom('payment_links').select('square_payment_link_id').where('invoice_id', '=', invoice.id).executeTakeFirstOrThrow()
    const paid = s.sim.store.payLink(row.square_payment_link_id!)
    await transaction(h.db, async (tx) => {
      await lockPayment(tx, String(paid.id))
      await decideSquarePayment(tx, { locationId: h.locationId, clock: h.clock, newId: h.newId, env: s.env }, paymentFacts(await s.sim.api.payments.get(String(paid.id))))
    })
    expect(json(await h.call('POST', 'deposit/start', { session: cal.session, body: { bookingRef: booked.bookingRef } }))).toEqual({ status: 'paid', redirectUrl: null, amountCents: 2500 })
    const dep = await h.db.selectFrom('ledger_events').select(['amount_cents', 'deposit']).where('invoice_id', '=', invoice.id).where('type', '=', 'pay').execute()
    expect(dep).toEqual([{ amount_cents: 2500, deposit: true }])
    // a calendar link's bookings are not used up by paying
    expect((await h.db.selectFrom('client_links').select('uses').where('id', '=', cal.link.id).executeTakeFirstOrThrow()).uses).toBe(1)
    expect(json(await h.call('POST', 'deposit/start', { session: cal.session, body: { bookingRef: 'OAS-99999' } }))).toMatchObject({ status: 404 })
  })

  it('a visit whose booking asked for no deposit link answers none', async () => {
    square()
    const { cal, booked } = await bookOnCalendar()
    expect(json(await h.call('POST', 'deposit/start', { session: cal.session, body: { bookingRef: booked.bookingRef } }))).toEqual({ status: 'none', redirectUrl: null, amountCents: 0 })
  })
})
