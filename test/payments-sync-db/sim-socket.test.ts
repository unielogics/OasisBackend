// The runtime builds its own client from the stored key and SQSP_API_BASE, and talks to the simulator over a real loopback
// socket (what `pnpm sim:squarespace` serves): Bearer key, User-Agent, paging and the polling windows all travel over HTTP.
import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { SquarespaceSimApi } from '../../src/integrations/squarespace/sim/api.js'
import { close, createSimHttpServer, listen } from '../../src/integrations/squarespace/sim/http.js'
import { SquarespaceSimStore } from '../../src/integrations/squarespace/sim/store.js'
import { configureSqspRuntime, createSqspRuntime } from '../../src/modules/payments-sync/db/runtime-config.js'
import { FakeSleeper } from '../../src/integrations/squarespace/sleeper.js'
import { useRig, testEnv } from './harness.js'

const KEY = 'sqsp-live-looking-key-0123456789'

describe('the runtime over a real socket to the simulator', () => {
  const rig = useRig()
  let server: Server | undefined
  afterEach(async () => {
    if (server) await close(server)
    server = undefined
  })

  it('syncs with the stored key and SQSP_API_BASE, sends the configured User-Agent and pages through the simulator', async () => {
    const r = rig()
    const store = new SquarespaceSimStore(r.clock, { pageSize: 2, order: 'asc', currency: 'USD' })
    const api = new SquarespaceSimApi(store, r.clock, { apiKeys: [KEY] })
    server = createSimHttpServer(api)
    const base = await listen(server)
    const env2 = testEnv({ SQSP_API_BASE: base, SQSP_USER_AGENT: 'OasisSocketTest/9', SQSP_API_KEY: 'will-be-overridden-by-the-stored-key' })
    configureSqspRuntime({ env: env2, sleeper: new FakeSleeper(r.clock) })
    const rt = createSqspRuntime({ db: r.db, clock: r.clock, newId: r.newId, env: env2 })
    await rt.connection(r.locationId).save(KEY, { verified: false })
    for (let i = 0; i < 5; i++)
      store.createOrder({ email: `c${i}@example.com`, name: `C ${i}`, lineItems: [{ productId: 'p', sku: 'X', name: 'X', unitCents: 1000 + i }] })
    r.advance(60_000)
    const res = await rt.syncCycle(r.locationId)
    expect(res.status).toBe('ok')
    expect(res.orders?.inserted).toBe(5)
    expect(res.orders?.pages).toBeGreaterThanOrEqual(3) // 2 per page
    expect(await r.db.selectFrom('sqsp_orders').select('id').execute()).toHaveLength(5)
    expect(api.log.length).toBeGreaterThan(0)
    expect(api.log.every((l) => l.userAgent === 'OasisSocketTest/9')).toBe(true)
    expect(api.log.every((l) => l.status === 200)).toBe(true)
    // the wrong key is a 401 over the wire and a recorded failure, not a crash
    await rt.connection(r.locationId).save('another-key-that-is-not-known-1234', { verified: false })
    r.advance(60_000)
    const rt2 = createSqspRuntime({ db: r.db, clock: r.clock, newId: r.newId, env: env2 })
    const bad = await rt2.syncCycle(r.locationId)
    expect(bad.status).toBe('error')
    expect(bad.orders?.error).toMatch(/401/)
  })

  it('sim mode points at the simulator\'s default address and key without any configuration', () => {
    const r = rig()
    const rt = createSqspRuntime({ db: r.db, clock: r.clock, newId: r.newId, env: testEnv({ SQSP_PROVIDER: 'sim', SQSP_API_KEY: '' } as never) })
    expect(rt.baseUrl()).toBe('http://127.0.0.1:4590')
  })
})
