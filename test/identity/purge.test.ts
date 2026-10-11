// Retention of the identity tables (maintenance.retention, ADR 0160): what is past its window goes, the rest stays, a second run
// removes nothing, customer_pins is never purged, and the code rows of a purged session stay (the hourly ceiling counts them).
import { describe, expect, it } from 'vitest'
import { runMaintenancePurge } from '../../src/platform/maintenance.js'
import { purgeIdentityRows } from '../../src/modules/identity/purge.js'
import { requestStepUpCode } from '../../src/modules/identity/codes.js'
import { grantTrust } from '../../src/modules/identity/trust.js'
import { PHONES, useIdentityWorld } from './world.js'

const w = useIdentityWorld()
const DAY = 86_400_000
const count = async (table: 'client_links' | 'client_link_sessions' | 'phone_trust' | 'identity_pin_failures' | 'customer_pins' | 'public_otp_challenges') =>
  Number((await w.t.db.selectFrom(table).select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow()).n)

describe('purgeIdentityRows', () => {
  it('drops links, sessions, wrong-PIN rows and ended trust past their windows; keeps PINs and the code rows', async () => {
    const maria = await w.customer({})
    await w.t.db.insertInto('customer_pins').values({ customer_id: maria, pin_hash: null, cleared_at: w.clock.now(), version: 2, set_at: w.clock.now() }).execute()
    const s = await w.session({ customerId: maria, kind: 'verify' })
    await requestStepUpCode(w.d, { session: s.session, purpose: 'link_verify', ip: '203.0.113.1' })
    await w.t.db.insertInto('identity_pin_failures').values({ id: w.newId(), location_id: w.locationId, customer_id: null, phone_e164: PHONES.maria, ip: '203.0.113.1', at: w.clock.now() }).execute()
    await w.tx((tx) => grantTrust(tx, { locationId: w.locationId, phone: PHONES.maria, customerId: maria, verifiedBy: 'code', now: w.clock.now() }))

    expect(await purgeIdentityRows(w.t.db, w.clock.now())).toBe(0)
    w.advance(3 * DAY)
    // sessions a day past their hour and wrong-PIN rows two days old go; the link (a week past expiry) stays
    expect(await purgeIdentityRows(w.t.db, w.clock.now())).toBe(2)
    expect([await count('client_link_sessions'), await count('identity_pin_failures'), await count('client_links')]).toEqual([0, 0, 1])
    expect(await count('public_otp_challenges')).toBe(1)
    w.advance(5 * DAY)
    expect(await purgeIdentityRows(w.t.db, w.clock.now())).toBe(1)
    expect(await count('client_links')).toBe(0)
    w.advance(210 * DAY)
    expect(await purgeIdentityRows(w.t.db, w.clock.now())).toBe(1)
    expect(await count('phone_trust')).toBe(0)
    expect(await purgeIdentityRows(w.t.db, w.clock.now())).toBe(0)
    expect(await count('customer_pins')).toBe(1)
    expect(await count('public_otp_challenges')).toBe(1)
  })

  it('runs as the daily "identity" task of maintenance.retention', async () => {
    const removed = await runMaintenancePurge(w.t.db, w.clock, 'daily')
    expect(removed.identity).toBe(0)
  })
})
