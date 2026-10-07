// Review finding 5: five failed Squarespace runs (about ten minutes of outage) dead-letter the resource and polling stops
// until a person presses "Sync now". The sync_dead_letter alert is raised once, then the very next scheduled run returns
// `skipped` for the dead resource, which the cycle treats as healthy: it resolves sync_dead_letter and sync_failing and marks
// the connection healthy. Payments stay unconfirmed with nothing on screen saying why.
import { describe, expect, it } from 'vitest'
import { replaceProductRows } from '../../src/modules/payments-sync/db/product-map.js'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { transaction } from '../../src/platform/db.js'
import { useRig } from '../payments-sync-db/harness.js'

describe('a dead-lettered Squarespace sync', () => {
  const rig = useRig({ pageSize: 50 })

  it('keeps its alert open and the connection unhealthy while it is stopped', async () => {
    const r = rig()
    await ensurePlans(r.db, { locationId: r.locationId, clock: r.clock, newId: r.newId })
    await transaction(r.db, (tx) => replaceProductRows(tx, { locationId: r.locationId, clock: r.clock, newId: r.newId }, [{ sku: 'DET-SEDAN', kind: 'service' }]))
    await r.rt.syncCycle(r.locationId)

    r.api.injectFailure({ status: 500, times: 50 })
    for (let i = 0; i < 5; i++) {
      r.advance(120_000)
      await r.rt.syncCycle(r.locationId)
    }
    const open = async (): Promise<string[]> => (await r.db.selectFrom('sqsp_alerts').select('code').where('resolved_at', 'is', null).execute()).map((a) => a.code)
    expect(await open()).toContain('sync_dead_letter')

    // the next scheduled poll finds the resource dead-lettered and skips it
    r.advance(120_000)
    const skipped = await r.rt.syncCycle(r.locationId)
    expect(skipped.orders?.status).toBe('skipped')

    const state = await r.db.selectFrom('sqsp_sync_state').select('status').where('resource', '=', 'orders').executeTakeFirstOrThrow()
    expect(state.status).toBe('dead_letter')
    expect(await open()).toContain('sync_dead_letter')
  })
})
