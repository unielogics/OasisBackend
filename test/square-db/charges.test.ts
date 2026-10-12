// Saved cards as a tender and the no-show / late-cancel fees (ADR 0171 D7, plan decision 6, wave Q3a; design 4.2 and 4.3), through
// the real app (session authorizer, the real payments gateway and messaging queue) with the Square runtime pointed at the simulator
// (Square the processor, writes on): a balance charged only after staff confirm and only on a card whose consent covers it; a decline
// answered in plain words; an unanswered charge resolved by re-sending the same key (never twice); a double submit replayed; the
// Square call never made while the invoice is locked; fees proposed (never charged) by the cancel or no-show, then charged or waived;
// the staff card routes; everything off by default.
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../../src/config/env.js'
import type { SquareApi } from '../../src/integrations/ports/square.js'
import { SquareNetworkError, squareErrorFrom } from '../../src/integrations/square/errors.js'
import { sqKey } from '../../src/integrations/square/keys.js'
import { saveCardOnFile } from '../../src/modules/square/cards.js'
import { resolveCharges } from '../../src/modules/square/charges.js'
import { squareExternalAlerts } from '../../src/modules/square/db/alerts.js'
import type { CardPurpose } from '../../src/modules/square/consents.js'
import { paymentFacts } from '../../src/modules/square/facts.js'
import { decideSquarePayment, lockPayment } from '../../src/modules/square/payments.js'
import { configureSquareRuntime } from '../../src/modules/square/runtime.js'
import { transaction } from '../../src/platform/db.js'
import { activityOf, idemKey, invoiceState, ledgerOf, recordPayment, useRig } from '../scheduling-gaps/support.js'
import { silent, squareEnvFor } from './core.js'
import { simFor } from './helpers.js'

const PEPPER = '5c1b7e0a9f3d2c6b8a4e1f07d9c2b5a3e6f1d8c4b7a2e9f0c3d6b1a8e5f2c7d4'
const m = useRig({ PUBLIC_LINKS_ENABLED: 'true', PIN_PEPPER: PEPPER })
afterEach(() => configureSquareRuntime({}))

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

type Sim = ReturnType<typeof simFor>
interface Square {
  sim: Sim
  env: Env
  api: SquareApi
}
let sq!: Square
/** Points the runtime at the test's simulator (the same Square merchant all test long) with these switches and an optional wrapper. */
function square(vars: Record<string, string> = {}, wrap?: (api: SquareApi) => SquareApi, sim: Sim = (sq as Square | undefined)?.sim ?? simFor(m.h.clock)): Square {
  const env = squareEnvFor(vars)
  const api = wrap ? wrap(sim.api) : sim.api
  configureSquareRuntime({ env, api: () => api })
  return { sim, env, api }
}
beforeEach(() => {
  sq = square({}, undefined, simFor(m.h.clock))
})

let n = 0
async function saveCard(customerId: string, purposes: CardPurpose[] = ['balance', 'no_show_fee', 'late_cancel_fee']) {
  return saveCardOnFile(
    { db: m.h.t.db, clock: m.h.clock, newId: m.h.t.app.newId, env: sq.env, api: sq.sim.api, locationId: m.locationId(), logger: silent },
    {
      customerId,
      sourceId: 'cnon:card-nonce-ok',
      purposes,
      consentVersion: 'v1',
      ip: '203.0.113.9',
      userAgent: 'test',
      keyBase: `charges-test-${++n}`,
      postalCode: '07026',
    },
  )
}

const balanceOf = async (invoiceId: string) => (await invoiceState(m, invoiceId)).balance
const charges = () => m.h.t.db.selectFrom('square_charges').selectAll().orderBy('created_at').execute()
const chargeCard = (invoiceId: string, body: Record<string, unknown>, key = idemKey(), s = m.superS()) =>
  m.send(s, 'POST', `/invoices/${invoiceId}/card-charges`, body, key)

/** A declined CreatePayment (PAYMENT_METHOD_ERROR GENERIC_DECLINE), as Square answers it. */
const declining = (api: SquareApi): SquareApi => ({
  ...api,
  payments: {
    ...api.payments,
    create: async () => {
      throw squareErrorFrom(400, { errors: [{ category: 'PAYMENT_METHOD_ERROR', code: 'GENERIC_DECLINE', detail: 'Authorization error' }] }, 'POST', '/v2/payments')
    },
  },
})

/** Square takes the payment but the answer never comes back (a timeout after the request left). */
const answerLost = (api: SquareApi): SquareApi => ({
  ...api,
  payments: {
    ...api.payments,
    create: async (key, input) => {
      await api.payments.create(key, input)
      throw new SquareNetworkError('timeout after the request was sent', true)
    },
  },
})

describe('a balance on a saved card (POST /invoices/:id/card-charges)', () => {
  it('charges the card only after staff confirm: CreatePayment on the card, recorded as a Square pay (rule charge), audited', async () => {
    const maria = await m.customer('Maria Delgado')
    const card = await saveCard(maria)
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    const balance = await balanceOf(a.invoiceId)
    expect(balance).toBeGreaterThan(0)
    expect(await charges()).toEqual([])
    const r = await chargeCard(a.invoiceId, { cardId: card.cardId, amountCents: balance })
    expect(r.statusCode, r.body).toBe(201)
    const body = r.json() as Json
    expect(body.charge).toMatchObject({ purpose: 'balance', state: 'charged', amountCents: balance, reason: 'Balance', card: { id: card.cardId, label: 'Visa ••5858' }, attempts: 1 })
    expect(body.invoice).toMatchObject({ id: a.invoiceId })
    const [row] = await charges()
    expect(row).toMatchObject({ state: 'charged', idempotency_key: sqKey('ch', row!.id), decided_by: expect.any(String), card_id: card.cardId, consent_id: card.consentId })
    // the request: the card on file, its Square customer, autocomplete, the charge as reference, a note naming the invoice
    const sent = [...sq.sim.store.payments.values()]
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ status: 'COMPLETED', customer_id: card.squareCustomerId, reference_id: row!.id, amount_money: { amount: balance, currency: 'USD' } })
    expect(String(sent[0]!.note)).toMatch(/^INV-\d{5} · Balance$/)
    expect(sq.sim.sim.log.filter((x) => x.path === '/v2/payments' && x.method === 'POST').map((x) => x.idempotencyKey)).toEqual([row!.idempotency_key])
    const ledger = await ledgerOf(m, a.invoiceId)
    expect(ledger).toEqual([expect.objectContaining({ type: 'pay', amount_cents: balance, method_kind: 'card', processor_state: 'confirmed', source: 'square', reason: 'Balance', idempotency_key: `square:pay:${sent[0]!.id}` })])
    expect(await balanceOf(a.invoiceId)).toBe(0)
    const mirror = await m.h.t.db.selectFrom('square_payments').select(['classification', 'match_state', 'rule', 'invoice_id']).executeTakeFirstOrThrow()
    expect(mirror).toEqual({ classification: 'charge', match_state: 'matched', rule: 'charge', invoice_id: a.invoiceId })
    const audits = await m.h.t.db.selectFrom('audit_log').select('action').where('entity_type', '=', 'square_charge').orderBy('id').execute()
    expect(audits.map((x) => x.action)).toEqual(['card.charge_started', 'card.charged'])
  })

  it('a double submit with the same key answers the stored result; another key finds nothing left to charge', async () => {
    const maria = await m.customer('Maria Delgado')
    const card = await saveCard(maria)
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    const balance = await balanceOf(a.invoiceId)
    const key = idemKey()
    const first = await chargeCard(a.invoiceId, { cardId: card.cardId, amountCents: balance }, key)
    const replay = await chargeCard(a.invoiceId, { cardId: card.cardId, amountCents: balance }, key)
    expect(first.statusCode).toBe(201)
    expect(replay.statusCode).toBe(201)
    expect(replay.headers['idempotent-replayed']).toBe('true')
    expect((replay.json() as Json).charge.id).toBe((first.json() as Json).charge.id)
    const other = await chargeCard(a.invoiceId, { cardId: card.cardId, amountCents: balance })
    expect(other.statusCode).toBe(422)
    expect((other.json() as Json).code).toBe('PAY_NOTHING_TO_COLLECT')
    expect(sq.sim.store.payments.size).toBe(1)
    expect(await charges()).toHaveLength(1)
    expect((await ledgerOf(m, a.invoiceId)).filter((e) => e.type === 'pay')).toHaveLength(1)
  })

  it('a retry of the same request after the answer was lost (the key released) never charges twice', async () => {
    const maria = await m.customer('Maria Delgado')
    const card = await saveCard(maria)
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    const balance = await balanceOf(a.invoiceId)
    const key = idemKey()
    // half the balance, so a second charge of the same amount would still fit
    const half = Math.floor(balance / 2)
    const first = await chargeCard(a.invoiceId, { cardId: card.cardId, amountCents: half }, key)
    expect(first.statusCode, first.body).toBe(201)
    // the stored answer is lost (as when the command's transaction fails after the charge): the same request comes again
    await m.h.t.db.deleteFrom('idempotency_keys').execute()
    const again = await chargeCard(a.invoiceId, { cardId: card.cardId, amountCents: half }, key)
    expect(again.statusCode, again.body).toBe(201)
    expect((again.json() as Json).charge.id).toBe((first.json() as Json).charge.id)
    expect(sq.sim.store.payments.size).toBe(1)
    expect(await charges()).toHaveLength(1)
    expect(await balanceOf(a.invoiceId)).toBe(balance - half)
  })

  it('never calls Square while the invoice is locked', async () => {
    const maria = await m.customer('Maria Delgado')
    const card = await saveCard(maria)
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    const seen: boolean[] = []
    sq = square({}, (api) => ({
      ...api,
      payments: {
        ...api.payments,
        create: async (key, input) => {
          // another connection takes the invoice lock without waiting: it fails when someone holds it
          try {
            await m.h.t.db.transaction().execute((tx) => sql`select id from invoices where id = ${a.invoiceId} for update nowait`.execute(tx))
            seen.push(true)
          } catch {
            seen.push(false)
          }
          return api.payments.create(key, input)
        },
      },
    }))
    const r = await chargeCard(a.invoiceId, { cardId: card.cardId, amountCents: await balanceOf(a.invoiceId) })
    expect(r.statusCode, r.body).toBe(201)
    expect(seen).toEqual([true])
  })

  it('needs a card whose consent covers balances, active and not expired, and no more than the balance', async () => {
    const maria = await m.customer('Maria Delgado')
    const feesOnly = await saveCard(maria, ['no_show_fee'])
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    const balance = await balanceOf(a.invoiceId)
    const noConsent = await chargeCard(a.invoiceId, { cardId: feesOnly.cardId, amountCents: balance })
    expect(noConsent.statusCode).toBe(422)
    expect((noConsent.json() as Json).code).toBe('CARD_NOT_USABLE')
    const ok = await saveCard(maria)
    const tooMuch = await chargeCard(a.invoiceId, { cardId: ok.cardId, amountCents: balance + 1 })
    expect(tooMuch.statusCode).toBe(422)
    expect((tooMuch.json() as Json).code).toBe('PAY_AMOUNT_INVALID')
    await m.h.t.db.updateTable('customer_cards').set({ exp_month: 5, exp_year: 2026 }).where('id', '=', ok.cardId).execute()
    const expired = await chargeCard(a.invoiceId, { cardId: ok.cardId, amountCents: balance })
    expect((expired.json() as Json).code).toBe('CARD_NOT_USABLE')
    await m.h.t.db.updateTable('customer_cards').set({ exp_month: 10, exp_year: 2030 }).where('id', '=', ok.cardId).execute()
    const removed = await m.send(m.superS(), 'DELETE', `/customers/${maria}/cards/${ok.cardId}`, undefined, false)
    expect(removed.statusCode, removed.body).toBe(200)
    const gone = await chargeCard(a.invoiceId, { cardId: ok.cardId, amountCents: balance })
    expect((gone.json() as Json).code).toBe('CARD_NOT_USABLE')
    // another client's card is not usable for this invoice
    const david = await m.customer('David Okafor')
    const davids = await saveCard(david)
    expect(((await chargeCard(a.invoiceId, { cardId: davids.cardId, amountCents: balance })).json() as Json).code).toBe('CARD_NOT_USABLE')
    expect(await charges()).toEqual([])
    expect(sq.sim.store.payments.size).toBe(0)
  })

  it('a decline answers the plain reason (422 CARD_DECLINED), keeps the charge as declined and records nothing; the same key may try again', async () => {
    const maria = await m.customer('Maria Delgado')
    const card = await saveCard(maria)
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    const balance = await balanceOf(a.invoiceId)
    sq = square({}, declining)
    const key = idemKey()
    const r = await chargeCard(a.invoiceId, { cardId: card.cardId, amountCents: balance }, key)
    expect(r.statusCode).toBe(422)
    expect(r.json()).toMatchObject({ code: 'CARD_DECLINED', title: 'Card declined', detail: 'Your card was declined. Please try another card.' })
    expect(await charges()).toEqual([expect.objectContaining({ state: 'declined', decline_code: 'GENERIC_DECLINE', error: 'Your card was declined. Please try another card.' })])
    expect(await ledgerOf(m, a.invoiceId)).toEqual([])
    expect(await balanceOf(a.invoiceId)).toBe(balance)
    // the client gave another card meanwhile (or the bank said yes): the same request key is free again
    sq = square()
    const again = await chargeCard(a.invoiceId, { cardId: card.cardId, amountCents: balance }, key)
    expect(again.statusCode, again.body).toBe(201)
    // the same request's charge, a new attempt with a new key
    const [row] = await charges()
    expect(row).toMatchObject({ state: 'charged', attempts: 2, idempotency_key: sqKey('ch', `${row!.id}:2`) })
    expect(await charges()).toHaveLength(1)
  })

  describe('the same key sent again after a decline is checked like a new charge', () => {
    /** A full-balance charge declined under `key`; then the card accepts again. */
    async function declinedFirst() {
      const maria = await m.customer('Maria Delgado')
      const card = await saveCard(maria)
      const a = await m.book('Maria Delgado', 'Express Hand Wash')
      const balance = await balanceOf(a.invoiceId)
      sq = square({}, declining)
      const key = idemKey()
      const r = await chargeCard(a.invoiceId, { cardId: card.cardId, amountCents: balance }, key)
      expect(r.statusCode).toBe(422)
      sq = square()
      return { card, a, balance, key }
    }

    it('the balance paid meanwhile: nothing left to charge, the card is not charged', async () => {
      const { card, a, balance, key } = await declinedFirst()
      await recordPayment(m, a.invoiceId, balance, { kind: 'cash', deposit: false })
      expect(await balanceOf(a.invoiceId)).toBe(0)
      const again = await chargeCard(a.invoiceId, { cardId: card.cardId, amountCents: balance }, key)
      expect(again.statusCode, again.body).toBe(422)
      expect((again.json() as Json).code).toBe('PAY_NOTHING_TO_COLLECT')
      expect(sq.sim.store.payments.size).toBe(0)
      expect(await charges()).toEqual([expect.objectContaining({ state: 'declined', attempts: 1 })])
      expect(await balanceOf(a.invoiceId)).toBe(0)
    })

    it('part of the balance paid meanwhile: the old amount is now above the balance (PAY_AMOUNT_INVALID)', async () => {
      const { card, a, balance, key } = await declinedFirst()
      await recordPayment(m, a.invoiceId, 1000, { kind: 'cash', deposit: false })
      const again = await chargeCard(a.invoiceId, { cardId: card.cardId, amountCents: balance }, key)
      expect(again.statusCode, again.body).toBe(422)
      expect((again.json() as Json).code).toBe('PAY_AMOUNT_INVALID')
      expect(sq.sim.store.payments.size).toBe(0)
      expect(await charges()).toEqual([expect.objectContaining({ state: 'declined', attempts: 1 })])
    })

    it('the visit canceled meanwhile: nothing to collect on the canceled invoice', async () => {
      const { card, a, balance, key } = await declinedFirst()
      const c = await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/cancel`, { reason: 'Customer called' }, idemKey())
      expect(c.statusCode, c.body).toBe(200)
      expect((await m.h.t.db.selectFrom('invoices').select('canceled_at').where('id', '=', a.invoiceId).executeTakeFirstOrThrow()).canceled_at).not.toBeNull()
      const again = await chargeCard(a.invoiceId, { cardId: card.cardId, amountCents: balance }, key)
      expect(again.statusCode, again.body).toBe(422)
      expect((again.json() as Json).code).toBe('PAY_NOTHING_TO_COLLECT')
      expect(sq.sim.store.payments.size).toBe(0)
      expect(await charges()).toEqual([expect.objectContaining({ state: 'declined', attempts: 1 })])
    })

    it('another charge on the invoice still waiting for Square: 409 CARD_CHARGE_IN_PROGRESS, one Square payment', async () => {
      const { card, a, balance, key } = await declinedFirst()
      const lost = square({}, answerLost)
      sq = lost
      const other = await chargeCard(a.invoiceId, { cardId: card.cardId, amountCents: balance })
      expect(other.statusCode, other.body).toBe(202)
      expect(lost.sim.store.payments.size).toBe(1)
      sq = square()
      const again = await chargeCard(a.invoiceId, { cardId: card.cardId, amountCents: balance }, key)
      expect(again.statusCode, again.body).toBe(409)
      expect((again.json() as Json).code).toBe('CARD_CHARGE_IN_PROGRESS')
      expect(sq.sim.store.payments.size).toBe(1)
      expect((await charges()).map((c) => `${c.state}:${c.attempts}`).sort()).toEqual(['declined:1', 'unknown:1'])
    })
  })

  it('Square not answering leaves the charge unknown (202); the job re-sends the same key and records it once', async () => {
    const maria = await m.customer('Maria Delgado')
    const card = await saveCard(maria)
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    const balance = await balanceOf(a.invoiceId)
    const lost = square({}, answerLost)
    sq = lost
    const r = await chargeCard(a.invoiceId, { cardId: card.cardId, amountCents: balance })
    expect(r.statusCode, r.body).toBe(202)
    expect((r.json() as Json).charge).toMatchObject({ state: 'unknown', error: 'Square did not answer' })
    expect(lost.sim.store.payments.size).toBe(1) // Square did take it
    expect(await ledgerOf(m, a.invoiceId)).toEqual([])
    // another charge waits until this one is known
    const blocked = await chargeCard(a.invoiceId, { cardId: card.cardId, amountCents: balance })
    expect(blocked.statusCode).toBe(409)
    expect((blocked.json() as Json).code).toBe('CARD_CHARGE_IN_PROGRESS')
    // after 10 minutes without an answer staff see it
    m.h.clock.set(new Date(m.h.clock.now().getTime() + 11 * 60_000))
    const alerts = await squareExternalAlerts.list(m.h.t.db, { locationId: m.locationId(), now: m.h.clock.now(), manager: false })
    expect(alerts.filter((x) => x.kind === 'square_charge_unknown').map((x) => x.title)).toEqual(['Saved-card charge not confirmed · Maria Delgado'])
    const report = await resolveCharges({ db: m.h.t.db, clock: m.h.clock, newId: m.h.t.app.newId, env: lost.env, api: lost.sim.api, locationId: m.locationId(), logger: silent })
    expect(report).toMatchObject({ considered: 1, charged: 1, stale: 0 })
    expect(lost.sim.store.payments.size).toBe(1) // the same key: Square answered the payment it had made
    expect((await squareExternalAlerts.list(m.h.t.db, { locationId: m.locationId(), now: m.h.clock.now(), manager: false })).filter((x) => x.kind === 'square_charge_unknown')).toEqual([])
    const [row] = await charges()
    expect(row).toMatchObject({ state: 'charged', square_payment_id: [...lost.sim.store.payments.keys()][0] })
    expect((await ledgerOf(m, a.invoiceId)).filter((e) => e.type === 'pay')).toHaveLength(1)
    expect(await balanceOf(a.invoiceId)).toBe(0)
    // a second run has nothing to do
    expect(await resolveCharges({ db: m.h.t.db, clock: m.h.clock, newId: m.h.t.app.newId, env: lost.env, api: lost.sim.api, locationId: m.locationId(), logger: silent })).toMatchObject({ considered: 0 })
  })

  it('the job leaves an attempt older than 23 hours to the webhook and staff (no re-send)', async () => {
    const maria = await m.customer('Maria Delgado')
    const card = await saveCard(maria)
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    sq.sim.sim.injectFault({ hang: true, times: 4, path: '/v2/payments', method: 'POST' })
    expect((await chargeCard(a.invoiceId, { cardId: card.cardId, amountCents: await balanceOf(a.invoiceId) })).statusCode).toBe(202)
    m.h.clock.set(new Date(m.h.clock.now().getTime() + 24 * 3_600_000))
    const report = await resolveCharges({ db: m.h.t.db, clock: m.h.clock, newId: m.h.t.app.newId, env: sq.env, api: sq.sim.api, locationId: m.locationId(), logger: silent })
    expect(report).toMatchObject({ considered: 0, stale: 1 })
    expect(sq.sim.store.payments.size).toBe(0)
    expect((await charges())[0]).toMatchObject({ state: 'unknown' })
  })

  it('an unanswered charge whose request never reached Square is made once by the job', async () => {
    const maria = await m.customer('Maria Delgado')
    const card = await saveCard(maria)
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    // the client tries 4 times; each attempt times out before Square sees it
    sq.sim.sim.injectFault({ hang: true, times: 4, path: '/v2/payments', method: 'POST' })
    const r = await chargeCard(a.invoiceId, { cardId: card.cardId, amountCents: await balanceOf(a.invoiceId) })
    expect(r.statusCode, r.body).toBe(202)
    expect(sq.sim.store.payments.size).toBe(0)
    const report = await resolveCharges({ db: m.h.t.db, clock: m.h.clock, newId: m.h.t.app.newId, env: sq.env, api: sq.sim.api, locationId: m.locationId(), logger: silent })
    expect(report).toMatchObject({ considered: 1, charged: 1 })
    expect(sq.sim.store.payments.size).toBe(1)
    expect((await charges())[0]).toMatchObject({ state: 'charged' })
  })

  it('the webhook of an unanswered charge records it on the charge’s invoice (classified charge); the job then finds it done', async () => {
    const maria = await m.customer('Maria Delgado')
    const card = await saveCard(maria)
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    const lost = square({}, answerLost)
    sq = lost
    const balance = await balanceOf(a.invoiceId)
    expect((await chargeCard(a.invoiceId, { cardId: card.cardId, amountCents: balance })).statusCode).toBe(202)
    const paymentId = [...lost.sim.store.payments.keys()][0]!
    const deps = { locationId: m.locationId(), clock: m.h.clock, newId: m.h.t.app.newId, env: lost.env }
    const outcome = await transaction(m.h.t.db, async (tx) => {
      await lockPayment(tx, paymentId)
      return decideSquarePayment(tx, deps, paymentFacts(await lost.sim.api.payments.get(paymentId)))
    })
    expect(outcome).toBe('matched')
    expect((await charges())[0]).toMatchObject({ state: 'charged', square_payment_id: paymentId })
    const ledger = await ledgerOf(m, a.invoiceId)
    expect(ledger).toEqual([expect.objectContaining({ type: 'pay', amount_cents: balance, reason: 'Balance' })])
    // the webhook again, and the job: nothing twice
    await transaction(m.h.t.db, async (tx) => {
      await lockPayment(tx, paymentId)
      return decideSquarePayment(tx, deps, paymentFacts(await lost.sim.api.payments.get(paymentId)))
    })
    expect(await resolveCharges({ db: m.h.t.db, clock: m.h.clock, newId: m.h.t.app.newId, env: lost.env, api: lost.sim.api, locationId: m.locationId(), logger: silent })).toMatchObject({ considered: 0 })
    expect(await ledgerOf(m, a.invoiceId)).toHaveLength(1)
  })

  it('is off before the cutover (CARD_PAYMENTS_OFF) and in watch-only mode (SQUARE_WRITES_OFF): nothing written or sent', async () => {
    const maria = await m.customer('Maria Delgado')
    const card = await saveCard(maria)
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    const balance = await balanceOf(a.invoiceId)
    sq = square({ PAYMENT_PROCESSOR: 'squarespace' })
    const off = await chargeCard(a.invoiceId, { cardId: card.cardId, amountCents: balance })
    expect(off.statusCode).toBe(409)
    expect((off.json() as Json).code).toBe('CARD_PAYMENTS_OFF')
    sq = square({ SQUARE_WRITES_ENABLED: 'false' })
    const watch = await chargeCard(a.invoiceId, { cardId: card.cardId, amountCents: balance })
    expect(watch.statusCode).toBe(409)
    expect((watch.json() as Json).code).toBe('SQUARE_WRITES_OFF')
    expect(await charges()).toEqual([])
  })

  it('needs pay.collect', async () => {
    const maria = await m.customer('Maria Delgado')
    const card = await saveCard(maria)
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    const r = await chargeCard(a.invoiceId, { cardId: card.cardId, amountCents: 100 }, idemKey(), m.limited())
    expect(r.statusCode).toBe(403)
    expect(await charges()).toEqual([])
  })
})

describe('no-show and late-cancel fees (fees.card_on_file)', () => {
  const noShowAt = '2026-06-13T14:11:00-04:00' // after the 14:00 start plus the grace
  const setFees = async (fees: { enabled: boolean; noShowCents: number; lateCancelCents: number }) => {
    const cur = (await m.get(m.superS(), '/settings/card-fees')).json() as Json
    const r = await m.send(m.superS(), 'PUT', '/settings/card-fees', { ...fees, version: cur.version }, false)
    expect(r.statusCode, r.body).toBe(200)
    return r.json() as Json
  }
  const noShow = (appointmentId: string) => m.send(m.superS(), 'POST', `/appointments/${appointmentId}/no-show`, {}, idemKey())
  const cancel = (appointmentId: string, body: Record<string, unknown> = {}) =>
    m.send(m.superS(), 'POST', `/appointments/${appointmentId}/cancel`, { reason: 'Customer called', ...body }, idemKey())
  const feeCharges = async (appointmentId: string) => ((await m.get(m.superS(), `/appointments/${appointmentId}/fee-charges`)).json() as Json).items as Json[]

  it('are off by default: a no-show proposes nothing', async () => {
    const maria = await m.customer('Maria Delgado')
    await saveCard(maria)
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    const settings = (await m.get(m.superS(), '/settings/card-fees')).json() as Json
    expect(settings).toMatchObject({ fees: { enabled: false, noShowCents: 0, lateCancelCents: 0 }, active: false })
    m.h.clock.set(noShowAt)
    const r = await noShow(a.appointmentId)
    expect(r.statusCode, r.body).toBe(200)
    expect((r.json() as Json).settlement?.cardFee ?? null).toBeNull()
    expect(await charges()).toEqual([])
  })

  it('a no-show proposes the fee beyond the kept deposit on the saved card; staff charge it: recorded on the canceled invoice, the client texted', async () => {
    const maria = await m.customer('Maria Delgado')
    const card = await saveCard(maria)
    expect((await setFees({ enabled: true, noShowCents: 4000, lateCancelCents: 2000 })).active).toBe(true)
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    await recordPayment(m, a.invoiceId, 2500)
    m.h.clock.set(noShowAt)
    const r = await noShow(a.appointmentId)
    expect(r.statusCode, r.body).toBe(200)
    const fee = (r.json() as Json).settlement.cardFee
    expect(fee).toMatchObject({ purpose: 'no_show_fee', amountCents: 1500, cardLabel: 'Visa ••5858' })
    expect(sq.sim.store.payments.size).toBe(0) // proposed, never charged
    expect(await activityOf(m, a.appointmentId)).toEqual(expect.arrayContaining(['No-show fee proposed · $15.00 on Visa ••5858 (charge or waive it)']))
    expect(await feeCharges(a.appointmentId)).toEqual([expect.objectContaining({ id: fee.chargeId, state: 'proposed', amountCents: 1500, reason: 'No-show fee', card: expect.objectContaining({ id: card.cardId }) })])
    const chargeKey = idemKey()
    const charged = await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/fee-charges/${fee.chargeId}/charge`, {}, chargeKey)
    expect(charged.statusCode, charged.body).toBe(201)
    // the same request after its stored answer was lost: the same charge, nothing charged again
    await m.h.t.db.deleteFrom('idempotency_keys').execute()
    const lost = await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/fee-charges/${fee.chargeId}/charge`, {}, chargeKey)
    expect(lost.statusCode, lost.body).toBe(201)
    expect((charged.json() as Json).charge).toMatchObject({ state: 'charged', amountCents: 1500 })
    const ledger = await ledgerOf(m, a.invoiceId)
    expect(ledger.at(-1)).toMatchObject({ type: 'pay', amount_cents: 1500, reason: 'No-show fee', source: 'square', processor_state: 'confirmed' })
    expect(await invoiceState(m, a.invoiceId)).toMatchObject({ status: 'canceled_kept', paid: 4000 })
    const texts = await m.h.t.db.selectFrom('messages').select(['body', 'template_key']).where('template_key', '=', 'card_fee_charged').execute()
    expect(texts).toHaveLength(1)
    expect(texts[0]!.body).toMatch(/^Oasis Auto Spa charged \$15\.00 to your saved Visa ending in 5858 for the no-show fee\. Questions\? Just reply to this text\./)
    expect(await activityOf(m, a.appointmentId)).toEqual(expect.arrayContaining(['No-show fee charged · $15.00 on Visa ••5858']))
    const again = await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/fee-charges/${fee.chargeId}/charge`, {}, idemKey())
    expect(again.statusCode).toBe(409)
    expect((again.json() as Json).code).toBe('CARD_CHARGE_DECIDED')
    expect(sq.sim.store.payments.size).toBe(1)
  })

  it('a fee larger than the visit is not an overpayment for the alerts', async () => {
    const maria = await m.customer('Maria Delgado')
    await saveCard(maria)
    await setFees({ enabled: true, noShowCents: 9000, lateCancelCents: 0 })
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    await recordPayment(m, a.invoiceId, 2500, { state: 'confirmed' })
    m.h.clock.set(noShowAt)
    const fee = ((await noShow(a.appointmentId)).json() as Json).settlement.cardFee
    expect(fee.amountCents).toBe(6500)
    expect((await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/fee-charges/${fee.chargeId}/charge`, {}, idemKey())).statusCode).toBe(201)
    const calc = (await sql<{ overpaid: string }>`select overpaid from invoice_calc_of(${a.invoiceId}::uuid)`.execute(m.h.t.db)).rows[0]!
    expect(Number(calc.overpaid)).toBeGreaterThan(0)
    const alerts = await squareExternalAlerts.list(m.h.t.db, { locationId: m.locationId(), now: m.h.clock.now(), manager: true })
    expect(alerts.filter((x) => x.kind === 'square_overpaid')).toEqual([])
  })

  it('nothing is proposed when the kept deposit covers the fee, without a card whose consent covers it, or before the cutover', async () => {
    await setFees({ enabled: true, noShowCents: 2500, lateCancelCents: 2000 })
    const maria = await m.customer('Maria Delgado')
    await saveCard(maria, ['balance'])
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    m.h.clock.set(noShowAt)
    expect(((await noShow(a.appointmentId)).json() as Json).settlement?.cardFee ?? null).toBeNull() // no consent for fees
    m.h.clock.set('2026-06-13T10:36:00-04:00')
    await saveCard(maria)
    const b = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-13T15:00:00-04:00')
    await recordPayment(m, b.invoiceId, 2500)
    m.h.clock.set('2026-06-13T15:11:00-04:00')
    expect(((await noShow(b.appointmentId)).json() as Json).settlement?.cardFee ?? null).toBeNull() // the deposit covers it
    m.h.clock.set('2026-06-13T10:36:00-04:00')
    sq = square({ PAYMENT_PROCESSOR: 'squarespace' })
    const c = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-13T16:00:00-04:00')
    m.h.clock.set('2026-06-13T16:11:00-04:00')
    expect(((await noShow(c.appointmentId)).json() as Json).settlement?.cardFee ?? null).toBeNull() // Squarespace is the processor
    expect(await charges()).toEqual([])
  })

  it('a late cancel proposes the late-cancel fee; a cancel in time, or one where staff refund the deposit, proposes none', async () => {
    await setFees({ enabled: true, noShowCents: 4000, lateCancelCents: 2000 })
    const maria = await m.customer('Maria Delgado')
    await saveCard(maria)
    const late = await m.book('Maria Delgado', 'Express Hand Wash') // 14:00 today: inside the 24 h window
    const r = await cancel(late.appointmentId)
    expect(r.statusCode, r.body).toBe(200)
    expect((r.json() as Json).settlement.cardFee).toMatchObject({ purpose: 'late_cancel_fee', amountCents: 2000 })
    const early = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-15T10:00:00-04:00')
    expect(((await cancel(early.appointmentId)).json() as Json).settlement?.cardFee ?? null).toBeNull()
    const lenient = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-13T16:00:00-04:00')
    await recordPayment(m, lenient.invoiceId, 2500)
    expect(((await cancel(lenient.appointmentId, { deposit: 'refund_card' })).json() as Json).settlement?.cardFee ?? null).toBeNull()
    expect((await charges()).map((c) => [c.purpose, c.state])).toEqual([['late_cancel_fee', 'proposed']])
  })

  it('waive keeps the reason (audited); a waived fee cannot be charged; reopening a visit waives its open fee', async () => {
    await setFees({ enabled: true, noShowCents: 4000, lateCancelCents: 2000 })
    const maria = await m.customer('Maria Delgado')
    await saveCard(maria)
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    const b = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-13T16:00:00-04:00')
    const feeA = ((await cancel(a.appointmentId)).json() as Json).settlement.cardFee
    const feeB = ((await cancel(b.appointmentId)).json() as Json).settlement.cardFee
    const w = await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/fee-charges/${feeA.chargeId}/waive`, { reason: 'First time, let it go' }, idemKey())
    expect(w.statusCode, w.body).toBe(200)
    expect((w.json() as Json).charge).toMatchObject({ state: 'waived', waiveReason: 'First time, let it go' })
    const after = await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/fee-charges/${feeA.chargeId}/charge`, {}, idemKey())
    expect((after.json() as Json).code).toBe('CARD_CHARGE_DECIDED')
    expect(await activityOf(m, a.appointmentId)).toEqual(expect.arrayContaining(['Late-cancel fee waived · $20.00 · First time, let it go']))
    const audit = await m.h.t.db.selectFrom('audit_log').select(['action', 'after']).where('entity_id', '=', feeA.chargeId).where('action', '=', 'card.fee_waived').executeTakeFirstOrThrow()
    expect(audit.after).toMatchObject({ reason: 'First time, let it go' })
    // another visit's fee id under this visit: not found
    const wrong = await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/fee-charges/${feeB.chargeId}/waive`, { reason: 'x y' }, idemKey())
    expect(wrong.statusCode).toBe(404)
    const reopened = await m.send(m.superS(), 'POST', `/appointments/${b.appointmentId}/reopen`, {}, idemKey())
    expect(reopened.statusCode, reopened.body).toBe(200)
    expect((await charges()).find((c) => c.id === feeB.chargeId)).toMatchObject({ state: 'waived', waive_reason: 'Visit reopened' })
    expect(sq.sim.store.payments.size).toBe(0)
  })

  it('a declined fee is kept with its reason and may be charged again with a new key (or another card)', async () => {
    await setFees({ enabled: true, noShowCents: 4000, lateCancelCents: 2000 })
    const maria = await m.customer('Maria Delgado')
    await saveCard(maria)
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    const fee = ((await cancel(a.appointmentId)).json() as Json).settlement.cardFee
    sq = square({}, declining)
    const d = await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/fee-charges/${fee.chargeId}/charge`, {}, idemKey())
    expect(d.statusCode).toBe(422)
    expect((d.json() as Json).code).toBe('CARD_DECLINED')
    expect((await charges())[0]).toMatchObject({ state: 'declined', attempts: 1, idempotency_key: sqKey('ch', fee.chargeId) })
    sq = square()
    const second = await saveCard(maria)
    const ok = await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/fee-charges/${fee.chargeId}/charge`, { cardId: second.cardId }, idemKey())
    expect(ok.statusCode, ok.body).toBe(201)
    expect((await charges())[0]).toMatchObject({ state: 'charged', attempts: 2, card_id: second.cardId, idempotency_key: sqKey('ch', `${fee.chargeId}:2`) })
  })
})

describe('the client’s saved cards for staff', () => {
  it('lists the cards with their consents, removes one (DisableCard), and texts a card link', async () => {
    const maria = await m.customer('Maria Delgado')
    const card = await saveCard(maria, ['balance', 'no_show_fee'])
    const list = await m.get(m.superS(), `/customers/${maria}/cards`)
    expect(list.statusCode, list.body).toBe(200)
    expect(list.json()).toMatchObject({
      charge: true,
      cards: [{ id: card.cardId, label: 'Visa ••5858', state: 'active', purposes: ['no_show_fee', 'balance'], consents: [{ version: 'v1', purposes: ['no_show_fee', 'balance'], revokedAt: null, via: 'staff' }] }],
    })
    const del = await m.send(m.superS(), 'DELETE', `/customers/${maria}/cards/${card.cardId}`, undefined, false)
    expect(del.json()).toEqual({ cardId: card.cardId, state: 'disabled', revokedConsents: 1 })
    expect(sq.sim.store.cards.get(card.squareCardId)!.enabled).toBe(false)
    const after = (await m.get(m.superS(), `/customers/${maria}/cards`)).json() as Json
    expect(after.cards[0]).toMatchObject({ state: 'disabled', disabledReason: 'staff_removed', purposes: [], consents: [{ revokeReason: 'staff_removed' }] })
    const link = await m.send(m.superS(), 'POST', `/customers/${maria}/card-link`, {}, false)
    expect(link.statusCode, link.body).toBe(200)
    expect(link.json()).toMatchObject({ sent: true, reason: null, linkId: expect.any(String) })
    const msg = await m.h.t.db.selectFrom('messages').select(['body', 'template_key', 'klass']).where('template_key', '=', 'personal_link_card').executeTakeFirstOrThrow()
    expect(msg.klass).toBe('personal_link')
    expect(msg.body).toMatch(/^Save a card with Oasis Auto Spa on this secure page: \[private link\] It expires in 24 hours\./)
    const issued = await m.h.t.db.selectFrom('client_links').select(['kind', 'issued_by', 'customer_id']).executeTakeFirstOrThrow()
    expect(issued).toEqual({ kind: 'card', issued_by: 'staff', customer_id: maria })
  })

  it('refuses the card link before the cutover', async () => {
    const maria = await m.customer('Maria Delgado')
    sq = square({ PAYMENT_PROCESSOR: 'squarespace' })
    const r = await m.send(m.superS(), 'POST', `/customers/${maria}/card-link`, {}, false)
    expect(r.statusCode).toBe(409)
    expect((r.json() as Json).code).toBe('CARD_PAYMENTS_OFF')
    expect(await m.h.t.db.selectFrom('client_links').select('id').execute()).toEqual([])
  })
})
