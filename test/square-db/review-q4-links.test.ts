// Review Q4 money:M2: a payment-link payment that arrives after the visit was canceled is never kept silently on the canceled invoice
// (no cancel rule settles it); it waits in "Square payments to match" for a person. The sweep deletes the canceled link at Square in
// observe-only mode too (a clean-up), so it cannot stay payable while writes are off.
import { describe, expect, it } from 'vitest'
import { loadEnv } from '../../src/config/env.js'
import { createSquareApi } from '../../src/integrations/square/api/index.js'
import { SquareClient } from '../../src/integrations/square/client.js'
import { simFetch } from '../../src/integrations/square/sim/index.js'
import { paymentFacts } from '../../src/modules/square/facts.js'
import { activateSquareLink, prepareSquareLink, sweepSquareLinks } from '../../src/modules/square/links.js'
import { decideSquarePayment, lockPayment } from '../../src/modules/square/payments.js'
import { configureSquareRuntime } from '../../src/modules/square/runtime.js'
import type { FixedClock } from '../../src/platform/clock.js'
import { transaction } from '../../src/platform/db.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { makeInvoice } from '../payments/helpers.js'
import { usePayHarness } from '../payments/http.js'
import { coreVars, silent, useCoreRuntime } from './core.js'
import { simFor } from './helpers.js'

const p = usePayHarness()
useCoreRuntime()

function square(vars: Record<string, string> = {}) {
  const clock = p.h.t.clock as FixedClock
  const sim = simFor(clock)
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl(), ...coreVars, ...vars })
  configureSquareRuntime({ env, api: () => sim.api })
  const newId = createIdGenerator(clock)
  const deps = { db: p.h.t.db, clock, newId, env, api: sim.api, logger: silent }
  const decide = (paymentId: string) =>
    transaction(p.h.t.db, async (tx) => {
      await lockPayment(tx, paymentId)
      return decideSquarePayment(tx, { locationId: p.env().locationId, clock, newId, env }, paymentFacts(await sim.api.payments.get(paymentId)), { force: true })
    })
  return { sim, env, clock, newId, deps, decide }
}

describe('a link paid after the visit was canceled (review Q4 money:M2)', () => {
  it('waits in the queue (never kept on the canceled invoice); the sweep deletes the link at Square even when writes are off', async () => {
    const s = square()
    const inv = await makeInvoice(p.h.t.db, p.env())
    const prepared = await prepareSquareLink(s.deps, { locationId: p.env().locationId, invoiceId: inv.id, purpose: 'deposit', amountCents: 2500, origin: 'staff' })
    await transaction(p.h.t.db, (tx) => activateSquareLink(tx, { locationId: p.env().locationId, clock: s.clock }, prepared))
    // the visit is canceled in its free window: nothing was paid, nothing to settle
    await p.h.t.db.updateTable('invoices').set({ canceled_at: s.clock.now(), cancel_reason: 'canceled' }).where('id', '=', inv.id).execute()
    // the client pays the link still open at Square
    const paid = s.sim.store.payLink(prepared.squareLinkId)
    expect(await s.decide(String(paid.id))).toBe('unmatched')
    const mirror = await p.h.t.db.selectFrom('square_payments').selectAll().where('square_payment_id', '=', String(paid.id)).executeTakeFirstOrThrow()
    expect(mirror).toMatchObject({ classification: 'link', match_state: 'unmatched', variance: { reason: 'paid by a payment link after the visit was canceled: refund it in Square, or apply it' } })
    expect(mirror.candidates).toEqual([expect.objectContaining({ invoiceId: inv.id, why: ['paid by its payment link after the visit was canceled'] })])
    expect(await p.h.t.db.selectFrom('ledger_events').select('id').where('invoice_id', '=', inv.id).execute()).toEqual([])
    // observe-only (or a rollback): the client refuses every write but this clean-up
    const watchOnly = createSquareApi(
      new SquareClient({ baseUrl: 'http://sim', accessToken: 'sim-token-000001', fetch: simFetch(s.sim.sim), writesEnabled: false, sleeper: { sleep: async () => undefined } }),
    )
    const off = loadEnv({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl(), ...coreVars, SQUARE_WRITES_ENABLED: 'false' })
    const r = await sweepSquareLinks({ db: p.h.t.db, clock: s.clock, newId: s.newId, env: off, api: watchOnly, logger: silent, locationId: p.env().locationId })
    expect(r).toEqual({ canceled: 1, deleted: 1, failed: 0 })
    expect(s.sim.store.links.size).toBe(0)
    const row = await p.h.t.db.selectFrom('payment_links').selectAll().where('id', '=', prepared.rowId).executeTakeFirstOrThrow()
    expect(row).toMatchObject({ state: 'canceled', cancel_reason: 'invoice_canceled' })
    expect(row.square_deleted_at).not.toBeNull()
  })
})
