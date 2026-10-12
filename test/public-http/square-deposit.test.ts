// The booking deposit by Square link on the website path (ADR 0171 D2, plan decision 4): with the guest fee collected by link and
// Square as the processor, a booking asks for a deposit link in its own transaction (nothing at Square yet), the job square.deposit-link
// makes the quick-pay link and texts it, the payment lands as a deposit toward the visit, and the cancel and no-show settlement keeps
// or refunds it unchanged (a refund to the card goes back through the Square API). Before the cutover nothing of this happens.
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadEnv } from '../../src/config/env.js'
import { devOutbox } from '../../src/modules/payments/ports.js'
import { runDepositLinks } from '../../src/modules/square/deposits.js'
import { paymentFacts } from '../../src/modules/square/facts.js'
import { decideSquarePayment, lockPayment } from '../../src/modules/square/payments.js'
import { runSquareRefunds } from '../../src/modules/square/refunds.js'
import { configureSquareMessenger, configureSquareRuntime } from '../../src/modules/square/runtime.js'
import { createDbDepositSettlement } from '../../src/modules/scheduling/settlement.js'
import { transaction } from '../../src/platform/db.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { makeUser } from '../helpers/factories.js'
import { coreVars, silent } from '../square-db/core.js'
import { simFor } from '../square-db/helpers.js'
import { bookingBody, json, PHONES, usePublicHarness } from './harness.js'

const h = usePublicHarness()
afterEach(() => configureSquareRuntime({}))
// the deposit texts go to the dev outbox (a worker started by an earlier suite may have wired its own messaging)
beforeEach(() => configureSquareMessenger(undefined))

function square(vars: Record<string, string> = {}) {
  const sim = simFor(h.clock)
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl(), ...coreVars, ...vars })
  configureSquareRuntime({ env, api: () => sim.api })
  const deps = { db: h.db, clock: h.clock, newId: h.newId, env, api: sim.api, logger: silent, locationId: h.locationId }
  return { sim, env, deps }
}

const feeByLink = (cents = 1500) =>
  sql`insert into settings (location_id, key, value) values (${h.locationId}, 'booking.guest_fee', ${JSON.stringify({ cents, collect: 'link' })}::jsonb)
    on conflict (location_id, key) do update set value = excluded.value`.execute(h.db)

/** A desk person (a real user: the ledger names them). */
async function desk() {
  const u = await makeUser(h.db, h.newId, { first: 'Desk' })
  return {
    auth: { userId: u.userId, employeeId: u.employeeId, locationId: h.locationId, permissions: new Set(['*']), actorName: 'Desk D.' },
    audit: { actor: { name: 'Desk D.' } },
  }
}

const depositRows = () =>
  h.db.selectFrom('payment_links').select(['id', 'invoice_id', 'state', 'origin', 'expected_cents', 'url', 'square_payment_link_id', 'purpose']).where('purpose', '=', 'deposit').execute()

async function bookedInvoice(phone: string = PHONES.guest, startMin = 13 * 60) {
  const r = await h.post('public/bookings', bookingBody(h, { phone, startMin }))
  expect(r.statusCode, r.body).toBe(201)
  expect(json(r).deposit).toEqual({ dueCents: 1500, how: 'link' })
  const ref = Number(String(json(r).bookingRef).slice(4))
  const a = await h.db.selectFrom('appointments').select('id').where('seq', '=', ref).executeTakeFirstOrThrow()
  const inv = await h.db.selectFrom('invoices').select(['id', 'invoice_no']).where('appointment_id', '=', a.id).executeTakeFirstOrThrow()
  return { appointmentId: a.id, invoiceId: inv.id }
}

describe('the booking deposit by Square link (website)', () => {
  it('before the cutover a booking asks for nothing (staff text a link, as today)', async () => {
    square({ PAYMENT_PROCESSOR: 'squarespace' })
    await feeByLink()
    await bookedInvoice()
    expect(await depositRows()).toEqual([])
  })

  it('the booking asks for a deposit link; the job makes it and texts it; the payment is a deposit the settlement keeps', async () => {
    const s = square()
    await feeByLink()
    devOutbox.clear()
    const b = await bookedInvoice()
    const [req] = await depositRows()
    expect(req).toMatchObject({ invoice_id: b.invoiceId, state: 'pending', origin: 'booking', expected_cents: 1500, url: null, square_payment_link_id: null })
    expect(s.sim.store.links.size).toBe(0)
    expect(await runDepositLinks(s.deps)).toMatchObject({ created: 1, texted: 1, failed: 0 })
    const [live] = await depositRows()
    expect(live).toMatchObject({ state: 'active' })
    expect(devOutbox.sms.find((m) => m.body.includes(live!.url!))).toMatchObject({ klass: 'payment_link' })
    expect(await runDepositLinks(s.deps)).toMatchObject({ created: 0 })
    const paid = s.sim.store.payLink(live!.square_payment_link_id!)
    await transaction(h.db, async (tx) => {
      await lockPayment(tx, String(paid.id))
      await decideSquarePayment(tx, { locationId: h.locationId, clock: h.clock, newId: h.newId, env: s.env }, paymentFacts(await s.sim.api.payments.get(String(paid.id))))
    })
    const pay = await h.db.selectFrom('ledger_events').selectAll().where('invoice_id', '=', b.invoiceId).where('type', '=', 'pay').executeTakeFirstOrThrow()
    expect(pay).toMatchObject({ amount_cents: 1500, deposit: true, processor: 'square', source: 'square' })
    // a no-show: the policy keeps the deposit, exactly as for a deposit taken at the counter
    const settle = createDbDepositSettlement({ clock: h.clock, newId: h.newId })
    const actor = await desk()
    const kept = await transaction(h.db, (tx) =>
      settle.settle(tx, { appointmentId: b.appointmentId, locationId: h.locationId, kind: 'no_show', mode: 'policy', retainBp: 10_000, refundTo: 'original', rule: 'No-show: the deposit is kept', actor, idempotencyKey: 'ns-1' }),
    )
    expect(kept).toMatchObject({ heldCents: 1500, retainedCents: 1500, refundedCents: 0 })
  })

  it('a canceled visit gets its deposit back to the card through the Square API', async () => {
    const s = square()
    await feeByLink()
    const b = await bookedInvoice(PHONES.extra, 14 * 60)
    await runDepositLinks(s.deps)
    const [live] = await depositRows()
    const paid = s.sim.store.payLink(live!.square_payment_link_id!)
    await transaction(h.db, async (tx) => {
      await lockPayment(tx, String(paid.id))
      await decideSquarePayment(tx, { locationId: h.locationId, clock: h.clock, newId: h.newId, env: s.env }, paymentFacts(await s.sim.api.payments.get(String(paid.id))))
    })
    await sql`update invoices set canceled_at = app_now(), cancel_reason = 'canceled' where id = ${b.invoiceId}`.execute(h.db)
    const settle = createDbDepositSettlement({ clock: h.clock, newId: h.newId })
    const actor = await desk()
    const out = await transaction(h.db, (tx) =>
      settle.settle(tx, { appointmentId: b.appointmentId, locationId: h.locationId, kind: 'canceled', mode: 'policy', retainBp: 0, refundTo: 'original', rule: 'Canceled in time: the deposit goes back', actor, idempotencyKey: 'c-1' }),
    )
    expect(out).toMatchObject({ refundedCents: 1500, refunds: [{ dest: 'card', awaitingProcessor: true }] })
    const refund = await h.db.selectFrom('ledger_events').selectAll().where('invoice_id', '=', b.invoiceId).where('type', '=', 'refund').executeTakeFirstOrThrow()
    expect(refund).toMatchObject({ processor: 'square', processor_state: 'awaiting_processor' })
    expect(await runSquareRefunds(s.deps)).toMatchObject({ planned: 1, submitted: 1 })
    const [leg] = await h.db.selectFrom('square_refund_legs').selectAll().where('ledger_event_id', '=', refund.id).execute()
    expect(leg).toMatchObject({ square_payment_id: paid.id, amount_cents: 1500 })
  })

  it('a deposit request of a visit canceled before the link was made is dropped', async () => {
    const s = square()
    await feeByLink()
    const b = await bookedInvoice()
    await sql`update invoices set canceled_at = app_now(), cancel_reason = 'canceled' where id = ${b.invoiceId}`.execute(h.db)
    expect(await runDepositLinks(s.deps)).toMatchObject({ created: 0, dropped: 1 })
    expect((await depositRows())[0]).toMatchObject({ state: 'canceled' })
    expect(s.sim.store.links.size).toBe(0)
  })
})
