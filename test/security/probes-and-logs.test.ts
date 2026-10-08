// The readiness and liveness probes tell the details (database error text, migration names, queue state) only to the server
// itself, and the request log never carries a link token or what someone typed into a search box.
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { loadEnv } from '../../src/config/env.js'
import { access } from '../../src/http/access.js'
import { createDenyAuthorizer } from '../../src/http/authorizer.js'
import type { ApiModule } from '../../src/http/modules.js'
import { isLoopbackCaller } from '../../src/http/routes/health.js'
import { FixedClock } from '../../src/platform/clock.js'
import { createDb } from '../../src/platform/db.js'
import { redactUrl } from '../../src/platform/logging.js'
import { useTestDb } from '../helpers/db.js'
import { createTestApp, type TestApp } from '../helpers/app.js'

const t = useTestDb()
let ctx: TestApp | undefined
afterEach(async () => {
  await ctx?.close()
  ctx = undefined
})

const demo: ApiModule = (app) => {
  app.get('/customers', { config: { access: access.authenticated() } }, async () => ({ items: [] }))
  app.post('/auth/password/reset', { config: { access: access.public('test') } }, async () => ({ ok: true }))
}

const start = async (): Promise<TestApp> => {
  ctx = await createTestApp({ testDb: t, modules: [demo] })
  return ctx
}

describe('/readyz and /healthz details', () => {
  it('answer the full body to the server itself', async () => {
    const { app } = await start()
    const ready = await app.inject({ url: '/readyz' })
    expect(ready.json()).toMatchObject({
      status: 'ready',
      checks: { db: { ok: true }, migrations: { ok: true } },
    })
    const health = await app.inject({ url: '/healthz' })
    expect(health.json()).toMatchObject({ status: 'ok', checks: { db: { ok: true } } })
  })

  it('answer only {status} to anyone else, directly or through a proxy', async () => {
    const { app } = await start()
    for (const o of [
      { remoteAddress: '203.0.113.9' },
      { headers: { 'x-forwarded-for': '203.0.113.9' } },
      { headers: { 'x-real-ip': '198.51.100.3' } },
      { headers: { forwarded: 'for="[2001:db8::1]:4711";proto=https' } },
      { headers: { 'x-forwarded-for': '127.0.0.1, 203.0.113.9' } },
    ]) {
      const ready = await app.inject({ url: '/readyz', ...o })
      expect(ready.statusCode, JSON.stringify(o)).toBe(200)
      expect(ready.json(), JSON.stringify(o)).toEqual({ status: 'ready' })
      expect((await app.inject({ url: '/healthz', ...o })).json()).toEqual({ status: 'ok' })
    }
  })

  it('keeps the status code when the database is down, without its error text', async () => {
    const dead = createDb({ url: 'postgres://oasis:x@127.0.0.1:1/none', poolMax: 1 })
    try {
      const app = await buildApp({
        env: loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x' }),
        db: dead,
        clock: new FixedClock('2026-06-13T14:36:00Z'),
        authorizer: createDenyAuthorizer(),
        modules: [],
        hookModules: [],
        logStream: { write: () => undefined },
      })
      const outside = await app.inject({ url: '/readyz', remoteAddress: '203.0.113.9' })
      expect(outside.statusCode).toBe(503)
      expect(outside.json()).toEqual({ status: 'degraded' })
      const local = await app.inject({ url: '/readyz' })
      expect(local.json().checks.db.ok).toBe(false)
      expect((await app.inject({ url: '/healthz', remoteAddress: '203.0.113.9' })).json()).toEqual({
        status: 'degraded',
      })
      await app.close()
    } finally {
      await dead.destroy()
    }
  })

  it('treat loopback through a local proxy as the server itself', () => {
    const req = (remote: string, headers: Record<string, string> = {}) =>
      ({ socket: { remoteAddress: remote }, headers }) as never
    expect(isLoopbackCaller(req('127.0.0.1'))).toBe(true)
    expect(isLoopbackCaller(req('::1'))).toBe(true)
    expect(isLoopbackCaller(req('::ffff:127.0.0.1', { 'x-forwarded-for': '127.0.0.1' }))).toBe(true)
    expect(isLoopbackCaller(req('127.0.0.1', { forwarded: 'for=127.0.0.1:5000' }))).toBe(true)
    expect(isLoopbackCaller(req('127.0.0.1', { forwarded: 'for="[::1]:5000"' }))).toBe(true)
    expect(isLoopbackCaller(req('10.0.0.2'))).toBe(false)
    expect(isLoopbackCaller(req('127.0.0.1', { 'x-forwarded-for': '10.1.2.3' }))).toBe(false)
  })
})

describe('request logging', () => {
  const token = 'Qv3x9LmT0aZ_r8sWkP2yH5nB7cD1eF4gJ6hK8iL0mN2'

  it('never writes link tokens or search terms', async () => {
    const { app, logs } = await start()
    await app.inject({ url: `/a/${token}` })
    await app.inject({ url: `/invite?token=${token}` })
    await app.inject({ url: `/reset-password/${token}` })
    await app.inject({ url: '/api/v1/customers?q=Maria%20Delgado%20305-555-0102&limit=8' })
    await app.inject({ url: '/api/v1/ops/snapshot?window=today&q=KLP-8842' })
    await app.inject({ url: `/api/v1/payments/invoices?range=7d&q=${encodeURIComponent('Liam Chen')}` })
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset',
      payload: { token, password: 'a long new password' },
      headers: { origin: 'http://localhost:3000' },
    })
    const text = JSON.stringify(logs)
    expect(logs.some((l) => l.msg === 'incoming request')).toBe(true)
    for (const secret of [
      token,
      token.slice(0, 20),
      'Maria',
      'Delgado',
      '0102',
      'KLP-8842',
      'Liam',
      'a long new password',
    ])
      expect(text, secret).not.toContain(secret)
    const urls = logs.flatMap((l) =>
      (l.req as { url?: string } | undefined)?.url ? [(l.req as { url: string }).url] : [],
    )
    expect(urls).toEqual(
      expect.arrayContaining([
        '/a/[redacted]',
        '/invite?token=%5Bredacted%5D',
        '/reset-password/[redacted]',
        '/api/v1/customers?q=%5Bredacted%5D&limit=8',
        '/api/v1/ops/snapshot?window=today&q=%5Bredacted%5D',
      ]),
    )
  })

  it('keeps ids and ordinary paths readable', () => {
    expect(redactUrl('/api/v1/appointments/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/advance')).toBe(
      '/api/v1/appointments/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/advance',
    )
    expect(redactUrl('/api/v1/employees/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/invite/resend')).toBe(
      '/api/v1/employees/0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b/invite/resend',
    )
    expect(redactUrl('/api/v1/integrations/squarespace/customer-links/5f8a3b2c1d0e9f8a7b6c5d4e')).toBe(
      '/api/v1/integrations/squarespace/customer-links/5f8a3b2c1d0e9f8a7b6c5d4e',
    )
    expect(redactUrl('/api/v1/payments/invoices?range=7d&filter=all')).toBe(
      '/api/v1/payments/invoices?range=7d&filter=all',
    )
  })
})
