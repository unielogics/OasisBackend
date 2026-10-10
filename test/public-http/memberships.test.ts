// POST /public/memberships over the real app (ADR 0150): a pending membership tied to the tier's Squarespace product, the customer
// and vehicles, the staff notification asking for the checkout link (with the product, or the empty-map alert), the welcome text,
// no card data anywhere, the already-a-member refusal, replay and the honeypot.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { json, PHONES, usePublicHarness } from './harness.js'

const h = usePublicHarness()

const joinBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  tier: 'gold',
  name: 'Jo Joiner',
  phone: PHONES.joiner,
  email: 'jo@example.test',
  vehicles: [
    { car: '2019 Honda Civic', plate: 'JO-1' },
    { car: 'Ford F-150' },
  ],
  smsConsent: true,
  agree: true,
  website: '',
  ...extra,
})
const join = (body: Record<string, unknown>, o: Parameters<typeof h.post>[2] = {}) => h.post('public/memberships', body, o)

const notifications = () => h.db.selectFrom('notifications').select(['kind', 'title', 'body', 'employee_id', 'entity_type', 'entity_id']).orderBy('created_at').execute()

describe('joining on the website', () => {
  it('with an empty product map: the membership stays pending, staff are asked to send the link, an alert is open, the person is texted', async () => {
    const r = await join(joinBody())
    expect(r.statusCode, r.body).toBe(201)
    const b = json(r)
    expect(b).toMatchObject({ status: 'pending_payment', next: 'checkout_link_by_sms', tier: 'gold', plan: 'Gold', confirmationBy: 'sms' })
    expect(b.memberRef).toMatch(/^OAS-M-[0-9A-F]{8}$/)
    const m = await h.db.selectFrom('memberships').innerJoin('membership_plans', 'membership_plans.id', 'memberships.plan_id').select(['memberships.id', 'status', 'source', 'plan_label', 'key', 'sqsp_product_key', 'manual_status_at', 'current_period_start', 'inference_reason', 'customer_id']).executeTakeFirstOrThrow()
    expect(m).toMatchObject({ status: 'pending', source: 'manual', plan_label: 'Gold', key: 'premium', sqsp_product_key: null, manual_status_at: null, current_period_start: null })
    expect(m.inference_reason).toMatch(/product map has no product/)
    expect(b.memberRef).toBe(`OAS-M-${m.id.replace(/-/g, '').slice(-8).toUpperCase()}`)
    const c = await h.db.selectFrom('customers').selectAll().where('id', '=', m.customer_id).executeTakeFirstOrThrow()
    expect(c).toMatchObject({ full_name: 'Jo Joiner', phone_e164: PHONES.joiner, email: 'jo@example.test', source: 'online', sms_opted_in: true, sms_opt_in_source: 'online', synthetic: false })
    const v = await h.db.selectFrom('vehicles').select(['year', 'make', 'model', 'plate']).where('customer_id', '=', c.id).orderBy('created_at').execute()
    expect(v).toEqual([
      { year: 2019, make: 'Honda', model: 'Civic', plate: 'JO-1' },
      { year: null, make: 'Ford', model: 'F-150', plate: null },
    ])
    // no credits before payment
    expect(await h.db.selectFrom('membership_credit_events').select('id').execute()).toEqual([])
    const n = await notifications()
    expect(n.length).toBeGreaterThan(0)
    expect(new Set(n.map((x) => x.kind))).toEqual(new Set(['membership.web_join']))
    expect(n[0]!.title).toBe('Website join: send Jo the Gold checkout link')
    expect(n[0]!.body).toMatch(/^Jo Joiner \(\(201\) 555-0103\) joined Gold on the website\. The Squarespace product map has no product for the Premium plan/)
    expect(n[0]).toMatchObject({ entity_type: 'membership', entity_id: m.id })
    const alerts = await h.db.selectFrom('sqsp_alerts').select(['code', 'message', 'resolved_at']).execute()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({ code: 'product_map_empty', resolved_at: null })
    const texts = await h.texts(PHONES.joiner)
    expect(texts).toHaveLength(1)
    expect(texts[0]!.klass).toBe('membership_welcome_web')
    // the SMS builder normalises to GSM-7 (straight apostrophes) and adds the STOP footer to a first text
    expect(texts[0]!.body).toBe("Hi Jo, thanks for joining Oasis Auto Spa Gold. We'll text your secure checkout link shortly; your membership starts once it's paid. Reply STOP to opt out.")
    const audit = await h.db.selectFrom('audit_log').select(['action', 'actor_name', 'after']).where('action', '=', 'membership.created').executeTakeFirstOrThrow()
    expect(audit.actor_name).toBe('Website')
    expect(JSON.stringify(audit.after)).toContain('"source":"web"')
    // nothing like a card number was accepted or stored anywhere
    expect(JSON.stringify(b)).not.toMatch(/card|cvc|expiry/i)
  })

  it('with the tier’s product mapped: the pending membership carries the product key and staff are told which link to send', async () => {
    await ensurePlans(h.db, { locationId: h.locationId, clock: h.clock, newId: h.newId })
    const exec = await h.db.selectFrom('membership_plans').select('id').where('key', '=', 'executive').executeTakeFirstOrThrow()
    await sql`insert into sqsp_products (id, location_id, sqsp_product_id, sku, name, kind, plan_id, plan_label, interval_months, active, created_at, updated_at)
      values (${h.newId()}, ${h.locationId}, 'prod-vip-1', 'VIP-MONTHLY', 'VIP Membership (monthly)', 'membership', ${exec.id}, 'VIP', 1, true, app_now(), app_now())`.execute(h.db)
    const r = await join(joinBody({ tier: 'vip' }))
    expect(r.statusCode, r.body).toBe(201)
    expect(json(r)).toMatchObject({ tier: 'vip', plan: 'VIP' })
    const m = await h.db.selectFrom('memberships').select(['sqsp_product_key', 'plan_label', 'inference_reason']).executeTakeFirstOrThrow()
    expect(m).toEqual({ sqsp_product_key: 'prod-vip-1', plan_label: 'VIP', inference_reason: 'Joined on the website; awaiting the Squarespace checkout of VIP Membership (monthly)' })
    const n = await notifications()
    expect(n[0]!.body).toMatch(/Text them the Squarespace checkout link for "VIP Membership \(monthly\)"/)
    expect(await h.db.selectFrom('sqsp_alerts').select('id').execute()).toEqual([])
  })

  it('refuses a second membership for the number (409, the design’s voice) and bad input (422), writing nothing', async () => {
    expect((await join(joinBody())).statusCode).toBe(201)
    const again = await join(joinBody({ tier: 'vip' }))
    expect(again.statusCode).toBe(409)
    expect(json(again)).toMatchObject({ code: 'PUBLIC_ALREADY_MEMBER', detail: 'This number already has a membership. Text us to change your plan.' })
    expect(await h.db.selectFrom('memberships').select('id').execute()).toHaveLength(1)
    for (const [extra, path] of [
      [{ agree: false }, 'body.agree'],
      [{ tier: 'platinum' }, 'body.tier'],
      [{ vehicles: [] }, 'body.vehicles'],
      [{ email: 'nope' }, 'body.email'],
      [{ card: '4242 4242 4242 4242' }, 'body'],
      [{ phone: '1' }, 'body.phone'],
      [{ phone: '+8613800138000' }, 'body.phone'],
      [{ phone: '+18885551234' }, 'body.phone'],
    ] as [Record<string, unknown>, string][]) {
      const r = await join(joinBody({ ...extra, phone: (extra.phone as string) ?? PHONES.extra }))
      expect(r.statusCode, JSON.stringify(extra)).toBe(422)
      expect(JSON.stringify(json(r).errors), JSON.stringify(extra)).toContain(path)
    }
    expect(await h.db.selectFrom('memberships').select('id').execute()).toHaveLength(1)
  })

  it('replays the same key, needs a key, and answers the honeypot with a fake reference and no record', async () => {
    const key = h.nextKey()
    const ip = h.nextIp()
    const first = await join(joinBody(), { key, ip })
    const again = await join(joinBody(), { key, ip })
    expect(again.statusCode).toBe(201)
    expect(again.headers['idempotent-replayed']).toBe('true')
    expect(json(again)).toEqual(json(first))
    expect(await h.db.selectFrom('memberships').select('id').execute()).toHaveLength(1)
    expect((await join(joinBody(), { key: null })).statusCode).toBe(400)
    const decoy = await join(joinBody({ phone: PHONES.extra, website: 'spam' }))
    expect(decoy.statusCode).toBe(202)
    expect(json(decoy).memberRef).toMatch(/^OAS-M-/)
    expect(await h.db.selectFrom('memberships').select('id').execute()).toHaveLength(1)
    expect(await h.db.selectFrom('customers').select('id').where('phone_e164', '=', PHONES.extra).execute()).toEqual([])
  })

  it('limits a number to 2 joins a day from one address and 3 in all (429)', async () => {
    const one = '10.94.1.1'
    for (let i = 0; i < 2; i++) {
      const r = await join(joinBody({ tier: i === 0 ? 'gold' : 'vip' }), { ip: one })
      expect([201, 409], `join ${i + 1}: ${r.body}`).toContain(r.statusCode)
    }
    expect(json(await join(joinBody(), { ip: one })).code).toBe('PUBLIC_RATE_LIMITED')
    expect((await join(joinBody(), { ip: '10.94.1.2' })).statusCode).not.toBe(429)
    const fourth = await join(joinBody(), { ip: '10.94.1.3' })
    expect(fourth.statusCode).toBe(429)
    expect(json(fourth).code).toBe('PUBLIC_RATE_LIMITED')
  })

  it('one address naming a number over and over cannot lock its owner out of joining', async () => {
    const attacker = '10.94.2.1'
    const answers = []
    for (let i = 0; i < 10; i++) answers.push((await join(joinBody({ phone: PHONES.extra, name: 'Not The Owner' }), { ip: attacker })).statusCode)
    expect(answers.slice(2)).toEqual([429, 429, 429, 429, 429, 429, 429, 429])
    expect((await join(joinBody({ phone: PHONES.extra }), { ip: '10.94.2.2' })).statusCode).not.toBe(429)
  })
})
