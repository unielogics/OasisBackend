// Settings → Billing & integrations (ADR 0171, wave Q3 dashapi): one read for the panel (the Square status row, the processor and its
// switches read only, the booking fee, link tipping, card fees, the renewal policy, the "Move members" notice, the consent text in
// use) and the writes that had no route: link tipping, the renewal policy and the price-change notice. set.billing only; each write
// takes the version it read (428 without, 412 stale), is audited and publishes settings.changed. Everything off by default.
import { afterEach, describe, expect, it } from 'vitest'
import { CURRENT_CONSENT_VERSION } from '../../src/modules/square/consents.js'
import { configureSquareRuntime } from '../../src/modules/square/runtime.js'
import { useRig } from '../scheduling-gaps/support.js'
import { squareEnvFor } from './core.js'

const m = useRig()
afterEach(() => configureSquareRuntime({}))

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const defaults = () => configureSquareRuntime({ env: squareEnvFor({ PAYMENT_PROCESSOR: 'squarespace', SQUARE_WRITES_ENABLED: 'false' }) })
const panel = async (s = m.superS()) => {
  const r = await m.get(s, '/settings/billing')
  expect(r.statusCode, r.body).toBe(200)
  return r.json() as Json
}
const put = (url: string, body: unknown, headers: Record<string, string> = {}, s = m.superS()) =>
  m.h.call('PUT', `/api/v1/settings/billing/${url}`, { session: s, body, headers })
const changed = async (key: string) =>
  (await m.h.t.db.selectFrom('realtime_events').select(['type', 'payload']).where('type', '=', 'settings.changed').orderBy('id').execute()).filter(
    (e) => (e.payload as Json).key === key,
  )
const audits = (key: string) =>
  m.h.t.db.selectFrom('audit_log').select(['action', 'before', 'after']).where('action', '=', 'settings.update').where('entity_id', '=', key).orderBy('id').execute()

describe('GET /settings/billing', () => {
  it('the whole panel with the defaults: Squarespace, observe-only, every switch off, fees off, policy 7/21, notice 30, consent v1', async () => {
    defaults()
    const p = await panel()
    expect(p.square.status).toMatchObject({ key: 'square' })
    expect(p.square.eventTypes.length).toBeGreaterThan(0)
    expect(p.processing).toEqual({
      processor: 'squarespace',
      squareProvider: 'sim',
      squareEnvironment: 'sandbox',
      writesEnabled: false,
      membershipsEnabled: false,
      posAppSwitch: false,
      posAutomatch: 'evidence',
      publicLinksEnabled: false,
      cardsOn: false,
    })
    expect(p.guestFee).toMatchObject({ cents: expect.any(Number), collect: 'counter' })
    const v = expect.any(Number)
    expect(p.linkTipping).toEqual({ enabled: false, version: v })
    expect(p.cardFees).toEqual({ fees: { enabled: false, noShowCents: 0, lateCancelCents: 0 }, version: v, active: false })
    expect(p.renewalPolicy).toEqual({ graceDays: 7, cancelDays: 21, version: v })
    expect(p.priceChangeNotice).toEqual({ days: 30, version: v })
    expect(p.consent).toMatchObject({ version: CURRENT_CONSENT_VERSION, checkedByDefault: false, purposes: ['membership_billing', 'no_show_fee', 'late_cancel_fee', 'balance'] })
    expect(p.consent.text.length).toBeGreaterThan(20)
    // never a token or a key
    expect(JSON.stringify(p)).not.toMatch(/sim-square-access-token|SIGNATURE_KEY=|EAAA/)
  })

  it('follows the switches: Square the processor with writes on', async () => {
    configureSquareRuntime({ env: squareEnvFor({ SQUARE_MEMBERSHIPS_ENABLED: 'true' }) })
    const p = await panel()
    expect(p.processing).toMatchObject({ processor: 'square', writesEnabled: true, membershipsEnabled: true, cardsOn: true })
  })

  it('needs set.billing (pay.reports alone is not enough)', async () => {
    defaults()
    const reports = (await m.h.userWithPermissions(['pay.reports', 'set.services'], 'reports@example.test')).session
    expect((await m.get(reports, '/settings/billing')).statusCode).toBe(403)
    expect((await put('link-tipping', { enabled: true, version: 1 }, {}, reports)).statusCode).toBe(403)
    const billing = (await m.h.userWithPermissions(['set.billing'], 'billing@example.test')).session
    expect((await m.get(billing, '/settings/billing')).statusCode).toBe(200)
  })
})

describe('the writes', () => {
  it('link tipping: version required (428), stale (412), saved with ETag, audited, settings.changed; the panel shows it', async () => {
    defaults()
    const v = (await panel()).linkTipping.version as number
    expect((await put('link-tipping', { enabled: true })).statusCode).toBe(428)
    const ok = await put('link-tipping', { enabled: true, version: v })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toEqual({ enabled: true, version: v + 1 })
    expect(ok.headers.etag).toBe(`"${v + 1}"`)
    expect((await put('link-tipping', { enabled: false, version: v })).statusCode).toBe(412)
    const viaHeader = await put('link-tipping', { enabled: false }, { 'if-match': `"${v + 1}"` })
    expect(viaHeader.statusCode, viaHeader.body).toBe(200)
    expect(viaHeader.json()).toEqual({ enabled: false, version: v + 2 })
    expect((await panel()).linkTipping).toEqual({ enabled: false, version: v + 2 })
    expect(await changed('payments.link_tipping')).toHaveLength(2)
    expect((await audits('payments.link_tipping')).map((a) => [a.before, a.after])).toEqual([
      [false, true],
      [true, false],
    ])
  })

  it('the renewal policy: cancel after the grace days end (422), bounds, saved', async () => {
    defaults()
    const v = (await panel()).renewalPolicy.version as number
    const bad = await put('renewal-policy', { graceDays: 10, cancelDays: 10, version: v })
    expect(bad.statusCode, bad.body).toBe(422)
    expect((await put('renewal-policy', { graceDays: 61, cancelDays: 90, version: v })).statusCode).toBe(422)
    const ok = await put('renewal-policy', { graceDays: 3, cancelDays: 14, version: v })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toEqual({ graceDays: 3, cancelDays: 14, version: v + 1 })
    expect((await panel()).renewalPolicy).toEqual({ graceDays: 3, cancelDays: 14, version: v + 1 })
    expect(await changed('memberships.billing_policy')).toHaveLength(1)
  })

  it('the price-change notice: 0 to 90 days, saved', async () => {
    defaults()
    const v = (await panel()).priceChangeNotice.version as number
    expect((await put('price-change-notice', { days: 91, version: v })).statusCode).toBe(422)
    const ok = await put('price-change-notice', { days: 45, version: v })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toEqual({ days: 45, version: v + 1 })
    expect((await panel()).priceChangeNotice).toEqual({ days: 45, version: v + 1 })
    expect(await changed('memberships.price_change_notice_days')).toHaveLength(1)
  })
})

describe('the sales tax rate (ADR 0173)', () => {
  it('reads 7% by default, rounded like Square on new invoices', async () => {
    defaults()
    expect((await panel()).salesTax).toEqual({ percent: '7', rateDbp: 7000, label: '7%', rounding: 'half_even', version: expect.any(Number) })
  })

  it('saves a percentage with up to three decimals (6.625 for New Jersey): version required, audited, settings.changed', async () => {
    defaults()
    const v = (await panel()).salesTax.version as number
    expect((await put('sales-tax', { percent: '6.625' })).statusCode).toBe(428)
    const ok = await put('sales-tax', { percent: '6.625', version: v })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toEqual({ percent: '6.625', rateDbp: 6625, label: '6.625%', rounding: 'half_even', version: v + 1 })
    expect(ok.headers.etag).toBe(`"${v + 1}"`)
    expect((await put('sales-tax', { percent: '7', version: v })).statusCode).toBe(412)
    expect((await panel()).salesTax).toMatchObject({ percent: '6.625', rateDbp: 6625 })
    expect(await changed('tax.rate_dbp')).toHaveLength(1)
    expect((await audits('tax.rate_dbp')).map((a) => [a.before, a.after])).toEqual([[7000, 6625]])
    const back = await put('sales-tax', { percent: '7.000%', version: v + 1 })
    expect(back.json()).toMatchObject({ percent: '7', rateDbp: 7000, label: '7%' })
  })

  it('refuses anything that is not 0 to 100 with up to three decimals, on the percent field, with a plain message', async () => {
    defaults()
    const v = (await panel()).salesTax.version as number
    for (const percent of ['6.6255', '101', '-1', 'seven', '', '6,625']) {
      const r = await put('sales-tax', { percent, version: v })
      expect(r.statusCode, percent).toBe(422)
      expect(r.json()).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ path: 'percent', message: expect.stringMatching(/up to three decimals/) }] })
    }
    expect((await put('sales-tax', { percent: 6.625, version: v })).statusCode).toBe(422)
    expect((await panel()).salesTax.version).toBe(v)
  })

  it('needs set.billing', async () => {
    defaults()
    const reports = (await m.h.userWithPermissions(['pay.reports', 'set.services'], 'tax-reports@example.test')).session
    expect((await put('sales-tax', { percent: '6.625', version: 1 }, {}, reports)).statusCode).toBe(403)
  })
})
