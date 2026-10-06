// Property test: for random invoices (items, tax rate, tip, canceled or not, random ledger events) the SQL function
// invoice_calc_of equals the TypeScript twin calcInvoice.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { calcInvoice, type CalcEvent } from '../../src/modules/payments/calc.js'
import { calcOf } from '../../src/modules/payments/repository.js'
import { useTestDb } from '../helpers/db.js'
import { addEvent, makeInvoice, setupEnv, type RawEvent } from './helpers.js'

const t = useTestDb()

const arbEvent: fc.Arbitrary<RawEvent> = fc.oneof(
  fc
    .integer({ min: 1, max: 80_000 })
    .map((n): RawEvent => ({ type: 'pay', amountCents: n, method: 'Cash', methodKind: 'cash' })),
  fc
    .integer({ min: -20_000, max: 20_000 })
    .filter((n) => n !== 0)
    .map((n): RawEvent => ({ type: 'adjust', amountCents: n })),
  fc.integer({ min: 1, max: 30_000 }).map((n): RawEvent => ({
    type: 'credit_apply',
    amountCents: n,
    method: 'Store credit',
    methodKind: 'store_credit',
  })),
  fc
    .integer({ min: 1, max: 30_000 })
    .map((n): RawEvent => ({ type: 'credit_issue', amountCents: n, expiry: 'none' })),
  fc
    .tuple(
      fc.integer({ min: 1, max: 40_000 }),
      fc.constantFrom('done', 'pending', 'denied'),
      fc.constantFrom('card', 'credit', 'cash'),
    )
    .map(([n, s, d]): RawEvent => ({
      type: 'refund',
      amountCents: n,
      status: s as 'done',
      dest: d as 'card',
    })),
)

describe('SQL invoice_calc_of equals the TS twin', () => {
  it('over random invoices and ledgers', async () => {
    const env = await setupEnv(t)
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          prices: fc.array(fc.integer({ min: 0, max: 100_000 }), { minLength: 1, maxLength: 5 }),
          events: fc.array(arbEvent, { maxLength: 10 }),
          taxBp: fc.constantFrom(0, 500, 700, 825, 1000),
          tipCents: fc.integer({ min: 0, max: 5000 }),
          canceled: fc.boolean(),
        }),
        async (i) => {
          const inv = await makeInvoice(t.db, env, {
            items: i.prices.map((priceCents, n) => ({ name: `Line ${n}`, priceCents })),
            taxBp: i.taxBp,
            tipCents: i.tipCents,
          })
          if (i.canceled) {
            await t.db
              .updateTable('invoices')
              .set({ canceled_at: t.clock.now(), cancel_reason: 'canceled' })
              .where('id', '=', inv.id)
              .execute()
          }
          for (const e of i.events) await addEvent(t.db, env, inv, e)
          const twinEvents: CalcEvent[] = i.events.map((e) => ({
            type: e.type,
            amountCents: e.amountCents,
            status: e.type === 'refund' ? (e.status ?? 'done') : undefined,
            dest: e.type === 'refund' ? (e.dest ?? 'card') : undefined,
          }))
          const twin = calcInvoice({
            itemPrices: i.prices,
            events: twinEvents,
            taxBp: i.taxBp,
            tipCents: i.tipCents,
            canceled: i.canceled,
          })
          expect(await calcOf(t.db, inv.id)).toEqual(twin)
        },
      ),
      { numRuns: 60 },
    )
  }, 120_000)
})
