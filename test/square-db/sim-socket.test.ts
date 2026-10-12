// The whole path over real loopback sockets, as `pnpm sim:square` serves it: the app's own client (SQUARE_PROVIDER=live,
// SQUARE_API_BASE = the simulator) and the simulator's signed webhooks into /hooks/square, including duplicates, reordering and a
// wrong key; then the catch-up over HTTP finds what no webhook delivered.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { loadEnv } from '../../src/config/env.js'
import { squareApiFor } from '../../src/integrations/square/factory.js'
import { sqKey } from '../../src/integrations/square/keys.js'
import { usd } from '../../src/integrations/square/money.js'
import { SquareSimApi, SquareSimStore, closeSim, createSquareSimHttpServer, listenSim } from '../../src/integrations/square/sim/index.js'
import { runSquareCatchup } from '../../src/modules/square/catchup.js'
import { noopSquareIngest } from '../../src/modules/square/ingest.js'
import { squareHookModule } from '../../src/modules/square/http/hook.js'
import { systemClock } from '../../src/platform/clock.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { createLogger } from '../../src/platform/logging.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { useTestDb } from '../helpers/db.js'
import { testDatabaseUrl } from '../helpers/env.js'

const TOKEN = 'sim-socket-token-0001'
const KEY = 'sim-socket-signature-key'

describe('Square over a socket', () => {
  const t = useTestDb()
  const servers: Server[] = []
  const apps: TestApp[] = []
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.close()
    for (const s of servers.splice(0)) await closeSim(s)
  })

  async function stack() {
    // the simulator runs on the wall clock (deliveries carry real timestamps); the app keeps the frozen test clock
    const store = new SquareSimStore(systemClock, { locationId: 'LSOCKET001' })
    const sim = new SquareSimApi(store, { tokens: [TOKEN] })
    const simServer = createSquareSimHttpServer(sim)
    servers.push(simServer)
    const base = await listenSim(simServer)
    const ref: { app?: TestApp } = {}
    // a tiny receiver on its own port that hands the exact bytes to the app (its URL is the one Square signs)
    const receiver = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', async () => {
        const r = await ref.app!.app.inject({ method: 'POST', url: '/hooks/square', headers: req.headers as Record<string, string>, payload: Buffer.concat(chunks).toString('utf8') })
        res.writeHead(r.statusCode, { 'content-type': 'application/json' }).end(r.body)
      })
    })
    servers.push(receiver)
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))
    const hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hooks/square`
    const vars = {
      SQUARE_PROVIDER: 'live',
      SQUARE_API_BASE: base,
      SQUARE_ACCESS_TOKEN: TOKEN,
      SQUARE_LOCATION_ID: 'LSOCKET001',
      SQUARE_APPLICATION_ID: 'sandbox-sq0idb-socket',
      SQUARE_WEBHOOK_SIGNATURE_KEY: KEY,
      SQUARE_WEBHOOK_URL: hookUrl,
      SQUARE_WRITES_ENABLED: 'true',
    }
    const app = await createTestApp({ testDb: t, hookModules: [squareHookModule], env: vars, deps: { jobs: null } })
    ref.app = app
    apps.push(app)
    const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl(), ...vars })
    const api = squareApiFor(env, { sleeper: { sleep: async () => undefined } })
    const rows = () => app.db.selectFrom('webhook_log').select(['external_id', 'status']).where('provider', '=', 'square').execute()
    return { store, sim, base, hookUrl, app, env, api, rows }
  }

  it('signed deliveries reach /hooks/square and are processed once, also when Square repeats or reorders them', async () => {
    const s = await stack()
    s.sim.addWebhookSubscription({ url: s.hookUrl, signatureKey: KEY })
    const p = await s.api.payments.create(sqKey('ch', 'sock-1'), { source_id: 'cnon:card-nonce-ok', amount_money: usd(4000), location_id: 'LSOCKET001' })
    await s.sim.webhooks.pending()
    let rows = await s.rows()
    const paymentEvents = s.store.events.filter((e) => e.type.startsWith('payment.') && e.data.id === p.id)
    expect(rows.filter((r) => paymentEvents.some((e) => e.event_id === r.external_id)).map((r) => r.status)).toEqual(paymentEvents.map(() => 'processed'))
    expect(s.sim.webhooks.deliveries.every((d) => d.status === 200)).toBe(true)
    // duplicates: every event twice, still one row each
    s.sim.webhooks.mode = 'duplicate'
    const before = rows.length
    await s.api.payments.create(sqKey('ch', 'sock-2'), { source_id: 'cnon:card-nonce-ok', amount_money: usd(2500), location_id: 'LSOCKET001' })
    await s.sim.webhooks.pending()
    rows = await s.rows()
    const twice = s.sim.webhooks.deliveries.filter((d) => d.attempt === 2)
    expect(twice.length).toBeGreaterThan(0)
    expect(new Set(rows.map((r) => r.external_id)).size).toBe(rows.length)
    expect(rows.length).toBeGreaterThan(before)
    // reordered: the newer event first
    s.sim.webhooks.mode = 'out_of_order'
    await s.api.refunds.refund(sqKey('rf', 'sock-r'), { payment_id: p.id, amount_money: usd(1000) })
    await s.sim.webhooks.flush()
    rows = await s.rows()
    expect(rows.every((r) => r.status === 'processed' || r.status === 'ignored')).toBe(true)
  })

  it('a delivery signed with another key is refused (401) and nothing is kept', async () => {
    const s = await stack()
    s.sim.addWebhookSubscription({ url: s.hookUrl, signatureKey: 'not-our-key-000000' })
    await s.api.customers.create(sqKey('cu', 'sock'), { given_name: 'Ana', email_address: 'ana@oasisautospanj.com' })
    s.store.updateCustomer([...s.store.customers.keys()][0]!, { given_name: 'Ana Maria' })
    await s.sim.webhooks.pending()
    expect(s.sim.webhooks.deliveries.length).toBeGreaterThan(0)
    expect(s.sim.webhooks.deliveries.every((d) => d.status === 401)).toBe(true)
    expect(await s.rows()).toHaveLength(0)
  })

  it('the catch-up over HTTP claims and processes what no webhook delivered; the client retries a dropped connection', async () => {
    const s = await stack()
    s.sim.injectFault({ hang: true, times: 1, path: '/v2/payments' })
    await s.api.payments.create(sqKey('ch', 'quiet'), { source_id: 'cnon:card-nonce-ok', amount_money: usd(1800), location_id: 'LSOCKET001' })
    expect(s.store.payments.size).toBe(1)
    const rep = await runSquareCatchup({
      db: s.app.db,
      clock: systemClock,
      logger: createLogger({ level: 'silent' }),
      env: s.env,
      api: s.api,
      ingest: noopSquareIngest,
      newId: createIdGenerator(systemClock),
    })
    expect(rep).toMatchObject({ status: 'ok', failed: 0 })
    expect(rep.claimed).toBeGreaterThanOrEqual(2)
    expect((await s.rows()).every((r) => r.status === 'processed')).toBe(true)
    const bad = squareApiFor({ ...s.env, SQUARE_ACCESS_TOKEN: 'wrong-token-00000', SQUARE_MAX_ATTEMPTS: 1 })
    await expect(bad.locations.list()).rejects.toMatchObject({ status: 401 })
  })
})
