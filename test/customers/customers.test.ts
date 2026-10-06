import { describe, expect, it } from 'vitest'
import { transaction } from '../../src/platform/db.js'
import { isAppError } from '../../src/platform/errors.js'
import {
  findCustomerByPhone,
  findVehiclesByPlate,
  getCustomer,
  isVipCustomer,
  listVehicles,
  normalizePlate,
  recordSmsOptIn,
  recordSmsOptOut,
  redactCustomer,
  searchCustomers,
  softDeleteVehicle,
  updateCustomer,
  upsertCustomerByPhone,
  upsertVehicleByPlate,
  vipCustomerIds,
} from '../../src/modules/customers/index.js'
import { useTestDb } from '../helpers/db.js'
import { makeCustomer, makeVehicle, setupLocation } from '../domain-schema/helpers.js'

const t = useTestDb({ poolMax: 6 })

async function appError(p: Promise<unknown>) {
  try {
    await p
  } catch (e) {
    if (isAppError(e)) return e
    throw e
  }
  throw new Error('expected an AppError')
}

const upsert = async (
  f: Awaited<ReturnType<typeof setupLocation>>,
  o: Partial<Parameters<typeof upsertCustomerByPhone>[1]> = {},
) =>
  transaction(t.db, (tx) =>
    upsertCustomerByPhone(tx, {
      newId: f.newId,
      now: t.clock.now(),
      source: 'walk_in',
      synthetic: true,
      ...o,
    }),
  )

describe('upsertCustomerByPhone', () => {
  it('normalizes the number to E.164, keeps a display form and records the opt-in', async () => {
    const f = await setupLocation(t)
    const r = await upsert(f, {
      fullName: ' Maria Delgado ',
      phone: '(305) 555-0142',
      email: 'maria@example.com',
      smsOptIn: 'walk_in',
    })
    expect(r).toMatchObject({ created: true, changed: true })
    expect(r.customer).toMatchObject({
      fullName: 'Maria Delgado',
      phoneE164: '+13055550142',
      phoneDisplay: '(305) 555-0142',
      email: 'maria@example.com',
      smsOptedIn: true,
      smsOptInSource: 'walk_in',
      source: 'walk_in',
      synthetic: true,
      needsDetails: false,
      version: 1,
    })
    expect(r.customer.smsOptInAt?.toISOString()).toBe('2026-06-13T14:36:00.000Z')
  })

  it('returns the same customer for any spelling of the same number', async () => {
    const f = await setupLocation(t)
    const a = await upsert(f, { fullName: 'Maria Delgado', phone: '(305) 555-0142' })
    const b = await upsert(f, { fullName: 'Someone Else', phone: '+1 305-555-0142' })
    const c = await upsert(f, { phone: '3055550142' })
    expect([b.created, c.created]).toEqual([false, false])
    expect(b.customer.id).toBe(a.customer.id)
    expect(c.customer.id).toBe(a.customer.id)
    expect(b.customer.fullName).toBe('Maria Delgado')
    expect(b.changed).toBe(false)
    expect(await t.db.selectFrom('customers').select('id').execute()).toHaveLength(1)
  })

  it('fills a missing email or note but never overwrites, and bumps the version only when something changed', async () => {
    const f = await setupLocation(t)
    const a = await upsert(f, { fullName: 'Maria', phone: '(305) 555-0142' })
    const b = await upsert(f, { phone: '(305) 555-0142', email: 'maria@example.com', notes: 'Likes a text' })
    expect(b.changed).toBe(true)
    expect(b.customer).toMatchObject({ email: 'maria@example.com', notes: 'Likes a text', version: 2 })
    const c = await upsert(f, { phone: '(305) 555-0142', email: 'other@example.com', notes: 'Different' })
    expect(c.changed).toBe(false)
    expect(c.customer).toMatchObject({ email: 'maria@example.com', notes: 'Likes a text', version: 2 })
    expect(a.customer.version).toBe(1)
  })

  it('creates a walk-in without a number as a placeholder that needs details, and completes it from a later visit', async () => {
    const f = await setupLocation(t)
    const noPhone = await upsert(f, { fullName: 'Pat' })
    expect(noPhone.customer).toMatchObject({ phoneE164: null, needsDetails: true })
    const anonymous = await upsert(f, { phone: '(305) 555-0143' })
    expect(anonymous.customer).toMatchObject({ fullName: 'Walk-in guest', needsDetails: true })
    const named = await upsert(f, { phone: '(305) 555-0143', fullName: 'Grace Adeyemi' })
    expect(named.customer).toMatchObject({
      id: anonymous.customer.id,
      fullName: 'Grace Adeyemi',
      needsDetails: false,
    })
    const again = await upsert(f, { fullName: 'Pat' })
    expect(again.created).toBe(true)
  })

  it('rejects numbers that are not valid', async () => {
    const f = await setupLocation(t)
    const e = await appError(upsert(f, { fullName: 'X', phone: '12345' }))
    expect(e.code).toBe('VALIDATION_FAILED')
    expect(e.errors).toEqual([{ path: 'phone', message: 'Enter a valid mobile number.' }])
  })

  it('does not opt a customer back in who has opted out, and opts in one who never did', async () => {
    const f = await setupLocation(t)
    const out = await makeCustomer(t.db, f, { line: '0160', optedOut: true })
    const r = await upsert(f, { phone: '(305) 555-0160', smsOptIn: 'dashboard' })
    expect(r.customer.id).toBe(out)
    expect(r.customer).toMatchObject({ smsOptedIn: false })
    expect(r.customer.smsOptedOutAt).not.toBeNull()
    const fresh = await upsert(f, { fullName: 'New', phone: '(305) 555-0161' })
    expect(fresh.customer.smsOptedIn).toBe(false)
    const later = await upsert(f, { phone: '(305) 555-0161', smsOptIn: 'online' })
    expect(later.customer).toMatchObject({ smsOptedIn: true, smsOptInSource: 'online' })
  })

  it('creates one row when the same new number is upserted concurrently', async () => {
    const f = await setupLocation(t)
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => upsert(f, { fullName: `Racer ${i}`, phone: '(305) 555-0170' })),
    )
    expect(results.filter((r) => r.created)).toHaveLength(1)
    expect(new Set(results.map((r) => r.customer.id)).size).toBe(1)
    expect(
      await t.db.selectFrom('customers').select('id').where('phone_e164', '=', '+13055550170').execute(),
    ).toHaveLength(1)
  })

  it('refuses a real-looking number on a synthetic customer (database guard)', async () => {
    const f = await setupLocation(t)
    await expect(
      upsert(f, { fullName: 'X', phone: '(305) 412-8890', synthetic: true }),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('finds a live customer by phone and ignores deleted or merged ones', async () => {
    const f = await setupLocation(t)
    const a = await upsert(f, { fullName: 'A', phone: '(305) 555-0180' })
    expect((await findCustomerByPhone(t.db, '+13055550180'))?.id).toBe(a.customer.id)
    await t.db
      .updateTable('customers')
      .set({ deleted_at: new Date('2026-06-01T00:00:00Z') })
      .where('id', '=', a.customer.id)
      .execute()
    expect(await findCustomerByPhone(t.db, '+13055550180')).toBeUndefined()
    const b = await upsert(f, { fullName: 'B', phone: '(305) 555-0180' })
    expect(b.created).toBe(true)
  })
})

describe('updateCustomer and SMS consent', () => {
  it('edits with a version check and recomputes needs_details', async () => {
    const f = await setupLocation(t)
    const a = await upsert(f, { phone: '(305) 555-0143' })
    const edited = await transaction(t.db, (tx) =>
      updateCustomer(tx, {
        id: a.customer.id,
        expectedVersion: 1,
        patch: { fullName: 'Grace Adeyemi', email: 'g@example.com' },
      }),
    )
    expect(edited).toMatchObject({
      fullName: 'Grace Adeyemi',
      email: 'g@example.com',
      needsDetails: false,
      version: 2,
    })
    const e = await appError(
      transaction(t.db, (tx) =>
        updateCustomer(tx, { id: a.customer.id, expectedVersion: 1, patch: { notes: 'x' } }),
      ),
    )
    expect(e.code).toBe('VERSION_CONFLICT')
    const cleared = await transaction(t.db, (tx) =>
      updateCustomer(tx, { id: a.customer.id, patch: { phone: null } }),
    )
    expect(cleared).toMatchObject({ phoneE164: null, phoneDisplay: null, needsDetails: true })
  })

  it('reports a number that another live customer already owns', async () => {
    const f = await setupLocation(t)
    await upsert(f, { fullName: 'A', phone: '(305) 555-0190' })
    const b = await upsert(f, { fullName: 'B', phone: '(305) 555-0191' })
    const e = await appError(
      transaction(t.db, (tx) =>
        updateCustomer(tx, { id: b.customer.id, patch: { phone: '(305) 555-0190' } }),
      ),
    )
    expect(e.code).toBe('CUSTOMER_PHONE_IN_USE')
    expect(e.status).toBe(409)
  })

  it('records opt-out and a later opt-in', async () => {
    const f = await setupLocation(t)
    const a = await upsert(f, { fullName: 'A', phone: '(305) 555-0192', smsOptIn: 'dashboard' })
    const out = await transaction(t.db, (tx) =>
      recordSmsOptOut(tx, a.customer.id, new Date('2026-06-13T15:00:00Z')),
    )
    expect(out).toMatchObject({ smsOptedIn: false })
    expect(out.smsOptedOutAt?.toISOString()).toBe('2026-06-13T15:00:00.000Z')
    const back = await transaction(t.db, (tx) =>
      recordSmsOptIn(tx, a.customer.id, 'keyword', new Date('2026-06-14T15:00:00Z')),
    )
    expect(back).toMatchObject({ smsOptedIn: true, smsOptInSource: 'keyword', smsOptedOutAt: null })
  })
})

describe('vehicles', () => {
  it('upserts by plate, case-insensitively, filling details without duplicating', async () => {
    const f = await setupLocation(t)
    const c = await makeCustomer(t.db, f)
    const v = (o: Partial<Parameters<typeof upsertVehicleByPlate>[1]>) =>
      transaction(t.db, (tx) => upsertVehicleByPlate(tx, { newId: f.newId, customerId: c, ...o }))
    const a = await v({ plate: ' klp 8842 ', make: 'Audi', model: 'Q5', year: 2021 })
    expect(a.created).toBe(true)
    expect(a.vehicle).toMatchObject({ plate: 'KLP 8842', make: 'Audi', model: 'Q5', year: 2021, color: null })
    const b = await v({ plate: 'KLP 8842', color: 'Pearl White' })
    expect(b.created).toBe(false)
    expect(b.vehicle).toMatchObject({ id: a.vehicle.id, color: 'Pearl White', make: 'Audi' })
    expect(await listVehicles(t.db, c)).toHaveLength(1)
  })

  it('revives a soft-deleted vehicle when the same plate comes back', async () => {
    const f = await setupLocation(t)
    const c = await makeCustomer(t.db, f)
    const id = await makeVehicle(t.db, f, c, { plate: 'ABC-1234' })
    await transaction(t.db, (tx) => softDeleteVehicle(tx, id))
    expect(await listVehicles(t.db, c)).toHaveLength(0)
    const r = await transaction(t.db, (tx) =>
      upsertVehicleByPlate(tx, { newId: f.newId, customerId: c, plate: 'abc-1234' }),
    )
    expect(r).toMatchObject({ created: false, vehicle: { id, deletedAt: null } })
    expect(await listVehicles(t.db, c)).toHaveLength(1)
  })

  it('reuses an identical plate-less vehicle and adds a different one', async () => {
    const f = await setupLocation(t)
    const c = await makeCustomer(t.db, f)
    const v = (o: Partial<Parameters<typeof upsertVehicleByPlate>[1]>) =>
      transaction(t.db, (tx) => upsertVehicleByPlate(tx, { newId: f.newId, customerId: c, ...o }))
    const a = await v({ make: 'Jeep', model: 'Wrangler', color: 'Green', year: 2017 })
    const b = await v({ make: 'Jeep', model: 'Wrangler', color: 'Green', year: 2017 })
    const d = await v({ make: 'Jeep', model: 'Wrangler', color: 'Black', year: 2017 })
    expect(b.vehicle.id).toBe(a.vehicle.id)
    expect(d.created).toBe(true)
    expect(await listVehicles(t.db, c)).toHaveLength(2)
  })

  it('lets two customers share a plate and finds vehicles by plate across customers', async () => {
    const f = await setupLocation(t)
    const c1 = await makeCustomer(t.db, f)
    const c2 = await makeCustomer(t.db, f)
    await makeVehicle(t.db, f, c1, { plate: 'XYZ-1' })
    await makeVehicle(t.db, f, c2, { plate: 'XYZ-1' })
    expect(await findVehiclesByPlate(t.db, 'xyz-1')).toHaveLength(2)
    expect(await findVehiclesByPlate(t.db, '   ')).toEqual([])
    expect(normalizePlate('  ab  12 ')).toBe('AB 12')
  })

  it('rejects an impossible model year', async () => {
    const f = await setupLocation(t)
    const c = await makeCustomer(t.db, f)
    const e = await appError(
      transaction(t.db, (tx) =>
        upsertVehicleByPlate(tx, { newId: f.newId, customerId: c, plate: 'A1', year: 1850 }),
      ),
    )
    expect(e.errors?.[0]?.path).toBe('year')
  })
})

describe('searchCustomers', () => {
  async function seedPeople() {
    const f = await setupLocation(t)
    const maria = await makeCustomer(t.db, f, {
      name: 'Maria Delgado',
      line: '0102',
      email: 'maria@oasis.test',
    })
    const liam = await makeCustomer(t.db, f, { name: 'Liam Chen', line: '0107', email: 'liam@oasis.test' })
    const marcus = await makeCustomer(t.db, f, { name: 'Marcus Webb', line: '0108' })
    await makeVehicle(t.db, f, maria, { make: 'Audi', model: 'Q5', plate: 'KLP-8842', year: 2021 })
    await makeVehicle(t.db, f, liam, { make: 'BMW', model: 'M340i', plate: 'BMW-3401', year: 2020 })
    await makeVehicle(t.db, f, marcus, { make: 'Jeep', model: 'Wrangler', plate: 'JEP-7720', year: 2017 })
    await t.db.insertInto('vip_clients').values({ location_id: f.locationId, customer_id: liam }).execute()
    return { f, maria, liam, marcus }
  }
  const names = (hits: { fullName: string }[]) => hits.map((h) => h.fullName)

  it('matches names and vehicle details for everyone, with every token required', async () => {
    const { f } = await seedPeople()
    const s = (q: string, canContact = false) =>
      searchCustomers(t.db, { locationId: f.locationId, q, canContact })
    expect(names(await s('mar'))).toEqual(['Marcus Webb', 'Maria Delgado'])
    expect(names(await s('mar delg'))).toEqual(['Maria Delgado'])
    expect(names(await s('klp-8842'))).toEqual(['Maria Delgado'])
    expect(names(await s('jeep wrangler'))).toEqual(['Marcus Webb'])
    expect(names(await s('nobody'))).toEqual([])
    expect(await s('   ')).toEqual([])
  })

  it('excludes phone and email tokens when the caller lacks cli.contact', async () => {
    const { f } = await seedPeople()
    const noContact = (q: string) => searchCustomers(t.db, { locationId: f.locationId, q, canContact: false })
    const withContact = (q: string) =>
      searchCustomers(t.db, { locationId: f.locationId, q, canContact: true })
    for (const q of ['0107', '555-0107', '(305) 555-0107', '+13055550107', 'liam@oasis.test', '@oasis.test'])
      expect(await noContact(q), q).toEqual([])
    expect(names(await withContact('0107'))).toEqual(['Liam Chen'])
    expect(names(await withContact('(305) 555-0107'))).toEqual(['Liam Chen'])
    expect(names(await withContact('liam@oasis.test'))).toEqual(['Liam Chen'])
    expect(names(await withContact('oasis.test'))).toEqual(['Liam Chen', 'Maria Delgado'])
  })

  it('does not let a contact token narrow a name search for a caller without cli.contact', async () => {
    const { f } = await seedPeople()
    expect(
      await searchCustomers(t.db, { locationId: f.locationId, q: 'liam 0107', canContact: false }),
    ).toEqual([])
    expect(
      names(await searchCustomers(t.db, { locationId: f.locationId, q: 'liam 0107', canContact: true })),
    ).toEqual(['Liam Chen'])
  })

  it('redacts contact fields in the result and flags VIPs', async () => {
    const { f } = await seedPeople()
    const open = await searchCustomers(t.db, { locationId: f.locationId, q: 'liam', canContact: true })
    expect(open[0]).toMatchObject({ phoneDisplay: '(305) 555-0107', email: 'liam@oasis.test', vip: true })
    expect(open[0]!.vehicles.map((v) => v.plate)).toEqual(['BMW-3401'])
    const closed = await searchCustomers(t.db, { locationId: f.locationId, q: 'liam', canContact: false })
    expect(closed[0]).toMatchObject({ phoneDisplay: null, email: null, vip: true })
    const maria = await searchCustomers(t.db, { locationId: f.locationId, q: 'maria', canContact: false })
    expect(maria[0]!.vip).toBe(false)
  })

  it('treats LIKE wildcards literally, hides deleted and merged customers and caps the limit', async () => {
    const { f, maria, liam } = await seedPeople()
    expect(await searchCustomers(t.db, { locationId: f.locationId, q: '%', canContact: true })).toEqual([])
    expect(await searchCustomers(t.db, { locationId: f.locationId, q: '_____', canContact: true })).toEqual(
      [],
    )
    await t.db
      .updateTable('customers')
      .set({ deleted_at: new Date('2026-06-01T00:00:00Z') })
      .where('id', '=', maria)
      .execute()
    await t.db
      .updateTable('customers')
      .set({ merged_into: liam })
      .where('full_name', '=', 'Marcus Webb')
      .execute()
    expect(await searchCustomers(t.db, { locationId: f.locationId, q: 'mar', canContact: true })).toEqual([])
    for (let i = 0; i < 5; i++) await makeCustomer(t.db, f, { name: `Zed ${i}`, noPhone: true })
    expect(
      await searchCustomers(t.db, { locationId: f.locationId, q: 'zed', canContact: false, limit: 3 }),
    ).toHaveLength(3)
  })

  it('redactCustomer blanks phone and email', async () => {
    const f = await setupLocation(t)
    const id = await makeCustomer(t.db, f, { email: 'a@b.co' })
    const c = (await getCustomer(t.db, id))!
    expect(redactCustomer(c)).toMatchObject({
      phoneE164: null,
      phoneDisplay: null,
      email: null,
      redacted: true,
      fullName: c.fullName,
    })
  })
})

describe('VIP flag', () => {
  it('is membership of vip_clients for the location', async () => {
    const f = await setupLocation(t)
    const a = await makeCustomer(t.db, f)
    const b = await makeCustomer(t.db, f)
    await t.db.insertInto('vip_clients').values({ location_id: f.locationId, customer_id: a }).execute()
    expect(await isVipCustomer(t.db, f.locationId, a)).toBe(true)
    expect(await isVipCustomer(t.db, f.locationId, b)).toBe(false)
    expect([...(await vipCustomerIds(t.db, f.locationId, [a, b]))]).toEqual([a])
    expect(await vipCustomerIds(t.db, f.locationId, [])).toEqual(new Set())
    expect(await vipCustomerIds(t.db, '00000000-0000-7000-8000-000000000000', [a])).toEqual(new Set())
  })
})
