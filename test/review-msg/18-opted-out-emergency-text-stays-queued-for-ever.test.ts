// Review finding 18: an emergency text that is cancelled before it is sent (the customer texted STOP after the closure was
// announced, or staff cancelled it) leaves its emergency_notifications row `queued` for ever, because only sent, delivered,
// failed and expired texts are followed. The emergency screen then counts a customer who was deliberately not texted as
// still waiting.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SIM_DEVICE_KEY } from '../../db/seeds/messaging.js'
import { configureProductionPayments, configureProductionSettings, messagingRuntimeFor } from '../../src/composition.js'
import { createPermissiveAuthorizer } from '../../src/http/authorizer.js'
import { apiModules } from '../../src/http/modules.js'
import type { MessagingRuntime } from '../../src/modules/messaging/runtime.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { makeUser } from '../helpers/factories.js'
import { useWorld } from '../messaging-db/world.js'

const w = useWorld()
let app: TestApp
let rt: MessagingRuntime

beforeAll(async () => {
  const user = await makeUser(w.t.db, w.newId, { first: 'Desk', email: 'desk-review18@example.test' })
  app = await createTestApp({
    testDb: w.t,
    modules: apiModules,
    authorizer: (location) => createPermissiveAuthorizer({ locationId: location.id, userId: user.userId, employeeId: user.employeeId, actorName: 'Desk U.' }),
    env: { SMS_ALLOWLIST: w.env.SMS_ALLOWLIST, SMSGATE_MIN_INTERVAL_MS: '0', EMAIL_CONSOLE_DIR: w.env.EMAIL_CONSOLE_DIR },
  })
  rt = messagingRuntimeFor({ db: w.t.db, clock: w.clock, env: app.env })
  configureProductionSettings({ clock: w.clock, newId: w.newId, messaging: rt })
  configureProductionPayments(rt)
})
afterAll(async () => {
  await rt?.idle()
  await app?.close()
})

describe('an emergency text cancelled before it left', () => {
  it('is not left queued on the emergency screen', async () => {
    const maria = w.customer('Maria Delgado')
    const svc = await w.t.db.selectFrom('services').select('id').where('name', '=', 'Express Hand Wash').where('kind', '=', 'package').executeTakeFirstOrThrow()
    const booked = await app.app.inject({
      method: 'POST',
      url: '/api/v1/appointments',
      headers: { 'idempotency-key': 'review18-book-1234' },
      payload: { customer: { id: maria.id }, serviceId: svc.id, start: '2026-06-13T14:00:00-04:00' },
    })
    expect(booked.statusCode, booked.body).toBe(201)
    const close = await app.app.inject({
      method: 'POST',
      url: '/api/v1/emergency/close',
      headers: { 'idempotency-key': 'review18-close-1234' },
      payload: { reason: 'Severe weather', dur: 'today', notify: true, link: true, credits: true, pause: true, crew: false },
    })
    expect(close.statusCode, close.body).toBe(201)

    // she texts STOP before the tablet gets to the emergency text
    const ev = w.signed('sms:received', { messageId: 'review18-stop', sender: maria.phone, recipient: '+15555550100', simNumber: 1, message: 'STOP', receivedAt: w.clock.now().toISOString() })
    await rt.webhooks.receive(SIM_DEVICE_KEY, ev.headers, ev.body)
    await rt.idle()
    await rt.pollHealthAll()
    for (let i = 0; i < 3; i++) await rt.tickAll()
    await rt.idle()

    const note = await w.t.db.selectFrom('emergency_notifications').select(['state', 'message_id']).where('customer_id', '=', maria.id).executeTakeFirstOrThrow()
    const msg = await w.t.db.selectFrom('messages').select('status').where('id', '=', note.message_id!).executeTakeFirstOrThrow()
    expect(msg.status).toBe('canceled')
    expect(note.state).not.toBe('queued')
  })
})
