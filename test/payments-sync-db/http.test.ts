// The Squarespace integration routes through the real session authorizer: permission gates, the credential never leaving the
// server, the manual queue rules, and the webhook.
import { beforeEach, describe, expect, it } from 'vitest'
import { SquarespaceClient } from '../../src/integrations/squarespace/client.js'
import { SlidingWindowLimiter } from '../../src/integrations/squarespace/limiter.js'
import { FakeSleeper } from '../../src/integrations/squarespace/sleeper.js'
import { SquarespaceSimApi } from '../../src/integrations/squarespace/sim/api.js'
import { SquarespaceSimStore } from '../../src/integrations/squarespace/sim/store.js'
import { createSecretBox } from '../../src/modules/payments-sync/db/secrets.js'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { replaceProductRows } from '../../src/modules/payments-sync/db/product-map.js'
import { configureSqspRuntime, createSqspRuntime } from '../../src/modules/payments-sync/db/runtime-config.js'
import { transaction } from '../../src/platform/db.js'
import { useHarness, type Session } from '../auth/harness.js'
import { simFetch } from '../integrations/squarespace/helpers.js'
import { addEvent, makeCustomer, makeInvoice, setupEnv, type Env as PayEnv } from '../payments/helpers.js'
import { SECRETS_KEY, SIM_KEY } from './harness.js'

const REAL_KEY = 'sq0-secret-api-key-0123456789abcdef'
let keyN = 0
const idemKey = (): string => `http-key-${++keyN}-${'z'.repeat(8)}`

describe('Squarespace routes', () => {
  const h = useHarness({ env: { SECRETS_KEY, SQSP_PROVIDER: 'sim' } })
  let store: SquarespaceSimStore
  let api: SquarespaceSimApi
  let sleeper: FakeSleeper
  let ip = 0
  const addr = () => `10.88.${Math.floor(ip / 200)}.${(ip++ % 200) + 1}`
  let acct: Session
  let collector: Session
  let crew: Session
  let payEnv: PayEnv

  beforeEach(async () => {
    store = new SquarespaceSimStore(h.clock, { pageSize: 50, order: 'asc', currency: 'USD' })
    api = new SquarespaceSimApi(store, h.clock, { apiKeys: [SIM_KEY, REAL_KEY] })
    sleeper = new FakeSleeper(h.clock)
    configureSqspRuntime({
      env: h.t.env,
      sleeper,
      sourceFactory: ({ apiKey }) =>
        new SquarespaceClient({
          auth: { kind: 'api_key', apiKey },
          clock: h.clock,
          sleeper,
          fetch: simFetch(api),
          userAgent: 'OasisTest/1.0',
          limiter: new SlidingWindowLimiter(h.clock, sleeper, 240, 60_000),
        }),
    })
    payEnv = await setupEnv({ db: h.t.db, clock: h.clock })
    const mk = async (email: string, roles: string[]) => {
      const user = await h.createUser({ email, roles })
      return h.login(user, addr())
    }
    acct = await mk('daniel@example.test', ['acct'])
    collector = await mk('sofia@example.test', ['support'])
    crew = await mk('marco@example.test', ['crew'])
  })

  const get = (s: Session, url: string) => h.call('GET', `/api/v1${url}`, { session: s, ip: addr() })
  const send = (s: Session, method: 'POST' | 'PUT' | 'DELETE' | 'PATCH', url: string, body?: unknown, key?: string) =>
    h.call(method, `/api/v1${url}`, {
      session: s,
      body: body ?? {},
      headers: key === undefined ? { 'idempotency-key': idemKey() } : key ? { 'idempotency-key': key } : {},
      ip: addr(),
    })
  const rt = () => createSqspRuntime({ db: h.t.db, clock: h.clock, env: h.t.env })

  it('status needs set.billing and reports connection, lag, counts and alerts, never a key', async () => {
    expect((await get(crew, '/integrations/squarespace/status')).statusCode).toBe(403)
    expect((await get(collector, '/integrations/squarespace/status')).statusCode).toBe(403)
    const empty = await get(acct, '/integrations/squarespace/status')
    expect(empty.statusCode, empty.body).toBe(200)
    const e = empty.json() as { provider: string; sync: { orders: { status: string } }; lagSeconds: number | null; productMap: { empty: boolean } }
    expect(e.provider).toBe('sim')
    expect(e.sync.orders.status).toBe('never_run')
    expect(e.lagSeconds).toBeNull()
    expect(e.productMap.empty).toBe(true)

    store.createOrder({ email: 'a@example.com', name: 'A', lineItems: [{ productId: 'p', sku: 'X', name: 'X', unitCents: 1000 }] })
    h.clock.advance(120_000)
    await rt().syncCycle(h.t.location.id)
    h.clock.advance(30_000)
    const st = await get(acct, '/integrations/squarespace/status')
    const body = st.json() as {
      lagSeconds: number
      sync: { orders: { status: string; lastSuccessAt: string } }
      counts: { orders: { ignored: number }; deadLetters: number }
      alerts: { code: string }[]
      connection: { configured: boolean; keySource: string }
    }
    expect(body.sync.orders.status).toBe('ok')
    expect(body.lagSeconds).toBe(30)
    expect(body.counts.orders.ignored).toBe(1)
    expect(body.alerts.map((a) => a.code)).toContain('product_map_empty')
    expect(body.connection).toMatchObject({ configured: true, keySource: 'simulator' })
  })

  it('PUT connection verifies the key, stores it encrypted and never returns it anywhere', async () => {
    const r = await send(acct, 'PUT', '/integrations/squarespace/connection', { apiKey: REAL_KEY, siteId: 'site-1' }, '')
    expect(r.statusCode, r.body).toBe(200)
    expect(r.body).not.toContain(REAL_KEY)
    expect(r.json()).toMatchObject({ configured: true, keySource: 'database', status: 'connected', siteId: 'site-1' })
    const row = await h.t.db.selectFrom('sqsp_connections').selectAll().executeTakeFirstOrThrow()
    expect(row.api_key_enc).toBeTruthy()
    expect(row.api_key_enc).not.toContain(REAL_KEY)
    expect(createSecretBox([SECRETS_KEY]).decrypt(row.api_key_enc!)).toBe(REAL_KEY)
    expect(row.last_verified_at).not.toBeNull()
    // the key is not in the audit trail, in the logs, or in any response
    const audits = await h.t.db.selectFrom('audit_log').selectAll().execute()
    expect(JSON.stringify(audits)).not.toContain(REAL_KEY)
    expect(JSON.stringify(h.t.logs)).not.toContain(REAL_KEY)
    const urls = [
      '/integrations/squarespace/status',
      '/integrations/squarespace/product-map',
      '/integrations/squarespace/orders?state=all',
      '/payments/reconciliation',
    ]
    for (const u of urls) {
      const res = await get(acct, u)
      expect(res.body, u).not.toContain(REAL_KEY)
      expect(res.body, u).not.toContain(row.api_key_enc!)
    }
    // the stored key is the one the sync uses
    expect(await rt().resolveKey(h.t.location.id)).toBe(REAL_KEY)
  })

  it('PUT connection refuses a key Squarespace rejects and stores nothing', async () => {
    const r = await send(acct, 'PUT', '/integrations/squarespace/connection', { apiKey: 'not-a-known-key-123' }, '')
    expect(r.statusCode).toBe(422)
    expect((r.json() as { code: string }).code).toBe('SQSP_CONNECTION_FAILED')
    expect(r.body).not.toContain('not-a-known-key-123')
    expect(await h.t.db.selectFrom('sqsp_connections').select('id').execute()).toHaveLength(0)
    const denied = await send(collector, 'PUT', '/integrations/squarespace/connection', { apiKey: REAL_KEY }, '')
    expect(denied.statusCode).toBe(403)
  })

  it('DELETE connection erases the key and stops using it', async () => {
    await send(acct, 'PUT', '/integrations/squarespace/connection', { apiKey: REAL_KEY }, '')
    const r = await send(acct, 'DELETE', '/integrations/squarespace/connection', undefined, '')
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ status: 'disconnected', keySource: 'none', configured: false })
    const row = await h.t.db.selectFrom('sqsp_connections').selectAll().executeTakeFirstOrThrow()
    expect(row.api_key_enc).toBeNull()
    // an explicit disconnect stops polling even in sim mode
    expect(await rt().resolveKey(h.t.location.id)).toBeUndefined()
    const skipped = await rt().syncCycle(h.t.location.id)
    expect(skipped.status).toBe('not_configured')
  })

  it('product map: validates, saves, lists products seen on orders and flags the unmapped ones', async () => {
    const bad = await send(acct, 'PUT', '/integrations/squarespace/product-map', { entries: [{ sku: 'MEM-1', kind: 'membership' }] }, '')
    expect(bad.statusCode).toBe(422)
    expect(JSON.stringify(bad.json())).toMatch(/needs a plan/)
    store.createOrder({ email: 'a@example.com', name: 'A', lineItems: [{ productId: 'p-mem', sku: 'MEM-1', name: 'Gold', unitCents: 9900 }] })
    store.createOrder({ email: 'b@example.com', name: 'B', lineItems: [{ productId: 'p-x', sku: 'WASH-1', name: 'Wash', unitCents: 4500 }] })
    h.clock.advance(120_000)
    await rt().syncCycle(h.t.location.id)
    const ok = await send(
      acct,
      'PUT',
      '/integrations/squarespace/product-map',
      { entries: [{ sku: 'MEM-1', kind: 'membership', planLabel: 'Premium Care', name: 'Gold' }] },
      '',
    )
    expect(ok.statusCode, ok.body).toBe(200)
    const body = ok.json() as {
      entries: { plan: string; planLabel: string }[]
      seen: { sku: string; mapped: boolean }[]
      plans: { key: string }[]
    }
    expect(body.entries[0]).toMatchObject({ plan: 'premium', planLabel: 'Premium Care' })
    expect(body.seen.find((s) => s.sku === 'MEM-1')?.mapped).toBe(true)
    expect(body.seen.find((s) => s.sku === 'WASH-1')?.mapped).toBe(false)
    expect(body.plans.map((p) => p.key)).toEqual(['essential', 'premium', 'executive', 'exotic'])
    const again = await get(acct, '/integrations/squarespace/product-map')
    expect((again.json() as { entries: unknown[] }).entries).toHaveLength(1)
  })

  it('sync-now: refuses without a key, otherwise runs inline when there is no queue', async () => {
    const live = await h.call('POST', '/api/v1/integrations/squarespace/sync-now', {
      session: acct,
      body: {},
      ip: addr(),
    })
    // sim provider defaults to the simulator key, so a run happens
    expect(live.statusCode, live.body).toBe(200)
    const j = live.json() as { mode: string; result: { status: string } }
    expect(j.mode).toBe('inline')
    expect(j.result.status).toBe('ok')
    const denied = await h.call('POST', '/api/v1/integrations/squarespace/sync-now', { session: collector, body: {}, ip: addr() })
    expect(denied.statusCode).toBe(403)
    const audits = await h.t.db.selectFrom('audit_log').select('action').where('action', '=', 'sqsp.sync_now').execute()
    expect(audits).toHaveLength(1)
  })

  async function queuedOrder(over: { email?: string; amount?: number } = {}) {
    await ensurePlans(h.t.db, { locationId: h.t.location.id, clock: h.clock, newId: h.t.app.newId })
    await transaction(h.t.db, (tx) =>
      replaceProductRows(tx, { locationId: h.t.location.id, clock: h.clock, newId: h.t.app.newId }, [
        { sku: 'DET-SEDAN', kind: 'service' },
      ]),
    )
    const o = store.createOrder({
      email: over.email ?? 'stranger@example.com',
      name: 'Stranger',
      lineItems: [{ productId: 'p', sku: 'DET-SEDAN', name: 'Full Detail', unitCents: over.amount ?? 18900 }],
      taxCents: 1323,
    })
    h.clock.advance(120_000)
    await rt().syncCycle(h.t.location.id)
    return o
  }

  const detail = [{ name: 'Full Detail', priceCents: 18900 }]

  it('the orders queue needs set.billing or pay.collect and masks contact details without cli.contact', async () => {
    await queuedOrder()
    expect((await get(crew, '/integrations/squarespace/orders')).statusCode).toBe(403)
    const full = await get(acct, '/integrations/squarespace/orders?state=unmatched')
    expect(full.statusCode).toBe(200)
    expect(JSON.stringify(full.json())).toContain('stranger@example.com')
    const user = await h.userWithPermissions(['pay.collect'])
    const masked = await get(user.session, '/integrations/squarespace/orders?state=unmatched')
    expect(masked.statusCode).toBe(200)
    expect(masked.body).not.toContain('stranger@example.com')
    expect((masked.json() as { items: { customerEmail: string }[] }).items[0]?.customerEmail).toMatch(/\*/)
  })

  it('match: needs pay.collect and an Idempotency-Key, records once, and refuses a possible double count unless forced', async () => {
    const o = await queuedOrder()
    const customerId = await makeCustomer(h.t.db, payEnv, { name: 'Walk In', email: 'walkin@example.com' })
    const inv = await makeInvoice(h.t.db, payEnv, { customerId, items: detail })
    const waiting = await addEvent(h.t.db, payEnv, inv, {
      type: 'pay',
      amountCents: 20223,
      method: 'Card',
      methodKind: 'card',
      processorState: 'awaiting_processor',
    })
    const url = `/integrations/squarespace/orders/${o.orderId}/match`
    expect((await send(crew, 'POST', url, { invoiceId: inv.id })).statusCode).toBe(403)
    const noKey = await send(collector, 'POST', url, { invoiceId: inv.id }, '')
    expect(noKey.statusCode).toBe(400)
    expect((noKey.json() as { code: string }).code).toBe('IDEMPOTENCY_KEY_REQUIRED')
    expect((await send(collector, 'POST', url, {})).statusCode).toBe(422)
    // an invoice that already shows a card payment waiting on Squarespace: confirm that one instead
    const dup = await send(collector, 'POST', url, { invoiceId: inv.id })
    expect(dup.statusCode).toBe(409)
    expect((dup.json() as { code: string; meta: { eventIds: string[] } })).toMatchObject({ code: 'SQSP_MATCH_DUPLICATE', meta: { eventIds: [waiting] } })
    expect(await h.t.db.selectFrom('ledger_events').select('id').where('invoice_id', '=', inv.id).execute()).toHaveLength(1)
    // confirming the waiting payment is the right way, and replaying the same request replays the response
    const key = idemKey()
    const ok = await send(collector, 'POST', url, { eventId: waiting }, key)
    expect(ok.statusCode, ok.body).toBe(200)
    expect((ok.json() as { applied: { how: string }[] }).applied[0]?.how).toBe('confirmed')
    const replay = await send(collector, 'POST', url, { eventId: waiting }, key)
    expect(replay.headers['idempotent-replayed']).toBe('true')
    const ev = await h.t.db.selectFrom('ledger_events').select(['processor_state', 'sqsp_order_id', 'processor_confirmed_by']).where('id', '=', waiting).executeTakeFirstOrThrow()
    expect(ev).toMatchObject({ processor_state: 'confirmed', sqsp_order_id: o.orderId })
    expect(ev.processor_confirmed_by).toMatch(/Sofia|Duarte|User/)
    expect(await h.t.db.selectFrom('ledger_events').select('id').where('invoice_id', '=', inv.id).execute()).toHaveLength(1)
    // nothing is left to match
    const gone = await send(collector, 'POST', url, { invoiceId: inv.id })
    expect(gone.statusCode).toBe(409)
  })

  it('match with force records a squarespace payment even beside an equal card payment', async () => {
    const o = await queuedOrder({ email: 'f@example.com' })
    const customerId = await makeCustomer(h.t.db, payEnv, { name: 'Forced', email: 'forced@example.com' })
    const inv = await makeInvoice(h.t.db, payEnv, { customerId, items: detail })
    await addEvent(h.t.db, payEnv, inv, { type: 'pay', amountCents: 20223, method: 'Visa', methodKind: 'card' })
    const url = `/integrations/squarespace/orders/${o.orderId}/match`
    const forced = await send(collector, 'POST', url, { invoiceId: inv.id, force: true })
    expect(forced.statusCode, forced.body).toBe(200)
    const evs = await h.t.db.selectFrom('ledger_events').select(['source', 'amount_cents']).where('invoice_id', '=', inv.id).orderBy('seq').execute()
    expect(evs).toEqual([
      { source: 'oasis', amount_cents: 20223 },
      { source: 'squarespace', amount_cents: 20223 },
    ])
  })

  it('ignore: leaves the queue, is idempotent, and is refused once money is on an invoice', async () => {
    const o = await queuedOrder({ email: 'ig@example.com' })
    const url = `/integrations/squarespace/orders/${o.orderId}/ignore`
    expect((await send(crew, 'POST', url, {})).statusCode).toBe(403)
    const r1 = await send(collector, 'POST', url, { reason: 'duplicate of a phone order' })
    expect(r1.statusCode, r1.body).toBe(200)
    expect(r1.json()).toEqual({ orderId: o.orderId, alreadyIgnored: false })
    expect((await send(collector, 'POST', url, {})).json()).toEqual({ orderId: o.orderId, alreadyIgnored: true })
    const row = await h.t.db.selectFrom('sqsp_orders').select(['match_state', 'ignore_reason']).executeTakeFirstOrThrow()
    expect(row).toEqual({ match_state: 'ignored', ignore_reason: 'manual: duplicate of a phone order' })
    expect(await h.t.db.selectFrom('sqsp_manual_queue').select('state').executeTakeFirstOrThrow()).toEqual({ state: 'ignored' })
    expect((await get(acct, '/integrations/squarespace/orders?state=unmatched')).json()).toMatchObject({ items: [] })
    const t = await h.t.db.selectFrom('sqsp_transactions').select('state').executeTakeFirstOrThrow()
    expect(t.state).toBe('ignored')
    // an order whose money is already recorded cannot be ignored
    const o2 = await queuedOrder({ email: 'paid@example.com' })
    const customerId = await makeCustomer(h.t.db, payEnv, { name: 'Payer', email: 'payer@example.com' })
    const inv = await makeInvoice(h.t.db, payEnv, { customerId, items: detail })
    expect((await send(collector, 'POST', `/integrations/squarespace/orders/${o2.orderId}/match`, { invoiceId: inv.id })).statusCode).toBe(200)
    const refused = await send(collector, 'POST', `/integrations/squarespace/orders/${o2.orderId}/ignore`, {})
    expect(refused.statusCode).toBe(409)
    expect((refused.json() as { code: string }).code).toBe('SQSP_ORDER_ALREADY_MATCHED')
  })

  it('unknown orders are 404 for match and ignore', async () => {
    expect((await send(collector, 'POST', '/integrations/squarespace/orders/nope/match', { invoiceId: '00000000-0000-7000-8000-000000000000' })).statusCode).toBe(404)
    expect((await send(collector, 'POST', '/integrations/squarespace/orders/nope/ignore', {})).statusCode).toBe(404)
  })

  it('alerts can be resolved by set.billing', async () => {
    await queuedOrder()
    const alert = await h.t.db.selectFrom('sqsp_alerts').select('id').where('code', '=', 'external_refund').executeTakeFirst()
    expect(alert).toBeUndefined()
    const id = h.t.app.newId()
    await h.t.db.insertInto('sqsp_alerts').values({ id, location_id: h.t.location.id, dedupe_key: 'x', code: 'external_refund', message: 'm' }).execute()
    expect((await send(collector, 'POST', `/integrations/squarespace/alerts/${id}/resolve`, {})).statusCode).toBe(403)
    const r = await send(acct, 'POST', `/integrations/squarespace/alerts/${id}/resolve`, {})
    expect(r.json()).toEqual({ resolved: true })
    expect((await send(acct, 'POST', `/integrations/squarespace/alerts/${id}/resolve`, {})).json()).toEqual({ resolved: false })
  })
})
