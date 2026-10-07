// Adversarial review (rv/sec): an event stream is authorised once, when it opens. What happens to it when the person's
// session, role or account changes while the tab stays open?
import { sql } from 'kysely'
import { beforeEach, describe, expect, it } from 'vitest'
import { transaction } from '../../src/platform/db.js'
import { publish } from '../../src/platform/realtime.js'
import { useHarness, type Harness, type Session } from '../auth/harness.js'
import { openSse, sleep, type SseClient } from '../helpers/sse.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>

const SETTLE_MS = 700 // several heartbeats at SSE_HEARTBEAT_MS=100

describe('SEC-03 event streams outlive the authority they were opened with', () => {
  const h = useHarness({ hub: true, env: { SSE_HEARTBEAT_MS: '100' } })
  const clients: SseClient[] = []

  // The hub starts once per file but the harness restarts the id sequence before every test; ids it has already seen would be
  // dropped as duplicates, so each test continues from a fresh, strictly larger id.
  beforeEach(async () => {
    await sql`select setval(pg_get_serial_sequence('realtime_events', 'id'), ${Date.now()}, false)`.execute(
      h.t.db,
    )
  })

  async function open(s: Session): Promise<SseClient> {
    const addr = h.t.app.server.address()
    if (!addr) await h.t.app.listen({ port: 0, host: '127.0.0.1' })
    const port = (h.t.app.server.address() as { port: number }).port
    const c = await openSse(`http://127.0.0.1:${port}/api/v1/events`, { cookie: s.cookie })
    clients.push(c)
    expect(c.status).toBe(200)
    await c.waitFor((f) => f.event === 'ready')
    return c
  }

  const payment = (n: number) =>
    transaction(h.t.db, (tx) =>
      publish(tx, {
        locationId: h.t.location.id,
        channel: 'payments',
        type: 'ledger.event',
        payload: { invoiceId: `inv-${n}`, eventId: `ev-${n}` },
      }),
    )

  const paymentFrames = (c: SseClient) =>
    c.messages().filter((f) => (f.data as Json | undefined)?.channel === 'payments')

  async function accountant(h2: Harness, email: string) {
    const user = await h2.createUser({ email, roles: ['acct'] })
    return { user, session: await h2.login(user, '10.80.0.1') }
  }

  const done = () => {
    for (const c of clients.splice(0)) c.close()
  }

  it('stops delivering payments events after the person signs out', async () => {
    const { session } = await accountant(h, 'acct1@example.test')
    const stream = await open(session)
    await payment(1)
    await stream.waitFor((f) => (f.data as Json | undefined)?.channel === 'payments')

    const out = await h.call('POST', 'auth/logout', { session })
    expect(out.statusCode).toBe(204)
    await sleep(SETTLE_MS)
    await payment(2)
    await sleep(SETTLE_MS)

    const leaked = paymentFrames(stream).map((f) => (f.data as Json).payload.eventId)
    done()
    expect(leaked).toEqual(['ev-1'])
  })

  it('stops delivering payments events once an administrator removes the permission', async () => {
    const owner = await h.createUser({ email: 'owner@example.test', roles: ['super'] })
    const sup = await h.login(owner, '10.80.0.2')
    const { user, session } = await accountant(h, 'acct2@example.test')
    const stream = await open(session)
    await payment(1)
    await stream.waitFor((f) => (f.data as Json | undefined)?.channel === 'payments')

    const v = ((await h.call('GET', `employees/${user.employeeId}`, { session: sup })).json() as Json).version
    const res = await h.call('PUT', `employees/${user.employeeId}`, {
      session: sup,
      body: { roles: ['crew'] },
      headers: { 'if-match': `"${v}"` },
    })
    expect(res.statusCode).toBe(200)
    expect((await h.call('GET', 'payments/summary', { session })).statusCode).toBe(403) // REST already refuses
    await sleep(SETTLE_MS)
    await payment(2)
    await sleep(SETTLE_MS)

    const leaked = paymentFrames(stream).map((f) => (f.data as Json).payload.eventId)
    done()
    expect(leaked).toEqual(['ev-1'])
  })

  it('closes the stream when the account is deactivated', async () => {
    const owner = await h.createUser({ email: 'owner@example.test', roles: ['super'] })
    const sup = await h.login(owner, '10.80.0.3')
    const { user, session } = await accountant(h, 'acct3@example.test')
    const stream = await open(session)

    const res = await h.call('POST', `employees/${user.employeeId}/deactivate`, { session: sup })
    expect(res.statusCode).toBe(200)
    expect((await h.call('GET', 'me', { session })).statusCode).toBe(401) // REST already refuses
    await sleep(SETTLE_MS)
    await payment(2)
    await sleep(SETTLE_MS)

    const leaked = paymentFrames(stream).map((f) => (f.data as Json).payload.eventId)
    const closed = await Promise.race([stream.ended.then(() => true), sleep(100).then(() => false)])
    done()
    expect({ leaked, closed }).toEqual({ leaked: [], closed: true })
  })
})
