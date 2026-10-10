// The two record-creating public POSTs run inside the idempotency transaction, which holds one pooled connection. Nothing they do
// may wait for a second connection while holding the first (public-surface review 2026-10-10): with a small pool, a burst of
// bookings and joins from one address used to fill the pool with transactions that each waited for one more connection, and every
// database-backed request of the API (the staff dashboard included) hung until the sessions were killed.
import { describe, expect, it } from 'vitest'
import { bookingBody, json, usePublicHarness } from './harness.js'

const POOL = 2
const h = usePublicHarness({ poolMax: POOL })

describe('public writes on a small pool', () => {
  it(`${3 * POOL} bookings and ${POOL + 1} joins at once from one address all complete (no nested checkout, no deadlock)`, async () => {
    const ip = '10.93.0.1'
    const times = [11 * 60 + 30, 12 * 60, 12 * 60 + 30, 13 * 60, 13 * 60 + 30, 14 * 60]
    const started = Date.now()
    const bookings = times.slice(0, 3 * POOL).map((startMin, i) =>
      h.post('public/bookings', bookingBody(h, { startMin, phone: `+1201555${String(400 + i).padStart(4, '0')}`, name: `Pool Guest ${i}` }), { ip }),
    )
    const joins = Array.from({ length: POOL + 1 }, (_, i) =>
      h.post(
        'public/memberships',
        { tier: 'gold', name: `Pool Joiner ${i}`, phone: `+1201555${String(450 + i).padStart(4, '0')}`, email: `pool${i}@example.test`, vehicles: [{ car: '2020 Kia Soul' }], smsConsent: false, agree: true, website: '' },
        { ip },
      ),
    )
    const all = await Promise.all([...bookings, ...joins])
    const elapsed = Date.now() - started
    expect(all.map((r) => `${r.statusCode} ${r.statusCode >= 300 ? json(r).code : ''}`.trim())).toEqual(all.map(() => '201'))
    // well under the pool's checkout timeout: nobody waited for a connection that could never come
    expect(elapsed).toBeLessThan(8_000)
    expect(await h.db.selectFrom('appointments').select('id').execute()).toHaveLength(3 * POOL)
    expect(await h.db.selectFrom('memberships').select('id').execute()).toHaveLength(POOL + 1)
  })

  it('the honeypot answer reads nothing outside the transaction either', async () => {
    const ip = '10.93.0.2'
    const all = await Promise.all(
      Array.from({ length: 3 * POOL }, (_, i) => h.post('public/bookings', bookingBody(h, { website: 'spam', phone: `+1201555${String(470 + i).padStart(4, '0')}` }), { ip })),
    )
    expect(all.map((r) => r.statusCode)).toEqual(all.map(() => 202))
  })
})
