// The event stream for a kiosk (ADR 0180): ops, messages and settings, never the per-person notifications (nor payments, which needs
// pay.reports); at most 8 streams per DEVICE; the periodic re-check ends a stream once the kiosk locks.
import { sql } from 'kysely'
import { beforeEach, describe, expect, it } from 'vitest'
import { useHarness, type KioskSession } from '../auth/harness.js'
import { openSse, sleep, type SseClient } from '../helpers/sse.js'

describe('kiosk event streams', () => {
  const h = useHarness({ hub: true, env: { SSE_HEARTBEAT_MS: '100' } })
  const clients: SseClient[] = []

  beforeEach(async () => {
    for (const c of clients.splice(0)) c.close()
    await sql`select setval(pg_get_serial_sequence('realtime_events', 'id'), ${Date.now()}, false)`.execute(h.t.db)
  })

  async function url(): Promise<string> {
    if (!h.t.app.server.address()) await h.t.app.listen({ port: 0, host: '127.0.0.1' })
    return `http://127.0.0.1:${(h.t.app.server.address() as { port: number }).port}/api/v1/events`
  }

  async function open(k: Pick<KioskSession, 'cookie'>): Promise<SseClient> {
    const c = await openSse(await url(), { cookie: k.cookie })
    clients.push(c)
    return c
  }

  it('subscribes to ops, messages and settings; notifications and payments are refused', async () => {
    const { kiosk } = await h.kioskSetup()
    const c = await open(kiosk)
    expect(c.status).toBe(200)
    const ready = await c.waitFor((f) => f.event === 'ready')
    expect(ready.data).toMatchObject({ channels: ['ops', 'messages', 'settings'], denied: ['payments', 'notifications'] })
    const asked = await openSse(`${await url()}?channels=notifications`, { cookie: kiosk.cookie })
    clients.push(asked)
    expect((await asked.waitFor((f) => f.event === 'ready')).data).toMatchObject({ channels: [], denied: ['notifications'] })
  })

  it('ends the stream once the kiosk is locked', async () => {
    const { kiosk } = await h.kioskSetup()
    const c = await open(kiosk)
    await c.waitFor((f) => f.event === 'ready')
    expect((await h.kioskCall('POST', 'kiosk/lock', kiosk)).statusCode).toBe(204)
    const ended = await Promise.race([c.ended.then(() => true), sleep(3000).then(() => false)])
    expect(ended).toBe(true)
  })

  it('caps open streams per device, not per address or per person', async () => {
    const { admin, kiosk } = await h.kioskSetup()
    for (let i = 0; i < 8; i++) {
      const c = await open(kiosk)
      expect(c.status, `stream ${i + 1}`).toBe(200)
      await c.waitFor((f) => f.event === 'ready')
    }
    const ninth = await open(kiosk)
    expect(ninth.status).toBe(429)
    // the manager on the same tablet has their own budget
    const mine = await openSse(await url(), { cookie: admin.cookie })
    clients.push(mine)
    expect(mine.status).toBe(200)
  })
})
