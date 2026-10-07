import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from '../../src/modules/auth/sessions.js'
import { TEST_PASSWORD, useHarness } from './harness.js'

const HOUR = 3_600_000
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

describe('login, cookie and session model', () => {
  const h = useHarness()

  it('signs in, sets an httpOnly SameSite=Lax cookie with an opaque token, and stores only its hash', async () => {
    const u = await h.createUser({
      email: 'amara@example.test',
      roles: ['super'],
      first: 'Amara',
      last: 'Okoye',
    })
    const res = await h.t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: h.origin },
      payload: { email: 'AMARA@example.test ', password: u.password },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      user: { email: 'amara@example.test', name: 'Amara O.' },
      csrfToken: expect.any(String),
    })
    expect(res.headers['cache-control']).toBe('no-store')
    const raw = String(res.headers['set-cookie'])
    expect(raw).toMatch(/^oasis_sid=[A-Za-z0-9_-]{43};/)
    expect(raw).toMatch(/HttpOnly/i)
    expect(raw).toMatch(/SameSite=Lax/i)
    expect(raw).toMatch(/Path=\//)
    // relative lifetime: a frozen or offset server clock must not hand the browser a cookie that is already expired
    expect(raw).toMatch(new RegExp(`Max-Age=${SESSION_ABSOLUTE_MS / 1000}(;|$)`, 'i'))
    expect(raw).not.toMatch(/Expires=/i)
    expect(raw).not.toMatch(/Secure/i)

    const token = res.cookies[0]!.value
    const rows = await h.t.db.selectFrom('sessions').selectAll().execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(sha256(token))
    expect(rows[0]!.id).not.toBe(token)
    expect(rows[0]!.csrf_secret).not.toContain(res.json().csrfToken)
    const lifetimeMs = rows[0]!.absolute_expires_at.getTime() - rows[0]!.created_at.getTime()
    expect(lifetimeMs).toBe(SESSION_ABSOLUTE_MS)
    expect(rows[0]!.idle_expires_at.getTime() - rows[0]!.created_at.getTime()).toBe(SESSION_IDLE_MS)
  })

  it('answers wrong password and unknown email with the same generic 401', async () => {
    await h.createUser({ email: 'a@example.test' })
    const wrong = await h.call('POST', 'auth/login', {
      body: { email: 'a@example.test', password: 'not the password' },
    })
    const unknown = await h.call('POST', 'auth/login', {
      body: { email: 'nobody@example.test', password: 'not the password' },
    })
    for (const r of [wrong, unknown]) {
      expect(r.statusCode).toBe(401)
      expect(r.json()).toMatchObject({
        code: 'INVALID_CREDENTIALS',
        title: 'Sign-in failed',
        detail: 'Email or password is incorrect',
      })
    }
  })

  it('rotates: logging in again replaces the pre-login session, whose cookie stops working', async () => {
    const u = await h.createUser({ email: 'a@example.test' })
    const first = await h.login(u)
    const second = await h.t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: h.origin, cookie: first.cookie },
      payload: { email: u.email, password: u.password },
    })
    expect(second.statusCode).toBe(200)
    const token2 = second.cookies[0]!.value
    expect(token2).not.toBe(first.token)
    expect((await h.call('GET', 'me', { session: first })).statusCode).toBe(401)
    expect(
      (await h.call('GET', 'me', { session: { cookie: `oasis_sid=${token2}`, csrf: '' } })).statusCode,
    ).toBe(200)
  })

  it('expires after 12 hours idle, sliding with activity', async () => {
    const u = await h.createUser({ email: 'a@example.test' })
    const s = await h.login(u)
    h.clock.advance(11 * HOUR)
    expect((await h.call('GET', 'me', { session: s })).statusCode).toBe(200) // slides the idle window
    h.clock.advance(11 * HOUR)
    expect((await h.call('GET', 'me', { session: s })).statusCode).toBe(200)
    h.clock.advance(12 * HOUR + 1000)
    const gone = await h.call('GET', 'me', { session: s })
    expect(gone.statusCode).toBe(401)
    expect(gone.json().code).toBe('UNAUTHENTICATED')
  })

  it('expires 14 days after login no matter how active the session is', async () => {
    const u = await h.createUser({ email: 'a@example.test' })
    const s = await h.login(u)
    for (let i = 0; i < 40; i++) {
      h.clock.advance(11 * HOUR)
      const r = await h.call('GET', 'me', { session: s })
      if (h.clock.now().getTime() - new Date('2026-06-13T10:36:00-04:00').getTime() >= SESSION_ABSOLUTE_MS) {
        expect(r.statusCode).toBe(401)
        return
      }
      expect(r.statusCode).toBe(200)
    }
    throw new Error('session never hit the absolute limit')
  })

  it('logout revokes the session and clears the cookie', async () => {
    const u = await h.createUser({ email: 'a@example.test' })
    const s = await h.login(u)
    const out = await h.call('POST', 'auth/logout', { session: s })
    expect(out.statusCode).toBe(204)
    expect(String(out.headers['set-cookie'])).toMatch(/oasis_sid=;/)
    expect((await h.call('GET', 'me', { session: s })).statusCode).toBe(401)
    const row = await h.t.db.selectFrom('sessions').select('revoked_at').executeTakeFirstOrThrow()
    expect(row.revoked_at).not.toBeNull()
  })

  it('rejects unknown, malformed and revoked cookies', async () => {
    const u = await h.createUser({ email: 'a@example.test' })
    for (const cookie of ['oasis_sid=garbage', `oasis_sid=${'A'.repeat(43)}`, 'oasis_sid=']) {
      expect((await h.call('GET', 'me', { session: { cookie, csrf: '' } })).statusCode).toBe(401)
    }
    const s = await h.login(u)
    await h.identity.sessions.revoke(sha256(s.token))
    expect((await h.call('GET', 'me', { session: s })).statusCode).toBe(401)
  })
})

describe('production cookie', () => {
  const h = useHarness({
    env: {
      NODE_ENV: 'production',
      COOKIE_SECURE: 'true',
      SESSION_SECRET: 'x'.repeat(40),
      SECRETS_KEY: Buffer.alloc(32, 5).toString('base64'),
      PUBLIC_DASHBOARD_URL: 'https://app.oasis.test',
      PUBLIC_API_URL: 'https://app.oasis.test',
    },
  })

  it('is __Host- prefixed and Secure', async () => {
    const u = await h.createUser({ email: 'a@example.test' })
    const res = await h.t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'https://app.oasis.test' },
      payload: { email: u.email, password: u.password },
    })
    expect(res.statusCode).toBe(200)
    const raw = String(res.headers['set-cookie'])
    expect(raw).toMatch(/^__Host-oasis_sid=/)
    expect(raw).toMatch(/Secure/i)
    expect(raw).toMatch(/HttpOnly/i)
    expect(raw).toMatch(/SameSite=Lax/i)
    expect(raw).not.toMatch(/Domain=/i)
    expect(h.cookieName).toBe('__Host-oasis_sid')
  })
})

describe('login throttling (progressive delay, never a hard lock)', () => {
  const h = useHarness()

  const attempt = (email: string, password: string, ip = '10.9.9.9') =>
    h.t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: h.origin },
      remoteAddress: ip,
      payload: { email, password },
    })

  it('adds a growing wait after repeated failures on one account, capped at 30 seconds, and a correct password works once it passes', async () => {
    const u = await h.createUser({ email: 'a@example.test' })
    for (let i = 0; i < 4; i++) expect((await attempt(u.email, 'wrong password!')).statusCode).toBe(401) // free attempts
    expect((await attempt(u.email, 'wrong password!')).statusCode).toBe(401) // 5th failure starts the delay
    const blocked = await attempt(u.email, u.password) // even the right password waits
    expect(blocked.statusCode).toBe(429)
    expect(blocked.json().code).toBe('LOGIN_THROTTLED')
    expect(Number(blocked.headers['retry-after'])).toBe(1)

    h.clock.advance(1100)
    expect((await attempt(u.email, 'wrong password!')).statusCode).toBe(401) // 6th failure -> 2 s
    expect(Number((await attempt(u.email, u.password)).headers['retry-after'])).toBe(2)
    for (let i = 0; i < 8; i++) {
      h.clock.advance(31_000)
      expect((await attempt(u.email, 'wrong password!')).statusCode).toBe(401)
    }
    const capped = await attempt(u.email, u.password)
    expect(capped.statusCode).toBe(429)
    expect(Number(capped.headers['retry-after'])).toBeLessThanOrEqual(30)

    h.clock.advance(31_000)
    expect((await attempt(u.email, u.password)).statusCode).toBe(200) // never locked out for good
    expect((await attempt(u.email, 'wrong password!')).statusCode).toBe(401) // success reset the account counter
  })

  it('throttles per client IP across accounts, and unknown emails count too', async () => {
    for (let i = 0; i < 10; i++)
      expect((await attempt(`ghost${i}@example.test`, 'wrong password!', '10.7.7.7')).statusCode).toBe(401)
    expect((await attempt('ghost-x@example.test', 'wrong password!', '10.7.7.7')).statusCode).toBe(401)
    const r = await attempt('ghost-y@example.test', 'wrong password!', '10.7.7.7')
    expect(r.statusCode).toBe(429)
    // another address is unaffected
    expect((await attempt('ghost-y@example.test', 'wrong password!', '10.7.7.8')).statusCode).toBe(401)
  })

  it('a failing neighbour does not lock a real account for 15 minutes', async () => {
    const u = await h.createUser({ email: 'a@example.test' })
    for (let i = 0; i < 12; i++) {
      await attempt(u.email, 'wrong password!', `10.8.8.${i}`)
      h.clock.advance(31_000)
    }
    expect((await attempt(u.email, u.password, '10.8.9.9')).statusCode).toBe(200)
  })
})

describe('CSRF: Origin check plus synchronizer token', () => {
  const h = useHarness()

  it('rejects unsafe requests without or with a wrong X-CSRF-Token, accepts the right one', async () => {
    const u = await h.createUser({ email: 'a@example.test' })
    const s = await h.login(u)
    const missing = await h.call('PUT', 'me/preferences', {
      session: s,
      csrf: false,
      body: { theme: 'dark' },
    })
    expect(missing.statusCode).toBe(403)
    expect(missing.json().code).toBe('CSRF_INVALID')
    const wrong = await h.call('PUT', 'me/preferences', {
      session: s,
      csrf: false,
      headers: { 'x-csrf-token': 'nope' },
      body: { theme: 'dark' },
    })
    expect(wrong.json().code).toBe('CSRF_INVALID')
    const ok = await h.call('PUT', 'me/preferences', { session: s, body: { theme: 'dark' } })
    expect(ok.statusCode).toBe(200)
  })

  it("GET /auth/csrf returns the login token; another session's token does not work", async () => {
    const a = await h.login(await h.createUser({ email: 'a@example.test' }))
    const b = await h.login(await h.createUser({ email: 'b@example.test' }), '10.0.0.5')
    const got = await h.call('GET', 'auth/csrf', { session: a })
    expect(got.json().csrfToken).toBe(a.csrf)
    expect(b.csrf).not.toBe(a.csrf)
    const cross = await h.call('PUT', 'me/preferences', {
      session: a,
      csrf: false,
      headers: { 'x-csrf-token': b.csrf },
      body: { theme: 'dark' },
    })
    expect(cross.statusCode).toBe(403)
  })

  it('refuses a foreign Origin even with a valid token, and safe methods need no token', async () => {
    const s = await h.login(await h.createUser({ email: 'a@example.test' }))
    const res = await h.call('PUT', 'me/preferences', {
      session: s,
      headers: { origin: 'https://evil.example' },
      body: { theme: 'dark' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('ORIGIN_NOT_ALLOWED')
    expect((await h.call('GET', 'me', { session: { cookie: s.cookie, csrf: '' } })).statusCode).toBe(200)
  })
})

describe('password change, forgot and reset', () => {
  const h = useHarness()

  it('changing the password revokes every other session and keeps the current one', async () => {
    const u = await h.createUser({ email: 'a@example.test' })
    const here = await h.login(u, '10.0.1.1')
    const there = await h.login(u, '10.0.1.2')
    const bad = await h.call('POST', 'auth/password/change', {
      session: here,
      body: { currentPassword: 'wrong wrong wrong', newPassword: 'a brand new passphrase' },
    })
    expect(bad.statusCode).toBe(422)
    expect(bad.json().code).toBe('CURRENT_PASSWORD_INVALID')
    const weak = await h.call('POST', 'auth/password/change', {
      session: here,
      body: { currentPassword: u.password, newPassword: 'short' },
    })
    expect(weak.statusCode).toBe(422)

    const ok = await h.call('POST', 'auth/password/change', {
      session: here,
      body: { currentPassword: u.password, newPassword: 'a brand new passphrase' },
    })
    expect(ok.statusCode).toBe(200)
    expect((await h.call('GET', 'me', { session: here })).statusCode).toBe(200)
    expect((await h.call('GET', 'me', { session: there })).statusCode).toBe(401)
    const old = await h.t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: h.origin },
      payload: { email: u.email, password: u.password },
    })
    expect(old.statusCode).toBe(401)
    await h.login({ email: u.email, password: 'a brand new passphrase' })
  })

  it('forgot always answers 202, and a known account gets a link through the notification port', async () => {
    const u = await h.createUser({ email: 'a@example.test', phone: '(305) 555-0142' })
    const known = await h.call('POST', 'auth/password/forgot', { body: { email: 'A@example.test' } })
    const unknown = await h.call('POST', 'auth/password/forgot', { body: { email: 'nobody@example.test' } })
    expect(known.statusCode).toBe(202)
    expect(unknown.statusCode).toBe(202)
    expect(known.json()).toEqual(unknown.json())
    expect(h.notifier.sent).toHaveLength(1)
    const m = h.notifier.last('password_reset')!
    expect(m.email).toBe(u.email)
    expect(m.phone).toBe('+13055550142')
    expect(m.link).toMatch(/^http:\/\/localhost:3000\/reset-password\?token=[A-Za-z0-9_-]{43}$/)
    // a second request inside a minute is coalesced
    await h.call('POST', 'auth/password/forgot', { body: { email: u.email } })
    expect(h.notifier.sent).toHaveLength(1)
  })

  it('reset sets the password, is single-use, expires after an hour and revokes all sessions', async () => {
    const u = await h.createUser({ email: 'a@example.test' })
    const s = await h.login(u)
    await h.call('POST', 'auth/password/forgot', { body: { email: u.email } })
    const token = h.notifier.lastToken('password_reset')!
    const weak = await h.call('POST', 'auth/password/reset', { body: { token, password: 'short' } })
    expect(weak.statusCode).toBe(422)
    const ok = await h.call('POST', 'auth/password/reset', {
      body: { token, password: 'another long passphrase' },
    })
    expect(ok.statusCode).toBe(200)
    expect((await h.call('GET', 'me', { session: s })).statusCode).toBe(401)
    await h.login({ email: u.email, password: 'another long passphrase' })
    const again = await h.call('POST', 'auth/password/reset', {
      body: { token, password: 'yet another long passphrase' },
    })
    expect(again.statusCode).toBe(410)
    expect(again.json().code).toBe('RESET_INVALID')

    h.clock.advance(2 * 60_000)
    await h.call('POST', 'auth/password/forgot', { body: { email: u.email } })
    const late = h.notifier.lastToken('password_reset')!
    h.clock.advance(HOUR + 1000)
    expect(
      (
        await h.call('POST', 'auth/password/reset', {
          body: { token: late, password: 'late long passphrase' },
        })
      ).statusCode,
    ).toBe(410)
    expect(
      (
        await h.call('POST', 'auth/password/reset', {
          body: { token: 'x'.repeat(43), password: 'late long passphrase' },
        })
      ).statusCode,
    ).toBe(410)
  })

  it('a newer reset link invalidates the older one', async () => {
    const u = await h.createUser({ email: 'a@example.test' })
    await h.call('POST', 'auth/password/forgot', { body: { email: u.email } })
    const first = h.notifier.lastToken('password_reset')!
    h.clock.advance(2 * 60_000)
    await h.call('POST', 'auth/password/forgot', { body: { email: u.email } })
    const second = h.notifier.lastToken('password_reset')!
    expect(second).not.toBe(first)
    expect(
      (
        await h.call('POST', 'auth/password/reset', {
          body: { token: first, password: 'some long passphrase' },
        })
      ).statusCode,
    ).toBe(410)
    expect(
      (
        await h.call('POST', 'auth/password/reset', {
          body: { token: second, password: 'some long passphrase' },
        })
      ).statusCode,
    ).toBe(200)
  })
})

describe('first-user bootstrap', () => {
  const h = useHarness()

  it('creates the Super Admin on an empty database, once, with a working login', async () => {
    const { bootstrapAdmin } = await import('../../src/modules/auth/accounts.js')
    const first = await bootstrapAdmin(h.identity, { email: 'Owner@Example.test', password: TEST_PASSWORD })
    expect(first.created).toBe(true)
    const again = await bootstrapAdmin(h.identity, { email: 'other@example.test', password: TEST_PASSWORD })
    expect(again.created).toBe(false)
    expect(await h.t.db.selectFrom('users').select('email').execute()).toEqual([
      { email: 'owner@example.test' },
    ])

    const s = await h.login({ email: 'owner@example.test', password: TEST_PASSWORD })
    const me = h.json<{
      isSuperAdmin: boolean
      displayRole: string
      permissions: Record<string, { on: boolean }>
    }>(await h.call('GET', 'me', { session: s }))
    expect(me.isSuperAdmin).toBe(true)
    expect(me.displayRole).toBe('Super Admin')
    expect(Object.values(me.permissions).every((p) => p.on)).toBe(true)
    const roles = await h.t.db.selectFrom('roles').select('key').orderBy('key').execute()
    expect(roles.map((r) => r.key)).toEqual(['acct', 'crew', 'mgmt', 'super', 'support'])
  })

  it('does nothing when any user already exists', async () => {
    const { bootstrapAdmin } = await import('../../src/modules/auth/accounts.js')
    await h.createUser({ email: 'a@example.test' })
    expect(
      (await bootstrapAdmin(h.identity, { email: 'owner@example.test', password: TEST_PASSWORD })).created,
    ).toBe(false)
  })

  it('the password rule applies', async () => {
    const { createAccount } = await import('../../src/modules/auth/accounts.js')
    await expect(
      createAccount(h.identity, { email: 'x@example.test', password: 'short', first: 'X' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })
})

describe('/me and preferences', () => {
  const h = useHarness()

  it('returns the effective permission map, limits, role display and preferences', async () => {
    const u = await h.createUser({
      email: 'sofia@example.test',
      roles: ['support', 'crew'],
      first: 'Sofia',
      last: 'Duarte',
      overrides: { 'sched.override': 'allow' },
    })
    const s = await h.login(u)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const me = h.json<Record<string, any>>(await h.call('GET', 'me', { session: s }))
    expect(me.employee).toMatchObject({ name: 'Sofia D.', initials: 'SD' })
    expect(me.roles.map((r: { key: string }) => r.key)).toEqual(['support', 'crew'])
    expect(me.displayRole).toBe('Customer Support')
    expect(me.permissions['pay.refund']).toEqual({ on: true, limit: 5000 })
    expect(me.permissions['sched.override']).toEqual({ on: true })
    expect(me.permissions['team.edit']).toEqual({ on: false })
    expect(Object.keys(me.permissions)).toHaveLength(27)
    expect(me.limits).toEqual({ refund: 5000, adjust: 2500, credit: 5000 })
    expect(me.isSuperAdmin).toBe(false)
    expect(me.viewAs).toMatchObject({ active: false, canViewAs: false, roleId: null, options: [] })
    expect(me.preferences).toEqual({ theme: null })
    expect(typeof me.rbacVersion).toBe('number')
    expect(me.csrfToken).toBe(s.csrf)

    expect((await h.call('PUT', 'me/preferences', { session: s, body: { theme: 'dark' } })).statusCode).toBe(
      200,
    )
    expect(h.json<{ preferences: unknown }>(await h.call('GET', 'me', { session: s })).preferences).toEqual({
      theme: 'dark',
    })
    expect((await h.call('PUT', 'me/preferences', { session: s, body: { theme: 'neon' } })).statusCode).toBe(
      422,
    )
  })
})
