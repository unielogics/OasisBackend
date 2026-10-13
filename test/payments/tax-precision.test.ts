// ADR 0173 in the database: sales_tax_cents (SQL) equals salesTaxCents (TS) for every subtotal and rule; a new invoice takes the
// location's tax.rate_dbp and tax.rounding (default half_up: today's 7% numbers stay identical until the rollout switches to
// Square's half to even) and keeps both; an older half-up invoice keeps its numbers; the invoice DTOs carry taxDbp and taxRounding
// (and the deprecated whole-bp taxBp).
import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { createInvoiceGateway, type EnsureInvoiceInput } from '../../src/modules/payments/gateway.js'
import { calcOf } from '../../src/modules/payments/repository.js'
import { transaction } from '../../src/platform/db.js'
import { createIdGenerator } from '../../src/platform/ids.js'
import { salesTaxCents, type TaxRounding } from '../../src/platform/money.js'
import { getSetting, updateSetting } from '../../src/platform/settings.js'
import { edt, makeAppointment, makeCustomer, makeService, setupLocation } from '../domain-schema/helpers.js'
import { useTestDb } from '../helpers/db.js'
import { makeInvoice, setupEnv } from './helpers.js'

const t = useTestDb()

describe('sales_tax_cents (SQL) equals salesTaxCents (TS)', () => {
  it('for every subtotal from $0 to $250 and odd amounts above, at 7%, 6.625% and other rates, both rules', async () => {
    const rates = [0, 1, 6625, 6875, 7000, 8250, 99_999, 100_000]
    const rules: TaxRounding[] = ['half_up', 'half_even']
    const subs = [...Array.from({ length: 25_001 }, (_, i) => i), 50_000, 99_999, 100_000, 123_456_789, 999_999_999]
    for (const dbp of rates)
      for (const rounding of rules) {
        const r = await sql<{ sub: string; tax: string }>`
          select s::bigint as sub, sales_tax_cents(s::bigint, ${dbp}::integer, ${rounding}::text) as tax
          from unnest(${subs}::bigint[]) s`.execute(t.db)
        const bad = r.rows.filter((x) => Number(x.tax) !== salesTaxCents(Number(x.sub), { dbp, rounding }))
        expect(bad.slice(0, 5), `${dbp} ${rounding}`).toEqual([])
        expect(r.rows).toHaveLength(subs.length)
      }
  }, 120_000)

  it('Square vectors: $4 + $8k at 6.625% round to the even cent', async () => {
    const r = await sql<{ a: string | number; b: string | number; c: string | number; d: string | number }>`
      select sales_tax_cents(400, 6625, 'half_even') as a, sales_tax_cents(1200, 6625, 'half_even') as b,
             sales_tax_cents(10000, 6625, 'half_even') as c, sales_tax_cents(10000, 6625, 'half_up') as d`.execute(t.db)
    const row = r.rows[0]!
    expect([row.a, row.b, row.c, row.d].map(Number)).toEqual([26, 80, 662, 663])
  })
})

describe('invoices', () => {
  async function world() {
    const f = await setupLocation(t)
    const gw = createInvoiceGateway({ clock: t.clock, newId: createIdGenerator(t.clock) })
    const customerId = await makeCustomer(t.db, f, { name: 'Priya Nair' })
    const serviceId = await makeService(t.db, f, { kind: 'package', name: 'Express Hand Wash', priceCents: 10_000, durationMin: 45 })
    const ensure = async (o: Partial<EnsureInvoiceInput> = {}) => {
      const appointmentId = await makeAppointment(t.db, f, { customerId, serviceId, start: edt('2026-06-13', '10:30') })
      return transaction(t.db, (tx) =>
        gw.ensureForAppointment(tx, {
          appointmentId,
          locationId: f.locationId,
          customerId,
          clientName: 'Priya Nair',
          vehicleLabel: '2022 Tesla Model Y',
          staffLabel: 'Lena K.',
          occurredAt: edt('2026-06-13', '10:30'),
          packageName: 'Express Hand Wash',
          packagePriceCents: 10_000,
          addons: [],
          ...o,
        }),
      )
    }
    return { f, ensure }
  }

  it('with the defaults a new invoice is made exactly as today: 7%, rounded half-up ($13.50 is 95 cents, $1.50 is 11)', async () => {
    const { f, ensure } = await world()
    expect((await getSetting(t.db, f.locationId, 'tax.rate_dbp')).value).toBe(7000)
    expect((await getSetting(t.db, f.locationId, 'tax.rounding')).value).toBe('half_up')
    const a = await ensure({ packagePriceCents: 1500, addons: [] })
    expect(a).toMatchObject({ taxDbp: 7000, taxRounding: 'half_up', taxBp: 700, taxCents: 105 })
    const row = await t.db.selectFrom('invoices').select(['tax_dbp', 'tax_rounding']).where('id', '=', a.invoiceId).executeTakeFirstOrThrow()
    expect(row).toEqual({ tax_dbp: 7000, tax_rounding: 'half_up' })
    // the half-cent subtotals where the two rules differ at 7% keep today's numbers
    expect(await ensure({ packagePriceCents: 1350, addons: [] })).toMatchObject({ taxCents: 95, taxRounding: 'half_up' })
    expect(await ensure({ packagePriceCents: 150, addons: [] })).toMatchObject({ taxCents: 11, taxRounding: 'half_up' })
  })

  it("tax.rounding half_even (the rollout's switch): new invoices round like Square, older ones keep half-up", async () => {
    const { f, ensure } = await world()
    const before = await ensure({ packagePriceCents: 1350, addons: [] })
    await transaction(t.db, (tx) => updateSetting(tx, { locationId: f.locationId, key: 'tax.rounding', value: 'half_even' }))
    const after = await ensure({ packagePriceCents: 1350, addons: [] })
    expect(after).toMatchObject({ taxDbp: 7000, taxRounding: 'half_even', taxCents: 94 })
    expect((await calcOf(t.db, before.invoiceId)).tax).toBe(95)
    const row = await t.db.selectFrom('invoices').select('tax_rounding').where('id', '=', before.invoiceId).executeTakeFirstOrThrow()
    expect(row.tax_rounding).toBe('half_up')
  })

  it('at 6.625% and half_even: $100 is $6.62 (Square), $4 + $4 is 53 cents; the change does not touch an invoice made before it', async () => {
    const { f, ensure } = await world()
    const before = await ensure()
    expect(before).toMatchObject({ taxDbp: 7000, taxCents: 700 })
    await transaction(t.db, async (tx) => {
      await updateSetting(tx, { locationId: f.locationId, key: 'tax.rate_dbp', value: 6625 })
      await updateSetting(tx, { locationId: f.locationId, key: 'tax.rounding', value: 'half_even' })
    })
    const a = await ensure()
    expect(a).toMatchObject({ subtotalCents: 10_000, taxCents: 662, totalCents: 10_662, taxDbp: 6625, taxRounding: 'half_even', taxBp: 663 })
    const b = await ensure({ packagePriceCents: 400, addons: [{ name: 'Tire shine', priceCents: 400 }] })
    expect(b).toMatchObject({ subtotalCents: 800, taxCents: 53 })
    // the invoice made at 7% still reads 7%
    expect((await calcOf(t.db, before.invoiceId)).tax).toBe(700)
    const old = await t.db.selectFrom('invoices').select(['tax_dbp', 'tax_rounding']).where('id', '=', before.invoiceId).executeTakeFirstOrThrow()
    expect(old).toEqual({ tax_dbp: 7000, tax_rounding: 'half_up' })
  })

  it('an invoice made before ADR 0173 (half_up) keeps rounding half-up; the same lines on a new one round half to even', async () => {
    const env = await setupEnv(t)
    const old = await makeInvoice(t.db, env, { items: [{ name: 'Wash', priceCents: 150 }], taxDbp: 7000, taxRounding: 'half_up' })
    const fresh = await makeInvoice(t.db, env, { items: [{ name: 'Wash', priceCents: 150 }], taxDbp: 7000, taxRounding: 'half_even' })
    expect([(await calcOf(t.db, old.id)).tax, (await calcOf(t.db, fresh.id)).tax]).toEqual([11, 10])
    // a rounding Oasis does not know is refused by the table
    await expect(sql`update invoices set tax_rounding = 'bankers' where id = ${old.id}`.execute(t.db)).rejects.toThrow(/tax_rounding/)
    await expect(sql`update invoices set tax_dbp = 100001 where id = ${old.id}`.execute(t.db)).rejects.toThrow(/tax_dbp/)
  })

  it('the column default for a row written without one is half_up (the setting default; the gateway always writes it)', async () => {
    const r = await sql<{ d: string }>`
      select column_default as d from information_schema.columns
      where table_name = 'invoices' and column_name = 'tax_rounding' and table_schema = current_schema()`.execute(t.db)
    expect(r.rows[0]?.d).toMatch(/half_up/)
    const gone = await sql<{ n: number }>`
      select count(*)::int as n from information_schema.columns
      where table_name = 'invoices' and column_name = 'tax_bp' and table_schema = current_schema()`.execute(t.db)
    expect(gone.rows[0]!.n).toBe(0)
  })
})
