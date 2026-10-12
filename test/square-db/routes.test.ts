// GET /integrations/square, POST /integrations/square/test and the 'square' row of GET /system/integrations.
import { describe, expect, it } from 'vitest'
import { squareModule } from '../../src/modules/square/http/module.js'
import { systemModule } from '../../src/modules/system/index.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { useTestDb } from '../helpers/db.js'
import { HOOK_URL, liveEnvVars, simFor, useSquareRuntime } from './helpers.js'
import { SQUARE_EVENT_TYPES } from '../../src/integrations/square/webhook.js'

describe('Square routes', () => {
  const t = useTestDb()
  const runtime = useSquareRuntime()
  const appWith = (env: Record<string, string> = {}): Promise<TestApp> => createTestApp({ testDb: t, modules: [squareModule, systemModule], env })
  const testConn = (app: TestApp) => app.app.inject({ method: 'POST', url: '/api/v1/integrations/square/test', payload: {} })

  it('Test connection with every check passing stores the merchant, enables events, verifies the subscription and is audited', async () => {
    const app = await appWith(liveEnvVars)
    const sim = simFor(t.clock)
    sim.sim.addWebhookSubscription({ url: HOOK_URL, signatureKey: 'k-0000000000' })
    runtime({ env: app.env, api: sim.api })
    const res = await testConn(app)
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ ok: true, environment: 'sandbox', locationId: 'LSIMTEST0001', merchantId: sim.store.merchantId })
    expect(body.checks.map((c: { key: string; ok: boolean }) => [c.key, c.ok])).toEqual([
      ['token', true],
      ['location', true],
      ['events', true],
      ['webhook', true],
    ])
    expect(sim.store.eventsEnabled).toBe(true)
    const state = await app.db.selectFrom('square_state').selectAll().executeTakeFirstOrThrow()
    expect(state).toMatchObject({ merchant_id: sim.store.merchantId, square_location_id: 'LSIMTEST0001', environment: 'sandbox' })
    expect(state.events_enabled_at).not.toBeNull()
    expect(state.webhook_subscription_id).toMatch(/^wbhk_/)
    const audit = await app.db.selectFrom('audit_log').select(['action', 'entity_id', 'after']).where('action', '=', 'square.test_connection').execute()
    expect(audit).toHaveLength(1)
    expect(JSON.stringify(audit[0]!.after)).not.toMatch(/token-not-real|signature/)
    const view = await app.app.inject({ method: 'GET', url: '/api/v1/integrations/square' })
    expect(view.statusCode, view.body).toBe(200)
    expect(view.json()).toMatchObject({ lastTest: { ok: true }, eventTypes: [...SQUARE_EVENT_TYPES], catchup: { watermark: null, lastEvents: 0 }, reconcile: null })
    expect(view.body).not.toContain('test-token-not-real')
    await app.close()
  })

  it('a failing check is a 200 with ok false and a plain reason: no subscription, a subscription lacking types, a wrong location, a refused token', async () => {
    const app = await appWith(liveEnvVars)
    const sim = simFor(t.clock)
    runtime({ env: app.env, api: sim.api })
    let body = (await testConn(app)).json()
    expect(body.ok).toBe(false)
    expect(body.checks.find((c: { key: string }) => c.key === 'webhook').detail).toMatch(/no webhook subscription for .*pnpm square:webhooks --apply/)
    sim.sim.addWebhookSubscription({ url: HOOK_URL, signatureKey: 'k-0000000000', eventTypes: ['payment.updated'] })
    body = (await testConn(app)).json()
    expect(body.checks.find((c: { key: string }) => c.key === 'webhook').detail).toMatch(/lacks .*refund\.created/)
    const state = await app.db.selectFrom('square_state').selectAll().executeTakeFirstOrThrow()
    expect(state.webhook_subscription_id).toBeNull()
    expect(state.last_error).toMatch(/^test connection: /)
    await app.close()
    const other = await appWith({ ...liveEnvVars, SQUARE_LOCATION_ID: 'LNOTOURS' })
    runtime({ env: other.env, api: sim.api })
    body = (await testConn(other)).json()
    expect(body.checks.find((c: { key: string }) => c.key === 'location')).toMatchObject({ ok: false, detail: expect.stringMatching(/LNOTOURS is not among/) })
    await other.close()
    const badToken = await appWith(liveEnvVars)
    const { createSquareApi } = await import('../../src/integrations/square/api/index.js')
    const { SquareClient } = await import('../../src/integrations/square/client.js')
    const { simFetch } = await import('../../src/integrations/square/sim/index.js')
    runtime({ env: badToken.env, api: createSquareApi(new SquareClient({ baseUrl: 'http://sim', accessToken: 'wrong-token-0000', fetch: simFetch(sim.sim), maxAttempts: 1 })) })
    body = (await testConn(badToken)).json()
    expect(body).toMatchObject({ ok: false, checks: [{ key: 'token', ok: false, detail: expect.stringMatching(/refused the access token/) }] })
    expect(JSON.stringify(body)).not.toContain('wrong-token-0000')
    await badToken.close()
  })

  it('with the defaults Test connection talks to the in-process simulator only and says what is missing', async () => {
    const app = await appWith()
    const res = await testConn(app)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ ok: false, environment: 'sim', locationId: 'LSIMOASIS0001' })
    expect(res.json().checks.find((c: { key: string }) => c.key === 'webhook').detail).toBe('SQUARE_WEBHOOK_URL is not set')
    await app.close()
  })

  it("the status row: missing settings with the defaults; live, configured and warnings once tested", async () => {
    const app = await appWith()
    const row = (await app.app.inject({ method: 'GET', url: '/api/v1/system/integrations' })).json().integrations.find((i: { key: string }) => i.key === 'square')
    expect(row).toMatchObject({ key: 'square', provider: 'sim', live: false, configured: false })
    expect(row.missing).toEqual(expect.arrayContaining(['SQUARE_PROVIDER=live', 'SQUARE_ACCESS_TOKEN', 'SQUARE_WEBHOOK_URL']))
    expect(row.missing.some((m: string) => m.startsWith('Events API not enabled'))).toBe(true)
    expect(row.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/observe-only/), expect.stringMatching(/PAYMENT_PROCESSOR=squarespace/)]))
    expect(row.details).toMatchObject({ token: 'not set', processor: 'squarespace', unmatched: 0, failedRefunds: 0, pendingEnrollments: null })
    await app.close()
    const live = await appWith(liveEnvVars)
    const sim = simFor(t.clock)
    sim.sim.addWebhookSubscription({ url: HOOK_URL, signatureKey: 'k-0000000000' })
    runtime({ env: live.env, api: sim.api })
    await testConn(live)
    const r2 = (await live.app.inject({ method: 'GET', url: '/api/v1/system/integrations' })).json().integrations.find((i: { key: string }) => i.key === 'square')
    expect(r2).toMatchObject({ live: true, configured: true, missing: [], lastError: null })
    expect(r2.details).toMatchObject({ token: 'set', webhookKey: 'set', merchant: sim.store.merchantId, webhookSubscription: 'verified' })
    expect(r2.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/sandbox/), expect.stringMatching(/catch-up has not run/)]))
    expect(JSON.stringify(r2)).not.toMatch(/test-token-not-real|sq-test-signature/)
    await live.close()
  })

  it('what Test connection learned from the simulator does not count once live: the status row and the view start afresh', async () => {
    const simApp = await appWith()
    expect((await testConn(simApp)).json()).toMatchObject({ environment: 'sim', merchantId: 'MSIMOASIS0001' })
    const learned = await simApp.db.selectFrom('square_state').selectAll().executeTakeFirstOrThrow()
    expect(learned).toMatchObject({ environment: 'sim', merchant_id: 'MSIMOASIS0001' })
    expect(learned.events_enabled_at).not.toBeNull()
    await simApp.close()
    const live = await appWith({ ...liveEnvVars, SQUARE_ENVIRONMENT: 'production' })
    const row = (await live.app.inject({ method: 'GET', url: '/api/v1/system/integrations' })).json().integrations.find((i: { key: string }) => i.key === 'square')
    expect(row.missing.some((m: string) => m.startsWith('Events API not enabled'))).toBe(true)
    expect(row.details).toMatchObject({ merchant: null, eventsEnabledAt: null, webhookSubscription: null, lastTestOk: null })
    const view = (await live.app.inject({ method: 'GET', url: '/api/v1/integrations/square' })).json()
    expect(view).toMatchObject({ lastTest: null, catchup: { watermark: null, lastRunAt: null } })
    // a failed Test connection against production (the location check fails, no merchant learned) leaves no simulator fact behind
    const sim = simFor(t.clock)
    const other = await appWith({ ...liveEnvVars, SQUARE_ENVIRONMENT: 'production', SQUARE_LOCATION_ID: 'LNOTOURS' })
    runtime({ env: other.env, api: sim.api })
    expect((await testConn(other)).json()).toMatchObject({ ok: false, environment: 'production' })
    const after = await other.db.selectFrom('square_state').selectAll().executeTakeFirstOrThrow()
    expect(after.environment).toBe('production')
    expect(after).toMatchObject({ merchant_id: null, webhook_subscription_id: null })
    await other.close()
    await live.close()
  })
})
