import { describe, expect, it } from 'vitest'
import { transaction } from '../../src/platform/db.js'
import { isAppError } from '../../src/platform/errors.js'
import {
  DEFAULT_ARRIVAL_SETTINGS,
  DEFAULT_VIP_SETTINGS,
  addVipByName,
  addVipClient,
  addVipHold,
  countVipClients,
  getArrivalSettings,
  getVipSettings,
  holdLabel,
  holdReleasesAt,
  holdSort,
  holdToast,
  isHoldReleased,
  listVipClients,
  listVipHolds,
  removeVipClient,
  removeVipHold,
  saveArrivalSettings,
  saveVipSettings,
  validateArrivalSettings,
  validateVipSettings,
  VIP_ERRORS,
} from '../../src/modules/settings/index.js'
import { FixedClock } from '../../src/platform/clock.js'
import { useTestDb } from '../helpers/db.js'
import { edt, makeCustomer, makeVehicle, setupLocation } from '../domain-schema/helpers.js'

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

type Fx = Awaited<ReturnType<typeof setupLocation>>

describe('validateVipSettings (pure)', () => {
  const ok = (p: Parameters<typeof validateVipSettings>[0]) => expect(validateVipSettings(p)).toEqual([])
  const bad = (p: Parameters<typeof validateVipSettings>[0], path: string) =>
    expect(validateVipSettings(p).map((i) => i.path)).toEqual([path])

  it('accepts the design defaults and every allowed value', () => {
    ok(DEFAULT_VIP_SETTINGS)
    for (const releaseHours of [24, 48, 72]) ok({ releaseHours })
    for (const offerMinutes of [10, 15, 30]) ok({ offerMinutes })
    for (const sameDayPerMonth of [0, 1, 8]) ok({ sameDayPerMonth })
    ok({ windowVipDays: 7 })
    ok({ windowVipDays: 90 })
    ok({ windowStdDays: 7 })
    ok({ windowStdDays: 60 })
    ok({ cadences: [] })
    ok({ cadences: ['weekly', 'biweekly', 'triweekly', 'monthly'] })
  })

  it('accepts the stepper drift values: 30 +/- 7 is not on the 7-day grid but is in range', () => {
    ok({ windowVipDays: 23 })
    ok({ windowVipDays: 37 })
    ok({ windowStdDays: 14 })
    ok({ windowStdDays: 21 })
  })

  it('rejects values outside the design’s sets and ranges', () => {
    bad({ releaseHours: 36 }, 'releaseHours')
    bad({ offerMinutes: 20 }, 'offerMinutes')
    bad({ sameDayPerMonth: 9 }, 'sameDayPerMonth')
    bad({ sameDayPerMonth: -1 }, 'sameDayPerMonth')
    bad({ sameDayPerMonth: 1.5 }, 'sameDayPerMonth')
    bad({ windowVipDays: 6 }, 'windowVipDays')
    bad({ windowVipDays: 91 }, 'windowVipDays')
    bad({ windowStdDays: 61 }, 'windowStdDays')
    bad({ cadences: ['daily' as never] }, 'cadences')
    bad({ cadences: ['weekly', 'weekly'] }, 'cadences')
    bad({ waitlist: 'yes' as never }, 'waitlist')
  })
})

describe('VIP settings', () => {
  const save = (f: Fx, patch: Parameters<typeof saveVipSettings>[1]['patch'], expectedVersion?: number) =>
    transaction(t.db, (tx) => saveVipSettings(tx, { locationId: f.locationId, patch, expectedVersion }))

  it('reads the design defaults', async () => {
    const f = await setupLocation(t)
    expect(await getVipSettings(t.db, f.locationId)).toEqual({ settings: DEFAULT_VIP_SETTINGS, version: 1 })
    expect(DEFAULT_VIP_SETTINGS).toEqual({
      releaseHours: 48,
      windowVipDays: 30,
      windowStdDays: 14,
      sameDayPerMonth: 2,
      waitlist: true,
      offerMinutes: 15,
      standing: true,
      autoConfirm: true,
      cadences: ['weekly', 'biweekly', 'monthly'],
    })
  })

  it('returns the defaults at version 0 for a location without a row', async () => {
    expect(await getVipSettings(t.db, '00000000-0000-7000-8000-000000000000')).toEqual({
      settings: DEFAULT_VIP_SETTINGS,
      version: 0,
    })
  })

  it('saves a partial patch, bumps the version, audits, and keeps cadences in the canonical order', async () => {
    const f = await setupLocation(t)
    const r = await save(
      f,
      { releaseHours: 72, windowVipDays: 37, waitlist: false, cadences: ['monthly', 'weekly'] },
      1,
    )
    expect(r).toMatchObject({ changed: true, version: 2 })
    expect(r.settings).toMatchObject({
      releaseHours: 72,
      windowVipDays: 37,
      windowStdDays: 14,
      waitlist: false,
      cadences: ['weekly', 'monthly'],
    })
    expect(await getVipSettings(t.db, f.locationId)).toMatchObject({
      version: 2,
      settings: { releaseHours: 72, cadences: ['weekly', 'monthly'] },
    })
    const audit = await t.db
      .selectFrom('audit_log')
      .select('action')
      .where('action', '=', 'settings.vip.update')
      .execute()
    expect(audit).toHaveLength(1)
  })

  it('does nothing when nothing changes, rejects bad values without writing, and rejects a stale version', async () => {
    const f = await setupLocation(t)
    expect(await save(f, { releaseHours: 48 })).toMatchObject({ changed: false, version: 1 })
    const e = await appError(save(f, { releaseHours: 36 as never, offerMinutes: 20 as never }))
    expect(e).toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(e.errors).toHaveLength(2)
    expect((await getVipSettings(t.db, f.locationId)).version).toBe(1)
    await save(f, { standing: false }, 1)
    const stale = await appError(save(f, { standing: true }, 1))
    expect(stale).toMatchObject({ code: 'VERSION_CONFLICT', meta: { currentVersion: 2 } })
  })
})

describe('VIP holds', () => {
  const add = (f: Fx, weekday: number, timeMin: number) =>
    transaction(t.db, (tx) => addVipHold(tx, { locationId: f.locationId, weekday, timeMin, newId: f.newId }))

  it('lists holds Monday-first then by time with the design label', async () => {
    const f = await setupLocation(t)
    for (const [d, m] of [
      [6, 540],
      [0, 540],
      [6, 480],
      [5, 960],
      [6, 600],
    ] as const)
      await add(f, d, m)
    const holds = await listVipHolds(t.db, f.locationId)
    expect(holds.map((h) => h.label)).toEqual([
      'Friday · 4:00 PM',
      'Saturday · 8:00 AM',
      'Saturday · 9:00 AM',
      'Saturday · 10:00 AM',
      'Sunday · 9:00 AM',
    ])
  })

  it('returns the hold and builds the label and toast strings', async () => {
    const f = await setupLocation(t)
    const h = await add(f, 6, 660)
    expect(h).toMatchObject({ weekday: 6, timeMin: 660, label: 'Saturday · 11:00 AM' })
    expect(holdLabel(5, 960)).toBe('Friday · 4:00 PM')
    expect(holdToast(6, 660)).toBe('Sat 11:00 AM held for VIPs')
    expect(holdSort({ weekday: 0, timeMin: 0 }, { weekday: 1, timeMin: 0 })).toBeGreaterThan(0)
  })

  it('refuses a duplicate hold with the design string', async () => {
    const f = await setupLocation(t)
    await add(f, 6, 480)
    const e = await appError(add(f, 6, 480))
    expect(e).toMatchObject({
      code: 'VIP_HOLD_EXISTS',
      status: 409,
      title: 'That slot is already held',
      detail: 'That slot is already held',
    })
    expect(VIP_ERRORS.holdTaken).toBe('That slot is already held')
    expect(await listVipHolds(t.db, f.locationId)).toHaveLength(1)
  })

  it('lets only one of two concurrent identical holds win', async () => {
    const f = await setupLocation(t)
    const results = await Promise.allSettled([add(f, 1, 600), add(f, 1, 600)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
      code: 'VIP_HOLD_EXISTS',
    })
  })

  it('validates the day and the 30-minute time', async () => {
    const f = await setupLocation(t)
    expect((await appError(add(f, 7, 480))).errors?.[0]?.path).toBe('weekday')
    expect((await appError(add(f, 6, 485))).errors?.[0]?.path).toBe('time')
    expect((await appError(add(f, 6, 240))).errors?.[0]?.path).toBe('time')
    expect((await appError(add(f, 6, 1440))).errors?.[0]?.path).toBe('time')
  })

  it('removes a hold and reports a missing one', async () => {
    const f = await setupLocation(t)
    const h = await add(f, 6, 480)
    const removed = await transaction(t.db, (tx) => removeVipHold(tx, { locationId: f.locationId, id: h.id }))
    expect(removed.label).toBe('Saturday · 8:00 AM')
    expect(await listVipHolds(t.db, f.locationId)).toEqual([])
    expect(
      (await appError(transaction(t.db, (tx) => removeVipHold(tx, { locationId: f.locationId, id: h.id }))))
        .code,
    ).toBe('NOT_FOUND')
    expect(
      (await appError(transaction(t.db, (tx) => removeVipHold(tx, { locationId: f.locationId, id: 'bad' }))))
        .code,
    ).toBe('NOT_FOUND')
  })

  it('computes when a hold opens to everyone: release hours before the slot', () => {
    const slot = edt('2026-06-20', '08:00') // Saturday
    expect(holdReleasesAt(slot, 48).toISOString()).toBe(edt('2026-06-18', '08:00').toISOString())
    expect(holdReleasesAt(slot, 24).toISOString()).toBe(edt('2026-06-19', '08:00').toISOString())
    expect(holdReleasesAt(slot, 72).toISOString()).toBe(edt('2026-06-17', '08:00').toISOString())
    expect(isHoldReleased(new Date(edt('2026-06-18', '08:00').getTime() - 1), slot, 48)).toBe(false)
    expect(isHoldReleased(edt('2026-06-18', '08:00'), slot, 48)).toBe(true)
    expect(isHoldReleased(edt('2026-06-19', '12:00'), slot, 48)).toBe(true)
    expect(isHoldReleased(edt('2026-06-17', '12:00'), slot, 48)).toBe(false)
  })
})

describe('VIP clients', () => {
  it('adds by id once, lists, counts and removes', async () => {
    const f = await setupLocation(t)
    const a = await makeCustomer(t.db, f, { name: 'Liam Chen' })
    const b = await makeCustomer(t.db, f, { name: 'Aisha Rahman' })
    const first = await transaction(t.db, (tx) =>
      addVipClient(tx, { locationId: f.locationId, customerId: a }),
    )
    expect(first).toMatchObject({ added: true, customer: { fullName: 'Liam Chen' } })
    expect(
      (await transaction(t.db, (tx) => addVipClient(tx, { locationId: f.locationId, customerId: a }))).added,
    ).toBe(false)
    ;(t.clock as FixedClock).advance(60_000)
    await transaction(t.db, (tx) => addVipClient(tx, { locationId: f.locationId, customerId: b }))
    expect((await listVipClients(t.db, f.locationId)).map((c) => c.fullName)).toEqual([
      'Liam Chen',
      'Aisha Rahman',
    ])
    expect(await countVipClients(t.db, f.locationId)).toBe(2)
    expect(
      await transaction(t.db, (tx) => removeVipClient(tx, { locationId: f.locationId, customerId: a })),
    ).toBe(true)
    expect(
      await transaction(t.db, (tx) => removeVipClient(tx, { locationId: f.locationId, customerId: a })),
    ).toBe(false)
    expect(await countVipClients(t.db, f.locationId)).toBe(1)
    const audits = await t.db.selectFrom('audit_log').select('action').orderBy('id').execute()
    expect(audits.map((x) => x.action)).toEqual([
      'settings.vip.client.add',
      'settings.vip.client.add',
      'settings.vip.client.remove',
    ])
  })

  it('refuses unknown, deleted and merged customers', async () => {
    const f = await setupLocation(t)
    const gone = await makeCustomer(t.db, f)
    const keep = await makeCustomer(t.db, f)
    const merged = await makeCustomer(t.db, f)
    await t.db
      .updateTable('customers')
      .set({ deleted_at: new Date('2026-06-01T00:00:00Z') })
      .where('id', '=', gone)
      .execute()
    await t.db.updateTable('customers').set({ merged_into: keep }).where('id', '=', merged).execute()
    const add = (customerId: string) =>
      appError(transaction(t.db, (tx) => addVipClient(tx, { locationId: f.locationId, customerId })))
    expect((await add(gone)).code).toBe('VALIDATION_FAILED')
    expect((await add(merged)).code).toBe('VALIDATION_FAILED')
    expect((await add('00000000-0000-7000-8000-000000000000')).code).toBe('NOT_FOUND')
  })

  describe('by name', () => {
    const byName = (f: Fx, name: string) =>
      transaction(t.db, (tx) => addVipByName(tx, { locationId: f.locationId, name }))

    it('adds a single exact match, ignoring case and spacing, with the design toast', async () => {
      const f = await setupLocation(t)
      const id = await makeCustomer(t.db, f, { name: 'Liam Chen' })
      await makeCustomer(t.db, f, { name: 'Liam Cheng' })
      const r = await byName(f, '  liam CHEN ')
      expect(r).toMatchObject({ status: 'added', toast: 'Liam Chen is now VIP', customer: { id } })
      expect(await byName(f, 'Liam Chen')).toMatchObject({ status: 'already_vip' })
      expect(await countVipClients(t.db, f.locationId)).toBe(1)
    })

    it('returns candidates instead of guessing when several customers share the name', async () => {
      const f = await setupLocation(t)
      const a = await makeCustomer(t.db, f, { name: 'Sam Lee', line: '0140' })
      const b = await makeCustomer(t.db, f, { name: 'Sam Lee', line: '0141' })
      await makeVehicle(t.db, f, a, { year: 2021, make: 'Audi', model: 'Q5' })
      await t.db.insertInto('vip_clients').values({ location_id: f.locationId, customer_id: b }).execute()
      const r = await byName(f, 'sam lee')
      expect(r.status).toBe('candidates')
      if (r.status !== 'candidates') return
      expect(r.candidates).toHaveLength(2)
      const cand = Object.fromEntries(r.candidates.map((c) => [c.customerId, c]))
      expect(cand[a]).toMatchObject({ fullName: 'Sam Lee', vehicles: ['2021 Audi Q5'], alreadyVip: false })
      expect(cand[a]!.phoneHint).toMatch(/0140$/)
      expect(cand[a]!.phoneHint).not.toContain('305')
      expect(cand[b]!.alreadyVip).toBe(true)
      expect(await countVipClients(t.db, f.locationId)).toBe(1)
    })

    it('returns candidates for a partial name and never adds one on its own', async () => {
      const f = await setupLocation(t)
      await makeCustomer(t.db, f, { name: 'Maria Delgado' })
      await makeCustomer(t.db, f, { name: 'Maria Lopez' })
      const r = await byName(f, 'maria')
      expect(r.status).toBe('candidates')
      expect(r.status === 'candidates' && r.candidates.map((c) => c.fullName)).toEqual([
        'Maria Delgado',
        'Maria Lopez',
      ])
      expect(await countVipClients(t.db, f.locationId)).toBe(0)
    })

    it('reports an unknown name and rejects an empty one', async () => {
      const f = await setupLocation(t)
      expect(await byName(f, 'Nobody Here')).toEqual({ status: 'not_found' })
      expect((await appError(byName(f, '   '))).errors?.[0]?.path).toBe('name')
    })

    it('ignores deleted and merged customers when matching names', async () => {
      const f = await setupLocation(t)
      const gone = await makeCustomer(t.db, f, { name: 'Ghost Guest' })
      await t.db
        .updateTable('customers')
        .set({ deleted_at: new Date('2026-06-01T00:00:00Z') })
        .where('id', '=', gone)
        .execute()
      expect(await byName(f, 'Ghost Guest')).toEqual({ status: 'not_found' })
    })
  })
})

describe('arrival settings', () => {
  const save = (f: Fx, patch: Parameters<typeof saveArrivalSettings>[1]['patch'], expectedVersion?: number) =>
    transaction(t.db, (tx) => saveArrivalSettings(tx, { locationId: f.locationId, patch, expectedVersion }))

  it('validates radius and prep alert against the design choices', () => {
    expect(validateArrivalSettings(DEFAULT_ARRIVAL_SETTINGS)).toEqual([])
    for (const radiusM of [150, 300, 500]) expect(validateArrivalSettings({ radiusM })).toEqual([])
    for (const prepAtMin of [10, 15, 20]) expect(validateArrivalSettings({ prepAtMin })).toEqual([])
    expect(validateArrivalSettings({ radiusM: 200 }).map((i) => i.path)).toEqual(['radiusM'])
    expect(validateArrivalSettings({ prepAtMin: 12 }).map((i) => i.path)).toEqual(['prepAtMin'])
    expect(validateArrivalSettings({ welcome: 1 as never }).map((i) => i.path)).toEqual(['welcome'])
  })

  it('reads the design defaults (on, 300 m, prep 15, all toggles on)', async () => {
    const f = await setupLocation(t)
    expect(await getArrivalSettings(t.db, f.locationId)).toEqual({
      version: 1,
      settings: {
        enabled: true,
        radiusM: 300,
        prepAtMin: 15,
        autoArrive: true,
        welcome: true,
        alertCrew: true,
        vipFirst: true,
      },
    })
    expect(await getArrivalSettings(t.db, '00000000-0000-7000-8000-000000000000')).toMatchObject({
      version: 0,
    })
  })

  it('saves with a version check and does nothing when unchanged', async () => {
    const f = await setupLocation(t)
    const r = await save(f, { radiusM: 500, prepAtMin: 10, autoArrive: false }, 1)
    expect(r).toMatchObject({
      changed: true,
      version: 2,
      settings: { radiusM: 500, prepAtMin: 10, autoArrive: false, welcome: true },
    })
    expect(await save(f, { radiusM: 500 })).toMatchObject({ changed: false, version: 2 })
    expect(await appError(save(f, { enabled: false }, 1))).toMatchObject({
      code: 'VERSION_CONFLICT',
      meta: { currentVersion: 2 },
    })
    expect(await appError(save(f, { radiusM: 250 as never }))).toMatchObject({ code: 'VALIDATION_FAILED' })
    expect((await getArrivalSettings(t.db, f.locationId)).settings.radiusM).toBe(500)
    const events = await t.db
      .selectFrom('realtime_events')
      .select('payload')
      .where('type', '=', 'settings.changed')
      .execute()
    expect(events.map((e) => e.payload)).toEqual([{ section: 'arrival', key: 'arrival', version: 2 }])
  })
})
