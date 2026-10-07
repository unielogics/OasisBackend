// Adversarial review (rv/sec): behind nginx the client address comes from X-Forwarded-For. Which entry may the app believe?
import { describe, expect, it } from 'vitest'
import { loadEnv } from '../../src/config/env.js'
import { useHarness } from '../auth/harness.js'

const REAL_CLIENT = '203.0.113.7' // what the proxy appended
const PROXY = '10.0.0.1' // the socket peer (nginx on the same host or subnet)

describe('SEC-05 TRUST_PROXY=true must not let a client choose its own address', () => {
  const h = useHarness({ env: { TRUST_PROXY: 'true' } })

  it('keeps the per-address login throttle when the client prepends spoofed X-Forwarded-For entries', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 16; i++) {
      // nginx's $proxy_add_x_forwarded_for: whatever the client sent, then the address it really connected from
      const res = await h.t.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: PROXY,
        headers: { origin: h.origin, 'x-forwarded-for': `198.51.100.${i + 1}, ${REAL_CLIENT}` },
        payload: { email: `guess${i}@example.test`, password: 'not the password' },
      })
      statuses.push(res.statusCode)
    }
    // ten free failures per address, then the wait starts: a sixteen-guess burst from one address must hit it
    expect(statuses).toContain(429)
  })

  it('records the address the proxy appended, not the first entry the client supplied', async () => {
    const owner = await h.createUser({ email: 'owner@example.test', roles: ['super'] })
    const res = await h.t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: PROXY,
      headers: { origin: h.origin, 'x-forwarded-for': `198.51.100.99, ${REAL_CLIENT}` },
      payload: { email: owner.email, password: owner.password },
    })
    expect(res.statusCode).toBe(200)
    const row = await h.t.db.selectFrom('sessions').select('ip').executeTakeFirstOrThrow()
    expect(String(row.ip)).toBe(REAL_CLIENT)
  })
})

describe('SEC-05 TRUST_PROXY parsing', () => {
  const base = { DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/x' }

  it('accepts false, a hop count and an address list; true means one trusted hop, never "everyone"', () => {
    expect(loadEnv({ ...base, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false)
    expect(loadEnv({ ...base, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(1)
    expect(loadEnv({ ...base, TRUST_PROXY: '2' }).TRUST_PROXY).toBe(2)
    expect(loadEnv({ ...base, TRUST_PROXY: 'loopback, 10.0.0.0/8' }).TRUST_PROXY).toEqual([
      'loopback',
      '10.0.0.0/8',
    ])
    expect(loadEnv({ ...base }).TRUST_PROXY).toBe(false)
  })

  it('refuses a value that is neither', () => {
    expect(() => loadEnv({ ...base, TRUST_PROXY: 'sometimes' })).toThrow(/TRUST_PROXY/)
  })
})
