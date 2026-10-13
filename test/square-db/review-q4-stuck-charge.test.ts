// Review Q4 H1-R1: a saved-card charge Square never answered must not block the invoice forever. The job still looks the payment up
// (read-only ListPayments by reference_id) when Square is watch-only or the re-send window has passed, and closes the charge
// `declined` (NOT_SENT) when Square has none, or records it when Square has it; staff can do the same with "Not charged (checked
// Square)" (POST /invoices/:id/card-charges/:chargeId/not-charged), which the alert points at.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../../src/config/env.js'
import type { SquareApi } from '../../src/integrations/ports/square.js'
import { SquareClient } from '../../src/integrations/square/client.js'
import { createSquareApi } from '../../src/integrations/square/api/index.js'
import { simFetch } from '../../src/integrations/square/sim/index.js'
import { saveCardOnFile } from '../../src/modules/square/cards.js'
import { chargeWaiting } from '../../src/modules/square/charge-guard.js'
import { resolveCharges } from '../../src/modules/square/charges.js'
import { squareExternalAlerts } from '../../src/modules/square/db/alerts.js'
import { configureSquareRuntime } from '../../src/modules/square/runtime.js'
import { idemKey, invoiceState, recordPayment, useRig } from '../scheduling-gaps/support.js'
import { silent, squareEnvFor } from './core.js'
import { simFor } from './helpers.js'

const PEPPER = '5c1b7e0a9f3d2c6b8a4e1f07d9c2b5a3e6f1d8c4b7a2e9f0c3d6b1a8e5f2c7d4'
const m = useRig({ PUBLIC_LINKS_ENABLED: 'true', PIN_PEPPER: PEPPER })
afterEach(() => configureSquareRuntime({}))

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const MIN = 60_000
let sim!: ReturnType<typeof simFor>
let env!: Env
let api!: SquareApi
beforeEach(() => {
  sim = simFor(m.h.clock)
  env = squareEnvFor({})
  api = sim.api
  configureSquareRuntime({ env, api: () => api })
})

/** Square turned watch-only (the rollback lever): the same simulator, writes refused by the client. */
function writesOff(): void {
  env = squareEnvFor({ SQUARE_WRITES_ENABLED: 'false' })
  api = createSquareApi(
    new SquareClient({ baseUrl: 'http://sim', accessToken: 'sim-token-000001', fetch: simFetch(sim.sim), sleeper: { sleep: async () => undefined }, writesEnabled: false }),
  )
  configureSquareRuntime({ env, api: () => api })
}

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
      keyBase: `review-q4-stuck-${++n}`,
      postalCode: '07026',
    },
  )
}

const charges = () => m.h.t.db.selectFrom('square_charges').selectAll().orderBy('created_at').execute()
const balanceOf = async (invoiceId: string) => (await invoiceState(m, invoiceId)).balance
const resolve = () => resolveCharges({ db: m.h.t.db, clock: m.h.clock, newId: m.h.t.app.newId, env, api, locationId: m.locationId(), logger: silent })
const paymentPosts = () => sim.sim.log.filter((x) => x.path === '/v2/payments' && x.method === 'POST').length
const later = (ms: number) => m.h.clock.set(new Date(m.h.clock.now().getTime() + ms))
const cash = (invoiceId: string) => m.send(m.superS(), 'POST', `/invoices/${invoiceId}/payments`, { method: 'cash' }, idemKey())
const notCharged = (invoiceId: string, chargeId: string) =>
  m.send(m.superS(), 'POST', `/invoices/${invoiceId}/card-charges/${chargeId}/not-charged`, {}, idemKey())

/** A full-balance charge whose requests never got an answer: 202 unknown. `hang`: nothing at Square; `dropAnswer`: Square made it. */
async function unanswered(fault: 'hang' | 'dropAnswer') {
  const maria = await m.customer('Maria Delgado')
  const card = await saveCard(maria)
  const a = await m.book('Maria Delgado', 'Express Hand Wash')
  const balance = await balanceOf(a.invoiceId)
  sim.sim.injectFault({ [fault]: true, times: 4, path: '/v2/payments', method: 'POST' })
  const r = await m.send(m.superS(), 'POST', `/invoices/${a.invoiceId}/card-charges`, { cardId: card.cardId, amountCents: balance }, idemKey())
  expect(r.statusCode, r.body).toBe(202)
  const chargeId = (r.json() as Json).charge.id as string
  return { a, balance, chargeId }
}

describe('an unanswered saved-card charge always has a way out (review Q4 H1-R1)', () => {
  it('past the re-send window: Square has no payment, so the job closes it (nothing charged) and the desk collects again', async () => {
    const { a, balance } = await unanswered('hang')
    later(24 * 60 * MIN)
    const posts = paymentPosts()
    expect(await resolve()).toMatchObject({ considered: 1, declined: 1, stale: 1 })
    expect(paymentPosts()).toBe(posts) // looked up, never sent again
    expect((await charges())[0]).toMatchObject({ state: 'declined', decline_code: 'NOT_SENT', error: 'Nothing was charged: Square has no payment for it.' })
    // the invoice can be collected again (the staff session of the test is a day old: the guard is asked directly)
    expect(await chargeWaiting(m.h.t.db, a.invoiceId)).toBeNull()
    expect(await balanceOf(a.invoiceId)).toBe(balance)
  })

  it('past the re-send window: a payment Square made is found and recorded', async () => {
    const { a } = await unanswered('dropAnswer')
    later(24 * 60 * MIN)
    expect(await resolve()).toMatchObject({ considered: 1, charged: 1, stale: 1 })
    expect((await charges())[0]).toMatchObject({ state: 'charged' })
    expect(await balanceOf(a.invoiceId)).toBe(0)
  })

  it('Square watch-only: the job only looks; none after 15 minutes closes it, a payment Square made is recorded', async () => {
    const { a } = await unanswered('hang')
    writesOff()
    // too soon: Square's list may still be catching up, the charge keeps waiting (and the row is left as it is)
    const before = (await charges())[0]!
    expect(await resolve()).toMatchObject({ considered: 1, declined: 0, unknown: 1 })
    expect((await charges())[0]).toMatchObject({ state: 'unknown', updated_at: before.updated_at })
    later(16 * MIN)
    expect(await resolve()).toMatchObject({ considered: 1, declined: 1 })
    expect((await charges())[0]).toMatchObject({ state: 'declined', decline_code: 'NOT_SENT' })
    expect(sim.store.payments.size).toBe(0)
    expect((await cash(a.invoiceId)).statusCode).toBe(201)

    // another one Square did make while its answer was lost: watch-only finds and records it
    const b = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-13T16:00:00-04:00')
    env = squareEnvFor({})
    api = sim.api
    configureSquareRuntime({ env, api: () => api })
    const card = (await m.h.t.db.selectFrom('customer_cards').select('id').executeTakeFirstOrThrow()).id
    sim.sim.injectFault({ dropAnswer: true, times: 4, path: '/v2/payments', method: 'POST' })
    const r = await m.send(m.superS(), 'POST', `/invoices/${b.invoiceId}/card-charges`, { cardId: card, amountCents: await balanceOf(b.invoiceId) }, idemKey())
    expect(r.statusCode, r.body).toBe(202)
    writesOff()
    expect(await resolve()).toMatchObject({ considered: 1, charged: 1 })
    expect(await balanceOf(b.invoiceId)).toBe(0)
  })

  it('staff "Not charged (checked Square)": looks Square up; none: closed, audited, the desk collects again', async () => {
    const { a, chargeId } = await unanswered('hang')
    writesOff() // the rollback lever: the job sends nothing, staff still have a way out
    const r = await notCharged(a.invoiceId, chargeId)
    expect(r.statusCode, r.body).toBe(200)
    expect((r.json() as Json).charge).toMatchObject({ id: chargeId, state: 'declined', declineCode: 'NOT_SENT' })
    expect((r.json() as Json).charge.error).toMatch(/^Nothing was charged: Square has no payment for it/)
    const audit = await m.h.t.db.selectFrom('audit_log').select(['action', 'actor_name']).where('entity_id', '=', chargeId).where('action', '=', 'card.charge_not_charged').execute()
    expect(audit).toHaveLength(1)
    expect(audit[0]!.actor_name).toBeTruthy()
    expect((await cash(a.invoiceId)).statusCode).toBe(201)
    // closed: a second press says so
    const again = await notCharged(a.invoiceId, chargeId)
    expect(again.statusCode, again.body).toBe(409)
    expect((again.json() as Json).code).toBe('CARD_CHARGE_NOT_WAITING')
  })

  it('staff "Not charged": Square has the payment, so it is recorded instead (never closed as not charged)', async () => {
    const { a, chargeId } = await unanswered('dropAnswer')
    const posts = paymentPosts()
    const r = await notCharged(a.invoiceId, chargeId)
    expect(r.statusCode, r.body).toBe(200)
    expect((r.json() as Json).charge).toMatchObject({ state: 'charged' })
    expect(paymentPosts()).toBe(posts)
    expect(await balanceOf(a.invoiceId)).toBe(0)
  })

  it('staff "Not charged": Square not answering is 503 and changes nothing; another invoice’s charge is 404', async () => {
    const { a, chargeId } = await unanswered('hang')
    sim.sim.injectFault({ hang: true, times: 40, path: '/v2/payments', method: 'GET' })
    const r = await notCharged(a.invoiceId, chargeId)
    expect(r.statusCode, r.body).toBe(503)
    expect((await charges())[0]).toMatchObject({ state: 'unknown' })
    const other = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-13T16:00:00-04:00')
    const wrong = await notCharged(other.invoiceId, chargeId)
    expect(wrong.statusCode, wrong.body).toBe(404)
  })

  it('a balance paid another way meanwhile is still closed when Square has no payment', async () => {
    const { a, balance } = await unanswered('hang')
    await recordPayment(m, a.invoiceId, balance, { kind: 'cash', deposit: false })
    writesOff()
    later(16 * MIN)
    expect(await resolve()).toMatchObject({ declined: 1 })
    expect((await charges())[0]).toMatchObject({ state: 'declined', decline_code: 'NOT_SENT' })
  })

  it('the alert says how to close it', async () => {
    await unanswered('hang')
    later(11 * MIN)
    const alerts = await squareExternalAlerts.list(m.h.t.db, { locationId: m.locationId(), now: m.h.clock.now(), manager: true })
    const a = alerts.find((x) => x.kind === 'square_charge_unknown')
    expect(a?.desc).toMatch(/Not charged/)
  })
})
