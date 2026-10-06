import { describe, expect, it } from 'vitest'
import { BUNDLE_READ_PERMISSIONS } from '../../src/modules/settings/http/bundle-routes.js'
import { makeCustomer, makeService } from '../domain-schema/helpers.js'
import { bookCustomer } from './fixtures.js'
import { json, useSettingsHarness } from './harness.js'

const h = useSettingsHarness()

async function populate() {
  const s = await h.admin()
  await h.post('closures', s, { date: '2026-05-25', name: 'Memorial Day', notify: false })
  await h.post('closures', s, { date: '2026-12-25', name: 'Christmas Day', notify: false })
  await h.post('vip/holds', s, { weekday: 6, time: '8:00 AM' })
  const liam = await makeCustomer(h.db, h.fx, { name: 'Liam Chen' })
  await h.post('vip/clients', s, { customerId: liam })
  const express = await makeService(h.db, h.fx, {
    name: 'Express Hand Wash',
    tasks: ['Exterior rinse', 'Hand wash'],
  })
  await bookCustomer(h.db, h.fx, { name: 'Santa', date: '2026-12-25', time: '10:00', serviceId: express })
  await makeService(h.db, h.fx, { kind: 'addon', name: 'Wax', tasks: ['Apply wax'] })
  await makeService(h.db, h.fx, { name: 'Old', active: false })
  return s
}

describe('GET /settings/bundle', () => {
  it('returns every section of the Settings screen in one call for a caller who may read it all', async () => {
    const s = await populate()
    const r = await h.get('settings/bundle', s)
    expect(r.statusCode).toBe(200)
    const b = json(r)
    expect(Object.keys(b).sort()).toEqual(
      [
        'arrival',
        'closures',
        'counts',
        'emergency',
        'federalAuto',
        'generatedAt',
        'hours',
        'omitted',
        'rules',
        'services',
        'vip',
      ].sort(),
    )
    expect(b.generatedAt).toBe('2026-06-13T14:36:00.000Z')
    expect(b.omitted).toEqual([])
    expect(b.hours).toMatchObject({ weekHours: '65 hrs', weekMinutes: 3900 })
    expect(b.hours.days).toHaveLength(7)
    expect(b.rules).toMatchObject({ slot: 30, buffer: 10, cutoff: 60 })
    expect(b.federalAuto).toBe(true)
    expect(b.closures.upcoming.map((c: { name: string }) => c.name)).toEqual(['Christmas Day'])
    expect(b.closures.upcoming[0].affectedCount).toBe(1)
    expect(b.closures.past.map((c: { name: string }) => c.name)).toEqual(['Memorial Day'])
    expect(b.emergency).toMatchObject({ active: false, canClose: true, history: [] })
    expect(b.emergency.strip.text).toContain('Open now')
    expect(b.vip).toMatchObject({ release: 48, counts: { clients: 1, holds: 1 } })
    expect(b.vip.holds[0].label).toBe('Saturday · 8:00 AM')
    expect(b.vip.clients.map((c: { fullName: string }) => c.fullName)).toEqual(['Liam Chen'])
    expect(b.arrival).toMatchObject({ radius: 300, prepAt: 15 })
    expect(b.services.packages.map((p: { name: string }) => p.name)).toEqual(['Express Hand Wash'])
    expect(b.services.addons.map((p: { name: string }) => p.name)).toEqual(['Wax'])
    expect(b.services.packages[0].tasks).toHaveLength(2)
    expect(b.counts).toEqual({ employees: 1 })
  })

  it('matches what the individual routes return', async () => {
    const s = await populate()
    const bundle = json(await h.get('settings/bundle', s))
    const hours = json(await h.get('settings/hours', s))
    expect(bundle.hours.days).toEqual(hours.days)
    expect(bundle.hours.version).toBe(hours.version)
    expect(bundle.rules).toEqual(hours.rules)
    expect(bundle.closures).toEqual({
      upcoming: json(await h.get('closures', s)).upcoming,
      past: json(await h.get('closures', s)).past,
    })
    const vip = json(await h.get('vip', s))
    expect({ ...bundle.vip, clients: undefined }).toEqual({ ...vip, clients: undefined })
    expect(bundle.arrival).toEqual(json(await h.get('arrival-settings', s)))
    expect(bundle.services).toEqual(json(await h.get('services', s)))
    const em = json(await h.get('emergency', s))
    expect(bundle.emergency).toEqual(em)
  })

  it('leaves out what the caller cannot read and says so', async () => {
    await populate()
    const plain = await h.withPermissions([])
    const b = json(await h.get('settings/bundle', plain))
    expect(b.omitted).toEqual(['emergency.history', 'vip.clients', 'counts.employees'])
    expect(Object.keys(BUNDLE_READ_PERMISSIONS)).toEqual(b.omitted)
    expect(b.emergency.history).toBeNull()
    expect(b.emergency.canClose).toBe(false)
    expect(b.vip.clients).toBeUndefined()
    expect(b.vip.counts.clients).toBe(1)
    expect(b.counts).toEqual({})
    // the sections everyone may read are all there
    expect(b.hours.days).toHaveLength(7)
    expect(b.closures.upcoming).toHaveLength(1)
    expect(b.services.packages).toHaveLength(1)
    expect(b.arrival.radius).toBe(300)
  })

  it('adds each part back with its own permission', async () => {
    await populate()
    const em = json(await h.get('settings/bundle', await h.withPermissions(['set.emergency'])))
    expect(em.omitted).toEqual(['vip.clients', 'counts.employees'])
    expect(em.emergency.history).toEqual([])
    expect(em.emergency.canClose).toBe(true)

    const member = json(await h.get('settings/bundle', await h.withPermissions(['cli.member'])))
    expect(member.omitted).toEqual(['emergency.history', 'counts.employees'])
    expect(member.vip.clients).toHaveLength(1)

    const team = json(await h.get('settings/bundle', await h.withPermissions(['team.view'])))
    expect(team.omitted).toEqual(['emergency.history', 'vip.clients'])
    expect(team.counts.employees).toBe(4)

    const all = json(
      await h.get('settings/bundle', await h.withPermissions(['set.emergency', 'cli.member', 'team.view'])),
    )
    expect(all.omitted).toEqual([])
  })

  it('reflects an active emergency in the bundle', async () => {
    const s = await populate()
    await h.post(
      'emergency/close',
      s,
      { reason: 'Power outage', dur: 'today' },
      { 'idempotency-key': 'bundle-key-0001' },
    )
    const b = json(await h.get('settings/bundle', s))
    expect(b.emergency).toMatchObject({
      active: true,
      summary: 'Power outage · closed for the rest of today · online booking paused',
    })
    expect(b.closures.upcoming.some((c: { emergency: boolean }) => c.emergency)).toBe(true)
  })

  it('refuses an anonymous caller', async () => {
    expect((await h.call('GET', 'settings/bundle')).statusCode).toBe(401)
  })
})
