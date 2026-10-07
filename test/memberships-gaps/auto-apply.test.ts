// Gap 3a: a credit rule can apply itself. plan_credit_rules.auto_apply (default false) and the member's own autoApply flag
// (either one is enough) make completing a covered visit redeem one credit through the payments command layer: exactly once, a
// system adjust on the invoice, a redeem event on the credit ledger and a line in the activity log. Nothing applies by default.
import { describe, expect, it } from 'vitest'
import {
  activityOf,
  completeAs,
  creditEvents,
  creditsOf,
  ledgerOf,
  recordPayment,
  setRuleAutoApply,
  useRig,
} from '../scheduling-gaps/support.js'

const TODAY = '2026-06-13T14:00:00-04:00'
const calc = (m: ReturnType<typeof useRig>, invoiceId: string) =>
  m.h.t.db
    .selectFrom('invoice_calc')
    .select(['total', 'balance', 'paid', 'adj', 'sub'])
    .where('invoice_id', '=', invoiceId)
    .executeTakeFirstOrThrow()

describe('membership credit auto-apply', () => {
  const m = useRig()

  it('is off by default: completing a covered visit consumes nothing and leaves the full balance', async () => {
    const mem = await m.member('Maria Delgado', 'essential')
    const a = await m.book('Maria Delgado', 'Express Hand Wash', TODAY)
    const before = await calc(m, a.invoiceId)
    await completeAs(m, a.appointmentId)
    expect(await creditEvents(m, mem.id, ['redeem'])).toHaveLength(0)
    expect((await creditsOf(m, mem.customerId)).left).toBe(2)
    expect(await calc(m, a.invoiceId)).toMatchObject({ balance: before.balance, adj: 0 })
    expect((await activityOf(m, a.appointmentId)).some((t) => t.includes('Membership credit'))).toBe(false)
  })

  it('a rule marked auto_apply redeems one credit when the visit is completed: ledger, credit event and activity line', async () => {
    const mem = await m.member('Maria Delgado', 'essential')
    await setRuleAutoApply(m, 'essential', 'Express wash', true)
    const a = await m.book('Maria Delgado', 'Express Hand Wash', TODAY)
    const before = await calc(m, a.invoiceId)
    await completeAs(m, a.appointmentId)

    const redeems = await creditEvents(m, mem.id, ['redeem'])
    expect(redeems).toHaveLength(1)
    expect(redeems[0]).toMatchObject({ qty: 1, appointment_id: a.appointmentId })
    expect(redeems[0]!.ledger_event_id).not.toBeNull()
    expect(redeems[0]!.note).toContain('auto-applied')
    const ledger = (await ledgerOf(m, a.invoiceId)).filter((e) => e.type === 'adjust')
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({
      reason: 'Membership credit',
      source: 'system',
      amount_cents: -before.sub,
    })
    expect(await calc(m, a.invoiceId)).toMatchObject({ balance: 0, sub: 0 })
    expect((await creditsOf(m, mem.customerId)).left).toBe(1)
    expect(await activityOf(m, a.appointmentId)).toContain(
      'Membership credit applied automatically · Express wash',
    )
  })

  it('applies exactly once: a manual apply afterwards is refused, and the next visit takes the next credit', async () => {
    const mem = await m.member('Maria Delgado', 'essential')
    await setRuleAutoApply(m, 'essential', 'Express wash', true)
    const a = await m.book('Maria Delgado', 'Express Hand Wash', TODAY)
    await completeAs(m, a.appointmentId)
    const again = await m.send(
      m.superS(),
      'POST',
      `/appointments/${a.appointmentId}/membership-perks/apply`,
      {},
    )
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ code: 'MEMBERSHIP_CREDIT_APPLIED' })
    expect(await creditEvents(m, mem.id, ['redeem'])).toHaveLength(1)
    expect((await ledgerOf(m, a.invoiceId)).filter((e) => e.type === 'adjust')).toHaveLength(1)

    const b = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-13T15:00:00-04:00')
    await completeAs(m, b.appointmentId)
    expect((await creditsOf(m, mem.customerId)).left).toBe(0)
    const c = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-13T16:00:00-04:00')
    const full = await calc(m, c.invoiceId)
    await completeAs(m, c.appointmentId) // no credit left: the visit still completes, nothing is applied
    expect(await creditEvents(m, mem.id, ['redeem'])).toHaveLength(2)
    expect(await calc(m, c.invoiceId)).toMatchObject({ balance: full.balance })
  })

  it('a manual apply before completion is respected: completing does not apply a second time', async () => {
    const mem = await m.member('Maria Delgado', 'essential')
    await setRuleAutoApply(m, 'essential', 'Express wash', true)
    const a = await m.book('Maria Delgado', 'Express Hand Wash', TODAY)
    expect(
      (await m.send(m.superS(), 'POST', `/appointments/${a.appointmentId}/membership-perks/apply`, {}))
        .statusCode,
    ).toBe(201)
    await completeAs(m, a.appointmentId)
    expect(await creditEvents(m, mem.id, ['redeem'])).toHaveLength(1)
    expect((await ledgerOf(m, a.invoiceId)).filter((e) => e.type === 'adjust')).toHaveLength(1)
  })

  it('the member’s own autoApply flag is enough, even when the rule is not marked', async () => {
    const mem = await m.member('Maria Delgado', 'essential')
    const patch = await m.send(m.superS(), 'PATCH', `/memberships/${mem.id}`, { autoApply: true }, false)
    expect(patch.statusCode, patch.body).toBe(200)
    const a = await m.book('Maria Delgado', 'Express Hand Wash', TODAY)
    await completeAs(m, a.appointmentId)
    expect(await creditEvents(m, mem.id, ['redeem'])).toHaveLength(1)
  })

  it('skips quietly when it cannot apply: a service the plan does not cover, a non-member, an invoice with no balance', async () => {
    const mem = await m.member('Maria Delgado', 'essential')
    await setRuleAutoApply(m, 'essential', 'Express wash', true)
    const premium = await m.book('Maria Delgado', 'Premium Hand Wash + Interior', TODAY)
    await completeAs(m, premium.appointmentId)
    const stranger = await m.book('Liam Chen', 'Express Hand Wash', '2026-06-13T15:00:00-04:00')
    await completeAs(m, stranger.appointmentId)
    const prepaid = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-13T16:00:00-04:00')
    const { balance } = await calc(m, prepaid.invoiceId)
    await recordPayment(m, prepaid.invoiceId, balance, { kind: 'cash', deposit: false })
    await completeAs(m, prepaid.appointmentId)
    expect(await creditEvents(m, mem.id, ['redeem'])).toHaveLength(0)
    expect((await creditsOf(m, mem.customerId)).left).toBe(2)
  })

  it('an unlimited rule applies on every covered visit and stays unlimited', async () => {
    const mem = await m.member('Sofia Marchetti', 'executive', { label: 'Executive' })
    await setRuleAutoApply(m, 'executive', 'Express wash', true)
    for (const [i, t] of ['14:00', '15:00'].entries()) {
      const a = await m.book('Sofia Marchetti', 'Express Hand Wash', `2026-06-13T${t}:00-04:00`)
      await completeAs(m, a.appointmentId)
      expect(await creditEvents(m, mem.id, ['redeem'])).toHaveLength(i + 1)
    }
    expect((await creditsOf(m, mem.customerId)).rules.find((r) => r.label === 'Express wash')).toMatchObject({
      unlimited: true,
      left: null,
      used: 2,
    })
  })

  it('needs no payments permission: a crew member who only moves jobs completes and the credit still applies, in their name', async () => {
    const crew = (await m.h.userWithPermissions(['sched.view', 'jobs.status'], 'crewmove@example.test'))
      .session
    const mem = await m.member('Maria Delgado', 'essential')
    await setRuleAutoApply(m, 'essential', 'Express wash', true)
    const a = await m.book('Maria Delgado', 'Express Hand Wash', TODAY)
    await completeAs(m, a.appointmentId, crew)
    const redeem = (await creditEvents(m, mem.id, ['redeem']))[0]!
    expect(redeem).toBeDefined()
    expect(redeem.actor).not.toBeNull()
    expect((await ledgerOf(m, a.invoiceId)).find((e) => e.type === 'adjust')).toMatchObject({
      source: 'system',
    })
  })

  it('plans list their rules with the flag, and only cli.member changes it', async () => {
    const view = (await m.get(m.limited(), '/membership-plans')).json() as {
      plans: { key: string; rules: { id: string; label: string; autoApply: boolean }[] }[]
    }
    expect(view.plans.map((p) => p.key)).toEqual(['essential', 'premium', 'executive', 'exotic'])
    expect(view.plans.flatMap((p) => p.rules).every((r) => r.autoApply === false)).toBe(true)
    const rule = view.plans[0]!.rules[0]!
    expect(
      (await m.send(m.noMember(), 'PATCH', `/membership-plans/rules/${rule.id}`, { autoApply: true }, false))
        .statusCode,
    ).toBe(403)
    const ok = await m.send(
      m.limited(),
      'PATCH',
      `/membership-plans/rules/${rule.id}`,
      { autoApply: true },
      false,
    )
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toMatchObject({ id: rule.id, autoApply: true })
    expect(
      (
        await m.send(
          m.limited(),
          'PATCH',
          `/membership-plans/rules/00000000-0000-7000-8000-000000000000`,
          { autoApply: true },
          false,
        )
      ).statusCode,
    ).toBe(404)
    const audit = await m.h.t.db
      .selectFrom('audit_log')
      .select('action')
      .where('action', '=', 'membership.rule.update')
      .execute()
    expect(audit).toHaveLength(1)
  })
})
