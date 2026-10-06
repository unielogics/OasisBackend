// Refunds: modes and destinations, the limit matrix (Rafael mgmt+acct, Sofia support+crew, Super), approval and denial,
// self-approval, re-validation at approval, double-refund of items, and two refunds racing on one invoice.
import { describe, expect, it } from 'vitest'
import { addEvent, makeInvoice, type MadeInvoice } from './helpers.js'
import { freshKey, usePayHarness } from './http.js'

const p = usePayHarness()

interface Ev {
  id: string
  type: string
  status: string
  amountCents: number
  dest: string | null
  method: string | null
  processorState: string
  by: string
  byRole: string
  approvedBy: string | null
  deniedBy: string | null
  itemIds: string[]
  canApprove: boolean
  approveBlock: string | null
  resolvedAt: string | null
  at: string
}
interface Result {
  event: Ev
  invoice: {
    status: string
    statusLabel: string
    refundPending: boolean
    calc: {
      refundable: number
      refunded: number
      paid: number
      pendingAmt: number
      toOrigMax: number
      net: number
    }
    items: { id: string; refunded: boolean }[]
    ledger: Ev[]
  }
}

/** A paid invoice: one line of `priceCents`, paid in full by `method` (default a seeded Visa). */
async function paid(
  priceCents: number,
  o: { method?: string; kind?: 'card' | 'cash' | 'apple_pay' } = {},
): Promise<MadeInvoice & { total: number }> {
  const inv = await makeInvoice(p.h.t.db, p.env(), { items: [{ name: 'Exotic Detail Package', priceCents }] })
  const total = priceCents + Math.floor((priceCents * 700 + 5000) / 10000)
  await addEvent(p.h.t.db, p.env(), inv, {
    type: 'pay',
    amountCents: total,
    method: o.method ?? 'Visa ••5521',
    methodKind: o.kind ?? 'card',
    processorState: 'confirmed',
    at: new Date('2026-06-13T10:00:00-04:00'),
  })
  return { ...inv, total }
}

const refund = (
  who: keyof ReturnType<typeof p.people>,
  id: string,
  body: Record<string, unknown>,
  key?: string,
) => p.send(p.people()[who], 'POST', `invoices/${id}/refunds`, body, key)

describe('refund values and destinations', () => {
  it('full refunds everything refundable to the original payment, labelled with the first payment method', async () => {
    const inv = await paid(26000)
    const res = await refund('rafael', inv.id, { mode: 'full', dest: 'card', reason: 'Service issue' })
    expect(res.statusCode).toBe(201)
    const b = p.json<Result>(res)
    expect(b.event).toMatchObject({
      type: 'refund',
      status: 'done',
      amountCents: 27820,
      dest: 'card',
      method: 'Visa ••5521',
      processorState: 'awaiting_processor',
    })
    expect(b.invoice.calc.refundable).toBe(0)
    expect(b.invoice.status).toBe('refunded')
  })

  it('custom amount to store credit and to cash use their own method labels', async () => {
    const inv = await paid(26000)
    const credit = p.json<Result>(
      await refund('rafael', inv.id, { mode: 'custom', amountCents: 1000, dest: 'credit' }),
    )
    expect(credit.event).toMatchObject({ dest: 'credit', method: 'Store credit', processorState: 'na' })
    const cash = p.json<Result>(
      await refund('rafael', inv.id, { mode: 'custom', amountCents: 500, dest: 'cash' }),
    )
    expect(cash.event).toMatchObject({ dest: 'cash', method: 'Cash', processorState: 'na' })
    expect(cash.invoice.status).toBe('partially_refunded')
    expect(cash.invoice.calc.refunded).toBe(1500)
  })

  it('by item: selected lines with tax at the invoice rate, tracked by id; an item cannot be refunded twice', async () => {
    const inv = await makeInvoice(p.h.t.db, p.env(), {
      items: [
        { name: 'Premium Hand Wash + Interior', priceCents: 12900 },
        { name: 'Rain repellent', priceCents: 2500 },
      ],
    })
    await addEvent(p.h.t.db, p.env(), inv, {
      type: 'pay',
      amountCents: 16478,
      method: 'Visa ••4421',
      methodKind: 'card',
    })
    const res = await refund('rafael', inv.id, { mode: 'items', itemIds: [inv.itemIds[1]], dest: 'card' })
    expect(res.statusCode).toBe(201)
    const b = p.json<Result>(res)
    expect(b.event.amountCents).toBe(2675)
    expect(b.event.itemIds).toEqual([inv.itemIds[1]])
    expect(b.invoice.items.map((i) => i.refunded)).toEqual([false, true])
    const again = await refund('rafael', inv.id, { mode: 'items', itemIds: [inv.itemIds[1]], dest: 'card' })
    expect(again.statusCode).toBe(422)
    expect(again.json()).toMatchObject({ code: 'ITEM_ALREADY_REFUNDED' })
    const other = await refund('rafael', inv.id, { mode: 'items', itemIds: [inv.itemIds[0]], dest: 'credit' })
    expect(other.json<Result>().event.amountCents).toBe(13803)
  })

  it('a pending item refund also reserves its items', async () => {
    const inv = await makeInvoice(p.h.t.db, p.env(), {
      items: [
        { name: 'Fleet detail', priceCents: 250000 },
        { name: 'Wax', priceCents: 4000 },
      ],
    })
    await addEvent(p.h.t.db, p.env(), inv, {
      type: 'pay',
      amountCents: 271780,
      method: 'Cash',
      methodKind: 'cash',
    })
    const pending = await refund('sofia', inv.id, {
      mode: 'items',
      itemIds: [inv.itemIds[0]],
      dest: 'credit',
    })
    expect(pending.json<Result>().event.status).toBe('pending')
    const again = await refund('rafael', inv.id, { mode: 'items', itemIds: [inv.itemIds[0]], dest: 'credit' })
    expect(again.json()).toMatchObject({ code: 'ITEM_ALREADY_REFUNDED' })
  })

  it('INV-20560 shape: a full card refund is refused with the design text; the rest goes to store credit', async () => {
    const env = p.env()
    const inv = await makeInvoice(p.h.t.db, env, { items: [{ name: 'Express Hand Wash', priceCents: 4500 }] })
    await addEvent(p.h.t.db, env, inv, {
      type: 'credit_apply',
      amountCents: 2500,
      method: 'Store credit',
      methodKind: 'store_credit',
    })
    await addEvent(p.h.t.db, env, inv, {
      type: 'pay',
      amountCents: 2315,
      method: 'Visa ••8812',
      methodKind: 'card',
    })
    const res = await refund('rafael', inv.id, { mode: 'full', dest: 'card' })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({
      code: 'REFUND_EXCEEDS_CARD',
      detail: 'Only $23.15 was paid by card — refund the rest to store credit.',
    })
    expect(
      (await refund('rafael', inv.id, { mode: 'custom', amountCents: 2315, dest: 'card' })).statusCode,
    ).toBe(201)
    const rest = await refund('rafael', inv.id, { mode: 'full', dest: 'credit' })
    expect(rest.json<Result>().event.amountCents).toBe(2500)
  })

  it('more than refundable, and nothing left to refund', async () => {
    const inv = await paid(4500, { kind: 'cash', method: 'Cash' })
    const over = await refund('rafael', inv.id, { mode: 'custom', amountCents: 999999, dest: 'cash' })
    expect(over.json()).toMatchObject({
      code: 'REFUND_EXCEEDS_REFUNDABLE',
      detail: 'More than the refundable amount.',
    })
    await refund('rafael', inv.id, { mode: 'full', dest: 'cash' })
    const none = await refund('rafael', inv.id, { mode: 'full', dest: 'cash' })
    expect(none.statusCode).toBe(422)
    expect(none.json()).toMatchObject({ code: 'PAY_AMOUNT_INVALID', detail: 'Nothing left to refund' })
  })

  it('needs pay.refund', async () => {
    const inv = await paid(4500)
    expect((await refund('kevin', inv.id, { mode: 'full', dest: 'card' })).statusCode).toBe(403)
  })
})

describe("limit matrix: pending exactly when the amount is strictly greater than the actor's refund limit", () => {
  it('Rafael (Management 1000 + Accounting 500 = 1000): $1,000.00 is done, $1,000.01 is pending', async () => {
    const a = await paid(250000)
    const atLimit = p.json<Result>(
      await refund('rafael', a.id, { mode: 'custom', amountCents: 100000, dest: 'card' }),
    )
    expect(atLimit.event.status).toBe('done')
    expect(atLimit.event.byRole).toBe('Management + Accounting')
    const over = p.json<Result>(
      await refund('rafael', a.id, { mode: 'custom', amountCents: 100001, dest: 'card' }),
    )
    expect(over.event).toMatchObject({ status: 'pending', processorState: 'na', resolvedAt: null })
    expect(over.invoice).toMatchObject({ refundPending: true, statusLabel: 'Refund pending' })
    expect(over.invoice.calc).toMatchObject({ refunded: 100000, pendingAmt: 100001 })
  })

  it('Sofia (Customer Support 50; Crew grants nothing): $50.00 done, $50.01 pending', async () => {
    const a = await paid(26000)
    expect(
      p.json<Result>(await refund('sofia', a.id, { mode: 'custom', amountCents: 5000, dest: 'card' })).event
        .status,
    ).toBe('done')
    const over = p.json<Result>(
      await refund('sofia', a.id, { mode: 'custom', amountCents: 5001, dest: 'card' }),
    )
    expect(over.event.status).toBe('pending')
    expect(over.event.byRole).toBe('Customer Support')
  })

  it('Super is unlimited', async () => {
    const a = await paid(1_000_000)
    const r = p.json<Result>(await refund('amara', a.id, { mode: 'full', dest: 'card' }))
    expect(r.event.status).toBe('done')
    expect(r.event.amountCents).toBe(1_070_000)
  })

  it('Daniel (Accounting 500) sits between them', async () => {
    const a = await paid(250000)
    expect(
      p.json<Result>(await refund('daniel', a.id, { mode: 'custom', amountCents: 50000, dest: 'cash' })).event
        .status,
    ).toBe('done')
    expect(
      p.json<Result>(await refund('daniel', a.id, { mode: 'custom', amountCents: 50001, dest: 'cash' })).event
        .status,
    ).toBe('pending')
  })

  it('a role with the permission and no limit row gets the 2500-cent default', async () => {
    const a = await paid(26000)
    const { session } = await p.h.userWithPermissions(['pay.refund', 'pay.reports'], 'norow@example.test')
    const ok = await p.h.call('POST', `invoices/${a.id}/refunds`, {
      session,
      body: { mode: 'custom', amountCents: 2500, dest: 'card' },
      headers: { 'idempotency-key': freshKey() },
    })
    expect(ok.json<Result>().event.status).toBe('done')
    const over = await p.h.call('POST', `invoices/${a.id}/refunds`, {
      session,
      body: { mode: 'custom', amountCents: 2501, dest: 'card' },
      headers: { 'idempotency-key': freshKey() },
    })
    expect(over.json<Result>().event.status).toBe('pending')
  })
})

describe('approve and deny', () => {
  it("Rafael approves Sofia's request: done, approver recorded, original time kept, card refund awaits Squarespace", async () => {
    const a = await paid(26000)
    const req = p.json<Result>(
      await refund('sofia', a.id, {
        mode: 'custom',
        amountCents: 8000,
        dest: 'card',
        reason: 'Service issue',
        note: 'Interior stain not fully removed',
      }),
    )
    expect(req.event.status).toBe('pending')
    p.h.clock.advance(3 * 3600 * 1000)
    const res = await p.send(p.people().rafael, 'POST', `invoices/${a.id}/refunds/${req.event.id}/approve`)
    expect(res.statusCode).toBe(200)
    const b = p.json<Result>(res)
    expect(b.event).toMatchObject({
      status: 'done',
      approvedBy: 'Rafael M. · Management + Accounting',
      processorState: 'awaiting_processor',
      by: 'Sofia D.',
    })
    expect(b.event.at).toBe(req.event.at)
    expect(b.event.resolvedAt).not.toBe(b.event.at)
    expect(b.invoice.calc).toMatchObject({ refunded: 8000, pendingAmt: 0 })
    const again = await p.send(p.people().rafael, 'POST', `invoices/${a.id}/refunds/${req.event.id}/approve`)
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ code: 'REFUND_NOT_PENDING' })
  })

  it('the approver needs a limit of at least the amount (the design toast), and pay.refund', async () => {
    const a = await paid(250000)
    const req = p.json<Result>(
      await refund('sofia', a.id, { mode: 'custom', amountCents: 8000, dest: 'card' }),
    )
    const big = p.json<Result>(
      await refund('rafael', a.id, { mode: 'custom', amountCents: 150000, dest: 'card' }),
    )
    const tooBig = await p.send(p.people().daniel, 'POST', `invoices/${a.id}/refunds/${big.event.id}/approve`)
    expect(tooBig.statusCode).toBe(403)
    expect(tooBig.json()).toMatchObject({ code: 'CANT_APPROVE', title: 'Your role can’t approve $1,500.00' })
    expect(
      (await p.send(p.people().kevin, 'POST', `invoices/${a.id}/refunds/${req.event.id}/approve`)).statusCode,
    ).toBe(403)
    expect(
      (await p.send(p.people().amara, 'POST', `invoices/${a.id}/refunds/${big.event.id}/approve`)).statusCode,
    ).toBe(200)
  })

  it('canApprove / approveBlock on the detail are evaluated for the caller', async () => {
    const a = await paid(250000)
    const big = p.json<Result>(
      await refund('rafael', a.id, { mode: 'custom', amountCents: 150000, dest: 'card' }),
    )
    const asDaniel = p.json<Result['invoice']>(await p.get(p.people().daniel, `invoices/${a.id}`))
    expect(asDaniel.ledger.find((e) => e.id === big.event.id)).toMatchObject({
      canApprove: false,
      approveBlock: 'limit',
    })
    const asAmara = p.json<Result['invoice']>(await p.get(p.people().amara, `invoices/${a.id}`))
    expect(asAmara.ledger.find((e) => e.id === big.event.id)).toMatchObject({
      canApprove: true,
      approveBlock: null,
    })
  })

  it('a requester cannot approve their own request unless they are unlimited or approvals.allow_self is on', async () => {
    const env = p.env()
    const { rafael, amara } = p.people()
    const a = await paid(250000)
    const own = await addEvent(p.h.t.db, env, a, {
      type: 'refund',
      amountCents: 20000,
      status: 'pending',
      dest: 'card',
      method: 'Visa ••5521',
      actorUserId: rafael.user.userId,
    })
    const blocked = await p.send(rafael, 'POST', `invoices/${a.id}/refunds/${own}/approve`)
    expect(blocked.statusCode).toBe(403)
    expect(blocked.json()).toMatchObject({ code: 'SELF_APPROVAL' })
    const detail = p.json<Result['invoice']>(await p.get(rafael, `invoices/${a.id}`))
    expect(detail.ledger.find((e) => e.id === own)).toMatchObject({ canApprove: false, approveBlock: 'self' })

    const ownSuper = await addEvent(p.h.t.db, env, a, {
      type: 'refund',
      amountCents: 20000,
      status: 'pending',
      dest: 'card',
      method: 'Visa ••5521',
      actorUserId: amara.user.userId,
    })
    expect((await p.send(amara, 'POST', `invoices/${a.id}/refunds/${ownSuper}/approve`)).statusCode).toBe(200)

    await p.h.t.db
      .updateTable('settings')
      .set({ value: 'true' })
      .where('location_id', '=', env.locationId)
      .where('key', '=', 'approvals.allow_self')
      .execute()
    expect((await p.send(rafael, 'POST', `invoices/${a.id}/refunds/${own}/approve`)).statusCode).toBe(200)
  })

  it("re-validates at approval without the request's own reservation (card cap)", async () => {
    const env = p.env()
    const { rafael, sofia } = p.people()
    const inv = await makeInvoice(p.h.t.db, env, { items: [{ name: 'Executive Detail', priceCents: 26000 }] })
    await addEvent(p.h.t.db, env, inv, {
      type: 'pay',
      amountCents: 10000,
      method: 'Visa ••5521',
      methodKind: 'card',
    })
    await addEvent(p.h.t.db, env, inv, {
      type: 'credit_apply',
      amountCents: 17820,
      method: 'Store credit',
      methodKind: 'store_credit',
    })
    const req = p.json<Result>(
      await p.send(sofia, 'POST', `invoices/${inv.id}/refunds`, {
        mode: 'custom',
        amountCents: 8000,
        dest: 'card',
      }),
    )
    expect(req.event.status).toBe('pending')
    expect(
      (
        await p.send(rafael, 'POST', `invoices/${inv.id}/refunds`, {
          mode: 'custom',
          amountCents: 5000,
          dest: 'cash',
        })
      ).statusCode,
    ).toBe(201)
    const res = await p.send(rafael, 'POST', `invoices/${inv.id}/refunds/${req.event.id}/approve`)
    expect(res.statusCode).toBe(422)
    expect(res.json()).toMatchObject({
      code: 'REFUND_EXCEEDS_CARD',
      detail: 'Only $50.00 was paid by card — refund the rest to store credit.',
    })
  })

  it('deny needs pay.refund; the requester can withdraw; a denied request returns its amount to refundable', async () => {
    const a = await paid(26000)
    const req = p.json<Result>(
      await refund('sofia', a.id, { mode: 'custom', amountCents: 8000, dest: 'card' }),
    )
    expect(req.invoice.calc.refundable).toBe(27820 - 8000)
    expect(
      (await p.send(p.people().kevin, 'POST', `invoices/${a.id}/refunds/${req.event.id}/deny`)).statusCode,
    ).toBe(403)
    const res = await p.send(p.people().sofia, 'POST', `invoices/${a.id}/refunds/${req.event.id}/deny`, {
      note: 'Wrong invoice',
    })
    expect(res.statusCode).toBe(200)
    const b = p.json<Result>(res)
    expect(b.event).toMatchObject({ status: 'denied', deniedBy: 'Sofia D. · Customer Support' })
    expect(b.invoice.calc).toMatchObject({ refundable: 27820, refunded: 0, pendingAmt: 0 })
    expect(
      (await p.send(p.people().rafael, 'POST', `invoices/${a.id}/refunds/${req.event.id}/deny`)).statusCode,
    ).toBe(409)
  })

  it("approvals queue lists pending refunds oldest first with the caller's rights", async () => {
    const a = await paid(26000)
    const b = await paid(26000)
    await refund('sofia', a.id, { mode: 'custom', amountCents: 8000, dest: 'card' })
    p.h.clock.advance(60_000)
    await refund('sofia', b.id, { mode: 'custom', amountCents: 9000, dest: 'card' })
    const res = await p.get(p.people().rafael, 'payments/approvals')
    const items = res.json<{
      items: { amountCents: number; canApprove: boolean; requestedBy: string; invoiceId: string }[]
    }>().items
    expect(items.map((i) => i.amountCents)).toEqual([8000, 9000])
    expect(items.every((i) => i.canApprove && i.requestedBy === 'Sofia D.')).toBe(true)
    const asKevin = await p.get(p.people().kevin, 'payments/approvals')
    expect(asKevin.statusCode).toBe(403)
  })
})

describe('concurrency and view-as', () => {
  it('two refunds racing on one invoice serialise on the invoice row: one wins, one is refused', async () => {
    const a = await paid(26000)
    const [r1, r2] = await Promise.all([
      refund('amara', a.id, { mode: 'custom', amountCents: 20000, dest: 'credit' }),
      refund('rafael', a.id, { mode: 'custom', amountCents: 20000, dest: 'credit' }),
    ])
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([201, 422])
    const loser = r1.statusCode === 422 ? r1 : r2
    expect(loser.json()).toMatchObject({ code: 'REFUND_EXCEEDS_REFUNDABLE' })
    const rows = await p.h.t.db
      .selectFrom('ledger_events')
      .select('amount_cents')
      .where('type', '=', 'refund')
      .execute()
    expect(rows).toEqual([{ amount_cents: 20000 }])
  })

  it('two requests with the same key racing produce a single refund', async () => {
    const a = await paid(26000)
    const key = freshKey()
    const results = await Promise.all([
      refund('rafael', a.id, { mode: 'custom', amountCents: 1000, dest: 'card' }, key),
      refund('rafael', a.id, { mode: 'custom', amountCents: 1000, dest: 'card' }, key),
    ])
    expect(results.map((r) => r.statusCode).every((c) => c === 201 || c === 409)).toBe(true)
    expect(
      await p.h.t.db.selectFrom('ledger_events').select('id').where('type', '=', 'refund').execute(),
    ).toHaveLength(1)
  })

  it('under view-as the real person is recorded and the viewed role decides limit and role names', async () => {
    const { amara } = p.people()
    const a = await paid(26000)
    const support = await p.h.t.db
      .selectFrom('roles')
      .select('id')
      .where('key', '=', 'support')
      .executeTakeFirstOrThrow()
    const set = await p.h.call('POST', 'me/view-as', { session: amara.session, body: { roleId: support.id } })
    expect(set.statusCode).toBe(200)
    const res = await refund('amara', a.id, { mode: 'custom', amountCents: 8000, dest: 'card' })
    const b = p.json<Result>(res)
    expect(b.event).toMatchObject({ status: 'pending', by: 'Amara O.', byRole: 'Customer Support' })
    const row = await p.h.t.db
      .selectFrom('ledger_events')
      .select(['actor_user_id', 'view_as_role_id'])
      .where('id', '=', b.event.id)
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ actor_user_id: amara.user.userId, view_as_role_id: support.id })
    const mgmt = await p.h.t.db
      .selectFrom('roles')
      .select('id')
      .where('key', '=', 'mgmt')
      .executeTakeFirstOrThrow()
    await p.h.call('POST', 'me/view-as', { session: amara.session, body: { roleId: mgmt.id } })
    const own = await p.send(amara, 'POST', `invoices/${a.id}/refunds/${b.event.id}/approve`)
    expect(own.statusCode).toBe(403)
    expect(own.json()).toMatchObject({ code: 'SELF_APPROVAL' })
  })
})
