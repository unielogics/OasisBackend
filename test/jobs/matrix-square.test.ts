// Every Square job through the real worker, twice each, against the Square simulator (the runtime pointed at it): the second run
// of every job leaves the database (and Square) exactly as the first did. The wave Q2b jobs run with Square as the processor and
// writes on (the defaults would make them skip).
import { afterEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { loadEnv } from '../../src/config/env.js'
import { sqKey } from '../../src/integrations/square/keys.js'
import { usd } from '../../src/integrations/square/money.js'
import { configureSquareMessenger, configureSquareRuntime } from '../../src/modules/square/runtime.js'
import { squareJobs } from '../../src/modules/square/jobs/index.js'
import { squareWebhookLog } from '../../src/modules/square/events.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { ensureLocation } from '../../src/platform/locations.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { liveEnvVars, simFor } from '../square-db/helpers.js'
import { useJobsHarness } from './harness.js'
import { paymentFacts } from '../../src/modules/square/facts.js'
import { activateSquareLink, prepareSquareLink } from '../../src/modules/square/links.js'
import { decideSquarePayment, lockPayment } from '../../src/modules/square/payments.js'
import { transaction } from '../../src/platform/db.js'
import { addEvent, makeInvoice } from '../payments/helpers.js'
import { coreVars } from '../square-db/core.js'

const h = useJobsHarness()
afterEach(() => {
  configureSquareRuntime({})
  configureSquareMessenger(undefined)
})

async function arrange() {
  const db = h.t.db
  const newId = createIdGenerator(h.clock)
  await ensureLocation(db, newId)
  const sim = simFor(h.clock)
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl(), ...liveEnvVars })
  configureSquareRuntime({ env, api: () => sim.api })
  await sim.api.payments.create(sqKey('ch', 'matrix-1'), { source_id: 'cnon:card-nonce-ok', amount_money: usd(4000), location_id: 'LSIMTEST0001' })
  await sim.api.payments.create(sqKey('ch', 'matrix-2'), { source_id: 'cnon:card-nonce-ok', amount_money: usd(2500), location_id: 'LSIMTEST0001' })
  return { db, newId, sim }
}

const snapshot = async () => {
  const db = h.t.db
  return {
    log: (await sql<{ external_id: string; status: string; error: string | null }>`
      select external_id, status, error from webhook_log where provider = 'square' order by external_id`.execute(db)).rows,
    state: (await sql<Record<string, unknown>>`
      select watermark, last_catchup_events, last_catchup_claimed_at, last_reconcile, last_error from square_state`.execute(db)).rows,
  }
}

async function run(worker: Awaited<ReturnType<typeof h.start>>, name: string, data: object = {}): Promise<void> {
  const before = (await h.states(worker.schema, name)).filter((s) => s === 'completed').length
  await worker.jobs.enqueue(name, data)
  await h.waitFor(async () => (await h.states(worker.schema, name)).filter((s) => s === 'completed').length > before, 60_000)
}

describe('the Square jobs, twice each through the real worker', () => {
  it('square.event.process processes a logged event once; the second run leaves the row as it was', async () => {
    const { db, newId, sim } = await arrange()
    const ev = sim.store.events.find((e) => e.type === 'payment.created')!
    await squareWebhookLog(db, newId).claim(ev.event_id, h.clock.now(), { headers: { source: 'webhook' }, body: JSON.stringify(ev) })
    const w = await h.start({ definitions: squareJobs as never })
    const before = JSON.stringify(await snapshot())
    await run(w, 'square.event.process', { eventId: ev.event_id })
    const first = await snapshot()
    expect(first.log).toEqual([{ external_id: ev.event_id, status: 'processed', error: null }])
    expect(JSON.stringify(first)).not.toBe(before)
    await run(w, 'square.event.process', { eventId: ev.event_id })
    expect(await snapshot()).toEqual(first)
  })

  it('square.events.catchup claims and processes each event once; the second run finds nothing new', async () => {
    await arrange()
    const w = await h.start({ definitions: squareJobs as never })
    await run(w, 'square.events.catchup')
    const first = await snapshot()
    expect(first.log.length).toBe(4) // two payments: created + updated each
    expect(first.log.every((r) => r.status === 'processed')).toBe(true)
    await run(w, 'square.events.catchup')
    const second = await snapshot()
    expect(second.log).toEqual(first.log)
    expect(second.state[0]!.watermark).toEqual(first.state[0]!.watermark)
  })

  it('square.reconcile keeps the same counts however many times it runs', async () => {
    await arrange()
    const w = await h.start({ definitions: squareJobs as never })
    await run(w, 'square.reconcile')
    const first = await snapshot()
    expect(first.state[0]!.last_reconcile).toMatchObject({ payments: 2, refunds: 0 })
    await run(w, 'square.reconcile')
    expect(await snapshot()).toEqual(first)
  })

  const q2 = async () => {
    const db = h.t.db
    const newId = createIdGenerator(h.clock)
    const loc = await ensureLocation(db, newId)
    const sim = simFor(h.clock)
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl(), ...coreVars })
    configureSquareRuntime({ env, api: () => sim.api })
    const pe = { location: loc, locationId: loc.id, newId }
    return { db, newId, sim, env, pe, deps: { locationId: loc.id, clock: h.clock, newId, env } }
  }
  const money = async () => {
    const db = h.t.db
    return {
      ledger: (await sql`select invoice_id, type, amount_cents, processor_state, processor_ref, idempotency_key from ledger_events order by seq`.execute(db)).rows,
      mirror: (await sql`select square_payment_id, match_state, rule, invoice_id from square_payments order by square_payment_id`.execute(db)).rows,
      links: (await sql`select state, cancel_reason, url, square_deleted_at from payment_links order by created_at, id`.execute(db)).rows,
      legs: (await sql`select square_payment_id, amount_cents, state, square_refund_id from square_refund_legs order by created_at, id`.execute(db)).rows,
    }
  }

  it('square.payments.match records a counter payment once; the second run finds nothing', async () => {
    const r = await q2()
    const inv = await makeInvoice(r.db, r.pe, { items: [{ name: 'Wash', priceCents: 4000 }] })
    await addEvent(r.db, r.pe, inv, { type: 'pay', amountCents: 4280, method: 'Card', methodKind: 'card', processorState: 'awaiting_processor' })
    const p = r.sim.store.posPayment({ amountCents: 4280 })
    await transaction(r.db, async (tx) => {
      await lockPayment(tx, p.id as string)
      await decideSquarePayment(tx, { ...r.deps, env: loadEnv({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl(), ...coreVars, SQUARE_MATCH_DELAY_SECONDS: '600' }) }, paymentFacts(await r.sim.api.payments.get(p.id as string)))
    })
    await sql`update square_payments set match_after = ${h.clock.now()}`.execute(r.db)
    const w = await h.start({ definitions: squareJobs as never })
    await run(w, 'square.payments.match')
    const first = await money()
    expect(first.mirror).toMatchObject([{ match_state: 'matched', rule: 'R3' }])
    await run(w, 'square.payments.match')
    expect(await money()).toEqual(first)
  })

  it('square.links.sweep cancels and deletes a stale link once', async () => {
    const r = await q2()
    const inv = await makeInvoice(r.db, r.pe, { items: [{ name: 'Wash', priceCents: 4000 }] })
    const prepared = await prepareSquareLink({ db: r.db, clock: h.clock, newId: r.newId, env: r.env, api: r.sim.api }, { locationId: r.pe.locationId, invoiceId: inv.id, purpose: 'balance', origin: 'staff' })
    await transaction(r.db, (tx) => activateSquareLink(tx, { locationId: r.pe.locationId, clock: h.clock }, prepared))
    await addEvent(r.db, r.pe, inv, { type: 'pay', amountCents: 1000, method: 'Cash', methodKind: 'cash' })
    const w = await h.start({ definitions: squareJobs as never })
    await run(w, 'square.links.sweep')
    const first = await money()
    expect(first.links).toMatchObject([{ state: 'canceled', cancel_reason: 'amount_changed' }])
    expect(r.sim.store.links.size).toBe(0)
    await run(w, 'square.links.sweep')
    expect(await money()).toEqual(first)
  })

  it('square.deposit-link makes and activates the deposit link once', async () => {
    const r = await q2()
    const inv = await makeInvoice(r.db, r.pe, { items: [{ name: 'Wash', priceCents: 4000 }] })
    await r.db.insertInto('payment_links').values({ id: r.newId(), location_id: r.pe.locationId, invoice_id: inv.id, kind: 'square_quick_pay', purpose: 'deposit', url: null, expected_cents: 1500, state: 'pending', provider: 'square', origin: 'booking' }).execute()
    const w = await h.start({ definitions: squareJobs as never })
    await run(w, 'square.deposit-link')
    const first = await money()
    expect(first.links).toMatchObject([{ state: 'active', cancel_reason: null }])
    expect(r.sim.store.links.size).toBe(1)
    await run(w, 'square.deposit-link')
    expect(await money()).toEqual(first)
    expect(r.sim.store.links.size).toBe(1)
  })

  it('square.refunds.submit plans and sends a refund leg once', async () => {
    const r = await q2()
    const inv = await makeInvoice(r.db, r.pe, { items: [{ name: 'Wash', priceCents: 4000 }] })
    const p = r.sim.store.posPayment({ amountCents: 4280, note: `INV-${inv.no}` })
    await transaction(r.db, async (tx) => {
      await lockPayment(tx, p.id as string)
      await decideSquarePayment(tx, r.deps, paymentFacts(await r.sim.api.payments.get(p.id as string)), { force: true })
    })
    await r.db.insertInto('ledger_events').values({ id: r.newId(), location_id: r.pe.locationId, invoice_id: inv.id, customer_id: inv.customerId, type: 'refund', amount_cents: 1000, status: 'done', dest: 'card', method: 'Visa', method_kind: 'card', actor_name: 'Test', occurred_at: h.clock.now(), resolved_at: h.clock.now(), processor_state: 'awaiting_processor', processor: 'square' }).execute()
    const w = await h.start({ definitions: squareJobs as never })
    await run(w, 'square.refunds.submit')
    const first = await money()
    expect(first.legs).toMatchObject([{ square_payment_id: p.id, amount_cents: 1000, state: 'pending' }])
    expect(r.sim.store.refunds.size).toBe(1)
    await run(w, 'square.refunds.submit')
    expect(await money()).toEqual(first)
    expect(r.sim.store.refunds.size).toBe(1)
  })
})
