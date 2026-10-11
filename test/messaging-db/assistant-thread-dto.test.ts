// The Messages tab's AI state (ADR 0160, design section 8): the thread DTO of GET /appointments/:id/messages and
// GET /customers/:id/messages carries whether the assistant answers at all (assistantActive), the staff pause (aiPausedUntil, only
// while it lasts) and the open handoff of the client's number ({open, since, reason}); the assistant's own texts are marked
// author 'ai', from 'system', senderName "Oasis AI". A staff reply pauses the AI and closes the handoff.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { createPermissiveAuthorizer } from '../../src/http/authorizer.js'
import { apiModules } from '../../src/http/modules.js'
import { messagingRuntimeFor } from '../../src/composition.js'
import type { MessagingRuntime } from '../../src/modules/messaging/runtime.js'
import { ensureThread } from '../../src/modules/messaging/db/messages.js'
import { updateSetting } from '../../src/platform/settings.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { makeUser } from '../helpers/factories.js'
import { useWorld } from './world.js'

const w = useWorld()
let app: TestApp
let rt: MessagingRuntime
let keyN = 0

beforeAll(async () => {
  const user = await makeUser(w.t.db, w.newId, { first: 'Desk', email: 'desk-thread-dto@example.test' })
  app = await createTestApp({
    testDb: w.t,
    modules: apiModules,
    authorizer: (location) => createPermissiveAuthorizer({ locationId: location.id, userId: user.userId, employeeId: user.employeeId, actorName: 'Desk U.' }),
    // the server switch on: the thread then follows Settings → Assistant (off by default)
    env: { AI_ENABLED: 'true', SMS_ALLOWLIST: w.env.SMS_ALLOWLIST, SMSGATE_MIN_INTERVAL_MS: '0', EMAIL_CONSOLE_DIR: w.env.EMAIL_CONSOLE_DIR },
  })
  rt = messagingRuntimeFor({ db: w.t.db, clock: w.clock, env: app.env })
})
afterAll(async () => {
  await rt?.idle()
  await app?.close()
})

interface ThreadJson {
  assistantActive: boolean
  aiPausedUntil: string | null
  handoff: { open: boolean; since: string | null; reason: string | null }
  items: { id: string; text: string; [k: string]: unknown }[]
}

const get = async (url: string): Promise<ThreadJson> => {
  const r = await app.app.inject({ method: 'GET', url: `/api/v1${url}` })
  expect(r.statusCode, r.body).toBe(200)
  return r.json()
}
const post = (url: string, body: unknown): Promise<LightMyRequestResponse> =>
  app.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: { 'idempotency-key': `thread-dto-${++keyN}-abcdefgh` }, payload: body as object })

/** An AI text already sent on the client's thread (as the assistant's turn writes it). */
async function aiText(customerId: string, appointmentId: string, body: string): Promise<string> {
  const id = w.newId()
  await w.tx(async (tx) => {
    const threadId = await ensureThread(tx, { locationId: w.locationId, customerId, newId: w.newId })
    await tx
      .insertInto('messages')
      .values({ id, location_id: w.locationId, thread_id: threadId, customer_id: customerId, appointment_id: appointmentId, direction: 'out', sender_kind: 'ai', channel: 'sms', body, klass: 'ai_reply', status: 'sent', sent_at: w.clock.now() })
      .execute()
  })
  return id
}

describe('the thread DTO', () => {
  it('nothing AI by default: inactive, no pause, no handoff', async () => {
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T14:00:00-04:00' })
    const t = await get(`/appointments/${appt}/messages`)
    expect(t).toMatchObject({ assistantActive: false, aiPausedUntil: null, handoff: { open: false, since: null, reason: null } })
    const c = await get(`/customers/${w.customer('Maria Delgado').id}/messages`)
    expect(c).toMatchObject({ assistantActive: false, aiPausedUntil: null, handoff: { open: false, since: null, reason: null } })
  })

  it('marks the AI’s texts, shows the open handoff of the number, then the staff pause after a staff reply, until it ends', async () => {
    const maria = w.customer('Maria Delgado')
    await w.tx((tx) =>
      updateSetting(tx, { locationId: w.locationId, key: 'assistant.enabled', value: true }),
    )
    const appt = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-13T15:00:00-04:00' })
    const msgId = await aiText(maria.id, appt, 'Hi Maria! A Signature Hand Wash starts at $45 for members.')
    // a handoff opened on her number before the client record was linked to the conversation: found by the phone
    const since = w.clock.now()
    await w.t.db
      .insertInto('assistant_conversations')
      .values({ id: w.newId(), location_id: w.locationId, phone_e164: maria.phone, customer_id: null, handoff_state: 'open', handoff_reason: 'agent_keyword', handoff_at: since })
      .execute()

    const t = await get(`/appointments/${appt}/messages`)
    expect(t.assistantActive).toBe(true)
    expect(t.aiPausedUntil).toBeNull()
    expect(t.handoff).toEqual({ open: true, since: since.toISOString(), reason: 'agent_keyword' })
    const ai = t.items.find((m) => m.id === msgId)
    expect(ai).toMatchObject({ direction: 'out', from: 'system', author: 'ai', senderName: 'Oasis AI', text: 'Hi Maria! A Signature Hand Wash starts at $45 for members.' })
    expect((await get(`/customers/${maria.id}/messages`)).handoff).toEqual(t.handoff)

    // staff answer: the AI pauses 12 h on the thread and the handoff closes
    expect((await post(`/appointments/${appt}/messages`, { text: 'Hi Maria, Sam here.' })).statusCode).toBe(201)
    const paused = await get(`/appointments/${appt}/messages`)
    expect(paused.aiPausedUntil).toBe(new Date(w.clock.now().getTime() + 12 * 3600_000).toISOString())
    expect(paused.handoff).toEqual({ open: false, since: null, reason: null })
    const staff = paused.items.find((m) => m.text.startsWith('Hi Maria, Sam here.'))
    expect(staff).toMatchObject({ from: 'staff', author: 'staff' })
    expect((await get(`/customers/${maria.id}/messages`)).aiPausedUntil).toBe(paused.aiPausedUntil)

    // the pause is over: no line any more
    w.clock.advance(12 * 3600_000 + 1000)
    expect((await get(`/customers/${maria.id}/messages`)).aiPausedUntil).toBeNull()

    // turning the assistant off in Settings hides it again
    await w.tx((tx) =>
      updateSetting(tx, { locationId: w.locationId, key: 'assistant.enabled', value: false }),
    )
    expect((await get(`/customers/${maria.id}/messages`)).assistantActive).toBe(false)
  })

  it('another client’s handoff never shows on this thread', async () => {
    const liam = w.customer('Liam Chen')
    await w.t.db
      .insertInto('assistant_conversations')
      .values({ id: w.newId(), location_id: w.locationId, phone_e164: liam.phone, customer_id: liam.id, handoff_state: 'open', handoff_reason: 'upset', handoff_at: w.clock.now() })
      .execute()
    expect((await get(`/customers/${w.customer('Maria Delgado').id}/messages`)).handoff.open).toBe(false)
    expect((await get(`/customers/${liam.id}/messages`)).handoff).toMatchObject({ open: true, reason: 'upset' })
  })
})
