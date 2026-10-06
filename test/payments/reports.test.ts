// Reports beyond the oracle comparison: CSV spec, chart extension outside 8a-5p, awaiting-processor and reconciliation,
// the pending banner for several refunds, and the permission map of the routes.
import { beforeEach, describe, expect, it } from 'vitest'
import { runSeed } from '../../db/seeds/index.js'
import { CSV_BOM } from '../../src/platform/csv.js'
import { addEvent, makeInvoice } from './helpers.js'
import { usePayHarness } from './http.js'

const p = usePayHarness()
const get = (path: string) => p.get(p.people().rafael, path)

describe('CSV export', () => {
  beforeEach(async () => {
    await runSeed({ db: p.h.t.db, clock: p.h.t.clock, profile: 'parity-pay' })
  })

  it('spec: BOM, CRLF, header, filename, plain decimals, business-tz dates', async () => {
    const res = await get('payments/export.csv?range=7d')
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="oasis-invoices_2026-06-07_2026-06-13.csv"',
    )
    expect(res.headers['x-row-count']).toBe('32')
    const body = res.body
    expect(body.startsWith(CSV_BOM)).toBe(true)
    expect(body.replace(/\r\n/g, '').includes('\n')).toBe(false)
    expect(body.endsWith('\r\n')).toBe(true)
    const lines = body.slice(1).split('\r\n').filter(Boolean)
    expect(lines[0]).toBe(
      'Invoice,Date,Time,Client,Vehicle,Staff,Items,Tip,Adjustments,Subtotal,Tax,Total,Paid,Credit applied,Refunded,Refund pending,Balance,Credits issued,Net revenue,Status',
    )
    expect(lines).toHaveLength(33)
    const row = lines.find((l) => l.startsWith('INV-20603,'))!
    expect(row).toBe(
      'INV-20603,2026-06-13,10:31,Priya Nair,2022 Tesla Model Y,Lena K.,Premium Hand Wash + Interior; Rain repellent,0.00,0.00,154.00,10.78,164.78,0.00,0.00,0.00,0.00,164.78,0.00,154.00,Unpaid',
    )
    const discount = lines.find((l) => l.startsWith('INV-20602,'))!
    expect(discount).toContain(',20.00,-25.00,350.00,24.50,394.50,394.50,')
    const pending = lines.find((l) => l.startsWith('INV-20579,'))!
    expect(pending).toContain(',80.00,')
    expect(pending.endsWith(',Refund pending')).toBe(true)
    expect(body).not.toContain('$')
  })

  it('scope is the range and the filter and the search', async () => {
    const lines = async (q: string) =>
      (await get(`payments/export.csv?${q}`)).body.slice(1).split('\r\n').filter(Boolean).length - 1
    expect(await lines('range=30d')).toBe(105)
    expect(await lines('range=30d&filter=refunds')).toBe(5)
    expect(await lines('range=30d&filter=refunds&q=chloe')).toBe(1)
    expect(await lines('range=today&filter=unpaid')).toBe(3)
    expect(await lines('range=today&q=zzz')).toBe(0)
  })

  it('quotes cells that need it and neutralises formula injection in text cells only', async () => {
    const env = p.env()
    const inv = await makeInvoice(p.h.t.db, env, {
      client: '=HYPERLINK("http://x","y")',
      items: [
        { name: 'Wax, "premium"', priceCents: 4000 },
        { name: '@evil', priceCents: 100 },
      ],
    })
    await p.h.t.db
      .updateTable('invoices')
      .set({ vehicle_label: '+1 Ford', staff_label: '-cmd' })
      .where('id', '=', inv.id)
      .execute()
    await addEvent(p.h.t.db, env, inv, { type: 'adjust', amountCents: -500 })
    const body = (await get('payments/export.csv?range=today&q=hyperlink')).body
    const row = body.slice(1).split('\r\n')[1]!
    expect(row).toContain(`"'=HYPERLINK(""http://x"",""y"")"`)
    expect(row).toContain(`'+1 Ford`)
    expect(row).toContain(`'-cmd`)
    expect(row).toContain('"Wax, ""premium""; @evil"')
    // numeric columns are never prefixed: the discount stays a number
    expect(row).toContain(',-5.00,')
  })

  it('needs pay.reports', async () => {
    expect((await p.get(p.people().kevin, 'payments/export.csv?range=7d')).statusCode).toBe(403)
    expect((await p.get(p.people().sofia, 'payments/export.csv?range=7d')).statusCode).toBe(403)
  })
})

describe('summary edge cases', () => {
  it('an empty day has the 8a-5p hourly buckets, zero KPIs and no banner', async () => {
    const s = (await get('payments/summary?range=today')).json<{
      chart: { buckets: { label: string; netCents: number }[]; maxCents: number }
      kpis: { grossSales: number; counts: { invoices: number } }
      pendingApprovals: { count: number; text: string; first: null }
    }>()
    expect(s.chart.buckets.map((b) => b.label)).toEqual([
      '8a',
      '9a',
      '10a',
      '11a',
      '12p',
      '1p',
      '2p',
      '3p',
      '4p',
      '5p',
    ])
    expect(s.chart.maxCents).toBe(1)
    expect(s.kpis.grossSales).toBe(0)
    expect(s.pendingApprovals).toEqual({ count: 0, text: '', first: null, all: [] })
  })

  it('hours outside 8a-5p extend the chart instead of being dropped', async () => {
    const env = p.env()
    await makeInvoice(p.h.t.db, env, { occurredAt: new Date('2026-06-13T07:15:00-04:00') })
    await makeInvoice(p.h.t.db, env, { occurredAt: new Date('2026-06-13T18:40:00-04:00') })
    await makeInvoice(p.h.t.db, env, { occurredAt: new Date('2026-06-13T12:00:00-04:00') })
    const s = (await get('payments/summary?range=today')).json<{
      chart: { buckets: { key: number; label: string; netCents: number }[] }
    }>()
    expect(s.chart.buckets[0]).toMatchObject({ key: 7, label: '7a', netCents: 15400 })
    expect(s.chart.buckets.at(-1)).toMatchObject({ key: 18, label: '6p', netCents: 15400 })
    expect(s.chart.buckets.find((b) => b.label === '12p')?.netCents).toBe(15400)
    expect(s.chart.buckets.reduce((a, b) => a + b.netCents, 0)).toBe(3 * 15400)
  })

  it('a refunded invoice nets out the tax portion once per bucket and loss carries the refund and discounts', async () => {
    const env = p.env()
    const inv = await makeInvoice(p.h.t.db, env, { items: [{ name: 'Executive Detail', priceCents: 26000 }] })
    await addEvent(p.h.t.db, env, inv, { type: 'adjust', amountCents: -1500 })
    await addEvent(p.h.t.db, env, inv, {
      type: 'pay',
      amountCents: 26000,
      method: 'Cash',
      methodKind: 'cash',
    })
    await addEvent(p.h.t.db, env, inv, { type: 'refund', amountCents: 5350, dest: 'cash' })
    const s = (await get('payments/summary?range=today')).json<{
      chart: { buckets: { label: string; netCents: number; lossCents: number }[] }
      kpis: { netRevenue: number; refunds: number }
    }>()
    const b = s.chart.buckets.find((x) => x.label === '10a')!
    // 26000 - 1500 - 5350/1.07 (5000) = 19500; loss = 5350 refunded + 1500 discount
    expect(b).toMatchObject({ netCents: 19500, lossCents: 5350 + 1500 })
    expect(s.kpis).toMatchObject({ netRevenue: 19500, refunds: 5350 })
  })

  it('awaitingProcessor counts card money not yet seen in Squarespace, and it still counts in the KPIs', async () => {
    const { rafael } = p.people()
    const a = await makeInvoice(p.h.t.db, p.env())
    await p.send(rafael, 'POST', `invoices/${a.id}/payments`, { method: 'card' })
    const s = (await get('payments/summary?range=today')).json<{
      awaitingProcessor: { count: number; cents: number }
      byMethod: { card: number }
    }>()
    expect(s.awaitingProcessor).toEqual({ count: 1, cents: 16478 })
    expect(s.byMethod.card).toBe(16478)
  })

  it('the banner pluralises and leads with the oldest request', async () => {
    const { sofia } = p.people()
    const a = await makeInvoice(p.h.t.db, p.env(), { client: 'Chloe Bennett' })
    const b = await makeInvoice(p.h.t.db, p.env(), { client: 'Hannah Kim' })
    for (const [inv, cents] of [
      [a, 8000],
      [b, 9000],
    ] as const) {
      await addEvent(p.h.t.db, p.env(), inv, {
        type: 'pay',
        amountCents: 20000,
        method: 'Cash',
        methodKind: 'cash',
      })
      await p.send(sofia, 'POST', `invoices/${inv.id}/refunds`, {
        mode: 'custom',
        amountCents: cents,
        dest: 'cash',
      })
      p.h.clock.advance(60_000)
    }
    const s = (await get('payments/summary?range=today')).json<{
      pendingApprovals: { count: number; text: string }
    }>()
    expect(s.pendingApprovals).toMatchObject({
      count: 2,
      text: '2 refunds awaiting approval — $80.00 · Chloe Bennett · requested by Sofia D.',
    })
  })
})

describe('reconciliation', () => {
  it('lists card events waiting on Squarespace for more than 2 hours, overpaid invoices and the (empty) unmatched queues', async () => {
    const env = p.env()
    const old = await makeInvoice(p.h.t.db, env)
    const fresh = await makeInvoice(p.h.t.db, env)
    const t0 = p.h.clock.now()
    await addEvent(p.h.t.db, env, old, {
      type: 'pay',
      amountCents: 16478,
      method: 'Visa',
      methodKind: 'card',
      processorState: 'awaiting_processor',
      at: new Date(t0.getTime() - 121 * 60_000),
    })
    await addEvent(p.h.t.db, env, fresh, {
      type: 'pay',
      amountCents: 16478,
      method: 'Visa',
      methodKind: 'card',
      processorState: 'awaiting_processor',
      at: new Date(t0.getTime() - 119 * 60_000),
    })
    const over = await makeInvoice(p.h.t.db, env)
    await addEvent(p.h.t.db, env, over, {
      type: 'pay',
      amountCents: 20000,
      method: 'Cash',
      methodKind: 'cash',
    })
    const r = (await get('payments/reconciliation')).json<{
      thresholdMinutes: number
      awaitingProcessor: { invoiceId: string; ageMinutes: number }[]
      overpaid: { invoiceId: string; overpaidCents: number }[]
      unmatchedOrders: unknown[]
      unmatchedTransactions: unknown[]
    }>()
    expect(r.thresholdMinutes).toBe(120)
    expect(r.awaitingProcessor).toEqual([expect.objectContaining({ invoiceId: old.id, ageMinutes: 121 })])
    expect(r.overpaid).toEqual([
      expect.objectContaining({ invoiceId: over.id, overpaidCents: 20000 - 16478 }),
    ])
    expect(r.unmatchedOrders).toEqual([])
    expect(r.unmatchedTransactions).toEqual([])
  })

  it('is open to pay.reports or set.billing, and to nobody else', async () => {
    expect((await p.get(p.people().daniel, 'payments/reconciliation')).statusCode).toBe(200)
    expect((await p.get(p.people().kevin, 'payments/reconciliation')).statusCode).toBe(403)
    const { session } = await p.h.userWithPermissions(['set.billing'], 'billing@example.test')
    expect((await p.h.call('GET', 'payments/reconciliation', { session })).statusCode).toBe(200)
  })
})

describe('permission map of the payments routes (backend.md 6.1)', () => {
  it('every route declares the documented permission, and every mutation requires an Idempotency-Key', () => {
    const reg = p.h.t.app.routeRegistry
    const want: Record<string, string> = {
      'GET /payments/summary': 'pay.reports',
      'GET /payments/invoices': 'pay.reports',
      'GET /invoices/:id': 'pay.reports',
      'GET /payments/approvals': 'pay.reports',
      'GET /payments/export.csv': 'pay.reports',
      'GET /payments/reconciliation': 'pay.reports | set.billing',
      'GET /clients/:id/credit': 'pay.reports',
      'POST /invoices/:id/payments': 'pay.collect',
      'POST /invoices/:id/credit-applications': 'pay.collect',
      'POST /invoices/:id/refunds': 'pay.refund',
      'POST /invoices/:id/refunds/:eventId/approve': 'pay.refund',
      'POST /invoices/:id/refunds/:eventId/deny': 'pay.refund',
      'POST /invoices/:id/adjustments': 'pay.adjust',
      'POST /invoices/:id/credits': 'pay.credit',
      'POST /invoices/:id/void': 'pay.void',
      'PUT /invoices/:id/tip': 'pay.collect',
      'POST /invoices/:id/receipt': 'msg.send | pay.collect',
      'POST /invoices/:id/payment-links': 'pay.collect',
      'POST /ledger-events/:id/confirm-processor': 'pay.collect | pay.refund',
    }
    const mine = reg.filter((r) => r.tags?.includes('payments'))
    const got: Record<string, string> = {}
    for (const r of mine) {
      if (r.access.kind !== 'permission') throw new Error(`${r.method} ${r.url} is not permission gated`)
      got[`${r.method} ${r.url.replace('/api/v1', '')}`] = r.access.perms.join(
        r.access.mode === 'all' ? ' + ' : ' | ',
      )
      if (r.method !== 'GET') expect(r.idempotency, `${r.method} ${r.url}`).toBe('required')
    }
    expect(got).toEqual(want)
  })
})
