import { describe, expect, it } from 'vitest'
import { PgLedger } from '../../src/modules/payments-sync/db/ledger.js'
import { addEvent, makeCustomer, makeInvoice, setupEnv } from '../payments/helpers.js'
import { D, H, useRig } from './harness.js'

const T = new Date('2026-10-06T14:00:00.000Z')

describe('PgLedger over the real payments ledger', () => {
  const rig = useRig()

  async function world() {
    const r = rig()
    const env = await setupEnv({ db: r.db, clock: r.clock })
    const ledger = new PgLedger(r.db, { locationId: r.locationId, clock: r.clock, newId: r.newId })
    const customerId = await makeCustomer(r.db, env, {
      name: 'Liam Chen',
      email: 'liam.chen@example.com',
      phone: '+13055550142',
    })
    // 189.00 + 7% = 202.23
    const inv = await makeInvoice(r.db, env, {
      customerId,
      items: [{ name: 'Full Detail', priceCents: 18900 }],
      occurredAt: new Date(T.getTime() - 3 * H),
    })
    return { r, env, ledger, customerId, inv }
  }

  const query = (orderId = 'o-1', transactionIds: string[] = [], around = [T]) => ({
    orderId,
    transactionIds,
    around,
    awaitingWindowMs: 48 * H,
    linkWindowMs: 14 * D,
  })

  it('loadContext: awaiting events with the customer identity, voided ones excluded, invoice summary with totals', async () => {
    const { r, env, ledger, customerId, inv } = await world()
    const staff = await addEvent(r.db, env, inv, {
      type: 'pay',
      amountCents: 20223,
      method: 'Card',
      methodKind: 'card',
      processorState: 'awaiting_processor',
      at: new Date(T.getTime() - 2 * H),
    })
    const voided = await addEvent(r.db, env, inv, {
      type: 'pay',
      amountCents: 1000,
      method: 'Card',
      methodKind: 'card',
      processorState: 'awaiting_processor',
      at: new Date(T.getTime() - H),
    })
    await addEvent(r.db, env, inv, { type: 'void', amountCents: 1000, voidsEventId: voided, methodKind: 'card' })
    const cash = await addEvent(r.db, env, inv, { type: 'pay', amountCents: 500, methodKind: 'cash', method: 'Cash', at: new Date(T.getTime() - 30 * D) })
    const ctx = await ledger.loadContext(query())
    expect(ctx.events.map((e) => e.id)).toEqual([staff])
    const e = ctx.events[0]!
    expect(e.processorState).toBe('awaiting_processor')
    expect(e.customer.customerId).toBe(customerId)
    expect(e.customer.emails).toEqual(['liam.chen@example.com'])
    expect(e.customer.phones).toEqual(['+13055550142'])
    expect(e.invoice?.totalCents).toBe(20223)
    expect(e.invoice?.taxCents).toBe(1323)
    expect(e.invoice?.canceled).toBe(false)
    // the invoice's live pay events (for the double-count guard) exclude the voided one: the old cash payment still counts
    expect(e.invoice?.payEvents?.map((p) => p.id)).toEqual([cash, staff])
    expect(ctx.orderInvoiceId).toBeUndefined()
  })

  it('loadContext: finds events by order and by processor reference, links in the window and an explicitly attached one', async () => {
    const { r, env, ledger, inv } = await world()
    const byOrder = await addEvent(r.db, env, inv, { type: 'pay', amountCents: 100, methodKind: 'card', method: 'Visa', at: new Date(T.getTime() - 90 * D) })
    await r.db.updateTable('ledger_events').set({ sqsp_order_id: 'o-1' }).where('id', '=', byOrder).execute()
    const byRef = await addEvent(r.db, env, inv, { type: 'pay', amountCents: 200, methodKind: 'card', method: 'Visa', at: new Date(T.getTime() - 91 * D) })
    await r.db.updateTable('ledger_events').set({ processor_ref: 'txn-7' }).where('id', '=', byRef).execute()
    await r.db
      .insertInto('payment_links')
      .values([
        { id: r.newId(), location_id: r.locationId, invoice_id: inv.id, url: 'https://x.squarespace.com/a', expected_cents: 20223, sent_at: new Date(T.getTime() - 5 * H) },
        { id: r.newId(), location_id: r.locationId, invoice_id: inv.id, url: 'https://x.squarespace.com/old', expected_cents: 20223, sent_at: new Date(T.getTime() - 40 * D) },
        { id: r.newId(), location_id: r.locationId, invoice_id: inv.id, url: 'https://x.squarespace.com/m', expected_cents: 999, sent_at: new Date(T.getTime() - 60 * D), matched_sqsp_order_id: 'o-1' },
      ])
      .execute()
    const ctx = await ledger.loadContext(query('o-1', ['txn-7']))
    expect(ctx.events.map((e) => e.id).sort()).toEqual([byOrder, byRef].sort())
    expect(ctx.orderInvoiceId).toBe(inv.id)
    expect(ctx.links).toHaveLength(2)
    expect(ctx.links.some((l) => l.matchedSqspOrderId === 'o-1')).toBe(true)
    expect(ctx.links.every((l) => l.customer.emails.length === 1)).toBe(true)
  })

  it('a card refund still pending approval is shown to the matcher as waiting on the processor', async () => {
    const { r, env, ledger, inv } = await world()
    await addEvent(r.db, env, inv, { type: 'pay', amountCents: 20223, methodKind: 'card', method: 'Visa', at: new Date(T.getTime() - 2 * H) })
    const pending = await addEvent(r.db, env, inv, { type: 'refund', amountCents: 5000, dest: 'card', status: 'pending', at: new Date(T.getTime() - H) })
    const ctx = await ledger.loadContext(query())
    const ref = ctx.events.find((e) => e.id === pending)!
    expect(ref.type).toBe('refund')
    expect(ref.status).toBe('pending')
    expect(ref.processorState).toBe('awaiting_processor')
  })

  it('confirmAwaitingEvent moves only the processor fields, once, and announces it', async () => {
    const { r, env, ledger, inv } = await world()
    const id = await addEvent(r.db, env, inv, { type: 'pay', amountCents: 20223, methodKind: 'card', method: 'Card', processorState: 'awaiting_processor' })
    const before = await r.db.selectFrom('invoices').select('version').where('id', '=', inv.id).executeTakeFirstOrThrow()
    const input = {
      idempotencyKey: 'sqsp:o-1:payment:t-1',
      eventId: id,
      sqspOrderId: 'o-1',
      processorRef: 't-1',
      variance: { sqspTotalCents: 20223, oasisTotalCents: 20223, deltaCents: 0, exceedsAlert: false },
    }
    await ledger.confirmAwaitingEvent(input)
    await ledger.confirmAwaitingEvent(input)
    const ev = await r.db.selectFrom('ledger_events').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
    expect(ev.processor_state).toBe('confirmed')
    expect(ev.processor_ref).toBe('t-1')
    expect(ev.sqsp_order_id).toBe('o-1')
    expect(ev.processor_confirmed_by).toBe('Squarespace')
    expect(ev.processor_confirmed_at?.toISOString()).toBe(r.clock.now().toISOString())
    expect(ev.amount_cents).toBe(20223)
    expect(ev.source).toBe('oasis')
    const after = await r.db.selectFrom('invoices').select('version').where('id', '=', inv.id).executeTakeFirstOrThrow()
    expect(after.version).toBe(before.version + 1)
    const matches = await r.db.selectFrom('sqsp_matches').selectAll().execute()
    expect(matches).toHaveLength(1)
    expect(matches[0]?.kind).toBe('confirm_awaiting')
    expect(matches[0]?.event_id).toBe(id)
    expect(matches[0]?.variance).toMatchObject({ deltaCents: 0, exceedsAlert: false })
    const audits = await r.db.selectFrom('audit_log').select(['action', 'actor_name']).where('action', '=', 'sqsp.confirm_awaiting').execute()
    expect(audits).toEqual([{ action: 'sqsp.confirm_awaiting', actor_name: 'Squarespace' }])
    const sse = await r.db.selectFrom('realtime_events').select(['channel', 'type']).where('channel', '=', 'payments').orderBy('id').execute()
    expect(sse.map((x) => x.type)).toEqual(['invoice.updated', 'ledger.event'])
  })

  it('confirming an event staff already confirmed by hand only fills in the missing references', async () => {
    const { r, env, ledger, inv } = await world()
    const id = await addEvent(r.db, env, inv, { type: 'pay', amountCents: 20223, methodKind: 'card', processorState: 'confirmed' })
    await ledger.confirmAwaitingEvent({ idempotencyKey: 'k1', eventId: id, sqspOrderId: 'o-1', processorRef: 't-1' })
    const ev = await r.db.selectFrom('ledger_events').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
    expect(ev.processor_state).toBe('confirmed')
    expect(ev.processor_confirmed_by).toBeNull()
    expect(ev.processor_ref).toBe('t-1')
    expect(ev.sqsp_order_id).toBe('o-1')
  })

  it('attachProcessorRefs never overwrites a reference that is already set', async () => {
    const { r, env, ledger, inv } = await world()
    const id = await addEvent(r.db, env, inv, { type: 'pay', amountCents: 100, methodKind: 'card' })
    await r.db.updateTable('ledger_events').set({ processor_ref: 'first' }).where('id', '=', id).execute()
    await ledger.attachProcessorRefs({ idempotencyKey: 'a1', eventId: id, sqspOrderId: 'o-1', processorRef: 'second' })
    const ev = await r.db.selectFrom('ledger_events').select(['processor_ref', 'sqsp_order_id']).where('id', '=', id).executeTakeFirstOrThrow()
    expect(ev).toEqual({ processor_ref: 'first', sqsp_order_id: 'o-1' })
  })

  it('recordProcessorPayment inserts a squarespace pay event once, pays the link and settles the invoice', async () => {
    const { r, ledger, inv } = await world()
    const linkId = r.newId()
    await r.db
      .insertInto('payment_links')
      .values({ id: linkId, location_id: r.locationId, invoice_id: inv.id, url: 'https://x.squarespace.com/a', expected_cents: 20223, sent_at: new Date(T.getTime() - H) })
      .execute()
    const input = {
      idempotencyKey: 'sqsp:o-1:payment:t-1',
      invoiceId: inv.id,
      paymentLinkId: linkId,
      deposit: false,
      amountCents: 20223,
      occurredAt: new Date(T.getTime() - 60_000),
      brand: 'VISA',
      sqspOrderId: 'o-1',
      processorRef: 't-1',
    }
    const a = await ledger.recordProcessorPayment(input)
    const b = await ledger.recordProcessorPayment(input)
    expect(b.eventId).toBe(a.eventId)
    const evs = await r.db.selectFrom('ledger_events').selectAll().where('invoice_id', '=', inv.id).execute()
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({
      type: 'pay',
      amount_cents: 20223,
      source: 'squarespace',
      processor_state: 'confirmed',
      processor_ref: 't-1',
      sqsp_order_id: 'o-1',
      method: 'Visa',
      method_kind: 'card',
      brand: 'visa',
      last4: null,
      deposit: false,
      idempotency_key: 'sqsp:o-1:payment:t-1',
    })
    expect(evs[0]?.occurred_at.toISOString()).toBe(new Date(T.getTime() - 60_000).toISOString())
    const link = await r.db.selectFrom('payment_links').selectAll().where('id', '=', linkId).executeTakeFirstOrThrow()
    expect(link.state).toBe('paid')
    expect(link.matched_sqsp_order_id).toBe('o-1')
    const calc = await r.db.selectFrom('invoice_calc').select(['balance', 'status']).where('invoice_id', '=', inv.id).executeTakeFirstOrThrow()
    expect(calc).toMatchObject({ balance: 0, status: 'paid' })
  })

  it('recordExternalRefund inserts a done, confirmed squarespace refund flagged for review, once', async () => {
    const { r, env, ledger, inv } = await world()
    await addEvent(r.db, env, inv, { type: 'pay', amountCents: 20223, methodKind: 'card', method: 'Visa' })
    const input = {
      idempotencyKey: 'sqsp:o-1:refund:re-1',
      invoiceId: inv.id,
      amountCents: 5000,
      occurredAt: new Date(T.getTime() - 1000),
      brand: 'VISA',
      sqspOrderId: 'o-1',
      processorRef: 're-1',
    }
    const a = await ledger.recordExternalRefund(input)
    expect((await ledger.recordExternalRefund(input)).eventId).toBe(a.eventId)
    const ev = await r.db.selectFrom('ledger_events').selectAll().where('id', '=', a.eventId).executeTakeFirstOrThrow()
    expect(ev).toMatchObject({
      type: 'refund',
      status: 'done',
      dest: 'card',
      source: 'squarespace',
      processor_state: 'confirmed',
      needs_review: true,
      processor_ref: 're-1',
      amount_cents: 5000,
    })
    const calc = await r.db.selectFrom('invoice_calc').select(['refunded', 'status']).where('invoice_id', '=', inv.id).executeTakeFirstOrThrow()
    expect(calc).toMatchObject({ refunded: 5000, status: 'partially_refunded' })
  })

  it('confirmRefundEvent confirms an approved card refund waiting on Squarespace', async () => {
    const { r, env, ledger, inv } = await world()
    await addEvent(r.db, env, inv, { type: 'pay', amountCents: 20223, methodKind: 'card', method: 'Visa' })
    const id = await addEvent(r.db, env, inv, { type: 'refund', amountCents: 5000, dest: 'card', processorState: 'awaiting_processor' })
    await ledger.confirmRefundEvent({ idempotencyKey: 'sqsp:o-1:refund:re-1', eventId: id, sqspOrderId: 'o-1', processorRef: 're-1' })
    const ev = await r.db.selectFrom('ledger_events').select(['processor_state', 'processor_ref', 'status']).where('id', '=', id).executeTakeFirstOrThrow()
    expect(ev).toEqual({ processor_state: 'confirmed', processor_ref: 're-1', status: 'done' })
  })

  it('enqueueManual is idempotent per key and keeps the arrival and suggestions', async () => {
    const { r, ledger } = await world()
    const arrival = {
      kind: 'payment' as const,
      orderId: 'o-1',
      orderNumber: '1001',
      transactionId: 't-1',
      occurredAt: T,
      amountCents: 20223,
      currency: 'USD',
      orderTotalCents: 20223,
      source: 'transaction' as const,
    }
    const input = {
      idempotencyKey: 'sqsp:o-1:payment:t-1',
      orderId: 'o-1',
      transactionId: 't-1',
      reason: 'no_candidate' as const,
      candidates: [{ kind: 'link' as const, id: 'l-1', invoiceId: 'i-1', score: 0.6, via: 'email' }],
      arrival,
    }
    await ledger.enqueueManual(input)
    await ledger.enqueueManual(input)
    const rows = await r.db.selectFrom('sqsp_manual_queue').selectAll().execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ state: 'open', reason: 'no_candidate', sqsp_txn_id: 't-1' })
    expect(rows[0]?.candidates).toEqual(input.candidates)
    expect((rows[0]?.arrival as { amountCents: number }).amountCents).toBe(20223)
  })
})
