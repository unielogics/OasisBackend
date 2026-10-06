// Adjust (discount / surcharge, $ and %, limits, settlement), issue credit (expiry), void, and store-credit FIFO with expiry.
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { addEvent, makeCustomer, makeInvoice } from './helpers.js'
import { freshKey, usePayHarness, type Person } from './http.js'

const p = usePayHarness()

interface Ev {
  id: string
  type: string
  status: string
  amountCents: number
  dest: string | null
  method: string | null
  processorState: string
  parentEventId: string | null
  reason: string | null
  expiresAt: string | null
  expiryLabel: string | null
  voided: boolean
}
interface Detail {
  status: string
  calc: {
    total: number
    sub: number
    tax: number
    balance: number
    paid: number
    refunded: number
    refundable: number
    overpaid: number
    adj: number
  }
  clientCredit: { balanceCents: number; nextExpiry: { at: string; cents: number } | null }
  ledger: Ev[]
  adjustments: { kind: string; amountCents: number; reason: string }[]
}
interface AdjustResult {
  event: Ev
  settlement: Ev | null
  invoice: Detail
}

async function paidInvoice(
  items = [
    { name: 'Premium Hand Wash + Interior', priceCents: 12900 },
    { name: 'Rain repellent', priceCents: 2500 },
  ],
) {
  const inv = await makeInvoice(p.h.t.db, p.env(), { items })
  const sub = items.reduce((a, i) => a + i.priceCents, 0)
  const total = sub + Math.floor((sub * 700 + 5000) / 10000)
  await addEvent(p.h.t.db, p.env(), inv, {
    type: 'pay',
    amountCents: total,
    method: 'Visa ••4421',
    methodKind: 'card',
    processorState: 'confirmed',
  })
  return { ...inv, total }
}

const adjust = (who: keyof ReturnType<typeof p.people>, id: string, body: Record<string, unknown>) =>
  p.send(p.people()[who], 'POST', `invoices/${id}/adjustments`, body)

describe('adjust', () => {
  it('a $ discount on an unpaid invoice lowers the total and creates no settlement', async () => {
    const inv = await makeInvoice(p.h.t.db, p.env())
    const res = await adjust('rafael', inv.id, {
      kind: 'discount',
      unit: '$',
      value: 2500,
      reason: 'Loyalty',
    })
    expect(res.statusCode).toBe(201)
    const b = p.json<AdjustResult>(res)
    expect(b.event).toMatchObject({ type: 'adjust', amountCents: -2500, reason: 'Loyalty' })
    expect(b.settlement).toBeNull()
    expect(b.invoice.calc).toMatchObject({ adj: -2500, sub: 12900, tax: 903, total: 13803, balance: 13803 })
    expect(b.invoice.adjustments).toEqual([expect.objectContaining({ kind: 'discount', amountCents: -2500 })])
  })

  it('percent of the items subtotal in basis points, half-up: 10% of 15400 is 1540', async () => {
    const inv = await makeInvoice(p.h.t.db, p.env())
    const b = p.json<AdjustResult>(
      await adjust('rafael', inv.id, { kind: 'discount', unit: '%', value: 1000 }),
    )
    expect(b.event.amountCents).toBe(-1540)
    expect(b.event.reason).toBe('Service recovery')
  })

  it('a surcharge adds before tax', async () => {
    const inv = await makeInvoice(p.h.t.db, p.env(), {
      items: [{ name: 'Exotic Detail Package', priceCents: 65000 }],
    })
    const b = p.json<AdjustResult>(
      await adjust('rafael', inv.id, {
        kind: 'surcharge',
        unit: '$',
        value: 4000,
        reason: 'Extra soil surcharge',
      }),
    )
    expect(b.invoice.calc).toMatchObject({ adj: 4000, sub: 69000, tax: 4830, total: 73830 })
  })

  it('over the adjust limit is blocked with the design text; there is no approval path', async () => {
    const inv = await makeInvoice(p.h.t.db, p.env())
    const res = await adjust('sofia', inv.id, { kind: 'discount', unit: '$', value: 3000 })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({
      code: 'OVER_LIMIT',
      detail: 'Over your $25 limit as Customer Support. Ask Management or a Super Admin.',
    })
    expect((await adjust('sofia', inv.id, { kind: 'surcharge', unit: '$', value: 2600 })).statusCode).toBe(
      422,
    )
    expect((await adjust('sofia', inv.id, { kind: 'discount', unit: '$', value: 2500 })).statusCode).toBe(201)
    expect(
      await p.h.t.db.selectFrom('ledger_events').select('id').where('type', '=', 'adjust').execute(),
    ).toHaveLength(1)
  })

  it('a discount larger than the invoice is refused; a canceled invoice cannot be adjusted', async () => {
    const inv = await makeInvoice(p.h.t.db, p.env())
    const big = await adjust('amara', inv.id, { kind: 'discount', unit: '$', value: 99_999_00 })
    expect(big.statusCode).toBe(422)
    expect(big.json()).toMatchObject({
      code: 'ADJUST_EXCEEDS_INVOICE',
      detail: 'Discount is larger than the invoice.',
    })
    await p.h.t.db
      .updateTable('invoices')
      .set({ canceled_at: p.h.clock.now(), cancel_reason: 'canceled' })
      .where('id', '=', inv.id)
      .execute()
    const canceled = await adjust('rafael', inv.id, { kind: 'discount', unit: '$', value: 100 })
    expect(canceled.statusCode).toBe(409)
    expect(canceled.json()).toMatchObject({ code: 'INVOICE_CANCELED' })
  })

  it('settlement of an overpaid invoice is a NORMAL refund event: store credit by default, linked to the adjustment', async () => {
    const inv = await paidInvoice()
    const b = p.json<AdjustResult>(
      await adjust('rafael', inv.id, { kind: 'discount', unit: '%', value: 1000 }),
    )
    // 15400 - 1540 = 13860, tax 970, total 14830; paid 16478 -> 1648 comes back
    expect(b.invoice.calc).toMatchObject({ total: 14830, overpaid: 0 })
    expect(b.settlement).toMatchObject({
      type: 'refund',
      status: 'done',
      amountCents: 1648,
      dest: 'credit',
      method: 'Store credit',
      reason: 'Adjustment settlement',
      parentEventId: b.event.id,
      processorState: 'na',
    })
    expect(b.invoice.clientCredit.balanceCents).toBe(1648)
  })

  it('settle to card follows the processor rules: awaiting Squarespace, capped by what was paid by card', async () => {
    const inv = await paidInvoice()
    const b = p.json<AdjustResult>(
      await adjust('rafael', inv.id, { kind: 'discount', unit: '$', value: 2000, settle: 'card' }),
    )
    expect(b.settlement).toMatchObject({
      dest: 'card',
      method: 'Visa ••4421',
      processorState: 'awaiting_processor',
      status: 'done',
      amountCents: 2140,
    })
  })

  it("the settlement obeys the actor's refund limit: without pay.refund it waits for approval", async () => {
    const inv = await paidInvoice()
    const { session } = await p.h.userWithPermissions(['pay.adjust'], 'adjust-only@example.test')
    const res = await p.h.call('POST', `invoices/${inv.id}/adjustments`, {
      session,
      body: { kind: 'discount', unit: '$', value: 2000 },
      headers: { 'idempotency-key': freshKey() },
    })
    expect(res.statusCode).toBe(201)
    const b = res.json<AdjustResult>()
    expect(b.settlement).toMatchObject({ status: 'pending', amountCents: 2140, processorState: 'na' })
    expect(b.invoice.calc).toMatchObject({ refunded: 0, refundable: 16478 - 2140 })
  })

  it('a card settlement above what was paid by card is refused', async () => {
    const env = p.env()
    const inv = await makeInvoice(p.h.t.db, env, { items: [{ name: 'Executive Detail', priceCents: 26000 }] })
    await addEvent(p.h.t.db, env, inv, {
      type: 'credit_apply',
      amountCents: 27000,
      method: 'Store credit',
      methodKind: 'store_credit',
    })
    await addEvent(p.h.t.db, env, inv, {
      type: 'pay',
      amountCents: 820,
      method: 'Visa ••1',
      methodKind: 'card',
    })
    const res = await adjust('rafael', inv.id, { kind: 'discount', unit: '$', value: 20000, settle: 'card' })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'REFUND_EXCEEDS_CARD' })
    expect(
      await p.h.t.db.selectFrom('ledger_events').select('id').where('type', '=', 'adjust').execute(),
    ).toHaveLength(0)
  })
})

describe('issue credit', () => {
  it('stores the expiry from the clock at issue: end of the business day 30 / 90 days out; none never expires', async () => {
    const inv = await makeInvoice(p.h.t.db, p.env())
    const d30 = p.json<{ event: Ev; invoice: Detail }>(
      await p.send(p.people().rafael, 'POST', `invoices/${inv.id}/credits`, {
        amountCents: 2500,
        reason: 'Goodwill',
        expiry: 'd30',
      }),
    )
    expect(d30.event).toMatchObject({
      type: 'credit_issue',
      amountCents: 2500,
      expiryLabel: '30 days',
      expiresAt: '2026-07-14T04:00:00.000Z',
    })
    const labels = p.json<{ event: Ev }>(
      await p.send(p.people().rafael, 'POST', `invoices/${inv.id}/credits`, {
        amountCents: 1000,
        expiry: '90 days',
      }),
    )
    expect(labels.event.expiresAt).toBe('2026-09-12T04:00:00.000Z')
    const none = p.json<{ event: Ev; invoice: Detail }>(
      await p.send(p.people().rafael, 'POST', `invoices/${inv.id}/credits`, {
        amountCents: 500,
        expiry: 'No expiry',
      }),
    )
    expect(none.event.expiresAt).toBeNull()
    expect(none.invoice.clientCredit).toMatchObject({
      balanceCents: 4000,
      nextExpiry: { at: '2026-07-14T04:00:00.000Z', cents: 2500 },
    })
  })

  it('over the credit limit is blocked with the design text', async () => {
    const inv = await makeInvoice(p.h.t.db, p.env())
    const res = await p.send(p.people().sofia, 'POST', `invoices/${inv.id}/credits`, {
      amountCents: 5001,
      expiry: 'd90',
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({
      code: 'OVER_LIMIT',
      detail: 'Over your $50 limit as Customer Support.',
    })
    expect(
      (
        await p.send(p.people().sofia, 'POST', `invoices/${inv.id}/credits`, {
          amountCents: 5000,
          expiry: 'd90',
        })
      ).statusCode,
    ).toBe(201)
  })
})

describe('void', () => {
  it('voids a cash payment and an unconfirmed card payment, but not a confirmed card one', async () => {
    const { rafael, sofia } = p.people()
    const env = p.env()
    const inv = await makeInvoice(p.h.t.db, env)
    const cash = p.json<{ event: Ev }>(
      await p.send(rafael, 'POST', `invoices/${inv.id}/payments`, { method: 'cash' }),
    )
    const res = await p.send(rafael, 'POST', `invoices/${inv.id}/void`, { eventId: cash.event.id })
    expect(res.statusCode).toBe(201)
    const b = res.json<{ event: Ev; invoice: Detail }>()
    expect(b.event).toMatchObject({ type: 'void', amountCents: 16478, method: 'Cash' })
    expect(b.invoice).toMatchObject({ status: 'unpaid', calc: { paid: 0, balance: 16478 } })
    expect(b.invoice.ledger.find((e) => e.id === cash.event.id)?.voided).toBe(true)

    const again = await p.send(rafael, 'POST', `invoices/${inv.id}/void`, { eventId: cash.event.id })
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ code: 'PAYMENT_ALREADY_VOIDED' })

    const card = p.json<{ event: Ev }>(
      await p.send(sofia, 'POST', `invoices/${inv.id}/payments`, { method: 'card' }),
    )
    expect(
      (await p.send(rafael, 'POST', `invoices/${inv.id}/void`, { eventId: card.event.id })).statusCode,
    ).toBe(201)

    const confirmed = await addEvent(p.h.t.db, env, inv, {
      type: 'pay',
      amountCents: 1000,
      method: 'Visa ••1',
      methodKind: 'card',
      processorState: 'confirmed',
    })
    const refused = await p.send(rafael, 'POST', `invoices/${inv.id}/void`, { eventId: confirmed })
    expect(refused.statusCode).toBe(422)
    expect(refused.json()).toMatchObject({ code: 'VOID_NOT_ALLOWED' })
  })

  it('needs pay.void (Support does not have it) and refuses a payment that was refunded', async () => {
    const { rafael, sofia } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env())
    const cash = p.json<{ event: Ev }>(
      await p.send(rafael, 'POST', `invoices/${inv.id}/payments`, { method: 'cash' }),
    )
    expect(
      (await p.send(sofia, 'POST', `invoices/${inv.id}/void`, { eventId: cash.event.id })).statusCode,
    ).toBe(403)
    await p.send(rafael, 'POST', `invoices/${inv.id}/refunds`, {
      mode: 'custom',
      amountCents: 1000,
      dest: 'cash',
    })
    const res = await p.send(rafael, 'POST', `invoices/${inv.id}/void`, { eventId: cash.event.id })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({ code: 'VOID_NOT_ALLOWED' })
  })
})

describe('client credit endpoint', () => {
  it('404 for an unknown client; zero balance for a client without credit', async () => {
    const { rafael } = p.people()
    const none = await p.get(rafael, 'clients/00000000-0000-7000-8000-000000000000/credit')
    expect(none.statusCode).toBe(404)
    const customerId = await makeCustomer(p.h.t.db, p.env())
    expect((await p.get(rafael, `clients/${customerId}/credit`)).json()).toMatchObject({
      balanceCents: 0,
      entries: [],
      nextExpiry: null,
    })
  })

  it('amounts above the int4 range are rejected up front instead of overflowing the column', async () => {
    const inv = await makeInvoice(p.h.t.db, p.env())
    const res = await p.send(p.people().amara, 'POST', `invoices/${inv.id}/credits`, {
      amountCents: 3_000_000_000,
      expiry: 'none',
    })
    expect(res.statusCode).toBe(422)
  })
})

describe('store credit FIFO with expiry (review B1)', () => {
  /** An invoice whose balance is exactly `balance`. */
  async function owing(customerId: string, balance: number) {
    const inv = await makeInvoice(p.h.t.db, p.env(), { customerId })
    await addEvent(p.h.t.db, p.env(), inv, {
      type: 'pay',
      amountCents: 16478 - balance,
      method: 'Cash',
      methodKind: 'cash',
    })
    return inv
  }
  const DAY = 24 * 3600 * 1000
  /** Sessions idle out after 12 h, so a test that jumps days signs in again. */
  const relogin = async (person: Person): Promise<Person> => ({
    ...person,
    session: await p.h.login(person.user, '10.88.0.9'),
  })

  it('lot A 25.00 (expires day 30) and lot B 20.00 (no expiry): apply 10 on day 10, apply 10 on day 40', async () => {
    const env = p.env()
    const customerId = await makeCustomer(p.h.t.db, env, { name: 'Priya Nair' })
    const src = await makeInvoice(p.h.t.db, env, { customerId })
    const t0 = p.h.clock.now()
    const lotA = await addEvent(p.h.t.db, env, src, {
      type: 'credit_issue',
      amountCents: 2500,
      expiry: 'd30',
      expiresAt: new Date(t0.getTime() + 30 * DAY),
      at: t0,
    })
    const lotB = await addEvent(p.h.t.db, env, src, {
      type: 'credit_issue',
      amountCents: 2000,
      expiry: 'none',
      at: t0,
    })

    p.h.clock.advance(10 * DAY)
    const rafael = await relogin(p.people().rafael)
    const first = await owing(customerId, 1000)
    const r1 = p.json<{ event: Ev; invoice: Detail }>(
      await p.send(rafael, 'POST', `invoices/${first.id}/credit-applications`),
    )
    expect(r1.event.amountCents).toBe(1000)
    expect(r1.invoice.clientCredit.balanceCents).toBe(2500 + 2000 - 1000)

    p.h.clock.advance(30 * DAY)
    const rafael2 = await relogin(p.people().rafael)
    const second = await owing(customerId, 1000)
    const r2 = p.json<{ event: Ev; invoice: Detail }>(
      await p.send(rafael2, 'POST', `invoices/${second.id}/credit-applications`),
    )
    expect(r2.event.amountCents).toBe(1000)
    // lot A expired with 1500 unused; the second apply could only come from lot B, which now holds 1000
    expect(r2.invoice.clientCredit.balanceCents).toBe(1000)

    const alloc = await sql<{
      lot_event_id: string
      cents: number
    }>`select lot_event_id, cents from credit_allocations order by created_at, cents`.execute(p.h.t.db)
    expect(alloc.rows).toEqual([
      { lot_event_id: lotA, cents: 1000 },
      { lot_event_id: lotB, cents: 1000 },
    ])
    const credit = p.json<{
      balanceCents: number
      entries: { state: string; remainingCents: number; lotEventId: string }[]
    }>(await p.get(rafael2, `clients/${customerId}/credit`))
    expect(credit.balanceCents).toBe(1000)
    expect(credit.entries.find((e) => e.lotEventId === lotA)).toMatchObject({
      state: 'expired',
      remainingCents: 0,
    })
    expect(credit.entries.find((e) => e.lotEventId === lotB)).toMatchObject({
      state: 'active',
      remainingCents: 1000,
    })
  })

  it('apply consumes the earliest-expiring lot first, then the no-expiry lot (25 then 5 of 20)', async () => {
    const { rafael } = p.people()
    const env = p.env()
    const customerId = await makeCustomer(p.h.t.db, env)
    const src = await makeInvoice(p.h.t.db, env, { customerId })
    const t0 = p.h.clock.now()
    const lotB = await addEvent(p.h.t.db, env, src, {
      type: 'credit_issue',
      amountCents: 2000,
      expiry: 'none',
      at: t0,
    })
    const lotA = await addEvent(p.h.t.db, env, src, {
      type: 'credit_issue',
      amountCents: 2500,
      expiry: 'd30',
      expiresAt: new Date(t0.getTime() + 30 * DAY),
      at: new Date(t0.getTime() - 1000),
    })
    const inv = await owing(customerId, 3000)
    const r = p.json<{ event: Ev; invoice: Detail }>(
      await p.send(rafael, 'POST', `invoices/${inv.id}/credit-applications`),
    )
    expect(r.event.amountCents).toBe(3000)
    const alloc = await sql<{
      lot_event_id: string
      cents: number
    }>`select lot_event_id, cents from credit_allocations order by cents desc`.execute(p.h.t.db)
    expect(alloc.rows).toEqual([
      { lot_event_id: lotA, cents: 2500 },
      { lot_event_id: lotB, cents: 500 },
    ])
    expect(r.invoice.clientCredit.balanceCents).toBe(1500)
  })

  it('refund-to-credit makes a lot with no expiry once it is done (pending ones are not credit yet)', async () => {
    const { rafael, sofia } = p.people()
    const inv = await paidInvoice([{ name: 'Fleet detail', priceCents: 250000 }])
    await p.send(rafael, 'POST', `invoices/${inv.id}/refunds`, {
      mode: 'custom',
      amountCents: 2000,
      dest: 'credit',
    })
    const pending = p.json<{ event: Ev }>(
      await p.send(sofia, 'POST', `invoices/${inv.id}/refunds`, {
        mode: 'custom',
        amountCents: 8000,
        dest: 'credit',
      }),
    )
    const before = p.json<{ balanceCents: number }>(await p.get(rafael, `clients/${inv.customerId}/credit`))
    expect(before.balanceCents).toBe(2000)
    await p.send(rafael, 'POST', `invoices/${inv.id}/refunds/${pending.event.id}/approve`)
    const after = p.json<{ balanceCents: number; entries: { expiresAt: string | null; kind: string }[] }>(
      await p.get(rafael, `clients/${inv.customerId}/credit`),
    )
    expect(after.balanceCents).toBe(10000)
    expect(after.entries.every((e) => e.kind === 'refund' && e.expiresAt === null)).toBe(true)
  })

  it('two applications racing for the same credit never spend it twice', async () => {
    const { rafael, daniel } = p.people()
    const env = p.env()
    const customerId = await makeCustomer(p.h.t.db, env)
    const src = await makeInvoice(p.h.t.db, env, { customerId })
    await addEvent(p.h.t.db, env, src, { type: 'credit_issue', amountCents: 1500, expiry: 'none' })
    const a = await owing(customerId, 1000)
    const b = await owing(customerId, 1000)
    const [r1, r2] = await Promise.all([
      p.send(rafael, 'POST', `invoices/${a.id}/credit-applications`),
      p.send(daniel, 'POST', `invoices/${b.id}/credit-applications`),
    ])
    expect([r1.statusCode, r2.statusCode]).toEqual([201, 201])
    const amounts = [
      r1.json<{ event: Ev }>().event.amountCents,
      r2.json<{ event: Ev }>().event.amountCents,
    ].sort((x, y) => x - y)
    expect(amounts).toEqual([500, 1000])
    const spent = await sql<{ s: number }>`select sum(cents)::int as s from credit_allocations`.execute(
      p.h.t.db,
    )
    expect(spent.rows[0]!.s).toBe(1500)
  })
})
