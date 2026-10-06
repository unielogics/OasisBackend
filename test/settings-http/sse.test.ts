import { afterEach, describe, expect, it } from 'vitest'
import { bookCustomer } from './fixtures.js'
import { openSse, type SseClient } from '../helpers/sse.js'
import { json, useSettingsHarness, type Session } from './harness.js'

const h = useSettingsHarness({ hub: true })
const clients: SseClient[] = []

afterEach(() => {
  for (const c of clients.splice(0)) c.close()
})

async function url(): Promise<string> {
  const server = h.t.app.server
  if (!server.listening) await h.t.app.listen({ port: 0, host: '127.0.0.1' })
  const addr = server.address()
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/v1/events`
}

async function connect(s: Session, channels = 'ops,settings'): Promise<SseClient> {
  const c = await openSse(`${await url()}?channels=${channels}`, { cookie: s.cookie })
  clients.push(c)
  await c.waitFor((f) => f.event === 'ready')
  return c
}

const data = (c: SseClient): { channel: string; type: string; payload: Record<string, unknown> }[] =>
  c.messages().map((f) => f.data as { channel: string; type: string; payload: Record<string, unknown> })

describe('settings and emergency events over SSE', () => {
  it('delivers settings.changed for each settings mutation to every signed-in user', async () => {
    const admin = await h.admin()
    const crew = await h.withPermissions([])
    const watcher = await connect(crew, 'settings')

    const v = json(await h.get('settings/hours', admin)).version
    await h.put('settings/rules', admin, { slot: 60 })
    await h.put('arrival-settings', admin, { radius: 150 })
    await h.put('vip', admin, { release: 24 })
    await h.post('closures', admin, { date: '2026-07-04', name: 'Independence Day', notify: false })
    await watcher.waitFor(
      (f) => (f.data as { payload?: { section?: string } } | undefined)?.payload?.section === 'closures',
    )

    const sections = data(watcher)
      .filter((e) => e.type === 'settings.changed')
      .map((e) => e.payload.section)
    expect(sections).toEqual(['hours', 'arrival', 'vip', 'closures'])
    expect(v).toBeGreaterThan(0)
  })

  it('announces emergency.started and emergency.reopened on the ops channel, only to those who may see ops', async () => {
    await bookCustomer(h.db, h.fx, { name: 'Marcus Webb', date: '2026-06-13', time: '10:15' })
    const admin = await h.admin()
    const crew = await h.withPermissions(['sched.view'])
    const blind = await h.withPermissions([])
    const withOps = await connect(crew)
    const withoutOps = await connect(blind)
    expect((withoutOps.frames.find((f) => f.event === 'ready')!.data as { denied: string[] }).denied).toEqual(
      ['ops'],
    )

    const close = await h.post(
      'emergency/close',
      admin,
      { reason: 'Power outage', dur: 'today' },
      { 'idempotency-key': 'sse-key-00001' },
    )
    expect(close.statusCode).toBe(201)
    await withOps.waitFor((f) => (f.data as { type?: string } | undefined)?.type === 'emergency.started')
    const reopen = await h.post('emergency/reopen', admin)
    expect(reopen.statusCode).toBe(200)
    await withOps.waitFor((f) => (f.data as { type?: string } | undefined)?.type === 'emergency.reopened')
    await withoutOps.waitFor(
      (f) => (f.data as { payload?: { section?: string } } | undefined)?.payload?.section === 'emergency',
    )

    const opsTypes = data(withOps)
      .filter((e) => e.channel === 'ops')
      .map((e) => e.type)
    expect(opsTypes).toEqual(['emergency.started', 'emergency.ended', 'emergency.reopened'])
    expect(data(withOps).find((e) => e.type === 'emergency.started')!.payload).toMatchObject({ pause: true })
    expect(data(withoutOps).some((e) => e.channel === 'ops')).toBe(false)
    expect(
      data(withoutOps).some((e) => e.type === 'settings.changed' && e.payload.section === 'emergency'),
    ).toBe(true)
  })
})
