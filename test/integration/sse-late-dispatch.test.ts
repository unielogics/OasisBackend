// The hub reads the event log slightly behind the commit, so it can dispatch an event after a stream has gone live even though
// the event is at or below the stream's starting point (the cursor of a fresh stream, or the Last-Event-ID it resumed from).
// Such an event was already replayed, or predates the stream: it must not be sent live. Found as a flaky Last-Event-ID test.
import { afterEach, describe, expect, it } from 'vitest'
import { transaction } from '../../src/platform/db.js'
import { publish, type PublishInput } from '../../src/platform/realtime.js'
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

async function start(): Promise<{ url: string; app: TestApp; pub: (e: Omit<PublishInput, 'locationId'>) => Promise<number> }> {
  ctx = await createTestApp({ testDb: t, hub: { pollMs: 200 }, env: { SSE_HEARTBEAT_MS: '20000' } })
  await ctx.app.listen({ port: 0, host: '127.0.0.1' })
  const addr = ctx.app.server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const app = ctx
  // the hub reads the log late: everything committed so far is dispatched after the stream below is live
  const hub = app.hub!
  const original = hub.pump.bind(hub)
  hub.pump = async () => {
    await sleep(600)
    return original()
  }
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

describe('late hub dispatch of an event the stream starts after', () => {
  it('a stream resuming at the latest id does not get that event live', async () => {
    const { url, pub } = await start()
    const latest = await pub({ channel: 'ops', type: 'e1' })
    const c = await connect(url, { 'Last-Event-ID': String(latest) })
    await c.waitFor((f) => f.event === 'ready')
    await sleep(1500)
    expect(c.messages()).toEqual([])
    const next = await pub({ channel: 'ops', type: 'e2' })
    await c.waitFor((f) => f.id === String(next), 5000)
    expect(c.messages().map((f) => Number(f.id))).toEqual([next])
  })

  it('a fresh stream does not get events committed before it connected', async () => {
    const { url, pub } = await start()
    await pub({ channel: 'ops', type: 'before' })
    const c = await connect(url)
    await c.waitFor((f) => f.event === 'ready')
    await sleep(1500)
    expect(c.messages()).toEqual([])
  })
})
