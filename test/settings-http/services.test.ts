import { describe, expect, it } from 'vitest'
import type { ChecklistChange } from '../../src/modules/settings/http/runtime.js'
import { makeService } from '../domain-schema/helpers.js'
import { auditActions, events, json, useSettingsHarness } from './harness.js'

const h = useSettingsHarness()

const labels = (svc: { tasks: { label: string }[] }): string[] => svc.tasks.map((t) => t.label)

async function seedCatalog() {
  const express = await makeService(h.db, h.fx, {
    name: 'Express Hand Wash',
    priceCents: 4500,
    durationMin: 35,
    sort: 1,
    tasks: ['Exterior rinse', 'Hand wash', 'Wheel cleaning', 'Hand dry & towel', 'Glass & windows'],
  })
  const premium = await makeService(h.db, h.fx, {
    name: 'Premium Hand Wash + Interior',
    priceCents: 12900,
    durationMin: 75,
    sort: 2,
    tasks: ['Pre-rinse'],
  })
  const wax = await makeService(h.db, h.fx, {
    kind: 'addon',
    name: 'Wax',
    priceCents: 4000,
    tasks: ['Apply carnauba wax', 'Buff off haze'],
    sort: 1,
  })
  const retired = await makeService(h.db, h.fx, { name: 'Old Package', active: false, sort: 9 })
  return { express, premium, wax, retired }
}

describe('GET /services', () => {
  it('lists packages and add-ons with ordered tasks and their ids', async () => {
    const ids = await seedCatalog()
    const s = await h.withPermissions([])
    const r = await h.get('services', s)
    expect(r.statusCode).toBe(200)
    const b = json(r)
    expect(b.packages.map((p: { name: string }) => p.name)).toEqual([
      'Express Hand Wash',
      'Premium Hand Wash + Interior',
    ])
    expect(b.addons.map((p: { name: string }) => p.name)).toEqual(['Wax'])
    const express = b.packages[0]
    expect(express).toMatchObject({
      id: ids.express,
      kind: 'package',
      shortName: 'Express Hand Wash',
      priceCents: 4500,
      durationMin: 35,
      active: true,
      bookableDesk: true,
      taskCount: 5,
      version: 1,
    })
    expect(labels(express)).toEqual([
      'Exterior rinse',
      'Hand wash',
      'Wheel cleaning',
      'Hand dry & towel',
      'Glass & windows',
    ])
    expect(
      express.tasks.every(
        (t: { id: string; position: number }, i: number) => /^[0-9a-f-]{36}$/.test(t.id) && t.position === i,
      ),
    ).toBe(true)
    expect(b.packages[1].shortName).toBe('Premium Hand Wash')
    expect(b.addons[0]).toMatchObject({ durationMin: 0, priceCents: 4000, taskCount: 2 })
  })

  it('shows retired services only to holders of set.services with includeInactive', async () => {
    await seedCatalog()
    const plain = await h.withPermissions([])
    expect((await h.get('services?includeInactive=true', plain)).statusCode).toBe(403)
    const editor = await h.withPermissions(['set.services'])
    const all = json(await h.get('services?includeInactive=true', editor))
    expect(all.packages.map((p: { name: string }) => p.name)).toContain('Old Package')
    expect(json(await h.get('services', editor)).packages.map((p: { name: string }) => p.name)).not.toContain(
      'Old Package',
    )
  })

  it('refuses an anonymous caller', async () => {
    expect((await h.call('GET', 'services')).statusCode).toBe(401)
  })
})

describe('PUT /services/:id/checklist', () => {
  it('renames in place keeping ids, reorders, adds, drops blanks and retires removed tasks', async () => {
    const { express } = await seedCatalog()
    const s = await h.admin()
    const before = json(await h.get('services', s)).packages[0]
    const id = (label: string) => before.tasks.find((t: { label: string }) => t.label === label).id as string

    const r = await h.put(`services/${express}/checklist`, s, {
      version: before.version,
      tasks: [
        { id: id('Hand wash'), label: '  Two-bucket hand wash  ' },
        { id: id('Exterior rinse'), label: 'Exterior rinse' },
        { label: '   ' },
        { label: 'Foam pre-soak' },
        { id: id('Glass & windows'), label: 'Glass & windows' },
        { label: 'Spray sealant' },
      ],
    })
    expect(r.statusCode).toBe(200)
    const b = json(r)
    expect(b.changed).toBe(true)
    expect(labels(b.service)).toEqual([
      'Two-bucket hand wash',
      'Exterior rinse',
      'Foam pre-soak',
      'Glass & windows',
      'Spray sealant',
    ])
    expect(b.service.tasks[0].id).toBe(id('Hand wash'))
    expect(b.service.tasks[1].id).toBe(id('Exterior rinse'))
    expect(b.service.tasks[3].id).toBe(id('Glass & windows'))
    // an id-less entry takes the unclaimed task at its rank (rename in place), so "Foam pre-soak" reuses "Wheel cleaning"
    expect(b.service.tasks[2].id).toBe(id('Wheel cleaning'))
    expect(b.service.tasks[4].id).not.toBe(id('Hand dry & towel'))
    expect(b.service.version).toBe(before.version + 1)
    expect(b.summary).toMatchObject({ renamed: 2, created: 1, retired: 1 })
    expect(r.headers.etag).toBe(`"${before.version + 1}"`)

    // retired tasks stay in the table
    const retired = await h.db
      .selectFrom('checklist_tasks')
      .select(['label', 'retired_at'])
      .where('service_id', '=', express)
      .where('retired_at', 'is not', null)
      .execute()
    expect(retired.map((t) => t.label)).toEqual(['Hand dry & towel'])
    expect(await auditActions(h.db)).toContain('catalog.checklist.update')
    expect((await events(h.db, 'settings')).filter((e) => e.payload.section === 'services')).toHaveLength(1)
  })

  it("accepts the design's plain string array and keeps ids stable on a pure reorder", async () => {
    const { express } = await seedCatalog()
    const s = await h.admin()
    const before = json(await h.get('services', s)).packages[0]
    const reversed = [...labels(before)].reverse()
    const r = json(await h.put(`services/${express}/checklist`, s, { tasks: reversed }))
    expect(labels(r.service)).toEqual(reversed)
    expect(r.summary).toMatchObject({ renamed: 0, created: 0, retired: 0 })
    expect(new Set(r.service.tasks.map((t: { id: string }) => t.id))).toEqual(
      new Set(before.tasks.map((t: { id: string }) => t.id)),
    )
    const same = json(await h.put(`services/${express}/checklist`, s, { tasks: reversed }))
    expect(same.changed).toBe(false)
    expect(same.service.version).toBe(r.service.version)
  })

  it('answers 412 for a stale version (body or If-Match) and 422 for a foreign task id', async () => {
    const { express, premium } = await seedCatalog()
    const s = await h.admin()
    const first = await h.put(`services/${express}/checklist`, s, { version: 1, tasks: ['Only task'] })
    expect(first.statusCode).toBe(200)
    const stale = await h.put(`services/${express}/checklist`, s, { version: 1, tasks: ['Other'] })
    expect(stale.statusCode).toBe(412)
    expect(json(stale)).toMatchObject({ code: 'VERSION_CONFLICT', meta: { currentVersion: 2 } })
    const viaHeader = await h.put(
      `services/${express}/checklist`,
      s,
      { tasks: ['Other'] },
      { 'if-match': '"1"' },
    )
    expect(viaHeader.statusCode).toBe(412)

    const foreign = json(await h.get('services', s)).packages.find((p: { id: string }) => p.id === premium)
      .tasks[0].id
    const bad = await h.put(`services/${express}/checklist`, s, {
      tasks: [{ id: foreign, label: 'Pre-rinse' }],
    })
    expect(bad.statusCode).toBe(422)
    expect(json(bad).detail).toBe('That task does not belong to this checklist.')
    expect(
      (await h.put('services/00000000-0000-7000-8000-000000000001/checklist', s, { tasks: [] })).statusCode,
    ).toBe(404)
    expect((await h.put(`services/${express}/checklist`, s, { tasks: ['x'.repeat(301)] })).statusCode).toBe(
      422,
    )
  })

  it('works for add-ons and calls the ChecklistSync port with what changed', async () => {
    const { wax } = await seedCatalog()
    const s = await h.admin()
    const calls: ChecklistChange[] = []
    h.ports.checklistSync = async (_tx, change) => void calls.push(change)
    try {
      const r = json(
        await h.put(`services/${wax}/checklist`, s, {
          tasks: ['Apply carnauba wax', 'Buff to a shine', 'Wipe door jambs'],
        }),
      )
      expect(labels(r.service)).toEqual(['Apply carnauba wax', 'Buff to a shine', 'Wipe door jambs'])
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatchObject({ locationId: h.fx.locationId, serviceId: wax })
      expect(calls[0]!.renamed).toHaveLength(1)
      expect(calls[0]!.created).toHaveLength(1)
      await h.put(`services/${wax}/checklist`, s, {
        tasks: ['Apply carnauba wax', 'Buff to a shine', 'Wipe door jambs'],
      })
      expect(calls).toHaveLength(1)
    } finally {
      delete h.ports.checklistSync
    }
  })

  it('needs set.services', async () => {
    const { express } = await seedCatalog()
    const s = await h.withPermissions(['set.hours', 'sched.edit'])
    expect((await h.put(`services/${express}/checklist`, s, { tasks: ['x'] })).statusCode).toBe(403)
  })
})

describe('POST/PATCH /services', () => {
  it('creates a package and an add-on', async () => {
    const s = await h.admin()
    const pkg = await h.post('services', s, {
      kind: 'package',
      name: 'Ceramic Maintenance + Wax',
      priceCents: 18000,
      durationMin: 60,
      tasks: ['Pre-rinse', 'pH-neutral hand wash'],
      tags: ['ceramic'],
    })
    expect(pkg.statusCode).toBe(201)
    expect(json(pkg)).toMatchObject({
      kind: 'package',
      name: 'Ceramic Maintenance + Wax',
      shortName: 'Ceramic Maintenance',
      priceCents: 18000,
      durationMin: 60,
      taskCount: 2,
      tags: ['ceramic'],
      bookableDesk: true,
    })
    const addon = json(
      await h.post('services', s, { kind: 'addon', name: 'Rain repellent', priceCents: 2500 }),
    )
    expect(addon).toMatchObject({ kind: 'addon', durationMin: 0 })
    expect(json(await h.get('services', s)).addons.map((a: { name: string }) => a.name)).toEqual([
      'Rain repellent',
    ])
    expect(await auditActions(h.db)).toContain('catalog.create')
  })

  it('validates and refuses a duplicate name per kind', async () => {
    const s = await h.admin()
    await h.post('services', s, { kind: 'package', name: 'Full Detail', priceCents: 32000, durationMin: 120 })
    const dup = await h.post('services', s, {
      kind: 'package',
      name: 'full detail',
      priceCents: 1,
      durationMin: 5,
    })
    expect(dup.statusCode).toBe(422)
    expect(json(dup).detail).toBe('A package with that name already exists.')
    expect(
      (await h.post('services', s, { kind: 'addon', name: 'Full Detail', priceCents: 100 })).statusCode,
    ).toBe(201)
    expect(
      json(await h.post('services', s, { kind: 'package', name: 'No time', priceCents: 100 })).detail,
    ).toBe('Enter a duration from 1 to 720 minutes.')
    expect(
      json(await h.post('services', s, { kind: 'package', name: '   ', priceCents: 100, durationMin: 10 }))
        .detail,
    ).toBe('Enter a name of up to 120 characters.')
    expect(json(await h.post('services', s, { kind: 'addon', name: 'Free?', priceCents: -5 })).detail).toBe(
      'Enter a price in whole cents, from 0 to $100,000.',
    )
    expect(
      json(await h.post('services', s, { kind: 'addon', name: 'Timed', priceCents: 5, durationMin: 10 }))
        .detail,
    ).toBe('Add-ons do not have a duration.')
  })

  it('edits price, duration, name, bookable at the desk and active with a version check', async () => {
    const { express } = await seedCatalog()
    const s = await h.admin()
    const r = await h.patch(`services/${express}`, s, {
      priceCents: 4900,
      durationMin: 40,
      name: 'Express Hand Wash Plus',
      bookableDesk: false,
      version: 1,
    })
    expect(r.statusCode).toBe(200)
    expect(json(r)).toMatchObject({
      priceCents: 4900,
      durationMin: 40,
      name: 'Express Hand Wash Plus',
      bookableDesk: false,
      version: 2,
      active: true,
    })
    expect(r.headers.etag).toBe('"2"')
    const stale = await h.patch(`services/${express}`, s, { priceCents: 5000, version: 1 })
    expect(stale.statusCode).toBe(412)
    expect(json(stale).meta.currentVersion).toBe(2)
    const off = json(await h.patch(`services/${express}`, s, { active: false }))
    expect(off).toMatchObject({ active: false, version: 3 })
    expect(json(await h.get('services', s)).packages.map((p: { id: string }) => p.id)).not.toContain(express)
    const on = json(await h.patch(`services/${express}`, s, { active: true }))
    expect(on.active).toBe(true)
    expect(await auditActions(h.db)).toContain('catalog.update')
    expect((await h.patch(`services/${express}`, s, { priceCents: 1.5 })).statusCode).toBe(422)
    expect(json(await h.patch(`services/${express}`, s, { durationMin: 0 })).detail).toBe(
      'Enter a duration from 1 to 720 minutes.',
    )
    expect(
      (await h.patch('services/00000000-0000-7000-8000-000000000001', s, { priceCents: 5 })).statusCode,
    ).toBe(404)
  })

  it('an appointment keeps its own snapshot when the catalog changes', async () => {
    const { express } = await seedCatalog()
    const s = await h.admin()
    const { makeAppointment, makeCustomer, edt } = await import('../domain-schema/helpers.js')
    const appt = await makeAppointment(h.db, h.fx, {
      customerId: await makeCustomer(h.db, h.fx),
      serviceId: express,
      start: edt('2026-06-20', '10:00'),
    })
    await h.patch(`services/${express}`, s, { priceCents: 9900, name: 'Renamed' })
    const row = await h.db
      .selectFrom('appointments')
      .select(['price_cents', 'package_name'])
      .where('id', '=', appt)
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ price_cents: 4500, package_name: 'Express Hand Wash' })
  })

  it('needs set.services', async () => {
    const { express } = await seedCatalog()
    const s = await h.withPermissions(['set.hours'])
    expect((await h.patch(`services/${express}`, s, { priceCents: 1 })).statusCode).toBe(403)
    expect((await h.post('services', s, { kind: 'addon', name: 'x', priceCents: 1 })).statusCode).toBe(403)
  })
})
