// Gap 4: an emergency transition publishes ONE event on the ops channel. Closing is `emergency.started`; reopening (by a
// person, by the end-time job or by the service directly) is `emergency.reopened`. The service used to publish
// `emergency.ended` and the command a second `emergency.reopened`, so a consumer reacting to each saw two reopens.
import { afterEach, describe, expect, it } from 'vitest'
import { reopenIfEnded } from '../../src/modules/settings/emergency.js'
import { transaction } from '../../src/platform/db.js'
import { openSse, type SseClient } from '../helpers/sse.js'
import { bookCustomer } from '../settings-http/fixtures.js'
import { auditActions, events, json, useSettingsHarness, type Session } from '../settings-http/harness.js'

const h = useSettingsHarness({ hub: true })
const clients: SseClient[] = []

afterEach(() => {
  for (const c of clients.splice(0)) c.close()
})

const close = (s: Session, body: Record<string, unknown> = {}, key = 'gap4-close-0001') =>
  h.post('emergency/close', s, { reason: 'Power outage', dur: 'today', ...body }, { 'idempotency-key': key })

async function connect(s: Session): Promise<SseClient> {
  const server = h.t.app.server
  if (!server.listening) await h.t.app.listen({ port: 0, host: '127.0.0.1' })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const c = await openSse(`http://127.0.0.1:${port}/api/v1/events?channels=ops,notifications`, {
    cookie: s.cookie,
  })
  clients.push(c)
  await c.waitFor((f) => f.event === 'ready')
  return c
}

const opsTypes = async (): Promise<string[]> => (await events(h.db, 'ops')).map((e) => e.type)
const emergencyNotifications = async (): Promise<number> =>
  (await h.db.selectFrom('notifications').select('id').where('kind', '=', 'emergency').execute()).length

describe('one ops event per emergency transition', () => {
  it('close publishes emergency.started; reopen by a person publishes only emergency.reopened', async () => {
    await bookCustomer(h.db, h.fx, { name: 'Marcus Webb', date: '2026-06-13', time: '10:15' })
    const admin = await h.admin()
    const crew = await h.withPermissions(['sched.view'])
    const watcher = await connect(crew)

    expect((await close(admin)).statusCode).toBe(201)
    await watcher.waitFor((f) => (f.data as { type?: string } | undefined)?.type === 'emergency.started')
    const alertsAfterClose = await emergencyNotifications()
    expect(await opsTypes()).toEqual(['emergency.started'])

    const reopen = await h.post('emergency/reopen', admin)
    expect(reopen.statusCode).toBe(200)
    await watcher.waitFor((f) => (f.data as { type?: string } | undefined)?.type === 'emergency.reopened')

    expect(await opsTypes()).toEqual(['emergency.started', 'emergency.reopened'])
    const sse = watcher
      .messages()
      .map((f) => f.data as { channel: string; type: string; payload: Record<string, unknown> })
      .filter((e) => e.channel === 'ops')
    expect(sse.map((e) => e.type)).toEqual(['emergency.started', 'emergency.reopened'])
    const em = json(await h.get('emergency/history', admin)).items[0].id
    expect(sse[1]!.payload).toEqual({ id: em, auto: false })
    // reopening raises no further bell notification: the crew was alerted once, at the close
    expect(await emergencyNotifications()).toBe(alertsAfterClose)
    expect(await auditActions(h.db)).toEqual(expect.arrayContaining(['emergency.close', 'emergency.reopen']))
  })

  it('the end-time job reopens with the same single event, flagged auto', async () => {
    const admin = await h.admin()
    expect((await close(admin)).statusCode).toBe(201)
    const em = json(await h.get('emergency', admin)).current.id
    h.clock.set('2026-06-13T17:00:00-04:00')
    await transaction(h.db, (tx) =>
      reopenIfEnded(tx, { locationId: h.fx.locationId, now: h.clock.now(), tz: 'America/New_York' }),
    )
    const ops = await events(h.db, 'ops')
    expect(ops.map((e) => e.type)).toEqual(['emergency.started', 'emergency.reopened'])
    expect(ops[1]!.payload).toEqual({ id: em, auto: true })
  })
})
