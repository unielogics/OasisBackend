// Review Q4 SQ-SEM-6 and SQ-SEM-7: a booking deposit link that Square refuses is given up at once (not retried every minute for a
// day) and the managers are told to collect it another way; a link Square made but whose answer was lost is made live by the next run
// with the same key (never a second link).
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadEnv } from '../../src/config/env.js'
import { devOutbox } from '../../src/modules/payments/ports.js'
import { runDepositLinks } from '../../src/modules/square/deposits.js'
import { configureSquareMessenger, configureSquareRuntime } from '../../src/modules/square/runtime.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { coreVars, silent } from '../square-db/core.js'
import { simFor } from '../square-db/helpers.js'
import { bookingBody, json, PHONES, usePublicHarness } from './harness.js'

const h = usePublicHarness()
afterEach(() => configureSquareRuntime({}))
beforeEach(() => configureSquareMessenger(undefined))

function square() {
  const sim = simFor(h.clock)
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl(), ...coreVars })
  configureSquareRuntime({ env, api: () => sim.api })
  const deps = { db: h.db, clock: h.clock, newId: h.newId, env, api: sim.api, logger: silent, locationId: h.locationId }
  return { sim, env, deps }
}

const feeByLink = (cents = 1500) =>
  sql`insert into settings (location_id, key, value) values (${h.locationId}, 'booking.guest_fee', ${JSON.stringify({ cents, collect: 'link' })}::jsonb)
    on conflict (location_id, key) do update set value = excluded.value`.execute(h.db)

const depositRows = () =>
  h.db.selectFrom('payment_links').select(['id', 'state', 'cancel_reason', 'url', 'square_payment_link_id']).where('purpose', '=', 'deposit').execute()

async function booked() {
  const r = await h.post('public/bookings', bookingBody(h, { phone: PHONES.guest, startMin: 13 * 60 }))
  expect(r.statusCode, r.body).toBe(201)
  expect(json(r).deposit).toEqual({ dueCents: 1500, how: 'link' })
}

describe('the booking deposit link when Square refuses it or loses its answer (review Q4 SQ-SEM-6, SQ-SEM-7)', () => {
  it('a request Square refuses (400) is given up at once and the managers are told; nothing retries it', async () => {
    const s = square()
    await feeByLink()
    await booked()
    s.sim.sim.injectFault({ status: 400, times: 1, path: '/v2/online-checkout/payment-links', method: 'POST' })
    expect(await runDepositLinks(s.deps)).toMatchObject({ created: 0, dropped: 1, failed: 1 })
    expect(await depositRows()).toEqual([expect.objectContaining({ state: 'canceled', cancel_reason: 'square_error', url: null })])
    const notes = await h.db.selectFrom('notifications').select(['kind', 'title', 'body']).where('kind', '=', 'payments.deposit_link_failed').execute()
    expect(notes.length).toBeGreaterThan(0)
    expect(notes[0]!.title).toMatch(/^Deposit link failed · /)
    expect(notes[0]!.body).toMatch(/^Square refused the deposit link for OAS-\d+, so .+ was not texted one\. Take the deposit at the counter, or send a payment link from the invoice\.$/)
    const posts = s.sim.sim.log.filter((x) => x.path === '/v2/online-checkout/payment-links' && x.method === 'POST').length
    expect(await runDepositLinks(s.deps)).toMatchObject({ created: 0, failed: 0 })
    expect(s.sim.sim.log.filter((x) => x.path === '/v2/online-checkout/payment-links' && x.method === 'POST').length).toBe(posts)
  })

  it('Square down (500) keeps the request for the next run', async () => {
    const s = square()
    await feeByLink()
    await booked()
    s.sim.sim.injectFault({ status: 500, times: 4, path: '/v2/online-checkout/payment-links', method: 'POST' })
    expect(await runDepositLinks(s.deps)).toMatchObject({ created: 0, dropped: 0, failed: 1 })
    expect(await depositRows()).toEqual([expect.objectContaining({ state: 'pending' })])
    expect(await runDepositLinks(s.deps)).toMatchObject({ created: 1, texted: 1 })
  })

  it('a link Square made but whose answer was lost is made live by the next run with the same key: one link at Square', async () => {
    const s = square()
    await feeByLink()
    devOutbox.clear()
    await booked()
    s.sim.sim.injectFault({ dropAnswer: true, times: 4, path: '/v2/online-checkout/payment-links', method: 'POST' })
    expect(await runDepositLinks(s.deps)).toMatchObject({ created: 0, failed: 1 })
    expect(s.sim.store.links.size).toBe(1)
    expect(await depositRows()).toEqual([expect.objectContaining({ state: 'pending' })])
    expect(await runDepositLinks(s.deps)).toMatchObject({ created: 1, texted: 1 })
    expect(s.sim.store.links.size).toBe(1)
    const [row] = await depositRows()
    expect(row).toMatchObject({ state: 'active', square_payment_link_id: [...s.sim.store.links.keys()][0] })
  })
})
