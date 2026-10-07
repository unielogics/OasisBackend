// The membership routes through the real session authorizer: the client file (GET /customers/:id/membership), the list, manual
// create and PATCH override.
import { describe, expect, it } from 'vitest'
import { useMemRig } from './harness.js'

interface View {
  id: string
  status: string
  source: string
  plan: { key: string; label: string; perks: string[] }
  renewsAt: string | null
  renewLabel: string | null
  memberMonths: number
  credits: { left: number | null; used: number; rules: { label: string; left: number | null; unlimited: boolean }[] }
  retention: { label: string; desc: string; tone: string; state: string }
  version: number
  autoApply: boolean
  canceledAt: string | null
}

describe('membership routes', () => {
  const m = useMemRig()

  it('POST /memberships adds a manual member with the cycle’s credits (cli.member only, no duplicate member)', async () => {
    const cid = await m.customer('Maria Delgado')
    expect((await m.send(m.noMember(), 'POST', '/memberships', { customerId: cid, planKey: 'essential' })).statusCode).toBe(403)
    const res = await m.send(m.limited(), 'POST', '/memberships', { customerId: cid, planKey: 'essential', renewsOn: '2026-07-12' }, false)
    expect(res.statusCode, res.body).toBe(201)
    const v = (res.json() as { membership: View }).membership
    expect(v).toMatchObject({ status: 'active', source: 'manual', renewLabel: 'Jul 12, 2026', autoApply: false })
    expect(v.plan).toMatchObject({ key: 'essential', label: 'Essential' })
    expect(v.credits).toMatchObject({ left: 2, used: 0 })
    expect(new Date(v.renewsAt!).toISOString()).toBe('2026-07-12T16:00:00.000Z') // noon in New York
    const dup = await m.send(m.limited(), 'POST', '/memberships', { customerId: cid, planKey: 'premium' }, false)
    expect(dup.statusCode).toBe(409)
    expect((dup.json() as { code: string }).code).toBe('MEMBERSHIP_EXISTS')
    expect((await m.send(m.limited(), 'POST', '/memberships', { customerId: '00000000-0000-7000-8000-000000000000', planKey: 'premium' }, false)).statusCode).toBe(404)
    expect((await m.send(m.limited(), 'POST', '/memberships', { customerId: cid }, false)).statusCode).toBe(422)
  })

  it('GET /customers/:id/membership: plan, perks, credits, renewal, retention, history; non-member gets upgrade candidacy', async () => {
    const mem = await m.member('Sofia Marchetti', 'executive', { label: 'Executive' })
    const cid = mem.customerId
    const res = await m.get(m.limited(), `/customers/${cid}/membership`)
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as { membership: View; upgrade: unknown; history: { visitCount: number; lifetimeSpendCents: number; avgFreqDays: number | null; favPackage: string | null } }
    expect(body.membership.plan.perks).toContain('Dedicated detailer')
    expect(body.membership.credits.left).toBeNull() // unlimited express
    expect(body.membership.credits.rules.map((r) => [r.label, r.left, r.unlimited])).toEqual([
      ['Express wash', null, true],
      ['Executive detail', 2, false],
    ])
    expect(body.membership.retention).toMatchObject({ label: 'New member', state: 'new' })
    expect(body.upgrade).toBeNull()
    expect(body.history).toEqual({ visitCount: 0, lifetimeSpendCents: 0, avgFreqDays: null, favPackage: null })
    // not a member: three completed visits in 60 days make an upgrade candidate with the real number in the copy
    const tom = await m.customer('Tom Bradley')
    const svc = await m.h.t.db.selectFrom('services').select(['id', 'name']).where('name', '=', 'Express Hand Wash').where('kind', '=', 'package').executeTakeFirstOrThrow()
    const days = [3, 20, 40]
    for (const d of days) {
      const at = new Date(m.h.clock.now().getTime() - d * 86_400_000)
      await m.h.t.db
        .insertInto('appointments')
        .values({
          id: m.h.t.app.newId(),
          location_id: m.locationId(),
          customer_id: tom,
          service_id: svc.id,
          package_name: svc.name,
          price_cents: 4500,
          duration_min: 30,
          status: 'completed',
          scheduled_start: at,
          scheduled_end: new Date(at.getTime() + 1_800_000),
          completed_at: new Date(at.getTime() + 1_800_000),
        })
        .execute()
    }
    const t = (await m.get(m.limited(), `/customers/${tom}/membership`)).json() as { membership: unknown; upgrade: { candidate: boolean; visits60: number; copy: string }; history: { visitCount: number; avgFreqDays: number; favPackage: string } }
    expect(t.membership).toBeNull()
    expect(t.upgrade).toEqual({
      candidate: true,
      visits60: 3,
      copy: 'Tom Bradley is a strong upgrade candidate — 3 visits in 60 days. Offer Essential at check-out.',
    })
    expect(t.history).toMatchObject({ visitCount: 3, avgFreqDays: 18.5, favPackage: 'Express Hand Wash' })
    expect((await m.get(m.limited(), '/customers/00000000-0000-7000-8000-000000000000/membership')).statusCode).toBe(404)
    const crewLike = await m.h.userWithPermissions(['sched.view'])
    expect((await m.get(crewLike.session, `/customers/${cid}/membership`)).statusCode).toBe(403)
  })

  it('GET /memberships lists members with filters, paging and a count per status (cli.member)', async () => {
    await m.member('Maria Delgado', 'essential')
    await m.member('Priya Nair', 'premium', { label: 'Premium Care' })
    const sofia = await m.member('Sofia Marchetti', 'executive')
    await m.send(m.superS(), 'PATCH', `/memberships/${sofia.id}`, { status: 'paused' }, false)
    expect((await m.get(m.noMember(), '/memberships')).statusCode).toBe(403)
    const all = (await m.get(m.limited(), '/memberships')).json() as { items: (View & { customer: { name: string } })[]; nextCursor: string | null; counts: Record<string, number> }
    expect(all.items.map((i) => i.customer.name)).toEqual(['Maria Delgado', 'Priya Nair', 'Sofia Marchetti'])
    expect(all.counts).toEqual({ pending: 0, active: 2, past_due: 0, paused: 1, canceled: 0 })
    expect(all.items[1]?.plan).toMatchObject({ key: 'premium', label: 'Premium Care' })
    const active = (await m.get(m.limited(), '/memberships?status=active')).json() as { items: unknown[] }
    expect(active.items).toHaveLength(2)
    const exec = (await m.get(m.limited(), '/memberships?plan=executive')).json() as { items: unknown[] }
    expect(exec.items).toHaveLength(1)
    const q = (await m.get(m.limited(), '/memberships?q=priy')).json() as { items: { customer: { name: string } }[] }
    expect(q.items.map((i) => i.customer.name)).toEqual(['Priya Nair'])
    const p1 = (await m.get(m.limited(), '/memberships?limit=2')).json() as { items: unknown[]; nextCursor: string }
    expect(p1.items).toHaveLength(2)
    const p2 = (await m.get(m.limited(), `/memberships?limit=2&cursor=${p1.nextCursor}`)).json() as { items: { customer: { name: string } }[]; nextCursor: string | null }
    expect(p2.items.map((i) => i.customer.name)).toEqual(['Sofia Marchetti'])
    expect(p2.nextCursor).toBeNull()
  })

  it('PATCH overrides status, tier, renewal and auto-apply, audited, with optimistic versions', async () => {
    const mem = await m.member('Maria Delgado', 'essential')
    expect((await m.send(m.noMember(), 'PATCH', `/memberships/${mem.id}`, { status: 'paused' }, false)).statusCode).toBe(403)
    const upgraded = await m.send(m.limited(), 'PATCH', `/memberships/${mem.id}`, { planKey: 'exotic', planLabel: 'Exotic', renewsOn: '2026-08-01', autoApply: true }, false)
    expect(upgraded.statusCode, upgraded.body).toBe(200)
    const v = (upgraded.json() as { membership: View }).membership
    expect(v).toMatchObject({ autoApply: true, renewLabel: 'Aug 1, 2026', version: 2 })
    expect(v.plan.key).toBe('exotic')
    expect(v.credits.left).toBeNull() // exotic: unlimited hand washes, granted for this cycle on the change
    const stale = await m.send(m.limited(), 'PATCH', `/memberships/${mem.id}`, { status: 'paused', expectedVersion: 1 }, false)
    expect(stale.statusCode).toBe(412)
    const canceled = await m.send(m.limited(), 'PATCH', `/memberships/${mem.id}`, { status: 'canceled', note: 'moved away', expectedVersion: 2 }, false)
    expect(canceled.statusCode).toBe(200)
    const c = (canceled.json() as { membership: View }).membership
    expect(c.status).toBe('canceled')
    expect(c.canceledAt).not.toBeNull()
    const row = await m.h.t.db.selectFrom('memberships').select(['cancel_reason', 'manual_status_at']).where('id', '=', mem.id).executeTakeFirstOrThrow()
    expect(row.cancel_reason).toBe('moved away')
    expect(row.manual_status_at).not.toBeNull()
    const reactivated = await m.send(m.limited(), 'PATCH', `/memberships/${mem.id}`, { status: 'active' }, false)
    expect((reactivated.json() as { membership: View }).membership).toMatchObject({ status: 'active', canceledAt: null })
    const audits = await m.h.t.db.selectFrom('audit_log').select(['action', 'actor_name']).where('entity_type', '=', 'membership').where('action', '=', 'membership.edited').execute()
    expect(audits).toHaveLength(3)
    expect((await m.send(m.limited(), 'PATCH', '/memberships/00000000-0000-7000-8000-000000000000', { status: 'paused' }, false)).statusCode).toBe(404)
    expect((await m.send(m.limited(), 'PATCH', `/memberships/${mem.id}`, { status: 'bogus' }, false)).statusCode).toBe(422)
    expect((await m.send(m.limited(), 'PATCH', `/memberships/${mem.id}`, { unknown: 1 }, false)).statusCode).toBe(422)
  })
})
