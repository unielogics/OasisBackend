import { describe, expect, it } from 'vitest'
import { makeCustomer, makeVehicle } from '../domain-schema/helpers.js'
import { auditActions, events, json, useSettingsHarness } from './harness.js'

const h = useSettingsHarness()

const settingsEvents = async (section: string) =>
  (await events(h.db, 'settings')).filter((e) => e.payload.section === section)

describe('GET/PUT /vip', () => {
  it('returns the design defaults with holds, cadence options and counts', async () => {
    const s = await h.admin()
    for (const [weekday, timeMin] of [
      [6, 480],
      [6, 540],
      [5, 960],
      [0, 540],
    ] as const)
      expect((await h.post('vip/holds', s, { weekday, timeMin })).statusCode).toBe(201)
    const r = await h.get('vip', s)
    expect(r.statusCode).toBe(200)
    const b = json(r)
    expect(b).toMatchObject({
      release: 48,
      windowVip: 30,
      windowStd: 14,
      sameDay: 2,
      waitlist: true,
      offerMin: 15,
      standing: true,
      autoConfirm: true,
      cadences: ['weekly', 'biweekly', 'monthly'],
      counts: { clients: 0, holds: 4 },
    })
    expect(b.cadenceOptions).toEqual([
      { key: 'weekly', label: 'Weekly' },
      { key: 'biweekly', label: 'Every 2 weeks' },
      { key: 'triweekly', label: 'Every 3 weeks' },
      { key: 'monthly', label: 'Monthly' },
    ])
    // Monday first, then by time: Fri 4 PM, Sat 8, Sat 9, Sun 9
    expect(b.holds.map((x: { label: string }) => x.label)).toEqual([
      'Friday · 4:00 PM',
      'Saturday · 8:00 AM',
      'Saturday · 9:00 AM',
      'Sunday · 9:00 AM',
    ])
    expect(r.headers.etag).toBe(`"${b.version}"`)
  })

  it('saves partial changes with the design values, bumps the version and publishes', async () => {
    const s = await h.admin()
    const v = json(await h.get('vip', s)).version as number
    const r = await h.put('vip', s, {
      release: 72,
      windowVip: 45,
      sameDay: 0,
      waitlist: false,
      offerMin: 30,
      cadences: ['weekly', 'triweekly'],
    })
    expect(r.statusCode).toBe(200)
    expect(json(r)).toMatchObject({
      release: 72,
      windowVip: 45,
      windowStd: 14,
      sameDay: 0,
      waitlist: false,
      offerMin: 30,
      standing: true,
      cadences: ['weekly', 'triweekly'],
      changed: true,
      version: v + 1,
    })
    expect(json(await h.put('vip', s, { release: 72 })).changed).toBe(false)
    expect(await settingsEvents('vip')).toHaveLength(1)
    expect(await auditActions(h.db)).toContain('settings.vip.update')
  })

  it('rejects values outside the design choices and stale versions', async () => {
    const s = await h.admin()
    const detail = async (body: Record<string, unknown>) => json(await h.put('vip', s, body)).detail
    expect(await detail({ release: 36 })).toBe('Release holds 24, 48 or 72 hours before.')
    expect(await detail({ windowVip: 120 })).toBe('The VIP booking window is 7 to 90 days.')
    expect(await detail({ windowStd: 3 })).toBe('The standard booking window is 7 to 60 days.')
    expect(await detail({ sameDay: 9 })).toBe('Same-day guarantee is 0 to 8 per month.')
    expect(await detail({ offerMin: 20 })).toBe('The waitlist claim window is 10, 15 or 30 minutes.')
    expect((await h.put('vip', s, { cadences: ['daily'] })).statusCode).toBe(422)
    expect((await h.put('vip', s, { release: 24, version: 99 })).statusCode).toBe(412)
    expect((await h.put('vip', s, { nope: 1 })).statusCode).toBe(422)
    // off-grid windows are fine: the design's own defaults are 30 and 14
    expect((await h.put('vip', s, { windowVip: 23, windowStd: 37 })).statusCode).toBe(200)
  })

  it('reads for anyone signed in, writes need cli.member', async () => {
    const crew = await h.withPermissions([])
    expect((await h.get('vip', crew)).statusCode).toBe(200)
    expect((await h.put('vip', crew, { release: 24 })).statusCode).toBe(403)
    const support = await h.withPermissions(['cli.member'])
    expect((await h.put('vip', support, { release: 24 })).statusCode).toBe(200)
  })
})

describe('VIP holds', () => {
  it('adds with time text or minutes, answers the toast, and refuses a duplicate with the design string', async () => {
    const s = await h.admin()
    const a = await h.post('vip/holds', s, { weekday: 6, time: '11:00 AM' })
    expect(a.statusCode).toBe(201)
    expect(json(a)).toMatchObject({
      hold: { weekday: 6, day: 'Saturday', timeMin: 660, time: '11:00 AM', label: 'Saturday · 11:00 AM' },
      toast: 'Sat 11:00 AM held for VIPs',
    })
    const dup = await h.post('vip/holds', s, { weekday: 6, timeMin: 660 })
    expect(dup.statusCode).toBe(409)
    expect(json(dup)).toMatchObject({
      code: 'VIP_HOLD_EXISTS',
      title: 'That slot is already held',
      detail: 'That slot is already held',
    })
    expect(await h.db.selectFrom('vip_holds').select('id').execute()).toHaveLength(1)
    expect(await settingsEvents('vip')).toHaveLength(1)
  })

  it('validates the slot and removes by id', async () => {
    const s = await h.admin()
    expect(json(await h.post('vip/holds', s, { weekday: 6 })).detail).toBe('Pick a time like 11:00 AM.')
    expect(json(await h.post('vip/holds', s, { weekday: 6, time: 'noon' })).detail).toBe(
      'Pick a time like 11:00 AM.',
    )
    expect(json(await h.post('vip/holds', s, { weekday: 6, time: '11:15 AM' })).detail).toMatch(
      /30-minute steps/,
    )
    expect((await h.post('vip/holds', s, { weekday: 9, time: '11:00 AM' })).statusCode).toBe(422)
    const id = json(await h.post('vip/holds', s, { weekday: 1, time: '8:00 AM' })).hold.id as string
    const del = await h.del(`vip/holds/${id}`, s)
    expect(del.statusCode).toBe(200)
    expect(json(del)).toMatchObject({ id, removed: true, hold: { label: 'Monday · 8:00 AM' } })
    expect((await h.del(`vip/holds/${id}`, s)).statusCode).toBe(404)
    expect(json(await h.get('vip', s)).holds).toEqual([])
  })

  it('needs cli.member', async () => {
    const crew = await h.withPermissions(['set.hours'])
    expect((await h.post('vip/holds', crew, { weekday: 1, time: '8:00 AM' })).statusCode).toBe(403)
    expect((await h.del('vip/holds/00000000-0000-7000-8000-000000000001', crew)).statusCode).toBe(403)
  })
})

describe('VIP clients', () => {
  const names = async () =>
    json(await h.get('vip/clients', await h.admin())).items.map((c: { fullName: string }) => c.fullName)

  it('adds by customer id (201, then 200 with added false), lists and removes', async () => {
    const s = await h.admin()
    const liam = await makeCustomer(h.db, h.fx, { name: 'Liam Chen' })
    const a = await h.post('vip/clients', s, { customerId: liam })
    expect(a.statusCode).toBe(201)
    expect(json(a)).toEqual({
      customerId: liam,
      fullName: 'Liam Chen',
      added: true,
      toast: 'Liam Chen is now VIP',
    })
    const again = await h.post('vip/clients', s, { customerId: liam })
    expect(again.statusCode).toBe(200)
    expect(json(again)).toMatchObject({ added: false, toast: null })
    const list = json(await h.get('vip/clients', s))
    expect(list.count).toBe(1)
    expect(list.items[0]).toMatchObject({ customerId: liam, fullName: 'Liam Chen' })
    expect(json(await h.get('vip', s)).counts.clients).toBe(1)

    const del = await h.del(`vip/clients/${liam}`, s)
    expect(json(del)).toEqual({ customerId: liam, removed: true })
    expect((await h.del(`vip/clients/${liam}`, s)).statusCode).toBe(404)
    expect(await names()).toEqual([])
    expect(await auditActions(h.db)).toEqual(
      expect.arrayContaining(['settings.vip.client.add', 'settings.vip.client.remove']),
    )
    expect((await settingsEvents('vip')).length).toBe(2)
  })

  it('a name that matches exactly one customer is added (case-insensitive, trimmed)', async () => {
    const s = await h.admin()
    await makeCustomer(h.db, h.fx, { name: 'Aisha Rahman' })
    await makeCustomer(h.db, h.fx, { name: 'Aisha Rahim' })
    const r = await h.post('vip/clients', s, { name: '  aisha RAHMAN ' })
    expect(r.statusCode).toBe(201)
    expect(json(r)).toMatchObject({ fullName: 'Aisha Rahman', added: true, toast: 'Aisha Rahman is now VIP' })
    const dup = await h.post('vip/clients', s, { name: 'Aisha Rahman' })
    expect(dup.statusCode).toBe(200)
    expect(json(dup).added).toBe(false)
  })

  it('a name with several exact matches, or only partial ones, answers 409 with the candidates and adds nobody', async () => {
    const s = await h.admin()
    const a = await makeCustomer(h.db, h.fx, { name: 'Jordan Lee', line: '0121' })
    const b = await makeCustomer(h.db, h.fx, { name: 'Jordan Lee', line: '0122' })
    await makeVehicle(h.db, h.fx, a, { year: 2021, make: 'Audi', model: 'Q5' })
    await makeCustomer(h.db, h.fx, { name: 'Jordana Smith', line: '0123' })

    const exact = await h.post('vip/clients', s, { name: 'jordan lee' })
    expect(exact.statusCode).toBe(409)
    const body = json(exact)
    expect(body).toMatchObject({ code: 'VIP_CLIENT_AMBIGUOUS', title: 'Which client?' })
    expect(body.meta.candidates.map((c: { customerId: string }) => c.customerId).sort()).toEqual(
      [a, b].sort(),
    )
    const withCar = body.meta.candidates.find((c: { customerId: string }) => c.customerId === a)
    expect(withCar.vehicles).toEqual(['2021 Audi Q5'])
    expect(withCar.alreadyVip).toBe(false)

    const partial = await h.post('vip/clients', s, { name: 'Jordan' })
    expect(partial.statusCode).toBe(409)
    expect(json(partial).meta.candidates).toHaveLength(3)
    expect(await names()).toEqual([])

    const picked = await h.post('vip/clients', s, { customerId: b })
    expect(picked.statusCode).toBe(201)
    const again = json(await h.post('vip/clients', s, { name: 'Jordan Lee' }))
    expect(again.meta.candidates.find((c: { customerId: string }) => c.customerId === b).alreadyVip).toBe(
      true,
    )
  })

  it('shows the phone hint only to callers who hold cli.contact', async () => {
    await makeCustomer(h.db, h.fx, { name: 'Pat Kim', line: '0131' })
    await makeCustomer(h.db, h.fx, { name: 'Pat Kim', line: '0132' })
    const member = await h.withPermissions(['cli.member'])
    const plain = json(await h.post('vip/clients', member, { name: 'Pat Kim' }))
    expect(plain.meta.candidates.map((c: { phoneHint: string | null }) => c.phoneHint)).toEqual([null, null])
    const contact = await h.withPermissions(['cli.member', 'cli.contact'])
    const hinted = json(await h.post('vip/clients', contact, { name: 'Pat Kim' }))
    const hints = hinted.meta.candidates.map((c: { phoneHint: string }) => c.phoneHint).sort()
    expect(hints[0]).toMatch(/0131$/)
    expect(hints[1]).toMatch(/0132$/)
    expect(hints.join()).not.toContain('+13055550131')
  })

  it('answers 404 for an unknown name, 422 for an empty one and a deleted or unknown customer id', async () => {
    const s = await h.admin()
    const nf = await h.post('vip/clients', s, { name: 'Nobody Here' })
    expect(nf.statusCode).toBe(404)
    expect(json(nf)).toMatchObject({ code: 'VIP_CLIENT_NOT_FOUND', title: 'No such client' })
    expect(json(await h.post('vip/clients', s, {})).errors[0].path).toBe('body.name')
    expect((await h.post('vip/clients', s, { name: '   ' })).statusCode).toBe(422)
    expect(
      (await h.post('vip/clients', s, { customerId: '00000000-0000-7000-8000-000000000001' })).statusCode,
    ).toBe(404)
    const gone = await makeCustomer(h.db, h.fx, { name: 'Gone Away' })
    await h.db.updateTable('customers').set({ deleted_at: h.clock.now() }).where('id', '=', gone).execute()
    expect(json(await h.post('vip/clients', s, { customerId: gone })).detail).toBe(
      'That customer is no longer active.',
    )
  })

  it('needs cli.member', async () => {
    const crew = await h.withPermissions(['cli.view', 'cli.contact'])
    expect((await h.get('vip/clients', crew)).statusCode).toBe(403)
    expect((await h.post('vip/clients', crew, { name: 'x' })).statusCode).toBe(403)
    expect((await h.del('vip/clients/00000000-0000-7000-8000-000000000001', crew)).statusCode).toBe(403)
  })
})

describe('arrival settings', () => {
  it('returns the design defaults and an ETag', async () => {
    const s = await h.admin()
    const r = await h.get('arrival-settings', s)
    expect(json(r)).toMatchObject({
      on: true,
      radius: 300,
      prepAt: 15,
      autoArrive: true,
      welcome: true,
      crew: true,
      vipFirst: true,
    })
    expect(r.headers.etag).toBe(`"${json(r).version}"`)
  })

  it('saves partial changes, validates the choices and enforces a supplied version', async () => {
    const s = await h.admin()
    const v = json(await h.get('arrival-settings', s)).version as number
    const r = await h.put('arrival-settings', s, { radius: 500, prepAt: 20, welcome: false, on: false })
    expect(json(r)).toMatchObject({
      radius: 500,
      prepAt: 20,
      welcome: false,
      on: false,
      autoArrive: true,
      changed: true,
      version: v + 1,
    })
    expect(json(await h.put('arrival-settings', s, { radius: 500 })).changed).toBe(false)
    expect(json(await h.put('arrival-settings', s, { radius: 200 })).detail).toBe(
      'The check-in radius is 150, 300 or 500 m.',
    )
    expect(json(await h.put('arrival-settings', s, { prepAt: 5 })).detail).toBe(
      'The prep alert is 10, 15 or 20 minutes out.',
    )
    expect((await h.put('arrival-settings', s, { vipFirst: false, version: v })).statusCode).toBe(412)
    expect((await h.put('arrival-settings', s, { vipFirst: false, version: v + 1 })).statusCode).toBe(200)
    expect(await settingsEvents('arrival')).toHaveLength(2)
    expect(await auditActions(h.db)).toContain('settings.arrival.update')
  })

  it('reads for anyone signed in, writes need cli.member', async () => {
    const crew = await h.withPermissions([])
    expect((await h.get('arrival-settings', crew)).statusCode).toBe(200)
    expect((await h.put('arrival-settings', crew, { on: false })).statusCode).toBe(403)
  })
})
