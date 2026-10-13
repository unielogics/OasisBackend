// Review Q4 money:H1 and SQ-SEM-7: a saved-card charge Square did not answer is never made a second time once the invoice no longer
// owes it, and nothing else collects the invoice while the charge waits. The simulator's `dropAnswer` fault makes the payment at
// Square and loses the answer (the case every "same key, same answer" recovery exists for); `hang` never reaches Square.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../../src/config/env.js'
import type { SquareApi } from '../../src/integrations/ports/square.js'
import { sqKey } from '../../src/integrations/square/keys.js'
import { saveCardOnFile } from '../../src/modules/square/cards.js'
import { resolveCharges } from '../../src/modules/square/charges.js'
import { prepareSquareLink } from '../../src/modules/square/links.js'
import { configureSquareRuntime } from '../../src/modules/square/runtime.js'
import { idemKey, invoiceState, ledgerOf, recordPayment, useRig } from '../scheduling-gaps/support.js'
import { silent, squareEnvFor } from './core.js'
import { simFor } from './helpers.js'

const PEPPER = '5c1b7e0a9f3d2c6b8a4e1f07d9c2b5a3e6f1d8c4b7a2e9f0c3d6b1a8e5f2c7d4'
const m = useRig({ PUBLIC_LINKS_ENABLED: 'true', PIN_PEPPER: PEPPER })
afterEach(() => configureSquareRuntime({}))

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
let sim!: ReturnType<typeof simFor>
let env!: Env
let api!: SquareApi
beforeEach(() => {
  sim = simFor(m.h.clock)
  env = squareEnvFor({})
  api = sim.api
  configureSquareRuntime({ env, api: () => api })
})

let n = 0
async function saveCard(customerId: string) {
  return saveCardOnFile(
    { db: m.h.t.db, clock: m.h.clock, newId: m.h.t.app.newId, env, api, locationId: m.locationId(), logger: silent },
    {
      customerId,
      sourceId: 'cnon:card-nonce-ok',
      purposes: ['balance', 'no_show_fee', 'late_cancel_fee'],
      consentVersion: 'v1',
      ip: '203.0.113.9',
      userAgent: 'test',
      keyBase: `review-q4-charges-${++n}`,
      postalCode: '07026',
    },
  )
}

const charges = () => m.h.t.db.selectFrom('square_charges').selectAll().orderBy('created_at').execute()
const balanceOf = async (invoiceId: string) => (await invoiceState(m, invoiceId)).balance
const chargeCard = (invoiceId: string, body: Record<string, unknown>) => m.send(m.superS(), 'POST', `/invoices/${invoiceId}/card-charges`, body, idemKey())
const resolve = () => resolveCharges({ db: m.h.t.db, clock: m.h.clock, newId: m.h.t.app.newId, env, api, locationId: m.locationId(), logger: silent })
const paymentPosts = () => sim.sim.log.filter((x) => x.path === '/v2/payments' && x.method === 'POST').length

/** A full-balance charge whose requests never reach Square (4 tries): 202 unknown, nothing at Square. */
async function unanswered(fault: 'hang' | 'dropAnswer') {
  const maria = await m.customer('Maria Delgado')
  const card = await saveCard(maria)
  const a = await m.book('Maria Delgado', 'Express Hand Wash')
  const balance = await balanceOf(a.invoiceId)
  sim.sim.injectFault({ [fault]: true, times: 4, path: '/v2/payments', method: 'POST' })
  const r = await chargeCard(a.invoiceId, { cardId: card.cardId, amountCents: balance })
  expect(r.statusCode, r.body).toBe(202)
  expect((r.json() as Json).charge).toMatchObject({ state: 'unknown' })
  return { maria, card, a, balance }
}

describe('a saved-card charge waiting for Square (review Q4 money:H1)', () => {
  it('blocks Collect, Send link and a Square link (staff and pay page) until it is known', async () => {
    const { a, balance } = await unanswered('hang')
    const cash = await m.send(m.superS(), 'POST', `/invoices/${a.invoiceId}/payments`, { method: 'cash' }, idemKey())
    expect(cash.statusCode, cash.body).toBe(409)
    expect((cash.json() as Json).code).toBe('CARD_CHARGE_IN_PROGRESS')
    const card = await m.send(m.superS(), 'POST', `/invoices/${a.invoiceId}/payments`, { method: 'card' }, idemKey())
    expect((card.json() as Json).code).toBe('CARD_CHARGE_IN_PROGRESS')
    const link = await m.send(m.superS(), 'POST', `/invoices/${a.invoiceId}/payment-links`, { kind: 'balance' }, idemKey())
    expect(link.statusCode, link.body).toBe(409)
    expect((link.json() as Json).code).toBe('CARD_CHARGE_IN_PROGRESS')
    const deps = { db: m.h.t.db, clock: m.h.clock, newId: m.h.t.app.newId, env, api, logger: silent }
    await expect(prepareSquareLink(deps, { locationId: m.locationId(), invoiceId: a.invoiceId, purpose: 'balance', origin: 'staff' })).rejects.toMatchObject({
      code: 'CARD_CHARGE_IN_PROGRESS',
    })
    // the pay page says it in the client's words
    await expect(prepareSquareLink(deps, { locationId: m.locationId(), invoiceId: a.invoiceId, purpose: 'balance', origin: 'pay_page' })).rejects.toMatchObject({
      code: 'CARD_CHARGE_IN_PROGRESS',
      detail: 'A payment on your saved card is still going through. Check again in a few minutes, or text us.',
    })
    expect(sim.store.links.size).toBe(0)
    expect(await ledgerOf(m, a.invoiceId)).toEqual([])
    expect(await balanceOf(a.invoiceId)).toBe(balance)
    // once Square answers (the job), the desk may collect again
    expect(await resolve()).toMatchObject({ considered: 1, charged: 1 })
    expect(await balanceOf(a.invoiceId)).toBe(0)
  })

  it('a request that never reached Square is not sent again once the balance was paid another way (nothing charged)', async () => {
    const { a, balance } = await unanswered('hang')
    // paid another way meanwhile (a POS payment matched by its note, a staff entry made before the guard)
    await recordPayment(m, a.invoiceId, balance, { kind: 'cash', deposit: false })
    expect(await balanceOf(a.invoiceId)).toBe(0)
    const posts = paymentPosts()
    expect(await resolve()).toMatchObject({ considered: 1, charged: 0, declined: 1 })
    expect(paymentPosts()).toBe(posts)
    expect(sim.store.payments.size).toBe(0)
    expect(await charges()).toEqual([expect.objectContaining({ state: 'declined', decline_code: 'NOT_SENT', error: 'Nothing was charged: the invoice no longer owes it.' })])
    expect(await invoiceState(m, a.invoiceId)).toMatchObject({ balance: 0 })
    expect((await ledgerOf(m, a.invoiceId)).filter((e) => e.type === 'pay')).toHaveLength(1)
  })

  it('a request that never reached Square is not sent once the visit was canceled', async () => {
    const { a } = await unanswered('hang')
    const c = await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/cancel`, { reason: 'Customer called' }, idemKey())
    expect(c.statusCode, c.body).toBe(200)
    expect(await resolve()).toMatchObject({ considered: 1, declined: 1 })
    expect(sim.store.payments.size).toBe(0)
    expect((await charges())[0]).toMatchObject({ state: 'declined', decline_code: 'NOT_SENT' })
  })

  it('a payment Square made but whose answer was lost is found by its reference and recorded, never made again', async () => {
    const { a } = await unanswered('dropAnswer')
    expect(sim.store.payments.size).toBe(1) // Square took it; the answer never came back
    const posts = paymentPosts()
    expect(await resolve()).toMatchObject({ considered: 1, charged: 1 })
    expect(paymentPosts()).toBe(posts) // found by ListPayments, not sent again
    expect(sim.store.payments.size).toBe(1)
    const [row] = await charges()
    expect(row).toMatchObject({ state: 'charged', square_payment_id: [...sim.store.payments.keys()][0] })
    expect(await balanceOf(a.invoiceId)).toBe(0)
  })

  it('the card really charged while the balance was paid another way is recorded (the overpaid alert then asks for a refund)', async () => {
    const { a, balance } = await unanswered('dropAnswer')
    await recordPayment(m, a.invoiceId, balance, { kind: 'cash', deposit: false })
    expect(await resolve()).toMatchObject({ charged: 1 })
    expect(sim.store.payments.size).toBe(1)
    expect(await invoiceState(m, a.invoiceId)).toMatchObject({ paid: balance * 2 })
  })
})

describe('the simulator loses an answer (review Q4 SQ-SEM-7)', () => {
  it('dropAnswer makes the payment and keeps the key’s answer; hang makes nothing', async () => {
    const body = { source_id: 'cnon:card-nonce-ok', amount_money: { amount: 1000, currency: 'USD' as const }, location_id: sim.store.locationId, autocomplete: true }
    // every try's answer lost (the client's 4 tries): the client gives up, but Square made the payment once
    sim.sim.injectFault({ dropAnswer: true, times: 4, path: '/v2/payments', method: 'POST' })
    await expect(api.payments.create(sqKey('ch', 'review-q4-drop'), body)).rejects.toThrow()
    expect(sim.store.payments.size).toBe(1)
    // the same key again: the answer Square kept, no second payment
    const p = await api.payments.create(sqKey('ch', 'review-q4-drop'), body)
    expect(p.id).toBe([...sim.store.payments.keys()][0])
    expect(sim.store.payments.size).toBe(1)
    sim.sim.injectFault({ hang: true, times: 4, path: '/v2/payments', method: 'POST' })
    await expect(api.payments.create(sqKey('ch', 'review-q4-hang'), body)).rejects.toThrow()
    expect(sim.store.payments.size).toBe(1)
  })
})
