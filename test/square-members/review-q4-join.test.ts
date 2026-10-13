// Review Q4 pricing:F7: with Square as the processor, a website join for a tier with no price at any size is refused (plan decision 3:
// a tier with no price is not sold online): nothing is written and no membership page is texted, never a page that cannot subscribe.
import { afterEach, describe, expect, it } from 'vitest'
import { loadEnv } from '../../src/config/env.js'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { configureSquareRuntime } from '../../src/modules/square/runtime.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { json, PHONES, usePublicHarness } from '../public-http/harness.js'
import { PEPPER } from '../public-links/harness.js'
import { coreVars } from '../square-db/core.js'
import { simFor } from '../square-db/helpers.js'

const h = usePublicHarness({ env: { PUBLIC_LINKS_ENABLED: 'true', PIN_PEPPER: PEPPER } })
afterEach(() => configureSquareRuntime({}))

const join = (tier: string) =>
  h.post('public/memberships', { tier, name: 'Jo Joiner', phone: PHONES.joiner, email: 'jo.joiner@gmail.com', vehicles: [{ car: '2019 Honda Civic', plate: 'JO-1' }], smsConsent: true, agree: true, website: '' })

describe('a website join for a tier without a price (review Q4 F7)', () => {
  it('is refused with Square billing: nothing written, nothing texted', async () => {
    const sim = simFor(h.clock)
    configureSquareRuntime({ env: loadEnv({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl(), ...coreVars }), api: () => sim.api })
    await ensurePlans(h.db, { locationId: h.locationId, clock: h.clock, newId: h.newId })
    const vip = await h.db.selectFrom('membership_plans').select('id').where('key', '=', 'vip').executeTakeFirstOrThrow()
    await h.db.updateTable('membership_tier_prices').set({ superseded_at: h.clock.now() }).where('plan_id', '=', vip.id).where('superseded_at', 'is', null).execute()
    await h.db.updateTable('membership_plans').set({ public: true, active: true }).where('id', '=', vip.id).execute()
    const r = await join('vip')
    expect(r.statusCode, r.body).toBe(422)
    expect(json(r)).toMatchObject({ errors: [{ path: 'body.tier', message: 'That plan is not available right now.' }] })
    expect(await h.db.selectFrom('client_links').select('id').execute()).toEqual([])
    expect(await h.db.selectFrom('memberships').select('id').execute()).toEqual([])
    expect(await h.texts(PHONES.joiner)).toEqual([])
  })
})
