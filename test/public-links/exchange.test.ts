// Opening a personal link (ADR 0160, design sections 5 and 10): the exchange, the session, what the page may show, and the dead
// tokens (expired, wrong purpose, after a PIN change, after a links-epoch bump) that must all answer 401. The token travels only in
// the exchange body: never logged, never in a message, audit or idempotency row. Every answer is no-store JSON that cannot be read
// as markup.
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { windowStart } from '../../src/modules/public/limits.js'
import { LINK_LIMITS } from '../../src/modules/public/links/http/routes.js'
import { DAY, json, MIN, PHONES, SITE_ORIGIN, useLinksHarness } from './harness.js'

const h = useLinksHarness()

describe('POST exchange', () => {
  it('trades the token for a bearer session and shows the first name and the last two digits, unverified', async () => {
    const id = await h.customer({ name: 'Maria Delgado' })
    const link = await h.link({ customerId: id })
    const { res, body, session } = await h.open(link.token)
    expect(res.statusCode, res.body).toBe(200)
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(session).not.toBe(link.token)
    expect(body).toMatchObject({
      kind: 'calendar',
      client: { firstName: 'Maria', last2: '21', tier: null },
      trust: { verified: false, by: null, until: null },
      stepUp: { method: 'code', freshUntil: null, canSetPinUntil: null },
      appointments: null,
      invoice: null,
      plan: null,
    })
    expect(new Date(body.expiresAt).getTime() - h.clock.now().getTime()).toBe(60 * MIN)
    expect(new Date(body.idleExpiresAt).getTime() - h.clock.now().getTime()).toBe(15 * MIN)
    // only hashes are stored
    const s = await h.db.selectFrom('client_link_sessions').selectAll().executeTakeFirstOrThrow()
    expect(s.token_hash).not.toBe(session)
    expect(JSON.stringify(s)).not.toContain(session)
    // the page's state
    const me = await h.call('GET', 'me', { session })
    expect(me.statusCode).toBe(200)
    expect(json(me).client.firstName).toBe('Maria')
  })

  it('starts verified (no step-up) while the number’s 30-day trust is live, and then lists the client’s visits', async () => {
    const id = await h.customer()
    await h.trust(id)
    const { body } = await h.page({ customerId: id })
    expect(body.trust.verified).toBe(true)
    expect(body.trust.by).toBe('code')
    expect(new Date(body.trust.until).getTime() - h.clock.now().getTime()).toBe(30 * DAY)
    expect(body.appointments).toEqual([])
    expect(body.stepUp.freshUntil).toBeNull()
  })

  it('answers every response no-store, as JSON with nosniff and the API’s CSP, without a cookie', async () => {
    const id = await h.customer()
    const link = await h.link({ customerId: id })
    const ok = await h.open(link.token)
    const bad = await h.call('POST', 'exchange', { body: { token: 'z'.repeat(43) } })
    const me = await h.call('GET', 'me', { session: ok.session })
    for (const r of [ok.res, bad, me]) {
      expect(r.headers['cache-control']).toBe('no-store')
      expect(String(r.headers['content-type'])).toMatch(/json/)
      expect(r.headers['x-content-type-options']).toBe('nosniff')
      expect(String(r.headers['content-security-policy'])).toContain("default-src 'none'")
      expect(r.headers['set-cookie']).toBeUndefined()
    }
  })

  it('escapes <, > and & in the JSON text, so a name cannot become markup (CSP-safe JSON)', async () => {
    const id = await h.customer({ name: '<img src=x onerror=alert(1)>&co Delgado' })
    const link = await h.link({ customerId: id })
    const { res, body } = await h.open(link.token)
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toMatch(/[<>&]/)
    expect(res.body).toContain('\\u003cimg')
    expect(body.client.firstName).toBe('<img')
  })

  it('refuses an Origin outside the allowlist on reads and writes, allows the website and no Origin at all', async () => {
    const id = await h.customer()
    const link = await h.link({ customerId: id })
    expect((await h.call('POST', 'exchange', { body: { token: link.token }, origin: 'https://evil.example' })).statusCode).toBe(403)
    const { session } = await h.open(link.token)
    expect((await h.call('GET', 'me', { session, origin: 'https://evil.example' })).statusCode).toBe(403)
    expect((await h.call('GET', 'me', { session, origin: 'null' })).statusCode).toBe(403)
    expect((await h.call('GET', 'me', { session, origin: SITE_ORIGIN })).statusCode).toBe(200)
    expect((await h.call('GET', 'me', { session })).statusCode).toBe(200)
  })

  it('takes JSON only', async () => {
    const id = await h.customer()
    const link = await h.link({ customerId: id })
    const r = await h.t.app.inject({
      method: 'POST',
      url: '/api/v1/public/links/exchange',
      headers: { 'content-type': 'text/plain', origin: SITE_ORIGIN },
      payload: JSON.stringify({ token: link.token }),
    })
    expect(r.statusCode).toBe(415)
    expect(await h.db.selectFrom('client_link_sessions').selectAll().execute()).toEqual([])
  })
})

describe('dead tokens answer 401', () => {
  it('an unknown, malformed or expired token; a link used up by its exchanges', async () => {
    const id = await h.customer()
    for (const token of ['z'.repeat(43), 'short', `${'a'.repeat(42)}!`]) {
      const r = await h.call('POST', 'exchange', { body: { token } })
      expect(r.statusCode, token).toBe(401)
      expect(json(r)).toMatchObject({ code: 'IDENTITY_LINK_INVALID', meta: { reason: 'not_found' } })
    }
    const verify = await h.link({ customerId: id, kind: 'verify' })
    h.advance(16 * MIN)
    const expired = await h.call('POST', 'exchange', { body: { token: verify.token } })
    expect(expired.statusCode).toBe(401)
    expect(json(expired).meta.reason).toBe('expired')

    const pin = await h.link({ customerId: id, kind: 'pin' })
    for (let i = 0; i < 5; i++) expect((await h.open(pin.token)).res.statusCode).toBe(200)
    const sixth = await h.call('POST', 'exchange', { body: { token: pin.token } })
    expect(sixth.statusCode).toBe(401)
    expect(json(sixth).meta.reason).toBe('used')
  })

  it('wrong purpose: a session token as a link, a link token as a session, a link of one kind asking for another kind’s action', async () => {
    const id = await h.customer()
    const link = await h.link({ customerId: id })
    const { session } = await h.open(link.token)
    const asLink = await h.call('POST', 'exchange', { body: { token: session } })
    expect(asLink.statusCode).toBe(401)
    expect(json(asLink).code).toBe('IDENTITY_LINK_INVALID')
    const asSession = await h.call('GET', 'me', { session: link.token })
    expect(asSession.statusCode).toBe(401)
    expect(json(asSession).code).toBe('IDENTITY_SESSION_INVALID')
    for (const header of [undefined, 'Basic abc', `Bearer ${session}x`, `bearer ${session}`]) {
      const r = await h.call('GET', 'me', { headers: header ? { authorization: header } : {} })
      expect(r.statusCode, String(header)).toBe(401)
    }
    // a calendar page cannot pay or join; a membership page cannot book
    for (const path of ['pay/start', 'membership/start'] as const) {
      const r = await h.call('POST', path, { session, body: path === 'membership/start' ? { email: 'maria@example.test' } : {} })
      expect(r.statusCode, path).toBe(401)
      expect(json(r).code, path).toBe('LINK_WRONG_PURPOSE')
    }
  })

  it('after a PIN change: links issued before it die, and so do their open pages', async () => {
    const id = await h.customer()
    const before = await h.link({ customerId: id })
    const openBefore = await h.open(before.token)
    // another page sets the client's first PIN
    const other = await h.page({ customerId: id, kind: 'pin' })
    expect((await h.verifyByCode(other.session)).statusCode).toBe(200)
    const set = await h.call('POST', 'pin', { session: other.session, body: { pin: '4826' } })
    expect(set.statusCode, set.body).toBe(200)
    const reopened = await h.call('POST', 'exchange', { body: { token: before.token } })
    expect(reopened.statusCode).toBe(401)
    expect(json(reopened).meta.reason).toBe('revoked')
    expect((await h.call('GET', 'me', { session: openBefore.session })).statusCode).toBe(401)
    // the page that set it goes on
    expect((await h.call('GET', 'me', { session: other.session })).statusCode).toBe(200)
  })

  it('a links-epoch bump kills every session and link at once', async () => {
    const id = await h.customer()
    const link = await h.link({ customerId: id })
    const { session } = await h.open(link.token)
    expect((await h.call('GET', 'me', { session })).statusCode).toBe(200)
    await sql`insert into settings (location_id, key, value) values (${h.locationId}, 'links.epoch', '2'::jsonb)
      on conflict (location_id, key) do update set value = '2'::jsonb, version = settings.version + 1`.execute(h.db)
    const me = await h.call('GET', 'me', { session })
    expect(me.statusCode).toBe(401)
    expect(json(me).code).toBe('IDENTITY_SESSION_INVALID')
    expect((await h.call('POST', 'exchange', { body: { token: link.token } })).statusCode).toBe(401)
  })

  it('sessions end after 15 idle minutes and after their hour; a STOP from the number ends the link', async () => {
    const id = await h.customer()
    const link = await h.link({ customerId: id })
    const { session } = await h.open(link.token)
    h.advance(14 * MIN)
    expect((await h.call('GET', 'me', { session })).statusCode).toBe(200)
    h.advance(16 * MIN)
    expect((await h.call('GET', 'me', { session })).statusCode).toBe(401)
    const again = await h.open(link.token)
    for (let i = 0; i < 4; i++) {
      h.advance(14 * MIN)
      expect((await h.call('GET', 'me', { session: again.session })).statusCode).toBe(200)
    }
    h.advance(5 * MIN)
    expect((await h.call('GET', 'me', { session: again.session })).statusCode).toBe(401)
    await sql`insert into sms_opt_outs (id, location_id, phone_e164, opted_out_at, source)
      values (gen_random_uuid(), ${h.locationId}, ${PHONES.maria}, ${h.clock.now()}, 'keyword')`.execute(h.db)
    expect((await h.call('POST', 'exchange', { body: { token: link.token } })).statusCode).toBe(401)
  })
})

describe('what a page may show', () => {
  it('hides the name of a stale record (no activity for 180 days) even after a texted code: a code proves the number, not the client (W4c fixes)', async () => {
    const id = await h.customer({ createdAt: new Date(h.clock.now().getTime() - 200 * DAY) })
    const { session, body } = await h.page({ customerId: id })
    expect(body.client).toEqual({ firstName: '', last2: '21', tier: null })
    const v = await h.verifyByCode(session)
    expect(v.statusCode, v.body).toBe(200)
    expect(json(v).client.firstName).toBe('')
    expect(json(v).appointments).toBeNull()
  })

  it('shows no name for a placeholder client, and a stranger’s link knows nobody', async () => {
    const id = await h.customer({ name: 'New texter ••0122', phone: PHONES.liam, needsDetails: true })
    expect((await h.page({ customerId: id })).body.client.firstName).toBe('')
    const stranger = await h.page({ customerId: null, phone: PHONES.stranger })
    expect(stranger.body.client).toEqual({ firstName: '', last2: '23', tier: null })
    expect(stranger.body.trust.verified).toBe(false)
  })
})

describe('the token is never written anywhere but as its hash', () => {
  it('not in the logs, messages, outbox, audit or idempotency rows, after a full page visit', async () => {
    const id = await h.customer()
    const link = await h.link({ customerId: id })
    const { session } = await h.open(link.token)
    await h.call('POST', 'exchange', { body: { token: link.token.slice(0, 42) + 'Z' } })
    await h.verifyByCode(session)
    await h.call('GET', 'me', { session })
    await h.call('POST', 'bookings', { session, key: h.nextKey(), body: { serviceKey: h.key('Express Hand Wash'), addonKeys: [], date: '2026-06-13', startMin: 13 * 60 } })
    const logs = JSON.stringify(h.t.logs)
    expect(h.t.logs.length).toBeGreaterThan(5)
    const rows = await sql<{ blob: string }>`select concat_ws('|',
      (select coalesce(string_agg(body, '|'), '') from messages),
      (select coalesce(string_agg(body, '|'), '') from sms_outbox),
      (select coalesce(string_agg(coalesce(after::text, '') || coalesce(before::text, ''), '|'), '') from audit_log),
      (select coalesce(string_agg(to_jsonb(k)::text, '|'), '') from idempotency_keys k),
      (select coalesce(string_agg(to_jsonb(s)::text, '|'), '') from client_link_sessions s),
      (select coalesce(string_agg(to_jsonb(l)::text, '|'), '') from client_links l)) as blob`.execute(h.db)
    for (const secret of [link.token, session]) {
      expect(logs).not.toContain(secret)
      expect(logs).not.toContain(secret.slice(0, 20))
      expect(rows.rows[0]!.blob).not.toContain(secret)
    }
    // the request log line of the exchange carries the path only
    const lines = h.t.logs.filter((l) => JSON.stringify(l).includes('/public/links/exchange'))
    expect(lines.length).toBeGreaterThan(0)
  })
})

describe('limits', () => {
  it('30 exchanges per address every 10 minutes (durable, shared by every API process)', async () => {
    const id = await h.customer()
    const link = await h.link({ customerId: id })
    const ip = h.nextIp()
    const start = windowStart(h.clock.now(), LINK_LIMITS.exchange.ip.windowSec)
    await sql`insert into public_rate_limits (key, window_start, count) values (${`link_exchange:ip:${ip}`}, ${start}, 30)`.execute(h.db)
    const r = await h.call('POST', 'exchange', { body: { token: link.token }, ip })
    expect(r.statusCode).toBe(429)
    expect(json(r).code).toBe('PUBLIC_RATE_LIMITED')
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0)
    expect(await h.db.selectFrom('client_link_sessions').selectAll().execute()).toEqual([])
    expect((await h.call('POST', 'exchange', { body: { token: link.token } })).statusCode).toBe(200)
  })

  it('an IPv6 client counts by its /64: another address of a spent prefix is refused, another prefix is not (W4c fixes P8)', async () => {
    const id = await h.customer()
    const link = await h.link({ customerId: id })
    const start = windowStart(h.clock.now(), LINK_LIMITS.exchange.ip.windowSec)
    await sql`insert into public_rate_limits (key, window_start, count) values (${'link_exchange:ip:2001:db8:77:1::/64'}, ${start}, 30)`.execute(h.db)
    const r = await h.call('POST', 'exchange', { body: { token: link.token }, ip: '2001:db8:77:1:dead:beef:0:1' })
    expect(json(r)).toMatchObject({ status: 429, code: 'PUBLIC_RATE_LIMITED' })
    expect((await h.call('POST', 'exchange', { body: { token: link.token }, ip: '2001:db8:77:2::1' })).statusCode).toBe(200)
  })
})
