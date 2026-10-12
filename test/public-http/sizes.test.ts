// The website's booking and join flows take a vehicle size (ADR 0170, wave Q2). The size chip prices the visit; an old cached page's
// "Sedan / Coupe" sent as the car is the size, never a car named "Sedan"; a guest's size prices the visit but never reaches someone
// else's record; member prices only for the verified owner of a member's number; the answer carries the pricing; the confirmation
// says the exact price is confirmed at the shop when the size is not known. The join names a plan size the tier has a price for.
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { ensureVehicleClasses } from '../../src/modules/catalog/vehicle-classes.js'
import { upsertCustomerByPhone, upsertVehicleByPlate } from '../../src/modules/customers/service.js'
import { createManualMembership } from '../../src/modules/memberships/service.js'
import { bookingBody, json, PHONES, usePublicHarness } from './harness.js'

const h = usePublicHarness()
const book = (body: Record<string, unknown>) => h.post('public/bookings', body)

async function cells(name: string, prices: Record<string, number>): Promise<void> {
  await ensureVehicleClasses(h.db, h.locationId)
  const s = await h.db.selectFrom('services').select('id').where('name', '=', name).executeTakeFirstOrThrow()
  await h.db.deleteFrom('service_class_prices').where('service_id', '=', s.id).execute()
  for (const [cls, cents] of Object.entries(prices))
    await h.db.insertInto('service_class_prices').values({ service_id: s.id, location_id: h.locationId, class_key: cls, price_cents: cents }).execute()
}

async function tokenFor(phone: string): Promise<string> {
  const { challengeId } = json(await h.post('public/otp', { phone }))
  const r = await h.post('public/otp/verify', { challengeId, code: await h.codeSentTo(phone, challengeId) })
  expect(r.statusCode, r.body).toBe(200)
  return json(r).memberToken as string
}

async function goldMember(phone: string, discountBp: number): Promise<string> {
  const id = await h.db.transaction().execute(async (tx) => {
    const { customer } = await upsertCustomerByPhone(tx, { newId: h.newId, now: h.clock.now(), fullName: 'Mia Member', phone, email: 'mia@example.test', source: 'dashboard' })
    await createManualMembership(tx, { locationId: h.locationId, clock: h.clock, newId: h.newId }, { customerId: customer.id, planKey: 'gold', planLabel: 'Gold' }, { userId: 'test', name: 'Test', audit: {} })
    return customer.id
  })
  // the tiers exist once the first membership was made (ensurePlans)
  await h.db.updateTable('membership_plans').set({ member_discount_bp: discountBp }).where('key', '=', 'gold').execute()
  return id
}

const lastAppointment = () =>
  h.db
    .selectFrom('appointments')
    .select(['id', 'customer_id', 'vehicle_id', 'price_cents', 'list_price_cents', 'discount_bp', 'price_basis', 'vehicle_class', 'membership_id'])
    .orderBy('seq', 'desc')
    .executeTakeFirstOrThrow()

describe('sizes on the website', () => {
  it('"Sedan / Coupe" (an old page’s size chip sent as the car) creates no vehicle and prices at Compact car; "SUV / Crossover" at Compact SUV', async () => {
    await cells('Express Hand Wash', { compact_car: 4000, compact_suv: 5000 })
    const r = await book(bookingBody(h, { vehicle: { label: 'Sedan / Coupe' } }))
    expect(r.statusCode, r.body).toBe(201)
    const a = await lastAppointment()
    expect(a).toMatchObject({ vehicle_id: null, vehicle_class: 'compact_car', price_cents: 4000, price_basis: 'class' })
    expect(await h.db.selectFrom('vehicles').select('id').where('customer_id', '=', a.customer_id).execute()).toEqual([])
    expect(json(r).pricing).toEqual({ vehicleClass: 'compact_car', vehicleClassLabel: 'Compact car', confirmAtShop: false, listCents: 4000, discountCents: 0, coveredCents: 0, dueCents: 4000 })
    const s = await book(bookingBody(h, { vehicle: { label: 'SUV / Crossover' }, startMin: 14 * 60 }))
    expect(s.statusCode, s.body).toBe(201)
    expect(await lastAppointment()).toMatchObject({ vehicle_id: null, vehicle_class: 'compact_suv', price_cents: 5000 })
    // the shop's own size labels count too
    const t = await book(bookingBody(h, { vehicle: { label: 'compact suv' }, startMin: 15 * 60 }))
    expect(t.statusCode, t.body).toBe(201)
    expect(await lastAppointment()).toMatchObject({ vehicle_id: null, vehicle_class: 'compact_suv' })
  })

  it('the size chip prices the visit and is written on the new client’s car (source client)', async () => {
    await cells('Express Hand Wash', { compact_car: 4000, large_suv: 6000 })
    const r = await book(bookingBody(h, { vehicleClass: 'large_suv' }))
    expect(r.statusCode, r.body).toBe(201)
    expect(json(r).pricing).toMatchObject({ vehicleClass: 'large_suv', vehicleClassLabel: 'Large SUV', listCents: 6000, dueCents: 6000 })
    const a = await lastAppointment()
    expect(a).toMatchObject({ price_cents: 6000, list_price_cents: 6000, vehicle_class: 'large_suv' })
    const v = await h.db.selectFrom('vehicles').select(['make', 'vehicle_class', 'vehicle_class_source']).where('id', '=', a.vehicle_id!).executeTakeFirstOrThrow()
    expect(v).toEqual({ make: 'Tesla', vehicle_class: 'large_suv', vehicle_class_source: 'client' })
    // a size that is not one of the shop's
    const bad = await book(bookingBody(h, { vehicleClass: 'limo', startMin: 14 * 60 }))
    expect(bad.statusCode).toBe(422)
    expect(bad.body).toContain('body.vehicleClass')
  })

  it('a guest’s size never reaches someone else’s record: the number’s client keeps their car as it is', async () => {
    await cells('Express Hand Wash', { compact_car: 4000, large_suv: 6000 })
    const owner = await h.db.transaction().execute(async (tx) => {
      const { customer } = await upsertCustomerByPhone(tx, { newId: h.newId, now: h.clock.now(), fullName: 'Olga Owner', phone: PHONES.extra, email: null, source: 'dashboard' })
      await upsertVehicleByPlate(tx, { newId: h.newId, customerId: customer.id, make: 'Tesla', model: 'Model 3', plate: 'NJ-NINA1' })
      return customer.id
    })
    const r = await book(bookingBody(h, { phone: PHONES.extra, vehicleClass: 'large_suv' }))
    expect(r.statusCode, r.body).toBe(201)
    const a = await lastAppointment()
    expect(a).toMatchObject({ customer_id: owner, vehicle_id: null, vehicle_class: 'large_suv', price_cents: 6000 })
    const cars = await h.db.selectFrom('vehicles').select(['vehicle_class', 'vehicle_class_source']).where('customer_id', '=', owner).execute()
    expect(cars).toEqual([{ vehicle_class: null, vehicle_class_source: null }])
  })

  it('an unverified member’s number gets the regular price; the verified member gets the member price', async () => {
    await cells('Express Hand Wash', { compact_car: 4000 })
    await goldMember(PHONES.member, 1000)
    const guest = await book(bookingBody(h, { phone: PHONES.member, vehicleClass: 'compact_car' }))
    expect(guest.statusCode, guest.body).toBe(201)
    expect(json(guest)).toMatchObject({ member: false, pricing: { listCents: 4000, discountCents: 0, dueCents: 4000 } })
    expect(await lastAppointment()).toMatchObject({ price_cents: 4000, discount_bp: 0, membership_id: null })
    const token = await tokenFor(PHONES.member)
    const verified = await book(bookingBody(h, { phone: PHONES.member, name: 'Mia Member', vehicleClass: 'compact_car', memberToken: token, startMin: 14 * 60 }))
    expect(verified.statusCode, verified.body).toBe(201)
    expect(json(verified)).toMatchObject({ member: true, pricing: { listCents: 4000, discountCents: 400, dueCents: 3600 } })
    const a = await lastAppointment()
    expect(a).toMatchObject({ price_cents: 3600, list_price_cents: 4000, discount_bp: 1000 })
    expect(a.membership_id).not.toBeNull()
  })

  it('with no size known the visit is priced at the smallest size and the text says the exact price is confirmed at the shop', async () => {
    await cells('Express Hand Wash', { compact_car: 4000, large_suv: 6000 })
    const r = await book(bookingBody(h, { vehicle: { label: '2021 Tesla Model 3' } }))
    expect(r.statusCode, r.body).toBe(201)
    expect(json(r).pricing).toMatchObject({ vehicleClass: null, confirmAtShop: true, listCents: 4000 })
    expect(await lastAppointment()).toMatchObject({ price_basis: 'unknown_class', price_cents: 4000 })
    const texts = await h.texts(PHONES.guest)
    expect(texts.at(-1)!.body).toMatch(/\$25 booking fee due at the shop\. We.ll confirm the exact price at the shop\. Reply here to change it\./)
  })

  it('a service with one price for every size asks nothing', async () => {
    await cells('Express Hand Wash', {})
    const r = await book(bookingBody(h))
    expect(r.statusCode, r.body).toBe(201)
    expect(json(r).pricing).toMatchObject({ confirmAtShop: false, listCents: 4500 })
    expect((await h.texts(PHONES.guest)).at(-1)!.body).not.toContain('exact price')
  })

  it('the honeypot’s answer prices the visit as a real booking would (review F6); nothing is written', async () => {
    await cells('Express Hand Wash', { compact_car: 4000, large_suv: 6000 })
    const real = await book(bookingBody(h, { vehicleClass: 'large_suv' }))
    expect(real.statusCode, real.body).toBe(201)
    const before = await h.db.selectFrom('appointments').select('id').execute()
    const decoy = await book(bookingBody(h, { vehicleClass: 'large_suv', website: 'http://spam.example', phone: PHONES.extra, startMin: 14 * 60 }))
    expect(decoy.statusCode).toBe(202)
    expect(json(decoy).pricing).toEqual(json(real).pricing)
    expect(json(decoy).pricing).toMatchObject({ vehicleClassLabel: 'Large SUV', listCents: 6000, dueCents: 6000 })
    // a size the shop does not have is refused the same way
    const bad = await book(bookingBody(h, { vehicleClass: 'boat', website: 'http://spam.example', phone: PHONES.extra }))
    expect(bad.statusCode).toBe(422)
    expect(await h.db.selectFrom('appointments').select('id').execute()).toEqual(before)
  })
})

describe('the plan size on the website’s join', () => {
  const joinBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    tier: 'gold',
    name: 'Jo Joiner',
    phone: PHONES.joiner,
    email: 'jo@example.test',
    vehicles: [{ car: '2019 Honda Civic' }],
    smsConsent: true,
    agree: true,
    website: '',
    ...extra,
  })
  const goldPrice = async (cls: string, cents: number) => {
    await ensureVehicleClasses(h.db, h.locationId)
    const plan = await h.db.selectFrom('membership_plans').select(['id', 'price_version']).where('key', '=', 'gold').executeTakeFirstOrThrow()
    await sql`update membership_tier_prices set superseded_at = app_now() where plan_id = ${plan.id} and superseded_at is null`.execute(h.db)
    await h.db
      .insertInto('membership_tier_prices')
      .values({ id: h.newId(), location_id: h.locationId, plan_id: plan.id, class_key: cls, monthly_cents: cents, price_version: plan.price_version })
      .execute()
  }

  it('a size the tier has no price for is refused (422 TIER_CLASS_UNPRICED); a priced one is stored; none: the cheapest priced size', async () => {
    // the plans exist once the catalog was read (ensurePlans on the first join)
    expect((await h.post('public/memberships', joinBody({ phone: PHONES.otp, name: 'Warm Up' }))).statusCode).toBe(201)
    await goldPrice('compact_suv', 14900)
    const no = await h.post('public/memberships', joinBody({ planClass: 'truck' }))
    expect(no.statusCode, no.body).toBe(422)
    expect(json(no).code).toBe('TIER_CLASS_UNPRICED')
    expect(await h.db.selectFrom('memberships').select('id').where('plan_class', '=', 'truck').execute()).toEqual([])
    const yes = await h.post('public/memberships', joinBody({ planClass: 'compact_suv' }))
    expect(yes.statusCode, yes.body).toBe(201)
    expect(json(yes)).toMatchObject({ planClass: 'compact_suv', planClassLabel: 'Compact SUV', monthlyCents: 14900 })
    const row = await h.db
      .selectFrom('memberships as m')
      .innerJoin('customers as c', 'c.id', 'm.customer_id')
      .select(['m.plan_class', 'm.tier_price_id'])
      .where('c.phone_e164', '=', PHONES.joiner)
      .executeTakeFirstOrThrow()
    expect(row.plan_class).toBe('compact_suv')
    expect(row.tier_price_id).not.toBeNull()
    // no size named (an older page): the tier's cheapest priced size
    const old = await h.post('public/memberships', joinBody({ phone: PHONES.extra, name: 'Old Page' }))
    expect(old.statusCode, old.body).toBe(201)
    expect(json(old)).toMatchObject({ planClass: 'compact_suv' })
  })
  it('the honeypot’s join answers the size, its label and price as a real join would (review F6); nothing is created', async () => {
    expect((await h.post('public/memberships', joinBody({ phone: PHONES.otp, name: 'Warm Up' }))).statusCode).toBe(201)
    await goldPrice('compact_suv', 14900)
    const decoy = await h.post('public/memberships', joinBody({ website: 'spam', phone: PHONES.extra }))
    expect(decoy.statusCode, decoy.body).toBe(202)
    expect(json(decoy)).toMatchObject({ plan: 'Gold', planClass: 'compact_suv', planClassLabel: 'Compact SUV', monthlyCents: 14900 })
    const unpriced = await h.post('public/memberships', joinBody({ website: 'spam', phone: PHONES.extra, planClass: 'truck' }))
    expect(unpriced.statusCode).toBe(422)
    expect(json(unpriced).code).toBe('TIER_CLASS_UNPRICED')
    expect(await h.db.selectFrom('customers').select('id').where('phone_e164', '=', PHONES.extra).execute()).toEqual([])
  })

  it('a verified household member’s join is refused as already a member (review F3): no membership of their own', async () => {
    const holderId = await goldMember(PHONES.member, 0)
    const holder = await h.db.selectFrom('memberships').select('id').where('customer_id', '=', holderId).executeTakeFirstOrThrow()
    const jo = await h.db.transaction().execute(async (tx) =>
      (await upsertCustomerByPhone(tx, { newId: h.newId, now: h.clock.now(), fullName: 'Jo Joiner', phone: PHONES.joiner, email: 'jo@example.test', source: 'dashboard' })).customer.id,
    )
    await h.db.insertInto('membership_household').values({ id: h.newId(), membership_id: holder.id, customer_id: jo, added_by: null, removed_at: null }).execute()
    const token = await tokenFor(PHONES.joiner)
    const r = await h.post('public/memberships', joinBody({ memberToken: token }))
    expect(r.statusCode, r.body).toBe(409)
    expect(json(r).code).toBe('PUBLIC_ALREADY_MEMBER')
    expect(await h.db.selectFrom('memberships').select('id').where('customer_id', '=', jo).execute()).toEqual([])
  })
})
