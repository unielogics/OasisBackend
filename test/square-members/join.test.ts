// The website join with Square as the processor (ADR 0171 wave Q3b, design 5.7): with personal links open, POST /public/memberships
// texts the client their own membership page (a card there, billed by Square) instead of asking staff for a Squarespace checkout link;
// no pending membership and no product map until they submit on it. With Squarespace as the processor nothing changes
// (test/public-http/memberships.test.ts).
import { afterEach, describe, expect, it } from 'vitest'
import { loadEnv } from '../../src/config/env.js'
import { ensureVehicleClasses } from '../../src/modules/catalog/vehicle-classes.js'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { configureSquareRuntime } from '../../src/modules/square/runtime.js'
import { testDatabaseUrl } from '../helpers/env.js'
import { json, PHONES, usePublicHarness } from '../public-http/harness.js'
import { PEPPER } from '../public-links/harness.js'
import { coreVars } from '../square-db/core.js'
import { simFor } from '../square-db/helpers.js'

const h = usePublicHarness({ env: { PUBLIC_LINKS_ENABLED: 'true', PIN_PEPPER: PEPPER } })
afterEach(() => configureSquareRuntime({}))

describe('joining on the website with Square as the processor', () => {
  it('texts the client their membership page; no pending membership, no Squarespace product, staff told', async () => {
    const sim = simFor(h.clock)
    configureSquareRuntime({ env: loadEnv({ NODE_ENV: 'test', DATABASE_URL: testDatabaseUrl(), ...coreVars }), api: () => sim.api })
    // Gold is priced (a tier with no price is not sold online with Square: review Q4 F7)
    await ensureVehicleClasses(h.db, h.locationId)
    await ensurePlans(h.db, { locationId: h.locationId, clock: h.clock, newId: h.newId })
    const gold = await h.db.selectFrom('membership_plans').select(['id', 'price_version']).where('key', '=', 'gold').executeTakeFirstOrThrow()
    await h.db.updateTable('membership_tier_prices').set({ superseded_at: h.clock.now() }).where('plan_id', '=', gold.id).where('class_key', '=', 'compact_car').where('superseded_at', 'is', null).execute()
    await h.db
      .insertInto('membership_tier_prices')
      .values({ id: h.newId(), location_id: h.locationId, plan_id: gold.id, class_key: 'compact_car', monthly_cents: 12900, price_version: gold.price_version + 1, effective_from: h.clock.now() })
      .execute()
    await h.db.updateTable('membership_plans').set({ price_version: gold.price_version + 1 }).where('id', '=', gold.id).execute()
    const r = await h.post('public/memberships', {
      tier: 'gold',
      name: 'Jo Joiner',
      phone: PHONES.joiner,
      email: 'jo.joiner@gmail.com',
      vehicles: [{ car: '2019 Honda Civic', plate: 'JO-1' }],
      smsConsent: true,
      agree: true,
      website: '',
    })
    expect(r.statusCode, r.body).toBe(201)
    expect(json(r)).toMatchObject({ status: 'pending_payment', next: 'checkout_link_by_sms', tier: 'gold', plan: 'Gold', confirmationBy: 'sms' })
    expect(await h.db.selectFrom('memberships').select('id').execute()).toEqual([])
    const links = await h.db.selectFrom('client_links').select(['kind', 'plan_key', 'issued_by']).execute()
    expect(links).toEqual([{ kind: 'membership', plan_key: 'gold', issued_by: 'system' }])
    const texts = await h.texts(PHONES.joiner)
    expect(texts.map((t) => t.body)).toEqual([expect.stringMatching(/^Start your Oasis Auto Spa Gold membership on this secure page: https:\/\/[^ ]+\/#\/m\/[A-Za-z0-9_-]{43} It expires in 24 hours\./)])
    const n = await h.db.selectFrom('notifications').select(['kind', 'body']).execute()
    expect(n[0]).toMatchObject({ kind: 'membership.web_join' })
    expect(n[0]!.body).toContain('We texted them their secure membership page to enter a card')
    expect(n.some((x) => /Squarespace/.test(x.body ?? ''))).toBe(false)
    expect(sim.sim.log).toEqual([])
  })
})
