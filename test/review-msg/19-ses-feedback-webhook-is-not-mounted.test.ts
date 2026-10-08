// Review finding 19: docs/integrations/ses.md (and review B34) make SNS bounce and complaint feedback part of the email
// design: POST /hooks/ses decides suppressions and customers.email_bounced_at, and the suppression list is wired into the
// provider. Fixed by ADR 0110 (src/modules/messaging/email/hook.ts and feedback.ts); test/aws/ses-feedback.test.ts covers the
// signature, topic, replay and persistence rules.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hookModules } from '../../src/http/modules.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { createTestDb, type TestDb } from '../helpers/db.js'

describe('SES feedback', () => {
  let t: TestDb
  let app: TestApp
  beforeAll(async () => {
    t = await createTestDb({ poolMax: 2 })
    app = await createTestApp({ testDb: t, modules: [], hookModules })
  })
  afterAll(async () => {
    await app?.close()
    await t?.close()
  })

  it('has a public POST /hooks/ses route', async () => {
    const res = await app.app.inject({
      method: 'POST',
      url: '/hooks/ses',
      headers: { 'content-type': 'text/plain' },
      payload: '{}',
    })
    expect(res.statusCode, 'a malformed SNS body is answered 400, an absent route 404').not.toBe(404)
  })
})
