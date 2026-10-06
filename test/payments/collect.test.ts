// Collect (card / cash / payment link), apply credit, tip, receipt and confirm-processor over HTTP.
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { devOutbox } from '../../src/modules/payments/ports.js'
import { addEvent, makeCustomer, makeInvoice } from './helpers.js'
import { freshKey, usePayHarness } from './http.js'

const p = usePayHarness()
type EventResult = {
  event: {
    id: string
    type: string
    method: string | null
    methodKind: string
    brand: string | null
    last4: string | null
    amountCents: number
    processorState: string
    awaitingProcessor: boolean
    status: string
    by: string
    byRole: string
    source: string
  }
  invoice: {
    status: string
    calc: { balance: number; paid: number; total: number }
    awaitingProcessorCount: number
    version: number
    tipCents: number
    ledger: unknown[]
    clientCredit: { balanceCents: number }
  }
}

describe('collect', () => {
  it('cash records a pay event for the full balance, with no processor leg', async () => {
    const { rafael } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env())
    const res = await p.send(rafael, 'POST', `invoices/${inv.id}/payments`, { method: 'cash' })
    expect(res.statusCode).toBe(201)
    const b = p.json<EventResult>(res)
    expect(b.event).toMatchObject({
      type: 'pay',
      method: 'Cash',
      methodKind: 'cash',
      amountCents: 16478,
      processorState: 'na',
      awaitingProcessor: false,
      source: 'oasis',
    })
    expect(b.event.by).toBe('Rafael M.')
    expect(b.event.byRole).toBe('Management + Accounting')
    expect(b.invoice.status).toBe('paid')
    expect(b.invoice.calc.balance).toBe(0)
  })

  it('card counts as paid immediately, awaits Squarespace, and never invents a brand or last4', async () => {
    const { sofia } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env())
    const b = p.json<EventResult>(
      await p.send(sofia, 'POST', `invoices/${inv.id}/payments`, { method: 'card' }),
    )
    expect(b.event).toMatchObject({
      method: 'Card',
      methodKind: 'card',
      brand: null,
      last4: null,
      processorState: 'awaiting_processor',
      awaitingProcessor: true,
    })
    expect(b.invoice.status).toBe('paid')
    expect(b.invoice.awaitingProcessorCount).toBe(1)
    expect(b.event.byRole).toBe('Customer Support')
  })

  it('the list marks an invoice with card money waiting on Squarespace, and a confirmed one drops the mark', async () => {
    const { sofia, rafael } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env())
    const row = async () => {
      const page = p.json<{ items: Array<{ id: string; awaiting: string | null }> }>(
        await p.get(rafael, 'payments/invoices?range=30d&limit=500'),
      )
      return page.items.find((x) => x.id === inv.id)!
    }
    expect((await row()).awaiting).toBeNull()
    const b = p.json<EventResult>(await p.send(sofia, 'POST', `invoices/${inv.id}/payments`, { method: 'card' }))
    expect((await row()).awaiting).toBe('payment')
    await p.send(rafael, 'POST', `ledger-events/${b.event.id}/confirm-processor`, {})
    expect((await row()).awaiting).toBeNull()
  })

  it('collecting a settled invoice is refused', async () => {
    const { rafael } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env())
    await p.send(rafael, 'POST', `invoices/${inv.id}/payments`, { method: 'cash' })
    const again = await p.send(rafael, 'POST', `invoices/${inv.id}/payments`, { method: 'cash' })
    expect(again.statusCode).toBe(422)
    expect(again.json()).toMatchObject({ code: 'PAY_NOTHING_TO_COLLECT' })
  })

  it('needs pay.collect and an Idempotency-Key', async () => {
    const { kevin, rafael } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env())
    expect((await p.send(kevin, 'POST', `invoices/${inv.id}/payments`, { method: 'cash' })).statusCode).toBe(
      403,
    )
    const noKey = await p.h.call('POST', `invoices/${inv.id}/payments`, {
      session: rafael.session,
      body: { method: 'cash' },
    })
    expect(noKey.statusCode).toBe(400)
    expect(noKey.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' })
  })

  it('writes an audit row and publishes on the payments channel in the same transaction', async () => {
    const { rafael } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env())
    await p.send(rafael, 'POST', `invoices/${inv.id}/payments`, { method: 'cash' })
    const audit = await sql<{
      action: string
      actor_name: string
      entity_id: string
    }>`select action, actor_name, entity_id from audit_log where action = 'payments.collect'`.execute(
      p.h.t.db,
    )
    expect(audit.rows).toEqual([{ action: 'payments.collect', actor_name: 'Rafael M.', entity_id: inv.id }])
    const rt = await sql<{
      channel: string
      type: string
    }>`select channel, type from realtime_events where channel = 'payments' order by id`.execute(p.h.t.db)
    expect(rt.rows.map((r) => r.type)).toEqual(['invoice.updated', 'ledger.event'])
  })
})

describe('payment links', () => {
  it('payment_link needs a URL, on an allowed https host', async () => {
    const { rafael } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env())
    const none = await p.send(rafael, 'POST', `invoices/${inv.id}/payments`, { method: 'payment_link' })
    expect(none.json()).toMatchObject({ code: 'PAYMENT_LINK_REQUIRED' })
    const bad = await p.send(rafael, 'POST', `invoices/${inv.id}/payments`, {
      method: 'payment_link',
      url: 'https://evil.example.com/pay',
    })
    expect(bad.statusCode).toBe(422)
    expect(bad.json()).toMatchObject({ code: 'PAYMENT_LINK_HOST' })
    const http = await p.send(rafael, 'POST', `invoices/${inv.id}/payments`, {
      method: 'payment_link',
      url: 'http://shop.squarespace.com/x',
    })
    expect(http.json()).toMatchObject({ code: 'PAYMENT_LINK_HOST' })
  })

  it('creates a payment_links row and an SMS, and no ledger event', async () => {
    const { rafael } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env())
    const res = await p.send(rafael, 'POST', `invoices/${inv.id}/payments`, {
      method: 'payment_link',
      url: 'https://oasis.squarespace.com/checkout/abc',
    })
    expect(res.statusCode).toBe(201)
    const body = p.json<{
      paymentLink: { expectedCents: number; sms: string; purpose: string }
      invoice: { ledger: unknown[]; paymentLinkUrl: string }
    }>(res)
    expect(body.paymentLink).toMatchObject({ expectedCents: 16478, sms: 'queued', purpose: 'balance' })
    expect(body.invoice.ledger).toHaveLength(0)
    expect(body.invoice.paymentLinkUrl).toBe('https://oasis.squarespace.com/checkout/abc')
    const links = await p.h.t.db.selectFrom('payment_links').selectAll().execute()
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({
      state: 'active',
      expected_cents: 16478,
      url: 'https://oasis.squarespace.com/checkout/abc',
    })
    expect(devOutbox.sms).toHaveLength(1)
    expect(devOutbox.sms[0]!.body).toBe(
      'Here is your secure payment link: https://oasis.squarespace.com/checkout/abc',
    )
    expect(await p.h.t.db.selectFrom('ledger_events').select('id').execute()).toHaveLength(0)
  })

  it('a deposit link carries its own amount; opted-out clients are not texted', async () => {
    const { rafael } = p.people()
    const customerId = await makeCustomer(p.h.t.db, p.env(), { optedIn: false })
    const inv = await makeInvoice(p.h.t.db, p.env(), { customerId })
    const res = await p.send(rafael, 'POST', `invoices/${inv.id}/payment-links`, {
      kind: 'deposit',
      amountCents: 2500,
      url: 'https://oasis.squarespace.com/deposit-25',
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      paymentLink: { expectedCents: 2500, purpose: 'deposit', sms: 'skipped_opt_out' },
    })
    expect(devOutbox.sms).toHaveLength(0)
    const noAmount = await p.send(rafael, 'POST', `invoices/${inv.id}/payment-links`, {
      kind: 'deposit',
      url: 'https://oasis.squarespace.com/x',
    })
    expect(noAmount.statusCode).toBe(422)
  })
})

describe('apply credit', () => {
  it('uses min(credit, balance), writes allocations and refuses when there is nothing to apply', async () => {
    const { rafael } = p.people()
    const env = p.env()
    const customerId = await makeCustomer(p.h.t.db, env, { name: 'Priya Nair' })
    const other = await makeInvoice(p.h.t.db, env, { customerId })
    await addEvent(p.h.t.db, env, other, { type: 'credit_issue', amountCents: 2000, expiry: 'none' })
    const inv = await makeInvoice(p.h.t.db, env, { customerId })
    const res = await p.send(rafael, 'POST', `invoices/${inv.id}/credit-applications`)
    expect(res.statusCode).toBe(201)
    const b = p.json<EventResult>(res)
    expect(b.event).toMatchObject({
      type: 'credit_apply',
      amountCents: 2000,
      method: 'Store credit',
      methodKind: 'store_credit',
    })
    expect(b.invoice.calc).toMatchObject({ paid: 2000, balance: 14478 })
    expect(b.invoice.clientCredit.balanceCents).toBe(0)
    const alloc = await p.h.t.db.selectFrom('credit_allocations').select('cents').execute()
    expect(alloc).toEqual([{ cents: 2000 }])
    const again = await p.send(rafael, 'POST', `invoices/${inv.id}/credit-applications`)
    expect(again.statusCode).toBe(422)
    expect(again.json()).toMatchObject({ code: 'PAY_NOTHING_TO_APPLY' })
  })

  it('applies only the balance when the credit is larger', async () => {
    const { rafael } = p.people()
    const env = p.env()
    const customerId = await makeCustomer(p.h.t.db, env)
    const src = await makeInvoice(p.h.t.db, env, { customerId })
    await addEvent(p.h.t.db, env, src, { type: 'credit_issue', amountCents: 50000, expiry: 'none' })
    const inv = await makeInvoice(p.h.t.db, env, { customerId })
    const b = p.json<EventResult>(await p.send(rafael, 'POST', `invoices/${inv.id}/credit-applications`))
    expect(b.event.amountCents).toBe(16478)
    expect(b.invoice.status).toBe('paid')
    expect(b.invoice.clientCredit.balanceCents).toBe(50000 - 16478)
  })
})

describe('tip', () => {
  it('is untaxed, added after tax, and reopens a settled balance', async () => {
    const { rafael } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env())
    await p.send(rafael, 'POST', `invoices/${inv.id}/payments`, { method: 'cash' })
    const res = await p.send(rafael, 'PUT', `invoices/${inv.id}/tip`, { tipCents: 2000 })
    expect(res.statusCode).toBe(200)
    const b = p.json<EventResult>(res)
    expect(b.invoice).toMatchObject({ tipCents: 2000, status: 'partially_paid' })
    expect(b.invoice.calc).toMatchObject({ total: 18478, balance: 2000, tax: 1078 })
    const bad = await p.send(rafael, 'PUT', `invoices/${inv.id}/tip`, { tipCents: -1 })
    expect(bad.statusCode).toBe(422)
  })
})

describe('receipt', () => {
  it('queues SMS and email for an opted-in client with both on file', async () => {
    const { sofia } = p.people()
    const customerId = await makeCustomer(p.h.t.db, p.env(), { email: 'priya@example.test' })
    const inv = await makeInvoice(p.h.t.db, p.env(), { customerId })
    const res = await p.send(sofia, 'POST', `invoices/${inv.id}/receipt`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ sms: 'queued', email: 'queued' })
    expect(devOutbox.sms).toHaveLength(1)
    expect(devOutbox.email).toHaveLength(1)
    expect(devOutbox.email[0]!.subject).toMatch(/^Your Oasis Auto Spa receipt INV-\d+$/)
    const audit = await sql<{
      action: string
    }>`select action from audit_log where action = 'payments.receipt'`.execute(p.h.t.db)
    expect(audit.rows).toHaveLength(1)
  })

  it('email only when the client opted out of SMS', async () => {
    const { rafael } = p.people()
    const customerId = await makeCustomer(p.h.t.db, p.env(), { optedIn: false, email: 'a@example.test' })
    const inv = await makeInvoice(p.h.t.db, p.env(), { customerId })
    const res = await p.send(rafael, 'POST', `invoices/${inv.id}/receipt`)
    expect(res.json()).toMatchObject({ sms: 'skipped_opt_out', email: 'queued' })
    expect(devOutbox.sms).toHaveLength(0)
  })

  it('needs msg.send or pay.collect', async () => {
    const { kevin } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env())
    expect((await p.send(kevin, 'POST', `invoices/${inv.id}/receipt`)).statusCode).toBe(403)
  })
})

describe('confirm-processor', () => {
  it('flips an awaiting card payment to confirmed and records who and when', async () => {
    const { rafael, sofia } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env())
    const pay = p.json<EventResult>(
      await p.send(sofia, 'POST', `invoices/${inv.id}/payments`, { method: 'card' }),
    )
    const res = await p.send(rafael, 'POST', `ledger-events/${pay.event.id}/confirm-processor`, {
      processorRef: 'txn_1',
      sqspOrderId: 'order_9',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      event: { processorState: 'confirmed', processorRef: 'txn_1', sqspOrderId: 'order_9' },
      invoice: { awaitingProcessorCount: 0 },
    })
    const again = await p.send(rafael, 'POST', `ledger-events/${pay.event.id}/confirm-processor`, {})
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ code: 'EVENT_NOT_AWAITING' })
    const row = await p.h.t.db
      .selectFrom('ledger_events')
      .select(['processor_confirmed_by', 'amount_cents'])
      .where('id', '=', pay.event.id)
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ processor_confirmed_by: 'Rafael M.', amount_cents: 16478 })
  })

  it('needs the permission of the original action', async () => {
    const { sofia, amara } = p.people()
    const env = p.env()
    const inv = await makeInvoice(p.h.t.db, env)
    const refund = await addEvent(p.h.t.db, env, inv, {
      type: 'refund',
      amountCents: 100,
      dest: 'card',
      processorState: 'awaiting_processor',
    })
    const { session } = await p.h.userWithPermissions(['pay.collect'], 'collect-only@example.test')
    const denied = await p.h.call('POST', `ledger-events/${refund}/confirm-processor`, {
      session,
      body: {},
      headers: { 'idempotency-key': freshKey() },
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json()).toMatchObject({ code: 'FORBIDDEN', meta: { required: ['pay.refund'] } })
    expect((await p.send(sofia, 'POST', `ledger-events/${refund}/confirm-processor`, {})).statusCode).toBe(
      200,
    )
    void amara
  })
})

describe('idempotency', () => {
  it('replays the stored response for the same key and body, and writes one event', async () => {
    const { rafael } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env())
    const key = freshKey()
    const first = await p.send(rafael, 'POST', `invoices/${inv.id}/payments`, { method: 'cash' }, key)
    const second = await p.send(rafael, 'POST', `invoices/${inv.id}/payments`, { method: 'cash' }, key)
    expect(first.statusCode).toBe(201)
    expect(second.statusCode).toBe(201)
    expect(second.headers['idempotent-replayed']).toBe('true')
    expect(second.json()).toEqual(first.json())
    expect(await p.h.t.db.selectFrom('ledger_events').select('id').execute()).toHaveLength(1)
  })

  it('the same key with a different body is a 422 IDEMPOTENCY_MISMATCH', async () => {
    const { rafael } = p.people()
    const inv = await makeInvoice(p.h.t.db, p.env())
    const key = freshKey()
    await p.send(rafael, 'POST', `invoices/${inv.id}/payments`, { method: 'cash' }, key)
    const other = await p.send(rafael, 'POST', `invoices/${inv.id}/payments`, { method: 'card' }, key)
    expect(other.statusCode).toBe(422)
    expect(other.json()).toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' })
  })

  it('two users can use the same key without colliding', async () => {
    const { rafael, daniel } = p.people()
    const env = p.env()
    const a = await makeInvoice(p.h.t.db, env)
    const b = await makeInvoice(p.h.t.db, env)
    const key = freshKey()
    expect(
      (await p.send(rafael, 'POST', `invoices/${a.id}/payments`, { method: 'cash' }, key)).statusCode,
    ).toBe(201)
    expect(
      (await p.send(daniel, 'POST', `invoices/${b.id}/payments`, { method: 'cash' }, key)).statusCode,
    ).toBe(201)
  })
})
