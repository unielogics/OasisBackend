// Review finding 21: the membership pass runs from the sync job, the contacts job, the daily cycle job and "Sync now", and
// nothing serialises them. Two passes that both see a brand-new subscriber both try to insert the membership; the loser trips
// uq_memberships_customer_live, the exception escapes the whole pass (every later member of that pass is skipped) and the
// calling job fails.
import { describe, expect, it } from 'vitest'
import { runMembershipPass } from '../../src/modules/memberships/jobs.js'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { replaceProductRows } from '../../src/modules/payments-sync/db/product-map.js'
import { transaction } from '../../src/platform/db.js'
import { makeCustomer, setupEnv } from '../payments/helpers.js'
import { useRig } from '../payments-sync-db/harness.js'

describe('two membership passes at the same moment', () => {
  const rig = useRig({ pageSize: 50 })

  it('create the member once and neither fails', async () => {
    const r = rig()
    const env = await setupEnv({ db: r.db, clock: r.clock })
    await ensurePlans(r.db, { locationId: r.locationId, clock: r.clock, newId: r.newId })
    await transaction(r.db, (tx) =>
      replaceProductRows(tx, { locationId: r.locationId, clock: r.clock, newId: r.newId }, [{ sku: 'MEM-ESS', kind: 'membership', plan: 'essential' }]),
    )
    const customerId = await makeCustomer(r.db, env, { name: 'Nia New', email: 'nia@example.com', phone: '+13057781234' })
    r.store.createOrder({ email: 'nia@example.com', name: 'Nia New', phone: '3057781234', lineItems: [{ productId: 'p-ess', sku: 'MEM-ESS', name: 'Essential', unitCents: 9900 }], taxCents: 693 })
    r.advance(60_000)
    await r.rt.syncCycle(r.locationId)

    const pass = () => runMembershipPass(r.db, r.clock, r.locationId, r.env)
    const results = await Promise.allSettled([pass(), pass(), pass()])
    expect(results.filter((x) => x.status === 'rejected').map((x) => (x as PromiseRejectedResult).reason?.message)).toEqual([])
    expect(await r.db.selectFrom('memberships').select('id').where('customer_id', '=', customerId).execute()).toHaveLength(1)
  })
})
