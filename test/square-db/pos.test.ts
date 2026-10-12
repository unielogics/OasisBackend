// The Square POS app switch (ADR 0171, design 2.6): off unless SQUARE_POS_API_ENABLED with live production Square; the intent writes
// the staff card entry and answers the app-switch URLs; the payment is recorded on that entry on strong evidence (rule R2) whether the
// code in its note or the app's callback brings it; an unknown state and an error answer are handled.
import { describe, expect, it } from 'vitest'
import { loadEnv } from '../../src/config/env.js'
import { paymentFacts } from '../../src/modules/square/facts.js'
import { decideSquarePayment, lockPayment } from '../../src/modules/square/payments.js'
import { configureSquareRuntime } from '../../src/modules/square/runtime.js'
import type { FixedClock } from '../../src/platform/clock.js'
import { transaction } from '../../src/platform/db.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { makeInvoice } from '../payments/helpers.js'
import { usePayHarness } from '../payments/http.js'
import { useCoreRuntime } from './core.js'
import { liveEnvVars, simFor } from './helpers.js'

const p = usePayHarness()
useCoreRuntime()

function pos(on = true) {
  const clock = p.h.t.clock as FixedClock
  const sim = simFor(clock)
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: testDatabaseUrl(),
    ...liveEnvVars,
    SQUARE_ENVIRONMENT: 'production',
    SQUARE_POS_API_ENABLED: on ? 'true' : 'false',
    SQUARE_MATCH_DELAY_SECONDS: '0',
    PUBLIC_DASHBOARD_URL: 'https://app.example.test',
  })
  configureSquareRuntime({ env, api: () => sim.api })
  const newId = createIdGenerator(clock)
  const decide = (paymentId: string) =>
    transaction(p.h.t.db, async (tx) => {
      await lockPayment(tx, paymentId)
      return decideSquarePayment(tx, { locationId: p.env().locationId, clock, newId, env }, paymentFacts(await sim.api.payments.get(paymentId)))
    })
  return { sim, env, decide }
}

type IntentBody = { intent: { id: string; code: string; amountCents: number; note: string; appSwitch: { ios: string; android: string } }; invoice: { calc: { balance: number }; ledger: Array<{ id: string; awaitingProcessor: boolean }> } }

describe('Square POS app switch', () => {
  it('is off by default (404), and needs pay.collect', async () => {
    pos(false)
    const { rafael, kevin } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env())
    const r = await p.send(rafael, 'POST', `invoices/${inv.id}/square-pos-intents`, {})
    expect(r.statusCode).toBe(404)
    expect(r.json()).toMatchObject({ code: 'SQUARE_POS_DISABLED' })
    pos(true)
    expect((await p.send(kevin, 'POST', `invoices/${inv.id}/square-pos-intents`, {})).statusCode).toBe(403)
  })

  it('writes the staff entry, answers the app URLs; the payment with the code in its note confirms that entry (R2), tip on top', async () => {
    const s = pos()
    const { sofia } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env())
    const r = await p.send(sofia, 'POST', `invoices/${inv.id}/square-pos-intents`, {})
    expect(r.statusCode, r.body).toBe(201)
    const b = p.json<IntentBody>(r)
    expect(b.intent).toMatchObject({ amountCents: 16478, note: `INV-${inv.no} · ${b.intent.code}` })
    expect(b.intent.code).toMatch(/^OAS-PI-[A-Z0-9]{6}$/)
    const data = JSON.parse(decodeURIComponent(b.intent.appSwitch.ios.split('data=')[1]!))
    expect(data).toMatchObject({ callback_url: 'https://app.example.test/payments/square-callback', client_id: 'sandbox-sq0idb-test', amount_money: { amount: 16478 } })
    expect(b.invoice.calc.balance).toBe(0)
    const entry = b.invoice.ledger.find((e) => e.awaitingProcessor)!
    const paid = s.sim.store.posPayment({ amountCents: 16478, tipCents: 500, note: b.intent.note })
    expect(await s.decide(String(paid.id))).toBe('matched')
    const m = await p.h.t.db.selectFrom('square_payments').selectAll().where('square_payment_id', '=', String(paid.id)).executeTakeFirstOrThrow()
    expect(m).toMatchObject({ rule: 'R2', event_id: entry.id, classification: 'pos_intent' })
    expect(await p.h.t.db.selectFrom('square_pos_intents').select(['status', 'square_payment_id']).executeTakeFirstOrThrow()).toEqual({ status: 'matched', square_payment_id: paid.id })
  })

  it('the app’s callback (no code in the note) records the payment on the intent’s entry at once; unknown states and errors', async () => {
    const s = pos()
    const { sofia } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env())
    const b = p.json<IntentBody>(await p.send(sofia, 'POST', `invoices/${inv.id}/square-pos-intents`, {}))
    const state = (await p.h.t.db.selectFrom('square_pos_intents').select('callback_state').where('id', '=', b.intent.id).executeTakeFirstOrThrow()).callback_state
    const paid = s.sim.store.posPayment({ amountCents: 16478 })
    const cb = await p.send(sofia, 'POST', 'payments/square/pos-callback', { state, transactionId: String(paid.order_id) })
    expect(cb.statusCode, cb.body).toBe(200)
    expect(cb.json()).toMatchObject({ status: 'recorded', invoiceId: inv.id, payments: 1 })
    const ledger = await p.h.t.db.selectFrom('ledger_events').select(['processor_state', 'processor_ref']).where('invoice_id', '=', inv.id).execute()
    expect(ledger).toEqual([{ processor_state: 'confirmed', processor_ref: paid.id }])
    // the webhook of the same payment changes nothing
    expect(await s.decide(String(paid.id))).toBe('done')
    expect((await p.send(sofia, 'POST', 'payments/square/pos-callback', { state: 'x'.repeat(32) })).json()).toMatchObject({ code: 'SQUARE_POS_INTENT_UNKNOWN' })
    const inv2 = await makeInvoice(p.h.t.db, p.env())
    const b2 = p.json<IntentBody>(await p.send(sofia, 'POST', `invoices/${inv2.id}/square-pos-intents`, {}))
    const state2 = (await p.h.t.db.selectFrom('square_pos_intents').select('callback_state').where('id', '=', b2.intent.id).executeTakeFirstOrThrow()).callback_state
    const err = await p.send(sofia, 'POST', 'payments/square/pos-callback', { state: state2, errorCode: 'payment_canceled' })
    expect(err.json()).toMatchObject({ status: 'error', errorCode: 'payment_canceled', payments: 0 })
    expect(await p.h.t.db.selectFrom('ledger_events').select('processor_state').where('invoice_id', '=', inv2.id).execute()).toEqual([{ processor_state: 'awaiting_processor' }])
  })
})
