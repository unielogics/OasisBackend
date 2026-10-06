// ORACLE TESTS. Every expectation here was read from the ORIGINAL Payments bundle (frozen clock 2026-06-13T10:36 -04:00,
// role mgmt, light theme) by test/golden/pay/extract-oracle.mjs and stored in test/golden/pay/*.json. The API output over the
// parity-pay seed must equal it, except for the intentional differences recorded in test/golden/pay/DEVIATIONS.md.
import { describe, expect, it, beforeEach } from 'vitest'
import { runSeed } from '../../db/seeds/index.js'
import { STATUS_LABELS } from '../../src/modules/payments/calc.js'
import { firstName, money0 } from '../../src/modules/payments/format.js'
import { formatUsd } from '../../src/platform/money.js'
import { addDays } from '../../src/platform/time.js'
import { usePayHarness } from './http.js'
import { ledgerRow, TIME_PREFIX, uiActions, type Detail } from './ui-twin.js'
import { cents, oracleDetails, oracleViews, type OracleView } from './golden.js'

const p = usePayHarness()
beforeEach(async () => {
  await runSeed({ db: p.h.t.db, clock: p.h.t.clock, profile: 'parity-pay' })
})

const views = oracleViews()
const RANGES = ['today', '7d', '30d', 'mtd'] as const
const FILTERS = ['all', 'unpaid', 'refunds', 'adjusted', 'credits'] as const
const TODAY = '2026-06-13'

interface Summary {
  range: { label: string; from: string; to: string }
  kpis: Record<string, number> & { counts: Record<string, number> }
  chart: {
    granularity: string
    buckets: { key: string | number; label: string; title: string; netCents: number; lossCents: number }[]
    maxCents: number
  }
  byMethod: Record<string, number>
  filterCounts: Record<string, number>
  pendingApprovals: { count: number; text: string }
  awaitingProcessor: { count: number; cents: number }
}
interface ListRow {
  id: string
  label: string
  date: string
  time: string
  client: string
  vehicle: string
  items: { first: string; more: number }
  totalCents: number
  statusLabel: string
  adjusted: boolean
}

const summary = async (range: string): Promise<Summary> =>
  p.json<Summary>(await p.get(p.people().rafael, `payments/summary?range=${range}`))

describe('summary equals the original bundle for every range', () => {
  it('KPIs (value and sub-label), counts, by-method, filter counts, pending banner', async () => {
    for (const r of RANGES) {
      const o = views.views[r]!.all!
      const s = await summary(r)
      const where = `range ${r}`
      expect(s.range.label, where).toBe(o.rangeLabel)
      // raw aggregates are exact in cents
      expect(s.kpis.grossSales, where).toBe(cents(o.raw.agg.gross))
      expect(s.kpis.adjustments, where).toBe(cents(o.raw.agg.adj))
      expect(s.kpis.refunds, where).toBe(cents(o.raw.agg.refunds))
      expect(s.kpis.creditsIssued, where).toBe(cents(o.raw.agg.credits))
      expect(s.kpis.outstanding, where).toBe(cents(o.raw.agg.outstanding))
      expect(s.kpis.netRevenue, `${where} net`).toBe(Math.round(o.raw.agg.net * 100))
      // the design's whole-dollar display, from our cents
      const display = [
        s.kpis.grossSales,
        s.kpis.netRevenue,
        s.kpis.refunds,
        s.kpis.adjustments,
        s.kpis.creditsIssued,
        s.kpis.outstanding,
      ].map((v) => money0(v ?? 0))
      expect(display, where).toEqual(o.kpis.map((k) => k.value))
      // sub labels
      const c = s.kpis.counts
      expect(
        [
          `${c.invoices} invoices`,
          `${c.refunded} refunded`,
          `${c.adjusted} invoices`,
          `${c.creditInvoices} clients`,
          `${c.openBalances} open balances`,
        ],
        where,
      ).toEqual([o.kpis[0]!.sub, o.kpis[2]!.sub, o.kpis[3]!.sub, o.kpis[4]!.sub, o.kpis[5]!.sub])
      expect(o.kpis[1]!.sub).toBe('after refunds & discounts')
      expect(c).toMatchObject({
        invoices: o.raw.counts.invoices,
        refunded: o.raw.counts.refunded,
        adjusted: o.raw.counts.adjusted,
        creditInvoices: o.raw.counts.creditInvoices,
        openBalances: o.raw.counts.openBalances,
      })
      // collected by method
      expect(s.byMethod, where).toEqual({
        card: cents(o.raw.methods.Card!),
        applePay: cents(o.raw.methods['Apple Pay']!),
        cash: cents(o.raw.methods.Cash!),
        storeCredit: cents(o.raw.methods['Store credit']!),
        other: 0,
      })
      expect(
        [s.byMethod.card, s.byMethod.applePay, s.byMethod.cash, s.byMethod.storeCredit].map((v) =>
          money0(v ?? 0),
        ),
        where,
      ).toEqual(o.methods.map((m) => m.value))
      // filter chip counts
      expect(
        FILTERS.map((f) => String(s.filterCounts[f])),
        where,
      ).toEqual(o.filters.map((f) => f.count))
      // the banner is global
      expect(s.pendingApprovals.text, where).toBe(o.pendingText)
      expect(s.pendingApprovals.count).toBe(1)
    }
  })

  it('chart buckets: labels, tooltips, per-bucket net and loss, and bar heights', async () => {
    for (const r of RANGES) {
      const o = views.views[r]!.all!
      const s = await summary(r)
      const where = `range ${r}`
      expect(o.raw.droppedFromChart, where).toBe(0)
      expect(s.chart.granularity).toBe(r === 'today' ? 'hour' : 'day')
      expect(s.chart.buckets, where).toHaveLength(o.raw.chart.length)
      expect(
        s.chart.buckets.map((b) => b.label),
        where,
      ).toEqual(o.bars.map((b) => b.label))
      expect(
        s.chart.buckets.map((b) => `${b.title} · net ${money0(b.netCents)}`),
        where,
      ).toEqual(o.bars.map((b) => b.title))
      for (const [i, b] of s.chart.buckets.entries()) {
        const raw = o.raw.chart[i]!
        const key = r === 'today' ? raw.key : addDays(TODAY, raw.key)
        expect(b.key, `${where} bucket ${i}`).toBe(key)
        expect(b.netCents, `${where} bucket ${key} net`).toBe(Math.round(raw.net * 100))
        expect(b.lossCents, `${where} bucket ${key} loss`).toBe(Math.round(raw.loss * 100))
        const netPct = (b.netCents / s.chart.maxCents) * 100
        const lossPct = (b.lossCents / s.chart.maxCents) * 100
        expect(netPct, `${where} bucket ${key} net height`).toBeCloseTo(parseFloat(o.bars[i]!.netHeight), 6)
        expect(lossPct, `${where} bucket ${key} loss height`).toBeCloseTo(
          parseFloat(o.bars[i]!.lossHeight),
          6,
        )
        expect(o.bars[i]!.netMin).toBe(raw.net > 0 ? '3px' : '0')
      }
    }
  })
})

const rowText = (r: ListRow): string =>
  [
    `${r.date} · ${r.time}`,
    r.client,
    r.vehicle,
    r.items.first + (r.items.more ? ` +${r.items.more}` : ''),
    formatUsd(r.totalCents),
    r.statusLabel,
    r.adjusted,
  ].join(' | ')
const oracleRowText = (r: OracleView['rows'][number]): string =>
  [r.date, r.client, r.vehicle, r.items, r.total, r.status, r.adjusted].join(' | ')

describe('invoice list equals the original bundle for every range and filter', () => {
  it('same rows, same order (ids differ only where the design printed duplicates)', async () => {
    for (const r of RANGES) {
      for (const f of FILTERS) {
        const o = views.views[r]![f]!
        const res = await p.get(p.people().rafael, `payments/invoices?range=${r}&filter=${f}&limit=500`)
        const body = p.json<{ items: ListRow[]; nextCursor: string | null }>(res)
        const where = `range ${r} filter ${f}`
        expect(body.nextCursor, where).toBeNull()
        expect(body.items.map(rowText), where).toEqual(o.rows.map(oracleRowText))
      }
    }
  })

  it('the explicit design invoices keep their ids; generated ones are unique and renumbered', async () => {
    const all = p.json<{ items: ListRow[] }>(
      await p.get(p.people().rafael, 'payments/invoices?range=30d&limit=500'),
    ).items
    const labels = all.map((x) => x.label)
    expect(new Set(labels).size).toBe(105)
    for (const id of [
      'INV-20608',
      'INV-20603',
      'INV-20579',
      'INV-20571',
      'INV-20560',
      'INV-20548',
      'INV-20610',
      'INV-20609',
    ])
      expect(labels).toContain(id)
    expect(labels.at(-1)).toBe('INV-20506')
  })

  it('search over id, client, vehicle and item names behaves like the design (joined, case-insensitive)', async () => {
    const find = async (q: string): Promise<string[]> => {
      const res = await p.get(
        p.people().rafael,
        `payments/invoices?range=30d&q=${encodeURIComponent(q)}&limit=500`,
      )
      return p.json<{ items: ListRow[] }>(res).items.map((x) => x.label)
    }
    expect(await find('inv-20603')).toEqual(['INV-20603'])
    expect(await find('PRIYA')).toEqual(expect.arrayContaining(['INV-20603', 'INV-20610']))
    expect(await find('priya nair 2022 tesla')).toEqual(expect.arrayContaining(['INV-20603']))
    expect(await find('rain repellent')).toContain('INV-20603')
    expect(await find('nothing like this')).toEqual([])
    expect(await find('50%_')).toEqual([])
  })

  it('keyset pagination walks the whole list in order without gaps or repeats', async () => {
    const all = p.json<{ items: ListRow[] }>(
      await p.get(p.people().rafael, 'payments/invoices?range=30d&limit=500'),
    ).items
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const res: { items: ListRow[]; nextCursor: string | null } = p.json(
        await p.get(
          p.people().rafael,
          `payments/invoices?range=30d&limit=17${cursor ? `&cursor=${cursor}` : ''}`,
        ),
      )
      seen.push(...res.items.map((x) => x.label))
      cursor = res.nextCursor
      pages++
    } while (cursor)
    expect(pages).toBe(Math.ceil(105 / 17))
    expect(seen).toEqual(all.map((x) => x.label))
  })
})

describe('invoice detail equals the original bundle', () => {
  it('pending banner of the initial state', () => {
    expect(oracleDetails().pending).toEqual({
      hasPending: true,
      pendingText: '1 refund awaiting approval — $80.00 · Chloe Bennett · requested by Sofia D.',
    })
  })

  it('header, stat cards, breakdown lines, actions, ledger and credit line for every sampled invoice', async () => {
    const od = oracleDetails().invoices
    for (const [id, o] of Object.entries(od)) {
      const no = Number(id.slice(4))
      const row = await p.h.t.db
        .selectFrom('invoices')
        .select('id')
        .where('invoice_no', '=', no)
        .executeTakeFirstOrThrow()
      const d = p.json<Detail>(await p.get(p.people().rafael, `invoices/${row.id}`))
      const where = id
      expect(d.label, where).toBe(id)
      expect([d.when, d.client, d.vehicle, d.staff], where).toEqual([o.when, o.client, o.vehicle, o.staff])
      expect(d.statusLabel, where).toBe(o.status)

      const c = d.calc
      const big = [
        { label: 'Total', value: formatUsd(c.total) },
        { label: 'Collected', value: formatUsd(c.paid - c.refunded) },
        c.balance > 0
          ? { label: 'Balance due', value: formatUsd(c.balance) }
          : { label: 'Refundable', value: formatUsd(c.refundable) },
      ]
      expect(big, where).toEqual(o.big)

      const lines = [
        ...d.items.map((i) => ({ label: i.name, value: formatUsd(i.priceCents) })),
        ...d.adjustments.map((a) => ({
          label: `${a.amountCents < 0 ? 'Discount' : 'Surcharge'} · ${a.reason}`,
          value: formatUsd(a.amountCents),
        })),
        { label: 'Tax (7%)', value: formatUsd(c.tax) },
        ...(d.tipCents ? [{ label: 'Tip', value: formatUsd(d.tipCents) }] : []),
        { label: 'Total', value: formatUsd(c.total) },
        ...(c.creditApplied ? [{ label: 'Store credit applied', value: formatUsd(-c.creditApplied) }] : []),
        { label: 'Paid', value: formatUsd(c.paidOrig) },
        ...(c.refunded ? [{ label: 'Refunded', value: formatUsd(-c.refunded) }] : []),
      ]
      expect(lines, where).toEqual(o.lines)

      expect(uiActions(d), where).toEqual(o.actions)
      expect(
        d.clientCredit.balanceCents > 0
          ? `${firstName(d.client)} has ${formatUsd(d.clientCredit.balanceCents)} in store credit`
          : '',
        where,
      ).toBe(o.creditLine)

      const mine = d.ledger.map((e) => ledgerRow(e))
      const theirs = o.ledger.map((e) => ({
        title: e.title,
        amt: e.amt,
        rest: e.meta.replace(TIME_PREFIX, ''),
      }))
      // the original lists INV-20571's refund (9:12 AM) above its deposit (11:00 AM): its fixture time precedes the deposit;
      // we order by when it happened (DEVIATIONS.md)
      const expected = id === 'INV-20571' ? [...theirs].reverse() : theirs
      expect(mine, where).toEqual(expected)
    }
  })

  it("INV-20579 pending row: the original's time label and the approval right of the caller", async () => {
    const row = await p.h.t.db
      .selectFrom('invoices')
      .select('id')
      .where('invoice_no', '=', 20579)
      .executeTakeFirstOrThrow()
    const d = p.json<{
      ledger: { atLabel: string; canApprove: boolean; status: string }[]
      refundPending: boolean
    }>(await p.get(p.people().rafael, `invoices/${row.id}`))
    expect(d.refundPending).toBe(true)
    expect(d.ledger[0]).toMatchObject({ atLabel: 'Yesterday 4:40 PM', canApprove: true, status: 'pending' })
    const sofia = p.json<typeof d>(await p.get(p.people().amara, `invoices/${row.id}`))
    expect(sofia.ledger[0]!.canApprove).toBe(true)
    expect(Object.keys(STATUS_LABELS)).toHaveLength(8)
  })
})
