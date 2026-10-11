// The staff takeover through the real send route (ADR 0160: "a staff reply pauses the AI on that thread"): POST
// /appointments/:id/messages pauses the AI on the client's thread for assistant.staff_pause_hours and resolves an open handoff; the
// composer cannot send the assistant's own lines.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { createPermissiveAuthorizer } from '../../src/http/authorizer.js'
import { apiModules } from '../../src/http/modules.js'
import { messagingRuntimeFor } from '../../src/composition.js'
import type { MessagingRuntime } from '../../src/modules/messaging/runtime.js'
import { STAFF_SENDABLE } from '../../src/modules/messaging/http/thread-routes.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { makeUser } from '../helpers/factories.js'
import { useWorld } from './world.js'

const w = useWorld()
let app: TestApp
let rt: MessagingRuntime
let employeeId = ''
let keyN = 0

beforeAll(async () => {
  const user = await makeUser(w.t.db, w.newId, { first: 'Desk', email: 'desk-assistant@example.test' })
  employeeId = user.employeeId
  app = await createTestApp({
    testDb: w.t,
    modules: apiModules,
    authorizer: (location) => createPermissiveAuthorizer({ locationId: location.id, userId: user.userId, employeeId: user.employeeId, actorName: 'Desk U.' }),
    env: { SMS_ALLOWLIST: w.env.SMS_ALLOWLIST, SMSGATE_MIN_INTERVAL_MS: '0', EMAIL_CONSOLE_DIR: w.env.EMAIL_CONSOLE_DIR },
  })
  rt = messagingRuntimeFor({ db: w.t.db, clock: w.clock, env: app.env })
})
afterAll(async () => {
  await rt?.idle()
  await app?.close()
})

const post = (url: string, body: unknown): Promise<LightMyRequestResponse> =>
  app.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: { 'idempotency-key': `assistant-route-${++keyN}-abcdefgh` }, payload: body as object })

describe('a staff reply from the Messages tab', () => {
  it('pauses the AI on the thread for staff_pause_hours and resolves the open handoff', async () => {
    const maria = w.customer('Maria Delgado')
    await w.t.db
      .insertInto('assistant_conversations')
      .values({ id: w.newId(), location_id: w.locationId, phone_e164: maria.phone, customer_id: maria.id, handoff_state: 'open', handoff_reason: 'agent_keyword', handoff_at: w.clock.now(), pending_since: w.clock.now() })
      .execute()
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    const res = await post(`/appointments/${appt}/messages`, { text: 'Hi Maria, Sam here — what can I do for you?' })
    expect(res.statusCode).toBe(201)

    const thread = await w.t.db.selectFrom('message_threads').select(['ai_paused_until', 'ai_paused_by']).where('customer_id', '=', maria.id).executeTakeFirstOrThrow()
    expect(thread).toEqual({ ai_paused_until: new Date(w.clock.now().getTime() + 12 * 3600_000), ai_paused_by: employeeId })
    expect(await w.t.db.selectFrom('assistant_conversations').select(['handoff_state', 'pending_since']).execute()).toEqual([{ handoff_state: 'resolved', pending_since: null }])
  })

  it('the composer cannot send the assistant\'s lines, the link or code texts', async () => {
    for (const k of ['code_on_link_page', 'ai_fallback', 'action_confirm', 'personal_link_verify']) expect(STAFF_SENDABLE as readonly string[]).not.toContain(k)
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T15:00:00-04:00' })
    const res = await post(`/appointments/${appt}/messages`, { templateKey: 'code_on_link_page' })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'SMS_TEMPLATE_INVALID' })
  })
})
