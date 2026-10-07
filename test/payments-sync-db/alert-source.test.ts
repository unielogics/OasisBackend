// ExternalAlertSource (alert 12 of the Operations screen), the reconciliation lists and the card hint, over the real ledger.
import { describe, expect, it } from 'vitest'
import { sqspCardHints, sqspExternalAlerts, sqspUnmatched } from '../../src/modules/payments-sync/db/queries.js'
import { createTestApp } from '../helpers/app.js'
import { addEvent, makeCustomer, makeInvoice, setupEnv } from '../payments/helpers.js'
import { H, useRig } from './harness.js'

describe('alerts, reconciliation lists and card hints from the Squarespace tables', () => {
  const rig = useRig({ pageSize: 50 })

  async function world() {
    const r = rig()
    const env = await setupEnv({ db: r.db, clock: r.clock })
    return { r, env }
  }

  it('card money still awaiting Squarespace after 2 hours becomes an alert that clears when confirmed or voided', async () => {
    const { r, env } = await world()
    const cust = await makeCustomer(r.db, env, { name: 'Liam Chen' })
    const inv = await makeInvoice(r.db, env, { customerId: cust, items: [{ name: 'Full Detail', priceCents: 18900 }] })
    const fresh = await addEvent(r.db, env, inv, { type: 'pay', amountCents: 5000, methodKind: 'card', processorState: 'awaiting_processor', at: new Date(r.clock.now().getTime() - H) })
    const stale = await addEvent(r.db, env, inv, { type: 'pay', amountCents: 20223, methodKind: 'card', processorState: 'awaiting_processor', at: new Date(r.clock.now().getTime() - 3 * H) })
    const ctx = { locationId: r.locationId, now: r.clock.now(), manager: false }
    const list = await sqspExternalAlerts.list(r.db, ctx)
    expect(list.map((a) => a.key)).toEqual([`awaiting_processor:${stale}`])
    expect(list[0]).toMatchObject({
      kind: 'awaiting_processor',
      tone: 'amber',
      title: 'Card payment not confirmed · Liam Chen',
      actionLabel: 'Confirm',
    })
    expect(list[0]?.desc).toBe(`$202.23 on INV-${inv.no} recorded 3 h ago · finish it in Squarespace`)
    // it ages in: after another hour the first one joins
    r.advance(H + 1000)
    expect((await sqspExternalAlerts.list(r.db, { ...ctx, now: r.clock.now() })).map((a) => a.key).sort()).toEqual([`awaiting_processor:${fresh}`, `awaiting_processor:${stale}`].sort())
    // confirmed by hand: gone
    await r.db.updateTable('ledger_events').set({ processor_state: 'confirmed' }).where('id', '=', stale).execute()
    // voided: gone
    await addEvent(r.db, env, inv, { type: 'void', amountCents: 5000, voidsEventId: fresh, methodKind: 'card' })
    expect(await sqspExternalAlerts.list(r.db, { ...ctx, now: r.clock.now() })).toEqual([])
  })

  it('orders waiting in the manual queue are an alert for managers only, with a real count', async () => {
    const { r } = await world()
    const q = (orderId: string, state: 'open' | 'resolved' = 'open', txn: string | null = null) =>
      r.db
        .insertInto('sqsp_manual_queue')
        .values({ id: r.newId(), location_id: r.locationId, idempotency_key: `k-${orderId}-${txn}`, sqsp_order_id: orderId, sqsp_txn_id: txn, reason: 'no_candidate', arrival: '{}', state })
        .execute()
    await q('o-1')
    await q('o-1', 'open', 't-2') // two open items on one order count once
    await q('o-2')
    await q('o-3', 'resolved')
    const ctx = { locationId: r.locationId, now: r.clock.now() }
    expect(await sqspExternalAlerts.list(r.db, { ...ctx, manager: false })).toEqual([])
    const m = await sqspExternalAlerts.list(r.db, { ...ctx, manager: true })
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({ key: 'unmatched_orders', kind: 'unmatched_order', title: '2 Squarespace orders need matching', appointmentId: null })
    await r.db.updateTable('sqsp_manual_queue').set({ state: 'resolved' }).where('sqsp_order_id', '=', 'o-2').execute()
    await r.db.updateTable('sqsp_manual_queue').set({ state: 'resolved' }).where('sqsp_order_id', '=', 'o-1').execute()
    expect(await sqspExternalAlerts.list(r.db, { ...ctx, manager: true })).toEqual([])
  })

  it('the Payments reconciliation lists the queue and the transactions waiting on a person', async () => {
    const { r } = await world()
    await r.db
      .insertInto('sqsp_orders')
      .values({
        id: r.newId(),
        location_id: r.locationId,
        sqsp_order_id: 'o-9',
        order_number: '1009',
        created_on: new Date('2026-10-05T10:00:00Z'),
        modified_on: new Date('2026-10-05T10:00:00Z'),
        customer_email: 'x@example.com',
        grand_total_cents: 4815,
        currency: 'USD',
        order_json: '{}',
        payload_hash: 'h',
        first_seen_at: r.clock.now(),
        synced_at: r.clock.now(),
        match_state: 'manual',
      })
      .execute()
    await r.db.insertInto('sqsp_manual_queue').values({ id: r.newId(), location_id: r.locationId, idempotency_key: 'k9', sqsp_order_id: 'o-9', reason: 'no_candidate', arrival: '{}' }).execute()
    for (const [id, state] of [['t-1', 'manual'], ['t-2', 'deferred'], ['t-3', 'matched'], ['t-4', 'new']] as const)
      await r.db
        .insertInto('sqsp_transactions')
        .values({
          id: r.newId(),
          location_id: r.locationId,
          sqsp_txn_id: id,
          sqsp_order_id: 'o-9',
          kind: 'payment',
          created_on: new Date('2026-10-05T10:01:00Z'),
          amount_cents: 4815,
          currency: 'USD',
          effective_modified_on: new Date('2026-10-05T10:01:00Z'),
          txn_json: '{}',
          payload_hash: 'h',
          state,
          first_seen_at: r.clock.now(),
          synced_at: r.clock.now(),
        })
        .execute()
    const orders = await sqspUnmatched.unmatchedOrders(r.db)
    expect(orders).toEqual([{ sqspOrderId: 'o-9', orderNumber: '1009', customerEmail: 'x@example.com', totalCents: 4815, createdAt: new Date('2026-10-05T10:00:00Z') }])
    expect((await sqspUnmatched.unmatchedTransactions(r.db)).map((t) => t.sqspTransactionId)).toEqual(['t-1', 't-2'])
    const app = await createTestApp({ testDb: r.t, modules: (await import('../../src/http/modules.js')).apiModules, env: { SQSP_PROVIDER: 'sim' } })
    const rec = await app.app.inject({ method: 'GET', url: '/api/v1/payments/reconciliation' })
    expect(rec.statusCode, rec.body).toBe(200)
    const j = rec.json() as { unmatchedOrders: { sqspOrderId: string }[]; unmatchedTransactions: { sqspTransactionId: string }[] }
    expect(j.unmatchedOrders.map((o) => o.sqspOrderId)).toEqual(['o-9'])
    expect(j.unmatchedTransactions.map((t) => t.sqspTransactionId)).toEqual(['t-1', 't-2'])
    await app.close()
  })

  it('the card hint is the brand of the customer’s latest Squarespace card payment (by email or linked id), never last4', async () => {
    const { r, env } = await world()
    const liam = await makeCustomer(r.db, env, { name: 'Liam Chen', email: 'liam@example.com' })
    const sam = await makeCustomer(r.db, env, { name: 'Sam', email: 'sam@example.com' })
    expect(await sqspCardHints.hintFor(r.db, liam)).toBeNull()
    const add = async (orderId: string, email: string, brand: string | null, at: string, sqspCustomerId?: string) => {
      await r.db
        .insertInto('sqsp_orders')
        .values({
          id: r.newId(), location_id: r.locationId, sqsp_order_id: orderId, order_number: orderId,
          created_on: new Date(at), modified_on: new Date(at), customer_email: email, sqsp_customer_id: sqspCustomerId ?? null,
          grand_total_cents: 100, currency: 'USD', order_json: '{}', payload_hash: orderId, first_seen_at: r.clock.now(), synced_at: r.clock.now(),
        })
        .execute()
      await r.db
        .insertInto('sqsp_transactions')
        .values({
          id: r.newId(), location_id: r.locationId, sqsp_txn_id: `t-${orderId}`, sqsp_order_id: orderId, kind: 'payment', created_on: new Date(at),
          amount_cents: 100, currency: 'USD', brand, effective_modified_on: new Date(at), txn_json: '{}', payload_hash: orderId,
          first_seen_at: r.clock.now(), synced_at: r.clock.now(),
        })
        .execute()
    }
    await add('o-1', 'liam@example.com', 'MASTERCARD', '2026-09-01T10:00:00Z')
    await add('o-2', 'liam@example.com', 'VISA', '2026-09-20T10:00:00Z')
    await add('o-3', 'liam@example.com', 'OTHER', '2026-09-25T10:00:00Z')
    expect(await sqspCardHints.hintFor(r.db, liam)).toEqual({ brand: 'VISA' })
    expect(await sqspCardHints.hintFor(r.db, sam)).toBeNull()
    await add('o-4', 'billing@example.org', 'AMEX', '2026-09-30T10:00:00Z', 'sq-77')
    await r.db.insertInto('sqsp_customer_links').values({ location_id: r.locationId, sqsp_customer_id: 'sq-77', customer_id: sam, source: 'manual' }).execute()
    expect(await sqspCardHints.hintFor(r.db, sam)).toEqual({ brand: 'AMEX' })
  })
})
