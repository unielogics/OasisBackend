// The 30-day phone trust and the stale-record rule (ADR 0160, design sections 0, 5 and 10): granted on a verification for 30 days,
// re-checked on every read; it ends on a phone change, PIN reset or clear, merge, STOP, a staff revoke and an epoch bump; a record
// quiet for 180 days, or whose last text bounced as an invalid number, is unknown until the client proves it again (their PIN or
// staff: a texted code proves only the number, W4c fixes).
import { describe, expect, it } from 'vitest'
import { updateCustomer } from '../../src/modules/customers/service.js'
import { revokeForMerge, revokeForOptOut } from '../../src/modules/identity/revoke.js'
import { isInvalidNumberError, staleRecord } from '../../src/modules/identity/stale.js'
import { evaluateTrust, grantTrust, revokeTrust, TRUST_TTL_MS } from '../../src/modules/identity/trust.js'
import { PHONES, useIdentityWorld } from './world.js'

const w = useIdentityWorld()
const DAY = 86_400_000

const grant = (customerId: string, phone: string = PHONES.maria) =>
  w.tx((tx) => grantTrust(tx, { locationId: w.locationId, phone, customerId, verifiedBy: 'code', now: w.clock.now() }))
const grantPin = (customerId: string, phone: string = PHONES.maria) =>
  w.tx((tx) => grantTrust(tx, { locationId: w.locationId, phone, customerId, verifiedBy: 'pin', now: w.clock.now() }))
const trust = (phone: string = PHONES.maria, customerId?: string) =>
  evaluateTrust(w.t.db, { locationId: w.locationId, phone, now: w.clock.now(), customerId })

async function inbound(phone: string, at: Date): Promise<void> {
  let dev = await w.t.db.selectFrom('sms_devices').select('id').executeTakeFirst()
  if (!dev) {
    dev = { id: w.newId() }
    await w.t.db.insertInto('sms_devices').values({ id: dev.id, location_id: w.locationId, device_key: 'test-device-1', label: 'Tablet', provider: 'sim', webhook_secret_enc: 'x' } as never).execute()
  }
  await w.t.db
    .insertInto('sms_inbox')
    .values({ id: w.newId(), device_id: dev.id, provider_message_id: `in-${w.newId()}`, from_raw: phone, from_e164: phone, body: 'hi', device_received_at: at, received_at: at })
    .execute()
}

async function outbound(phone: string, status: 'failed' | 'delivered', error: string | null, at: Date): Promise<void> {
  await w.t.db
    .insertInto('messages')
    .values({ id: w.newId(), location_id: w.locationId, direction: 'out', sender_kind: 'system', body: 'x', status, peer_e164: phone, error, queued_at: at, klass: 'reminder' })
    .execute()
}

describe('grantTrust / evaluateTrust', () => {
  it('trusts the number for its client 30 days, in the current epoch', async () => {
    const maria = await w.customer({})
    const { until } = await grant(maria)
    expect(until.getTime() - w.clock.now().getTime()).toBe(TRUST_TTL_MS)
    expect(TRUST_TTL_MS).toBe(30 * DAY)
    expect(await trust()).toMatchObject({ trusted: true, customerId: maria, verifiedBy: 'code', until })
    expect(await trust(PHONES.maria, maria)).toMatchObject({ trusted: true })
    expect((await w.t.db.selectFrom('phone_trust').select('epoch').executeTakeFirstOrThrow()).epoch).toBe(1)
    w.advance(30 * DAY)
    expect(await trust()).toMatchObject({ trusted: false, reason: 'expired' })
    // a new verification renews it
    await grant(maria)
    expect((await trust()).trusted).toBe(true)
  })

  it('belongs to its client only', async () => {
    const maria = await w.customer({})
    const liam = await w.customer({ name: 'Liam Chen', phone: PHONES.liam })
    await grant(maria)
    expect(await trust(PHONES.maria, liam)).toMatchObject({ trusted: false, reason: 'owner_changed' })
    expect(await trust(PHONES.liam)).toMatchObject({ trusted: false, reason: 'none' })
  })

  it('ends on a phone change (updateCustomer), and the number’s next owner does not inherit it', async () => {
    const maria = await w.customer({})
    await grant(maria)
    await w.tx((tx) => updateCustomer(tx, { id: maria, patch: { phone: PHONES.other } }))
    expect(await trust()).toMatchObject({ trusted: false, reason: 'revoked', revokeReason: 'phone_change' })
    // even without the revocation row, a new owner of the number is not trusted
    await w.t.db.updateTable('phone_trust').set({ revoked_at: null, revoke_reason: null }).execute()
    await w.customer({ name: 'New Owner', phone: PHONES.maria })
    expect(await trust()).toMatchObject({ trusted: false, reason: 'owner_changed' })
  })

  it('ends on a merge of either record', async () => {
    const maria = await w.customer({})
    const dup = await w.customer({ name: 'Maria D', phone: PHONES.liam })
    await grant(maria)
    await grant(dup, PHONES.liam)
    expect(await w.tx((tx) => revokeForMerge(tx, { fromCustomerId: dup, intoCustomerId: maria }))).toMatchObject({ trust: 2 })
    expect(await trust()).toMatchObject({ trusted: false, revokeReason: 'merge' })
    expect(await trust(PHONES.liam)).toMatchObject({ trusted: false, revokeReason: 'merge' })
  })

  it('ends on a STOP: on read (even after START) and as a revocation when the router reports it', async () => {
    const maria = await w.customer({})
    await grant(maria)
    w.advance(60_000)
    await w.t.db
      .insertInto('sms_opt_outs')
      .values({ id: w.newId(), location_id: w.locationId, phone_e164: PHONES.maria, opted_out_at: w.clock.now(), source: 'keyword', keyword: 'STOP', opted_in_again_at: w.clock.now() })
      .execute()
    expect(await trust()).toMatchObject({ trusted: false, reason: 'opted_out' })
    expect(await w.tx((tx) => revokeForOptOut(tx, { locationId: w.locationId, phone: PHONES.maria, now: w.clock.now() }))).toMatchObject({ trust: 1 })
    expect(await trust()).toMatchObject({ trusted: false, reason: 'revoked', revokeReason: 'opt_out' })
    // the client's own opt-out mark counts too
    w.advance(60_000)
    await grant(maria)
    w.advance(60_000)
    await w.t.db.updateTable('customers').set({ sms_opted_out_at: w.clock.now() }).execute()
    expect(await trust()).toMatchObject({ trusted: false, reason: 'opted_out' })
  })

  it('ends on a staff revoke and on an epoch bump', async () => {
    const maria = await w.customer({})
    await grant(maria)
    expect(await w.tx((tx) => revokeTrust(tx, { locationId: w.locationId, customerId: maria, reason: 'staff' }))).toBe(1)
    expect(await trust()).toMatchObject({ trusted: false, revokeReason: 'staff' })
    await grant(maria)
    await w.bumpEpoch()
    expect(await trust()).toMatchObject({ trusted: false, reason: 'epoch' })
    await grant(maria)
    expect(await trust()).toMatchObject({ trusted: true })
  })

  it('ends when the number’s texts bounce as an invalid number after the verification (stale-record rule)', async () => {
    const maria = await w.customer({})
    await grant(maria)
    w.advance(60_000)
    await outbound(PHONES.maria, 'failed', 'Generic failure', w.clock.now())
    expect((await trust()).trusted).toBe(true)
    w.advance(60_000)
    await outbound(PHONES.maria, 'failed', 'RESULT_ERROR_INVALID_DESTINATION_ADDRESS', w.clock.now())
    expect(await trust()).toMatchObject({ trusted: false, reason: 'stale' })
  })
})

describe('staleRecord', () => {
  it('recognises a hard invalid-number failure, never a transient one', () => {
    for (const e of ['Invalid destination address', 'RESULT_ERROR_INVALID_DESTINATION_ADDRESS', 'Unknown subscriber', 'Number not in service', 'unallocated number'])
      expect(isInvalidNumberError(e), e).toBe(true)
    for (const e of ['Generic failure', 'Radio off', 'No service', 'Network error: invalid number? try again', null, ''])
      expect(isInvalidNumberError(e), String(e)).toBe(false)
  })

  it('a record quiet for 180 days is stale; a PIN or a newer record is activity, a texted code or a text from the number never is (W4c fixes)', async () => {
    const old = new Date(w.clock.now().getTime() - 200 * DAY)
    const maria = await w.customer({ createdAt: old })
    const verdict = () => staleRecord(w.t.db, { locationId: w.locationId, customerId: maria, phone: PHONES.maria, now: w.clock.now() })
    expect(await verdict()).toMatchObject({ stale: true, reason: 'inactive', lastActivityAt: old })
    // a recycled number: its new holder texts the shop (the webhook stores the text before the assistant reads the verdict); the
    // text says nothing about who holds the number, so the old client's record stays unknown
    await inbound(PHONES.maria, new Date(w.clock.now().getTime() - 179 * DAY))
    await inbound(PHONES.maria, w.clock.now())
    expect(await verdict()).toMatchObject({ stale: true, reason: 'inactive', lastActivityAt: old })
    // a texted code proves the number, not the client: no activity
    w.advance(2 * DAY)
    await grant(maria)
    expect(await verdict()).toMatchObject({ stale: true, reason: 'inactive', lastActivityAt: old })
    // the client's own PIN is; 181 days after it, a fresh text from the number still is not
    await grantPin(maria)
    expect(await verdict()).toMatchObject({ stale: false, reason: null, lastActivityAt: w.clock.now() })
    w.advance(181 * DAY)
    await inbound(PHONES.maria, w.clock.now())
    expect(await verdict()).toMatchObject({ stale: true, reason: 'inactive' })
    const fresh = await w.customer({ name: 'Liam Chen', phone: PHONES.liam })
    expect((await staleRecord(w.t.db, { locationId: w.locationId, customerId: fresh, phone: PHONES.liam, now: w.clock.now() })).stale).toBe(false)
  })

  it('a record whose last final text bounced as an invalid number is stale until the client proves it (PIN) again; a later delivery clears it', async () => {
    const maria = await w.customer({})
    const verdict = () => staleRecord(w.t.db, { locationId: w.locationId, customerId: maria, phone: PHONES.maria, now: w.clock.now() })
    w.advance(60_000)
    await outbound(PHONES.maria, 'failed', 'Invalid destination address', w.clock.now())
    expect(await verdict()).toMatchObject({ stale: true, reason: 'invalid_number' })
    w.advance(60_000)
    await grant(maria)
    expect(await verdict()).toMatchObject({ stale: true, reason: 'invalid_number' })
    w.advance(60_000)
    await grantPin(maria)
    expect((await verdict()).stale).toBe(false)
    w.advance(60_000)
    await outbound(PHONES.maria, 'failed', 'Invalid destination address', w.clock.now())
    expect((await verdict()).reason).toBe('invalid_number')
    w.advance(60_000)
    await outbound(PHONES.maria, 'delivered', null, w.clock.now())
    expect((await verdict()).stale).toBe(false)
  })
})
