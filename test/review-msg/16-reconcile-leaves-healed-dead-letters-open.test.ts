// Review finding 16: an item the poll dead-lettered (5 failed persists, recorded under resource `orders`) is picked up again by
// the nightly reconcile, which is the replay path. The reconcile only clears errors recorded under its own resource name, so an
// item it stores successfully stays an open dead letter for ever and the sync health keeps counting it.
import { describe, expect, it } from 'vitest'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { replaceProductRows } from '../../src/modules/payments-sync/db/product-map.js'
import { transaction } from '../../src/platform/db.js'
import { useRig } from '../payments-sync-db/harness.js'

describe('a dead-lettered order that the nightly reconcile stores', () => {
  const rig = useRig({ pageSize: 50 })
  const line = { productId: 'p', sku: 'DET-SEDAN', name: 'Full Detail', unitCents: 18900 }

  it('is no longer an open dead letter', async () => {
    const r = rig()
    await ensurePlans(r.db, { locationId: r.locationId, clock: r.clock, newId: r.newId })
    await transaction(r.db, (tx) => replaceProductRows(tx, { locationId: r.locationId, clock: r.clock, newId: r.newId }, [{ sku: 'DET-SEDAN', kind: 'service' }]))
    const { orderId } = r.store.createOrder({ email: 'a@example.com', name: 'A', lineItems: [line], taxCents: 1323, createdOn: new Date(r.clock.now().getTime() - 2 * 86_400_000) })
    // the poll gave up on it after five failed attempts (whatever the cause was, it has been fixed since)
    await r.db
      .insertInto('sqsp_sync_errors')
      .values({ id: r.newId(), location_id: r.locationId, resource: 'orders', key: orderId, kind: 'persist', message: 'boom', attempts: 5, first_at: r.clock.now(), last_at: r.clock.now(), dead_lettered_at: r.clock.now() })
      .execute()

    r.advance(120_000)
    const parts = (await r.rt.partsFor(r.locationId))!
    const report = await parts.engine.reconcile()
    expect(report.complete).toBe(true)
    expect(report.orders.inserted).toBe(1)

    const open = await r.db.selectFrom('sqsp_sync_errors').select('key').where('resolved_at', 'is', null).execute()
    expect(open).toEqual([])
  })
})
