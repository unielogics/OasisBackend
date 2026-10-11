// GET /api/v1/leads (ADR 0160, plan J and K; wave W3b): cli.view; the interest categories in their Settings labels and colours; the
// number only with cli.contact; open leads by default, newest contact first.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { leadsModule } from '../../src/modules/leads/http/module.js'
import { createTestApp, type TestApp } from '../helpers/app.js'
import { STRANGER, STRANGER2, useToolWorld } from '../assistant-tools/world.js'

const w = useToolWorld()
let app: TestApp

beforeAll(async () => {
  app = await createTestApp({ testDb: w.t, modules: [leadsModule] })
})
afterAll(async () => {
  await app?.close()
})

const get = (url: string, perms?: string) => app.app.inject({ method: 'GET', url, headers: perms === undefined ? {} : { 'x-test-permissions': perms } })

async function leads() {
  const maria = w.customer('Maria Delgado')
  const now = w.clock.now()
  await w.t.db
    .insertInto('leads')
    .values([
      { id: w.newId(), location_id: w.locationId, phone_e164: STRANGER, source: 'text', interests: ['tint', 'wash'], first_contact_at: now, last_contact_at: now },
      { id: w.newId(), location_id: w.locationId, phone_e164: maria.phone, customer_id: maria.id, source: 'website', first_contact_at: now, last_contact_at: new Date(now.getTime() + 60_000) },
      { id: w.newId(), location_id: w.locationId, phone_e164: STRANGER2, source: 'walk_in', status: 'closed', closed_at: now, first_contact_at: now, last_contact_at: now },
    ])
    .execute()
  return maria
}

describe('GET /leads', () => {
  it('lists the open leads newest contact first, with the interest labels; the number only with cli.contact', async () => {
    const maria = await leads()
    const r = await get('/api/v1/leads', 'cli.view')
    expect(r.statusCode).toBe(200)
    const body = r.json() as { leads: Record<string, unknown>[] }
    expect(body.leads.map((l) => l.source)).toEqual(['website', 'text'])
    expect(body.leads[0]).toMatchObject({ customerId: maria.id, customerName: 'Maria Delgado', needsName: false, phone: null, status: 'new' })
    expect(body.leads[1]).toMatchObject({
      customerId: null,
      phone: null,
      interests: [
        { key: 'tint', label: 'Tint', colour: expect.stringMatching(/^#/) },
        { key: 'wash', label: 'Wash', colour: expect.stringMatching(/^#/) },
      ],
    })
    expect(r.body).not.toContain(STRANGER.slice(-7))
    expect(r.body).not.toContain(maria.phone.slice(-7))
    const withContact = (await get('/api/v1/leads', 'cli.view,cli.contact')).json() as { leads: { phone: string }[] }
    expect(withContact.leads.map((l) => l.phone)).toEqual([maria.phone, STRANGER])
  })

  it('filters by status and needs cli.view', async () => {
    await leads()
    const all = (await get('/api/v1/leads?status=all', 'cli.view')).json() as { leads: unknown[] }
    expect(all.leads).toHaveLength(3)
    const closed = (await get('/api/v1/leads?status=closed', 'cli.view')).json() as { leads: { status: string }[] }
    expect(closed.leads.map((l) => l.status)).toEqual(['closed'])
    expect((await get('/api/v1/leads', 'sched.view')).statusCode).toBe(403)
    expect((await get('/api/v1/leads?status=bogus', 'cli.view')).statusCode).toBe(422)
  })
})
