// Kiosk mode end to end over HTTP (ADR 0180): registering the tablet, the shop code, every unlock outcome, the kiosk context and its
// fail-closed route list, the acting employee, expiry, what ends a kiosk session, the user session winning, short admin sessions on a
// kiosk device, and the cookies.
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hashToken } from '../../src/modules/auth/tokens.js'
import { createKioskSession } from '../../src/modules/kiosk/sessions.js'
import { ensureLocation } from '../../src/platform/locations.js'
import { useHarness, KIOSK_CODE, TEST_PASSWORD, type Harness, type KioskDevice, type KioskSession } from '../auth/harness.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>

const NIL = '00000000-0000-7000-8000-000000000000'
/** 2026-06-13 is a Saturday: the default hours close at 5:00 PM, so an unlock at 10:36 AM locks at 7:00 PM. */
const LOCKS_AT = '2026-06-13T23:00:00.000Z'

async function tryUnlock(h: Harness, cookie: string | null, code = KIOSK_CODE, ip = '10.0.0.7') {
  return h.t.app.inject({
    method: 'POST',
    url: '/api/v1/kiosk/unlock',
    headers: { origin: h.origin, ...(cookie ? { cookie } : {}) },
    remoteAddress: ip,
    payload: { code },
  })
}

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

describe('kiosk mode is off by default', () => {
  const h = useHarness()

  it('the status says off and no device; an unregistered browser never has its code checked', async () => {
    const st = await h.call('GET', 'kiosk/status')
    expect(st.statusCode).toBe(200)
    expect(st.json()).toEqual({ enabled: false, device: null, unlocked: null, lockedOut: false, retryAfterSec: 0 })
    const r = await tryUnlock(h, null)
    expect(r.statusCode).toBe(403)
    expect(r.json().code).toBe('KIOSK_DEVICE_UNKNOWN')
    expect(r.json().detail).toBe('Codes work only on the shop’s kiosk tablet.')
  })

  it('a registered device with kiosk mode off answers KIOSK_OFF; with no code KIOSK_CODE_NOT_SET; mode needs a code', async () => {
    const u = await h.createUser({ email: 'boss@example.test', roles: ['super'] })
    const admin = await h.login(u)
    const device = await h.registerDevice(admin)
    expect((await tryUnlock(h, device.cookie)).json().code).toBe('KIOSK_OFF')

    const cur = (await h.call('GET', 'kiosk', { session: admin })).json() as Json
    expect(cur.enabled).toBe(false)
    expect(cur.code).toEqual({ set: false, setAt: null, setBy: null, ageDays: null })
    const on = await h.call('PUT', 'kiosk/settings', { session: admin, body: { enabled: true, version: cur.version } })
    expect(on.statusCode).toBe(409)
    expect(on.json().code).toBe('KIOSK_CODE_NOT_SET')

    await h.setCode(admin)
    await h.setKioskMode(admin, true)
    await h.t.db.deleteFrom('kiosk_codes').execute()
    expect((await tryUnlock(h, device.cookie)).json().code).toBe('KIOSK_CODE_NOT_SET')
  })
})

describe('registering a tablet and the shop code', () => {
  const h = useHarness()

  it('"Make this a kiosk" sets an HttpOnly, Lax, 400-day device cookie and stores only its hash', async () => {
    const u = await h.createUser({ email: 'boss@example.test', roles: ['super'], first: 'Rafael', last: 'Mendes' })
    const admin = await h.login(u)
    const res = await h.call('POST', 'kiosk/devices', { session: admin, body: { name: ' Front desk tablet ' } })
    expect(res.statusCode).toBe(201)
    const body = res.json() as Json
    expect(body.signedOut).toBe(false)
    expect(body.device).toMatchObject({ name: 'Front desk tablet', state: 'locked', failedAttempts: 0, createdBy: 'Rafael M.' })
    const c = res.cookies.find((x) => x.name === 'oasis_kdev')!
    expect(c.httpOnly).toBe(true)
    expect(c.sameSite).toBe('Lax')
    expect(c.path).toBe('/')
    expect(c.maxAge).toBe(400 * 24 * 60 * 60)
    const row = await h.t.db.selectFrom('kiosk_devices').selectAll().executeTakeFirstOrThrow()
    expect(row.token_hash).toBe(hashToken(c.value))
    expect(JSON.stringify(row)).not.toContain(c.value)
    // the same browser again
    const again = await h.call('POST', 'kiosk/devices', {
      session: { cookie: `${admin.cookie}; oasis_kdev=${c.value}`, csrf: admin.csrf },
      body: { name: 'Second' },
    })
    expect(again.statusCode).toBe(409)
    expect(again.json().code).toBe('KIOSK_DEVICE_EXISTS')
    const audit = await h.t.db.selectFrom('audit_log').selectAll().where('action', '=', 'kiosk.device.register').executeTakeFirstOrThrow()
    expect(audit.kiosk_device_id).toBe(body.device.id)
  })

  it('refuses codes that break a rule with the rule as the message, and never stores the code', async () => {
    const u = await h.createUser({ email: 'boss@example.test', roles: ['super'] })
    const admin = await h.login(u)
    for (const [code, msg] of [
      ['02185739', /0218/],
      ['12345678', /in a row/],
      ['1234567', /8 digits/],
      ['20261013', /date/],
    ] as const) {
      const r = await h.call('PUT', 'kiosk/code', { session: admin, body: { code } })
      expect(r.statusCode, code).toBe(422)
      expect(r.json().code).toBe('KIOSK_CODE_REJECTED')
      expect(r.json().errors[0]).toMatchObject({ path: 'body.code' })
      expect(r.json().errors[0].message).toMatch(msg)
    }
    const ok = await h.call('PUT', 'kiosk/code', { session: admin, body: { code: KIOSK_CODE } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().code).toBeUndefined()
    const rows = await h.t.db.selectFrom('kiosk_codes').selectAll().execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.code_hash).toMatch(/^\$scrypt\$/)
    expect(JSON.stringify(rows)).not.toContain(KIOSK_CODE)
    const audits = await h.t.db.selectFrom('audit_log').select(['action', 'after']).where('action', '=', 'kiosk.code.set').execute()
    expect(audits).toHaveLength(1)
    expect(JSON.stringify(audits)).not.toContain(KIOSK_CODE)
  })

  it('refuses the last 3 codes, generates a code shown once, and both fields at once are refused', async () => {
    const u = await h.createUser({ email: 'boss@example.test', roles: ['super'] })
    const admin = await h.login(u)
    const codes = ['58203917', '47391028', '63918274', '70264819']
    for (const c of codes) await h.setCode(admin, c)
    // 58203917 is now the 4th newest: allowed again; 47391028 is among the last 3
    const reused = await h.call('PUT', 'kiosk/code', { session: admin, body: { code: '47391028' } })
    expect(reused.statusCode).toBe(422)
    expect(reused.json().errors[0].message).toMatch(/used recently/)
    expect((await h.call('PUT', 'kiosk/code', { session: admin, body: { code: '58203917' } })).statusCode).toBe(200)

    const gen = await h.call('PUT', 'kiosk/code', { session: admin, body: { generate: true } })
    expect(gen.statusCode).toBe(200)
    expect(gen.json().code).toMatch(/^\d{8}$/)
    expect(gen.json().code.startsWith('0218')).toBe(false)
    const both = await h.call('PUT', 'kiosk/code', { session: admin, body: { generate: true, code: '58203917' } })
    expect(both.statusCode).toBe(422)
    const current = await h.t.db.selectFrom('kiosk_codes').selectAll().where('retired_at', 'is', null).execute()
    expect(current).toHaveLength(1)
  })
})

describe('unlocking', () => {
  const h = useHarness()

  it('opens a kiosk session until closing + 2 hours, with HttpOnly cookies and the picker list', async () => {
    const { device, kiosk } = await h.kioskSetup()
    const me = kiosk.res.json() as Json
    expect(me).toMatchObject({
      kind: 'kiosk',
      device: { id: device.id, name: 'Front desk tablet' },
      lock: { locksAt: LOCKS_AT, locksAtLabel: '7:00 PM', rule: 'closing', unlockedAt: '2026-06-13T14:36:00.000Z' },
      limits: {},
      businessTz: 'America/New_York',
    })
    expect(Object.entries(me.permissions as Record<string, { on: boolean }>).filter(([, v]) => v.on).map(([k]) => k).sort()).toEqual(
      ['cli.contact', 'cli.view', 'jobs.checklist', 'jobs.status', 'msg.send', 'pay.collect', 'sched.edit', 'sched.view'],
    )
    const set = kiosk.res.cookies
    const ksid = set.find((c) => c.name === 'oasis_ksid')!
    expect(ksid.httpOnly).toBe(true)
    expect(ksid.sameSite).toBe('Lax')
    expect(ksid.maxAge).toBe((Date.parse(LOCKS_AT) - Date.parse('2026-06-13T14:36:00Z')) / 1000)
    const kdev = set.find((c) => c.name === 'oasis_kdev')!
    expect(kdev.value).toBe(device.token) // set again, 400 days
    expect(kdev.maxAge).toBe(400 * 24 * 60 * 60)

    const st = (await h.call('GET', 'kiosk/status', { session: { cookie: kiosk.cookie, csrf: '' } })).json()
    expect(st).toEqual({
      enabled: true,
      device: { name: 'Front desk tablet' },
      unlocked: { locksAt: LOCKS_AT, locksAtLabel: '7:00 PM' },
      lockedOut: false,
      retryAfterSec: 0,
    })
    const row = await h.t.db.selectFrom('kiosk_sessions').selectAll().executeTakeFirstOrThrow()
    expect(row.id).toBe(hashToken(kiosk.token))
    expect(row.lock_rule).toBe('closing')
    const a = await h.t.db.selectFrom('audit_log').selectAll().where('action', '=', 'kiosk.unlock').executeTakeFirstOrThrow()
    expect(a).toMatchObject({ kiosk_device_id: device.id, actor_user_id: null, actor_roles: 'Kiosk', actor_name: 'Kiosk · Front desk tablet' })
  })

  it('wrong codes: 3 free, then a doubling wait during which even the right code is not checked', async () => {
    const { admin, device } = await h.kioskSetup()
    await h.call('POST', 'kiosk/lock-all', { session: admin })
    for (let i = 1; i <= 3; i++) {
      const r = await tryUnlock(h, device.cookie, '11112229')
      expect(r.statusCode).toBe(401)
      expect(r.json()).toMatchObject({ code: 'KIOSK_CODE_WRONG', detail: 'That code didn’t work.', meta: { retryAfterSec: 0 } })
    }
    const fourth = await tryUnlock(h, device.cookie, '11112229')
    expect(fourth.json().meta).toEqual({ retryAfterSec: 2 })
    const held = await tryUnlock(h, device.cookie)
    expect(held.statusCode).toBe(429)
    expect(held.json().code).toBe('KIOSK_THROTTLED')
    expect(held.headers['retry-after']).toBe('2')
    expect((await h.t.db.selectFrom('kiosk_devices').select('failed_attempts').executeTakeFirstOrThrow()).failed_attempts).toBe(4)
    h.clock.advance(2000)
    const ok = await tryUnlock(h, device.cookie)
    expect(ok.statusCode).toBe(200)
    const d = await h.t.db.selectFrom('kiosk_devices').selectAll().executeTakeFirstOrThrow()
    expect({ n: d.failed_attempts, last: d.last_failed_at }).toEqual({ n: 0, last: null })
    const failed = await h.t.db.selectFrom('audit_log').selectAll().where('action', '=', 'kiosk.unlock.failed').execute()
    expect(failed).toHaveLength(4)
    expect(JSON.stringify(failed)).not.toContain('11112229')
  })

  it('20 wrong codes lock the device out until a manager clears it; the status says so', async () => {
    const { admin, device } = await h.kioskSetup()
    await h.t.db.updateTable('kiosk_devices').set({ failed_attempts: 19, last_failed_at: new Date('2026-06-13T13:00:00Z') }).execute()
    const r = await tryUnlock(h, device.cookie, '11112229')
    expect(r.statusCode).toBe(423)
    expect(r.json().code).toBe('KIOSK_LOCKED_OUT')
    expect((await tryUnlock(h, device.cookie)).statusCode).toBe(423) // the right code too
    const st = (await h.call('GET', 'kiosk/status', { session: { cookie: device.cookie, csrf: '' } })).json()
    expect(st.lockedOut).toBe(true)
    const ov = (await h.call('GET', 'kiosk', { session: admin })).json() as Json
    expect(ov.devices[0].state).toBe('locked_out')
    const cleared = await h.call('POST', `kiosk/devices/${device.id}/clear-lockout`, { session: admin })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json()).toMatchObject({ failedAttempts: 0 })
    expect((await tryUnlock(h, device.cookie)).statusCode).toBe(200)
    const actions = (await h.t.db.selectFrom('audit_log').select('action').where('action', 'like', 'kiosk.device.lockout%').execute()).map(
      (x) => x.action,
    )
    expect(actions.sort()).toEqual(['kiosk.device.lockout', 'kiosk.device.lockout.clear'])
  })

  it('an address that keeps failing on several devices is slowed too', async () => {
    const { admin } = await h.kioskSetup()
    const devices: KioskDevice[] = []
    await h.setKioskMode(admin, false)
    for (let i = 0; i < 4; i++) devices.push(await h.registerDevice(admin, `Tablet ${i}`))
    await h.setKioskMode(admin, true)
    let n = 0
    for (const d of devices) for (let i = 0; i < 3; i++, n++) await tryUnlock(h, d.cookie, '11112229', '10.66.0.1')
    expect(n).toBe(12) // 12 failures from one address, no device over its 3 free ones
    const held = await tryUnlock(h, devices[0]!.cookie, KIOSK_CODE, '10.66.0.1')
    expect(held.statusCode).toBe(429)
    expect((await tryUnlock(h, devices[0]!.cookie, KIOSK_CODE, '10.66.0.2')).statusCode).toBe(200)
  })

  it('a revoked device is unknown; a new unlock ends the previous kiosk session of the device', async () => {
    const { admin, device, kiosk } = await h.kioskSetup()
    const second = await h.unlock(device)
    expect((await h.kioskCall('GET', 'kiosk/me', kiosk)).statusCode).toBe(401)
    expect((await h.kioskCall('GET', 'kiosk/me', second)).statusCode).toBe(200)
    const prev = await h.t.db.selectFrom('kiosk_sessions').selectAll().where('id', '=', hashToken(kiosk.token)).executeTakeFirstOrThrow()
    expect(prev.revoked_reason).toBe('unlock_again')
    expect((await h.call('DELETE', `kiosk/devices/${device.id}`, { session: admin })).statusCode).toBe(204)
    expect((await h.kioskCall('GET', 'kiosk/me', second)).statusCode).toBe(401)
    expect((await tryUnlock(h, device.cookie)).json().code).toBe('KIOSK_DEVICE_UNKNOWN')
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

  it('a code change, lock all, locking the device and kiosk mode off', async () => {
    const { admin, device, kiosk } = await h.kioskSetup()
    await h.setCode(admin, '47391028')
    expect(await gone(kiosk)).toBe(true)
    expect(await reason(kiosk)).toBe('code_changed')
    expect((await tryUnlock(h, device.cookie)).statusCode).toBe(401) // the old code is gone

    const k2 = await h.unlock(device, '47391028')
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
    expect(actions).toEqual(expect.arrayContaining(['kiosk.code.set', 'kiosk.lock_all', 'kiosk.device.lock', 'kiosk.mode.on', 'kiosk.mode.off']))
  })

  it('kiosk mode off alone makes a live session invalid', async () => {
    const { kiosk } = await h.kioskSetup()
    await h.t.db.updateTable('settings').set({ value: JSON.stringify(false) }).where('key', '=', 'kiosk.enabled').execute()
    expect(await gone(kiosk)).toBe(true)
  })

  it('the session only works with the cookie of its own device', async () => {
    const { admin, kiosk } = await h.kioskSetup()
    await h.setKioskMode(admin, false)
    const other = await h.registerDevice(admin, 'Back office')
    await h.setKioskMode(admin, true)
    const swapped = { cookie: `${other.cookie}; oasis_ksid=${kiosk.token}`, csrf: kiosk.csrf }
    expect((await h.kioskCall('GET', 'kiosk/me', swapped)).statusCode).toBe(401)
    expect((await h.kioskCall('GET', 'kiosk/me', { cookie: `oasis_ksid=${kiosk.token}`, csrf: kiosk.csrf })).statusCode).toBe(401)
  })
})

describe('changes at the same moment', () => {
  const h = useHarness()

  it('several code changes at once all succeed, one after the other, and leave exactly one current code', async () => {
    const { admin, kiosk } = await h.kioskSetup()
    const codes = ['59308847', '61827394', '73946281', '82039475', '90384712', '39475862']
    const res = await Promise.all(codes.map((code) => h.call('PUT', 'kiosk/code', { session: admin, body: { code } })))
    expect(res.map((r) => r.statusCode)).toEqual(codes.map(() => 200))
    const rows = await h.t.db.selectFrom('kiosk_codes').select(['retired_at']).where('location_id', '=', h.t.location.id).execute()
    expect(rows).toHaveLength(codes.length + 1)
    expect(rows.filter((r) => r.retired_at === null)).toHaveLength(1)
    expect((await h.kioskCall('GET', 'kiosk/me', kiosk)).statusCode).toBe(401)
  })

  it('Lock all waits for an unlock in progress and ends the session it opens', async () => {
    const { admin, device, kiosk } = await h.kioskSetup()
    const code = await h.t.db
      .selectFrom('kiosk_codes')
      .select('id')
      .where('location_id', '=', h.t.location.id)
      .where('retired_at', 'is', null)
      .executeTakeFirstOrThrow()
    let lockAll: Promise<Awaited<ReturnType<Harness['call']>>> | undefined
    // an unlock in progress: it holds the device row and opens its session, then commits after Lock all started
    const opened = await h.t.db.transaction().execute(async (tx) => {
      await tx.selectFrom('kiosk_devices').select('id').where('id', '=', device.id).forUpdate().executeTakeFirstOrThrow()
      const s = await createKioskSession(tx, h.clock, {
        deviceId: device.id,
        locationId: h.t.location.id,
        codeId: code.id,
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

  it('unlocking signs out a user session on the device and clears its cookie', async () => {
    const { device, adminUser } = await h.kioskSetup()
    const s = await h.login(adminUser)
    const res = await tryUnlock(h, `${device.cookie}; ${s.cookie}`)
    expect(res.statusCode).toBe(200)
    expect(res.cookies.find((c) => c.name === 'oasis_sid')?.value).toBe('')
    expect((await h.call('GET', 'me', { session: s })).statusCode).toBe(401)
    const a = await h.t.db.selectFrom('audit_log').selectAll().where('action', '=', 'kiosk.unlock').orderBy('id', 'desc').executeTakeFirstOrThrow()
    expect(a.after).toMatchObject({ userSignedOut: true })
  })

  it('a manager signing in on a kiosk device gets 15 minutes idle and 4 hours at most, and GET /me names the device', async () => {
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
    expect(me.kioskDevice).toEqual({ id: device.id, name: 'Front desk tablet' })
    expect(me.session.expiresAt).toBe('2026-06-13T18:36:00.000Z')
    const row = await h.t.db.selectFrom('sessions').selectAll().where('id', '=', hashToken(c.value)).executeTakeFirstOrThrow()
    expect(row.kiosk_device_id).toBe(device.id)
    h.clock.advance(14 * 60_000)
    expect((await h.call('GET', 'me', { session: s })).statusCode).toBe(200) // slides 15 more minutes
    h.clock.advance(14 * 60_000)
    expect((await h.call('GET', 'me', { session: s })).statusCode).toBe(200)
    h.clock.advance(16 * 60_000)
    expect((await h.call('GET', 'me', { session: s })).statusCode).toBe(401)

    const normal = await h.login(adminUser)
    expect(((await h.call('GET', 'me', { session: normal })).json() as Json).kioskDevice).toBeNull()
  })

  it('registering a device while kiosk mode is on signs the manager out', async () => {
    const { admin } = await h.kioskSetup()
    const res = await h.call('POST', 'kiosk/devices', { session: admin, body: { name: 'Bay tablet' } })
    expect(res.statusCode).toBe(201)
    expect(res.json().signedOut).toBe(true)
    expect(res.cookies.find((c) => c.name === 'oasis_sid')?.value).toBe('')
    expect((await h.call('GET', 'me', { session: admin })).statusCode).toBe(401)
  })
})

describe('K4 review: a manager on the tablet never keeps a long session (kiosk:F1, kiosk:F2)', () => {
  const h = useHarness()
  const NOW_PLUS_4H = '2026-06-13T18:36:00.000Z'
  const deviceCookieOf = (res: { cookies: { name: string; value: string }[] }) => res.cookies.find((c) => c.name === 'oasis_kdev')!.value
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

  it('the documented order (sign in on the tablet, Make this a kiosk, then kiosk mode on) ends on the keypad', async () => {
    const u = await h.createUser({ email: 'boss@example.test', roles: ['super'], first: 'Rafael', last: 'Mendes' })
    const s = await h.login(u) // a normal 14-day session, opened before the tablet is a kiosk
    await h.setCode(s)
    const reg = await h.call('POST', 'kiosk/devices', { session: s, body: { name: 'Front desk tablet' } })
    expect(reg.statusCode).toBe(201)
    expect(reg.json().signedOut).toBe(false) // kiosk mode is still off
    const tablet = { cookie: `${s.cookie}; oasis_kdev=${deviceCookieOf(reg)}`, csrf: s.csrf }
    // the next request comes with the device cookie: the session is tied to the device, with the short timings and the banner
    const me = (await h.call('GET', 'me', { session: tablet })).json() as Json
    expect(me.kioskDevice).toEqual({ id: reg.json().device.id, name: 'Front desk tablet' })
    expect(me.session.expiresAt).toBe(NOW_PLUS_4H)
    const row = await h.t.db.selectFrom('sessions').selectAll().where('id', '=', hashToken(s.token)).executeTakeFirstOrThrow()
    expect(row.kiosk_device_id).toBe(reg.json().device.id)
    expect(row.absolute_expires_at.toISOString()).toBe(NOW_PLUS_4H)
    expect(row.idle_expires_at.toISOString()).toBe('2026-06-13T14:51:00.000Z')
    // kiosk mode on, from the tablet: the manager is signed out there and the tablet shows the keypad
    const version = ((await h.call('GET', 'kiosk', { session: tablet })).json() as Json).version
    const on = await h.call('PUT', 'kiosk/settings', { session: tablet, body: { enabled: true, version } })
    expect(on.statusCode).toBe(200)
    expect(on.json()).toEqual({ enabled: true, version: expect.any(Number), signedOut: true })
    expect(on.cookies.find((c) => c.name === 'oasis_sid')?.value).toBe('')
    expect(await alive(tablet)).toBe(false)
    const status = await h.t.app.inject({ method: 'GET', url: '/api/v1/kiosk/status', headers: { cookie: `oasis_kdev=${deviceCookieOf(reg)}` } })
    expect(status.json()).toMatchObject({ enabled: true, device: { name: 'Front desk tablet' }, unlocked: null })
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

  it('Lock all, locking the device, kiosk mode off and Remove device each sign out a manager on the tablet', async () => {
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

describe('K4 review: the last-3-codes rule holds for changes at the same moment (kiosk:KK-R1)', () => {
  const h = useHarness()

  it('two managers setting the same new code at once: one is accepted, the other refused as used recently', async () => {
    const u = await h.createUser({ email: 'boss@example.test', roles: ['super'] })
    const admin = await h.login(u)
    for (const code of ['59308847', '61827394', '73946281', '82039475', '90384712']) {
      const res = await Promise.all([1, 2].map(() => h.call('PUT', 'kiosk/code', { session: admin, body: { code } })))
      expect(res.map((r) => r.statusCode).sort(), code).toEqual([200, 422])
      expect(res.find((r) => r.statusCode === 422)!.json().errors[0].message).toMatch(/used recently/)
    }
  })
})

describe('the manager’s controls', () => {
  const h = useHarness()

  it('GET /kiosk shows mode, code age, devices, who shows on the kiosk and recent events; rename, list, revoke', async () => {
    const { admin, device } = await h.kioskSetup()
    const zed = await employee(h, { first: 'Zed', last: 'Invited' })
    await h.t.db.updateTable('kiosk_codes').set({ created_at: new Date('2026-06-10T09:00:00-04:00') }).execute()
    const ov = (await h.call('GET', 'kiosk', { session: admin })).json() as Json
    expect(ov).toMatchObject({ enabled: true, thisDeviceId: null, code: { set: true, setBy: 'Rafael M.', ageDays: 3 } })
    expect(ov.devices).toEqual([expect.objectContaining({ id: device.id, name: 'Front desk tablet', state: 'unlocked' })])
    expect(ov.staff).toEqual(expect.arrayContaining([{ id: zed, name: 'Zed I.', status: 'invited', listed: true }]))
    expect((ov.recent as Json[]).map((r) => r.action)).toEqual(expect.arrayContaining(['kiosk.unlock', 'kiosk.code.set']))
    expect((ov.recent as Json[]).find((r) => r.action === 'kiosk.unlock')).toMatchObject({ label: 'Unlocked', deviceName: 'Front desk tablet' })

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
  })

  it('the activity report answers the manager (test/kiosk/report.test.ts has the counts)', async () => {
    const { admin } = await h.kioskSetup()
    const r = await h.call('GET', 'reports/employee-activity?from=2026-06-01&to=2026-06-13', { session: admin })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ from: '2026-06-01', to: '2026-06-13', amounts: true })
    const e = await h.call('GET', `reports/employee-activity/${NIL}/events?from=2026-06-01&to=2026-06-13`, { session: admin })
    expect(e.statusCode).toBe(404)
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

describe('rate limits are per device', () => {
  const h = useHarness({ env: { RATE_LIMIT_PER_MIN: '12' } })

  it('one tablet is one caller, whatever the address; another tablet has its own budget', async () => {
    const u = await h.createUser({ email: 'boss@example.test', roles: ['super'] })
    const admin = await h.login(u)
    await h.setCode(admin)
    const one = await h.registerDevice(admin, 'First tablet')
    const two = await h.registerDevice(admin, 'Second tablet')
    await h.setKioskMode(admin, true)
    const k1 = await h.unlock(one)
    const k2 = await h.unlock(two)
    const codes: number[] = []
    for (let i = 0; i < 14; i++) codes.push((await h.kioskCall('GET', 'kiosk/staff', k1, { ip: `10.77.0.${i + 1}` })).statusCode)
    expect(codes.slice(0, 12).every((c) => c === 200)).toBe(true)
    expect(codes.slice(12)).toEqual([429, 429])
    expect((await h.kioskCall('GET', 'kiosk/staff', k2, { ip: '10.77.0.1' })).statusCode).toBe(200)
  })
})
