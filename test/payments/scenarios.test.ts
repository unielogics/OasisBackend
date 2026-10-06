// ORACLE SCENARIOS: the original bundle's own sheet logic (refund, adjust, credit, apply, collect, approve, deny) driven on the
// seeded fixtures; the same commands through the API must produce the same sheet previews, guard messages and resulting
// invoice figures. Differences are listed in test/golden/pay/DEVIATIONS.md.
import { beforeEach, describe, expect, it } from 'vitest'
import { runSeed } from '../../db/seeds/index.js'
import { itemsRefundValue } from '../../src/modules/payments/calc.js'
import { formatUsd } from '../../src/platform/money.js'
import { cents, oracleScenarios, type OracleScenarioStep } from './golden.js'
import { usePayHarness, type Person } from './http.js'
import { ledgerRow, TIME_PREFIX, type Detail } from './ui-twin.js'

const p = usePayHarness()
beforeEach(async () => {
  await runSeed({ db: p.h.t.db, clock: p.h.t.clock, profile: 'parity-pay' })
})

const scenarios = oracleScenarios()
const WHO: Record<string, 'rafael' | 'sofia' | 'amara'> = { mgmt: 'rafael', support: 'sofia', super: 'amara' }

interface DetailWithRaw extends Detail {
  id: string
  items: { id: string; name: string; priceCents: number }[]
  calc: Detail['calc'] & { pendingAmt: number; toOrigMax: number; refundable: number }
  taxBp: number
}

async function open(selId: string): Promise<{ id: string; detail: DetailWithRaw }> {
  const row = await p.h.t.db
    .selectFrom('invoices')
    .select('id')
    .where('invoice_no', '=', Number(selId.slice(4)))
    .executeTakeFirstOrThrow()
  return { id: row.id, detail: p.json<DetailWithRaw>(await p.get(p.people().rafael, `invoices/${row.id}`)) }
}

const sheetOf = (name: string): OracleScenarioStep => scenarios[name]!.log.find((l) => l.op === 'sheet')!
const finalOf = (name: string): OracleScenarioStep => scenarios[name]!.log.at(-1)!

/** The resulting invoice figures and the ledger rows the original shows after the command. */
function expectAfter(name: string, d: Detail): void {
  const a = finalOf(name).after!
  const c = d.calc
  expect(d.statusLabel, name).toBe(a.status)
  expect([c.total, c.paid, c.refunded, c.balance, c.refundable], name).toEqual(
    [a.calc.total, a.calc.paid, a.calc.refunded, a.calc.balance, a.calc.refundable].map(cents),
  )
  expect((c as DetailWithRaw['calc']).toOrigMax, `${name} toOrigMax`).toBe(cents(a.calc.toOrigMax))
  expect((c as DetailWithRaw['calc']).pendingAmt, `${name} pending`).toBe(
    cents(a.calc.pending.reduce((x, y) => x + y, 0)),
  )
  const big = [
    { label: 'Total', value: formatUsd(c.total) },
    { label: 'Collected', value: formatUsd(c.paid - c.refunded) },
    c.balance > 0
      ? { label: 'Balance due', value: formatUsd(c.balance) }
      : { label: 'Refundable', value: formatUsd(c.refundable) },
  ]
  expect(big, name).toEqual(a.big)
  // titles, amounts and notes of every ledger row; actor and roles differ by design (real roles snapshot, DEVIATIONS.md)
  const mine = d.ledger.map((e) => ledgerRow(e, false))
  const theirs = a.ledger.map((e) => ({
    title: e.title,
    amt: e.amt,
    rest: e.meta.replace(TIME_PREFIX, '').replace(/^[^·]*?(?: \([^)]*\))?(?: · |$)/, ''),
  }))
  expect(
    mine.map((r) => [r.title, r.amt]),
    name,
  ).toEqual(theirs.map((r) => [r.title, r.amt]))
}

const refundBody = (sheet: Record<string, unknown>, items: { id: string }[]): Record<string, unknown> => {
  const mode = (sheet.mode as string) ?? 'full'
  return {
    mode,
    dest: (sheet.dest as string) ?? 'card',
    ...(mode === 'items' ? { itemIds: (sheet.items as number[]).map((i) => items[i]!.id) } : {}),
    ...(mode === 'custom' ? { amountCents: cents(Number(sheet.amount)) } : {}),
  }
}

const REFUNDS: Record<string, Record<string, unknown>> = {
  refund_full_card: { dest: 'card', mode: 'full' },
  refund_items_card: { mode: 'items', items: [1], dest: 'card' },
  refund_items_credit: { mode: 'items', items: [0, 1], dest: 'credit' },
  refund_full_card_blocked: { dest: 'card', mode: 'full' },
  refund_custom_over_refundable: { dest: 'card', mode: 'custom', amount: '500' },
  refund_support_over_limit: { dest: 'card', mode: 'custom', amount: '80' },
  refund_support_at_limit: { dest: 'card', mode: 'custom', amount: '50' },
  refund_cash_custom: { dest: 'cash', mode: 'custom', amount: '100' },
}

describe('refund sheets and results', () => {
  for (const [name, sheet] of Object.entries(REFUNDS)) {
    it(name, async () => {
      const sc = scenarios[name]!
      const { id, detail } = await open(sc.selId)
      const who: Person = p.people()[WHO[sc.role]!]
      const o = sheetOf(name)
      // sheet preview from the TS twin
      const calc = detail.calc
      const val =
        sheet.mode === 'items'
          ? itemsRefundValue(
              (sheet.items as number[]).map((i) => detail.items[i]!.priceCents),
              detail.taxBp,
              calc.refundable,
            )
          : sheet.mode === 'custom'
            ? cents(Number(sheet.amount))
            : calc.refundable
      expect(formatUsd(val), name).toBe(o.summary!.find((x) => x.label === 'This refund')!.value)
      expect(formatUsd(calc.refundable), name).toBe(o.summary!.find((x) => x.label === 'Refundable')!.value)

      const res = await p.send(who, 'POST', `invoices/${id}/refunds`, refundBody(sheet, detail.items))
      if (o.blocked) {
        expect(res.statusCode, name).toBe(422)
        expect(res.json<{ detail: string }>().detail, name).toBe(o.permText)
        return
      }
      expect(res.statusCode, name).toBe(201)
      const body = res.json<{
        event: { status: string; amountCents: number; method: string }
        invoice: Detail
      }>()
      expect(body.event.amountCents, name).toBe(val)
      expect(body.event.status === 'pending', name).toBe(o.submitLabel!.startsWith('Request approval'))
      expectAfter(name, body.invoice)
    })
  }
})

const adjustSpec: Record<
  string,
  {
    kind: 'discount' | 'surcharge'
    unit: '$' | '%'
    amount: string
    settle?: 'credit' | 'card'
    reason?: string
  }
> = {
  adjust_pct_settle_credit: { kind: 'discount', unit: '%', amount: '10', settle: 'credit' },
  adjust_pct_settle_card: { kind: 'discount', unit: '%', amount: '10', settle: 'card' },
  adjust_surcharge_unpaid: { kind: 'surcharge', unit: '$', amount: '10', reason: 'Oversize vehicle' },
  adjust_discount_unpaid: { kind: 'discount', unit: '$', amount: '20' },
  adjust_support_over_limit: { kind: 'discount', unit: '$', amount: '30' },
  adjust_larger_than_invoice: { kind: 'discount', unit: '$', amount: '500' },
}

describe('adjust sheets and results', () => {
  for (const [name, a] of Object.entries(adjustSpec)) {
    it(name, async () => {
      const sc = scenarios[name]!
      const { id } = await open(sc.selId)
      const who = p.people()[WHO[sc.role]!]
      const o = sheetOf(name)
      const value = a.unit === '%' ? Math.round(Number(a.amount) * 100) : cents(Number(a.amount))
      const res = await p.send(who, 'POST', `invoices/${id}/adjustments`, {
        kind: a.kind,
        unit: a.unit,
        value,
        ...(a.settle ? { settle: a.settle } : {}),
        ...(a.reason ? { reason: a.reason } : {}),
      })
      if (o.blocked) {
        expect(res.statusCode, name).toBe(422)
        expect(res.json<{ detail: string }>().detail, name).toBe(o.permText)
        return
      }
      expect(res.statusCode, name).toBe(201)
      const body = res.json<{
        event: { amountCents: number }
        settlement: { amountCents: number; dest: string } | null
        invoice: Detail
      }>()
      const signed = o.summary!.find((x) => x.label.endsWith('(pre-tax)'))!.value
      expect(formatUsd(body.event.amountCents), name).toBe(signed)
      expect(formatUsd(body.invoice.calc.total), name).toBe(
        o.summary!.find((x) => x.label === 'New total')!.value,
      )
      const settleRow = o.summary!.find((x) => x.label.startsWith('Overpaid'))
      expect(body.settlement ? formatUsd(body.settlement.amountCents) : undefined, name).toBe(
        settleRow?.value,
      )
      if (settleRow) expect(body.settlement!.dest, name).toBe(a.settle === 'card' ? 'card' : 'credit')
      expectAfter(name, body.invoice)
    })
  }
})

describe('credit, apply, collect', () => {
  it('credit_issue_30d: current / issuing / new balance and the result', async () => {
    const { id, detail } = await open('INV-20603')
    const o = sheetOf('credit_issue_30d')
    expect(formatUsd(detail.clientCredit.balanceCents)).toBe(o.summary![0]!.value)
    const res = await p.send(p.people().rafael, 'POST', `invoices/${id}/credits`, {
      amountCents: 2500,
      expiry: '30 days',
      reason: 'Goodwill',
    })
    expect(res.statusCode).toBe(201)
    const b = res.json<{ invoice: Detail & { clientCredit: { balanceCents: number } } }>()
    expect(formatUsd(b.invoice.clientCredit.balanceCents)).toBe(o.summary![2]!.value)
    expectAfter('credit_issue_30d', b.invoice)
  })

  it('credit_issue_support_over: the guard text', async () => {
    const { id } = await open('INV-20603')
    const res = await p.send(p.people().sofia, 'POST', `invoices/${id}/credits`, {
      amountCents: 6000,
      expiry: 'd90',
    })
    expect(res.statusCode).toBe(422)
    expect(res.json<{ detail: string }>().detail).toBe(sheetOf('credit_issue_support_over').permText)
  })

  it('credit_apply: available / applying / balance after', async () => {
    const { id, detail } = await open('INV-20603')
    const o = sheetOf('credit_apply')
    expect(formatUsd(detail.clientCredit.balanceCents)).toBe(o.summary![0]!.value)
    const res = await p.send(p.people().rafael, 'POST', `invoices/${id}/credit-applications`)
    const b = res.json<{ event: { amountCents: number }; invoice: Detail }>()
    expect(formatUsd(b.event.amountCents)).toBe(o.summary![1]!.value)
    expect(formatUsd(b.invoice.calc.balance)).toBe(o.summary![2]!.value)
    expectAfter('credit_apply', b.invoice)
  })

  it('collect_cash: the balance is collected and the invoice reads Paid (the card path differs: no invented Visa ••4421)', async () => {
    const { id, detail } = await open('INV-20603')
    const o = sheetOf('collect_cash')
    expect(formatUsd(detail.calc.balance)).toBe(o.summary![0]!.value)
    const res = await p.send(p.people().rafael, 'POST', `invoices/${id}/payments`, { method: 'cash' })
    const b = res.json<{ event: { amountCents: number }; invoice: Detail }>()
    expect(formatUsd(b.event.amountCents)).toBe(o.summary![0]!.value)
    expectAfter('collect_cash', b.invoice)
  })
})

describe('approve and deny the seeded pending refund (INV-20579)', () => {
  const pendingId = async (invoiceId: string): Promise<string> =>
    (
      await p.h.t.db
        .selectFrom('ledger_events')
        .select('id')
        .where('invoice_id', '=', invoiceId)
        .where('status', '=', 'pending')
        .executeTakeFirstOrThrow()
    ).id

  it('approve_mgmt', async () => {
    const { id } = await open('INV-20579')
    const res = await p.send(
      p.people().rafael,
      'POST',
      `invoices/${id}/refunds/${await pendingId(id)}/approve`,
    )
    expect(res.statusCode).toBe(200)
    expectAfter('approve_mgmt', res.json<{ invoice: Detail }>().invoice)
  })

  it('approve_support: the design toast is the problem title, and the caller sees why', async () => {
    const { id } = await open('INV-20579')
    const res = await p.send(
      p.people().sofia,
      'POST',
      `invoices/${id}/refunds/${await pendingId(id)}/approve`,
    )
    expect(res.statusCode).toBe(403)
    expect(res.json<{ title: string }>().title).toBe(finalOf('approve_support').toast)
    // Support cannot even open Payments in the design (no pay.reports); someone who can read and refund, with the default limit, sees why
    expect((await p.get(p.people().sofia, `invoices/${id}`)).statusCode).toBe(403)
    const { session } = await p.h.userWithPermissions(['pay.reports', 'pay.refund'], 'reader@example.test')
    const d = (await p.h.call('GET', `invoices/${id}`, { session })).json<{
      ledger: { canApprove: boolean; approveBlock: string | null; status: string }[]
    }>()
    expect(d.ledger[0]).toMatchObject({ status: 'pending', canApprove: false, approveBlock: 'limit' })
  })

  it('deny_mgmt', async () => {
    const { id } = await open('INV-20579')
    const res = await p.send(p.people().rafael, 'POST', `invoices/${id}/refunds/${await pendingId(id)}/deny`)
    expect(res.statusCode).toBe(200)
    expectAfter('deny_mgmt', res.json<{ invoice: Detail }>().invoice)
  })
})
