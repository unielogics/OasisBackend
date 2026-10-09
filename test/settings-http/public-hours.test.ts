import { describe, expect, it } from 'vitest'
import { json, useSettingsHarness, type Session } from './harness.js'

const h = useSettingsHarness()

let ipSeq = 0
/** A public call: no session, its own client address (the route has a per-address rate limit). */
const pub = (headers: Record<string, string> = {}, ip = `10.80.0.${(ipSeq++ % 250) + 1}`) =>
  h.t.app.inject({ method: 'GET', url: '/api/v1/public/hours', headers, remoteAddress: ip })

const close = (s: Session) =>
  h.post(
    'emergency/close',
    s,
    { reason: 'Severe weather', dur: 'today' },
    { 'idempotency-key': 'public-hours-close-1' },
  )

const keysOf = (x: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(x)) x.forEach((v) => keysOf(v, out))
  else if (x && typeof x === 'object')
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      out.add(k)
      keysOf(v, out)
    }
  return out
}

describe('GET /public/hours (the website, no session)', () => {
  it('answers without a session, with a bogus cookie too, and never sets one', async () => {
    const r = await pub()
    expect(r.statusCode).toBe(200)
    const b = json(r)
    expect(b.tz).toBe('America/New_York')
    expect(b.generatedAt).toBe('2026-06-13T14:36:00.000Z')
    expect(b.today).toMatchObject({
      date: '2026-06-13',
      day: 'Saturday',
      state: 'open',
      openNow: true,
      opensAt: '8:00 AM',
    })
    expect(b.week).toHaveLength(7)
    expect(b.next).toMatchObject({ date: '2026-06-14', day: 'Sunday' }) // the test fixture's week has Sunday open
    expect(b.closures).toEqual([])
    const bogus = await pub({ cookie: 'oasis_sid=not-a-session; other=1' })
    expect(bogus.statusCode).toBe(200)
    expect(bogus.headers['set-cookie']).toBeUndefined()
    expect(r.headers['set-cookie']).toBeUndefined()
  })

  it('is cacheable for a minute and says so', async () => {
    const r = await pub()
    expect(r.headers['cache-control']).toBe('public, max-age=60')
    expect(r.headers['content-type']).toMatch(/^application\/json/)
    expect(r.headers['x-api-version']).toBe('1')
  })

  it('carries no personal or operations data, before and after an emergency', async () => {
    const forbidden =
      /message|startedBy|appointments|vehicles|history|^id$|Id$|customer|phone|email|count|notified/i
    const before = keysOf(json(await pub()))
    expect([...before].filter((k) => forbidden.test(k))).toEqual([])
    const s = await h.admin()
    expect((await close(s)).statusCode).toBe(201)
    const after = keysOf(json(await pub()))
    expect([...after].filter((k) => forbidden.test(k))).toEqual([])
  })

  it('flips to closed when the shop closes for the rest of the day, and back when it reopens', async () => {
    const s = await h.admin()
    expect(json(await pub()).today.state).toBe('open')
    expect((await close(s)).statusCode).toBe(201)
    // "rest of today" from 10:36: today becomes a reduced day (8:00 AM to 10:36 AM) that is over, hence closed now
    const closed = json(await pub())
    expect(closed.today).toMatchObject({
      closed: false,
      reduced: true,
      openNow: false,
      state: 'closed',
      opensAt: '8:00 AM',
      closesAt: '10:36 AM',
      reason: 'Weather closure',
      emergency: true,
    })
    expect(closed.closures).toEqual([
      {
        date: '2026-06-13',
        dateLabel: 'Saturday, Jun 13',
        name: 'Weather closure',
        type: 'reduced',
        from: '8:00 AM',
        to: '10:36 AM',
      },
    ])
    expect(closed.next).toMatchObject({ date: '2026-06-14' })
    expect((await h.post('emergency/reopen', s, {})).statusCode).toBe(200)
    expect(json(await pub()).today).toMatchObject({
      closed: false,
      state: 'open',
      emergency: false,
      reason: null,
    })
  })

  it('follows the Settings: a Sunday closed in the weekly hours and a planned closure show up at once', async () => {
    const s = await h.admin()
    const current = json(await h.get('settings/hours', s))
    const days = (current.days as { weekday: number; open: boolean }[]).map((d) => ({
      weekday: d.weekday,
      open: d.weekday !== 0,
    }))
    const saved = await h.put('settings/hours', s, { days, version: current.version })
    expect(saved.statusCode, saved.body).toBe(200)
    const created = await h.post('closures', s, {
      date: '2026-06-19',
      name: 'Juneteenth',
      type: 'closed',
      notify: false,
    })
    expect(created.statusCode, created.body).toBe(201)
    const b = json(await pub())
    expect(b.week[0]).toEqual({
      weekday: 0,
      day: 'Sunday',
      open: false,
      from: null,
      to: null,
      fromMin: null,
      toMin: null,
    })
    expect(b.next).toMatchObject({ date: '2026-06-15', day: 'Monday' })
    expect(b.closures).toEqual([
      { date: '2026-06-19', dateLabel: 'Friday, Jun 19', name: 'Juneteenth', type: 'closed' },
    ])
  })

  it('answers 429 after 60 calls a minute from one address, and other addresses are not affected', async () => {
    const ip = '10.81.0.1'
    for (let i = 0; i < 60; i++) expect((await pub({}, ip)).statusCode, `call ${i + 1}`).toBe(200)
    const limited = await pub({}, ip)
    expect(limited.statusCode).toBe(429)
    expect(json(limited).code).toBe('RATE_LIMITED')
    expect(limited.headers['retry-after']).toBeDefined()
    expect((await pub({}, '10.81.0.2')).statusCode).toBe(200)
  })
})
