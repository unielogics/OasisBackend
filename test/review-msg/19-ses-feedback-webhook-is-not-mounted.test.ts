// Review finding 19: docs/integrations/ses.md (and review B34) make SNS bounce and complaint feedback part of the email
// design: POST /hooks/ses decides suppressions and customers.email_bounced_at, and the suppression list is wired into the
// provider with createEmailProvider(env, { isSuppressed }). Neither is wired in the app: the route does not exist and the
// messaging runtime builds its provider without isSuppressed, so a hard-bounced or complaining address is mailed again.
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

  // Open finding, pinned as an expected failure so the suite stays green; mounting /hooks/ses makes this fail, and then it
  // must become a plain it() again.
  it.fails('has a public POST /hooks/ses route', async () => {
    const res = await app.app.inject({
      method: 'POST',
      url: '/hooks/ses',
      headers: { 'content-type': 'text/plain' },
      payload: '{}',
    })
    expect(res.statusCode, 'a malformed SNS body is answered 400, an absent route 404').not.toBe(404)
  })
})
