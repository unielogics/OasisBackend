// The W4c re-review of the stale-record rule (ADR 0160, "W4c fixes", second round): a stale PROVISIONAL record ("New texter …") is
// unknown to the assistant like any other stale record (M1, probe R4); the website's code check (/public/otp/verify) shows a stale
// record to nobody, and a texted-code member token never books or joins for a number whose client has a PIN (L1, probes R1 and R2);
// a membership proves the client from the time of its last matched payment or a staff action on it, never "live now" (L3, probe R3).
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { loadAppointmentRefs, loadTurnContext, resolveIdentity } from '../../src/modules/assistant/context.js'
import { staleRecord } from '../../src/modules/identity/stale.js'
import { DAY, json, PHONES, SITE_ORIGIN, useLinksHarness } from './harness.js'

const h = useLinksHarness({ env: { PUBLIC_WRITES_ENABLED: 'true' } })
const ago = (days: number): Date => new Date(h.clock.now().getTime() - days * DAY)

const post = (url: string, payload: Record<string, unknown>, key: string | null = null) =>
  h.t.app.inject({
    method: 'POST',
    url: `/api/v1/${url}`,
    headers: { 'x-test-anonymous': '1', origin: SITE_ORIGIN, ...(key ? { 'idempotency-key': key } : {}) },
    remoteAddress: h.nextIp(),
    payload,
  })

async function verifyOtp(phone: string) {
  const otp = await post('public/otp', { phone })
  expect(otp.statusCode, otp.body).toBe(202)
  const challengeId = json(otp).challengeId as string
  const r = await post('public/otp/verify', { challengeId, code: await h.codeOf(challengeId) })
  expect(r.statusCode, r.body).toBe(200)
  return json(r)
}

const webBook = (memberToken: string, o: { date?: string; startMin?: number } = {}) =>
  post(
    'public/bookings',
    {
      name: 'Somebody Else',
      phone: PHONES.maria,
      serviceKey: h.key('Express Hand Wash'),
      addonKeys: [],
      date: o.date ?? '2026-06-13',
      startMin: o.startMin ?? 14 * 60,
      smsConsent: true,
      website: '',
      memberToken,
    },
    h.nextKey(),
  )

const webJoin = (memberToken: string) =>
  post(
    'public/memberships',
    { tier: 'gold', name: 'Somebody Else', phone: PHONES.maria, email: 'someone@example.test', vehicles: [{ car: '2019 Honda Civic' }], smsConsent: true, agree: true, website: '', memberToken },
    h.nextKey(),
  )

const verdict = (customerId: string) => staleRecord(h.db, { locationId: h.locationId, customerId, phone: PHONES.maria, now: h.clock.now() })

/** Maria with a PIN set on her own page (the PIN proves her that day). */
async function pinHolder(): Promise<string> {
  const id = await h.customer({ name: 'Maria Delgado' })
  const own = await h.page({ customerId: id })
  expect((await h.verifyByCode(own.session)).statusCode).toBe(200)
  expect((await h.call('POST', 'pin', { session: own.session, body: { pin: '4826' } })).statusCode).toBe(200)
  await sql`delete from phone_trust`.execute(h.db)
  return id
}

async function provisional(createdAt: Date): Promise<string> {
  const id = h.newId()
  await h.db
    .insertInto('customers')
    .values({
      id,
      full_name: 'New texter ••0121',
      phone_e164: PHONES.maria,
      phone_display: null,
      email: null,
      notes: null,
      source: 'inbound_sms',
      sms_opted_in: true,
      sms_opt_in_source: 'inbound_text',
      synthetic: false,
      needs_details: true,
      created_at: createdAt,
    })
    .execute()
  await h.db.insertInto('vehicles').values({ id: h.newId(), customer_id: id, year: 2021, make: 'Tesla', model: 'Model 3', color: 'Red', plate: null, deleted_at: null }).execute()
  const svc = await h.db.selectFrom('services').select(['id', 'price_cents', 'duration_min']).where('kind', '=', 'package').executeTakeFirstOrThrow()
  const at = new Date(createdAt.getTime() + 2 * DAY)
  await h.db
    .insertInto('appointments')
    .values({
      id: h.newId(),
      location_id: h.locationId,
      customer_id: id,
      service_id: svc.id,
      package_name: 'Signature Detail',
      price_cents: svc.price_cents,
      duration_min: svc.duration_min,
      scheduled_start: at,
      scheduled_end: new Date(at.getTime() + 3_600_000),
      status: 'booked',
      source: 'link',
      created_at: createdAt,
    })
    .execute()
  return id
}

async function contextOf() {
  const now = h.clock.now()
  const resolved = await resolveIdentity(h.db, { locationId: h.locationId, phone: PHONES.maria, customerId: null, now })
  const refs = await loadAppointmentRefs(h.db, { locationId: h.locationId, customerId: resolved.identity.customerId, now })
  const ctx = await loadTurnContext(h.db, { resolved, conversationId: h.newId(), refs, actionsEnabled: true, firstContact: false, now, tz: 'America/New_York' })
  return { resolved, refs, ctx }
}

describe('a stale PROVISIONAL record is unknown to the assistant (M1, probe R4)', () => {
  it('a "New texter" record quiet for 300 days with a vehicle and a link visit: no client, no vehicles, no visits', async () => {
    const id = await provisional(ago(300))
    expect((await verdict(id)).stale).toBe(true)
    const { resolved, refs, ctx } = await contextOf()
    expect({ customerId: resolved.identity.customerId, provisional: resolved.identity.provisional, threadCustomerId: resolved.threadCustomerId }).toEqual({
      customerId: null,
      provisional: false,
      threadCustomerId: id,
    })
    expect({ refs: refs.length, vehicles: ctx.vehicles, unknown: ctx.unknownNumber, membership: ctx.membership }).toEqual({ refs: 0, vehicles: [], unknown: true, membership: null })
    expect(JSON.stringify(ctx)).not.toMatch(/Tesla|Model 3|Signature Detail/)
  })

  it('a provisional record that is not stale still resolves to its client (unchanged)', async () => {
    const id = await provisional(ago(10))
    const { resolved, ctx } = await contextOf()
    expect({ customerId: resolved.identity.customerId, provisional: resolved.identity.provisional, firstName: ctx.firstName }).toEqual({
      customerId: id,
      provisional: true,
      firstName: null,
    })
    expect(ctx.vehicles).toEqual(['2021 Tesla Model 3, Red'])
  })
})

describe('the website and the stale-record rule (L1, probes R1 and R2; closed by PUBLIC_WRITES_ENABLED=false)', () => {
  it('R1: /public/otp/verify on a stale record shows nobody (no first name, no membership)', async () => {
    await h.customer({ name: 'Maria Delgado', createdAt: ago(200) })
    const v = await verifyOtp(PHONES.maria)
    expect(v.member).toEqual({ firstName: '', tier: null, washesLeft: null, plan: null, active: false })
  })

  it('/public/otp/verify on a record that is not stale still greets the client', async () => {
    await h.customer({ name: 'Maria Delgado', createdAt: ago(20) })
    expect((await verifyOtp(PHONES.maria)).member.firstName).toBe('Maria')
  })

  it('R2: a texted-code member token never books for a STALE PIN holder’s number (409 IDENTITY_PIN_REQUIRED, the number stays hers)', async () => {
    const id = await pinHolder()
    h.advance(203 * DAY) // Saturday 2027-01-02, 10:36
    expect((await verdict(id)).stale).toBe(true)
    const token = (await verifyOtp(PHONES.maria)).memberToken as string
    const r = await webBook(token, { date: '2027-01-02', startMin: 13 * 60 })
    expect(json(r)).toMatchObject({ status: 409, code: 'IDENTITY_PIN_REQUIRED' })
    const row = await h.db.selectFrom('customers').select(['phone_e164', 'phone_reassigned_at']).where('id', '=', id).executeTakeFirstOrThrow()
    expect(row).toEqual({ phone_e164: PHONES.maria, phone_reassigned_at: null })
    expect(await h.db.selectFrom('appointments').select('id').execute()).toEqual([])
  })

  it('the same for a PIN holder whose record is not stale, and for POST /public/memberships', async () => {
    const id = await pinHolder()
    const token = (await verifyOtp(PHONES.maria)).memberToken as string
    expect(json(await webBook(token))).toMatchObject({ status: 409, code: 'IDENTITY_PIN_REQUIRED' })
    expect(json(await webJoin(token))).toMatchObject({ status: 409, code: 'IDENTITY_PIN_REQUIRED' })
    h.advance(203 * DAY)
    expect((await verdict(id)).stale).toBe(true)
    const late = (await verifyOtp(PHONES.maria)).memberToken as string
    expect(json(await webJoin(late))).toMatchObject({ status: 409, code: 'IDENTITY_PIN_REQUIRED' })
    expect((await h.db.selectFrom('customers').select('phone_e164').where('id', '=', id).executeTakeFirstOrThrow()).phone_e164).toBe(PHONES.maria)
    expect(await h.db.selectFrom('memberships').select('id').execute()).toEqual([])
    expect(await h.db.selectFrom('appointments').select('id').execute()).toEqual([])
  })

  it('a client with no PIN still books with a member token (unchanged)', async () => {
    const id = await h.customer({ name: 'Maria Delgado', createdAt: ago(20) })
    const token = (await verifyOtp(PHONES.maria)).memberToken as string
    const r = await webBook(token)
    expect(r.statusCode, r.body).toBe(201)
    expect((await h.db.selectFrom('appointments').select('customer_id').executeTakeFirstOrThrow()).customer_id).toBe(id)
  })
})

describe('a membership proves the client from its last matched payment or staff action (L3, probe R3)', () => {
  async function membership(customerId: string, o: { status: string; lastPaidAt: Date | null; manualStatusAt: Date | null }) {
    const plan = await h.db.selectFrom('membership_plans').select('id').where('key', '=', 'gold').executeTakeFirstOrThrow()
    await h.db
      .insertInto('memberships')
      .values({
        id: h.newId(),
        location_id: h.locationId,
        customer_id: customerId,
        plan_id: plan.id,
        plan_label: 'Gold',
        status: o.status,
        source: 'manual',
        started_at: ago(400),
        last_paid_at: o.lastPaidAt,
        manual_status_at: o.manualStatusAt,
      } as never)
      .execute()
  }
  const staleWith = async (o: { status: string; lastPaidAt: Date | null; manualStatusAt: Date | null }) => {
    await sql`delete from memberships`.execute(h.db)
    await sql`delete from customers where synthetic = false`.execute(h.db)
    const id = await h.customer({ createdAt: ago(400) })
    await membership(id, o)
    return (await verdict(id)).stale
  }

  it('R3: a membership staff paused 300 days ago is no proof now; one live but last paid 300 days ago neither', async () => {
    expect(await staleWith({ status: 'paused', lastPaidAt: null, manualStatusAt: ago(300) })).toBe(true)
    expect(await staleWith({ status: 'active', lastPaidAt: ago(300), manualStatusAt: null })).toBe(true)
    expect(await staleWith({ status: 'past_due', lastPaidAt: ago(250), manualStatusAt: ago(260) })).toBe(true)
  })

  it('a payment matched 10 days ago, or staff setting the membership 10 days ago, is proof', async () => {
    expect(await staleWith({ status: 'active', lastPaidAt: ago(10), manualStatusAt: null })).toBe(false)
    // a canceled membership's payment still proves the client at the time it was paid
    expect(await staleWith({ status: 'canceled', lastPaidAt: ago(10), manualStatusAt: null })).toBe(false)
    expect(await staleWith({ status: 'active', lastPaidAt: null, manualStatusAt: ago(10) })).toBe(false)
    expect(await staleWith({ status: 'paused', lastPaidAt: null, manualStatusAt: ago(10) })).toBe(false)
    // a checkout the system canceled (abandoned, never paid) proves nothing
    expect(await staleWith({ status: 'canceled', lastPaidAt: null, manualStatusAt: ago(10) })).toBe(true)
    expect(await staleWith({ status: 'pending', lastPaidAt: null, manualStatusAt: ago(10) })).toBe(true)
  })
})
