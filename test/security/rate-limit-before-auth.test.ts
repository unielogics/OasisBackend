// SEC-14: the global rate limit used to run in preHandler, after authentication, so a flood of requests that end in 401 or 403
// was never counted. It now runs before the 401/403 decision (per signed-in user, per address otherwise), with a coarser
// per-address ceiling ahead of authentication itself. Per-route limits (sign-in, events, arrival ping) are unchanged.
import type { InjectOptions } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { access } from '../../src/http/access.js'
import type { ApiModule } from '../../src/http/modules.js'
import { PRE_AUTH_IP_FACTOR } from '../../src/http/rate-limit.js'
import { useTestDb } from '../helpers/db.js'
import { createTestApp, type TestApp } from '../helpers/app.js'

const t = useTestDb()
let ctx: TestApp | undefined
afterEach(async () => {
  await ctx?.close()
  ctx = undefined
})

const demo: ApiModule = (app) => {
  app.get('/demo/me', { config: { access: access.authenticated() } }, async (req) => ({
    user: req.auth!.userId,
  }))
  app.get('/demo/refunds', { config: { access: access.perm('pay.refund') } }, async () => ({ ok: true }))
  app.get('/demo/open', { config: { access: access.public('test') } }, async () => ({ ok: true }))
  app.post(
    '/demo/signin',
    { config: { access: access.public('test'), rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async () => ({ ok: true }),
  )
}

const start = async (perMin: number): Promise<TestApp> => {
  ctx = await createTestApp({ testDb: t, modules: [demo], env: { RATE_LIMIT_PER_MIN: String(perMin) } })
  return ctx
}

const hit = (app: TestApp['app'], o: InjectOptions) => app.inject(o)

describe('SEC-14 rate limiting before authentication', () => {
  it('throttles a flood of unauthenticated requests (401) once the budget is spent', async () => {
    const { app } = await start(3)
    const anon = {
      url: '/api/v1/demo/me',
      headers: { 'x-test-anonymous': '1' },
      remoteAddress: '203.0.113.7',
    }
    const codes: number[] = []
    for (let i = 0; i < 5; i++) codes.push((await hit(app, anon)).statusCode)
    expect(codes).toEqual([401, 401, 401, 429, 429])
    const res = await hit(app, anon)
    expect(res.json()).toMatchObject({ code: 'RATE_LIMITED', status: 429 })
    expect(res.headers['retry-after']).toBeDefined()
  })

  it('throttles a flood of forbidden requests (403) per signed-in user', async () => {
    const { app } = await start(3)
    const denied = {
      url: '/api/v1/demo/refunds',
      headers: { 'x-test-permissions': 'sched.view', 'x-test-user': '00000000-0000-7000-8000-0000000000b1' },
    }
    const codes: number[] = []
    for (let i = 0; i < 5; i++) codes.push((await hit(app, denied)).statusCode)
    expect(codes).toEqual([403, 403, 403, 429, 429])
    // another person on the same address keeps their own budget
    const other = await hit(app, {
      url: '/api/v1/demo/me',
      headers: { 'x-test-user': '00000000-0000-7000-8000-0000000000b2' },
    })
    expect(other.statusCode).toBe(200)
  })

  it('an anonymous flood from one address does not spend a signed-in user’s budget elsewhere', async () => {
    const { app } = await start(3)
    for (let i = 0; i < 6; i++)
      await hit(app, {
        url: '/api/v1/demo/me',
        headers: { 'x-test-anonymous': '1' },
        remoteAddress: '198.51.100.9',
      })
    expect((await hit(app, { url: '/api/v1/demo/me', remoteAddress: '192.0.2.44' })).statusCode).toBe(200)
  })

  it('caps one address across many users before authentication runs', async () => {
    const { app } = await start(3)
    const ceiling = 3 * PRE_AUTH_IP_FACTOR
    const codes: number[] = []
    for (let i = 0; i <= ceiling; i++)
      codes.push(
        (
          await hit(app, {
            url: '/api/v1/demo/me',
            headers: { 'x-test-user': `00000000-0000-7000-8000-${String(i).padStart(12, '0')}` },
            remoteAddress: '203.0.113.50',
          })
        ).statusCode,
      )
    expect(codes.slice(0, ceiling).every((c) => c === 200)).toBe(true)
    expect(codes[ceiling]).toBe(429)
  })

  it('leaves per-route limits as they were and still limits public routes per address', async () => {
    const { app } = await start(3)
    const signin: number[] = []
    for (let i = 0; i < 6; i++)
      signin.push(
        (await hit(app, { method: 'POST', url: '/api/v1/demo/signin', remoteAddress: '203.0.113.60' }))
          .statusCode,
      )
    expect(signin).toEqual([200, 200, 200, 200, 200, 429]) // its own 5 a minute, not the global 3
    const open: number[] = []
    for (let i = 0; i < 4; i++)
      open.push((await hit(app, { url: '/api/v1/demo/open', remoteAddress: '203.0.113.61' })).statusCode)
    expect(open).toEqual([200, 200, 200, 429])
  })

  it('never limits the probes', async () => {
    const { app } = await start(1)
    for (let i = 0; i < 10; i++) expect((await hit(app, { url: '/healthz' })).statusCode).toBe(200)
  })
})
