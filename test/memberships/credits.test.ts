// Credits end to end: grants per rule, the explicit "apply credit" command (a system adjust through the payments command
// layer, exempt from the actor's adjust limit), the real MembershipPort and the Operations alert that points at it.
import { describe, expect, it } from 'vitest'
import { dbMembershipPort } from '../../src/modules/memberships/port.js'
import { key, useMemRig } from './harness.js'

interface Applied {
  membershipId: string
  discountCents: number
  rule: { label: string }
  credits: { left: number | null; used: number }
  event: { id: string; type: string; amountCents: number; reason: string | null; source: string; by: string | null }
  invoice: { totals: { totalCents: number; balanceCents: number } } | Record<string, unknown>
}

describe('membership credits', () => {
  const m = useMemRig()
  const apply = (appointmentId: string, idem?: string | false, s = m.superS()) =>
    m.send(s, 'POST', `/appointments/${appointmentId}/membership-perks/apply`, {}, idem)
  const calc = (invoiceId: string) =>
    m.h.t.db.selectFrom('invoice_calc').select(['total', 'balance', 'paid', 'status', 'adj', 'tax', 'sub']).where('invoice_id', '=', invoiceId).executeTakeFirstOrThrow()

  it('plans carry the design perks, colours and credit rules; a new member gets this cycle’s grants', async () => {
    const plans = await m.h.t.db.selectFrom('membership_plans').selectAll().orderBy('sort').execute()
    expect(plans.map((p) => [p.key, p.color, p.bg_color, p.tint, p.addon_discount_bp, p.service_discount_bp])).toEqual([
      ['essential', '#7A8B73', '#E9EDE4', '#5E7A52', 1000, 0],
      ['premium', '#8A6D3B', '#F2E9D6', '#8A6D3B', 1500, 0],
      ['executive', '#3B5A8A', '#E0E8F4', '#3B5A8A', 2000, 0],
      ['exotic', '#7A3B8A', '#EEDFF2', '#7A3B8A', 2500, 2500],
    ])
    expect(plans[0]?.perks).toEqual(['2 express washes / month', 'Priority booking', '10% off add-ons', 'Free vacuum anytime'])
    expect(plans[3]?.perks).toContain('Unlimited hand washes')
    const rules = await m.h.t.db
      .selectFrom('plan_credit_rules as r')
      .innerJoin('membership_plans as p', 'p.id', 'r.plan_id')
      .select(['p.key', 'r.label', 'r.include_tags', 'r.per_cycle'])
      .orderBy('p.sort')
      .orderBy('r.sort')
      .execute()
    expect(rules.map((r) => [r.key, r.include_tags.join(','), r.per_cycle])).toEqual([
      ['essential', 'express', 2],
      ['premium', 'premium', 2],
      ['executive', 'express', null],
      ['executive', 'executive', 2],
      ['exotic', 'handwash', null],
    ])
    const { id } = await m.member('Sofia Marchetti', 'executive')
    const grants = await m.h.t.db.selectFrom('membership_credit_events').select(['kind', 'qty']).where('membership_id', '=', id).orderBy('created_at').execute()
    expect(grants).toEqual([
      { kind: 'grant', qty: null },
      { kind: 'grant', qty: 2 },
    ])
  })

  it('applies two Essential credits, then refuses; one credit per appointment', async () => {
    await m.member('Maria Delgado', 'essential')
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    const r1 = await apply(a.appointmentId)
    expect(r1.statusCode, r1.body).toBe(201)
    const body = r1.json() as Applied
    expect(body.discountCents).toBe(4500)
    expect(body.rule.label).toBe('Express wash')
    expect(body.credits).toEqual({ left: 1, used: 1 })
    // the ledger effect: one system adjust equal to the package line, tax falls with it
    const evs = await m.h.t.db.selectFrom('ledger_events').selectAll().where('invoice_id', '=', a.invoiceId).execute()
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({ type: 'adjust', amount_cents: -4500, source: 'system', reason: 'Membership credit', note: 'Express wash · Essential', status: 'done' })
    expect(await calc(a.invoiceId)).toMatchObject({ adj: -4500, sub: 0, tax: 0, total: 0, balance: 0 })
    const redeem = await m.h.t.db.selectFrom('membership_credit_events').selectAll().where('kind', '=', 'redeem').executeTakeFirstOrThrow()
    expect(redeem).toMatchObject({ qty: 1, appointment_id: a.appointmentId, invoice_id: a.invoiceId, ledger_event_id: evs[0]!.id })
    // the same appointment again
    const again = await apply(a.appointmentId)
    expect(again.statusCode).toBe(409)
    expect((again.json() as { code: string }).code).toBe('MEMBERSHIP_CREDIT_APPLIED')
    // the second credit
    const b = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-13T15:00:00-04:00')
    const r2 = await apply(b.appointmentId)
    expect(r2.statusCode, r2.body).toBe(201)
    expect((r2.json() as Applied).credits).toEqual({ left: 0, used: 2 })
    // none left
    const c = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-13T16:00:00-04:00')
    const r3 = await apply(c.appointmentId)
    expect(r3.statusCode).toBe(409)
    expect((r3.json() as { code: string }).code).toBe('MEMBERSHIP_NO_CREDIT')
    expect(await m.h.t.db.selectFrom('ledger_events').select('id').where('invoice_id', '=', c.invoiceId).execute()).toHaveLength(0)
  })

  it('a replay of the same request applies once', async () => {
    await m.member('Maria Delgado', 'essential')
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    const k = key()
    const r1 = await apply(a.appointmentId, k)
    const r2 = await apply(a.appointmentId, k)
    expect(r1.statusCode).toBe(201)
    expect(r2.headers['idempotent-replayed']).toBe('true')
    expect(r2.body).toBe(r1.body)
    expect(await m.h.t.db.selectFrom('ledger_events').select('id').where('invoice_id', '=', a.invoiceId).execute()).toHaveLength(1)
    expect((await apply(a.appointmentId, false)).statusCode).toBe(400)
  })

  it('needs cli.member, not pay.adjust, and is exempt from the adjust limit but attributed to the person', async () => {
    await m.member('Priya Nair', 'premium')
    const a = await m.book('Priya Nair', 'Premium Hand Wash + Interior') // $129.00, far over the $25 default adjust limit
    expect((await apply(a.appointmentId, undefined, m.noMember())).statusCode).toBe(403)
    const ok = await apply(a.appointmentId, undefined, m.limited())
    expect(ok.statusCode, ok.body).toBe(201)
    const ev = await m.h.t.db.selectFrom('ledger_events').selectAll().where('invoice_id', '=', a.invoiceId).executeTakeFirstOrThrow()
    expect(ev).toMatchObject({ type: 'adjust', source: 'system', amount_cents: -12900, reason: 'Membership credit' })
    const limited = await m.h.t.db.selectFrom('users').select('id').where('email', '=', 'limited@example.test').executeTakeFirstOrThrow()
    expect(ev.actor_user_id).toBe(limited.id)
    expect(await calc(a.invoiceId)).toMatchObject({ total: 0, balance: 0 })
    // a normal manual adjust of the same size by the same kind of limited actor is still blocked by the limit
    const over = await m.send(m.noMember(), 'POST', `/invoices/${a.invoiceId}/adjustments`, { kind: 'discount', unit: '$', value: 12900 })
    expect(over.statusCode, over.body).toBe(422)
    expect((over.json() as { code: string }).code).toBe('OVER_LIMIT')
  })

  it('unlimited rules never run out and show as infinity (null)', async () => {
    await m.member('Aisha Rahman', 'exotic')
    for (const [i, start] of ['2026-06-13T13:00:00-04:00', '2026-06-13T14:00:00-04:00', '2026-06-13T15:00:00-04:00'].entries()) {
      const a = await m.book('Aisha Rahman', 'Express Hand Wash', start)
      const r = await apply(a.appointmentId)
      expect(r.statusCode, `${i}: ${r.body}`).toBe(201)
      expect((r.json() as Applied).credits).toEqual({ left: null, used: i + 1 })
    }
  })

  it('refuses where there is nothing to credit: not a member, inactive, not covered, nothing due, closed', async () => {
    const stranger = await m.book('Tom Bradley', 'Express Hand Wash', '2026-06-13T11:00:00-04:00')
    const r0 = await apply(stranger.appointmentId)
    expect(r0.statusCode).toBe(404)
    expect((r0.json() as { code: string }).code).toBe('MEMBERSHIP_NOT_FOUND')

    const mem = await m.member('Maria Delgado', 'essential')
    const notCovered = await m.book('Maria Delgado', 'Premium Hand Wash + Interior', '2026-06-13T12:00:00-04:00')
    const r1 = await apply(notCovered.appointmentId)
    expect((r1.json() as { code: string }).code).toBe('MEMBERSHIP_NOT_ELIGIBLE')

    const paid = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-13T13:00:00-04:00')
    expect((await m.send(m.superS(), 'POST', `/invoices/${paid.invoiceId}/payments`, { method: 'cash' })).statusCode).toBe(201)
    const r2 = await apply(paid.appointmentId)
    expect((r2.json() as { code: string }).code).toBe('MEMBERSHIP_NO_BALANCE')

    const closed = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-13T14:00:00-04:00')
    expect((await m.send(m.superS(), 'POST', `/appointments/${closed.appointmentId}/cancel`, { reason: 'Customer canceled' })).statusCode).toBeLessThan(300)
    const r3 = await apply(closed.appointmentId)
    expect((r3.json() as { code: string }).code).toBe('MEMBERSHIP_APPOINTMENT_CLOSED')

    const ok = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-13T15:00:00-04:00')
    expect((await m.send(m.superS(), 'PATCH', `/memberships/${mem.id}`, { status: 'paused' })).statusCode).toBe(200)
    const r4 = await apply(ok.appointmentId)
    expect(r4.statusCode).toBe(409)
    expect((r4.json() as { code: string }).code).toBe('MEMBERSHIP_NOT_ACTIVE')
    expect((await apply('00000000-0000-7000-8000-000000000000')).statusCode).toBe(404)
  })

  it('the port reports credits left, whether this appointment has an eligible credit, perks and the renewal date', async () => {
    await m.member('Maria Delgado', 'essential')
    const express = await m.book('Maria Delgado', 'Express Hand Wash')
    const premium = await m.book('Maria Delgado', 'Premium Hand Wash + Interior', '2026-06-13T15:00:00-04:00')
    const customerId = await m.customer('Maria Delgado')
    const refs = [
      { appointmentId: express.appointmentId, customerId, membershipId: null },
      { appointmentId: premium.appointmentId, customerId, membershipId: null },
    ]
    const before = await dbMembershipPort.forAppointments(m.h.t.db, refs)
    const e = before.get(express.appointmentId)!
    expect(e).toMatchObject({
      plan: 'Essential',
      planKey: 'essential',
      creditsLeft: 2,
      creditsUsed: 0,
      creditAvailable: true,
      renewLabel: 'Jul 12, 2026',
      color: '#7A8B73',
      bgColor: '#E9EDE4',
      tint: '#5E7A52',
    })
    expect(e.perks).toHaveLength(4)
    expect(e.retention).toMatchObject({ label: 'New member', tone: 'green' })
    expect(before.get(premium.appointmentId)?.creditAvailable).toBe(false)
    await apply(express.appointmentId)
    const after = await dbMembershipPort.forAppointments(m.h.t.db, refs)
    expect(after.get(express.appointmentId)).toMatchObject({ creditsLeft: 1, creditsUsed: 1, creditAvailable: false })
    // a client who is not a member has no entry; neither does a paused member
    const tom = await m.customer('Tom Bradley')
    expect((await dbMembershipPort.forAppointments(m.h.t.db, [{ appointmentId: express.appointmentId, customerId: tom, membershipId: null }])).size).toBe(0)
  })

  it('alert 9 points at an unused credit on a completed, unpaid job, and the file carries the membership tab data', async () => {
    await m.member('Priya Nair', 'premium')
    const a = await m.book('Priya Nair', 'Premium Hand Wash + Interior')
    await m.complete(a.appointmentId)
    const alerts = await m.get(m.superS(), '/ops/alerts')
    expect(alerts.statusCode, alerts.body).toBe(200)
    const list = (alerts.json() as { alerts: { kind: string; title: string; desc: string; action: { type: string } }[] }).alerts
    const credit = list.find((x) => x.kind === 'member_credit')
    expect(credit).toMatchObject({ title: 'Member credit available', desc: 'Priya Nair has 1 unused Premium credit this cycle', action: { type: 'apply_credit' } })
    const file = await m.get(m.superS(), `/appointments/${a.appointmentId}`)
    const membership = (file.json() as { membership: { plan: string; perks: string[]; renewLabel: string; retention: { label: string }; creditAvailable: boolean } }).membership
    expect(membership).toMatchObject({ plan: 'Premium', renewLabel: 'Jul 12, 2026', creditAvailable: true })
    expect(membership.perks).toContain('Free rain repellent')
    expect(membership.retention.label).toBe('Loyal · low risk')
    await apply(a.appointmentId)
    const after = (await m.get(m.superS(), '/ops/alerts')).json() as { alerts: { kind: string }[] }
    expect(after.alerts.some((x) => x.kind === 'member_credit')).toBe(false)
  })
})
