// Kiosk mode end to end over HTTP (ADR 0180 and its 2026-10-14 amendment): on by default; employees' PINs (rules, unique in the shop,
// the last 3, generated once, removed, deactivation); the shop's networks (Super Admin only, this connection's address confirmed, IPv4
// exact and IPv6 /64, approving a refused address, the refused list's cap); every unlock outcome (outside the shop, wrong PIN, throttle
// and lockout per address and per browser, a browser's first unlock giving it its device cookie, "Opened by"); the kiosk context and
// its fail-closed route list, the acting employee, expiry, what ends a kiosk session, the user session winning, short admin sessions
// on a shop browser, and the cookies.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { hashToken } from '../../src/modules/auth/tokens.js'
import { kioskKey, pinLookup } from '../../src/modules/kiosk/pin.js'
import { createKioskSession } from '../../src/modules/kiosk/sessions.js'
import { ensureLocation } from '../../src/platform/locations.js'
import {
  useHarness,
  KIOSK_PIN,
  TEST_PASSWORD,
  type Harness,
  type KioskDevice,
  type KioskSession,
  type Session,
} from '../auth/harness.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>

const NIL = '00000000-0000-7000-8000-000000000000'
/** 2026-06-13 is a Saturday: the default hours close at 5:00 PM, so an unlock at 10:36 AM locks at 7:00 PM. */
const LOCKS_AT = '2026-06-13T23:00:00.000Z'
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const SHOP = '203.0.113.9'

async function tryUnlock(h: Harness, cookie: string | null, pin = KIOSK_PIN, ip = SHOP, headers: Record<string, string> = {}) {
  return h.t.app.inject({
    method: 'POST',
    url: '/api/v1/kiosk/unlock',
    headers: { origin: h.origin, ...(cookie ? { cookie } : {}), ...headers },
    remoteAddress: ip,
    payload: { pin },
  })
}

const status = (h: Harness, ip: string, cookie?: string) =>
  h.t.app.inject({ method: 'GET', url: '/api/v1/kiosk/status', remoteAddress: ip, headers: cookie ? { cookie } : {} })

/** An employee row of the harness location without a login (status invited/inactive, listed or not). */
async function employee(
  h: Harness,
  o: { first: string; last: string; status?: 'active' | 'invited' | 'inactive'; listed?: boolean; locationId?: string },
): Promise<string> {
  const id = randomUUID()
  await h.t.db
    .insertInto('employees')
    .values({
      id,
      first: o.first,
      last: o.last,
      status: o.status ?? 'invited',
      deactivated_at: o.status === 'inactive' ? new Date('2026-06-01T12:00:00Z') : null,
      kiosk_listed: o.listed ?? true,
    })
    .execute()
  await h.t.db
    .insertInto('employee_locations')
    .values({ employee_id: id, location_id: o.locationId ?? h.t.location.id })
    .execute()
  return id
}

/** A Super Admin signed in at `ip`. */
async function superAt(h: Harness, ip = SHOP, email = `boss-${randomUUID()}@example.test`) {
  const u = await h.createUser({ email, roles: ['super'], first: 'Rafael', last: 'Mendes' })
  return { user: u, s: await h.login(u, ip) }
}

const overview = async (h: Harness, s: Pick<Session, 'cookie' | 'csrf'>, ip = '10.0.0.2') =>
  (await h.call('GET', 'kiosk', { session: s, ip })).json() as Json

describe('kiosk mode is on by default (ADR 0180 amendment)', () => {
  const h = useHarness()

  it('the keypad shows; without a shop network PINs are never checked and the try is listed', async () => {
    const st = await status(h, SHOP)
    expect(st.statusCode).toBe(200)
    expect(st.json()).toEqual({ enabled: true, networkSet: false, atShop: false, unlocked: null, lockedOut: false, retryAfterSec: 0 })
    const { user, s } = await superAt(h)
    await h.setPin(s, user.employeeId, KIOSK_PIN)
    const r = await tryUnlock(h, null)
    expect(r.statusCode).toBe(403)
    expect(r.json()).toMatchObject({ code: 'KIOSK_NOT_AT_SHOP', detail: 'PINs work only at the shop, on the shop’s Wi-Fi.', meta: { networkSet: false } })
    expect(r.cookies.find((c) => c.name === 'oasis_kdev')).toBeUndefined()
    expect(await h.t.db.selectFrom('kiosk_sessions').selectAll().execute()).toHaveLength(0)
    const ov = await overview(h, s)
    expect(ov.refused).toEqual([
      { id: expect.any(String), address: SHOP, firstSeenAt: expect.any(String), lastSeenAt: expect.any(String), attempts: 1, fromKnownBrowser: false, browserName: null },
    ])
  })

  it('kiosk mode off answers KIOSK_OFF before anything else', async () => {
    const { user, s } = await superAt(h)
    await h.addShopNetwork(s, SHOP)
    await h.setPin(s, user.employeeId, KIOSK_PIN)
    await h.setKioskMode(s, false)
    expect((await status(h, SHOP)).json()).toMatchObject({ enabled: false, networkSet: true, atShop: true })
    expect((await tryUnlock(h, null)).json().code).toBe('KIOSK_OFF')
    expect((await tryUnlock(h, null, KIOSK_PIN, '198.51.100.1')).json().code).toBe('KIOSK_OFF')
    await h.setKioskMode(s, true)
    expect((await tryUnlock(h, null)).statusCode).toBe(200)
  })

  it('the migration turns the boot-time default row on and never a value somebody set', async () => {
    const file = readFileSync(path.resolve(import.meta.dirname, '../../db/migrations/20261017100000_kiosk_pins.sql'), 'utf8')
    const stmt = file.slice(file.indexOf('update settings set value'))
    const other = await ensureLocation(h.t.db, () => randomUUID(), { slug: 'second', name: 'Second' })
    const third = await ensureLocation(h.t.db, () => randomUUID(), { slug: 'third', name: 'Third' })
    const set = (loc: string, v: { value: string; version?: number }) =>
      h.t.db.updateTable('settings').set(v).where('location_id', '=', loc).where('key', '=', 'kiosk.enabled').execute()
    await set(h.t.location.id, { value: JSON.stringify(false) }) // as the server wrote it at boot with the old default
    await set(other.id, { value: JSON.stringify(false), version: 2 }) // somebody turned it off
    await set(third.id, { value: JSON.stringify(false) })
    await h.t.db
      .insertInto('audit_log')
      .values({ location_id: third.id, action: 'settings.update', entity_type: 'setting', entity_id: 'kiosk.enabled' })
      .execute() // somebody set it (first write: version 1)
    await sql.raw(stmt).execute(h.t.db)
    const rows = await h.t.db.selectFrom('settings').select(['location_id', 'value']).where('key', '=', 'kiosk.enabled').execute()
    const of = (loc: string) => rows.find((r) => r.location_id === loc)!.value
    expect([of(h.t.location.id), of(other.id), of(third.id)]).toEqual([true, false, false])
  })
})

describe('the shop’s networks (Super Admin only)', () => {
  const h = useHarness()

  it('"This is the shop’s network" adds the caller’s own address, confirmed; GET /kiosk shows it', async () => {
    const { s } = await superAt(h)
    const before = await overview(h, s, SHOP)
    expect(before).toMatchObject({ yourAddress: SHOP, yourAddressIsShop: false, canManageNetworks: true, networks: [] })
    const add = await h.call('POST', 'kiosk/networks', { session: s, ip: SHOP, body: { confirmAddress: SHOP, label: 'Shop Wi-Fi' } })
    expect(add.statusCode).toBe(201)
    expect(add.json()).toEqual({
      created: true,
      network: {
        id: expect.any(String),
        address: SHOP,
        label: 'Shop Wi-Fi',
        addedBy: 'Rafael M.',
        addedAt: '2026-06-13T14:36:00.000Z',
        lastSeenAt: null,
        failedAttempts: 0,
        lockedOut: false,
      },
    })
    const again = await h.call('POST', 'kiosk/networks', { session: s, ip: SHOP, body: { confirmAddress: SHOP } })
    expect(again.statusCode).toBe(200)
    expect(again.json()).toMatchObject({ created: false, network: { id: add.json().network.id } })
    const after = await overview(h, s, SHOP)
    expect(after).toMatchObject({ yourAddress: SHOP, yourAddressIsShop: true })
    expect(after.networks).toHaveLength(1)
    expect((await status(h, SHOP)).json()).toMatchObject({ networkSet: true, atShop: true })
    expect((await status(h, '198.51.100.1')).json()).toMatchObject({ networkSet: true, atShop: false })
    const a = await h.t.db.selectFrom('audit_log').selectAll().where('action', '=', 'kiosk.network.add').execute()
    expect(a).toHaveLength(1)
    expect(a[0]!.after).toEqual({ address: SHOP, label: 'Shop Wi-Fi', source: 'this_connection' })
  })

  it('a phone whose address changed since the screen showed it cannot add the wrong one (409 KIOSK_ADDRESS_CHANGED)', async () => {
    const { s } = await superAt(h)
    const r = await h.call('POST', 'kiosk/networks', { session: s, ip: '198.51.100.77', body: { confirmAddress: SHOP } })
    expect(r.statusCode).toBe(409)
    expect(r.json()).toMatchObject({ code: 'KIOSK_ADDRESS_CHANGED', meta: { yourAddress: '198.51.100.77' } })
    for (const bad of ['', 'nope', '203.0.113.0/24'])
      expect((await h.call('POST', 'kiosk/networks', { session: s, ip: SHOP, body: { confirmAddress: bad } })).statusCode).toBe(409)
    expect(await h.t.db.selectFrom('kiosk_networks').selectAll().execute()).toHaveLength(0)
    // neither or both fields
    expect((await h.call('POST', 'kiosk/networks', { session: s, ip: SHOP, body: {} })).statusCode).toBe(422)
    expect((await h.call('POST', 'kiosk/networks', { session: s, ip: SHOP, body: { confirmAddress: SHOP, address: SHOP } })).statusCode).toBe(422)
  })

  it('a manager sees the networks and the refused list but cannot add, remove or approve (403 SUPER_ONLY); PINs are theirs', async () => {
    const { s: boss } = await superAt(h)
    const netId = await h.addShopNetwork(boss, SHOP)
    await tryUnlock(h, null, KIOSK_PIN, '198.51.100.20') // refused: listed
    const mgr = await h.createUser({ email: 'mgr@example.test', roles: ['mgmt'], first: 'Mia', last: 'Grant' })
    const m = await h.login(mgr, SHOP)
    const ov = await overview(h, m, SHOP)
    expect(ov).toMatchObject({ canManageNetworks: false, yourAddressIsShop: true })
    expect(ov.networks).toHaveLength(1)
    expect(ov.refused.map((r: Json) => r.address)).toEqual(['198.51.100.20'])
    for (const [method, url, body] of [
      ['POST', 'kiosk/networks', { confirmAddress: SHOP }],
      ['POST', 'kiosk/networks', { address: '198.51.100.20' }],
      ['DELETE', `kiosk/networks/${netId}`, undefined],
    ] as const) {
      const r = await h.call(method, url, { session: m, ip: SHOP, body })
      expect(r.statusCode, `${method} ${url}`).toBe(403)
      expect(r.json().code).toBe('SUPER_ONLY')
    }
    expect(await h.t.db.selectFrom('kiosk_networks').selectAll().execute()).toHaveLength(1)
    // what managers keep: PINs, browsers, lockouts
    expect((await h.call('PUT', `kiosk/staff/${mgr.employeeId}/pin`, { session: m, body: { pin: KIOSK_PIN } })).statusCode).toBe(200)
    expect((await h.call('POST', `kiosk/networks/${netId}/clear-lockout`, { session: m })).statusCode).toBe(200)
    // a Super Admin viewing as Management acts as Management: refused too (view-as never widens)
    const mgmtRole = await h.t.db.selectFrom('roles').select('id').where('key', '=', 'mgmt').executeTakeFirstOrThrow()
    expect((await h.call('POST', 'me/view-as', { session: boss, body: { roleId: mgmtRole.id } })).statusCode).toBe(200)
    const viewing = await h.call('POST', 'kiosk/networks', { session: boss, ip: '198.51.100.30', body: { confirmAddress: '198.51.100.30' } })
    expect(viewing.statusCode).toBe(403)
    expect(viewing.json().code).toBe('SUPER_ONLY')
    expect((await overview(h, boss)).canManageNetworks).toBe(false)
    // and a manager cannot view as anyone to get there
    expect((await h.call('POST', 'me/view-as', { session: m, body: { roleId: mgmtRole.id } })).statusCode).toBe(403)
    expect((await h.call('POST', 'me/view-as', { session: boss, body: { roleId: null } })).statusCode).toBe(200)
    expect((await h.call('DELETE', `kiosk/networks/${netId}`, { session: boss })).statusCode).toBe(204)
    expect((await h.call('DELETE', `kiosk/networks/${netId}`, { session: boss })).statusCode).toBe(404)
    expect((await h.call('DELETE', `kiosk/networks/nope`, { session: boss })).statusCode).toBe(404)
  })

  it('IPv4 is matched exactly, IPv6 by its /64, an IPv4-mapped address as IPv4', async () => {
    const { user, s } = await superAt(h, '2001:db8:1:2::10')
    await h.addShopNetwork(s, '2001:db8:1:2::10')
    expect((await overview(h, s, '2001:db8:1:2::10')).networks[0].address).toBe('2001:db8:1:2::/64')
    await h.setPin(s, user.employeeId, KIOSK_PIN)
    expect((await tryUnlock(h, null, KIOSK_PIN, '2001:db8:1:2:abcd::99')).statusCode).toBe(200) // another device of the line
    expect((await tryUnlock(h, null, KIOSK_PIN, '2001:db8:1:3::10')).json().code).toBe('KIOSK_NOT_AT_SHOP')

    const s4 = await h.login(user, SHOP)
    await h.addShopNetwork(s4, SHOP)
    expect((await tryUnlock(h, null, KIOSK_PIN, `::ffff:${SHOP}`)).statusCode).toBe(200)
    expect((await tryUnlock(h, null, KIOSK_PIN, '203.0.113.10')).json().code).toBe('KIOSK_NOT_AT_SHOP') // the neighbour address
    const ov = await overview(h, s4, `::ffff:${SHOP}`)
    expect(ov).toMatchObject({ yourAddress: SHOP, yourAddressIsShop: true })
    expect(ov.networks.map((n: Json) => n.address).sort()).toEqual(['2001:db8:1:2::/64', SHOP])
    expect(ov.networks.find((n: Json) => n.address === SHOP).lastSeenAt).toBe('2026-06-13T14:36:00.000Z')
  })

  it('the provider changed the address: the tablet’s refused PIN is listed with its name and a Super Admin approves it from anywhere', async () => {
    const { admin, device, pin } = await h.kioskSetup()
    expect(
      (await h.call('PATCH', `kiosk/devices/${device.id}`, { session: admin, body: { name: 'Front desk tablet', version: 1 } })).statusCode,
    ).toBe(200)
    await h.call('POST', 'kiosk/lock-all', { session: admin })
    const NEW = '198.51.100.44'
    const refused = await tryUnlock(h, device.cookie, pin, NEW)
    expect(refused.statusCode).toBe(403)
    expect(refused.json()).toMatchObject({ code: 'KIOSK_NOT_AT_SHOP', meta: { networkSet: true } })
    await tryUnlock(h, null, pin, '198.51.100.45') // somebody else's browser, elsewhere
    const ov = await overview(h, admin)
    expect(ov.refused).toEqual([
      expect.objectContaining({ address: '198.51.100.45', fromKnownBrowser: false, browserName: null, attempts: 1 }),
      expect.objectContaining({ address: NEW, fromKnownBrowser: true, browserName: 'Front desk tablet', attempts: 1 }),
    ])
    // never anything the refused list does not hold
    const other = await h.call('POST', 'kiosk/networks', { session: admin, ip: '10.9.9.9', body: { address: '198.51.100.99' } })
    expect(other.statusCode).toBe(404)
    expect(other.json().code).toBe('KIOSK_REFUSED_UNKNOWN')
    expect((await h.call('POST', 'kiosk/networks', { session: admin, ip: '10.9.9.9', body: { address: 'junk' } })).statusCode).toBe(404)
    const ok = await h.call('POST', 'kiosk/networks', { session: admin, ip: '10.9.9.9', body: { address: NEW, label: 'New router' } })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().network).toMatchObject({ address: NEW, label: 'New router' })
    expect((await overview(h, admin)).refused.map((r: Json) => r.address)).toEqual(['198.51.100.45'])
    const a = await h.t.db.selectFrom('audit_log').select('after').where('action', '=', 'kiosk.network.add').orderBy('id', 'desc').executeTakeFirstOrThrow()
    expect(a.after).toEqual({ address: NEW, label: 'New router', source: 'refused' })
    expect((await tryUnlock(h, device.cookie, pin, NEW)).statusCode).toBe(200)
  })

  it('refused tries: one row per address written at most once a minute, 30 days and 50 rows kept, the shop tablet’s row last to go', async () => {
    const { admin, device, pin } = await h.kioskSetup()
    const KNOWN = '198.51.100.200'
    for (let i = 0; i < 3; i++) await tryUnlock(h, device.cookie, pin, KNOWN)
    const row = () => h.t.db.selectFrom('kiosk_refused_networks').selectAll().where(sql<boolean>`cidr = ${KNOWN}::cidr`).executeTakeFirstOrThrow()
    expect((await row()).attempts).toBe(1)
    h.clock.advance(60_000)
    await tryUnlock(h, device.cookie, pin, KNOWN)
    expect((await row()).attempts).toBe(4)
    expect((await row()).known_device_id).toBe(device.id)
    // a flood of other addresses (unknown browsers): the table stops at 50 rows and the tablet's row stays
    for (let i = 1; i <= 55; i++) {
      h.clock.advance(1000) // each its own instant: the oldest are known
      await tryUnlock(h, null, pin, `192.0.2.${i}`)
    }
    const rows = await h.t.db.selectFrom('kiosk_refused_networks').select(['cidr', 'known_device_id']).execute()
    expect(rows).toHaveLength(50)
    expect(rows.some((r) => r.known_device_id === device.id)).toBe(true)
    expect(rows.some((r) => r.cidr === '192.0.2.1/32')).toBe(false) // the oldest unknown ones went
    expect(rows.some((r) => r.cidr === '192.0.2.55/32')).toBe(true)
    // 30 days: an old row goes with the next write, and the list never shows one
    await h.t.db.updateTable('kiosk_refused_networks').set({ last_seen_at: new Date('2026-05-01T00:00:00Z') }).where('cidr', '=', '192.0.2.55/32').execute()
    expect((await overview(h, admin)).refused.some((r: Json) => r.address === '192.0.2.55')).toBe(false)
    await tryUnlock(h, null, pin, '192.0.2.100')
    expect(await h.t.db.selectFrom('kiosk_refused_networks').select('id').where('cidr', '=', '192.0.2.55/32').execute()).toHaveLength(0)
    // a refused try is never an audit row (a flood cannot grow the audit log) and never touches a counter
    expect(await h.t.db.selectFrom('audit_log').select('id').where('action', 'like', 'kiosk.unlock%').where('action', '<>', 'kiosk.unlock').execute()).toHaveLength(0)
    expect((await h.t.db.selectFrom('kiosk_devices').select('failed_attempts').where('id', '=', device.id).executeTakeFirstOrThrow()).failed_attempts).toBe(0)
  })
})

describe('the proxy chain (TRUST_PROXY=true: nginx overwrites X-Forwarded-For)', () => {
  const h = useHarness({ env: { TRUST_PROXY: 'true' } })

  it('the address is the one hop nginx names; a client-typed entry to its left is never believed', async () => {
    const { user, s } = await superAt(h, '127.0.0.1')
    const add = await h.call('POST', 'kiosk/networks', {
      session: s,
      ip: '127.0.0.1',
      headers: { 'x-forwarded-for': SHOP },
      body: { confirmAddress: SHOP },
    })
    expect(add.statusCode).toBe(201)
    await h.setPin(s, user.employeeId, KIOSK_PIN)
    const via = (xff: string) => tryUnlock(h, null, KIOSK_PIN, '127.0.0.1', { 'x-forwarded-for': xff })
    expect((await via(SHOP)).statusCode).toBe(200)
    expect((await via(`198.51.100.1, ${SHOP}`)).statusCode).toBe(200) // only the right-most (the trusted hop's) counts
    expect((await via(`${SHOP}, 198.51.100.1`)).json().code).toBe('KIOSK_NOT_AT_SHOP') // a typed shop address is not believed
    expect((await via('198.51.100.1')).json().code).toBe('KIOSK_NOT_AT_SHOP')
  })
})

describe('without TRUST_PROXY a forwarding header is ignored', () => {
  const h = useHarness()

  it('a client cannot claim the shop’s address', async () => {
    const { user, s } = await superAt(h)
    await h.addShopNetwork(s, SHOP)
    await h.setPin(s, user.employeeId, KIOSK_PIN)
    for (const name of ['x-forwarded-for', 'x-real-ip'])
      expect((await tryUnlock(h, null, KIOSK_PIN, '198.51.100.1', { [name]: SHOP })).json().code, name).toBe('KIOSK_NOT_AT_SHOP')
  })
})

describe('employees’ PINs', () => {
  const h = useHarness()

  it('refuses PINs that break a rule with the rule as the message, and never stores or logs the PIN', async () => {
    const { user, s } = await superAt(h)
    for (const [pin, msg] of [
      ['02185739', /0218/],
      ['12345678', /in a row/],
      ['1234567', /8 digits/],
      ['20261013', /date/],
    ] as const) {
      const r = await h.call('PUT', `kiosk/staff/${user.employeeId}/pin`, { session: s, body: { pin } })
      expect(r.statusCode, pin).toBe(422)
      expect(r.json().code).toBe('KIOSK_PIN_REJECTED')
      expect(r.json().errors[0]).toMatchObject({ path: 'body.pin' })
      expect(r.json().errors[0].message).toMatch(msg)
    }
    const ok = await h.call('PUT', `kiosk/staff/${user.employeeId}/pin`, { session: s, body: { pin: KIOSK_PIN } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ employeeId: user.employeeId, setAt: '2026-06-13T14:36:00.000Z' })
    expect(ok.headers['cache-control']).toBe('no-store')
    const rows = await h.t.db.selectFrom('employee_kiosk_pins').selectAll().execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ employee_id: user.employeeId, set_by: user.userId, set_by_name: 'Rafael M.' })
    expect(rows[0]!.pin_lookup).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(rows)).not.toContain(KIOSK_PIN)
    const audits = await h.t.db.selectFrom('audit_log').selectAll().where('action', 'like', 'kiosk.pin%').execute()
    expect(audits.map((a) => a.action)).toEqual(['kiosk.pin.set'])
    expect(JSON.stringify(audits)).not.toContain(KIOSK_PIN)
    // GET /kiosk lists who has a PIN, never the PIN
    const ov = await overview(h, s)
    expect(ov.staff.find((x: Json) => x.id === user.employeeId)).toEqual({
      id: user.employeeId,
      name: 'Rafael M.',
      status: 'active',
      listed: true,
      pin: { setAt: '2026-06-13T14:36:00.000Z', setBy: 'Rafael M.' },
    })
    expect(JSON.stringify(ov)).not.toContain(KIOSK_PIN)
  })

  it('unique in the shop with a neutral answer; not one of the employee’s last 3; generated once', async () => {
    const { user, s } = await superAt(h)
    const ana = await employee(h, { first: 'Ana', last: 'Lima' })
    await h.setPin(s, user.employeeId, KIOSK_PIN)
    const taken = await h.call('PUT', `kiosk/staff/${ana}/pin`, { session: s, body: { pin: KIOSK_PIN } })
    expect(taken.statusCode).toBe(422)
    expect(taken.json().errors[0].message).toBe('Choose another PIN.')
    expect(taken.body).not.toMatch(/Rafael|used/)

    const pins = ['47391028', '63918274', '70264819', '81726354']
    for (const p of pins) await h.setPin(s, ana, p)
    // the last 3: 81726354 (now), 70264819, 63918274; 47391028 is the 4th newest
    for (const p of ['81726354', '70264819', '63918274']) {
      const r = await h.call('PUT', `kiosk/staff/${ana}/pin`, { session: s, body: { pin: p } })
      expect(r.statusCode, p).toBe(422)
      expect(r.json().errors[0].message).toMatch(/used recently/)
    }
    expect((await h.call('PUT', `kiosk/staff/${ana}/pin`, { session: s, body: { pin: '47391028' } })).statusCode).toBe(200)
    // somebody else's old PIN is free to use
    expect((await h.call('PUT', `kiosk/staff/${user.employeeId}/pin`, { session: s, body: { pin: '81726354' } })).statusCode).toBe(200)

    const gen = await h.call('PUT', `kiosk/staff/${ana}/pin`, { session: s, body: { generate: true } })
    expect(gen.statusCode).toBe(200)
    expect(gen.json().pin).toMatch(/^\d{8}$/)
    expect(gen.json().pin.startsWith('0218')).toBe(false)
    expect((await h.call('PUT', `kiosk/staff/${ana}/pin`, { session: s, body: { generate: true, pin: '58203917' } })).statusCode).toBe(422)
    expect((await h.call('PUT', `kiosk/staff/${ana}/pin`, { session: s, body: {} })).statusCode).toBe(422)
    expect(await h.t.db.selectFrom('employee_kiosk_pins').selectAll().execute()).toHaveLength(2)
    const history = await h.t.db.selectFrom('employee_kiosk_pin_history').select('id').where('employee_id', '=', ana).execute()
    expect(history.length).toBeLessThanOrEqual(5)
  })

  it('two managers giving two people the same PIN at once: one is accepted', async () => {
    const { s } = await superAt(h)
    const a = await employee(h, { first: 'Ana', last: 'Lima' })
    const b = await employee(h, { first: 'Ben', last: 'Cole' })
    const res = await Promise.all([a, b].map((id) => h.call('PUT', `kiosk/staff/${id}/pin`, { session: s, body: { pin: '59308847' } })))
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 422])
    expect(await h.t.db.selectFrom('employee_kiosk_pins').selectAll().execute()).toHaveLength(1)
  })

  it('removed, or the employee deactivated: the PIN stops working; deactivated people get none', async () => {
    const { admin, adminUser, pin, shopIp } = await h.kioskSetup()
    const marco = await h.createUser({ email: 'marco@example.test', first: 'Marco', last: 'Rossi', roles: ['crew'] })
    const mp = await h.setPin(admin, marco.employeeId)
    expect((await tryUnlock(h, null, mp, shopIp)).statusCode).toBe(200)
    expect((await h.call('DELETE', `kiosk/staff/${marco.employeeId}/pin`, { session: admin })).statusCode).toBe(204)
    expect((await h.call('DELETE', `kiosk/staff/${marco.employeeId}/pin`, { session: admin })).statusCode).toBe(204) // nothing to do
    expect((await tryUnlock(h, null, mp, shopIp)).json().code).toBe('KIOSK_PIN_WRONG')
    expect((await overview(h, admin)).staff.find((x: Json) => x.id === marco.employeeId).pin).toBeNull()
    // the removed PIN is in their last 3
    expect((await h.call('PUT', `kiosk/staff/${marco.employeeId}/pin`, { session: admin, body: { pin: mp } })).json().errors[0].message).toMatch(
      /used recently/,
    )

    const mp2 = await h.setPin(admin, marco.employeeId)
    expect((await h.call('POST', `employees/${marco.employeeId}/deactivate`, { session: admin })).statusCode).toBe(200)
    expect(await h.t.db.selectFrom('employee_kiosk_pins').select('employee_id').where('employee_id', '=', marco.employeeId).execute()).toHaveLength(0)
    expect((await tryUnlock(h, null, mp2, shopIp)).json().code).toBe('KIOSK_PIN_WRONG')
    const inactive = await h.call('PUT', `kiosk/staff/${marco.employeeId}/pin`, { session: admin, body: { generate: true } })
    expect(inactive.statusCode).toBe(409)
    expect(inactive.json().code).toBe('KIOSK_PIN_INACTIVE')
    const elsewhere = await employee(h, {
      first: 'Otto',
      last: 'Elsewhere',
      locationId: (await ensureLocation(h.t.db, () => randomUUID(), { slug: 'second', name: 'Second' })).id,
    })
    expect((await h.call('PUT', `kiosk/staff/${elsewhere}/pin`, { session: admin, body: { generate: true } })).statusCode).toBe(404)
    expect((await h.call('PUT', `kiosk/staff/${NIL}/pin`, { session: admin, body: { generate: true } })).statusCode).toBe(404)
    expect((await h.call('PUT', `kiosk/staff/nope/pin`, { session: admin, body: { generate: true } })).statusCode).toBe(404)
    const actions = (await h.t.db.selectFrom('audit_log').select('action').where('action', 'like', 'kiosk.pin%').orderBy('id').execute()).map(
      (a) => a.action,
    )
    expect(actions).toEqual(['kiosk.pin.set', 'kiosk.pin.set', 'kiosk.pin.remove', 'kiosk.pin.set'])
    // the Super Admin's own PIN still works
    expect((await tryUnlock(h, null, pin, shopIp)).statusCode).toBe(200)
    expect(adminUser).toBeTruthy()
  })
})

describe('unlocking', () => {
  const h = useHarness()

  it('a browser’s first unlock at the shop: the kiosk opens until closing + 2 hours, "Opened by", a device cookie and a listed browser', async () => {
    const { admin, adminUser, pin, shopIp } = await h.kioskSetup()
    await h.call('POST', 'kiosk/lock-all', { session: admin })
    const marco = await h.createUser({ email: 'marco@example.test', first: 'Marco', last: 'Rossi', roles: ['crew'] })
    const mp = await h.setPin(admin, marco.employeeId)
    const res = await tryUnlock(h, null, mp, shopIp, { 'user-agent': IPAD })
    expect(res.statusCode).toBe(200)
    const me = res.json() as Json
    expect(me).toMatchObject({
      kind: 'kiosk',
      device: { name: 'Shop browser 2 · Safari on iPad' },
      openedBy: { id: marco.employeeId, name: 'Marco R.' },
      lock: { locksAt: LOCKS_AT, locksAtLabel: '7:00 PM', rule: 'closing', unlockedAt: '2026-06-13T14:36:00.000Z' },
      limits: {},
      businessTz: 'America/New_York',
    })
    expect(Object.entries(me.permissions as Record<string, { on: boolean }>).filter(([, v]) => v.on).map(([k]) => k).sort()).toEqual(
      ['cli.contact', 'cli.view', 'jobs.checklist', 'jobs.status', 'msg.send', 'pay.collect', 'sched.edit', 'sched.view'],
    )
    const ksid = res.cookies.find((c) => c.name === 'oasis_ksid')!
    expect(ksid.httpOnly).toBe(true)
    expect(ksid.sameSite).toBe('Lax')
    expect(ksid.maxAge).toBe((Date.parse(LOCKS_AT) - Date.parse('2026-06-13T14:36:00Z')) / 1000)
    const kdev = res.cookies.find((c) => c.name === 'oasis_kdev')!
    expect(kdev.httpOnly).toBe(true)
    expect(kdev.maxAge).toBe(400 * 24 * 60 * 60)
    const dev = await h.t.db.selectFrom('kiosk_devices').selectAll().where('id', '=', me.device.id).executeTakeFirstOrThrow()
    expect(dev).toMatchObject({ token_hash: hashToken(kdev.value), created_by: null, created_by_name: 'Marco R.', last_ip: shopIp, last_ua: IPAD })
    expect(JSON.stringify(dev)).not.toContain(kdev.value)
    const row = await h.t.db.selectFrom('kiosk_sessions').selectAll().where('id', '=', hashToken(ksid.value)).executeTakeFirstOrThrow()
    expect(row).toMatchObject({ device_id: dev.id, lock_rule: 'closing', opened_by_employee_id: marco.employeeId, opened_by_name: 'Marco R.' })
    const a = await h.t.db.selectFrom('audit_log').selectAll().where('action', '=', 'kiosk.unlock').orderBy('id', 'desc').executeTakeFirstOrThrow()
    expect(a).toMatchObject({ kiosk_device_id: dev.id, actor_user_id: null, actor_employee_id: marco.employeeId, actor_name: 'Marco R.', actor_roles: 'Kiosk' })
    expect(a.after).toMatchObject({ openedBy: { employeeId: marco.employeeId, name: 'Marco R.' }, network: shopIp })
    expect(JSON.stringify(a)).not.toContain(mp)
    const reg = await h.t.db.selectFrom('audit_log').selectAll().where('action', '=', 'kiosk.device.register').orderBy('id', 'desc').executeTakeFirstOrThrow()
    expect(reg).toMatchObject({ entity_id: dev.id, actor_employee_id: marco.employeeId })
    expect(reg.after).toEqual({ name: 'Shop browser 2 · Safari on iPad', auto: true })
    const ev = await h.t.db.selectFrom('staff_events').selectAll().where('kind', '=', 'kiosk_unlock').where('employee_id', '=', marco.employeeId).execute()
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ employee_name: 'Marco R.', via: 'kiosk', kiosk_device_id: dev.id, user_id: null, audit_id: Number(a.id) })

    const kiosk = { cookie: `oasis_kdev=${kdev.value}; oasis_ksid=${ksid.value}`, csrf: me.csrfToken as string }
    expect((await h.kioskCall('GET', 'kiosk/me', kiosk)).json().openedBy).toEqual({ id: marco.employeeId, name: 'Marco R.' })
    expect((await status(h, shopIp, kiosk.cookie)).json()).toEqual({
      enabled: true,
      networkSet: true,
      atShop: true,
      unlocked: { locksAt: LOCKS_AT, locksAtLabel: '7:00 PM' },
      lockedOut: false,
      retryAfterSec: 0,
    })
    const ov = await overview(h, admin)
    expect(ov.devices.find((d: Json) => d.id === dev.id)).toMatchObject({ state: 'unlocked', openedBy: 'Marco R.', locksAt: LOCKS_AT })
    expect(ov.recent.find((r: Json) => r.action === 'kiosk.unlock')).toMatchObject({ label: 'Unlocked', by: 'Marco R.' })

    // the same browser again: no new browser, the same cookie; another browser at the shop is a third one
    const again = await tryUnlock(h, `oasis_kdev=${kdev.value}`, pin, shopIp)
    expect(again.json().device.id).toBe(dev.id)
    expect(again.json().openedBy).toEqual({ id: adminUser.employeeId, name: 'Rafael M.' })
    expect(again.cookies.find((c) => c.name === 'oasis_kdev')!.value).toBe(kdev.value)
    const third = await tryUnlock(h, null, pin, shopIp)
    expect(third.json().device.name).toBe('Shop browser 3')
    expect(await h.t.db.selectFrom('kiosk_devices').select('id').execute()).toHaveLength(3)
  })

  it('outside the shop the PIN is never checked, even from the tablet; a wrong PIN never tells whether someone has it', async () => {
    const { admin, device, pin, shopIp } = await h.kioskSetup()
    const out = await tryUnlock(h, device.cookie, pin, '198.51.100.7')
    expect(out.statusCode).toBe(403)
    expect(out.json().code).toBe('KIOSK_NOT_AT_SHOP')
    for (let i = 0; i < 30; i++) await tryUnlock(h, device.cookie, '11112229', '198.51.100.7')
    expect((await h.t.db.selectFrom('kiosk_devices').select('failed_attempts').executeTakeFirstOrThrow()).failed_attempts).toBe(0)
    expect((await h.t.db.selectFrom('kiosk_networks').select('failed_attempts').executeTakeFirstOrThrow()).failed_attempts).toBe(0)
    expect((await status(h, '198.51.100.7', device.cookie)).json()).toMatchObject({ atShop: false, lockedOut: false, retryAfterSec: 0 })

    const hidden = await employee(h, { first: 'Cy', last: 'Hidden', listed: false })
    const gone = await employee(h, { first: 'Zed', last: 'Gone' })
    const hp = await h.setPin(admin, hidden)
    const gp = await h.setPin(admin, gone)
    await h.t.db.updateTable('employees').set({ status: 'inactive', deactivated_at: new Date() }).where('id', '=', gone).execute()
    // deactivating removed the PIN; put it back by hand: the unlock itself still refuses a deactivated employee
    await h.t.db
      .insertInto('employee_kiosk_pins')
      .values({ employee_id: gone, location_id: h.t.location.id, pin_lookup: pinLookup(kioskKey({ NODE_ENV: 'test' }), h.t.location.id, gp) })
      .execute()
    const answers: { status: number; body: Json }[] = []
    for (const p of ['30481726', hp, gp]) {
      const r = await tryUnlock(h, null, p, shopIp)
      answers.push({ status: r.statusCode, body: r.json() as Json })
    }
    const shape = (a: { status: number; body: Json }) => [a.status, a.body.code, a.body.title, a.body.detail, a.body.meta]
    expect(shape(answers[0]!)).toEqual([401, 'KIOSK_PIN_WRONG', 'Wrong PIN', 'That PIN didn’t work.', { retryAfterSec: 0 }])
    expect(shape(answers[1]!)).toEqual(shape(answers[0]!))
    expect(shape(answers[2]!)).toEqual(shape(answers[0]!))
  })

  it('wrong PINs from a browser: 3 free, then a doubling wait during which even the right PIN is not checked', async () => {
    const { admin, device, pin, shopIp } = await h.kioskSetup()
    await h.call('POST', 'kiosk/lock-all', { session: admin })
    for (let i = 1; i <= 3; i++) {
      const r = await tryUnlock(h, device.cookie, '11112229', shopIp)
      expect(r.statusCode).toBe(401)
      expect(r.json()).toMatchObject({ code: 'KIOSK_PIN_WRONG', detail: 'That PIN didn’t work.', meta: { retryAfterSec: 0 } })
    }
    const fourth = await tryUnlock(h, device.cookie, '11112229', shopIp)
    expect(fourth.json().meta).toEqual({ retryAfterSec: 2 })
    const held = await tryUnlock(h, device.cookie, pin, shopIp)
    expect(held.statusCode).toBe(429)
    expect(held.json().code).toBe('KIOSK_THROTTLED')
    expect(held.headers['retry-after']).toBe('2')
    expect((await status(h, shopIp, device.cookie)).json().retryAfterSec).toBe(2)
    expect((await h.t.db.selectFrom('kiosk_devices').select('failed_attempts').executeTakeFirstOrThrow()).failed_attempts).toBe(4)
    h.clock.advance(2000)
    const ok = await tryUnlock(h, device.cookie, pin, shopIp)
    expect(ok.statusCode).toBe(200)
    const d = await h.t.db.selectFrom('kiosk_devices').selectAll().executeTakeFirstOrThrow()
    expect({ n: d.failed_attempts, last: d.last_failed_at }).toEqual({ n: 0, last: null })
    const n = await h.t.db.selectFrom('kiosk_networks').selectAll().executeTakeFirstOrThrow()
    expect({ n: n.failed_attempts, last: n.last_failed_at }).toEqual({ n: 0, last: null })
    const failed = await h.t.db.selectFrom('audit_log').selectAll().where('action', '=', 'kiosk.unlock.failed').execute()
    expect(failed).toHaveLength(4)
    expect(failed[0]).toMatchObject({ entity_type: 'kiosk_device', entity_id: device.id, kiosk_device_id: device.id, actor_employee_id: null })
    expect(JSON.stringify(failed)).not.toContain('11112229')
  })

  it('20 wrong PINs lock the browser out until a manager clears it; another browser at the shop still unlocks', async () => {
    const { admin, device, pin, shopIp } = await h.kioskSetup()
    await h.t.db.updateTable('kiosk_devices').set({ failed_attempts: 19, last_failed_at: new Date('2026-06-13T13:00:00Z') }).execute()
    const r = await tryUnlock(h, device.cookie, '11112229', shopIp)
    expect(r.statusCode).toBe(423)
    expect(r.json().code).toBe('KIOSK_LOCKED_OUT')
    expect((await tryUnlock(h, device.cookie, pin, shopIp)).statusCode).toBe(423) // the right PIN too
    expect((await status(h, shopIp, device.cookie)).json().lockedOut).toBe(true)
    expect((await status(h, shopIp)).json().lockedOut).toBe(false)
    expect((await tryUnlock(h, null, pin, shopIp)).statusCode).toBe(200)
    const ov = await overview(h, admin)
    expect(ov.devices.find((d: Json) => d.id === device.id).state).toBe('locked_out')
    const cleared = await h.call('POST', `kiosk/devices/${device.id}/clear-lockout`, { session: admin })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json()).toMatchObject({ failedAttempts: 0 })
    expect((await tryUnlock(h, device.cookie, pin, shopIp)).statusCode).toBe(200)
    const actions = (await h.t.db.selectFrom('audit_log').select('action').where('action', 'like', 'kiosk.device.lockout%').execute()).map(
      (x) => x.action,
    )
    expect(actions.sort()).toEqual(['kiosk.device.lockout', 'kiosk.device.lockout.clear'])
  })

  it('the shop address has its own counter for every browser: 5 free, then waits, 30 lock it out until a manager clears it', async () => {
    const { admin, pin, shopIp } = await h.kioskSetup()
    for (let i = 1; i <= 5; i++) expect((await tryUnlock(h, null, '11112229', shopIp)).json().meta).toEqual({ retryAfterSec: 0 })
    expect((await tryUnlock(h, null, '11112229', shopIp)).json().meta).toEqual({ retryAfterSec: 2 })
    expect((await tryUnlock(h, null, pin, shopIp)).statusCode).toBe(429) // any browser at the shop waits
    expect((await status(h, shopIp)).json().retryAfterSec).toBe(2)
    const net = await h.t.db.selectFrom('kiosk_networks').selectAll().executeTakeFirstOrThrow()
    await h.t.db.updateTable('kiosk_networks').set({ failed_attempts: 29, last_failed_at: new Date('2026-06-13T13:00:00Z') }).execute()
    const r = await tryUnlock(h, null, '11112229', shopIp)
    expect(r.statusCode).toBe(423)
    expect((await tryUnlock(h, null, pin, shopIp)).json().code).toBe('KIOSK_LOCKED_OUT')
    expect((await status(h, shopIp)).json().lockedOut).toBe(true)
    const ov = await overview(h, admin)
    expect(ov.networks[0]).toMatchObject({ id: net.id, lockedOut: true, failedAttempts: 30 })
    expect(ov.recent.find((x: Json) => x.action === 'kiosk.network.lockout')).toMatchObject({ label: 'Shop network locked out after too many wrong PINs' })
    const mgr = await h.createUser({ email: 'mgr@example.test', roles: ['mgmt'] })
    const m = await h.login(mgr, '10.8.8.8')
    const cleared = await h.call('POST', `kiosk/networks/${net.id}/clear-lockout`, { session: m })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json()).toMatchObject({ lockedOut: false, failedAttempts: 0 })
    expect((await tryUnlock(h, null, pin, shopIp)).statusCode).toBe(200)
    expect((await h.call('POST', `kiosk/networks/${NIL}/clear-lockout`, { session: m })).statusCode).toBe(404)
  })

  it('a removed browser is a new one at its next unlock; a new unlock ends the previous kiosk session of the browser', async () => {
    const { admin, device, kiosk } = await h.kioskSetup()
    const second = await h.unlock(device)
    expect((await h.kioskCall('GET', 'kiosk/me', kiosk)).statusCode).toBe(401)
    expect((await h.kioskCall('GET', 'kiosk/me', second)).statusCode).toBe(200)
    const prev = await h.t.db.selectFrom('kiosk_sessions').selectAll().where('id', '=', hashToken(kiosk.token)).executeTakeFirstOrThrow()
    expect(prev.revoked_reason).toBe('unlock_again')
    expect((await h.call('DELETE', `kiosk/devices/${device.id}`, { session: admin })).statusCode).toBe(204)
    expect((await h.kioskCall('GET', 'kiosk/me', second)).statusCode).toBe(401)
    const again = await h.unlock(device)
    expect(again.device.id).toBe(device.id) // the harness keeps the old cookie in the jar...
    const fresh = again.res.json() as Json
    expect(fresh.device.id).not.toBe(device.id) // ...but the server made it a new browser
    expect(again.res.cookies.find((c) => c.name === 'oasis_kdev')!.value).not.toBe(device.token)
  })
})

describe('the kiosk context', () => {
  const h = useHarness()

  it('reaches only its route list: account routes say KIOSK_SESSION, everything else KIOSK_FORBIDDEN', async () => {
    const { kiosk } = await h.kioskSetup()
    const me = await h.kioskCall('GET', 'me', kiosk)
    expect(me.statusCode).toBe(403)
    expect(me.json().code).toBe('KIOSK_SESSION')
    for (const [m, url] of [
      ['GET', 'settings/hours'],
      ['PUT', 'settings/hours'],
      ['GET', 'payments/summary'],
      ['GET', 'kiosk'],
      ['GET', 'employees'],
      ['POST', 'kiosk/networks'],
      ['PUT', `kiosk/staff/${NIL}/pin`],
      ['POST', `invoices/${NIL}/refunds`],
      ['DELETE', `appointments/${NIL}/photos/${NIL}`],
      ['POST', `appointments/${NIL}/cancel`],
    ] as const) {
      const r = await h.kioskCall(m, url, kiosk, { body: m === 'GET' ? undefined : {} })
      expect(r.statusCode, `${m} ${url}`).toBe(403)
      expect(r.json().code, `${m} ${url}`).toBe('KIOSK_FORBIDDEN')
    }
    const csrf = await h.kioskCall('GET', 'auth/csrf', kiosk)
    expect(csrf.json().csrfToken).toBe(kiosk.csrf)
    expect((await h.kioskCall('GET', 'ops/snapshot', kiosk)).statusCode).toBe(200)
  })

  it('the picker lists active and invited employees shown on the kiosk, bay staff first; not inactive, unlisted or other shops', async () => {
    const { kiosk } = await h.kioskSetup()
    await h.createUser({ email: 'marco@example.test', first: 'Marco', last: 'Rossi', roles: ['crew'] })
    await h.createUser({ email: 'ana@example.test', first: 'Ana', last: 'Lima', roles: ['support'] })
    await employee(h, { first: 'Zed', last: 'Invited', status: 'invited' })
    await employee(h, { first: 'Bob', last: 'Gone', status: 'inactive' })
    await employee(h, { first: 'Cy', last: 'Hidden', status: 'invited', listed: false })
    const other = await ensureLocation(h.t.db, () => randomUUID(), { slug: 'second', name: 'Second' })
    await employee(h, { first: 'Otto', last: 'Elsewhere', status: 'invited', locationId: other.id })
    const r = await h.kioskCall('GET', 'kiosk/staff', kiosk)
    expect(r.statusCode).toBe(200)
    const names = (r.json().items as Json[]).map((p) => [p.name, p.bayStaff])
    expect(names).toEqual([
      ['Marco R.', true],
      ['Ana L.', false],
      ['Rafael M.', false],
      ['Zed I.', false],
    ])
  })

  it('a write that records who did it needs X-Oasis-Employee of a listed active or invited employee of the shop', async () => {
    const { kiosk } = await h.kioskSetup()
    const marco = await h.createUser({ email: 'marco@example.test', first: 'Marco', last: 'Rossi', roles: ['crew'] })
    const invited = await employee(h, { first: 'Zed', last: 'Invited' })
    const inactive = await employee(h, { first: 'Bob', last: 'Gone', status: 'inactive' })
    const hidden = await employee(h, { first: 'Cy', last: 'Hidden', listed: false })
    const other = await ensureLocation(h.t.db, () => randomUUID(), { slug: 'second', name: 'Second' })
    const elsewhere = await employee(h, { first: 'Otto', last: 'Elsewhere', locationId: other.id })
    const url = `appointments/${NIL}/arrive`

    const none = await h.kioskCall('POST', url, kiosk, { body: {} })
    expect(none.statusCode).toBe(428)
    expect(none.json().code).toBe('KIOSK_EMPLOYEE_REQUIRED')
    for (const bad of [randomUUID(), 'not-a-uuid', inactive, hidden, elsewhere]) {
      const r = await h.kioskCall('POST', url, kiosk, { body: {}, actor: bad })
      expect(r.statusCode, bad).toBe(422)
      expect(r.json().code).toBe('KIOSK_EMPLOYEE_INVALID')
    }
    for (const ok of [marco.employeeId, invited]) {
      const r = await h.kioskCall('POST', url, kiosk, { body: {}, actor: ok })
      expect(r.statusCode).toBe(404) // through to the command: no such appointment
    }
    const noCsrf = await h.kioskCall('POST', url, kiosk, { body: {}, actor: marco.employeeId, csrf: false })
    expect(noCsrf.statusCode).toBe(403)
    expect(noCsrf.json().code).toBe('CSRF_INVALID')
    // a write with no acting employee
    expect((await h.kioskCall('POST', `customers/${NIL}/messages/read`, kiosk, { body: {} })).statusCode).not.toBe(428)
  })

  it('records the tapped employee and the device, never a user, on what it changes', async () => {
    const { kiosk, device } = await h.kioskSetup()
    const marco = await h.createUser({ email: 'marco@example.test', first: 'Marco', last: 'Rossi', roles: ['crew'] })
    const r = await h.kioskCall('POST', 'customers', kiosk, {
      actor: marco.employeeId,
      body: { name: 'Walk In', phone: '(201) 555-0142' },
    })
    expect(r.statusCode).toBe(201)
    const a = await h.t.db.selectFrom('audit_log').selectAll().where('action', '=', 'customer.create').executeTakeFirstOrThrow()
    expect(a).toMatchObject({
      actor_user_id: null,
      actor_employee_id: marco.employeeId,
      actor_name: 'Marco R.',
      actor_roles: 'Kiosk',
      kiosk_device_id: device.id,
    })
  })

  it('locks at its lock time', async () => {
    const { kiosk } = await h.kioskSetup()
    h.clock.set('2026-06-13T18:59:00-04:00')
    expect((await h.kioskCall('GET', 'kiosk/me', kiosk)).statusCode).toBe(200)
    h.clock.set('2026-06-13T19:00:00-04:00')
    expect((await h.kioskCall('GET', 'kiosk/me', kiosk)).statusCode).toBe(401)
  })

  it('is refused by a signed-in person’s kiosk-only routes, and kiosk-only routes refuse a person', async () => {
    const u = await h.createUser({ email: 'boss@example.test', roles: ['super'] })
    const s = await h.login(u)
    for (const [m, url] of [
      ['GET', 'kiosk/me'],
      ['GET', 'kiosk/staff'],
      ['POST', 'kiosk/lock'],
    ] as const) {
      const r = await h.call(m, url, { session: s })
      expect(r.statusCode).toBe(403)
      expect(r.json().code).toBe('NOT_A_KIOSK')
    }
  })

  it('the shop code and "Make this a kiosk" are gone', async () => {
    const { admin } = await h.kioskSetup()
    expect((await h.call('PUT', 'kiosk/code', { session: admin, body: { code: KIOSK_PIN } })).statusCode).toBe(404)
    expect((await h.call('POST', 'kiosk/devices', { session: admin, body: { name: 'Tablet' } })).statusCode).toBe(404)
    const old = await h.t.app.inject({
      method: 'POST',
      url: '/api/v1/kiosk/unlock',
      headers: { origin: h.origin },
      remoteAddress: SHOP,
      payload: { code: KIOSK_PIN },
    })
    expect(old.statusCode).toBe(422)
    const tables = await sql<{ n: number }>`select count(*)::int as n from information_schema.tables where table_name = 'kiosk_codes'`.execute(h.t.db)
    expect(tables.rows[0]!.n).toBe(0)
  })
})

describe('what ends a kiosk session', () => {
  const h = useHarness()
  const gone = async (k: KioskSession) => (await h.kioskCall('GET', 'kiosk/me', k)).statusCode === 401
  const reason = async (k: KioskSession) =>
    (await h.t.db.selectFrom('kiosk_sessions').select('revoked_reason').where('id', '=', hashToken(k.token)).executeTakeFirstOrThrow())
      .revoked_reason

  it('Lock kiosk clears the cookie', async () => {
    const { kiosk, device } = await h.kioskSetup()
    const r = await h.kioskCall('POST', 'kiosk/lock', kiosk)
    expect(r.statusCode).toBe(204)
    expect(r.cookies.find((c) => c.name === 'oasis_ksid')?.value).toBe('')
    expect(await gone(kiosk)).toBe(true)
    expect(await reason(kiosk)).toBe('lock')
    const a = await h.t.db.selectFrom('audit_log').selectAll().where('action', '=', 'kiosk.lock').executeTakeFirstOrThrow()
    expect(a.kiosk_device_id).toBe(device.id)
  })

  it('lock all, locking the browser and kiosk mode off; a PIN change locks nothing', async () => {
    const { admin, adminUser, device, kiosk } = await h.kioskSetup()
    await h.setPin(admin, adminUser.employeeId, '47391028')
    expect(await gone(kiosk)).toBe(false) // the tablet stays open
    expect((await h.unlock(null, KIOSK_PIN).catch((e: Error) => e.message)) as string).toMatch(/KIOSK_PIN_WRONG/)

    const k2 = await h.unlock(device, '47391028')
    expect(await reason(kiosk)).toBe('unlock_again') // the browser's previous session
    const all = await h.call('POST', 'kiosk/lock-all', { session: admin })
    expect(all.json()).toEqual({ locked: 1 })
    expect(await reason(k2)).toBe('lock_all')

    const k3 = await h.unlock(device, '47391028')
    expect((await h.call('POST', `kiosk/devices/${device.id}/lock`, { session: admin })).statusCode).toBe(204)
    expect(await reason(k3)).toBe('lock_device')

    const k4 = await h.unlock(device, '47391028')
    await h.setKioskMode(admin, false)
    expect(await gone(k4)).toBe(true)
    expect(await reason(k4)).toBe('kiosk_off')
    const actions = (await h.t.db.selectFrom('audit_log').select('action').where('action', 'like', 'kiosk.%').execute()).map((x) => x.action)
    expect(actions).toEqual(expect.arrayContaining(['kiosk.pin.set', 'kiosk.lock_all', 'kiosk.device.lock', 'kiosk.mode.off']))
  })

  it('kiosk mode off alone makes a live session invalid', async () => {
    const { kiosk } = await h.kioskSetup()
    await h.t.db.updateTable('settings').set({ value: JSON.stringify(false) }).where('key', '=', 'kiosk.enabled').execute()
    expect(await gone(kiosk)).toBe(true)
  })

  it('the session only works with the cookie of its own browser', async () => {
    const { kiosk } = await h.kioskSetup()
    const other = (await h.unlock(null)).device
    const swapped = { cookie: `${other.cookie}; oasis_ksid=${kiosk.token}`, csrf: kiosk.csrf }
    expect((await h.kioskCall('GET', 'kiosk/me', swapped)).statusCode).toBe(401)
    expect((await h.kioskCall('GET', 'kiosk/me', { cookie: `oasis_ksid=${kiosk.token}`, csrf: kiosk.csrf })).statusCode).toBe(401)
  })
})

describe('changes at the same moment', () => {
  const h = useHarness()

  it('Lock all waits for an unlock in progress and ends the session it opens', async () => {
    const { admin, adminUser, device, kiosk } = await h.kioskSetup()
    let lockAll: Promise<Awaited<ReturnType<Harness['call']>>> | undefined
    // an unlock in progress: it holds the browser's row and opens its session, then commits after Lock all started
    const opened = await h.t.db.transaction().execute(async (tx) => {
      await tx.selectFrom('kiosk_devices').select('id').where('id', '=', device.id).forUpdate().executeTakeFirstOrThrow()
      const s = await createKioskSession(tx, h.clock, {
        deviceId: device.id,
        locationId: h.t.location.id,
        openedBy: { employeeId: adminUser.employeeId, name: 'Rafael M.' },
        expiresAt: new Date(LOCKS_AT),
        lockRule: 'closing',
      })
      lockAll = h.call('POST', 'kiosk/lock-all', { session: admin })
      await new Promise((r) => setTimeout(r, 400))
      return s
    })
    const all = await lockAll!
    expect(all.statusCode).toBe(200)
    expect(all.json()).toEqual({ locked: 2 })
    const rows = await h.t.db
      .selectFrom('kiosk_sessions')
      .select(['id', 'revoked_reason'])
      .where('id', 'in', [opened.id, hashToken(kiosk.token)])
      .execute()
    expect(rows.map((r) => r.revoked_reason)).toEqual(['lock_all', 'lock_all'])
  })

  it('Lock all waits for a first unlock in progress (it holds the shop address’s row)', async () => {
    const { admin, shopIp } = await h.kioskSetup()
    let lockAll: Promise<Awaited<ReturnType<Harness['call']>>> | undefined
    await h.t.db.transaction().execute(async (tx) => {
      await tx.selectFrom('kiosk_networks').select('id').forUpdate().execute()
      lockAll = h.call('POST', 'kiosk/lock-all', { session: admin })
      await new Promise((r) => setTimeout(r, 300))
      // Lock all is still waiting for the address's row
      expect(await Promise.race([lockAll.then(() => 'done'), new Promise((r) => setTimeout(() => r('waiting'), 50))])).toBe('waiting')
    })
    expect((await lockAll!).statusCode).toBe(200)
    expect(shopIp).toBeTruthy()
  })
})

describe('users and kiosks on one tablet', () => {
  const h = useHarness()

  it('a user session wins over the kiosk cookies, and X-Oasis-Employee is ignored', async () => {
    const { admin, kiosk, adminUser } = await h.kioskSetup()
    const both = { cookie: `${admin.cookie}; ${kiosk.cookie}`, csrf: admin.csrf }
    const me = await h.call('GET', 'me', { session: both })
    expect(me.statusCode).toBe(200)
    expect(me.json().employee.id).toBe(adminUser.employeeId)
    const r = await h.call('POST', 'customers', {
      session: both,
      body: { name: 'Walk In', phone: '(201) 555-0143' },
      headers: { 'x-oasis-employee': randomUUID() },
    })
    expect(r.statusCode).toBe(201)
    const a = await h.t.db.selectFrom('audit_log').selectAll().where('action', '=', 'customer.create').executeTakeFirstOrThrow()
    expect(a).toMatchObject({ actor_user_id: adminUser.userId, actor_employee_id: adminUser.employeeId, kiosk_device_id: null })
  })

  it('unlocking signs out a user session on the browser and clears its cookie', async () => {
    const { device, adminUser, pin, shopIp } = await h.kioskSetup()
    const s = await h.login(adminUser)
    const res = await tryUnlock(h, `${device.cookie}; ${s.cookie}`, pin, shopIp)
    expect(res.statusCode).toBe(200)
    expect(res.cookies.find((c) => c.name === 'oasis_sid')?.value).toBe('')
    expect((await h.call('GET', 'me', { session: s })).statusCode).toBe(401)
    const a = await h.t.db.selectFrom('audit_log').selectAll().where('action', '=', 'kiosk.unlock').orderBy('id', 'desc').executeTakeFirstOrThrow()
    expect(a.after).toMatchObject({ userSignedOut: true })
  })

  it('a manager signing in on a browser that unlocked at the shop gets 15 minutes idle and 4 hours at most', async () => {
    const { device, adminUser } = await h.kioskSetup()
    const res = await h.t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: h.origin, cookie: device.cookie },
      payload: { email: adminUser.email, password: adminUser.password },
    })
    expect(res.statusCode).toBe(200)
    const c = res.cookies.find((x) => x.name === 'oasis_sid')!
    expect(c.maxAge).toBe(4 * 60 * 60)
    const s = { cookie: `oasis_sid=${c.value}`, csrf: res.json().csrfToken as string }
    const me = (await h.call('GET', 'me', { session: s })).json() as Json
    expect(me.kioskDevice).toEqual({ id: device.id, name: device.name })
    expect(me.session.expiresAt).toBe('2026-06-13T18:36:00.000Z')
    h.clock.advance(14 * 60_000)
    expect((await h.call('GET', 'me', { session: s })).statusCode).toBe(200) // slides 15 more minutes
    h.clock.advance(14 * 60_000)
    expect((await h.call('GET', 'me', { session: s })).statusCode).toBe(200)
    h.clock.advance(16 * 60_000)
    expect((await h.call('GET', 'me', { session: s })).statusCode).toBe(401)

    const normal = await h.login(adminUser)
    expect(((await h.call('GET', 'me', { session: normal })).json() as Json).kioskDevice).toBeNull()
  })
})

describe('K4 review: a manager on the tablet never keeps a long session (kiosk:F1, kiosk:F2)', () => {
  const h = useHarness()
  const loginOn = async (device: KioskDevice, u: { email: string; password: string }) => {
    const res = await h.t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: h.origin, cookie: device.cookie },
      payload: { email: u.email, password: u.password },
    })
    expect(res.statusCode).toBe(200)
    const c = res.cookies.find((x) => x.name === 'oasis_sid')!
    return { cookie: `oasis_sid=${c.value}; ${device.cookie}`, csrf: res.json().csrfToken as string }
  }
  const alive = async (s: { cookie: string; csrf: string }) => (await h.call('GET', 'me', { session: s })).statusCode === 200

  it('the documented first setup on the tablet itself (0218, the shop network, a PIN, unlock) ends on the kiosk, never a 14-day session', async () => {
    const u = await h.createUser({ email: 'boss@example.test', roles: ['super'], first: 'Rafael', last: 'Mendes' })
    const s = await h.login(u, SHOP) // a normal 14-day session, on a browser that never unlocked
    await h.addShopNetwork(s, SHOP)
    const pin = await h.setPin(s, u.employeeId)
    const res = await tryUnlock(h, s.cookie, pin, SHOP) // typing a PIN on that browser
    expect(res.statusCode).toBe(200)
    expect(res.cookies.find((c) => c.name === 'oasis_sid')?.value).toBe('') // the manager is signed out there
    expect(await alive(s)).toBe(false)
    const kdev = res.cookies.find((c) => c.name === 'oasis_kdev')!.value
    // signing in again there (0218) is the short kiosk-admin session
    const again = await loginOn({ id: '', name: '', token: kdev, cookie: `oasis_kdev=${kdev}` }, u)
    const me = (await h.call('GET', 'me', { session: again })).json() as Json
    expect(me.kioskDevice).toMatchObject({ id: res.json().device.id })
    expect(me.session.expiresAt).toBe('2026-06-13T18:36:00.000Z')
  })

  it('a session that never sent the device cookie is not touched; one opened elsewhere is tied as soon as it comes with it', async () => {
    const { admin, adminUser, device } = await h.kioskSetup()
    expect(((await h.call('GET', 'me', { session: admin })).json() as Json).kioskDevice).toBeNull()
    const other = await h.login(adminUser)
    const onTablet = { cookie: `${other.cookie}; ${device.cookie}`, csrf: other.csrf }
    expect(((await h.call('GET', 'me', { session: onTablet })).json() as Json).kioskDevice).toEqual({ id: device.id, name: device.name })
    h.clock.advance(16 * 60_000) // 15 minutes idle
    expect(await alive(onTablet)).toBe(false)
    expect(await alive(other)).toBe(false) // the same session without the device cookie: tied for good
    expect(await alive(admin)).toBe(true)
  })

  it('accepting an invite on the tablet opens the short kiosk-admin session', async () => {
    const { device } = await h.kioskSetup()
    const id = randomUUID()
    await h.t.db.insertInto('employees').values({ id, first: 'Kevin', last: 'Tran', status: 'invited' }).execute()
    await h.t.db.insertInto('employee_locations').values({ employee_id: id, location_id: h.t.location.id }).execute()
    const { token } = await h.t.db.transaction().execute((tx) => h.identity.auth.issueInvite(tx, id, null))
    const res = await h.t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/invite/accept',
      headers: { origin: h.origin, cookie: device.cookie },
      payload: { token, email: 'kevin@example.test', password: TEST_PASSWORD },
    })
    expect(res.statusCode, res.body).toBe(200)
    const c = res.cookies.find((x) => x.name === 'oasis_sid')!
    expect(c.maxAge).toBe(4 * 60 * 60)
    const row = await h.t.db.selectFrom('sessions').selectAll().where('id', '=', hashToken(c.value)).executeTakeFirstOrThrow()
    expect(row.kiosk_device_id).toBe(device.id)
  })

  it('Lock all, locking the browser, kiosk mode off and Remove each sign out a manager on the tablet', async () => {
    const { admin, adminUser, device } = await h.kioskSetup()
    let t = await loginOn(device, adminUser)
    expect(await alive(t)).toBe(true)
    expect((await h.call('POST', 'kiosk/lock-all', { session: admin })).statusCode).toBe(200)
    expect(await alive(t)).toBe(false)

    t = await loginOn(device, adminUser)
    expect((await h.call('POST', `kiosk/devices/${device.id}/lock`, { session: admin })).statusCode).toBe(204)
    expect(await alive(t)).toBe(false)

    t = await loginOn(device, adminUser)
    await h.setKioskMode(admin, false)
    expect(await alive(t)).toBe(false)
    await h.setKioskMode(admin, true)

    t = await loginOn(device, adminUser)
    // the manager on the tablet locks every kiosk from the tablet: signed out there, the cookie cleared
    const self = await h.call('POST', 'kiosk/lock-all', { session: t })
    expect(self.statusCode).toBe(200)
    expect(self.cookies.find((c) => c.name === 'oasis_sid')?.value).toBe('')
    expect(await alive(t)).toBe(false)

    t = await loginOn(device, adminUser)
    expect((await h.call('DELETE', `kiosk/devices/${device.id}`, { session: admin })).statusCode).toBe(204)
    expect(await alive(t)).toBe(false)
    expect(await alive(admin)).toBe(true) // the manager's own session elsewhere is not touched
    const audit = await h.t.db.selectFrom('audit_log').select('after').where('action', '=', 'kiosk.lock_all').orderBy('id').execute()
    expect(audit[0]!.after).toMatchObject({ managersSignedOut: 1 })
  })
})

describe('the manager’s controls', () => {
  const h = useHarness()

  it('GET /kiosk shows mode, networks, browsers, who shows on the kiosk and who has a PIN, recent events; rename, list, remove', async () => {
    const { admin, device, adminUser } = await h.kioskSetup()
    const zed = await employee(h, { first: 'Zed', last: 'Invited' })
    const ov = await overview(h, admin)
    expect(ov).toMatchObject({ enabled: true, thisDeviceId: null, canManageNetworks: true })
    expect(ov).not.toHaveProperty('code')
    expect(ov.devices).toEqual([
      expect.objectContaining({ id: device.id, name: 'Shop browser 1', state: 'unlocked', openedBy: 'Rafael M.', createdBy: 'Rafael M.' }),
    ])
    expect(ov.staff).toEqual(
      expect.arrayContaining([
        { id: zed, name: 'Zed I.', status: 'invited', listed: true, pin: null },
        expect.objectContaining({ id: adminUser.employeeId, pin: expect.objectContaining({ setBy: 'Rafael M.' }) }),
      ]),
    )
    expect((ov.recent as Json[]).map((r) => r.action)).toEqual(
      expect.arrayContaining(['kiosk.unlock', 'kiosk.pin.set', 'kiosk.network.add', 'kiosk.device.register']),
    )
    expect((ov.recent as Json[]).find((r) => r.action === 'kiosk.unlock')).toMatchObject({ label: 'Unlocked', deviceName: 'Shop browser 1' })

    const here = (await h.call('GET', 'kiosk', { session: { cookie: `${admin.cookie}; ${device.cookie}`, csrf: admin.csrf } })).json() as Json
    expect(here.thisDeviceId).toBe(device.id)

    const stale = await h.call('PATCH', `kiosk/devices/${device.id}`, { session: admin, body: { name: 'Desk', version: 99 } })
    expect(stale.statusCode).toBe(412)
    const renamed = await h.call('PATCH', `kiosk/devices/${device.id}`, { session: admin, body: { name: 'Desk', version: 1 } })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json()).toMatchObject({ name: 'Desk', version: 2 })

    const off = await h.call('PUT', `kiosk/staff/${zed}`, { session: admin, body: { listed: false } })
    expect(off.json()).toEqual({ id: zed, name: 'Zed I.', status: 'invited', listed: false })
    expect((await h.call('PUT', `kiosk/staff/${NIL}`, { session: admin, body: { listed: false } })).statusCode).toBe(404)
    expect((await h.call('PUT', `kiosk/staff/nope`, { session: admin, body: { listed: false } })).statusCode).toBe(404)
    expect((await h.call('DELETE', `kiosk/devices/${NIL}`, { session: admin })).statusCode).toBe(404)
    expect((await h.call('DELETE', `kiosk/staff/${NIL}/pin`, { session: admin })).statusCode).toBe(404)
  })

  it('the activity report answers the manager, with the unlock on the opener’s timeline', async () => {
    const { admin, adminUser } = await h.kioskSetup()
    const r = await h.call('GET', 'reports/employee-activity?from=2026-06-01&to=2026-06-13', { session: admin })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ from: '2026-06-01', to: '2026-06-13', amounts: true })
    const e = await h.call('GET', `reports/employee-activity/${adminUser.employeeId}/events?from=2026-06-01&to=2026-06-13`, { session: admin })
    expect(e.statusCode).toBe(200)
    expect(e.json().items).toEqual([expect.objectContaining({ kind: 'kiosk_unlock', via: 'kiosk', deviceName: 'Shop browser 1' })])
  })
})

describe('production cookies', () => {
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

  it('are __Host- prefixed, Secure, HttpOnly, SameSite=Lax, with no Domain', async () => {
    const { device, kiosk } = await h.kioskSetup()
    expect(device.cookie).toMatch(/^__Host-oasis_kdev=/)
    const raw = ([] as string[]).concat(kiosk.res.headers['set-cookie'] as string | string[])
    for (const name of ['__Host-oasis_ksid', '__Host-oasis_kdev']) {
      const c = raw.find((x) => x.startsWith(`${name}=`))!
      expect(c, name).toMatch(/Secure/i)
      expect(c).toMatch(/HttpOnly/i)
      expect(c).toMatch(/SameSite=Lax/i)
      expect(c).toMatch(/Path=\//)
      expect(c).not.toMatch(/Domain=/i)
    }
    expect((await h.kioskCall('GET', 'kiosk/me', kiosk)).statusCode).toBe(200)
  })
})

describe('rate limits are per browser', () => {
  const h = useHarness({ env: { RATE_LIMIT_PER_MIN: '12' } })

  it('one tablet is one caller, whatever the address; another tablet has its own budget', async () => {
    const { user, s } = await superAt(h)
    await h.addShopNetwork(s, SHOP)
    const pin = await h.setPin(s, user.employeeId)
    const k1 = await h.unlock(null, pin, SHOP)
    const k2 = await h.unlock(null, pin, SHOP)
    expect(k1.device.id).not.toBe(k2.device.id)
    const codes: number[] = []
    for (let i = 0; i < 14; i++) codes.push((await h.kioskCall('GET', 'kiosk/staff', k1, { ip: `10.77.0.${i + 1}` })).statusCode)
    expect(codes.slice(0, 12).every((c) => c === 200)).toBe(true)
    expect(codes.slice(12)).toEqual([429, 429])
    expect((await h.kioskCall('GET', 'kiosk/staff', k2, { ip: '10.77.0.1' })).statusCode).toBe(200)
  })
})
