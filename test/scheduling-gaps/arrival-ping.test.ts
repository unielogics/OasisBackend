// Gap 2: the customer-side arrival ping. A staff member issues a per-appointment link token (only its hash is stored); the
// customer's phone posts its location to POST /arrivals/ping with that token. The server evaluates the geofence from the arrival
// settings: an ETA (and one crew alert when it first crosses the prep time), then an automatic check-in or a "confirm the
// arrival" alert inside the radius. Idempotent, throttled per appointment, rate limited per address.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { activityOf, opsEvents, outboundTexts, useRig, type Rig } from './support.js'

const SHOP = { lat: 25.7617, lng: -80.1918 }
const M_PER_DEG_LAT = 111_194.9266 // 2 * pi * 6371000 / 360, the haversine sphere
const north = (meters: number): { lat: number; lng: number } => ({
  lat: SHOP.lat + meters / M_PER_DEG_LAT,
  lng: SHOP.lng,
})
const START = '2026-06-13T11:00:00-04:00'

async function setup(
  m: Rig,
  o: { coords?: boolean } = {},
): Promise<{ appointmentId: string; invoiceId: string }> {
  const db = m.h.t.db
  if (o.coords !== false) await db.updateTable('locations').set({ lat: SHOP.lat, lng: SHOP.lng }).execute()
  // everyone with a login is on shift on Saturday, 8:00 AM to 5:00 PM
  await db
    .updateTable('employee_schedules')
    .set({ is_on: true, from_min: 480, to_min: 1020 })
    .where('weekday', '=', 6)
    .execute()
  return m.book('Maria Delgado', 'Express Hand Wash', START)
}

const issue = async (m: Rig, appointmentId: string, s = m.superS()) => {
  const res = await m.send(s, 'POST', `/appointments/${appointmentId}/arrival-link`, {}, false)
  return { res, body: res.json() as { token: string; path: string; url: string; expiresAt: string } }
}

let ipN = 0
const ping = (
  m: Rig,
  body: Record<string, unknown>,
  ip = `10.77.${Math.floor(ipN / 200)}.${(ipN++ % 200) + 1}`,
) => m.h.call('POST', '/api/v1/arrivals/ping', { session: null, body, ip })

const arrivalSettings = (m: Rig, patch: Record<string, unknown>) =>
  m.send(m.superS(), 'PUT', '/arrival-settings', patch, false)

const apptRow = (m: Rig, id: string) =>
  m.h.t.db
    .selectFrom('appointments')
    .select([
      'status',
      'eta_minutes',
      'eta_at',
      'geo_checked_in_at',
      'arrived_at',
      'arrival_token_hash',
      'arrival_token_expires_at',
    ])
    .where('id', '=', id)
    .executeTakeFirstOrThrow()

describe('arrival link tokens', () => {
  const m = useRig()

  it('staff with sched.edit issue a link; only the hash is stored; re-issuing rotates it', async () => {
    const a = await setup(m)
    const clerk = (await m.h.userWithPermissions(['sched.view', 'jobs.status'], 'crewonly@example.test'))
      .session
    expect((await issue(m, a.appointmentId, clerk)).res.statusCode).toBe(403)

    const first = await issue(m, a.appointmentId)
    expect(first.res.statusCode, first.res.body).toBe(201)
    expect(first.body.token).toMatch(/^oa_[A-Za-z0-9_-]{43}$/)
    expect(first.body.path).toBe(`/a/${first.body.token}`)
    expect(first.body.url).toBe(`http://localhost:4000/a/${first.body.token}`)
    const row = await apptRow(m, a.appointmentId)
    expect(row.arrival_token_hash).toBe(createHash('sha256').update(first.body.token).digest('hex'))
    expect(JSON.stringify(row)).not.toContain(first.body.token)
    // valid until two hours after the booked end
    const end = (
      await m.h.t.db
        .selectFrom('appointments')
        .select('scheduled_end')
        .where('id', '=', a.appointmentId)
        .executeTakeFirstOrThrow()
    ).scheduled_end
    expect(row.arrival_token_expires_at!.toISOString()).toBe(
      new Date(end.getTime() + 2 * 3600_000).toISOString(),
    )

    const second = await issue(m, a.appointmentId)
    expect(second.body.token).not.toBe(first.body.token)
    const stale = await ping(m, { token: first.body.token, ...north(2000) })
    expect(stale.statusCode).toBe(401)
    expect(stale.json()).toMatchObject({ code: 'ARRIVAL_LINK_INVALID' })
    expect((await ping(m, { token: second.body.token, ...north(2000) })).statusCode).toBe(200)
  })

  it('no link for a finished job, and a link dies with the appointment', async () => {
    const a = await setup(m)
    const { body } = await issue(m, a.appointmentId)
    await m.send(
      m.superS(),
      'POST',
      `/appointments/${a.appointmentId}/cancel`,
      { reason: 'x' },
      'cancel-key-0001',
    )
    const res = await ping(m, { token: body.token, ...north(2000) })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ code: 'ARRIVAL_LINK_INVALID' })
    expect((await issue(m, a.appointmentId)).res.statusCode).toBe(409)
  })

  it('an expired token answers 410 and an unknown one 401, with no detail that tells them apart from the appointment', async () => {
    const a = await setup(m)
    const { body } = await issue(m, a.appointmentId)
    expect((await ping(m, { token: 'oa_' + 'x'.repeat(43), ...north(2000) })).statusCode).toBe(401)
    m.h.clock.set('2026-06-13T14:00:01-04:00') // end 11:30 + 2h = 13:30
    const res = await ping(m, { token: body.token, ...north(2000) })
    expect(res.statusCode).toBe(410)
    expect(res.json()).toMatchObject({ code: 'ARRIVAL_LINK_EXPIRED' })
    expect(JSON.stringify(res.json())).not.toContain('Maria')
  })
})

describe('the shop location', () => {
  const m = useRig()
  it('is unset until set.hours saves it, then arrival pings are evaluated against it', async () => {
    expect((await m.get(m.limited(), '/settings/location')).json()).toEqual({ lat: null, lng: null })
    const body = { lat: SHOP.lat, lng: SHOP.lng }
    expect((await m.send(m.limited(), 'PUT', '/settings/location', body, false)).statusCode).toBe(403)
    expect(
      (await m.send(m.superS(), 'PUT', '/settings/location', { lat: 91, lng: 0 }, false)).statusCode,
    ).toBe(422)
    const saved = await m.send(m.superS(), 'PUT', '/settings/location', body, false)
    expect(saved.statusCode, saved.body).toBe(200)
    expect((await m.get(m.limited(), '/settings/location')).json()).toEqual(body)
    expect(
      (
        await m.h.t.db
          .selectFrom('audit_log')
          .select('action')
          .where('action', '=', 'settings.location.update')
          .execute()
      ).length,
    ).toBe(1)
  })
})

describe('the geofence ping', () => {
  const m = useRig()

  const go = async (o: { coords?: boolean } = {}) => {
    const a = await setup(m, o)
    const { body } = await issue(m, a.appointmentId)
    return { ...a, token: body.token }
  }
  const seen = async (type: string) => (await opsEvents(m, type)).map((e) => e.payload)

  it('refuses to evaluate until the shop has coordinates', async () => {
    const a = await go({ coords: false })
    const res = await ping(m, { token: a.token, ...north(500) })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'ARRIVAL_NOT_CONFIGURED' })
  })

  it('outside the radius it stores an ETA from the distance (25 km/h) and alerts the crew once, when the ETA first reaches the prep time', async () => {
    const a = await go()
    const far = await ping(m, { token: a.token, ...north(20_000) }) // 48 min
    expect(far.statusCode, far.body).toBe(200)
    expect(far.json()).toMatchObject({ state: 'outside', distanceM: 20_000, radiusM: 300, etaMinutes: 48 })
    expect((await apptRow(m, a.appointmentId)).eta_minutes).toBe(48)
    expect(await seen('arrival.eta')).toEqual([
      expect.objectContaining({ appointmentId: a.appointmentId, etaMinutes: 48, crossed: false }),
    ])
    const bell = () =>
      m.h.t.db
        .selectFrom('notifications')
        .select(['kind', 'title', 'entity_id'])
        .where('kind', '=', 'arrival')
        .execute()
    expect(await bell()).toHaveLength(0)

    m.h.clock.advance(60_000)
    const near = await ping(m, { token: a.token, ...north(5000) }) // 12 min, crosses 15
    expect(near.json()).toMatchObject({ state: 'outside', distanceM: 5000, etaMinutes: 12 })
    expect((await seen('arrival.eta')).at(-1)).toMatchObject({ etaMinutes: 12, crossed: true })
    const rows = await bell()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]).toMatchObject({ title: 'Maria Delgado is 12 min away', entity_id: a.appointmentId })
    const count = rows.length

    m.h.clock.advance(60_000)
    await ping(m, { token: a.token, ...north(3000) }) // 8 min: already past the prep time
    expect(await bell()).toHaveLength(count)
    expect((await apptRow(m, a.appointmentId)).eta_minutes).toBe(8)

    const alerts = (await m.get(m.superS(), '/ops/alerts')).json() as { alerts: { kind: string }[] }
    expect(alerts.alerts.map((x) => x.kind)).toContain('arriving_eta')
  })

  it('a client-supplied ETA wins over the distance estimate, clamped to a sane range', async () => {
    const a = await go()
    expect((await ping(m, { token: a.token, ...north(20_000), etaMinutes: 9 })).json()).toMatchObject({
      etaMinutes: 9,
    })
    m.h.clock.advance(60_000)
    expect((await ping(m, { token: a.token, ...north(20_000), etaMinutes: 5000 })).json()).toMatchObject({
      etaMinutes: 600,
    })
  })

  it('inside the radius with auto check-in on: the job arrives, the welcome text goes out, the crew sees it', async () => {
    const a = await go()
    const res = await ping(m, { token: a.token, ...north(120), accuracyM: 25 })
    expect(res.json()).toMatchObject({ state: 'checked_in', distanceM: 120, radiusM: 300, etaMinutes: null })
    const row = await apptRow(m, a.appointmentId)
    expect(row.status).toBe('arrived')
    expect(row.geo_checked_in_at?.toISOString()).toBe(m.h.clock.now().toISOString())
    expect(row.eta_minutes).toBeNull()
    expect(await activityOf(m, a.appointmentId)).toEqual(expect.arrayContaining(['Auto check-in · geofence']))
    expect((await outboundTexts(m, a.appointmentId)).at(-1)).toContain('Welcome to Oasis')
    expect(await seen('arrival.checked_in')).toEqual([
      expect.objectContaining({ appointmentId: a.appointmentId, auto: true, distanceM: 120 }),
    ])
    const alerts = (await m.get(m.superS(), '/ops/alerts')).json() as { alerts: { kind: string }[] }
    expect(alerts.alerts.map((x) => x.kind)).toContain('auto_checked_in')
  })

  it('with auto check-in off it only flags the geofence check-in for staff to confirm', async () => {
    const a = await go()
    expect((await arrivalSettings(m, { autoArrive: false })).statusCode).toBe(200)
    const res = await ping(m, { token: a.token, ...north(100) })
    expect(res.json()).toMatchObject({ state: 'confirm_needed' })
    const row = await apptRow(m, a.appointmentId)
    expect(row.status).toBe('booked')
    expect(row.geo_checked_in_at).not.toBeNull()
    expect(await outboundTexts(m, a.appointmentId)).toEqual([expect.stringContaining('thanks for booking')])
    const alerts = (await m.get(m.superS(), '/ops/alerts')).json() as { alerts: { kind: string }[] }
    expect(alerts.alerts.map((x) => x.kind)).toContain('confirm_checkin')
    expect(await seen('arrival.checked_in')).toEqual([expect.objectContaining({ auto: false })])
    // staff then confirm with the ordinary arrive command
    const arrive = await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/arrive`, {}, false)
    expect(arrive.statusCode).toBe(200)
    expect((await apptRow(m, a.appointmentId)).status).toBe('arrived')
  })

  it('the radius comes from the arrival settings, and a fix less accurate than the radius proves nothing', async () => {
    const a = await go()
    expect((await arrivalSettings(m, { radius: 150 })).statusCode).toBe(200)
    expect((await ping(m, { token: a.token, ...north(200) })).json()).toMatchObject({
      state: 'outside',
      radiusM: 150,
    })
    m.h.clock.advance(60_000)
    expect((await arrivalSettings(m, { radius: 300 })).statusCode).toBe(200)
    const vague = await ping(m, { token: a.token, ...north(100), accuracyM: 400 })
    expect(vague.json()).toMatchObject({ state: 'inconclusive', distanceM: 100 })
    expect((await apptRow(m, a.appointmentId)).status).toBe('booked')
    m.h.clock.advance(60_000)
    expect((await ping(m, { token: a.token, ...north(200), accuracyM: 30 })).json()).toMatchObject({
      state: 'checked_in',
    })
  })

  it('does nothing when geofence check-in is turned off', async () => {
    const a = await go()
    expect((await arrivalSettings(m, { on: false })).statusCode).toBe(200)
    const res = await ping(m, { token: a.token, ...north(50) })
    expect(res.json()).toMatchObject({ state: 'disabled' })
    const row = await apptRow(m, a.appointmentId)
    expect(row).toMatchObject({ status: 'booked', eta_minutes: null, geo_checked_in_at: null })
  })

  it('is idempotent: a repeated pingId replays, a ping after arrival changes nothing, one welcome text only', async () => {
    const a = await go()
    const body = { token: a.token, ...north(80), pingId: 'ping-00000001' }
    const one = await ping(m, body)
    const replay = await ping(m, body)
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toEqual(one.json())
    m.h.clock.advance(60_000)
    const again = await ping(m, { token: a.token, ...north(60) })
    expect(again.json()).toMatchObject({ state: 'already_arrived' })
    const welcomes = (await outboundTexts(m, a.appointmentId)).filter((t) => t.includes('Welcome to Oasis'))
    expect(welcomes).toHaveLength(1)
    expect(await seen('arrival.checked_in')).toHaveLength(1)
    expect(
      (
        await m.h.t.db
          .selectFrom('arrival_pings')
          .select('id')
          .where('appointment_id', '=', a.appointmentId)
          .execute()
      ).length,
    ).toBe(1)
  })

  it('throttles a chatty phone per appointment (429 with retry-after) and per address', async () => {
    const a = await go()
    expect((await ping(m, { token: a.token, ...north(20_000) }, '10.88.0.1')).statusCode).toBe(200)
    m.h.clock.advance(2000)
    const fast = await ping(m, { token: a.token, ...north(19_000) }, '10.88.0.2')
    expect(fast.statusCode).toBe(429)
    expect(fast.json()).toMatchObject({ code: 'ARRIVAL_PING_TOO_FAST' })
    expect(Number(fast.headers['retry-after'])).toBeGreaterThan(0)
    m.h.clock.advance(4000)
    expect((await ping(m, { token: a.token, ...north(19_000) }, '10.88.0.3')).statusCode).toBe(200)

    let limited = 0
    for (let i = 0; i < 70; i++)
      if (
        (await ping(m, { token: 'oa_' + 'y'.repeat(43), lat: SHOP.lat, lng: SHOP.lng }, '10.88.9.9'))
          .statusCode === 429
      )
        limited++
    expect(limited).toBeGreaterThan(0)
  })

  it('validates the body', async () => {
    const a = await go()
    for (const bad of [
      { token: a.token },
      { token: a.token, lat: 95, lng: 0 },
      { token: a.token, lat: 0, lng: 181 },
      { token: a.token, lat: 25, lng: -80, accuracyM: -1 },
      { token: 'short', lat: 25, lng: -80 },
      { lat: 25, lng: -80 },
    ])
      expect((await ping(m, bad)).statusCode, JSON.stringify(bad)).toBe(422)
  })
})

describe('simulate arrival (dev only), endpoints off', () => {
  const off = useRig()
  it('is not mounted unless ALLOW_DEV_ENDPOINTS is on', async () => {
    const a = await setup(off)
    const res = await off.send(
      off.superS(),
      'POST',
      `/dev/appointments/${a.appointmentId}/simulate-arrival`,
      {},
      false,
    )
    expect(res.statusCode).toBe(404)
  })
})

describe('simulate arrival (dev only), endpoints on', () => {
  const on = useRig({ ALLOW_DEV_ENDPOINTS: 'true' })
  it('with it on, "arrive" checks the job in as the geofence would and "eta" sets an ETA', async () => {
    const a = await setup(on)
    const sim = (body: Record<string, unknown>) =>
      on.send(on.superS(), 'POST', `/dev/appointments/${a.appointmentId}/simulate-arrival`, body, false)
    const eta = await sim({ mode: 'eta', etaMinutes: 12 })
    expect(eta.statusCode, eta.body).toBe(200)
    expect(eta.json()).toMatchObject({ state: 'outside', etaMinutes: 12 })
    expect((await apptRow(on, a.appointmentId)).eta_minutes).toBe(12)
    const arrive = await sim({})
    expect(arrive.json()).toMatchObject({ state: 'checked_in' })
    expect((await apptRow(on, a.appointmentId)).status).toBe('arrived')
    const nobody = (await on.h.userWithPermissions(['sched.view'], 'view@example.test')).session
    expect(
      (await on.send(nobody, 'POST', `/dev/appointments/${a.appointmentId}/simulate-arrival`, {}, false))
        .statusCode,
    ).toBe(403)
  })
})
