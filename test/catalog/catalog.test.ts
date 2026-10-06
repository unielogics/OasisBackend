import { describe, expect, it } from 'vitest'
import { transaction } from '../../src/platform/db.js'
import { isAppError } from '../../src/platform/errors.js'
import {
  createService,
  displayShortName,
  findServiceByName,
  getService,
  jobTasksFor,
  listCatalog,
  putChecklist,
  renameService,
  setServiceActive,
  setServiceDuration,
  setServicePrice,
  updateService,
} from '../../src/modules/catalog/index.js'
import { useTestDb } from '../helpers/db.js'
import { makeService, setupLocation } from '../domain-schema/helpers.js'

const t = useTestDb()

async function appError(p: Promise<unknown>) {
  try {
    await p
  } catch (e) {
    if (isAppError(e)) return e
    throw e
  }
  throw new Error('expected an AppError')
}

const labelsOf = (s: { tasks: { label: string }[] }) => s.tasks.map((x) => x.label)

describe('listCatalog', () => {
  it('returns packages and add-ons in sort order with their ordered, non-retired tasks', async () => {
    const f = await setupLocation(t)
    const b = await makeService(t.db, f, { name: 'B pack', sort: 20, tasks: ['b1', 'b2'] })
    const a = await makeService(t.db, f, { name: 'A pack', sort: 10, tasks: ['x', 'y', 'z'] })
    await makeService(t.db, f, { kind: 'addon', name: 'Wax', sort: 10, tasks: ['Apply'] })
    await t.db
      .updateTable('checklist_tasks')
      .set({ retired_at: new Date('2026-06-01T00:00:00Z') })
      .where('service_id', '=', a)
      .where('label', '=', 'y')
      .execute()
    const c = await listCatalog(t.db, f.locationId)
    expect(c.packages.map((s) => s.name)).toEqual(['A pack', 'B pack'])
    expect(c.packages.map((s) => labelsOf(s))).toEqual([
      ['x', 'z'],
      ['b1', 'b2'],
    ])
    expect(c.addons.map((s) => s.name)).toEqual(['Wax'])
    expect(c.packages[0]!.id).toBe(a)
    expect(c.packages[1]!.id).toBe(b)
    expect(c.packages[0]).toMatchObject({
      priceCents: 4500,
      durationMin: 60,
      active: true,
      bookableDesk: true,
      version: 1,
    })
  })

  it('hides inactive services unless asked, and is scoped to the location', async () => {
    const f = await setupLocation(t)
    await makeService(t.db, f, { name: 'Live' })
    await makeService(t.db, f, { name: 'Retired', active: false })
    expect((await listCatalog(t.db, f.locationId)).packages.map((s) => s.name)).toEqual(['Live'])
    expect(
      (await listCatalog(t.db, f.locationId, { includeInactive: true })).packages.map((s) => s.name).sort(),
    ).toEqual(['Live', 'Retired'])
    expect((await listCatalog(t.db, '00000000-0000-7000-8000-000000000000')).packages).toEqual([])
  })

  it('derives the short name from the text before " + " unless overridden', async () => {
    expect(displayShortName('Executive Detail + Ceramic')).toBe('Executive Detail')
    expect(displayShortName('Premium Hand Wash + Interior')).toBe('Premium Hand Wash')
    expect(displayShortName('Express Hand Wash')).toBe('Express Hand Wash')
    expect(displayShortName('Executive Detail + Ceramic', 'Exec Ceramic')).toBe('Exec Ceramic')
  })

  it('gives a task-less add-on one task named after it, and a task-less package none', async () => {
    const f = await setupLocation(t)
    const addon = await makeService(t.db, f, { kind: 'addon', name: 'Wax' })
    const pack = await makeService(t.db, f, { name: 'Bare' })
    expect(jobTasksFor((await getService(t.db, f.locationId, addon))!)).toEqual(['Wax'])
    expect(jobTasksFor((await getService(t.db, f.locationId, pack))!)).toEqual([])
  })
})

describe('putChecklist', () => {
  const put = (
    f: { locationId: string; newId: () => string },
    serviceId: string,
    tasks: Parameters<typeof putChecklist>[1]['tasks'],
    expectedVersion?: number,
  ) =>
    transaction(t.db, (tx) =>
      putChecklist(tx, { locationId: f.locationId, serviceId, tasks, expectedVersion, newId: f.newId }),
    )

  it('keeps ids on reorder plus an in-place rename, and bumps the version once', async () => {
    const f = await setupLocation(t)
    const id = await makeService(t.db, f, { tasks: ['Rinse', 'Wash', 'Dry'] })
    const before = (await getService(t.db, f.locationId, id))!
    const byLabel = Object.fromEntries(before.tasks.map((x) => [x.label, x.id]))
    const reordered = await put(f, id, ['Dry', 'Rinse', 'Wash'])
    expect(reordered.service.version).toBe(before.version + 1)
    expect(reordered.service.tasks.map((x) => [x.label, x.position])).toEqual([
      ['Dry', 0],
      ['Rinse', 1],
      ['Wash', 2],
    ])
    expect(reordered.service.tasks.map((x) => x.id)).toEqual([byLabel.Dry, byLabel.Rinse, byLabel.Wash])
    expect(reordered.plan.createdIds).toEqual([])
    const renamed = await put(f, id, ['Dry', 'Rinse', 'Two-bucket wash'])
    expect(renamed.service.version).toBe(before.version + 2)
    expect(renamed.service.tasks.map((x) => x.id)).toEqual([byLabel.Dry, byLabel.Rinse, byLabel.Wash])
    expect(renamed.plan.renamed).toEqual([{ id: byLabel.Wash, from: 'Wash', to: 'Two-bucket wash' }])
  })

  it('keeps ids when a reorder and a rename arrive together as {id, label}', async () => {
    const f = await setupLocation(t)
    const id = await makeService(t.db, f, { tasks: ['Rinse', 'Wash', 'Dry'] })
    const before = (await getService(t.db, f.locationId, id))!
    const [rinse, wash, dry] = before.tasks.map((x) => x.id)
    const r = await put(f, id, [
      { id: dry!, label: 'Dry' },
      { id: rinse!, label: 'Rinse' },
      { id: wash!, label: 'Two-bucket wash' },
    ])
    expect(r.service.tasks.map((x) => [x.id, x.label])).toEqual([
      [dry, 'Dry'],
      [rinse, 'Rinse'],
      [wash, 'Two-bucket wash'],
    ])
    expect(r.plan.createdIds).toEqual([])
    expect(r.plan.retired).toEqual([])
  })

  it('creates new tasks with fresh ids and retires removed ones without deleting rows', async () => {
    const f = await setupLocation(t)
    const id = await makeService(t.db, f, { tasks: ['Rinse', 'Wash', 'Dry'] })
    const before = (await getService(t.db, f.locationId, id))!
    const wash = before.tasks.find((x) => x.label === 'Wash')!.id
    const r = await put(f, id, ['Rinse', 'Dry', 'Wax'])
    expect(r.plan.createdIds).toHaveLength(1)
    expect(labelsOf(r.service)).toEqual(['Rinse', 'Dry', 'Wax'])
    expect(r.service.tasks[2]!.id).toBe(r.plan.createdIds[0])
    const rows = await t.db
      .selectFrom('checklist_tasks')
      .select(['id', 'label', 'retired_at'])
      .where('service_id', '=', id)
      .execute()
    expect(rows).toHaveLength(4)
    const retired = rows.find((x) => x.id === wash)!
    expect(retired.label).toBe('Wash')
    expect(retired.retired_at).not.toBeNull()
    expect(retired.retired_at!.toISOString()).toBe('2026-06-13T14:36:00.000Z')
  })

  it('trims labels, drops blank entries and is a no-op (no version bump) when nothing changes', async () => {
    const f = await setupLocation(t)
    const id = await makeService(t.db, f, { tasks: ['Rinse', 'Wash'] })
    const r = await put(f, id, ['  Rinse ', '   ', 'Wash', ''])
    expect(r.changed).toBe(false)
    expect(r.service.version).toBe(1)
    const audits = await t.db
      .selectFrom('audit_log')
      .select('id')
      .where('action', '=', 'catalog.checklist.update')
      .execute()
    expect(audits).toHaveLength(0)
  })

  it('accepts {id, label} input and revives a retired task by id', async () => {
    const f = await setupLocation(t)
    const id = await makeService(t.db, f, { tasks: ['Rinse', 'Wash'] })
    const first = (await getService(t.db, f.locationId, id))!
    const wash = first.tasks[1]!.id
    await put(f, id, ['Rinse'])
    expect(labelsOf((await getService(t.db, f.locationId, id))!)).toEqual(['Rinse'])
    const r = await put(f, id, [
      { id: first.tasks[0]!.id, label: 'Rinse' },
      { id: wash, label: 'Wash' },
    ])
    expect(r.plan.revived).toEqual([wash])
    expect(r.service.tasks.map((x) => x.id)).toEqual([first.tasks[0]!.id, wash])
    const row = await t.db
      .selectFrom('checklist_tasks')
      .select('retired_at')
      .where('id', '=', wash)
      .executeTakeFirstOrThrow()
    expect(row.retired_at).toBeNull()
  })

  it('checks the expected version and reports the current one', async () => {
    const f = await setupLocation(t)
    const id = await makeService(t.db, f, { tasks: ['Rinse'] })
    await put(f, id, ['Rinse', 'Wash'], 1)
    const e = await appError(put(f, id, ['Rinse'], 1))
    expect(e.code).toBe('VERSION_CONFLICT')
    expect(e.meta).toEqual({ currentVersion: 2 })
    expect(labelsOf((await getService(t.db, f.locationId, id))!)).toEqual(['Rinse', 'Wash'])
  })

  it('rejects ids that are not on the service, with the offending entry in the error', async () => {
    const f = await setupLocation(t)
    const id = await makeService(t.db, f, { tasks: ['Rinse'] })
    const other = await makeService(t.db, f, { tasks: ['Foreign'] })
    const foreign = (await getService(t.db, f.locationId, other))!.tasks[0]!.id
    const e = await appError(put(f, id, [{ id: foreign, label: 'Foreign' }]))
    expect(e.code).toBe('VALIDATION_FAILED')
    expect(e.errors).toEqual([{ path: 'tasks.0', message: 'That task does not belong to this checklist.' }])
  })

  it('rolls everything back when the transaction fails after the write', async () => {
    const f = await setupLocation(t)
    const id = await makeService(t.db, f, { tasks: ['Rinse', 'Wash'] })
    await expect(
      transaction(t.db, async (tx) => {
        await putChecklist(tx, { locationId: f.locationId, serviceId: id, tasks: ['Only'], newId: f.newId })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(labelsOf((await getService(t.db, f.locationId, id))!)).toEqual(['Rinse', 'Wash'])
  })

  it('is invisible across locations', async () => {
    const f = await setupLocation(t)
    const id = await makeService(t.db, f, { tasks: ['Rinse'] })
    const e = await appError(
      put({ locationId: '00000000-0000-7000-8000-000000000000', newId: f.newId }, id, ['x']),
    )
    expect(e.code).toBe('NOT_FOUND')
  })

  it('writes an audit entry and a settings.changed event for a real change', async () => {
    const f = await setupLocation(t)
    const id = await makeService(t.db, f, { tasks: ['Rinse'] })
    await put(f, id, ['Rinse', 'Wash'])
    const audit = await t.db
      .selectFrom('audit_log')
      .select(['before', 'after', 'entity_id'])
      .where('action', '=', 'catalog.checklist.update')
      .executeTakeFirstOrThrow()
    expect(audit.entity_id).toBe(id)
    expect(audit.before).toEqual(['Rinse'])
    expect(audit.after).toEqual(['Rinse', 'Wash'])
    const ev = await t.db
      .selectFrom('realtime_events')
      .select('payload')
      .where('type', '=', 'settings.changed')
      .executeTakeFirstOrThrow()
    expect(ev.payload).toMatchObject({ section: 'services', key: id })
  })
})

describe('service edits', () => {
  it('edits name, price, duration and flags with a version check', async () => {
    const f = await setupLocation(t)
    const id = await makeService(t.db, f, { name: 'Express Hand Wash', priceCents: 4500, durationMin: 35 })
    const ctx = { locationId: f.locationId, serviceId: id }
    const r1 = await transaction(t.db, (tx) => setServicePrice(tx, ctx, 4900))
    expect(r1).toMatchObject({ priceCents: 4900, version: 2 })
    const r2 = await transaction(t.db, (tx) => setServiceDuration(tx, { ...ctx, expectedVersion: 2 }, 40))
    expect(r2).toMatchObject({ durationMin: 40, version: 3 })
    const r3 = await transaction(t.db, (tx) => renameService(tx, ctx, 'Express Wash + Dry', 'Express'))
    expect(r3).toMatchObject({
      name: 'Express Wash + Dry',
      shortName: 'Express',
      shortNameOverride: 'Express',
    })
    const r4 = await transaction(t.db, (tx) => setServiceActive(tx, ctx, false))
    expect(r4.active).toBe(false)
    expect(
      (await appError(transaction(t.db, (tx) => setServicePrice(tx, { ...ctx, expectedVersion: 1 }, 1))))
        .code,
    ).toBe('VERSION_CONFLICT')
  })

  it('rejects bad values with field-level errors', async () => {
    const f = await setupLocation(t)
    const pack = await makeService(t.db, f, { name: 'A' })
    const addon = await makeService(t.db, f, { name: 'Wax', kind: 'addon' })
    const upd = (serviceId: string, patch: Parameters<typeof updateService>[1]['patch']) =>
      appError(transaction(t.db, (tx) => updateService(tx, { locationId: f.locationId, serviceId, patch })))
    expect((await upd(pack, { priceCents: -1 })).errors?.[0]?.path).toBe('priceCents')
    expect((await upd(pack, { priceCents: 12.5 })).errors?.[0]?.path).toBe('priceCents')
    expect((await upd(pack, { durationMin: 0 })).errors?.[0]?.path).toBe('durationMin')
    expect((await upd(addon, { durationMin: 15 })).errors?.[0]?.path).toBe('durationMin')
    expect((await upd(pack, { name: '   ' })).errors?.[0]?.path).toBe('name')
    expect((await upd(pack, { tags: ['Bad Tag'] })).errors?.[0]?.path).toBe('tags')
  })

  it('refuses a duplicate name per kind but allows the same name across kinds', async () => {
    const f = await setupLocation(t)
    await makeService(t.db, f, { name: 'Wax', kind: 'addon' })
    const pack = await makeService(t.db, f, { name: 'Other' })
    await makeService(t.db, f, { name: 'Taken' })
    const e = await appError(
      transaction(t.db, (tx) => renameService(tx, { locationId: f.locationId, serviceId: pack }, ' taken ')),
    )
    expect(e.code).toBe('VALIDATION_FAILED')
    expect(e.errors?.[0]).toEqual({ path: 'name', message: 'A package with that name already exists.' })
    const ok = await transaction(t.db, (tx) =>
      renameService(tx, { locationId: f.locationId, serviceId: pack }, 'Wax'),
    )
    expect(ok.name).toBe('Wax')
    const dup = await appError(
      transaction(t.db, (tx) =>
        createService(tx, {
          locationId: f.locationId,
          kind: 'addon',
          name: ' WAX ',
          priceCents: 100,
          newId: f.newId,
        }),
      ),
    )
    expect(dup.errors?.[0]).toEqual({ path: 'name', message: 'An add-on with that name already exists.' })
  })

  it('creates a service with an initial checklist and finds it by name', async () => {
    const f = await setupLocation(t)
    const s = await transaction(t.db, (tx) =>
      createService(tx, {
        locationId: f.locationId,
        kind: 'package',
        name: 'Mini Detail',
        priceCents: 9900,
        durationMin: 45,
        tags: ['mini'],
        tasks: ['One', ' ', 'Two'],
        newId: f.newId,
      }),
    )
    expect(labelsOf(s)).toEqual(['One', 'Two'])
    expect(s).toMatchObject({ priceCents: 9900, durationMin: 45, tags: ['mini'], version: 1 })
    expect((await findServiceByName(t.db, f.locationId, 'package', 'mini detail'))?.id).toBe(s.id)
    expect(await findServiceByName(t.db, f.locationId, 'addon', 'Mini Detail')).toBeUndefined()
  })

  it('does not create an add-on with a duration or a package without one', async () => {
    const f = await setupLocation(t)
    const addon = await transaction(t.db, (tx) =>
      createService(tx, {
        locationId: f.locationId,
        kind: 'addon',
        name: 'Wax',
        priceCents: 4000,
        durationMin: 30,
        newId: f.newId,
      }),
    )
    expect(addon.durationMin).toBe(0)
    const e = await appError(
      transaction(t.db, (tx) =>
        createService(tx, {
          locationId: f.locationId,
          kind: 'package',
          name: 'No time',
          priceCents: 100,
          newId: f.newId,
        }),
      ),
    )
    expect(e.errors?.[0]?.path).toBe('durationMin')
  })
})
