// Adversarial review (rv/sec): can an anonymous caller learn which email addresses have an account?
import { describe, expect, it } from 'vitest'
import { useHarness } from '../auth/harness.js'
import { sleep } from '../helpers/sse.js'

const DELIVERY_MS = 400 // a real SMS Gate hop or an SES call, which is what the reset waits on

describe('SEC-07 password reset does not reveal whether an account exists', () => {
  const h = useHarness()

  it('answers in the same time for a known and an unknown email even when delivery is slow', async () => {
    const u = await h.createUser({ email: 'known@example.test', roles: ['crew'] })
    const deliver = h.notifier.deliver.bind(h.notifier)
    h.notifier.deliver = async (m) => {
      await sleep(DELIVERY_MS)
      return deliver(m)
    }
    const time = async (email: string, ip: string): Promise<number> => {
      const t0 = performance.now()
      const res = await h.t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password/forgot',
        headers: { origin: h.origin },
        remoteAddress: ip,
        payload: { email },
      })
      expect(res.statusCode).toBe(202)
      return performance.now() - t0
    }
    try {
      const unknown = await time('nobody@example.test', '10.90.0.1')
      const known = await time(u.email, '10.90.0.2')
      expect(known - unknown).toBeLessThan(DELIVERY_MS / 2)
    } finally {
      h.notifier.deliver = deliver
    }
    // the link still goes out
    await sleep(DELIVERY_MS * 2)
    expect(h.notifier.last('password_reset')?.email).toBe(u.email)
  })
})

describe('SEC-12 an anonymous caller cannot keep texting a colleague reset links', () => {
  const h = useHarness()

  it('sends at most three self-service reset messages per account per hour', async () => {
    const u = await h.createUser({ email: 'known@example.test', roles: ['crew'] })
    for (let i = 0; i < 6; i++) {
      const res = await h.t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/password/forgot',
        headers: { origin: h.origin },
        remoteAddress: `10.91.0.${i + 1}`,
        payload: { email: u.email },
      })
      expect(res.statusCode).toBe(202)
      h.clock.advance(61_000) // past the one-minute coalescing window each time
    }
    expect(h.notifier.sent.filter((m) => m.kind === 'password_reset')).toHaveLength(3)
    // an hour on, the person can ask again
    h.clock.advance(3_600_000)
    await h.t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/forgot',
      headers: { origin: h.origin },
      remoteAddress: '10.91.0.99',
      payload: { email: u.email },
    })
    expect(h.notifier.sent.filter((m) => m.kind === 'password_reset')).toHaveLength(4)
  })
})
