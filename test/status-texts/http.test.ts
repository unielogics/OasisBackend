// The status texts through the production composition (src/http/modules.ts apiModules): the staff's own buttons (arrive, start,
// complete, pickup) reach the status-texts port. Off by default: the same calls send only the texts sent before (wash started, ready).
// On: a manual arrival queues the checked-in text and the pickup sends the thank-you.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { sql } from 'kysely'
import { createPermissiveAuthorizer } from '../../src/http/authorizer.js'
import { apiModules } from '../../src/http/modules.js'
import { updateSetting } from '../../src/platform/settings.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { makeUser } from '../helpers/factories.js'
import { useWorld } from '../messaging-db/world.js'

const w = useWorld({ start: '2026-06-12T10:00:00-04:00' })
let app: TestApp
let keyN = 0

beforeAll(async () => {
  const user = await makeUser(w.t.db, w.newId, { first: 'Desk', email: 'desk-status@example.test' })
  app = await createTestApp({
    testDb: w.t,
    modules: apiModules,
    authorizer: (location) => createPermissiveAuthorizer({ locationId: location.id, userId: user.userId, employeeId: user.employeeId, actorName: 'Desk U.' }),
    env: { SMS_ALLOWLIST: w.env.SMS_ALLOWLIST, SMSGATE_MIN_INTERVAL_MS: '0', EMAIL_CONSOLE_DIR: w.env.EMAIL_CONSOLE_DIR },
  })
})
afterAll(async () => {
  await app?.close()
})
afterEach(async () => {
  await sql`delete from settings where key like 'status_texts.%'`.execute(w.t.db)
})

const post = (url: string, body?: object): Promise<LightMyRequestResponse> =>
  app.app.inject({ method: 'POST', url: `/api/v1${url}`, headers: { 'idempotency-key': `status-http-${++keyN}-xxxxxxxx` }, ...(body ? { payload: body } : {}) })

async function throughTheDay(id: string): Promise<void> {
  for (const [path, body] of [
    ['arrive', {}],
    ['start', {}],
    ['complete', {}],
    ['pickup', { state: 'collected' }],
  ] as const) {
    const r = await post(`/appointments/${id}/${path}`, body)
    expect(r.statusCode, `${path}: ${r.body}`).toBe(200)
  }
}
const sent = async (id: string) =>
  (await w.t.db.selectFrom('messages').select(['template_key', 'purpose']).where('appointment_id', '=', id).where('direction', '=', 'out').orderBy('queued_at').orderBy('id').execute())

describe('status texts through the API', () => {
  it('off by default: a visit gets only the texts it got before (wash started, ready for pickup)', async () => {
    const id = await w.appointment({ customer: 'Maria Delgado', at: '2026-06-12T10:00:00-04:00' })
    await throughTheDay(id)
    expect((await sent(id)).map((m) => m.template_key)).toEqual(['in_progress', 'ready'])
    expect(await w.t.db.selectFrom('pending_checkin_texts').selectAll().execute()).toEqual([])
  })

  it('on: the manual arrival queues the checked-in text (dropped when the wash starts) and the pickup sends the thank-you', async () => {
    await w.tx(async (tx) => {
      for (const key of ['status_texts.checked_in', 'status_texts.picked_up'] as const) await updateSetting(tx, { locationId: w.locationId, key, value: true })
    })
    const id = await w.appointment({ customer: 'Liam Chen', at: '2026-06-12T10:00:00-04:00' })
    await throughTheDay(id)
    expect(await w.t.db.selectFrom('pending_checkin_texts').select(['state', 'drop_reason']).where('appointment_id', '=', id).execute()).toEqual([
      { state: 'dropped', drop_reason: 'cleaning_started' },
    ])
    expect(await sent(id)).toEqual([
      { template_key: 'in_progress', purpose: 'start' },
      { template_key: 'ready', purpose: 'complete' },
      { template_key: 'picked_up', purpose: 'picked_up' },
    ])
  })
})
