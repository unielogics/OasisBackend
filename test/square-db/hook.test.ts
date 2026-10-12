// POST /hooks/square: the signature over the configured URL and the raw body (current and previous key), the event_id dedupe in
// webhook_log, a foreign merchant ignored, the job queued at once, and a queue failure that gives the event back (503).
import { describe, expect, it } from 'vitest'
import { squareHookModule } from '../../src/modules/square/http/hook.js'
import { saveSquareState } from '../../src/modules/square/db/state.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { useTestDb } from '../helpers/db.js'
import { usd } from '../../src/integrations/square/money.js'
import { sqKey } from '../../src/integrations/square/keys.js'
import { HOOK_KEY_PREVIOUS, fakeJobs, signed, simFor, squareEnvVars, useSquareRuntime } from './helpers.js'

describe('POST /hooks/square', () => {
  const t = useTestDb()
  const runtime = useSquareRuntime()

  async function appWith(o: { env?: Record<string, string>; jobs?: unknown } = {}): Promise<TestApp> {
    return createTestApp({
      testDb: t,
      hookModules: [squareHookModule],
      env: { ...squareEnvVars, ...o.env },
      deps: o.jobs === undefined ? {} : { jobs: o.jobs as never },
    })
  }
  const post = (app: TestApp, n: { rawBody: string; headers: Record<string, string> }) =>
    app.app.inject({ method: 'POST', url: '/hooks/square', headers: n.headers, payload: n.rawBody })
  const event = (id: string, o: { type?: string; merchant?: string; objectId?: string } = {}) => ({
    merchant_id: o.merchant ?? 'MSIMOASIS0001',
    location_id: 'LSIMTEST0001',
    type: o.type ?? 'payment.updated',
    event_id: id,
    created_at: '2026-06-13T14:30:00Z',
    data: { type: 'payment', id: o.objectId ?? 'PAY1', object: { payment: { id: o.objectId ?? 'PAY1', amount_money: { amount: 999999, currency: 'USD' } } } },
  })
  const logRows = (app: TestApp) => app.db.selectFrom('webhook_log').selectAll().where('provider', '=', 'square').execute()

  it('accepts a signed event: claims it, keeps the body and headers without the signature, queues the job, answers 200', async () => {
    const q = fakeJobs()
    const app = await appWith({ jobs: q.jobs })
    const n = signed(event('evt-1'))
    const res = await post(app, n)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({ status: 'accepted' })
    const rows = await logRows(app)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ provider: 'square', external_id: 'evt-1', status: 'received', signature_valid: true, body: n.rawBody })
    expect(JSON.stringify(rows[0]!.headers)).not.toMatch(/hmacsha256|signature/i)
    expect(rows[0]!.headers).toMatchObject({ source: 'webhook', key: 'current', 'square-environment': 'Sandbox' })
    expect(q.calls).toEqual([{ name: 'square.event.process', data: { eventId: 'evt-1' }, opts: { singletonKey: 'evt-1' } }])
    const state = await app.db.selectFrom('square_state').selectAll().executeTakeFirstOrThrow()
    expect(state.last_webhook_at?.toISOString()).toBe(app.clock.now().toISOString())
    // the same event again (Square retries, a replay): 200, nothing new
    const dup = await post(app, n)
    expect(dup.statusCode).toBe(200)
    expect(dup.json()).toEqual({ status: 'duplicate' })
    expect(await logRows(app)).toHaveLength(1)
    expect(q.calls).toHaveLength(1)
    await app.close()
  })

  it('accepts the previous key during a rotation; refuses a wrong key, a wrong URL, a tampered body and a missing signature (401, nothing kept)', async () => {
    const q = fakeJobs()
    const app = await appWith({ jobs: q.jobs, env: { SQUARE_WEBHOOK_SIGNATURE_KEY_PREVIOUS: HOOK_KEY_PREVIOUS } })
    const prev = await post(app, signed(event('evt-prev'), { key: HOOK_KEY_PREVIOUS }))
    expect(prev.statusCode, prev.body).toBe(200)
    expect((await logRows(app))[0]!.headers).toMatchObject({ key: 'previous' })
    for (const n of [
      signed(event('evt-x'), { key: 'some-other-key-000' }),
      signed(event('evt-x'), { url: 'https://evil.example.com/hooks/square' }),
      { ...signed(event('evt-x')), rawBody: JSON.stringify(event('evt-x', { objectId: 'PAY2' })) },
      { rawBody: JSON.stringify(event('evt-x')), headers: { 'content-type': 'application/json' } },
    ]) {
      const r = await post(app, n)
      expect(r.statusCode).toBe(401)
      expect(r.json()).toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' })
    }
    expect(await logRows(app)).toHaveLength(1)
    expect(q.calls).toHaveLength(1)
    await app.close()
  })

  it('with no webhook key or URL configured nothing verifies (the defaults keep the hook closed)', async () => {
    const app = await createTestApp({ testDb: t, hookModules: [squareHookModule] })
    const r = await post(app, signed(event('evt-1')))
    expect(r.statusCode).toBe(401)
    expect(await logRows(app)).toHaveLength(0)
    await app.close()
  })

  it('a queue that refuses the job releases the claim and answers 503, so Square retries and the retry is accepted', async () => {
    const down = fakeJobs({ fail: true })
    const app = await appWith({ jobs: down.jobs })
    const n = signed(event('evt-503'))
    const r = await post(app, n)
    expect(r.statusCode).toBe(503)
    expect(await logRows(app)).toHaveLength(0)
    await app.close()
    const up = fakeJobs()
    const app2 = await appWith({ jobs: up.jobs })
    expect((await post(app2, n)).statusCode).toBe(200)
    expect(await logRows(app2)).toHaveLength(1)
    expect(up.calls).toHaveLength(1)
    await app2.close()
  })

  it('an event of another merchant is acknowledged and dropped once the merchant is known', async () => {
    const q = fakeJobs()
    const app = await appWith({ jobs: q.jobs })
    await saveSquareState(app.db, app.location.id, app.env, app.clock.now(), { merchant_id: 'MOURS0001' })
    const r = await post(app, signed(event('evt-foreign', { merchant: 'MSOMEONEELSE' })))
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ status: 'ignored' })
    expect(await logRows(app)).toHaveLength(0)
    expect(q.calls).toHaveLength(0)
    expect((await post(app, signed(event('evt-ours', { merchant: 'MOURS0001' })))).json()).toEqual({ status: 'accepted' })
    await app.close()
  })

  it('a signed body that is not a Square event is a 400', async () => {
    const app = await appWith({ jobs: fakeJobs().jobs })
    const r = await post(app, signed({ hello: 'world' }))
    expect(r.statusCode).toBe(400)
    await app.close()
  })

  it('without a queue the event is processed at once: the object is re-fetched from Square, not read from the payload', async () => {
    const sim = simFor(t.clock)
    const seen: unknown[] = []
    const app = await appWith({ jobs: null })
    runtime({
      env: app.env,
      api: sim.api,
      ingest: {
        payment: async (_c, p) => {
          seen.push(p.amount_money)
          return { status: 'processed' }
        },
        refund: async () => ({ status: 'processed' }),
        invoice: async () => ({ status: 'processed' }),
        subscription: async () => ({ status: 'processed' }),
        card: async () => ({ status: 'processed' }),
        customer: async () => ({ status: 'processed' }),
      },
    })
    const p = await sim.api.payments.create(sqKey('ch', 'inline'), { source_id: 'cnon:card-nonce-ok', amount_money: usd(4000), location_id: 'LSIMTEST0001' })
    const r = await post(app, signed(event('evt-inline', { objectId: p.id })))
    expect(r.statusCode, r.body).toBe(200)
    expect(seen).toEqual([usd(4000)]) // not the 999999 of the payload
    expect((await logRows(app))[0]).toMatchObject({ status: 'processed', error: null })
    await app.close()
  })
})
