// Held invariants of "Apply credit": credits are never over-spent when requests race, one appointment redeems at most once
// whatever the Idempotency-Key, and the system adjust is the only ledger effect.
import { describe, expect, it } from 'vitest'
import { key, useMemRig } from '../memberships/harness.js'

describe('membership credit under concurrency', () => {
  const m = useMemRig()
  const apply = (appointmentId: string, idem: string = key()) =>
    m.send(m.superS(), 'POST', `/appointments/${appointmentId}/membership-perks/apply`, {}, idem)

  it('three appointments racing for the two credits of the cycle: two win, one is refused', async () => {
    await m.member('Maria Delgado', 'essential')
    const a = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-13T14:00:00-04:00')
    const b = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-13T15:00:00-04:00')
    const c = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-13T16:00:00-04:00')
    const results = await Promise.all([
      apply(a.appointmentId),
      apply(b.appointmentId),
      apply(c.appointmentId),
    ])
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 201, 409])
    const redeems = await m.h.t.db
      .selectFrom('membership_credit_events')
      .select('id')
      .where('kind', '=', 'redeem')
      .execute()
    expect(redeems).toHaveLength(2)
    const adjusts = await m.h.t.db
      .selectFrom('ledger_events')
      .select('id')
      .where('type', '=', 'adjust')
      .execute()
    expect(adjusts).toHaveLength(2)
  })

  it('one appointment applied twice at once with different keys redeems once', async () => {
    await m.member('Maria Delgado', 'essential')
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    const results = await Promise.all([apply(a.appointmentId), apply(a.appointmentId)])
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409])
    expect(
      await m.h.t.db
        .selectFrom('membership_credit_events')
        .select('id')
        .where('kind', '=', 'redeem')
        .execute(),
    ).toHaveLength(1)
    expect(
      await m.h.t.db.selectFrom('ledger_events').select('id').where('invoice_id', '=', a.invoiceId).execute(),
    ).toHaveLength(1)
  })

  it('a deposit already paid turns into a normal settlement refund to store credit (done for an unlimited caller)', async () => {
    await m.member('Maria Delgado', 'essential')
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    await m.h.t.db
      .insertInto('ledger_events')
      .values({
        id: m.h.t.app.newId(),
        location_id: m.locationId(),
        invoice_id: a.invoiceId,
        customer_id: await m.customer('Maria Delgado'),
        type: 'pay',
        amount_cents: 2000,
        status: 'done',
        method: 'Cash',
        method_kind: 'cash',
        deposit: true,
        actor_name: 'Test',
        occurred_at: m.h.clock.now(),
        source: 'oasis',
        processor_state: 'na',
      })
      .execute()
    const res = await apply(a.appointmentId)
    // the credit is applied only while a balance is due: 45.00 + tax less the 20.00 deposit is still due
    expect(res.statusCode, res.body).toBe(201)
    const refunds = await m.h.t.db
      .selectFrom('ledger_events')
      .select(['amount_cents', 'dest', 'status', 'reason'])
      .where('invoice_id', '=', a.invoiceId)
      .where('type', '=', 'refund')
      .execute()
    // the credit takes the whole package off: the 20.00 deposit becomes store credit (super is unlimited, so it is done)
    expect(refunds).toEqual([
      { amount_cents: 2000, dest: 'credit', status: 'done', reason: 'Adjustment settlement' },
    ])
    const calc = await m.h.t.db
      .selectFrom('invoice_calc')
      .select(['total', 'paid', 'refunded', 'balance'])
      .where('invoice_id', '=', a.invoiceId)
      .executeTakeFirstOrThrow()
    expect(calc).toMatchObject({ total: 0, paid: 2000, refunded: 2000, balance: 0 })
  })

  it('for a caller without pay.refund the same settlement waits for approval and the credit is still not spendable', async () => {
    await m.member('Maria Delgado', 'essential')
    const a = await m.book('Maria Delgado', 'Express Hand Wash')
    await m.h.t.db
      .insertInto('ledger_events')
      .values({
        id: m.h.t.app.newId(),
        location_id: m.locationId(),
        invoice_id: a.invoiceId,
        customer_id: await m.customer('Maria Delgado'),
        type: 'pay',
        amount_cents: 2000,
        status: 'done',
        method: 'Cash',
        method_kind: 'cash',
        deposit: true,
        actor_name: 'Test',
        occurred_at: m.h.clock.now(),
        source: 'oasis',
        processor_state: 'na',
      })
      .execute()
    const res = await m.send(
      m.limited(),
      'POST',
      `/appointments/${a.appointmentId}/membership-perks/apply`,
      {},
      key(),
    )
    expect(res.statusCode, res.body).toBe(201)
    const refund = await m.h.t.db
      .selectFrom('ledger_events')
      .select(['amount_cents', 'status', 'dest'])
      .where('invoice_id', '=', a.invoiceId)
      .where('type', '=', 'refund')
      .executeTakeFirstOrThrow()
    expect(refund).toEqual({ amount_cents: 2000, status: 'pending', dest: 'credit' })
    const credit = await m.get(m.superS(), `/clients/${await m.customer('Maria Delgado')}/credit`)
    expect((credit.json() as { balanceCents: number }).balanceCents).toBe(0)
  })
})
