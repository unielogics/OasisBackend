import http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { transaction } from '../../src/platform/db.js'
import { createDb } from '../../src/platform/db.js'
import { publish, purgeRealtimeEvents, type PublishInput } from '../../src/platform/realtime.js'
import { makeLocation } from '../helpers/factories.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { createPermissiveAuthorizer } from '../../src/http/authorizer.js'
import { useTestDb } from '../helpers/db.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { openSse, sleep, type SseClient } from '../helpers/sse.js'

const t = useTestDb()
let ctx: TestApp | undefined
const clients: SseClient[] = []

afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  await ctx?.close()
  ctx = undefined
})

async function start(env: Record<string, string> = {}): Promise<{
  url: string
  app: TestApp
  pub: (e: Omit<PublishInput, 'locationId'> & { locationId?: string }) => Promise<number>
}> {
  ctx = await createTestApp({ testDb: t, hub: { pollMs: 200 }, env: { SSE_HEARTBEAT_MS: '20000', ...env } })
  await ctx.app.listen({ port: 0, host: '127.0.0.1' })
  const addr = ctx.app.server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const app = ctx
  return {
    url: `http://127.0.0.1:${port}/api/v1/events`,
    app,
    pub: (e) => transaction(app.db, (tx) => publish(tx, { locationId: app.location.id, ...e })),
  }
}

const connect = async (url: string, headers: Record<string, string> = {}): Promise<SseClient> => {
  const c = await openSse(url, headers)
  clients.push(c)
  return c
}
const ids = (c: SseClient): number[] => c.messages().map((f) => Number(f.id))

describe('GET /api/v1/events', () => {
  it('streams text/event-stream with a ready frame and delivers events committed after connect', async () => {
    const { url, pub } = await start()
    const c = await connect(url)
    expect(c.status).toBe(200)
    expect(c.headers.get('content-type')).toContain('text/event-stream')
    expect(c.headers.get('cache-control')).toContain('no-cache')
    expect(c.headers.get('x-accel-buffering')).toBe('no')
    expect(c.headers.get('x-request-id')).toBeTruthy()
    expect(c.headers.get('content-security-policy')).toContain("default-src 'none'")

    const ready = await c.waitFor((f) => f.event === 'ready')
    expect(ready.data).toMatchObject({
      channels: ['ops', 'payments', 'messages', 'settings', 'notifications'],
      denied: [],
      cursor: 0,
      heartbeatMs: 20000,
    })
    expect(ready.id).toBe('0')
    expect(c.frames[0]?.retry).toBe('3000')

    const id = await pub({ channel: 'ops', type: 'appointment.updated', payload: { id: 'a1', version: 4 } })
    const msg = await c.waitFor((f) => f.event === undefined && f.data !== undefined)
    expect(msg.id).toBe(String(id))
    expect(msg.data).toMatchObject({
      channel: 'ops',
      type: 'appointment.updated',
      payload: { id: 'a1', version: 4 },
      at: '2026-06-13T14:36:00.000Z',
    })
  })

  it('sends a heartbeat comment on the configured interval', async () => {
    const { url } = await start({ SSE_HEARTBEAT_MS: '100' })
    const c = await connect(url)
    const ready = await c.waitFor((f) => f.event === 'ready')
    expect(ready.data).toMatchObject({ heartbeatMs: 100 })
    await c.waitFor((f) => f.comment === 'hb', 2000)
    await c.waitFor((f) => f.comment === 'hb' && f !== c.frames.find((x) => x.comment === 'hb'), 2000)
  })

  it('does not deliver events before commit, and never delivers rolled-back ones', async () => {
    const { url, app } = await start()
    const c = await connect(url)
    await c.waitFor((f) => f.event === 'ready')
    await expect(
      transaction(app.db, async (tx) => {
        await publish(tx, { locationId: app.location.id, channel: 'ops', type: 'ghost' })
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const open = transaction(app.db, async (tx) => {
      await publish(tx, { locationId: app.location.id, channel: 'ops', type: 'pending' })
      await gate
    })
    await sleep(400)
    expect(c.messages()).toHaveLength(0)
    release()
    await open
    const msg = await c.waitFor((f) => f.event === undefined && f.data !== undefined)
    expect(msg.data).toMatchObject({ type: 'pending' })
    expect(c.messages()).toHaveLength(1)
  })

  it('filters by requested channels', async () => {
    const { url, pub } = await start()
    const c = await connect(`${url}?channels=settings,ops`)
    const ready = await c.waitFor((f) => f.event === 'ready')
    expect(ready.data).toMatchObject({ channels: ['settings', 'ops'], denied: [] })
    await pub({ channel: 'payments', type: 'invoice.updated' })
    await pub({ channel: 'messages', type: 'message.in' })
    const keep = await pub({ channel: 'settings', type: 'settings.changed', payload: { section: 'tax' } })
    await c.waitFor((f) => f.id === String(keep))
    expect(c.messages().map((f) => (f.data as { channel: string }).channel)).toEqual(['settings'])
  })

  it('drops channels the caller lacks permission for and lists them as denied', async () => {
    const { url, pub } = await start()
    const c = await connect(url, { 'x-test-permissions': 'sched.view' })
    const ready = await c.waitFor((f) => f.event === 'ready')
    expect(ready.data).toMatchObject({
      channels: ['ops', 'settings', 'notifications'],
      denied: ['payments', 'messages'],
    })
    await pub({ channel: 'payments', type: 'invoice.updated' })
    await pub({ channel: 'messages', type: 'message.in' })
    const ok = await pub({ channel: 'ops', type: 'kpi.dirty' })
    await c.waitFor((f) => f.id === String(ok))
    expect(c.messages()).toHaveLength(1)

    const pay = await connect(url, { 'x-test-permissions': 'pay.reports,cli.view' })
    const payReady = await pay.waitFor((f) => f.event === 'ready')
    expect(payReady.data).toMatchObject({
      channels: ['payments', 'messages', 'settings', 'notifications'],
      denied: ['ops'],
    })
  })

  it('honours the authorizer canSubscribe hook over the default table', async () => {
    ctx = await createTestApp({
      testDb: t,
      hub: { pollMs: 200 },
      authorizer: (loc) => ({
        ...createPermissiveAuthorizer({ locationId: loc.id }),
        canSubscribe: (_c, channel) => channel === 'settings',
      }),
    })
    await ctx.app.listen({ port: 0, host: '127.0.0.1' })
    const addr = ctx.app.server.address()
    const c = await connect(
      `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/v1/events`,
    )
    const ready = await c.waitFor((f) => f.event === 'ready')
    expect(ready.data).toMatchObject({
      channels: ['settings'],
      denied: ['ops', 'payments', 'messages', 'notifications'],
    })
  })

  it('delivers targeted events (notifications) only to the targeted user', async () => {
    const { url, pub } = await start()
    const a = await connect(url, { 'x-test-user': '00000000-0000-7000-8000-00000000000a' })
    const b = await connect(url, { 'x-test-user': '00000000-0000-7000-8000-00000000000b' })
    await a.waitFor((f) => f.event === 'ready')
    await b.waitFor((f) => f.event === 'ready')
    const id = await pub({
      channel: 'notifications',
      type: 'notification.new',
      targetUserId: '00000000-0000-7000-8000-00000000000a',
      payload: { kind: 'alert' },
    })
    const marker = await pub({ channel: 'settings', type: 'settings.changed' })
    await a.waitFor((f) => f.id === String(marker))
    await b.waitFor((f) => f.id === String(marker))
    expect(ids(a)).toEqual([id, marker])
    expect(ids(b)).toEqual([marker])
  })

  it('does not leak another location events', async () => {
    const { url, app, pub } = await start()
    const other = await makeLocation(app.db, createIdGenerator(app.clock))
    const c = await connect(url)
    await c.waitFor((f) => f.event === 'ready')
    await pub({ locationId: other.id, channel: 'ops', type: 'secret' })
    const mine = await pub({ channel: 'ops', type: 'mine' })
    await c.waitFor((f) => f.id === String(mine))
    expect(c.messages().map((f) => (f.data as { type: string }).type)).toEqual(['mine'])
  })

  it('rejects unknown channels with 422 and anonymous callers with 401', async () => {
    const { url } = await start()
    const bad = await fetch(`${url}?channels=ops,bogus`)
    expect(bad.status).toBe(422)
    expect(await bad.json()).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'query.channels' }],
    })
    const anon = await fetch(url, { headers: { 'x-test-anonymous': '1' } })
    expect(anon.status).toBe(401)
    expect(await anon.json()).toMatchObject({ code: 'UNAUTHENTICATED' })
  })

  it('answers 503 when no realtime hub is configured', async () => {
    ctx = await createTestApp({ testDb: t })
    const res = await ctx.app.inject({ url: '/api/v1/events' })
    expect(res.statusCode).toBe(503)
    expect(res.json().code).toBe('SERVICE_UNAVAILABLE')
  })

  it('caps open streams per user at 8', async () => {
    const { url } = await start()
    for (let i = 0; i < 8; i++) {
      const c = await connect(url)
      await c.waitFor((f) => f.event === 'ready')
    }
    const ninth = await fetch(url)
    expect(ninth.status).toBe(429)
    expect(await ninth.json()).toMatchObject({ code: 'RATE_LIMITED' })
    clients[0]!.close()
    await sleep(300)
    const again = await connect(url)
    await again.waitFor((f) => f.event === 'ready')
  })

  it('does not count a stream whose client left before the handler ran (the count must not leak)', async () => {
    const slow = (location: { id: string }) => {
      const base = createPermissiveAuthorizer({ locationId: location.id })
      return {
        ...base,
        async resolve(req: Parameters<typeof base.resolve>[0]) {
          await sleep(120) // authentication takes a moment: a browser tab can close during it
          return base.resolve(req)
        },
      }
    }
    ctx = await createTestApp({
      testDb: t,
      hub: { pollMs: 200 },
      env: { SSE_HEARTBEAT_MS: '20000' },
      authorizer: slow,
    })
    await ctx.app.listen({ port: 0, host: '127.0.0.1' })
    const addr = ctx.app.server.address()
    const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/v1/events`
    for (let i = 0; i < 10; i++) {
      const r = http.get(url, {
        headers: { accept: 'text/event-stream' },
        agent: new http.Agent({ keepAlive: false }),
      })
      r.on('error', () => {})
      await sleep(25)
      r.destroy()
    }
    await sleep(600)
    for (let i = 0; i < 8; i++) {
      const c = await connect(url)
      expect(c.status).toBe(200)
      await c.waitFor((f) => f.event === 'ready')
    }
  })

  it('closes open streams when the app shuts down (close() does not hang)', async () => {
    const { url } = await start()
    const c = await connect(url)
    await c.waitFor((f) => f.event === 'ready')
    await ctx!.close()
    ctx = undefined
    await Promise.race([c.ended, sleep(3000).then(() => Promise.reject(new Error('stream was not closed')))])
  })
})

describe('Last-Event-ID replay', () => {
  it('replays missed events in order, then continues live without duplicates', async () => {
    const { url, pub } = await start()
    const first = await pub({ channel: 'ops', type: 'e1' })
    const second = await pub({ channel: 'ops', type: 'e2' })
    const third = await pub({ channel: 'settings', type: 'e3' })
    const c = await connect(url, { 'Last-Event-ID': String(first) })
    const ready = await c.waitFor((f) => f.event === 'ready')
    expect(ready.id).toBeUndefined() // a resuming client keeps its own cursor until replay completes
    await c.waitFor((f) => f.id === String(third))
    expect(ids(c)).toEqual([second, third])
    const live = await pub({ channel: 'ops', type: 'e4' })
    await c.waitFor((f) => f.id === String(live))
    expect(ids(c)).toEqual([second, third, live])
    expect(c.frames.some((f) => f.event === 'resync')).toBe(false)
  })

  it('accepts the cursor as ?lastEventId for clients that cannot set headers', async () => {
    const { url, pub } = await start()
    const first = await pub({ channel: 'ops', type: 'e1' })
    const second = await pub({ channel: 'ops', type: 'e2' })
    const c = await connect(`${url}?lastEventId=${first}`)
    await c.waitFor((f) => f.id === String(second))
    expect(ids(c)).toEqual([second])
  })

  it('replays only events the caller may see', async () => {
    const { url, pub } = await start()
    const cursor = await pub({ channel: 'ops', type: 'start' })
    await pub({ channel: 'payments', type: 'hidden' })
    await pub({
      channel: 'notifications',
      type: 'notification.new',
      targetUserId: '00000000-0000-7000-8000-0000000000ff',
    })
    const visible = await pub({ channel: 'ops', type: 'visible' })
    const c = await connect(url, { 'Last-Event-ID': String(cursor), 'x-test-permissions': 'sched.view' })
    await c.waitFor((f) => f.id === String(visible))
    expect(c.messages().map((f) => (f.data as { type: string }).type)).toEqual(['visible'])
  })

  it('a client resuming at the latest id gets nothing replayed', async () => {
    const { url, pub } = await start()
    const latest = await pub({ channel: 'ops', type: 'e1' })
    const c = await connect(url, { 'Last-Event-ID': String(latest) })
    await c.waitFor((f) => f.event === 'ready')
    await sleep(300)
    expect(c.messages()).toHaveLength(0)
    expect(c.frames.some((f) => f.event === 'resync')).toBe(false)
  })

  it('loses and duplicates nothing while events are published during the replay-to-live handoff', async () => {
    const { url, pub } = await start()
    const cursor = await pub({ channel: 'ops', type: 'seed' })
    const published: number[] = []
    const publisher = (async () => {
      for (let i = 0; i < 40; i++) {
        published.push(await pub({ channel: 'ops', type: 'burst', payload: { i } }))
        if (i % 5 === 0) await sleep(5)
      }
    })()
    const c = await connect(url, { 'Last-Event-ID': String(cursor) })
    await publisher
    await c.waitFor((f) => f.id === String(published.at(-1)), 8000)
    const got = ids(c)
    expect(new Set(got).size).toBe(got.length)
    expect([...got].sort((a, b) => a - b)).toEqual(published)
  })

  it('does not deliver an event twice when the hub dispatches it after the replay already sent it', async () => {
    const { url, pub, app } = await start()
    const hub = app.hub!
    const original = hub.pump.bind(hub)
    hub.pump = async () => {
      await sleep(500) // the hub reads the log late, after the replay query has already returned the event
      return original()
    }
    const cursor = await pub({ channel: 'ops', type: 'seed' })
    const e1 = await pub({ channel: 'ops', type: 'e1' })
    const c = await connect(url, { 'Last-Event-ID': String(cursor - 1) })
    await c.waitFor((f) => f.id === String(e1))
    await sleep(1500)
    expect(ids(c)).toEqual([cursor, e1])
  })

  it('sends resync when the cursor is older than retention (events purged)', async () => {
    const { url, pub, app } = await start()
    const old = await pub({ channel: 'ops', type: 'old' })
    await pub({ channel: 'ops', type: 'newer' })
    app.clock.advance(11 * 60 * 1000)
    const latest = await pub({ channel: 'ops', type: 'fresh' })
    expect(await purgeRealtimeEvents(app.db, new Date(app.clock.now().getTime() - 10 * 60 * 1000))).toBe(2)

    const c = await connect(url, { 'Last-Event-ID': String(old) })
    const resync = await c.waitFor((f) => f.event === 'resync')
    expect(resync.data).toEqual({ reason: 'cursor_expired', latestId: latest })
    expect(resync.id).toBe(String(latest))
    expect(c.messages()).toHaveLength(0) // nothing is replayed after a resync
    const live = await pub({ channel: 'ops', type: 'after' })
    await c.waitFor((f) => f.id === String(live))
    expect(ids(c)).toEqual([live])

    // a client whose cursor is still within retention replays normally
    const keep = await connect(url, { 'Last-Event-ID': String(latest) })
    await keep.waitFor((f) => f.id === String(live))
    expect(keep.frames.some((f) => f.event === 'resync')).toBe(false)
  })

  it('sends resync when the cursor is ahead of the log (database reset) or unparsable', async () => {
    const { url, pub } = await start()
    const latest = await pub({ channel: 'ops', type: 'e1' })
    const ahead = await connect(url, { 'Last-Event-ID': String(latest + 1000) })
    expect((await ahead.waitFor((f) => f.event === 'resync')).data).toMatchObject({
      reason: 'cursor_expired',
      latestId: latest,
    })
    const junk = await connect(url, { 'Last-Event-ID': 'not-a-number' })
    expect((await junk.waitFor((f) => f.event === 'resync')).data).toMatchObject({ latestId: latest })
  })
})

describe('realtime hub resilience', () => {
  it('reconnects its LISTEN connection and catches up on events committed while it was down', async () => {
    const { url, pub, app } = await start()
    const c = await connect(url)
    await c.waitFor((f) => f.event === 'ready')
    const admin = createDb({ url: t.connection.url, poolMax: 1 })
    try {
      const killed = await sql<{
        n: number
      }>`select count(*)::int as n from (select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'oasis-test-listen' and pid <> pg_backend_pid()) x`.execute(
        admin,
      )
      expect(killed.rows[0]!.n).toBeGreaterThanOrEqual(1)
    } finally {
      await admin.destroy()
    }
    const id = await pub({ channel: 'ops', type: 'while-down' })
    await c.waitFor((f) => f.id === String(id), 10_000)
    const after = await pub({ channel: 'ops', type: 'after-reconnect' })
    await c.waitFor((f) => f.id === String(after), 10_000)
    expect(app.hub!.subscriberCount).toBe(1)
  })
})
