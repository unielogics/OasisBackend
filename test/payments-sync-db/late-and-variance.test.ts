// Two behaviours the counter produces every day: the customer pays on the terminal BEFORE the staff member records the card payment
// in Oasis (the order is queued, then resolves by itself), and Squarespace's tax makes its total differ from the Oasis invoice.
import { describe, expect, it } from 'vitest'
import { ensurePlans } from '../../src/modules/memberships/plans.js'
import { replaceProductRows } from '../../src/modules/payments-sync/db/product-map.js'
import { listOrders } from '../../src/modules/payments-sync/db/manual.js'
import { transaction } from '../../src/platform/db.js'
import { addEvent, makeCustomer, makeInvoice, setupEnv } from '../payments/helpers.js'
import { H, useRig } from './harness.js'

describe('late staff records and totals that differ', () => {
  const rig = useRig({ pageSize: 50 })
  const line = { productId: 'p', sku: 'DET-SEDAN', name: 'Full Detail', unitCents: 18900 }

  async function setup() {
    const r = rig()
    const env = await setupEnv({ db: r.db, clock: r.clock })
    await ensurePlans(r.db, { locationId: r.locationId, clock: r.clock, newId: r.newId })
    await transaction(r.db, (tx) =>
      replaceProductRows(tx, { locationId: r.locationId, clock: r.clock, newId: r.newId }, [
        { sku: 'DET-SEDAN', kind: 'service' },
      ]),
    )
    const customerId = await makeCustomer(r.db, env, {
      name: 'Liam Chen',
      email: 'liam@example.com',
      phone: '+13055550142',
    })
    const inv = await makeInvoice(r.db, env, {
      customerId,
      items: [{ name: 'Full Detail', priceCents: 18900 }],
    })
    return { r, env, customerId, inv }
  }
  const cycle = async (r: ReturnType<typeof rig>) => {
    r.advance(120_000)
    return r.rt.syncCycle(r.locationId)
  }

  it('an order that arrives before the staff record is queued, then confirms the staff payment by itself on the next cycle', async () => {
    const { r, env, inv } = await setup()
    const order = r.store.createOrder({
      email: 'liam@example.com',
      name: 'Liam Chen',
      phone: '3055550142',
      lineItems: [line],
      taxCents: 1323,
    })
    const first = await cycle(r)
    expect(first.match?.manual).toBe(1)
    expect(
      await r.db.selectFrom('sqsp_manual_queue').select(['state', 'reason']).executeTakeFirstOrThrow(),
    ).toEqual({ state: 'open', reason: 'no_candidate' })
    // nothing new: the next cycle leaves the queue alone (no churn)
    const queueRow = await r.db
      .selectFrom('sqsp_manual_queue')
      .select(['id', 'created_at'])
      .executeTakeFirstOrThrow()
    const quiet = await cycle(r)
    expect(quiet.match?.manual).toBe(0)
    expect((await r.db.selectFrom('sqsp_manual_queue').select('id').executeTakeFirstOrThrow()).id).toBe(
      queueRow.id,
    )
    // the staff member now records the card payment
    r.advance(5 * 60_000)
    await addEvent(r.db, env, inv, {
      type: 'pay',
      amountCents: 20223,
      method: 'Card',
      methodKind: 'card',
      processorState: 'awaiting_processor',
      at: r.clock.now(),
    })
    const after = await cycle(r)
    expect(after.match?.confirmedAwaiting).toBe(1)
    const ev = await r.db
      .selectFrom('ledger_events')
      .select(['processor_state', 'sqsp_order_id'])
      .where('invoice_id', '=', inv.id)
      .execute()
    expect(ev).toHaveLength(1)
    expect(ev[0]).toEqual({ processor_state: 'confirmed', sqsp_order_id: order.orderId })
    expect(
      await r.db.selectFrom('sqsp_manual_queue').select('id').where('state', '=', 'open').execute(),
    ).toHaveLength(0)
    expect(
      (await r.db.selectFrom('sqsp_orders').select('match_state').executeTakeFirstOrThrow()).match_state,
    ).toBe('auto')
    // and it stays quiet afterwards
    const later = await cycle(r)
    expect(later.match?.ordersProcessed).toBe(0)
  })

  it('a payment link created after the order arrived also resolves it', async () => {
    const { r, inv } = await setup()
    r.store.createOrder({
      email: 'liam@example.com',
      name: 'Liam Chen',
      phone: '3055550142',
      lineItems: [line],
      taxCents: 1323,
    })
    await cycle(r)
    r.advance(60_000)
    // the link was attached and texted a minute AFTER the customer already paid (sent_at is a minute before the order)
    await r.db
      .insertInto('payment_links')
      .values({
        id: r.newId(),
        location_id: r.locationId,
        invoice_id: inv.id,
        url: 'https://oasis.squarespace.com/pay/x',
        expected_cents: 20223,
        sent_at: new Date(r.clock.now().getTime() - 5 * 60_000),
      })
      .execute()
    const after = await cycle(r)
    expect(after.match?.paymentsRecorded).toBe(1)
    expect(
      await r.db
        .selectFrom('invoice_calc')
        .select(['balance', 'status'])
        .where('invoice_id', '=', inv.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ balance: 0, status: 'paid' })
  })

  it('stores the Squarespace-versus-Oasis variance of every match and alerts only past the configured delta', async () => {
    const { r, env, customerId } = await setup()
    // within tolerance: Squarespace computed 50 cents more tax
    const small = await makeInvoice(r.db, env, {
      customerId,
      items: [{ name: 'Full Detail', priceCents: 18900 }],
    })
    await addEvent(r.db, env, small, {
      type: 'pay',
      amountCents: 20273,
      methodKind: 'card',
      method: 'Card',
      processorState: 'awaiting_processor',
      at: new Date(r.clock.now().getTime() - 20 * 60_000),
    })
    r.store.createOrder({
      email: 'liam@example.com',
      name: 'Liam Chen',
      phone: '3055550142',
      lineItems: [line],
      taxCents: 1373,
    })
    await cycle(r)
    const m = await r.db
      .selectFrom('sqsp_matches')
      .select(['kind', 'variance'])
      .where('kind', '=', 'confirm_awaiting')
      .executeTakeFirstOrThrow()
    expect(m.variance).toMatchObject({
      sqspTotalCents: 20273,
      oasisTotalCents: 20223,
      deltaCents: 50,
      sqspTaxCents: 1373,
      oasisTaxCents: 1323,
      taxDeltaCents: 50,
      exceedsAlert: false,
    })
    expect(
      await r.db
        .selectFrom('sqsp_alerts')
        .select('id')
        .where('code', '=', 'variance_exceeds_delta')
        .execute(),
    ).toHaveLength(0)
    // past the 100 cent delta: Squarespace charged 177 cents more
    const big = await makeInvoice(r.db, env, {
      customerId,
      items: [{ name: 'Full Detail', priceCents: 18900 }],
    })
    r.advance(H)
    await addEvent(r.db, env, big, {
      type: 'pay',
      amountCents: 20400,
      methodKind: 'card',
      method: 'Card',
      processorState: 'awaiting_processor',
      at: new Date(r.clock.now().getTime() - 20 * 60_000),
    })
    const o2 = r.store.createOrder({
      email: 'liam@example.com',
      name: 'Liam Chen',
      phone: '3055550142',
      lineItems: [line],
      taxCents: 1500,
    })
    await cycle(r)
    const matches = await r.db
      .selectFrom('sqsp_matches')
      .select(['sqsp_order_id', 'variance'])
      .where('kind', '=', 'confirm_awaiting')
      .execute()
    const v = matches.find((x) => x.sqsp_order_id === o2.orderId)!.variance as {
      deltaCents: number
      exceedsAlert: boolean
    }
    expect(v).toMatchObject({ deltaCents: 177, exceedsAlert: true })
    const alerts = await r.db
      .selectFrom('sqsp_alerts')
      .select(['code', 'sqsp_order_id', 'invoice_id', 'message', 'variance'])
      .where('resolved_at', 'is', null)
      .execute()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toMatchObject({
      code: 'variance_exceeds_delta',
      sqsp_order_id: o2.orderId,
      invoice_id: big.id,
    })
    expect(alerts[0]?.message).toMatch(/differs from the Oasis invoice by 177 cents/)
    // the amount actually paid is what the ledger holds; the invoice total is not rewritten
    const calc = await r.db
      .selectFrom('invoice_calc')
      .select(['total', 'paid'])
      .where('invoice_id', '=', big.id)
      .executeTakeFirstOrThrow()
    expect(calc).toEqual({ total: 20223, paid: 20400 })
    // the orders list exposes what was applied, with the variance
    const page = await listOrders(r.db, r.locationId, { state: 'all', limit: 10 })
    const item = page.items.find((i) => i.sqspOrderId === o2.orderId)!
    expect(item.matches).toHaveLength(1)
    expect(item.matches[0]).toMatchObject({
      kind: 'confirm_awaiting',
      rule: 'awaiting',
      manual: false,
      invoiceId: big.id,
    })
    expect((item.matches[0]!.variance as { deltaCents: number }).deltaCents).toBe(177)
  })
})
