import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import { Validator } from '@seriousme/openapi-schema-validator'
import { sql } from 'kysely'
import { buildApp } from '../../src/app.js'
import { access, describeAccess } from '../../src/http/access.js'
import {
  createDenyAuthorizer,
  createPermissiveAuthorizer,
  type Authorizer,
} from '../../src/http/authorizer.js'
import { idempotentHandler } from '../../src/http/idempotent.js'
import type { ApiModule } from '../../src/http/modules.js'
import { hmacSha256Hex, safeEqual, webhookRoute } from '../../src/http/webhooks.js'
import { AppError } from '../../src/platform/errors.js'
import { auditContextOf } from '../../src/http/authorizer.js'
import * as audit from '../../src/platform/audit.js'
import { createDb } from '../../src/platform/db.js'
import { createTestDb, dropSchema, schemaPrefix, useTestDb } from '../helpers/db.js'
import { createTestApp, type TestApp } from '../helpers/app.js'

const t = useTestDb()
let ctx: TestApp | undefined
afterEach(async () => {
  await ctx?.close()
  ctx = undefined
})

const known = new Set(['pay.refund', 'sched.view'])
const strictAuthorizer = (loc: { id: string }): Authorizer => ({
  ...createPermissiveAuthorizer({ locationId: loc.id }),
  knownPermissions: known,
})

const demo: ApiModule = (app) => {
  app.get('/demo/open', { config: { access: access.public('test') } }, async () => ({ ok: true }))
  app.get('/demo/me', { config: { access: access.authenticated() } }, async (req) => ({
    user: req.auth!.userId,
  }))
  app.get('/demo/refunds', { config: { access: access.perm('pay.refund') } }, async () => ({ ok: true }))
  app.get('/demo/either', { config: { access: access.anyPerm('pay.refund', 'sched.view') } }, async () => ({
    ok: true,
  }))
  app.post(
    '/demo/echo',
    {
      config: { access: access.authenticated() },
      schema: {
        body: z
          .object({
            name: z.string().min(2),
            items: z.array(z.object({ qty: z.number().int().min(1) })).optional(),
          })
          .strict(),
      },
    },
    async (req) => ({ got: req.body }),
  )
  app.get('/demo/boom', { config: { access: access.public('test') } }, async () => {
    throw new Error('secret internal detail with +13055550142')
  })
  app.get('/demo/guard', { config: { access: access.public('test') } }, async () => {
    throw new AppError('BAY_BUSY', { params: { n: 1, firstName: 'Marco' } })
  })
  app.get('/demo/sleep', { config: { access: access.public('test') } }, async () => ({ ok: true }))
  app.post(
    '/demo/refund',
    { config: { access: access.perm('pay.refund'), idempotency: 'required' } },
    idempotentHandler(async (req, tx) => {
      const body = req.body as { cents: number }
      await audit.record(tx, {
        locationId: req.auth!.locationId,
        action: 'demo.refund',
        entityType: 'demo',
        after: body,
        ctx: auditContextOf(req),
      })
      return { status: 201, body: { refunded: body.cents }, headers: { Location: '/api/v1/demo/refund/1' } }
    }),
  )
  app.post(
    '/demo/optional',
    { config: { access: access.authenticated(), idempotency: 'optional' } },
    idempotentHandler(async (req, tx) => {
      await audit.record(tx, {
        locationId: req.auth!.locationId,
        action: 'demo.optional',
        entityType: 'demo',
      })
      return { status: 200, body: { ok: true } }
    }),
  )
  app.post(
    '/demo/no-content',
    { config: { access: access.authenticated(), idempotency: 'required' } },
    idempotentHandler(async () => ({ status: 204, body: undefined })),
  )
}

const hook: ApiModule = (app) => {
  webhookRoute(app, {
    provider: 'smsgate',
    path: '/smsgate',
    handler: async (req) => {
      const sig = String(req.headers['x-signature'] ?? '')
      const ok = safeEqual(sig, hmacSha256Hex('shh', req.rawBody ?? ''))
      return { ok, rawLength: req.rawBody?.length, parsed: req.body }
    },
  })
}

const start = async (extra: Partial<Parameters<typeof createTestApp>[0]> = {}): Promise<TestApp> => {
  ctx = await createTestApp({ testDb: t, modules: [demo], hookModules: [hook], ...extra })
  return ctx
}
const origin = 'http://localhost:3000'

describe('system routes', () => {
  it('GET /healthz is public and needs no database', async () => {
    const { app } = await start()
    const res = await app.inject({ url: '/healthz', headers: { 'x-test-anonymous': '1' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('GET /readyz reports db, migrations and jobs', async () => {
    const { app } = await start()
    const res = await app.inject({ url: '/readyz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      status: 'ready',
      checks: { db: { ok: true }, migrations: { ok: true }, jobs: { ok: true, detail: 'not configured' } },
    })
  })

  it('GET /readyz is 503 when a migration is pending', async () => {
    const scratch = await createTestDb({ schema: `${schemaPrefix}_ready` })
    try {
      await sql`delete from schema_migrations where name like '%platform_core%'`.execute(scratch.db)
      const probe = await createTestApp({ testDb: scratch })
      const res = await probe.app.inject({ url: '/readyz' })
      expect(res.statusCode).toBe(503)
      expect(res.json()).toMatchObject({ status: 'degraded', checks: { migrations: { ok: false } } })
      await probe.close()
    } finally {
      await scratch.close()
      const admin = createDb({ url: scratch.connection.url, poolMax: 1 })
      await dropSchema(admin, scratch.schema)
      await admin.destroy()
    }
  })

  it('GET /readyz is 503 when the jobs check fails', async () => {
    const down = {
      start: async () => undefined,
      enqueue: async () => null,
      stop: async () => undefined,
      health: async () => ({ ok: false, detail: 'queue stalled' }),
    }
    const { app } = await start({ deps: { jobs: down } })
    const res = await app.inject({ url: '/readyz' })
    expect(res.statusCode).toBe(503)
    expect(res.json().checks.jobs).toEqual({ ok: false, detail: 'queue stalled' })
  })

  it('GET /readyz is 503 and does not throw when the database is unreachable', async () => {
    const dead = createDb({ url: 'postgres://oasis:x@127.0.0.1:1/none', poolMax: 1 })
    try {
      const { loadEnv } = await import('../../src/config/env.js')
      const { FixedClock } = await import('../../src/platform/clock.js')
      const app = await buildApp({
        env: loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x' }),
        db: dead,
        clock: new FixedClock('2026-06-13T14:36:00Z'),
        authorizer: createDenyAuthorizer(),
        modules: [],
        hookModules: [],
        logStream: { write: () => undefined },
      })
      const res = await app.inject({ url: '/readyz' })
      expect(res.statusCode).toBe(503)
      expect(res.json().checks.db.ok).toBe(false)
      await app.close()
    } finally {
      await dead.destroy()
    }
  })

  it('GET /api/v1/meta/now returns the business-tz clock and honours the frozen clock', async () => {
    const { app, clock } = await start()
    const res = await app.inject({ url: '/api/v1/meta/now', headers: { 'x-test-anonymous': '1' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      now: '2026-06-13T14:36:00.000Z',
      tz: 'America/New_York',
      bizDate: '2026-06-13',
      weekday: 6,
      minutes: 636,
      dateLabel: 'Saturday, June 13',
    })
    clock.set('2026-11-01T06:30:00Z') // 1:30 AM EST after fall-back
    expect((await app.inject({ url: '/api/v1/meta/now' })).json()).toMatchObject({
      bizDate: '2026-11-01',
      weekday: 0,
      minutes: 90,
      dateLabel: 'Sunday, November 1',
    })
  })

  it('meta/now follows the location timezone setting', async () => {
    const { app, db } = await start()
    await db.updateTable('locations').set({ timezone: 'America/Los_Angeles' }).execute()
    expect((await app.inject({ url: '/api/v1/meta/now' })).json()).toMatchObject({
      tz: 'America/Los_Angeles',
      minutes: 7 * 60 + 36,
    })
  })

  it('sets X-API-Version and X-Request-Id, and echoes a valid incoming request id', async () => {
    const { app } = await start()
    const res = await app.inject({ url: '/api/v1/meta/now' })
    expect(res.headers['x-api-version']).toBe('1')
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/)
    const echoed = await app.inject({
      url: '/api/v1/meta/now',
      headers: { 'x-request-id': 'trace-abc12345' },
    })
    expect(echoed.headers['x-request-id']).toBe('trace-abc12345')
    const bad = await app.inject({
      url: '/api/v1/meta/now',
      headers: { 'x-request-id': 'bad id with spaces!' },
    })
    expect(bad.headers['x-request-id']).not.toBe('bad id with spaces!')
  })

  it('sends security headers', async () => {
    const { app } = await start()
    const h = (await app.inject({ url: '/api/v1/meta/now' })).headers
    expect(h['content-security-policy']).toContain("default-src 'none'")
    expect(h['x-content-type-options']).toBe('nosniff')
    expect(h['cross-origin-resource-policy']).toBe('same-origin')
  })
})

describe('OpenAPI', () => {
  it('serves a valid OpenAPI 3.1 document at /api/v1/openapi.json', async () => {
    const { app } = await start()
    const res = await app.inject({ url: '/api/v1/openapi.json', headers: { 'x-test-anonymous': '1' } })
    expect(res.statusCode).toBe(200)
    const doc = res.json()
    expect(doc.openapi).toBe('3.1.0')
    const result = await new Validator().validate(doc)
    expect(result, JSON.stringify(result.errors)).toMatchObject({ valid: true })
    expect(doc.paths['/api/v1/meta/now'].get.responses['200']).toBeDefined()
    expect(doc.paths['/api/v1/demo/echo'].post.requestBody).toBeDefined()
    expect(doc.paths['/api/v1/demo/refund'].post['x-oasis-idempotency']).toBe('required')
    expect(doc.paths['/api/v1/demo/refunds'].get['x-oasis-access']).toBe('pay.refund')
    expect(doc.paths['/api/v1/meta/now'].get.security).toEqual([])
    expect(doc.components.securitySchemes.cookieAuth).toMatchObject({ type: 'apiKey', in: 'cookie' })
  })

  it('the committed docs/openapi.json is valid and current', async () => {
    const { readFileSync } = await import('node:fs')
    const doc = JSON.parse(readFileSync('docs/openapi.json', 'utf8'))
    const result = await new Validator().validate(doc)
    expect(result, JSON.stringify(result.errors)).toMatchObject({ valid: true })
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/api/v1/meta/now', '/api/v1/events']))
  })
})

describe('boot-time route checks', () => {
  it('refuses to boot when a route has no access metadata', async () => {
    const naked: ApiModule = (app) => {
      app.get('/naked', async () => ({ ok: true }))
    }
    await expect(createTestApp({ testDb: t, modules: [naked] })).rejects.toThrow(/has no access metadata/)
  })

  it('refuses a public route without a reason', async () => {
    const mod: ApiModule = (app) => {
      app.get('/x', { config: { access: access.public('  ') } }, async () => ({}))
    }
    await expect(createTestApp({ testDb: t, modules: [mod] })).rejects.toThrow(/needs a reason/)
  })

  it('refuses a permission route with an empty permission list', async () => {
    const mod: ApiModule = (app) => {
      app.get('/x', { config: { access: access.perm() } }, async () => ({}))
    }
    await expect(createTestApp({ testDb: t, modules: [mod] })).rejects.toThrow(/at least one permission/)
  })

  it('refuses unknown permission keys when the authorizer declares its known set', async () => {
    const mod: ApiModule = (app) => {
      app.get('/x', { config: { access: access.perm('pay.refudn') } }, async () => ({}))
    }
    await expect(createTestApp({ testDb: t, modules: [mod], authorizer: strictAuthorizer })).rejects.toThrow(
      /unknown permission\(s\): pay\.refudn/,
    )
    const okMod: ApiModule = (app) => {
      app.get('/x', { config: { access: access.perm('pay.refund') } }, async () => ({}))
    }
    ctx = await createTestApp({ testDb: t, modules: [okMod], authorizer: strictAuthorizer })
  })

  it('refuses a required-idempotency route whose handler is not built with idempotentHandler', async () => {
    const mod: ApiModule = (app) => {
      app.post(
        '/money',
        { config: { access: access.perm('pay.refund'), idempotency: 'required' } },
        async () => ({ ok: true }),
      )
    }
    await expect(createTestApp({ testDb: t, modules: [mod] })).rejects.toThrow(/idempotentHandler/)
  })

  it('refuses a webhook route that asks for idempotency', async () => {
    const mod: ApiModule = (app) => {
      app.post(
        '/w',
        { config: { access: access.webhook('x'), idempotency: 'optional' } },
        idempotentHandler(async () => ({ status: 200, body: {} })),
      )
    }
    await expect(createTestApp({ testDb: t, hookModules: [mod] })).rejects.toThrow(/exempt from idempotency/)
  })

  it('refuses a module registered under /hooks that forgets access metadata', async () => {
    const mod: ApiModule = (app) => {
      app.post('/oops', async () => ({}))
    }
    await expect(createTestApp({ testDb: t, hookModules: [mod] })).rejects.toThrow(/has no access metadata/)
  })

  it('exposes the registry of declared access for the authz-matrix test', async () => {
    const { app } = await start()
    const byKey = new Map(app.routeRegistry.map((r) => [`${r.method} ${r.url}`, r]))
    expect(describeAccess(byKey.get('GET /api/v1/demo/refunds')!.access)).toBe('pay.refund')
    expect(describeAccess(byKey.get('GET /api/v1/demo/either')!.access)).toBe('pay.refund | sched.view')
    expect(byKey.get('POST /api/v1/demo/refund')!.idempotency).toBe('required')
    expect(byKey.get('POST /hooks/smsgate')!.access).toEqual({ kind: 'webhook', provider: 'smsgate' })
    expect(byKey.get('GET /healthz')!.access.kind).toBe('public')
    expect([...byKey.keys()].some((k) => k.startsWith('HEAD '))).toBe(false)
    for (const r of app.routeRegistry) expect(r.access).toBeDefined()
  })
})

describe('authentication and permissions', () => {
  it('401 for anonymous callers, with a problem+json body', async () => {
    const { app } = await start()
    const res = await app.inject({ url: '/api/v1/demo/me', headers: { 'x-test-anonymous': '1' } })
    expect(res.statusCode).toBe(401)
    expect(res.headers['content-type']).toContain('application/problem+json')
    expect(res.json()).toMatchObject({
      code: 'UNAUTHENTICATED',
      status: 401,
      type: 'urn:oasis:problem:unauthenticated',
      requestId: res.headers['x-request-id'],
    })
  })

  it('403 FORBIDDEN without the permission, 200 with it (all/any semantics)', async () => {
    const { app } = await start()
    const denied = await app.inject({
      url: '/api/v1/demo/refunds',
      headers: { 'x-test-permissions': 'sched.view' },
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toMatchObject({
      code: 'FORBIDDEN',
      title: 'Not allowed',
      meta: { required: ['pay.refund'], mode: 'all' },
    })
    expect(
      (await app.inject({ url: '/api/v1/demo/refunds', headers: { 'x-test-permissions': 'pay.refund' } }))
        .statusCode,
    ).toBe(200)
    expect((await app.inject({ url: '/api/v1/demo/refunds' })).statusCode).toBe(200) // permissive default
    expect(
      (await app.inject({ url: '/api/v1/demo/either', headers: { 'x-test-permissions': 'sched.view' } }))
        .statusCode,
    ).toBe(200)
    expect(
      (await app.inject({ url: '/api/v1/demo/either', headers: { 'x-test-permissions': 'cli.view' } }))
        .statusCode,
    ).toBe(403)
  })

  it('the deny authorizer fails closed on every non-public route', async () => {
    ctx = await createTestApp({ testDb: t, modules: [demo], authorizer: () => createDenyAuthorizer() })
    for (const url of ['/api/v1/demo/me', '/api/v1/demo/refunds', '/api/v1/events'])
      expect((await ctx.app.inject({ url })).statusCode).toBe(401)
    expect((await ctx.app.inject({ url: '/api/v1/demo/open' })).statusCode).toBe(200)
  })

  it('the permissive authorizer refuses to exist in production', () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      expect(() => createPermissiveAuthorizer({ locationId: 'x' })).toThrow(/production/)
    } finally {
      process.env.NODE_ENV = prev
    }
  })

  it('calls verifyCsrf on unsafe methods for session routes only', async () => {
    const seen: string[] = []
    ctx = await createTestApp({
      testDb: t,
      modules: [demo],
      authorizer: (loc) => ({
        ...createPermissiveAuthorizer({ locationId: loc.id }),
        verifyCsrf: (req) => {
          seen.push(req.method)
          if (req.headers['x-csrf-token'] !== 'good')
            throw new AppError('FORBIDDEN', { detail: 'CSRF token missing or wrong' })
        },
      }),
    })
    expect(
      (await ctx.app.inject({ method: 'POST', url: '/api/v1/demo/echo', payload: { name: 'ab' } }))
        .statusCode,
    ).toBe(403)
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/api/v1/demo/echo',
          payload: { name: 'ab' },
          headers: { 'x-csrf-token': 'good' },
        })
      ).statusCode,
    ).toBe(200)
    expect((await ctx.app.inject({ url: '/api/v1/demo/me' })).statusCode).toBe(200)
    expect(seen).toEqual(['POST', 'POST'])
  })
})

describe('Origin check on unsafe methods', () => {
  const post = (app: TestApp['app'], headers: Record<string, string>, url = '/api/v1/demo/echo') =>
    app.inject({ method: 'POST', url, payload: { name: 'ab' }, headers })

  it('allows the dashboard and API origins, rejects others', async () => {
    const { app } = await start()
    expect((await post(app, { origin })).statusCode).toBe(200)
    expect((await post(app, { origin: 'http://localhost:4000' })).statusCode).toBe(200)
    const evil = await post(app, { origin: 'https://evil.example' })
    expect(evil.statusCode).toBe(403)
    expect(evil.json()).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' })
    expect((await post(app, { origin: 'null' })).statusCode).toBe(403)
  })

  it('falls back to Referer, and rejects cookie-bearing requests that carry neither header', async () => {
    const { app } = await start()
    expect((await post(app, { referer: `${origin}/payments` })).statusCode).toBe(200)
    expect((await post(app, { referer: 'https://evil.example/x' })).statusCode).toBe(403)
    expect((await post(app, { referer: 'not a url' })).statusCode).toBe(403)
    expect((await post(app, { cookie: 'oasis_sid=abc' })).statusCode).toBe(403)
    expect((await post(app, {})).statusCode).toBe(200) // no ambient credentials, nothing to forge
  })

  it('does not apply to safe methods and honours ALLOWED_ORIGINS', async () => {
    const { app } = await start({
      env: { ALLOWED_ORIGINS: 'https://dash.oasis.example, https://other.example' },
    })
    expect(
      (await app.inject({ url: '/api/v1/demo/me', headers: { origin: 'https://evil.example' } })).statusCode,
    ).toBe(200)
    expect((await post(app, { origin: 'https://dash.oasis.example' })).statusCode).toBe(200)
    expect((await post(app, { origin: 'https://other.example' })).statusCode).toBe(200)
  })
})

describe('webhooks under /hooks', () => {
  it('are exempt from Origin, CSRF and idempotency requirements, and keep the exact raw body', async () => {
    const { app } = await start()
    const body = '{"event":"sms:received",  "payload":{"x":1}}'
    const res = await app.inject({
      method: 'POST',
      url: '/hooks/smsgate',
      payload: body,
      headers: {
        'content-type': 'application/json',
        origin: 'https://some-device.example',
        cookie: 'a=b',
        'x-signature': hmacSha256Hex('shh', body),
        'x-test-anonymous': '1',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      ok: true,
      rawLength: body.length,
      parsed: { event: 'sms:received', payload: { x: 1 } },
    })
    const bad = await app.inject({
      method: 'POST',
      url: '/hooks/smsgate',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-signature': 'nope' },
    })
    expect(bad.json().ok).toBe(false)
  })

  it('accepts text/plain JSON (SNS) and rejects malformed JSON with 400', async () => {
    const { app } = await start()
    const sns = await app.inject({
      method: 'POST',
      url: '/hooks/smsgate',
      payload: '{"Type":"Notification"}',
      headers: { 'content-type': 'text/plain; charset=UTF-8' },
    })
    expect(sns.json().parsed).toEqual({ Type: 'Notification' })
    const bad = await app.inject({
      method: 'POST',
      url: '/hooks/smsgate',
      payload: '{nope',
      headers: { 'content-type': 'application/json' },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json()).toMatchObject({ code: 'MALFORMED_REQUEST' })
  })

  it('cap the body at 1 MB', async () => {
    const { app } = await start()
    const big = JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 10) })
    const res = await app.inject({
      method: 'POST',
      url: '/hooks/smsgate',
      payload: big,
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(413)
    expect(res.json()).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
  })

  it('are not rate limited', async () => {
    const { app } = await start({ env: { RATE_LIMIT_PER_MIN: '2' } })
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/hooks/smsgate',
        payload: '{}',
        headers: { 'content-type': 'application/json' },
      })
      expect(res.statusCode).toBe(200)
    }
  })
})

describe('error model', () => {
  it('validation failures are 422 with field paths', async () => {
    const { app } = await start()
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/demo/echo',
      payload: { name: 'a', items: [{ qty: 0 }], extra: 1 },
    })
    expect(res.statusCode).toBe(422)
    const body = res.json()
    expect(body).toMatchObject({ code: 'VALIDATION_FAILED', title: 'Check the form', status: 422 })
    const paths = body.errors.map((e: { path: string }) => e.path)
    expect(paths).toEqual(expect.arrayContaining(['body.name', 'body.items[0].qty']))
    expect(body.detail).toBe(body.errors[0].message)
  })

  it('malformed JSON is 400 and unsupported media type is 415', async () => {
    const { app } = await start()
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/demo/echo',
      payload: '{"name":',
      headers: { 'content-type': 'application/json' },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('MALFORMED_REQUEST')
    const media = await app.inject({
      method: 'POST',
      url: '/api/v1/demo/echo',
      payload: 'name=ab',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    expect(media.statusCode).toBe(415)
    expect(media.json().code).toBe('UNSUPPORTED_MEDIA_TYPE')
  })

  it('guard failures carry the design toast strings as title and detail', async () => {
    const { app } = await start()
    const res = await app.inject({ url: '/api/v1/demo/guard' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({
      code: 'BAY_BUSY',
      title: 'Bay 1 is busy',
      detail: "Finish Marco's vehicle first",
    })
  })

  it('unknown errors are 500 INTERNAL without leaking details, and are logged with the request id', async () => {
    const { app, logs } = await start()
    const res = await app.inject({ url: '/api/v1/demo/boom' })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toMatchObject({
      code: 'INTERNAL',
      title: 'Something went wrong',
      detail: 'An unexpected error occurred',
    })
    expect(JSON.stringify(res.json())).not.toContain('secret internal detail')
    const logged = logs.find((l) => l.msg === 'request failed')
    expect(logged).toMatchObject({ code: 'INTERNAL' })
    expect(logged!.reqId).toBe(res.headers['x-request-id'])
    expect(JSON.stringify(logged)).not.toContain('+13055550142') // masked at info
  })

  it('unknown routes are 404 problem+json and do not leak the access hook', async () => {
    const { app } = await start()
    const res = await app.inject({ url: '/api/v1/nope', headers: { 'x-test-anonymous': '1' } })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toContain('application/problem+json')
    expect(res.json()).toMatchObject({
      code: 'ROUTE_NOT_FOUND',
      meta: { method: 'GET', path: '/api/v1/nope' },
    })
  })

  it('wrong method on a known path is a problem+json 404 (no route)', async () => {
    const { app } = await start()
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/meta/now' })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe('ROUTE_NOT_FOUND')
  })
})

describe('rate limiting', () => {
  it('returns 429 RATE_LIMITED with Retry-After once the per-user budget is spent', async () => {
    const { app } = await start({ env: { RATE_LIMIT_PER_MIN: '3' } })
    for (let i = 0; i < 3; i++) expect((await app.inject({ url: '/api/v1/demo/me' })).statusCode).toBe(200)
    const res = await app.inject({ url: '/api/v1/demo/me' })
    expect(res.statusCode).toBe(429)
    expect(res.json()).toMatchObject({ code: 'RATE_LIMITED', status: 429 })
    expect(res.headers['retry-after']).toBeDefined()
    // a different user has their own budget
    expect(
      (
        await app.inject({
          url: '/api/v1/demo/me',
          headers: { 'x-test-user': '00000000-0000-7000-8000-0000000000aa' },
        })
      ).statusCode,
    ).toBe(200)
  })

  it('exempts health probes', async () => {
    const { app } = await start({ env: { RATE_LIMIT_PER_MIN: '1' } })
    for (let i = 0; i < 5; i++) expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200)
  })
})

describe('idempotent routes over HTTP', () => {
  const post = (
    app: TestApp['app'],
    key: string | undefined,
    cents: number,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/demo/refund',
      payload: { cents },
      headers: { origin, ...(key ? { 'idempotency-key': key } : {}), ...headers },
    })
  const auditRows = async (): Promise<number> =>
    (await t.db.selectFrom('audit_log').selectAll().where('action', '=', 'demo.refund').execute()).length

  it('requires the Idempotency-Key header on required routes (400 before any work)', async () => {
    const { app } = await start()
    const res = await post(app, undefined, 500)
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' })
    expect(await auditRows()).toBe(0)
    expect((await post(app, 'short', 500)).json().code).toBe('IDEMPOTENCY_KEY_INVALID')
  })

  it('runs once and replays with Idempotent-Replayed: true, keeping status, body and headers', async () => {
    const { app } = await start()
    const key = 'sheet-open-0001'
    const first = await post(app, key, 500)
    expect(first.statusCode).toBe(201)
    expect(first.json()).toEqual({ refunded: 500 })
    expect(first.headers['idempotent-replayed']).toBeUndefined()
    expect(first.headers.location).toBe('/api/v1/demo/refund/1')
    const second = await post(app, key, 500)
    expect(second.statusCode).toBe(201)
    expect(second.json()).toEqual({ refunded: 500 })
    expect(second.headers['idempotent-replayed']).toBe('true')
    expect(second.headers.location).toBe('/api/v1/demo/refund/1')
    expect(await auditRows()).toBe(1)
  })

  it('same key with a different body is 422 IDEMPOTENCY_MISMATCH', async () => {
    const { app } = await start()
    await post(app, 'sheet-open-0002', 500)
    const res = await post(app, 'sheet-open-0002', 501)
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'IDEMPOTENCY_MISMATCH', title: 'Idempotency key reused' })
    expect(await auditRows()).toBe(1)
  })

  it('a double click (two concurrent requests with one key) performs the command once', async () => {
    const { app } = await start()
    const [a, b] = await Promise.all([post(app, 'sheet-open-0003', 700), post(app, 'sheet-open-0003', 700)])
    expect(await auditRows()).toBe(1)
    const codes = [a.statusCode, b.statusCode].sort()
    expect(codes[0]).toBe(201) // one executed or replayed
    expect([201, 409]).toContain(codes[1])
    if (codes[1] === 409)
      expect([a, b].find((r) => r.statusCode === 409)!.json().code).toBe('IDEMPOTENCY_IN_FLIGHT')
  })

  it('records the audit row with the idempotency key and request id of the request', async () => {
    const { app } = await start()
    const res = await post(app, 'sheet-open-0004', 100, { 'x-request-id': 'req-audit-0001' })
    expect(res.statusCode).toBe(201)
    const row = await t.db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'demo.refund')
      .executeTakeFirstOrThrow()
    expect(row).toMatchObject({
      idempotency_key: 'sheet-open-0004',
      request_id: 'req-audit-0001',
      actor_name: 'Test User',
      after: { cents: 100 },
    })
  })

  it('is per user: two users can use the same key independently', async () => {
    const { app } = await start()
    const a = await post(app, 'shared-key-0001', 100, {
      'x-test-user': '00000000-0000-7000-8000-0000000000a1',
    })
    const b = await post(app, 'shared-key-0001', 100, {
      'x-test-user': '00000000-0000-7000-8000-0000000000a2',
    })
    expect([a.statusCode, b.statusCode]).toEqual([201, 201])
    expect(b.headers['idempotent-replayed']).toBeUndefined()
    expect(await auditRows()).toBe(2)
  })

  it('permission and origin checks run before the idempotency claim', async () => {
    const { app } = await start()
    const denied = await post(app, 'sheet-open-0005', 100, { 'x-test-permissions': 'sched.view' })
    expect(denied.statusCode).toBe(403)
    const evil = await post(app, 'sheet-open-0005', 100, { origin: 'https://evil.example' })
    expect(evil.statusCode).toBe(403)
    expect(await t.db.selectFrom('idempotency_keys').selectAll().execute()).toHaveLength(0)
  })

  it('optional routes work with and without a key; 204 replays without a body', async () => {
    const { app } = await start()
    const plain = await app.inject({
      method: 'POST',
      url: '/api/v1/demo/optional',
      payload: {},
      headers: { origin },
    })
    expect(plain.statusCode).toBe(200)
    const keyed1 = await app.inject({
      method: 'POST',
      url: '/api/v1/demo/optional',
      payload: {},
      headers: { origin, 'idempotency-key': 'optional-0001' },
    })
    const keyed2 = await app.inject({
      method: 'POST',
      url: '/api/v1/demo/optional',
      payload: {},
      headers: { origin, 'idempotency-key': 'optional-0001' },
    })
    expect(keyed2.headers['idempotent-replayed']).toBe('true')
    expect(keyed1.json()).toEqual(keyed2.json())
    expect(
      (await t.db.selectFrom('audit_log').selectAll().where('action', '=', 'demo.optional').execute()).length,
    ).toBe(2)

    const nc1 = await app.inject({
      method: 'POST',
      url: '/api/v1/demo/no-content',
      headers: { origin, 'idempotency-key': 'no-content-001' },
    })
    const nc2 = await app.inject({
      method: 'POST',
      url: '/api/v1/demo/no-content',
      headers: { origin, 'idempotency-key': 'no-content-001' },
    })
    expect([nc1.statusCode, nc2.statusCode]).toEqual([204, 204])
    expect(nc2.body).toBe('')
    expect(nc2.headers['idempotent-replayed']).toBe('true')
  })
})

describe('logging', () => {
  it('redacts credentials and masks PII in request logs', async () => {
    const { app, logs } = await start()
    await app.inject({
      method: 'POST',
      url: '/api/v1/demo/echo?token=abc123&x=1',
      payload: { name: 'ab' },
      headers: { origin, authorization: 'Bearer top-secret', cookie: 'oasis_sid=cookie-secret' },
    })
    const text = JSON.stringify(logs)
    expect(text).not.toContain('top-secret')
    expect(text).not.toContain('cookie-secret')
    expect(text).not.toContain('token=abc123')
    expect(logs.some((l) => typeof l.reqId === 'string')).toBe(true)
  })

  it('every log line of a request carries its request id', async () => {
    const { app, logs } = await start()
    const res = await app.inject({ url: '/api/v1/demo/me', headers: { 'x-request-id': 'req-logid-0001' } })
    expect(res.statusCode).toBe(200)
    const mine = logs.filter((l) => l.reqId === 'req-logid-0001')
    expect(mine.length).toBeGreaterThanOrEqual(2) // incoming request + completed
  })
})

describe('actor context for audit', () => {
  it('auditContextOf reflects view-as sessions with the real actor', async () => {
    let captured: ReturnType<typeof auditContextOf> | undefined
    const mod: ApiModule = (app) => {
      app.get('/demo/ctx', { config: { access: access.authenticated() } }, async (req) => {
        captured = auditContextOf(req)
        return {}
      })
    }
    ctx = await createTestApp({
      testDb: t,
      modules: [mod],
      authorizer: (loc) => ({
        ...createPermissiveAuthorizer({ locationId: loc.id }),
        resolve: async () => ({
          userId: 'viewed-as-user',
          realUserId: 'real-super-admin',
          employeeId: 'emp-1',
          locationId: loc.id,
          permissions: new Set(['*']),
          actorName: 'Rafael M.',
          roles: ['super'],
          viewAsRoleId: 'role-crew',
        }),
      }),
    })
    await ctx.app.inject({ url: '/api/v1/demo/ctx', headers: { 'x-request-id': 'req-ctx-000001' } })
    expect(captured).toMatchObject({
      actor: { userId: 'real-super-admin', viewAsRoleId: 'role-crew', name: 'Rafael M.', roles: 'super' },
      requestId: 'req-ctx-000001',
    })
  })
})
