// K4 review of the tax switch (ADR 0173): the rollout's PUT /settings/billing/sales-tax {6.625, half_even} also moves the open invoices
// of visits booked before it (tax:M1), a typo such as 66.25 is refused (tax:H3), and a new invoice reads the rate and the rounding in
// one statement (tax:H1).
import { afterEach, describe, expect, it } from 'vitest'
import { configureSquareRuntime } from '../../src/modules/square/runtime.js'
import { currentTax } from '../../src/modules/payments/tax-rate.js'
import { transaction } from '../../src/platform/db.js'
import { salesTaxCents } from '../../src/platform/money.js'
import { updateSetting } from '../../src/platform/settings.js'
import { recordPayment, useRig } from '../scheduling-gaps/support.js'
import { squareEnvFor } from './core.js'

const m = useRig()
afterEach(() => configureSquareRuntime({}))

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const db = () => m.h.t.db
const put = (body: unknown) => m.h.call('PUT', '/api/v1/settings/billing/sales-tax', { session: m.superS(), body })
const version = async () => ((await m.get(m.superS(), '/settings/billing')).json() as Json).salesTax.version as number
const row = (id: string) => db().selectFrom('invoices').select(['tax_dbp', 'tax_rounding', 'version']).where('id', '=', id).executeTakeFirstOrThrow()
const calc = async (id: string) => {
  const j = (await m.get(m.superS(), `/invoices/${id}`)).json() as Json
  return ((j.invoice ?? j) as Json).calc as Json
}

describe('the switch to 6.625% (tax:M1)', () => {
  it('moves the open invoices of visits not done yet; a finished visit and one paid in full up front keep their rate', async () => {
    configureSquareRuntime({ env: squareEnvFor({ PAYMENT_PROCESSOR: 'squarespace', SQUARE_WRITES_ENABLED: 'false' }) })
    const early = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-17T13:00:00-04:00') // booked before the switch
    const deposit = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-18T13:00:00-04:00')
    await recordPayment(m, deposit.invoiceId, 1000, { kind: 'cash', state: 'na' })
    const prepaid = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-19T13:00:00-04:00')
    const full = (await calc(prepaid.invoiceId)).balance as number
    await recordPayment(m, prepaid.invoiceId, full, { kind: 'cash', state: 'na' })
    const done = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-13T14:00:00-04:00')
    await m.complete(done.appointmentId)
    for (const v of [early, deposit, prepaid, done]) expect(await row(v.invoiceId)).toMatchObject({ tax_dbp: 7000, tax_rounding: 'half_up' })
    const before = await calc(early.invoiceId)
    const sub = before.sub as number
    expect(before.tax).toBe(salesTaxCents(sub, { dbp: 7000, rounding: 'half_up' }))
    const nj = salesTaxCents(sub, { dbp: 6625, rounding: 'half_even' })

    const r = await put({ percent: '6.625', rounding: 'half_even', version: await version() })
    expect(r.statusCode, r.body).toBe(200)

    expect(await row(early.invoiceId)).toMatchObject({ tax_dbp: 6625, tax_rounding: 'half_even' })
    expect(await calc(early.invoiceId)).toMatchObject({ sub, tax: nj, total: sub + nj, balance: sub + nj }) // what Square's basket charges
    expect(await row(deposit.invoiceId)).toMatchObject({ tax_dbp: 6625, tax_rounding: 'half_even' })
    expect(await calc(deposit.invoiceId)).toMatchObject({ total: sub + nj, paid: 1000, balance: sub + nj - 1000 })
    // paid in full at 7% before the visit: moving it would leave it overpaid, so it keeps its rate
    expect(await row(prepaid.invoiceId)).toMatchObject({ tax_dbp: 7000, tax_rounding: 'half_up' })
    expect((await calc(prepaid.invoiceId)).overpaid).toBe(0)
    // a finished visit keeps the rate of its sale
    expect(await row(done.invoiceId)).toMatchObject({ tax_dbp: 7000, tax_rounding: 'half_up' })
    // audited per invoice, with invoice.updated for the screens
    const audits = await db().selectFrom('audit_log').select(['entity_id', 'before', 'after']).where('action', '=', 'payments.tax_rerated').orderBy('id').execute()
    expect(audits.map((a) => a.entity_id).sort()).toEqual([early.invoiceId, deposit.invoiceId].sort())
    expect(audits[0]!.before).toEqual({ taxDbp: 7000, taxRounding: 'half_up' })
    expect(audits[0]!.after).toMatchObject({ taxDbp: 6625, taxRounding: 'half_even', balance: expect.any(Number) })
    const events = await db().selectFrom('realtime_events').select('payload').where('type', '=', 'invoice.updated').execute()
    expect(events.map((e) => (e.payload as Json).invoiceId)).toEqual(expect.arrayContaining([early.invoiceId, deposit.invoiceId]))
    // a reschedule keeps the new rate; a new booking is made at it
    const later = await m.book('Maria Delgado', 'Express Hand Wash', '2026-06-17T14:00:00-04:00')
    expect(await row(later.invoiceId)).toMatchObject({ tax_dbp: 6625, tax_rounding: 'half_even' })
    // saving the same rate again moves nothing more
    expect((await put({ percent: '6.625', version: await version() })).statusCode).toBe(200)
    expect(await db().selectFrom('audit_log').select('id').where('action', '=', 'payments.tax_rerated').execute()).toHaveLength(2)
  })
})

describe('a typo (tax:H3)', () => {
  it('a rate above 15% is refused with a plain message unless confirmed', async () => {
    const v = await version()
    const typo = await put({ percent: '66.25', version: v })
    expect(typo.statusCode).toBe(422)
    expect(typo.json()).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'percent', message: '66.25% is very high for a sales tax. Check the rate: New Jersey’s is 6.625%.' }] })
    expect(await version()).toBe(v)
    expect((await put({ percent: '15', version: v })).statusCode).toBe(200)
    expect((await put({ percent: '15.001', version: v + 1 })).statusCode).toBe(422)
    const confirmed = await put({ percent: '20', confirmHighRate: true, version: v + 1 })
    expect(confirmed.statusCode, confirmed.body).toBe(200)
    expect(confirmed.json()).toMatchObject({ rateDbp: 20_000 })
  })
})

describe('one read of the rate and the rounding (tax:H1)', () => {
  it('currentTax reads both settings together, with the defaults when never stored', async () => {
    expect(await currentTax(db(), m.locationId())).toEqual({ dbp: 7000, rounding: 'half_up' })
    await transaction(db(), async (tx) => {
      await updateSetting(tx, { locationId: m.locationId(), key: 'tax.rate_dbp', value: 6625 })
      await updateSetting(tx, { locationId: m.locationId(), key: 'tax.rounding', value: 'half_even' })
    })
    expect(await currentTax(db(), m.locationId())).toEqual({ dbp: 6625, rounding: 'half_even' })
  })
})
