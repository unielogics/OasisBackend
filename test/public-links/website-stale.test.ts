// The website's POST /public/bookings against the stale-record rule (ADR 0160, "W4c fixes" B1; closed in production by
// PUBLIC_WRITES_ENABLED=false, kept safe for a reopening): a booking with no code is only linked to a stale record and never ends the
// rule (the checker's C1 and C2); a booking whose number was proven by a texted code (a member token) on a stale record makes a new
// client and moves the number, exactly as on a link page.
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { resolveIdentity } from '../../src/modules/assistant/context.js'
import { staleRecord } from '../../src/modules/identity/stale.js'
import { DAY, json, PHONES, SITE_ORIGIN, useLinksHarness } from './harness.js'

const h = useLinksHarness({ env: { PUBLIC_WRITES_ENABLED: 'true' } })

const post = (url: string, payload: Record<string, unknown>, key: string | null = null) =>
  h.t.app.inject({
    method: 'POST',
    url: `/api/v1/${url}`,
    headers: { 'x-test-anonymous': '1', origin: SITE_ORIGIN, ...(key ? { 'idempotency-key': key } : {}) },
    remoteAddress: h.nextIp(),
    payload,
  })

/** POST /public/bookings as the website would (anyone can type any number); `memberToken` when the number was proven by a code. */
const webBook = (phone: string, name: string, o: { startMin?: number; date?: string; memberToken?: string } = {}) =>
  post(
    'public/bookings',
    {
      name,
      phone,
      serviceKey: h.key('Express Hand Wash'),
      addonKeys: [],
      date: o.date ?? '2026-06-13',
      startMin: o.startMin ?? 14 * 60,
      smsConsent: true,
      website: '',
      ...(o.memberToken ? { memberToken: o.memberToken } : {}),
    },
    h.nextKey(),
  )

async function memberToken(phone: string): Promise<string> {
  const otp = await post('public/otp', { phone })
  expect(otp.statusCode, otp.body).toBe(202)
  const challengeId = json(otp).challengeId as string
  const r = await post('public/otp/verify', { challengeId, code: await h.codeOf(challengeId) })
  expect(r.statusCode, r.body).toBe(200)
  return json(r).memberToken as string
}

const verdict = (customerId: string) => staleRecord(h.db, { locationId: h.locationId, customerId, phone: PHONES.maria, now: h.clock.now() })
const who = () => resolveIdentity(h.db, { locationId: h.locationId, phone: PHONES.maria, customerId: null, now: h.clock.now() })

describe('the website and a stale record', () => {
  it('C1: a booking with no code at all is only linked to the stale record and never un-hides it', async () => {
    const stale = await h.customer({ name: 'Maria Delgado', createdAt: new Date(h.clock.now().getTime() - 200 * DAY) })
    expect((await verdict(stale)).stale).toBe(true)
    const r = await webBook(PHONES.maria, 'Somebody Else')
    expect(r.statusCode, r.body).toBe(201)
    const appt = await h.db.selectFrom('appointments').select('customer_id').executeTakeFirstOrThrow()
    expect({ onStale: appt.customer_id === stale, stale: (await verdict(stale)).stale, name: (await who()).fullName }).toEqual({ onStale: true, stale: true, name: null })
  })

  it('C2: the same against a PIN holder’s stale record', async () => {
    const id = await h.customer()
    const own = await h.page({ customerId: id })
    expect((await h.verifyByCode(own.session)).statusCode).toBe(200)
    expect((await h.call('POST', 'pin', { session: own.session, body: { pin: '4826' } })).statusCode).toBe(200)
    await sql`delete from phone_trust`.execute(h.db)
    h.advance(203 * DAY) // Saturday 2027-01-02, 10:36
    expect((await verdict(id)).stale).toBe(true)
    const r = await webBook(PHONES.maria, 'Somebody Else', { startMin: 13 * 60, date: '2027-01-02' })
    expect(r.statusCode, r.body).toBe(201)
    expect({ stale: (await verdict(id)).stale, name: (await who()).fullName }).toEqual({ stale: true, name: null })
  })

  it('a member token (a texted code) on a stale record: a new client takes the number; the old record is flagged', async () => {
    const stale = await h.customer({ name: 'Maria Delgado', createdAt: new Date(h.clock.now().getTime() - 200 * DAY) })
    const token = await memberToken(PHONES.maria)
    const r = await webBook(PHONES.maria, 'Somebody Else', { memberToken: token })
    expect(r.statusCode, r.body).toBe(201)
    expect(json(r).member).toBe(false)
    const appt = await h.db.selectFrom('appointments').select('customer_id').executeTakeFirstOrThrow()
    expect(appt.customer_id).not.toBe(stale)
    const old = await h.db.selectFrom('customers').select(['phone_e164', 'phone_reassigned_to']).where('id', '=', stale).executeTakeFirstOrThrow()
    expect(old).toEqual({ phone_e164: null, phone_reassigned_to: appt.customer_id })
    expect((await who()).fullName).toBe('Somebody Else')
    expect((await h.db.selectFrom('notifications').select('entity_id').where('kind', '=', 'identity.number_reassigned').execute())[0]?.entity_id).toBe(stale)
  })
})
