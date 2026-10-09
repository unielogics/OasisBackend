import { describe, expect, it } from 'vitest'
import { describeAccess } from '../../src/http/access.js'
import { makeCustomer, makeService } from '../domain-schema/helpers.js'
import { bookCustomer } from './fixtures.js'
import { auditActions, events, json, useSettingsHarness } from './harness.js'

const h = useSettingsHarness()

// backend.md 5.2 and 6.1, route by route. `idem` marks the routes that need an Idempotency-Key.
const EXPECTED: [string, string, string, 'required' | 'optional' | undefined][] = [
  ['GET', '/api/v1/settings/hours', 'authenticated', undefined],
  ['PUT', '/api/v1/settings/hours', 'set.hours', undefined],
  ['GET', '/api/v1/settings/rules', 'authenticated', undefined],
  ['PUT', '/api/v1/settings/rules', 'set.hours', undefined],
  ['GET', '/api/v1/closures', 'authenticated', undefined],
  ['POST', '/api/v1/closures/preview', 'set.hours', undefined],
  ['POST', '/api/v1/closures', 'set.hours', 'optional'],
  ['PATCH', '/api/v1/closures/:id', 'set.hours', undefined],
  ['DELETE', '/api/v1/closures/:id', 'set.hours', undefined],
  ['PUT', '/api/v1/settings/auto-federal-holidays', 'set.hours', undefined],
  ['GET', '/api/v1/emergency', 'authenticated', undefined],
  ['GET', '/api/v1/emergency/preview', 'set.emergency', undefined],
  ['POST', '/api/v1/emergency/close', 'set.emergency', 'required'],
  ['POST', '/api/v1/emergency/reopen', 'set.emergency', 'optional'],
  ['GET', '/api/v1/emergency/history', 'set.emergency', undefined],
  ['GET', '/api/v1/emergency/:id/affected', 'set.emergency', undefined],
  ['GET', '/api/v1/vip', 'authenticated', undefined],
  ['PUT', '/api/v1/vip', 'cli.member', undefined],
  ['POST', '/api/v1/vip/holds', 'cli.member', undefined],
  ['DELETE', '/api/v1/vip/holds/:id', 'cli.member', undefined],
  ['GET', '/api/v1/vip/clients', 'cli.member', undefined],
  ['POST', '/api/v1/vip/clients', 'cli.member', undefined],
  ['DELETE', '/api/v1/vip/clients/:customerId', 'cli.member', undefined],
  ['GET', '/api/v1/arrival-settings', 'authenticated', undefined],
  ['PUT', '/api/v1/arrival-settings', 'cli.member', undefined],
  ['GET', '/api/v1/services', 'authenticated', undefined],
  ['PUT', '/api/v1/services/:id/checklist', 'set.services', undefined],
  ['POST', '/api/v1/services', 'set.services', 'optional'],
  ['PATCH', '/api/v1/services/:id', 'set.services', undefined],
  ['GET', '/api/v1/settings/bundle', 'authenticated', undefined],
  ['GET', '/api/v1/public/hours', 'public', undefined],
]

describe('route permissions match the design (backend.md 5.2 / 6.1)', () => {
  it('declares exactly the expected access and idempotency on every Settings route', async () => {
    const mine = new Set(EXPECTED.map(([m, u]) => `${m} ${u}`))
    const prefixes = [
      '/api/v1/settings/',
      '/api/v1/closures',
      '/api/v1/emergency',
      '/api/v1/vip',
      '/api/v1/arrival-settings',
      '/api/v1/services',
      '/api/v1/public/',
    ]
    const registered = h.t.app.routeRegistry.filter((r) => prefixes.some((p) => r.url.startsWith(p)))
    expect(new Set(registered.map((r) => `${r.method} ${r.url}`))).toEqual(mine)
    for (const [method, url, access, idem] of EXPECTED) {
      const r = registered.find((x) => x.method === method && x.url === url)!
      expect(describeAccess(r.access), `${method} ${url}`).toBe(access)
      expect(r.idempotency, `${method} ${url}`).toBe(idem)
    }
  })
})

describe('every mutation leaves an audit row and a settings.changed event', () => {
  it('walks every mutating route once', async () => {
    const s = await h.admin()
    const express = await makeService(h.db, h.fx, { name: 'Express Hand Wash', tasks: ['Rinse'] })
    const liam = await makeCustomer(h.db, h.fx, { name: 'Liam Chen' })
    await bookCustomer(h.db, h.fx, {
      name: 'Marcus Webb',
      date: '2026-06-13',
      time: '10:15',
      serviceId: express,
    })
    const hours = json(await h.get('settings/hours', s))
    const mark = async (): Promise<number> =>
      (await h.db.selectFrom('audit_log').select('id').execute()).length
    const step = async (label: string, run: () => Promise<{ statusCode: number }>): Promise<string> => {
      const before = await mark()
      const r = await run()
      expect(r.statusCode, label).toBeLessThan(300)
      expect(await mark(), `${label} wrote an audit row`).toBeGreaterThan(before)
      return label
    }
    const done: string[] = []
    done.push(
      await step('hours', () =>
        h.put('settings/hours', s, {
          version: hours.version,
          days: hours.days.map((d: { weekday: number; open: boolean; fromMin: number; toMin: number }) => ({
            weekday: d.weekday,
            open: d.open,
            fromMin: d.fromMin,
            toMin: d.weekday === 6 ? 990 : d.toMin,
          })),
        }),
      ),
    )
    done.push(await step('rules', () => h.put('settings/rules', s, { buffer: 20 })))
    done.push(await step('federal', () => h.put('settings/auto-federal-holidays', s, { enabled: false })))
    let id = ''
    done.push(
      await step('closure create', async () => {
        const r = await h.post('closures', s, { date: '2026-06-20', name: 'Training', notify: false })
        id = json(r).closure.id
        return r
      }),
    )
    done.push(await step('closure patch', () => h.patch(`closures/${id}`, s, { name: 'Training day' })))
    done.push(await step('closure delete', () => h.del(`closures/${id}`, s)))
    done.push(await step('vip', () => h.put('vip', s, { sameDay: 3 })))
    let holdId = ''
    done.push(
      await step('hold add', async () => {
        const r = await h.post('vip/holds', s, { weekday: 6, time: '9:00 AM' })
        holdId = json(r).hold.id
        return r
      }),
    )
    done.push(await step('hold remove', () => h.del(`vip/holds/${holdId}`, s)))
    done.push(await step('client add', () => h.post('vip/clients', s, { customerId: liam })))
    done.push(await step('client remove', () => h.del(`vip/clients/${liam}`, s)))
    done.push(await step('arrival', () => h.put('arrival-settings', s, { welcome: false })))
    done.push(
      await step('checklist', () => h.put(`services/${express}/checklist`, s, { tasks: ['Rinse', 'Dry'] })),
    )
    done.push(
      await step('service create', () =>
        h.post('services', s, { kind: 'addon', name: 'Wax', priceCents: 4000 }),
      ),
    )
    done.push(await step('service patch', () => h.patch(`services/${express}`, s, { priceCents: 5000 })))
    done.push(
      await step('emergency close', () =>
        h.post(
          'emergency/close',
          s,
          { reason: 'Other', dur: 'today' },
          { 'idempotency-key': 'contract-key-1' },
        ),
      ),
    )
    done.push(await step('emergency reopen', () => h.post('emergency/reopen', s)))
    expect(done).toHaveLength(17)

    const actions = await auditActions(h.db)
    for (const a of [
      'settings.hours.update',
      'settings.update',
      'settings.closure.create',
      'settings.closure.update',
      'settings.closure.delete',
      'settings.vip.update',
      'settings.vip.hold.add',
      'settings.vip.hold.remove',
      'settings.vip.client.add',
      'settings.vip.client.remove',
      'settings.arrival.update',
      'catalog.checklist.update',
      'catalog.create',
      'catalog.update',
      'emergency.close',
      'emergency.reopen',
    ])
      expect(actions, a).toContain(a)

    // the audit rows carry the actor and the request
    const row = await h.db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'settings.vip.update')
      .executeTakeFirstOrThrow()
    expect(row).toMatchObject({ actor_name: 'Amara O.', entity_type: 'vip_settings' })
    expect(row.actor_user_id).not.toBeNull()
    expect(row.request_id).toBeTruthy()
    const closeRow = await h.db
      .selectFrom('audit_log')
      .select('idempotency_key')
      .where('action', '=', 'emergency.close')
      .executeTakeFirstOrThrow()
    expect(closeRow.idempotency_key).toBe('contract-key-1')

    const sections = new Set(
      (await events(h.db, 'settings'))
        .filter((e) => e.type === 'settings.changed')
        .map((e) => e.payload.section),
    )
    for (const sec of ['hours', 'federal_holidays', 'closures', 'vip', 'arrival', 'services', 'emergency'])
      expect(sections, sec).toContain(sec)
  })

  it('a refused mutation writes nothing', async () => {
    const s = await h.admin()
    const crew = await h.withPermissions([])
    const before = (await h.db.selectFrom('audit_log').select('id').execute()).length
    await h.post('closures', s, {})
    await h.put('vip', s, { release: 5 })
    await h.put('arrival-settings', s, { radius: 1 })
    await h.put('settings/hours', s, { days: [] })
    await h.put('vip', crew, { release: 24 })
    expect((await h.db.selectFrom('audit_log').select('id').execute()).length).toBe(before)
    expect(await events(h.db, 'settings')).toEqual([])
  })
})
