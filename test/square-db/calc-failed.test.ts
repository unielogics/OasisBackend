// Property (ADR 0171 D4): with card refunds in every processor state (none yet, waiting, confirmed, FAILED), the SQL invoice_calc_of
// still equals its TypeScript twin calcInvoice, and the nightly integrity check (the third twin) finds no difference; a failed
// refund never counts as refunded.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { calcInvoice, type CalcEvent } from '../../src/modules/payments/calc.js'
import { checkLedgerIntegrity } from '../../src/modules/payments/jobs-integrity.js'
import { calcOf } from '../../src/modules/payments/repository.js'
import { useTestDb } from '../helpers/db.js'
import { addEvent, makeInvoice, setupEnv, type RawEvent } from '../payments/helpers.js'

const t = useTestDb()

const arbEvent: fc.Arbitrary<RawEvent> = fc.oneof(
  fc.integer({ min: 1, max: 80_000 }).map((n): RawEvent => ({ type: 'pay', amountCents: n, method: 'Visa', methodKind: 'card', processorState: 'confirmed' })),
  fc.integer({ min: 1, max: 30_000 }).map((n): RawEvent => ({ type: 'pay', amountCents: n, method: 'Cash', methodKind: 'cash' })),
  fc
    .integer({ min: -20_000, max: 20_000 })
    .filter((n) => n !== 0)
    .map((n): RawEvent => ({ type: 'adjust', amountCents: n })),
  fc
    .tuple(
      fc.integer({ min: 1, max: 40_000 }),
      fc.constantFrom('done', 'pending'),
      fc.constantFrom('card', 'credit', 'cash'),
      fc.constantFrom('na', 'awaiting_processor', 'confirmed', 'failed'),
    )
    .map(([n, s, d, p]): RawEvent => ({
      type: 'refund',
      amountCents: n,
      status: s as 'done',
      dest: d as 'card',
      // only a done card refund waits on (or is refused by) the processor
      processorState: (s === 'done' && d === 'card' ? p : 'na') as 'na',
    })),
)

describe('calc with failed card refunds: SQL equals the TS twin', () => {
  it('over random invoices and ledgers', async () => {
    const env = await setupEnv(t)
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          prices: fc.array(fc.integer({ min: 0, max: 100_000 }), { minLength: 1, maxLength: 4 }),
          events: fc.array(arbEvent, { maxLength: 8 }),
          taxBp: fc.constantFrom(0, 700, 825),
          tipCents: fc.integer({ min: 0, max: 3000 }),
          canceled: fc.boolean(),
        }),
        async (i) => {
          const inv = await makeInvoice(t.db, env, { items: i.prices.map((priceCents, k) => ({ name: `Line ${k}`, priceCents })), taxBp: i.taxBp, tipCents: i.tipCents })
          if (i.canceled) await t.db.updateTable('invoices').set({ canceled_at: t.clock.now(), cancel_reason: 'canceled' }).where('id', '=', inv.id).execute()
          for (const e of i.events) await addEvent(t.db, env, inv, e)
          const twin = calcInvoice({
            itemPrices: i.prices,
            events: i.events.map(
              (e): CalcEvent => ({
                type: e.type,
                amountCents: e.amountCents,
                status: e.type === 'refund' ? (e.status ?? 'done') : undefined,
                dest: e.type === 'refund' ? (e.dest ?? 'card') : undefined,
                processorState: e.processorState ?? 'na',
              }),
            ),
            taxBp: i.taxBp,
            tipCents: i.tipCents,
            canceled: i.canceled,
          })
          const sql = await calcOf(t.db, inv.id)
          expect(sql).toEqual(twin)
          const counted = i.events.filter((e) => e.type === 'refund' && (e.status ?? 'done') === 'done' && e.processorState !== 'failed').reduce((s, e) => s + e.amountCents, 0)
          expect(sql.refunded).toBe(counted)
        },
      ),
      { numRuns: 60 },
    )
    const report = await checkLedgerIntegrity(t.db, env.locationId)
    expect(report.findings.filter((f) => f.code === 'calc_mismatch')).toEqual([])
  }, 120_000)
})
