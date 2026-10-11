// The step-up codes of link pages share the website's hourly ceiling (PUBLIC_OTP_TEXTS_PER_HOUR, ADR 0150/0160): one lock, one
// count, so neither surface can use the tablet's texts the other one needs.
import { describe, expect, it } from 'vitest'
import { json, PHONES, useLinksHarness } from './harness.js'

const capped = useLinksHarness({ env: { PUBLIC_OTP_TEXTS_PER_HOUR: '2', PUBLIC_WRITES_ENABLED: 'true' } })

describe('the shared hourly ceiling on texted codes', () => {
  it('counts the website’s codes and the link pages’ codes together', async () => {
    const web = await capped.t.app.inject({
      method: 'POST',
      url: '/api/v1/public/otp',
      headers: { origin: 'https://site.example.test', 'content-type': 'application/json' },
      payload: { phone: PHONES.other },
    })
    expect(web.statusCode, web.body).toBe(202)
    const id = await capped.customer()
    const { session } = await capped.page({ customerId: id })
    expect((await capped.call('POST', 'verify/code', { session, body: {} })).statusCode).toBe(202)
    const liam = await capped.customer({ name: 'Liam Ortiz', phone: PHONES.liam })
    const second = await capped.page({ customerId: liam })
    const third = await capped.call('POST', 'verify/code', { session: second.session, body: {} })
    expect(third.statusCode).toBe(429)
    expect(json(third).code).toBe('PUBLIC_CODES_PAUSED')
  })
})
