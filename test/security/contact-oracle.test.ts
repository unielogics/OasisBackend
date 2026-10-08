// Adversarial review (rv/sec): GET /customers refuses to match a phone number for someone without cli.contact "so a number
// typed into the box never reveals who owns it". POST /customers (find or create by phone) is the same lookup by another door:
// for such a caller a number that belongs to someone answers a masked match (initials only, no id, contact or vehicles) and
// leaves the record untouched; the "existing customer" signal (created: false) stays.
import { describe, expect, it } from 'vitest'
import { runSeed } from '../../db/seeds/index.js'
import { useHarness } from '../auth/harness.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>

describe('SEC-10 phone-to-name lookup without cli.contact', () => {
  const h = useHarness()

  const target = async () => {
    await runSeed({ db: h.t.db, clock: h.clock, profile: 'parity-ops' })
    return h.t.db
      .selectFrom('customers as c')
      .select(['c.id', 'c.full_name', 'c.phone_display', 'c.email', 'c.version'])
      .where('c.full_name', '=', 'Liam Chen')
      .executeTakeFirstOrThrow()
  }

  it('does not tell a person without cli.contact who owns a number', async () => {
    const who = await target()
    // the default "Shift Lead" custom role: Crew plus sched.edit, no cli.contact
    const { session } = await h.userWithPermissions(
      ['sched.view', 'sched.edit', 'cli.view'],
      'lead@example.test',
    )

    const search = await h.call('GET', `customers?q=${encodeURIComponent(who.phone_display!)}`, { session })
    expect((search.json() as Json).items).toEqual([]) // the guard the search route documents

    const probe = await h.call('POST', 'customers', {
      session,
      body: {
        phone: who.phone_display,
        name: 'Somebody Else',
        email: 'planted@example.test',
        vehicle: { make: 'Fiat', model: 'Panda', plate: 'PLANT-1' },
      },
    })
    expect(probe.statusCode).toBe(201)
    const body = probe.json() as Json
    expect(body).toEqual({
      created: false,
      masked: true,
      customer: {
        id: null,
        fullName: 'L. C.',
        phone: null,
        email: null,
        vip: false,
        needsDetails: false,
        vehicles: [],
      },
    })
    expect(JSON.stringify(body)).not.toContain(who.id)
    expect(JSON.stringify(body)).not.toContain('Chen')

    // nothing was written into a record the caller cannot see
    const after = await h.t.db
      .selectFrom('customers')
      .select(['full_name', 'email', 'version'])
      .where('id', '=', who.id)
      .executeTakeFirstOrThrow()
    expect(after).toEqual({ full_name: who.full_name, email: who.email, version: who.version })
    const planted = await h.t.db.selectFrom('vehicles').select('id').where('plate', '=', 'PLANT-1').execute()
    expect(planted).toEqual([])
  })

  it('still creates a new customer for a number nobody owns, and shows it in full', async () => {
    await target()
    const { session } = await h.userWithPermissions(
      ['sched.view', 'sched.edit', 'cli.view'],
      'lead2@example.test',
    )
    const res = await h.call('POST', 'customers', {
      session,
      body: { phone: '(305) 555-0177', name: 'New Person' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as Json
    expect(body).toMatchObject({
      created: true,
      masked: false,
      customer: { fullName: 'New Person', phone: null },
    })
    expect(typeof body.customer.id).toBe('string')
  })

  it('answers the full record to a caller with cli.contact', async () => {
    const who = await target()
    const { session } = await h.userWithPermissions(
      ['sched.view', 'sched.edit', 'cli.view', 'cli.contact'],
      'desk@example.test',
    )
    const res = await h.call('POST', 'customers', { session, body: { phone: who.phone_display } })
    expect(res.json()).toMatchObject({
      created: false,
      masked: false,
      customer: { id: who.id, fullName: 'Liam Chen', phone: who.phone_display },
    })
  })
})
