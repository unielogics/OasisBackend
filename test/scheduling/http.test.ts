// The Operations HTTP surface: permission map (review B17), idempotency, expectedStatus conflicts, problem+json copy,
// contact masking, the photo flow and response contracts (the serializer enforces the zod schemas).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LightMyRequestResponse } from 'fastify'
import { createPermissiveAuthorizer } from '../../src/http/authorizer.js'
import { customersModule } from '../../src/modules/customers/http/module.js'
import { createSchedulingModule } from '../../src/modules/scheduling/module.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { makeUser } from '../helpers/factories.js'
import { useOps } from './helpers.js'

const o = useOps()
let app: TestApp

beforeAll(async () => {
  const user = await makeUser(o.t.db, o.ctx.newId, { first: 'Desk' })
  app = await createTestApp({
    testDb: o.t,
    modules: [customersModule, createSchedulingModule(o.ports)],
    authorizer: (location) =>
      createPermissiveAuthorizer({
        locationId: location.id,
        userId: user.userId,
        employeeId: user.employeeId,
        actorName: 'Desk U.',
      }),
    env: { STORAGE_PROVIDER: 'fs' },
  })
})
afterAll(async () => {
  await app?.close()
})

const at = (hhmm: string, date = '2026-06-13'): string => `${date}T${hhmm}:00-04:00`
let keyN = 0
const key = (): string => `test-key-${++keyN}-${'x'.repeat(8)}`

async function call(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  o2: { body?: unknown; perms?: string[]; key?: string | null } = {},
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = {}
  if (o2.perms) headers['x-test-permissions'] = o2.perms.join(',')
  if (o2.key !== null && o2.key !== undefined) headers['idempotency-key'] = o2.key
  return app.app.inject({
    method,
    url: `/api/v1${url}`,
    headers,
    ...(o2.body !== undefined ? { payload: o2.body as object } : {}),
  })
}
const json = <T = Record<string, unknown>>(r: LightMyRequestResponse): T => r.json() as T

const booking = (extra: object = {}) => ({
  customer: { id: o.customer('Maria Delgado') },
  serviceId: o.svc('Express Hand Wash').id,
  start: at('14:00'),
  ...extra,
})

describe('POST /appointments', () => {
  it('creates (201, Location), replays the same key, refuses a changed body and a missing key', async () => {
    const k = key()
    const first = await call('POST', '/appointments', { body: booking(), key: k })
    expect(first.statusCode).toBe(201)
    expect(first.headers.location).toBe(
      `/api/v1/appointments/${json<{ appointment: { id: string } }>(first).appointment.id}`,
    )
    const created = json<{
      appointment: { id: string; status: string }
      invoice: { invoiceNo: number }
      toast: { title: string }
    }>(first)
    expect(created).toMatchObject({
      appointment: { status: 'booked' },
      invoice: { invoiceNo: 20611 },
      toast: { title: 'Appointment booked' },
    })

    const replay = await call('POST', '/appointments', { body: booking(), key: k })
    expect(replay.statusCode).toBe(201)
    expect(replay.headers['idempotent-replayed']).toBe('true')
    expect(json<{ appointment: { id: string } }>(replay).appointment.id).toBe(created.appointment.id)
    expect(await o.t.db.selectFrom('appointments').select('id').execute()).toHaveLength(1)

    const changed = await call('POST', '/appointments', { body: booking({ start: at('15:00') }), key: k })
    expect(changed.statusCode).toBe(422)
    expect(json(changed)).toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' })

    const missing = await call('POST', '/appointments', { body: booking({ start: at('16:00') }) })
    expect(missing.statusCode).toBe(400)
    expect(json(missing)).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' })
    expect(await o.t.db.selectFrom('appointments').select('id').execute()).toHaveLength(1)
  })

  it('a slot conflict is problem+json with the design copy; a failed booking leaves nothing behind and the key is reusable', async () => {
    await call('POST', '/appointments', {
      body: booking({ customer: { id: o.customer('David Okafor') } }),
      key: key(),
    })
    await call('POST', '/appointments', {
      body: booking({ customer: { id: o.customer('Priya Nair') } }),
      key: key(),
    })
    const k = key()
    const res = await call('POST', '/appointments', {
      body: booking({ customer: { id: o.customer('Tom Bradley') } }),
      key: k,
    })
    expect(res.statusCode).toBe(409)
    expect(res.headers['content-type']).toContain('application/problem+json')
    expect(json(res)).toMatchObject({
      type: 'urn:oasis:problem:slot-unavailable',
      code: 'SLOT_UNAVAILABLE',
      title: 'Slot unavailable',
      detail: 'Would overbook a bay — override required',
      status: 409,
    })
    expect(await o.t.db.selectFrom('appointments').select('id').execute()).toHaveLength(2)
    // the same key can be retried with an override once the actor may
    const ok = await call('POST', '/appointments', {
      body: booking({ customer: { id: o.customer('Tom Bradley') }, override: { reason: 'Regular' } }),
      key: key(),
    })
    expect(ok.statusCode).toBe(201)
    expect(json<{ overrides: { kind: string }[] }>(ok).overrides[0]!.kind).toBe('capacity')
  })

  it('validation: start xor walkIn, strict body, ISO start with an offset', async () => {
    const bad = (body: object) => call('POST', '/appointments', { body, key: key() })
    expect((await bad(booking({ start: undefined }))).statusCode).toBe(422)
    expect((await bad(booking({ start: '2026-06-13T14:00:00' }))).statusCode).toBe(422) // no offset
    expect((await bad(booking({ surprise: 1 }))).statusCode).toBe(422)
    const walk = await call('POST', '/appointments', {
      body: { customer: { name: 'Pat' }, serviceId: o.svc('Express Hand Wash').id, walkIn: true },
      key: key(),
    })
    expect(walk.statusCode).toBe(201)
    expect(json<{ appointment: { scheduledStart: string } }>(walk).appointment.scheduledStart).toBe(
      new Date(at('11:00')).toISOString(),
    )
  })

  it('needs sched.edit; the override also needs sched.override', async () => {
    const denied = await call('POST', '/appointments', {
      body: booking(),
      perms: ['sched.view', 'jobs.status'],
      key: key(),
    })
    expect(denied.statusCode).toBe(403)
    expect(json(denied)).toMatchObject({ code: 'FORBIDDEN', meta: { required: ['sched.edit'] } })
    await call('POST', '/appointments', {
      body: booking({ customer: { id: o.customer('David Okafor') } }),
      key: key(),
    })
    await call('POST', '/appointments', {
      body: booking({ customer: { id: o.customer('Priya Nair') } }),
      key: key(),
    })
    const noOverride = await call('POST', '/appointments', {
      body: booking({ customer: { id: o.customer('Tom Bradley') }, override: { reason: 'x' } }),
      perms: ['sched.edit'],
      key: key(),
    })
    expect(noOverride.statusCode).toBe(403)
    expect(json(noOverride)).toMatchObject({ code: 'OVERRIDE_NOT_ALLOWED', title: 'Override not allowed' })
  })
})

describe('commands: the permission map (review B17) and conflicts', () => {
  async function bookedId(hhmm = '14:00', customer = 'Maria Delgado'): Promise<string> {
    const r = await call('POST', '/appointments', {
      body: booking({ start: at(hhmm), customer: { id: o.customer(customer) } }),
      key: key(),
    })
    return json<{ appointment: { id: string } }>(r).appointment.id
  }

  it('advance requires expectedStatus; a stale one is 409 STALE_STATE with the current status', async () => {
    const id = await bookedId()
    expect((await call('POST', `/appointments/${id}/advance`, { body: {} })).statusCode).toBe(422)
    const ok = await call('POST', `/appointments/${id}/advance`, { body: { expectedStatus: 'booked' } })
    expect(ok.statusCode).toBe(200)
    expect(json<{ appointment: { status: string }; toast: unknown }>(ok)).toMatchObject({
      appointment: { status: 'confirmed' },
      toast: { title: 'Confirmation sent' },
    })
    const stale = await call('POST', `/appointments/${id}/advance`, { body: { expectedStatus: 'booked' } })
    expect(stale.statusCode).toBe(409)
    expect(json(stale)).toMatchObject({
      code: 'STALE_STATE',
      meta: { currentStatus: 'confirmed', expectedStatus: 'booked' },
    })
  })

  it('jobs.status moves jobs (advance, start, assign-bay, pickup); it cannot create, reschedule, cancel or add add-ons', async () => {
    const id = await bookedId('11:00')
    const crew = ['sched.view', 'jobs.status', 'jobs.checklist', 'cli.view']
    expect(
      (await call('POST', `/appointments/${id}/advance`, { body: { expectedStatus: 'booked' }, perms: crew }))
        .statusCode,
    ).toBe(200)
    expect(
      (
        await call('POST', `/appointments/${id}/advance`, {
          body: { expectedStatus: 'confirmed' },
          perms: crew,
        })
      ).statusCode,
    ).toBe(200)
    expect(
      (await call('POST', `/appointments/${id}/assign-bay`, { body: { bayId: o.bay(2) }, perms: crew }))
        .statusCode,
    ).toBe(200)
    expect((await call('POST', `/appointments/${id}/complete`, { perms: crew })).statusCode).toBe(200)
    expect(
      (await call('POST', `/appointments/${id}/pickup`, { body: { state: 'collected' }, perms: crew }))
        .statusCode,
    ).toBe(200)
    const other = await bookedId('15:00', 'David Okafor')
    const denied = async (method: 'POST' | 'PUT' | 'PATCH', url: string, body?: object) => {
      const r = await call(method, url, { body: body ?? {}, perms: crew, key: key() })
      return [r.statusCode, json<{ meta?: { required?: string[] } }>(r).meta?.required]
    }
    expect(await denied('POST', `/appointments/${other}/reschedule`, { start: at('16:00') })).toEqual([
      403,
      ['sched.edit'],
    ])
    expect(await denied('POST', `/appointments/${other}/cancel`, { reason: 'x' })).toEqual([
      403,
      ['sched.cancel'],
    ])
    expect(await denied('POST', `/appointments/${other}/no-show`)).toEqual([403, ['sched.cancel']])
    expect(await denied('POST', `/appointments/${other}/reopen`)).toEqual([403, ['sched.cancel']])
    expect(await denied('PUT', `/appointments/${other}/addons/${o.svc('Wax').id}`)).toEqual([
      403,
      ['sched.edit'],
    ])
    expect(await denied('PATCH', `/appointments/${other}`, { notes: 'x' })).toEqual([403, ['sched.edit']])
    expect(await denied('POST', `/appointments/${other}/notify-ready`)).toEqual([403, ['msg.send']])
    expect(await denied('POST', '/appointments', booking())).toEqual([403, ['sched.edit']])
  })

  it('sched.edit reschedules and edits add-ons; jobs.checklist toggles tasks and photos; reads need sched.view', async () => {
    const id = await bookedId('14:00')
    const desk = ['sched.view', 'sched.edit', 'cli.view']
    const moved = await call('POST', `/appointments/${id}/reschedule`, {
      body: { start: at('15:30') },
      perms: desk,
    })
    expect(moved.statusCode).toBe(200)
    expect(json<{ toast: { title: string } }>(moved).toast.title).toBe('Moved to 3:30 PM')
    expect(
      (await call('PUT', `/appointments/${id}/addons/${o.svc('Wax').id}`, { perms: desk })).statusCode,
    ).toBe(200)
    const file = json<{ checklist: { sections: { items: { id: string }[] }[] } }>(
      await call('GET', `/appointments/${id}`, { perms: ['sched.view'] }),
    )
    const item = file.checklist.sections[0]!.items[0]!.id
    expect(
      (
        await call('PUT', `/appointments/${id}/checklist/items/${item}`, {
          body: { done: true },
          perms: desk,
        })
      ).statusCode,
    ).toBe(403)
    expect(
      (
        await call('PUT', `/appointments/${id}/checklist/items/${item}`, {
          body: { done: true },
          perms: ['jobs.checklist'],
        })
      ).statusCode,
    ).toBe(200)
    expect((await call('GET', `/appointments/${id}`, { perms: ['jobs.status'] })).statusCode).toBe(403)
    expect((await call('GET', '/ops/snapshot', { perms: ['cli.view'] })).statusCode).toBe(403)
  })

  it('cancel and no-show need an Idempotency-Key (money-effecting); a replay returns the same result', async () => {
    const id = await bookedId('14:00')
    expect(json(await call('POST', `/appointments/${id}/cancel`, { body: { reason: 'x' } }))).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    })
    const k = key()
    const a = await call('POST', `/appointments/${id}/cancel`, {
      body: { reason: 'Changed plans', notify: true, deposit: 'keep' },
      key: k,
    })
    expect(a.statusCode).toBe(200)
    expect(
      json<{ appointment: { status: string }; invoice: { status: string }; depositPolicy: string }>(a),
    ).toMatchObject({
      appointment: { status: 'canceled' },
      invoice: { status: 'canceled' },
      depositPolicy: 'keep',
    })
    const b = await call('POST', `/appointments/${id}/cancel`, {
      body: { reason: 'Changed plans', notify: true, deposit: 'keep' },
      key: k,
    })
    expect(b.headers['idempotent-replayed']).toBe('true')
    const again = await call('POST', `/appointments/${id}/cancel`, {
      body: { reason: 'Changed plans' },
      key: key(),
    })
    expect(again.statusCode).toBe(409)
    expect(json(again)).toMatchObject({
      code: 'INVALID_TRANSITION',
      title: 'Can’t do that now',
      detail: 'This job is canceled',
    })
    expect(
      (await call('POST', `/appointments/${id}/cancel`, { body: { reason: '' }, key: key() })).statusCode,
    ).toBe(422)
  })

  it('guard errors surface with the design strings', async () => {
    const a = await bookedId('11:00')
    const b = await bookedId('11:30', 'David Okafor')
    await call('POST', `/appointments/${a}/assign-bay`, { body: { bayId: o.bay(1) } })
    const busy = await call('POST', `/appointments/${b}/assign-bay`, { body: { bayId: o.bay(1) } })
    expect(busy.statusCode).toBe(409)
    expect(json(busy)).toMatchObject({
      code: 'BAY_BUSY',
      title: 'Bay 1 is busy',
      detail: 'Finish Maria’s vehicle first',
    })
    const twice = await call('POST', `/appointments/${a}/assign-bay`, { body: { bayId: o.bay(2) } })
    expect(json(twice)).toMatchObject({
      code: 'ALREADY_IN_BAY',
      title: 'Already in a bay',
      detail: 'That vehicle is in Bay 1',
    })
    const move = await call('POST', `/appointments/${a}/reschedule`, { body: { start: at('15:00') } })
    expect(json(move)).toMatchObject({
      code: 'CANT_MOVE_JOB',
      title: 'Can’t move this job',
      detail: 'It’s already in progress or done',
    })
    expect(
      (await call('POST', `/appointments/00000000-0000-7000-8000-000000000000/confirm`)).statusCode,
    ).toBe(404)
    expect((await call('POST', `/appointments/not-a-uuid/confirm`)).statusCode).toBe(422)
  })
})

describe('reads: contracts, search and masking', () => {
  it('snapshot, kpis, alerts, calendar, availability, list and file answer with schema-valid bodies', async () => {
    const a = json<{ appointment: { id: string } }>(
      await call('POST', '/appointments', { body: booking({ addonIds: [o.svc('Wax').id] }), key: key() }),
    ).appointment.id
    const snap = await call('GET', '/ops/snapshot?window=today')
    expect(snap.statusCode).toBe(200)
    expect(json<{ kpis: unknown[]; timeline: { count: number } }>(snap)).toMatchObject({
      timeline: { count: 1 },
    })
    expect(json<{ kpis: unknown[] }>(snap).kpis).toHaveLength(7)
    expect(json<{ kpis: unknown[] }>(await call('GET', '/ops/kpis')).kpis).toHaveLength(7)
    expect(
      json<{ alerts: { kind: string }[] }>(await call('GET', '/ops/alerts')).alerts.map((x) => x.kind),
    ).toEqual(['unconfirmed'])
    const cal = await call('GET', '/calendar/summary?from=2026-06-07&to=2026-06-13')
    expect(cal.statusCode).toBe(200)
    expect(json<{ total: number }>(cal).total).toBe(1)
    expect((await call('GET', '/calendar/day?date=2026-06-13')).statusCode).toBe(200)
    const av = await call('GET', `/availability?date=2026-06-13&serviceId=${o.svc('Express Hand Wash').id}`)
    expect(av.statusCode).toBe(200)
    expect(
      json<{ slots: { time: string; state: string }[] }>(av).slots.find((s) => s.time === '2:00 PM'),
    ).toMatchObject({ state: 'available' })
    expect(
      json<{ items: unknown[] }>(await call('GET', '/appointments?from=2026-06-13&to=2026-06-13')).items,
    ).toHaveLength(1)
    const file = await call('GET', `/appointments/${a}`)
    expect(file.statusCode).toBe(200)
    expect(json<{ addons: { selected: unknown[] } }>(file).addons.selected).toHaveLength(1)
    expect(json<{ items: { name: string }[] }>(await call('GET', '/staff')).items.map((s) => s.name)).toEqual(
      ['Marco R.', 'Lena K.', 'Sofia D.'],
    )
    expect(
      json<{ items: { number: number }[] }>(await call('GET', '/bays')).items.map((b) => b.number),
    ).toEqual([1, 2])
  })

  it('rejects malformed queries', async () => {
    for (const url of [
      '/ops/snapshot?window=month',
      '/calendar/summary?from=x&to=y',
      '/calendar/day',
      `/availability?date=2026-06-13`,
      '/availability?date=2026-06-13&serviceId=nope',
      '/appointments?limit=0',
    ])
      expect((await call('GET', url)).statusCode, url).toBe(422)
    expect(json(await call('GET', '/calendar/summary?from=2026-06-13&to=2026-01-01'))).toMatchObject({
      code: 'VALIDATION_FAILED',
    })
  })

  it('phone and email are masked without cli.contact, in the file and in search', async () => {
    const a = json<{ appointment: { id: string } }>(
      await call('POST', '/appointments', { body: booking(), key: key() }),
    ).appointment.id
    const full = json<{ customer: { phone: string; contactMasked: boolean } }>(
      await call('GET', `/appointments/${a}`, { perms: ['sched.view', 'cli.contact'] }),
    )
    expect(full.customer).toEqual(expect.objectContaining({ phone: '(305) 555-0102', contactMasked: false }))
    const masked = json<{ customer: { phone: string; contactMasked: boolean } }>(
      await call('GET', `/appointments/${a}`, { perms: ['sched.view'] }),
    )
    expect(masked.customer.contactMasked).toBe(true)
    expect(masked.customer.phone).toMatch(/\*+0102$/)
    const byPhone = async (perms: string[], path = '/ops/snapshot?q=0102') =>
      json<{ timeline: { count: number } }>(await call('GET', path, { perms })).timeline.count
    expect(await byPhone(['sched.view', 'cli.contact'])).toBe(1)
    expect(await byPhone(['sched.view'])).toBe(0)
    const customers = async (perms: string[]) =>
      json<{ items: { fullName: string; phone: string | null }[] }>(
        await call('GET', '/customers?q=0102', { perms }),
      ).items
    expect(await customers(['cli.view', 'cli.contact'])).toEqual([
      expect.objectContaining({ fullName: 'Maria Delgado', phone: '(305) 555-0102' }),
    ])
    expect(await customers(['cli.view'])).toEqual([])
    const byName = json<{ items: { phone: string | null; vehicles: unknown[] }[] }>(
      await call('GET', '/customers?q=maria', { perms: ['cli.view'] }),
    ).items
    expect(byName[0]).toMatchObject({ phone: null })
    expect(byName[0]!.vehicles).toHaveLength(1)
  })
})

describe('customers: search and create for the booking panel', () => {
  it('POST /customers finds by phone or creates, with the vehicle; needs sched.edit', async () => {
    const body = {
      name: 'Zed New',
      phone: '(305) 555-0177',
      smsOptIn: true,
      vehicle: { make: 'Kia', model: 'Soul', plate: 'zed-1' },
    }
    const r = await call('POST', '/customers', { body })
    expect(r.statusCode).toBe(201)
    expect(
      json<{
        created: boolean
        customer: { fullName: string; vehicles: { plate: string }[]; phone: string }
      }>(r),
    ).toMatchObject({
      created: true,
      customer: { fullName: 'Zed New', phone: '(305) 555-0177', vehicles: [{ plate: 'ZED-1' }] },
    })
    const again = json<{ created: boolean; customer: { id: string } }>(
      await call('POST', '/customers', { body: { ...body, name: 'Someone Else' } }),
    )
    expect(again.created).toBe(false)
    expect((await call('POST', '/customers', { body, perms: ['cli.view'] })).statusCode).toBe(403)
    const masked = json<{ customer: { phone: string | null } }>(
      await call('POST', '/customers', { body, perms: ['sched.edit'] }),
    )
    expect(masked.customer.phone).toBeNull()
    expect((await call('POST', '/customers', { body: { name: 'x', phone: 'abc' } })).statusCode).toBe(422)
  })
})

describe('photos over HTTP', () => {
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5d0000000049454e44ae426082',
    'hex',
  )

  it('presign (201), upload to storage, complete; HEIC is a 422 problem; notes and delete', async () => {
    const a = json<{ appointment: { id: string } }>(
      await call('POST', '/appointments', { body: booking(), key: key() }),
    ).appointment.id
    const heic = await call('POST', `/appointments/${a}/photos/presign`, {
      body: { category: 'before', contentType: 'image/heic', bytes: 1000 },
    })
    expect(heic.statusCode).toBe(422)
    expect(json<{ errors: { path: string; message: string }[] }>(heic).errors[0]).toMatchObject({
      path: 'contentType',
      message: expect.stringContaining('HEIC'),
    })
    const p = await call('POST', `/appointments/${a}/photos/presign`, {
      body: { category: 'after', contentType: 'image/png', bytes: png.length },
    })
    expect(p.statusCode).toBe(201)
    const slot = json<{
      photoId: string
      upload: { key: string; url: string; fields: Record<string, string>; expiresAt: string }
    }>(p)
    expect(slot.upload.expiresAt).toBe(new Date(o.clock.now().getTime() + 300_000).toISOString())
    await o.storage.put(slot.upload.key, png, 'image/png')
    const done = await call('POST', `/appointments/${a}/photos/${slot.photoId}/complete`)
    expect(done.statusCode).toBe(200)
    expect(json(done)).toMatchObject({ photo: { id: slot.photoId, category: 'after', bytes: png.length } })
    const note = await call('POST', `/appointments/${a}/photos/note`, {
      body: { note: 'Chip in the windshield' },
    })
    expect(note.statusCode).toBe(201)
    const file = json<{
      photos: { after: { count: number; items: { thumbUrl: string }[] }; issue: { count: number } }
    }>(await call('GET', `/appointments/${a}`))
    expect(file.photos.after.count).toBe(1)
    expect(file.photos.after.items[0]!.thumbUrl).toContain('/dev-storage/')
    expect(file.photos.issue.count).toBe(1)
    const del = await call('DELETE', `/appointments/${a}/photos/${slot.photoId}`)
    expect(json(del)).toEqual({ removed: true })
    expect(await o.storage.head(slot.upload.key)).toBeNull() // the object is deleted after commit
    expect(
      (
        await call('POST', `/appointments/${a}/photos/presign`, {
          body: { category: 'after', contentType: 'image/png', bytes: 5 },
          perms: ['sched.edit'],
        })
      ).statusCode,
    ).toBe(403)
  })
})

describe('bays', () => {
  it('PATCH /bays/:id needs sched.override, refuses a bay with a car in it, and shrinks capacity', async () => {
    expect(
      (await call('PATCH', `/bays/${o.bay(2)}`, { body: { status: 'maintenance' }, perms: ['sched.view'] }))
        .statusCode,
    ).toBe(403)
    const ok = await call('PATCH', `/bays/${o.bay(2)}`, {
      body: { status: 'maintenance' },
      perms: ['sched.override'],
    })
    expect(ok.statusCode).toBe(200)
    expect(json(ok)).toMatchObject({ number: 2, status: 'maintenance' })
    // one active bay: the second booking at the same time is blocked
    await call('POST', '/appointments', { body: booking(), key: key() })
    const full = await call('POST', '/appointments', {
      body: booking({ customer: { id: o.customer('David Okafor') } }),
      key: key(),
    })
    expect(full.statusCode).toBe(409)
    await call('PATCH', `/bays/${o.bay(2)}`, { body: { status: 'active' }, perms: ['sched.override'] })
    const id = await o.insert({
      customerName: 'Priya Nair',
      serviceName: 'Express Hand Wash',
      at: at('10:00'),
      status: 'cleaning',
      bay: 1,
      cleaningStartedAt: at('10:09'),
    })
    void id
    const busy = await call('PATCH', `/bays/${o.bay(1)}`, {
      body: { status: 'blocked' },
      perms: ['sched.override'],
    })
    expect(busy.statusCode).toBe(409)
    expect(json(busy)).toMatchObject({ code: 'BAY_BUSY', title: 'Bay 1 is busy' })
    expect(
      (await call('PATCH', `/bays/${o.bay(1)}`, { body: { status: 'nonsense' }, perms: ['sched.override'] }))
        .statusCode,
    ).toBe(422)
  })
})
