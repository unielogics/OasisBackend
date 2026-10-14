// An unlocked kiosk works only at the shop (ADR 0180 A13-A15, K-PIN review O1-O3): every kiosk-session request must come from a shop
// network (403 KIOSK_NOT_AT_SHOP otherwise, the session kept and listed like a refused PIN); the shop network's last_seen_at shows it
// is in use, so a refused entry says whether the shop's usual address was still working after it (shopActiveSince); and a known shop
// browser refused while the shop's network went quiet raises one Needs-attention alert for the Super Admins.
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { KIOSK_ADDRESS_ALERT_AFTER_MS } from '../../src/modules/kiosk/alerts.js'
import { KIOSK_NETWORK_CACHE_MS, KIOSK_NETWORK_SEEN_MS } from '../../src/modules/kiosk/network.js'
import { useHarness, type Harness, type KioskSession, type Session } from '../auth/harness.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>

const AWAY = '198.51.100.7'
const MIN = 60_000

const overview = async (h: Harness, s: Pick<Session, 'cookie' | 'csrf'>) => (await h.call('GET', 'kiosk', { session: s })).json() as Json
const refusedRow = (h: Harness, ip: string) =>
  h.t.db.selectFrom('kiosk_refused_networks').selectAll().where(sql<boolean>`cidr = ${ip}::cidr`).executeTakeFirst()
const networkSeen = async (h: Harness) =>
  (await h.t.db.selectFrom('kiosk_networks').select('last_seen_at').executeTakeFirstOrThrow()).last_seen_at?.toISOString() ?? null
const kioskAlerts = async (h: Harness, s: Pick<Session, 'cookie' | 'csrf'> | KioskSession) => {
  const r = 'device' in s ? await h.kioskCall('GET', 'ops/alerts', s) : await h.call('GET', 'ops/alerts', { session: s })
  expect(r.statusCode).toBe(200)
  return (r.json().alerts as Json[]).filter((a) => a.kind === 'kiosk_address_changed')
}
async function tryUnlock(h: Harness, cookie: string | null, pin: string, ip: string) {
  return h.t.app.inject({
    method: 'POST',
    url: '/api/v1/kiosk/unlock',
    headers: { origin: h.origin, ...(cookie ? { cookie } : {}) },
    remoteAddress: ip,
    payload: { pin },
  })
}

describe('an unlocked kiosk works only at the shop', () => {
  const h = useHarness()

  it('away from the shop every kind of kiosk request is 403 KIOSK_NOT_AT_SHOP; the session is kept and works again at the shop', async () => {
    const { kiosk, admin, device } = await h.kioskSetup()
    const marco = await h.createUser({ email: 'marco@example.test', first: 'Marco', last: 'Rossi', roles: ['crew'] })
    const away = { ...kiosk, ip: AWAY }
    for (const [m, url, body, actor] of [
      ['GET', 'kiosk/me', undefined, undefined],
      ['GET', 'kiosk/staff', undefined, undefined],
      ['GET', 'ops/snapshot', undefined, undefined], // a read
      ['GET', 'auth/csrf', undefined, undefined],
      ['POST', 'customers', { name: 'Walk In', phone: '(201) 555-0142' }, marco.employeeId], // a write with the acting employee
      ['POST', 'kiosk/lock', {}, undefined],
      ['GET', 'settings/hours', undefined, undefined], // not even a route off the list gets further
    ] as const) {
      const r = await h.kioskCall(m, url, away, { body, actor })
      expect(r.statusCode, `${m} ${url}`).toBe(403)
      expect(r.json(), `${m} ${url}`).toMatchObject({ code: 'KIOSK_NOT_AT_SHOP', meta: { networkSet: true } })
      expect(r.json().detail).toContain('only at the shop')
    }
    expect(await h.t.db.selectFrom('customers').select('id').execute()).toHaveLength(0)
    const s = await h.t.db.selectFrom('kiosk_sessions').select(['revoked_at']).where('device_id', '=', device.id).execute()
    expect(s).toEqual([{ revoked_at: null }])
    // back on the shop's Wi-Fi: the same session works
    expect((await h.kioskCall('GET', 'kiosk/me', kiosk)).statusCode).toBe(200)
    const made = await h.kioskCall('POST', 'customers', kiosk, { actor: marco.employeeId, body: { name: 'Walk In', phone: '(201) 555-0142' } })
    expect(made.statusCode).toBe(201)
    // a signed-in person is not affected, on the tablet's browser too
    expect((await h.call('GET', 'kiosk', { session: admin, ip: AWAY })).statusCode).toBe(200)
    const onTablet = { cookie: `${admin.cookie}; ${device.cookie}`, csrf: admin.csrf }
    expect((await h.call('GET', 'ops/snapshot', { session: onTablet, ip: AWAY })).statusCode).toBe(200)
    // kiosk mode off still wins: the session is simply gone
    await h.setKioskMode(admin, false)
    expect((await h.kioskCall('GET', 'kiosk/me', away)).statusCode).toBe(401)
  })

  it('is listed like a refused PIN from the session’s browser, written at most once a minute per address', async () => {
    const { kiosk, admin, device } = await h.kioskSetup()
    const away = { ...kiosk, ip: AWAY }
    for (let i = 0; i < 4; i++) expect((await h.kioskCall('GET', 'kiosk/me', away)).statusCode).toBe(403)
    expect(await refusedRow(h, AWAY)).toMatchObject({ attempts: 1, known_device_id: device.id, known_device_name: 'Shop browser 1' })
    h.clock.advance(MIN)
    await h.kioskCall('GET', 'ops/snapshot', away)
    expect((await refusedRow(h, AWAY))!.attempts).toBe(5)
    expect((await overview(h, admin)).refused).toEqual([
      expect.objectContaining({ address: AWAY, fromKnownBrowser: true, browserName: 'Shop browser 1', attempts: 5 }),
    ])
    // never an audit row, never a wrong-PIN counter
    expect(await h.t.db.selectFrom('audit_log').select('id').where('action', 'like', 'kiosk.unlock.%').execute()).toHaveLength(0)
    expect((await h.t.db.selectFrom('kiosk_devices').select('failed_attempts').executeTakeFirstOrThrow()).failed_attempts).toBe(0)
  })

  it('removing the shop network stops the kiosk there (at once in this process, within 30 seconds anywhere); adding it back restores it', async () => {
    const { kiosk, admin, shopIp } = await h.kioskSetup()
    const netId = (await overview(h, admin)).networks[0].id as string
    expect((await h.kioskCall('GET', 'kiosk/me', kiosk)).statusCode).toBe(200)
    expect((await h.call('DELETE', `kiosk/networks/${netId}`, { session: admin })).statusCode).toBe(204)
    const r = await h.kioskCall('GET', 'kiosk/me', kiosk)
    expect(r.statusCode).toBe(403)
    expect(r.json()).toMatchObject({ code: 'KIOSK_NOT_AT_SHOP', meta: { networkSet: false } })
    await h.addShopNetwork(admin, shopIp)
    expect((await h.kioskCall('GET', 'kiosk/me', kiosk)).statusCode).toBe(200)
    // removed by another process (straight in the database): the answer this process holds lasts at most 30 seconds
    await h.t.db.deleteFrom('kiosk_networks').execute()
    expect((await h.kioskCall('GET', 'kiosk/me', kiosk)).statusCode).toBe(200)
    h.clock.advance(KIOSK_NETWORK_CACHE_MS)
    expect((await h.kioskCall('GET', 'kiosk/me', kiosk)).statusCode).toBe(403)
  })

  it('the shop network is marked in use by an unlock, a kiosk request or the keypad’s status from it, at most every 5 minutes', async () => {
    const { kiosk, pin, shopIp } = await h.kioskSetup()
    const unlockedAt = h.clock.now().toISOString()
    expect(await networkSeen(h)).toBe(unlockedAt)
    h.clock.advance(MIN)
    await h.kioskCall('GET', 'kiosk/me', kiosk)
    expect(await networkSeen(h)).toBe(unlockedAt) // within 5 minutes of the unlock's write
    h.clock.advance(KIOSK_NETWORK_SEEN_MS)
    await h.kioskCall('GET', 'kiosk/me', kiosk)
    const byRequest = h.clock.now().toISOString()
    expect(await networkSeen(h)).toBe(byRequest)
    h.clock.advance(KIOSK_NETWORK_SEEN_MS - 1000)
    await h.t.app.inject({ method: 'GET', url: '/api/v1/kiosk/status', remoteAddress: shopIp })
    expect(await networkSeen(h)).toBe(byRequest)
    h.clock.advance(1000)
    await h.t.app.inject({ method: 'GET', url: '/api/v1/kiosk/status', remoteAddress: AWAY }) // not from the shop: nothing
    expect(await networkSeen(h)).toBe(byRequest)
    await h.t.app.inject({ method: 'GET', url: '/api/v1/kiosk/status', remoteAddress: shopIp })
    expect(await networkSeen(h)).toBe(h.clock.now().toISOString())
    // a wrong PIN at the shop is the shop in use too (its row is written anyway)
    h.clock.advance(MIN)
    expect((await tryUnlock(h, null, pin === '58203917' ? '61840275' : '58203917', shopIp)).statusCode).toBe(401)
    expect(await networkSeen(h)).toBe(h.clock.now().toISOString())
  })

  it('a refused entry says whether the shop’s network was in use after it (shopActiveSince)', async () => {
    const { kiosk, admin } = await h.kioskSetup()
    h.clock.advance(MIN)
    await h.kioskCall('GET', 'kiosk/me', { ...kiosk, ip: AWAY }) // the phone that unlocked at the shop, now at home
    const first = (await overview(h, admin)).refused as Json[]
    expect(first).toEqual([expect.objectContaining({ address: AWAY, fromKnownBrowser: true, shopActiveSince: false })])
    h.clock.advance(KIOSK_NETWORK_SEEN_MS)
    await h.kioskCall('GET', 'ops/snapshot', kiosk) // meanwhile the tablet keeps working at the shop
    expect((await overview(h, admin)).refused).toEqual([expect.objectContaining({ address: AWAY, shopActiveSince: true })])
  })
})

describe('"The shop’s internet address may have changed" (Needs attention, Super Admins)', () => {
  const h = useHarness()

  /** The tablet (renamed "Front desk tablet") refused from a new address an hour after the shop's network was last in use. */
  async function providerChanged() {
    const w = await h.kioskSetup()
    expect(
      (await h.call('PATCH', `kiosk/devices/${w.device.id}`, { session: w.admin, body: { name: 'Front desk tablet', version: 1 } })).statusCode,
    ).toBe(200)
    await h.call('POST', 'kiosk/lock-all', { session: w.admin })
    h.clock.advance(60 * MIN)
    expect((await tryUnlock(h, w.device.cookie, w.pin, AWAY)).json().code).toBe('KIOSK_NOT_AT_SHOP')
    return w
  }

  it('is raised once for a known shop browser refused while the shop’s network is quiet, and resolved when the address is approved', async () => {
    const { admin, device, pin } = await providerChanged()
    expect(await kioskAlerts(h, admin)).toEqual([]) // not before 10 minutes: a shop in use shows it by then
    h.clock.advance(KIOSK_ADDRESS_ALERT_AFTER_MS)
    const row = (await refusedRow(h, AWAY))!
    const raised = await kioskAlerts(h, admin)
    expect(raised).toEqual([
      expect.objectContaining({
        key: `kiosk_address_changed:${row.id}`,
        tone: 'amber',
        title: 'The shop’s internet address may have changed',
        desc: 'Front desk tablet was refused from a new address. A Super Admin can add it in Settings → Kiosk.',
        appointmentId: null,
      }),
    ])
    expect((await overview(h, admin)).refused).toEqual([expect.objectContaining({ fromKnownBrowser: true, shopActiveSince: false })])
    // more tries from that address, and a flood of other addresses: still the one alert
    h.clock.advance(MIN)
    await tryUnlock(h, device.cookie, pin, AWAY)
    for (let i = 1; i <= 5; i++) await tryUnlock(h, null, pin, `192.0.2.${i}`)
    h.clock.advance(KIOSK_ADDRESS_ALERT_AFTER_MS)
    expect((await kioskAlerts(h, admin)).map((a) => a.key)).toEqual([raised[0]!.key])
    // the operations snapshot carries it too; managers who are not Super Admins and the kiosk never see it
    const snap = (await h.call('GET', 'ops/snapshot', { session: admin })).json() as Json
    expect((snap.alerts as Json[]).filter((a) => a.kind === 'kiosk_address_changed')).toHaveLength(1)
    const mgr = await h.createUser({ email: 'mgr@example.test', roles: ['mgmt'], first: 'Mia', last: 'Grant' })
    expect(await kioskAlerts(h, await h.login(mgr))).toEqual([])
    const shopIp = (await h.t.db.selectFrom('kiosk_networks').select('cidr').executeTakeFirstOrThrow()).cidr.replace('/32', '')
    const quietSince = await networkSeen(h)
    const another = await h.unlock(null, pin, shopIp)
    expect(await kioskAlerts(h, another)).toEqual([])
    // that unlock is the shop's network in use again: not a provider change, the alert goes
    expect(await kioskAlerts(h, admin)).toEqual([])
    await h.call('POST', 'kiosk/lock-all', { session: admin })
    await h.t.db.updateTable('kiosk_networks').set({ last_seen_at: new Date(quietSince!) }).execute() // as if it had not happened
    expect((await kioskAlerts(h, admin)).map((a) => a.key)).toEqual([raised[0]!.key])
    // approved: resolved, and the tablet works from the new address
    expect((await h.call('POST', 'kiosk/networks', { session: admin, body: { address: AWAY } })).statusCode).toBe(201)
    expect(await kioskAlerts(h, admin)).toEqual([])
    expect((await tryUnlock(h, device.cookie, pin, AWAY)).statusCode).toBe(200)
  })

  it('resolved when the entry is pruned (30 days) or the browser removed; a Super Admin viewing as Management does not see it', async () => {
    const { admin, device } = await providerChanged()
    h.clock.advance(KIOSK_ADDRESS_ALERT_AFTER_MS)
    expect(await kioskAlerts(h, admin)).toHaveLength(1)
    const mgmtRole = await h.t.db.selectFrom('roles').select('id').where('key', '=', 'mgmt').executeTakeFirstOrThrow()
    expect((await h.call('POST', 'me/view-as', { session: admin, body: { roleId: mgmtRole.id } })).statusCode).toBe(200)
    expect(await kioskAlerts(h, admin)).toEqual([])
    expect((await h.call('POST', 'me/view-as', { session: admin, body: { roleId: null } })).statusCode).toBe(200)
    await h.t.db
      .updateTable('kiosk_refused_networks')
      .set({ last_seen_at: new Date(h.clock.now().getTime() - 31 * 24 * 60 * MIN) })
      .execute()
    expect(await kioskAlerts(h, admin)).toEqual([])
    await h.t.db.updateTable('kiosk_refused_networks').set({ last_seen_at: h.clock.now() }).execute()
    expect(await kioskAlerts(h, admin)).toHaveLength(1)
    expect((await h.call('DELETE', `kiosk/devices/${device.id}`, { session: admin })).statusCode).toBe(204)
    expect(await kioskAlerts(h, admin)).toEqual([])
  })

  it('no alert for an unknown browser, while the shop’s network is still in use, or with kiosk mode off', async () => {
    const { admin, kiosk, device, pin } = await h.kioskSetup()
    // an unknown browser from elsewhere
    await tryUnlock(h, null, pin, '198.51.100.50')
    h.clock.advance(KIOSK_ADDRESS_ALERT_AFTER_MS)
    expect(await kioskAlerts(h, admin)).toEqual([])
    // a shop browser away (an employee's phone at home) while the tablet keeps working at the shop
    await h.kioskCall('GET', 'kiosk/me', { ...kiosk, ip: AWAY })
    h.clock.advance(KIOSK_NETWORK_SEEN_MS)
    await h.kioskCall('GET', 'kiosk/me', kiosk)
    h.clock.advance(KIOSK_ADDRESS_ALERT_AFTER_MS)
    expect((await overview(h, admin)).refused.find((r: Json) => r.address === AWAY)).toMatchObject({ shopActiveSince: true })
    expect(await kioskAlerts(h, admin)).toEqual([])
    // kiosk mode off: nobody is using the tablet
    await h.call('POST', 'kiosk/lock-all', { session: admin })
    h.clock.advance(60 * MIN)
    await tryUnlock(h, device.cookie, pin, '198.51.100.60')
    h.clock.advance(KIOSK_ADDRESS_ALERT_AFTER_MS)
    expect(await kioskAlerts(h, admin)).toHaveLength(1)
    await h.setKioskMode(admin, false)
    expect(await kioskAlerts(h, admin)).toEqual([])
  })
})
