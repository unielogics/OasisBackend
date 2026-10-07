// Review finding 13: the tailnet hooks listener's error handler only understands Fastify's own statusCode. The body parser
// rejects invalid JSON with an AppError (status 400), which the handler turns into a 500 and an error log line, so a malformed
// request is answered like a server fault (the real device would retry such a delivery for two days).
import { afterEach, describe, expect, it } from 'vitest'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { buildHooksApp, type HooksApp } from '../../src/modules/messaging/http/hooks-app.js'
import { useWorld } from '../messaging-db/world.js'

const w = useWorld()
const listeners: HooksApp[] = []
afterEach(async () => {
  await Promise.all(listeners.splice(0).map((h) => h.close()))
})

describe('the hooks listener', () => {
  it('answers 400, not 500, to a body that is not JSON', async () => {
    const hooks = await buildHooksApp(w.rt, { host: '127.0.0.1', port: 0 })
    listeners.push(hooks)
    const base = await hooks.listen()
    const res = await fetch(`${base}/hooks/smsgate/${SIM_DEVICE_KEY}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
    expect(res.status).toBe(400)
  })
})
