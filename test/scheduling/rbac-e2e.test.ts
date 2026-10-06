// The Operations routes behind the real session authorizer and the seeded role grants: who can do what at the desk and in
// the bays (the command-to-permission map of review B17, end to end).
import { beforeEach, describe, expect, it } from 'vitest'
import { runSeed } from '../../db/seeds/index.js'
import { useHarness, type Session, type TestUser } from '../auth/harness.js'

const h = useHarness()
const at = (hhmm: string, date = '2026-06-13'): string => `${date}T${hhmm}:00-04:00`

let sessions: Record<'mgmt' | 'crew' | 'support' | 'acct', Session>
let serviceId = ''
let customerId = ''
let keyN = 0
const key = (): string => `e2e-key-${++keyN}-${'z'.repeat(8)}`

beforeEach(async () => {
  await runSeed({ db: h.t.db, clock: h.clock, profile: 'domain-design' })
  const users: Record<string, TestUser> = {}
  for (const role of ['mgmt', 'crew', 'support', 'acct'] as const)
    users[role] = await h.createUser({ email: `${role}@example.test`, roles: [role] })
  sessions = {
    mgmt: await h.login(users.mgmt!, '10.9.0.1'),
    crew: await h.login(users.crew!, '10.9.0.2'),
    support: await h.login(users.support!, '10.9.0.3'),
    acct: await h.login(users.acct!, '10.9.0.4'),
  }
  serviceId = (
    await h.t.db
      .selectFrom('services')
      .select('id')
      .where('name', '=', 'Express Hand Wash')
      .executeTakeFirstOrThrow()
  ).id
  customerId = (
    await h.t.db
      .selectFrom('customers')
      .select('id')
      .where('full_name', '=', 'Maria Delgado')
      .executeTakeFirstOrThrow()
  ).id
})

const book = async (as: keyof typeof sessions, hhmm: string) =>
  h.call('POST', '/api/v1/appointments', {
    session: sessions[as],
    headers: { 'idempotency-key': key() },
    body: { customer: { id: customerId }, serviceId, start: at(hhmm) },
  })

describe('desk and bays with the real roles', () => {
  it('management books, then the crew moves the job through the bays but cannot book, move or cancel it', async () => {
    const created = await book('mgmt', '11:00')
    expect(created.statusCode).toBe(201)
    const id = h.json<{ appointment: { id: string } }>(created).appointment.id

    const call = (
      as: keyof typeof sessions,
      path: string,
      body?: object,
      method: 'POST' | 'PUT' | 'GET' = 'POST',
    ) =>
      h.call(method, `/api/v1/appointments/${id}${path}`, {
        session: sessions[as],
        body,
        headers: { 'idempotency-key': key() },
      })

    // the crew cannot book, reschedule, cancel or touch add-ons
    expect((await book('crew', '12:00')).statusCode).toBe(403)
    expect((await call('crew', '/reschedule', { start: at('13:00') })).statusCode).toBe(403)
    expect((await call('crew', '/cancel', { reason: 'x' })).statusCode).toBe(403)
    // the crew can advance: confirm, arrive, start (needs a bay), complete, pickup
    const adv = (as: keyof typeof sessions, expectedStatus: string) =>
      call(as, '/advance', { expectedStatus })
    expect((await adv('crew', 'booked')).statusCode).toBe(200)
    expect((await adv('crew', 'confirmed')).statusCode).toBe(200)
    const started = await adv('crew', 'arrived')
    expect(started.statusCode).toBe(200)
    expect(
      h.json<{ appointment: { status: string; bay: { number: number } } }>(started).appointment,
    ).toMatchObject({ status: 'cleaning', bay: { number: 1 } })
    // a stale second tab
    const stale = await adv('crew', 'arrived')
    expect(stale.statusCode).toBe(409)
    expect(h.json(stale)).toMatchObject({ code: 'STALE_STATE' })
    expect((await adv('crew', 'cleaning')).statusCode).toBe(200)
    expect((await call('crew', '/pickup', { state: 'collected' })).statusCode).toBe(200)
  })

  it('support books and confirms but cannot start a job (jobs.status); accounting reads the board only', async () => {
    const id = h.json<{ appointment: { id: string } }>(await book('support', '11:00')).appointment.id
    const call = (as: keyof typeof sessions, path: string, body?: object) =>
      h.call('POST', `/api/v1/appointments/${id}${path}`, {
        session: sessions[as],
        body,
        headers: { 'idempotency-key': key() },
      })
    expect((await call('support', '/advance', { expectedStatus: 'booked' })).statusCode).toBe(200) // confirm: sched.edit
    expect((await call('support', '/advance', { expectedStatus: 'confirmed' })).statusCode).toBe(200) // arrive: sched.edit
    const start = await call('support', '/advance', { expectedStatus: 'arrived' })
    expect(start.statusCode).toBe(403)
    expect(h.json(start)).toMatchObject({ code: 'FORBIDDEN', meta: { required: ['jobs.status'] } })
    expect((await call('acct', '/advance', { expectedStatus: 'arrived' })).statusCode).toBe(403)
    expect((await h.call('GET', '/api/v1/ops/snapshot', { session: sessions.acct })).statusCode).toBe(200)
    expect((await book('acct', '14:00')).statusCode).toBe(403)
  })

  it('contact details follow cli.contact: the crew sees a masked phone and cannot search by it', async () => {
    const id = h.json<{ appointment: { id: string } }>(await book('mgmt', '11:00')).appointment.id
    const file = async (as: keyof typeof sessions) =>
      h.json<{ customer: { phone: string; contactMasked: boolean } }>(
        await h.call('GET', `/api/v1/appointments/${id}`, { session: sessions[as] }),
      )
    expect((await file('mgmt')).customer).toMatchObject({ phone: '(305) 555-0102', contactMasked: false })
    expect((await file('crew')).customer.contactMasked).toBe(true)
    const board = async (as: keyof typeof sessions) =>
      h.json<{ timeline: { count: number } }>(
        await h.call('GET', '/api/v1/ops/snapshot?q=0102', { session: sessions[as] }),
      )
    expect((await board('mgmt')).timeline.count).toBe(1)
    expect((await board('crew')).timeline.count).toBe(0)
  })

  it('the booking is idempotent with real sessions, and the key belongs to its user', async () => {
    const k = key()
    const body = { customer: { id: customerId }, serviceId, start: at('15:00') }
    const first = await h.call('POST', '/api/v1/appointments', {
      session: sessions.mgmt,
      headers: { 'idempotency-key': k },
      body,
    })
    const again = await h.call('POST', '/api/v1/appointments', {
      session: sessions.mgmt,
      headers: { 'idempotency-key': k },
      body,
    })
    expect(first.statusCode).toBe(201)
    expect(again.headers['idempotent-replayed']).toBe('true')
    expect(h.json<{ appointment: { id: string } }>(again).appointment.id).toBe(
      h.json<{ appointment: { id: string } }>(first).appointment.id,
    )
    const other = await h.call('POST', '/api/v1/appointments', {
      session: sessions.support,
      headers: { 'idempotency-key': k },
      body: { ...body, start: at('16:00') },
    })
    expect(other.statusCode).toBe(201) // another user's key is independent
  })
})
