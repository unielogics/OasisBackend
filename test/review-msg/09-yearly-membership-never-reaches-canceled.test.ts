// Review finding 9: the membership pass reads subscription orders of the last 420 days, but a yearly plan is only inferred
// canceled after 12 months + 7 days of grace + 60 days of lapse (432 days). From day 421 the member's only order is outside the
// window, the pass never looks at that person again, and the lapsed member stays past_due forever.
import { describe, expect, it } from 'vitest'
import { runMembershipPass } from '../../src/modules/memberships/jobs.js'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { replaceProductRows } from '../../src/modules/payments-sync/db/product-map.js'
import { transaction } from '../../src/platform/db.js'
import { makeCustomer, setupEnv } from '../payments/helpers.js'
import { D, useRig } from '../payments-sync-db/harness.js'

describe('a yearly membership that was never renewed', () => {
  const rig = useRig({ pageSize: 50 })

  it('is inferred canceled once the lapse has run, whatever the age of its last order', async () => {
    const r = rig()
    const env = await setupEnv({ db: r.db, clock: r.clock })
    await ensurePlans(r.db, { locationId: r.locationId, clock: r.clock, newId: r.newId })
    await transaction(r.db, (tx) =>
      replaceProductRows(tx, { locationId: r.locationId, clock: r.clock, newId: r.newId }, [{ sku: 'MEM-YEAR', kind: 'membership', plan: 'premium', intervalMonths: 12 }]),
    )
    const customerId = await makeCustomer(r.db, env, { name: 'Yara Year', email: 'yara@example.com', phone: '+13057783399' })
    const t0 = r.clock.now()
    r.store.createOrder({ email: 'yara@example.com', name: 'Yara Year', phone: '3057783399', lineItems: [{ productId: 'p-year', sku: 'MEM-YEAR', name: 'Premium yearly', unitCents: 99900 }], taxCents: 6993 })
    r.advance(60_000)
    await r.rt.syncCycle(r.locationId)
    const pass = () => runMembershipPass(r.db, r.clock, r.locationId, r.env)
    const status = async () => (await r.db.selectFrom('memberships').select('status').where('customer_id', '=', customerId).executeTakeFirstOrThrow()).status

    r.clock.set(new Date(t0.getTime() + 400 * D)) // a year plus a month: renewal overdue, past the grace
    await pass()
    expect(await status()).toBe('past_due')

    r.clock.set(new Date(t0.getTime() + 440 * D)) // 12 months + 7 + 60 days have passed: the documented lapse is over
    await pass()
    expect(await status()).toBe('canceled')
  })
})
